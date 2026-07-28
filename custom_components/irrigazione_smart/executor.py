"""Esecuzione dell'irrigazione: apre le valvole e segue il piano.

Principio guida: **non si dà mai per scontato che una linea stia irrigando
solo perché è stato acceso l'interruttore**. Dopo il comando si attende la
conferma di stato della valvola; se non arriva entro il timeout la linea
viene saltata e la sequenza prosegue, lasciando il deficit a bilancio.

Il flussostato, se configurato, è di sola lettura: viene registrato negli
eventi e mostrato in pagina, ma non blocca né interrompe l'irrigazione.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.util import dt as dt_util

from .const import (
    DOMAIN,
    EVENT_FINISHED,
    EVENT_STARTED,
    EVENT_ZONE_FAILED,
    EVENT_ZONE_FINISHED,
    EVENT_ZONE_STARTED,
    SIGNAL_STATE_CHANGED,
    VALVE_CONFIRM_TIMEOUT,
)
from .hydro import evaluate_zone, resolve_zone_params
from .store import IrrigazioneStore

_LOGGER = logging.getLogger(__name__)

# Stati che contano come "valvola aperta": switch e input_boolean usano
# `on`, il dominio valve usa `open`.
OPEN_STATES = {"on", "open", "opening"}
CLOSED_STATES = {"off", "closed"}

# Ogni quanto si controlla che la valvola sia ancora aperta durante
# l'irrigazione. Un secondo basta perché la pagina resti veritiera.
WATCH_INTERVAL = 1.0


class IrrigationAborted(Exception):
    """L'irrigazione è stata interrotta da fuori: si ferma tutta la sequenza."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class IrrigationExecutor:
    """Esegue una singola linea o l'intera sequenza."""

    def __init__(self, hass: HomeAssistant, store: IrrigazioneStore) -> None:
        self._hass = hass
        self._store = store
        self._task: asyncio.Task | None = None
        self._state: dict[str, Any] = {}

    # ------------------------------------------------------------- stato

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def status(self) -> dict[str, Any]:
        """Stato corrente, per pagina ed entità."""
        if not self.running:
            return {"active": False}

        state = dict(self._state)
        started = state.get("zone_started_at")
        if started:
            elapsed = (dt_util.utcnow() - started).total_seconds() / 60.0
            state["elapsed_min"] = round(elapsed, 1)
            total = state.get("zone_total_min") or 0
            state["progress"] = (
                round(min(100.0, elapsed / total * 100.0), 1) if total else 0.0
            )
            state["zone_started_at"] = started.isoformat()
        state["active"] = True
        return state

    def _publish(self, **changes: Any) -> None:
        self._state.update(changes)
        async_dispatcher_send(self._hass, SIGNAL_STATE_CHANGED)

    # ------------------------------------------------------------ valvole

    def _flow_value(self) -> float | None:
        """Lettura del flussostato, se configurato. Solo informativa."""
        entity_id = self._store.system.get("flow_entity")
        if not entity_id:
            return None
        state = self._hass.states.get(entity_id)
        if state is None or state.state in ("unknown", "unavailable"):
            return None
        try:
            return float(state.state)
        except (TypeError, ValueError):
            return None

    async def _switch_valve(self, entity_id: str, turn_on: bool) -> None:
        """Comanda la valvola, adattandosi al dominio dell'entità."""
        domain = entity_id.split(".")[0]
        if domain == "valve":
            service = "open_valve" if turn_on else "close_valve"
            await self._hass.services.async_call(
                "valve", service, {"entity_id": entity_id}, blocking=True
            )
            return
        await self._hass.services.async_call(
            "homeassistant",
            "turn_on" if turn_on else "turn_off",
            {"entity_id": entity_id},
            blocking=True,
        )

    async def _wait_for_state(
        self, entity_id: str, targets: set[str], timeout: float
    ) -> bool:
        """Attende che l'entità raggiunga uno degli stati attesi."""
        state = self._hass.states.get(entity_id)
        if state is not None and state.state in targets:
            return True

        future: asyncio.Future = self._hass.loop.create_future()

        @callback
        def _changed(event) -> None:
            new = event.data.get("new_state")
            if new is not None and new.state in targets and not future.done():
                future.set_result(True)

        unsub = async_track_state_change_event(self._hass, [entity_id], _changed)
        try:
            await asyncio.wait_for(future, timeout)
            return True
        except TimeoutError:
            return False
        finally:
            unsub()

    async def _open_confirmed(self, entity_id: str) -> bool:
        """Apre la valvola e ne verifica l'apertura effettiva."""
        await self._switch_valve(entity_id, True)
        timeout = float(
            self._store.system.get("valve_timeout_s") or VALVE_CONFIRM_TIMEOUT
        )
        return await self._wait_for_state(entity_id, OPEN_STATES, timeout)

    async def _close(self, entity_id: str) -> None:
        """Chiude la valvola, senza sollevare eccezioni."""
        try:
            await self._switch_valve(entity_id, False)
        except Exception:
            _LOGGER.exception("Chiusura della valvola %s fallita", entity_id)

    async def _irrigate_for(self, valve: str, minutes: float) -> str:
        """Attende la durata sorvegliando che l'acqua stia ancora scorrendo.

        Non basta dormire: se qualcuno chiude la valvola da Home Assistant,
        o spegne il master, l'irrigazione è finita davvero e il sistema non
        deve continuare a dichiarare che sta irrigando.

        Ritorna "completato", "valvola_chiusa" oppure "master_spento".
        """
        loop = self._hass.loop
        deadline = loop.time() + minutes * 60.0

        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                return "completato"

            await asyncio.sleep(min(WATCH_INTERVAL, remaining))

            if not self._store.system.get("master_enabled", True):
                return "master_spento"

            state = self._hass.states.get(valve)
            if state is None or state.state not in OPEN_STATES:
                return "valvola_chiusa"

    # ---------------------------------------------------------- avvio API

    async def async_run_zone(
        self, zone_id: str, minutes: float | None = None, trigger: str = "manuale"
    ) -> None:
        """Irriga una sola linea."""
        if self.running:
            _LOGGER.warning("Irrigazione già in corso: comando ignorato")
            return
        self._task = self._hass.async_create_task(
            self._run([(zone_id, minutes)], trigger=trigger, single=True)
        )

    async def async_start_sequence(self, trigger: str = "manuale") -> None:
        """Irriga tutte le linee che lo richiedono, in ordine."""
        if self.running:
            _LOGGER.warning("Irrigazione già in corso: comando ignorato")
            return

        system = self._store.system
        queue: list[tuple[str, float | None]] = []
        for zone in self._store.zones_sorted():
            plan = evaluate_zone(
                zone, system, float(zone.get("deficit_mm") or 0.0)
            )
            if plan.should_run:
                queue.append((zone["id"], None))

        if not queue:
            _LOGGER.info("Sequenza non avviata: nessuna linea richiede acqua")
            return

        self._task = self._hass.async_create_task(self._run(queue, trigger=trigger))

    async def async_stop(self) -> None:
        """Ferma tutto e chiude la valvola in corso."""
        if self._task is not None and not self._task.done():
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    # ------------------------------------------------------------ motore

    async def _run(
        self,
        queue: list[tuple[str, float | None]],
        *,
        trigger: str,
        single: bool = False,
    ) -> None:
        started_at = dt_util.utcnow()
        completed: list[str] = []
        failed: list[str] = []
        aborted_reason: str | None = None

        self._hass.bus.async_fire(
            EVENT_STARTED,
            {
                "trigger": trigger,
                "zone_ids": [zid for zid, _ in queue],
                "singola_linea": single,
            },
        )

        try:
            for index, (zone_id, minutes) in enumerate(queue):
                zone = self._store.zones.get(zone_id)
                if zone is None:
                    continue

                nxt = queue[index + 1][0] if index + 1 < len(queue) else None
                try:
                    ok = await self._run_zone(zone_id, minutes, next_zone_id=nxt)
                except IrrigationAborted:
                    # la linea in corso è stata interrotta: va contata
                    failed.append(zone_id)
                    raise
                (completed if ok else failed).append(zone_id)

                # pausa tra una linea e l'altra, non dopo l'ultima
                gap = int(self._store.system.get("gap_minutes", 5) or 0)
                if gap and index + 1 < len(queue):
                    self._publish(phase="pausa_tra_linee", zone_id=None)
                    if not await self._pause(gap):
                        raise IrrigationAborted("master spento durante la pausa")

        except IrrigationAborted as aborted:
            # Le linee non ancora raggiunte non sono "fallite": non sono
            # state nemmeno tentate. Restano col loro deficit a bilancio.
            _LOGGER.info("Sequenza interrotta: %s", aborted.reason)
            aborted_reason = aborted.reason
        except asyncio.CancelledError:
            _LOGGER.info("Irrigazione interrotta su richiesta")
            raise
        finally:
            duration = (dt_util.utcnow() - started_at).total_seconds() / 60.0
            self._state = {}
            self._hass.bus.async_fire(
                EVENT_FINISHED,
                {
                    "trigger": trigger,
                    "durata_min": round(duration, 1),
                    "linee_completate": completed,
                    "linee_fallite": failed,
                    "interrotta": aborted_reason,
                },
            )
            async_dispatcher_send(self._hass, SIGNAL_STATE_CHANGED)

    async def _pause(self, minutes: float) -> bool:
        """Pausa fra due linee, interrompibile spegnendo il master."""
        loop = self._hass.loop
        deadline = loop.time() + minutes * 60.0
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                return True
            await asyncio.sleep(min(WATCH_INTERVAL, remaining))
            if not self._store.system.get("master_enabled", True):
                return False

    def _fire_failed(
        self, zone_id: str, zone: dict[str, Any], motivo: str
    ) -> None:
        """Segnala che una linea non è stata irrigata, e perché."""
        self._hass.bus.async_fire(
            EVENT_ZONE_FAILED,
            {
                "zone_id": zone_id,
                "nome": zone.get("name"),
                "motivo": motivo,
                "valvola": zone.get("valve_entity"),
                "deficit_mm": zone.get("deficit_mm"),
            },
        )

    async def _run_zone(
        self, zone_id: str, minutes: float | None, next_zone_id: str | None
    ) -> bool:
        """Esegue una linea. Ritorna False se la valvola non ha confermato."""
        zone = self._store.zones.get(zone_id)
        if zone is None:
            return False

        system = self._store.system
        params = resolve_zone_params(zone, system)
        deficit = float(zone.get("deficit_mm") or 0.0)

        # durata: quella forzata dall'utente, o quella calcolata dal motore
        if minutes is None:
            plan = evaluate_zone(zone, system, deficit)
            if not plan.should_run:
                _LOGGER.info("Linea %s saltata: %s", zone.get("name"), plan.reason)
                self._fire_failed(zone_id, zone, plan.reason)
                return False
            total_minutes = plan.total_minutes
            cycles = plan.cycles
            soak = plan.soak_minutes
        else:
            total_minutes = float(minutes)
            cycles = 1
            soak = 0

        valve = zone.get("valve_entity")
        if not valve:
            _LOGGER.warning("Linea %s senza entità valvola: saltata", zone.get("name"))
            self._fire_failed(zone_id, zone, "nessuna valvola configurata")
            return False

        per_cycle = total_minutes / cycles if cycles else total_minutes
        name = zone.get("name")

        self._hass.bus.async_fire(
            EVENT_ZONE_STARTED,
            {
                "zone_id": zone_id,
                "nome": name,
                "minuti": round(total_minutes, 1),
                "cicli": cycles,
                "pausa_min": soak,
                "valvola": valve,
                "deficit_mm": round(deficit, 2),
                "portata_mm_h": params.rate_mm_h,
                "flusso": self._flow_value(),
            },
        )

        applied = 0.0
        confirmed_any = False

        try:
            for cycle in range(1, cycles + 1):
                self._publish(
                    zone_id=zone_id,
                    zone_name=name,
                    phase="irrigazione",
                    cycle=cycle,
                    cycles=cycles,
                    zone_total_min=total_minutes,
                    # l'inizio si fissa al primo ciclo: la barra di
                    # progresso deve misurare l'intera linea, non il ciclo
                    zone_started_at=(
                        dt_util.utcnow()
                        if cycle == 1
                        else self._state.get("zone_started_at")
                    ),
                )

                if not await self._open_confirmed(valve):
                    # La valvola non ha confermato: non si finge che stia
                    # irrigando. Si chiude, si registra e si passa oltre.
                    _LOGGER.error(
                        "La valvola %s della linea %s non ha confermato "
                        "l'apertura: linea saltata",
                        valve,
                        name,
                    )
                    await self._close(valve)
                    self._fire_failed(
                        zone_id,
                        zone,
                        f"la valvola {valve} non ha confermato l'apertura",
                    )
                    return False

                confirmed_any = True
                cycle_start = dt_util.utcnow()
                outcome = await self._irrigate_for(valve, per_cycle)

                # si conta solo l'acqua effettivamente erogata, anche se
                # l'irrigazione è stata interrotta a metà
                elapsed = (dt_util.utcnow() - cycle_start).total_seconds() / 60.0
                applied += params.applied_mm(min(elapsed, per_cycle))
                await self._close(valve)

                if outcome != "completato":
                    motivo = (
                        "master spento durante l'irrigazione"
                        if outcome == "master_spento"
                        else f"la valvola {valve} è stata chiusa dall'esterno"
                    )
                    _LOGGER.warning("Linea %s interrotta: %s", name, motivo)
                    self._store.async_set_deficit(
                        zone_id, max(0.0, deficit - applied)
                    )
                    self._store.async_set_runtime(
                        zone_id,
                        last_irrigation=dt_util.now().isoformat(),
                        last_duration_min=round(min(elapsed, per_cycle), 1),
                        last_trigger="interrotta",
                    )
                    self._fire_failed(zone_id, zone, motivo)
                    # spegnere il master significa fermare tutto, non solo
                    # la linea in corso
                    if outcome == "master_spento":
                        raise IrrigationAborted(motivo)
                    return False

                if cycle < cycles and soak:
                    self._publish(phase="assorbimento")
                    await asyncio.sleep(soak * 60)

        except asyncio.CancelledError:
            await self._close(valve)
            # l'acqua già erogata va comunque scalata dal deficit
            self._store.async_set_deficit(zone_id, max(0.0, deficit - applied))
            raise
        finally:
            await self._close(valve)

        new_deficit = max(0.0, deficit - applied)
        self._store.async_set_deficit(zone_id, new_deficit)
        self._store.async_set_runtime(
            zone_id,
            last_irrigation=dt_util.now().isoformat(),
            last_duration_min=round(total_minutes, 1),
            last_trigger="forzata" if minutes is not None else "automatica",
        )

        next_zone = self._store.zones.get(next_zone_id) if next_zone_id else None
        self._hass.bus.async_fire(
            EVENT_ZONE_FINISHED,
            {
                "zone_id": zone_id,
                "nome": name,
                "minuti": round(total_minutes, 1),
                "acqua_mm": round(applied, 2),
                "deficit_residuo_mm": round(new_deficit, 2),
                "confermata": confirmed_any,
                "flusso": self._flow_value(),
                "prossima_zone_id": next_zone_id,
                "prossima_nome": next_zone.get("name") if next_zone else None,
            },
        )
        return True


def get_executor(hass: HomeAssistant) -> IrrigationExecutor | None:
    return hass.data.get(DOMAIN, {}).get("executor")
