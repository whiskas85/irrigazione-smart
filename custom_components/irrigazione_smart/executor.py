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
from dataclasses import dataclass
from datetime import timedelta
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
    EVENT_VALVE_STUCK,
    SIGNAL_STATE_CHANGED,
    VALVE_CLOSE_ATTEMPTS,
    VALVE_CONFIRM_TIMEOUT,
    VALVE_RETRIES,
    VALVE_RETRY_PAUSE_S,
    zone_category,
)
from .hydro import (
    RunPlan,
    ZoneParams,
    evaluate_zone,
    interleave_cycles,
    resolve_zone_params,
)
from .logbook import ERROR, WARNING, get_log
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


@dataclass
class _ZoneRun:
    """Una linea in corso di irrigazione, con quanto le è già arrivato.

    Esiste perché le passate di una linea non sono più consecutive: fra
    la prima e la seconda ne passano altre, e quello che è stato erogato
    va tenuto da parte fino alla fine.
    """

    zone_id: str
    name: str
    valve: str
    params: ZoneParams
    deficit: float
    total_minutes: float
    cycles: int
    soak_minutes: int
    forced: bool = False

    applied: float = 0.0
    minutes_done: float = 0.0
    done_cycles: int = 0
    confirmed: bool = False
    started: bool = False
    failed: bool = False
    completed: bool = False
    abort_reason: str | None = None
    # istante del loop da cui la linea può ricevere la passata successiva
    ready_at: float | None = None
    next_zone_id: str | None = None
    next_name: str | None = None

    @property
    def per_cycle(self) -> float:
        return self.total_minutes / self.cycles if self.cycles else self.total_minutes


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

        ends = state.get("wait_ends_at")
        if ends is not None:
            left = (ends - dt_util.utcnow()).total_seconds() / 60.0
            state["wait_remaining_min"] = round(max(0.0, left), 2)
            state["wait_ends_at"] = ends.isoformat()

        started = state.pop("cycle_started_at", None)
        # Avanzamento contato sui minuti d'acqua, non sull'orologio: con
        # le passate alternate fra le linee, fra un ciclo e l'altro di una
        # zona ne passano altre, e una barra a tempo reale segnerebbe il
        # 100% quando la linea ha ricevuto un quarto dell'acqua.
        done = float(state.get("zone_done_min") or 0.0)
        corrente = 0.0
        if started:
            corrente = (dt_util.utcnow() - started).total_seconds() / 60.0
            done += corrente
            state["cycle_started_at"] = started.isoformat()

        total = state.get("zone_total_min") or 0
        state["elapsed_min"] = round(min(done, total) if total else done, 1)
        state["progress"] = (
            round(min(100.0, done / total * 100.0), 1) if total else 0.0
        )

        # I contatori per linea si aggiornano a fine passata; qui si
        # aggiunge quella in corso, altrimenti la barra della linea che
        # sta bagnando resterebbe ferma per tutta la passata.
        if corrente > 0 and state.get("progress_zones"):
            linee = {k: dict(v) for k, v in state["progress_zones"].items()}
            attiva = linee.get(state.get("zone_id"))
            if attiva:
                vivo = min(attiva["totale_min"], attiva["fatti_min"] + corrente)
                delta = vivo - attiva["fatti_min"]
                attiva["fatti_min"] = round(vivo, 1)
                state["progress_zones"] = linee
                fatti = float(state.get("progress_done_min") or 0.0) + delta
                totali = float(state.get("progress_total_min") or 0.0)
                state["progress_done_min"] = round(fatti, 1)
                state["progress_overall"] = (
                    round(min(100.0, fatti / totali * 100.0), 1) if totali else 0.0
                )

        state["active"] = True
        return state

    def _publish(self, **changes: Any) -> None:
        self._state.update(changes)
        async_dispatcher_send(self._hass, SIGNAL_STATE_CHANGED)

    def _publish_progress(self, runs: list[_ZoneRun]) -> None:
        """Avanzamento di ogni linea e dell'intera sequenza.

        Serve perché con le passate alternate non si capisce più a che
        punto si è: una linea può aver ricevuto tre passate su quattro
        mentre un'altra non ha ancora cominciato, e la scheda in cima
        parla solo di quella del momento.

        Si misura in **minuti d'acqua**, non in passate: le passate sono
        tutte uguali, ma una interrotta a metà ha dato meno delle altre.
        """
        linee = {}
        fatti = 0.0
        totali = 0.0

        for run in runs:
            done = min(run.minutes_done, run.total_minutes)
            linee[run.zone_id] = {
                "nome": run.name,
                "fatti_min": round(done, 1),
                "totale_min": round(run.total_minutes, 1),
                "passate_fatte": run.done_cycles,
                "passate": run.cycles,
                "stato": (
                    "fallita"
                    if run.failed
                    else "completata"
                    if run.completed
                    else "in corso"
                    if run.started
                    else "in attesa"
                ),
            }
            fatti += done
            totali += run.total_minutes

        self._publish(
            progress_zones=linee,
            progress_done_min=round(fatti, 1),
            progress_total_min=round(totali, 1),
            progress_overall=round(fatti / totali * 100.0, 1) if totali else 0.0,
        )

    @staticmethod
    def _wait_state(minutes: float) -> dict[str, Any]:
        """Quanto dura l'attesa e quando finisce.

        Si manda l'istante di fine e non i minuti che restano: la pagina
        si aggiorna ogni pochi secondi, e un conto alla rovescia calcolato
        di là scorre liscio invece di scattare a strappi.
        """
        return {
            "wait_total_min": round(minutes, 2),
            "wait_ends_at": dt_util.utcnow() + timedelta(minutes=minutes),
        }

    # ------------------------------------------------------------ valvole

    def _live_guards(self) -> dict[str, float]:
        """Vento e pioggia prevista correnti, per le guardie meteo.

        Li tiene il coordinator: senza passarli qui, la sequenza
        automatica irrigherebbe anche col temporale in arrivo.
        """
        coordinator = self._hass.data.get(DOMAIN, {}).get("coordinator")
        data = (coordinator.data if coordinator else None) or {}
        return {
            "wind_kmh": float(data.get("wind_kmh") or 0.0),
            "rain_forecast_mm": float(data.get("rain_forecast_mm") or 0.0),
        }

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
        """Chiude la valvola, senza sollevare eccezioni.

        Comando e basta, senza verifica: si usa dove la chiusura è un
        gesto di igiene — dopo un'apertura non confermata, dove la
        valvola non era comunque aperta.
        """
        try:
            await self._switch_valve(entity_id, False)
        except Exception:
            _LOGGER.exception("Chiusura della valvola %s fallita", entity_id)

    async def _close_confirmed(self, entity_id: str, zone_name: str) -> bool:
        """Chiude la valvola e **pretende** la conferma, insistendo.

        È il caso più grave che questo software possa incontrare. Una
        valvola che non apre lascia un prato asciutto; una valvola che non
        chiude allaga il giardino, svuota il pozzo o manda in blocco
        l'autoclave, e continua a farlo finché qualcuno non se ne accorge
        di persona. Per questo si insiste molto più che in apertura, e per
        questo il fallimento non finisce solo nel registro ma diventa una
        notifica che resta lì finché non la si chiude a mano.
        """
        timeout = float(
            self._store.system.get("valve_timeout_s") or VALVE_CONFIRM_TIMEOUT
        )

        for tentativo in range(1, VALVE_CLOSE_ATTEMPTS + 1):
            await self._close(entity_id)
            if await self._wait_for_state(entity_id, CLOSED_STATES, timeout):
                if tentativo > 1:
                    _LOGGER.warning(
                        "La valvola %s si è chiusa al tentativo %d",
                        entity_id,
                        tentativo,
                    )
                return True

            _LOGGER.error(
                "La valvola %s della linea %s non conferma la chiusura "
                "(tentativo %d di %d)",
                entity_id,
                zone_name,
                tentativo,
                VALVE_CLOSE_ATTEMPTS,
            )
            if tentativo < VALVE_CLOSE_ATTEMPTS:
                await asyncio.sleep(VALVE_RETRY_PAUSE_S)

        self._alert_stuck_open(entity_id, zone_name)
        return False

    def _mark_open(self, entity_id: str | None) -> None:
        """Annota su disco quale valvola è aperta in questo istante.

        È l'unica informazione che sopravvive a un riavvio improvviso, ed
        è quella che al ritorno permette di andare a chiudere proprio
        quella invece di tentare alla cieca su tutte.
        """
        active = self._store.system.get("active_run")
        if not active:
            return
        self._store.async_set_active_run({**active, "aperta": entity_id})

    def _alert_stuck_open(self, entity_id: str, zone_name: str) -> None:
        """Notifica persistente: la valvola potrebbe essere rimasta aperta.

        Persistente di proposito. Una riga di registro la si legge se la
        si va a cercare; questa resta davanti agli occhi a ogni apertura
        di Home Assistant finché non la si scarta, che è esattamente il
        comportamento che serve quando dall'altra parte sta uscendo acqua.
        """
        messaggio = (
            f"La valvola **{entity_id}** della linea **{zone_name}** non ha "
            f"confermato la chiusura dopo {VALVE_CLOSE_ATTEMPTS} tentativi.\n\n"
            "Potrebbe essere rimasta aperta: **controlla l'impianto di "
            "persona** e chiudi la valvola a mano se serve.\n\n"
            "L'irrigazione è stata interrotta per non aprirne altre."
        )

        self._hass.async_create_task(
            self._hass.services.async_call(
                "persistent_notification",
                "create",
                {
                    "title": "Irrigazione: valvola forse rimasta aperta",
                    "message": messaggio,
                    # id fisso per valvola: una valvola che sbaglia dieci
                    # volte non deve produrre dieci notifiche identiche
                    "notification_id": f"{DOMAIN}_valvola_aperta_{entity_id}",
                },
                blocking=False,
            )
        )

        activity = get_log(self._hass)
        if activity is not None:
            activity.add(
                "zone_failed",
                f"{zone_name}: la valvola {entity_id} non ha confermato la "
                f"chiusura — potrebbe essere rimasta aperta",
                level=ERROR,
            )

        self._hass.bus.async_fire(
            EVENT_VALVE_STUCK,
            {"valvola": entity_id, "nome": zone_name, "tentativi": VALVE_CLOSE_ATTEMPTS},
        )

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

    async def async_start_sequence(
        self, trigger: str = "manuale", category: str | None = None
    ) -> bool:
        """Irriga le linee che lo richiedono, in ordine.

        Con `category` si irriga un solo gruppo — il prato senza le aiuole,
        per esempio, che hanno irrigatori e tempi diversi.

        Ritorna True solo se l'irrigazione è davvero partita: chi programma
        deve poter distinguere "fatto" da "non c'era nulla da fare".
        """
        if self.running:
            _LOGGER.warning("Irrigazione già in corso: comando ignorato")
            return False

        system = self._store.system
        queue: list[tuple[str, float | None]] = []
        for zone in self._store.zones_sorted():
            if category and zone_category(zone.get("zone_type")) != category:
                continue
            plan = evaluate_zone(
                zone,
                system,
                float(zone.get("deficit_mm") or 0.0),
                **self._live_guards(),
            )
            if plan.should_run:
                queue.append((zone["id"], None))

        if not queue:
            _LOGGER.info(
                "Sequenza non avviata: nessuna linea%s richiede acqua",
                f" del gruppo {category}" if category else "",
            )
            return False

        self._task = self._hass.async_create_task(self._run(queue, trigger=trigger))
        return True

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
        aborted_reason: str | None = None

        self._hass.bus.async_fire(
            EVENT_STARTED,
            {
                "trigger": trigger,
                "zone_ids": [zid for zid, _ in queue],
                "singola_linea": single,
            },
        )

        runs = [self._prepare(zone_id, minutes) for zone_id, minutes in queue]
        runs = [run for run in runs if run is not None]
        steps = self._interleaved_steps(runs)

        # Segnaposto per ritrovare l'irrigazione se Home Assistant se ne
        # va nel mezzo: senza, al riavvio nessuno sa che c'era una valvola
        # aperta e resta aperta.
        self._store.async_set_active_run(
            {
                "started_at": dt_util.utcnow().isoformat(),
                "trigger": trigger,
                "valvole": [run.valve for run in runs],
                "aperta": None,
            }
        )

        # "prossima linea" nelle notifiche: con le passate alternate non è
        # più la successiva in elenco, ma quella che finirà dopo di questa
        finishing = []
        for run, cycle in steps:
            if cycle >= run.cycles:
                finishing.append(run)
        for current, following in zip(finishing, finishing[1:]):
            current.next_zone_id = following.zone_id
            current.next_name = following.name

        try:
            await self._execute(steps, runs)
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
            self._store.async_set_active_run(None)
            self._state = {}
            self._hass.bus.async_fire(
                EVENT_FINISHED,
                {
                    "trigger": trigger,
                    "durata_min": round(duration, 1),
                    "linee_completate": [r.zone_id for r in runs if r.completed],
                    "linee_fallite": [r.zone_id for r in runs if r.failed],
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

    # ------------------------------------------------- passate alternate

    def _prepare(self, zone_id: str, minutes: float | None) -> _ZoneRun | None:
        """Risolve il piano di una linea prima che la sequenza cominci.

        Si fa tutto adesso perché l'alternanza delle passate va decisa
        conoscendo cicli e assorbimenti di tutte le linee insieme.
        """
        zone = self._store.zones.get(zone_id)
        if zone is None:
            return None

        system = self._store.system
        params = resolve_zone_params(zone, system)
        deficit = float(zone.get("deficit_mm") or 0.0)

        # durata: quella forzata dall'utente, o quella calcolata dal motore
        if minutes is None:
            plan = evaluate_zone(zone, system, deficit, **self._live_guards())
            if not plan.should_run:
                _LOGGER.info("Linea %s saltata: %s", zone.get("name"), plan.reason)
                self._fire_failed(zone_id, zone, plan.reason)
                return None
            total_minutes = plan.total_minutes
            cycles = max(1, plan.cycles)
            soak = plan.soak_minutes
        else:
            total_minutes = float(minutes)
            cycles = 1
            soak = 0

        valve = zone.get("valve_entity")
        if not valve:
            _LOGGER.warning("Linea %s senza entità valvola: saltata", zone.get("name"))
            self._fire_failed(zone_id, zone, "nessuna valvola configurata")
            return None

        return _ZoneRun(
            zone_id=zone_id,
            name=zone.get("name") or "linea",
            valve=valve,
            params=params,
            deficit=deficit,
            total_minutes=total_minutes,
            cycles=cycles,
            soak_minutes=soak,
            forced=minutes is not None,
        )

    def _interleaved_steps(self, runs: list[_ZoneRun]) -> list[tuple[_ZoneRun, int]]:
        """Ordine delle passate, alternando le linee.

        L'ordine lo decide `hydro.interleave_cycles`, lo stesso codice che
        disegna il programma in pagina: se qui si irrigasse in un ordine
        diverso, la pagina mostrerebbe una cosa e l'impianto ne farebbe
        un'altra. Gli orari calcolati lì servono solo a stabilire la
        successione — i tempi veri li impone l'esecuzione, che può
        slittare aspettando la conferma di una valvola.
        """
        plans = [
            (
                run.zone_id,
                run.name,
                RunPlan(
                    should_run=True,
                    reason="ok",
                    total_minutes=run.total_minutes,
                    cycles=run.cycles,
                    minutes_per_cycle=run.per_cycle,
                    soak_minutes=run.soak_minutes,
                ),
            )
            for run in runs
        ]
        by_id = {run.zone_id: run for run in runs}
        gap = int(self._store.system.get("gap_minutes", 5) or 0)

        return [
            (by_id[cycle.zone_id], cycle.cycle)
            for cycle in interleave_cycles(plans, 0.0, gap_minutes=gap)
        ]

    async def _execute(
        self, steps: list[tuple[_ZoneRun, int]], runs: list[_ZoneRun]
    ) -> None:
        """Esegue le passate nell'ordine stabilito, una valvola per volta."""
        gap = int(self._store.system.get("gap_minutes", 5) or 0)
        loop = self._hass.loop
        previous: _ZoneRun | None = None

        # tutte le linee compaiono subito a zero: la lista deve dire
        # "questa non ha ancora cominciato", non tacere
        self._publish_progress(runs)

        for run, cycle in steps:
            # una linea che ha già fallito non riprova le passate rimaste:
            # se la valvola non ha risposto, non risponderà fra dieci minuti
            if run.failed:
                continue

            # Nome, id e numero di passata descrivono sempre la **stessa**
            # linea: quella che sta per ricevere acqua. Aggiornarne uno
            # solo lasciava in pagina il nome di chi aveva appena finito
            # accanto all'identificativo di chi doveva ancora cominciare,
            # e la lista evidenziava una linea diversa da quella scritta
            # in testa.
            if previous is not None and gap:
                self._publish(
                    phase="pausa_tra_linee",
                    zone_id=run.zone_id,
                    zone_name=run.name,
                    cycle=cycle,
                    cycles=run.cycles,
                    **self._wait_state(gap),
                )
                if not await self._pause(gap):
                    raise IrrigationAborted("master spento durante la pausa")

            # Assorbimento: si aspetta solo quello che manca davvero. Con
            # molte linee è già trascorso mentre irrigavano le altre, ed è
            # tutto il punto dell'alternanza.
            if run.ready_at is not None:
                left = (run.ready_at - loop.time()) / 60.0
                if left > 0:
                    self._publish(
                        phase="assorbimento",
                        zone_id=run.zone_id,
                        zone_name=run.name,
                        cycle=cycle,
                        cycles=run.cycles,
                        **self._wait_state(left),
                    )
                    if not await self._pause(left):
                        raise IrrigationAborted(
                            "master spento durante l'assorbimento"
                        )

            if not run.started:
                run.started = True
                self._fire_zone_started(run)

            ok = await self._run_cycle(run, cycle)
            previous = run

            if not ok:
                run.failed = True
                self._finalize(run, interrupted=True)
                self._publish_progress(runs)
                if run.abort_reason:
                    raise IrrigationAborted(run.abort_reason)
                continue

            run.done_cycles = cycle
            run.ready_at = loop.time() + run.soak_minutes * 60.0
            if cycle >= run.cycles:
                run.completed = True
                self._finalize(run)
            self._publish_progress(runs)

    def _fire_zone_started(self, run: _ZoneRun) -> None:
        self._hass.bus.async_fire(
            EVENT_ZONE_STARTED,
            {
                "zone_id": run.zone_id,
                "nome": run.name,
                "minuti": round(run.total_minutes, 1),
                "cicli": run.cycles,
                "pausa_min": run.soak_minutes,
                "valvola": run.valve,
                "deficit_mm": round(run.deficit, 2),
                "portata_mm_h": run.params.rate_mm_h,
                "flusso": self._flow_value(),
            },
        )

    async def _open_with_retries(self, run: _ZoneRun) -> bool:
        """Apre la valvola, riprovando prima di rinunciare.

        Il principio resta quello di sempre: non si dà mai per scontato
        che una linea stia irrigando solo perché è stato dato il comando.
        Ma un silenzio solo non prova che la valvola sia guasta — una
        radio o una batteria possono perdere un comando e rispondere al
        successivo, e rinunciare al primo tentativo salta un'irrigazione
        per un pacchetto perso.

        Dopo l'ultimo tentativo la linea viene saltata **per questa
        irrigazione**: le passate rimaste non si riprovano, perché una
        valvola che ha taciuto tre volte di fila non risponderà fra mezz'ora.
        """
        system = self._store.system
        tentativi = 1 + max(0, int(system.get("valve_retries", VALVE_RETRIES) or 0))
        activity = get_log(self._hass)

        for tentativo in range(1, tentativi + 1):
            if await self._open_confirmed(run.valve):
                if tentativo > 1:
                    _LOGGER.info(
                        "La valvola %s ha confermato al tentativo %d",
                        run.valve,
                        tentativo,
                    )
                    if activity is not None:
                        activity.add(
                            "zone_started",
                            f"{run.name}: valvola aperta al tentativo "
                            f"{tentativo} di {tentativi}",
                            zone_id=run.zone_id,
                        )
                return True

            # il comando resta appeso: si richiude prima di riprovare,
            # così il tentativo dopo parte da una condizione nota
            await self._close(run.valve)

            if tentativo >= tentativi:
                break

            _LOGGER.warning(
                "La valvola %s della linea %s non ha confermato "
                "(tentativo %d di %d): riprovo",
                run.valve,
                run.name,
                tentativo,
                tentativi,
            )
            if activity is not None:
                activity.add(
                    "zone_failed",
                    f"{run.name}: nessuna conferma dalla valvola "
                    f"(tentativo {tentativo} di {tentativi}), riprovo",
                    level=WARNING,
                    zone_id=run.zone_id,
                )

            if not await self._pause(VALVE_RETRY_PAUSE_S / 60.0):
                run.abort_reason = "master spento durante i tentativi di apertura"
                return False

        _LOGGER.error(
            "La valvola %s della linea %s non ha confermato l'apertura "
            "in %d tentativi: linea saltata",
            run.valve,
            run.name,
            tentativi,
        )
        self._fire_failed(
            run.zone_id,
            self._store.zones.get(run.zone_id) or {},
            f"la valvola {run.valve} non ha confermato l'apertura "
            f"in {tentativi} tentativi",
        )
        return False

    async def _run_cycle(self, run: _ZoneRun, cycle: int) -> bool:
        """Una singola passata: apri, sorveglia, chiudi.

        Ritorna False se la valvola non ha confermato o è stata chiusa da
        fuori. In quel caso `run.abort_reason` dice se va fermata tutta la
        sequenza — spegnere il master ferma tutto, non solo questa linea.
        """
        self._publish(
            zone_id=run.zone_id,
            zone_name=run.name,
            phase="irrigazione",
            cycle=cycle,
            cycles=run.cycles,
            zone_total_min=run.total_minutes,
            zone_done_min=round(run.per_cycle * (cycle - 1), 2),
            cycle_started_at=dt_util.utcnow(),
            # l'attesa è finita: senza azzerarli, il conto alla rovescia
            # resterebbe a schermo mentre l'acqua sta già uscendo
            wait_total_min=None,
            wait_ends_at=None,
        )

        try:
            if not await self._open_with_retries(run):
                return False

            run.confirmed = True
            self._mark_open(run.valve)
            began = dt_util.utcnow()
            outcome = await self._irrigate_for(run.valve, run.per_cycle)
            elapsed = (dt_util.utcnow() - began).total_seconds() / 60.0
            run.applied += run.params.applied_mm(min(elapsed, run.per_cycle))
            run.minutes_done += min(elapsed, run.per_cycle)

            # L'acqua erogata si mette a bilancio adesso, non alla fine
            # della linea: se Home Assistant si riavvia fra una passata e
            # l'altra, questa passata è comunque uscita e il terreno l'ha
            # ricevuta. Contarla solo in fondo la farebbe sparire.
            self._store.async_set_deficit(
                run.zone_id, max(0.0, run.deficit - run.applied)
            )

            # Qui la valvola era davvero aperta: la chiusura va confermata,
            # e se non arriva è la cosa più grave che possa succedere.
            if not await self._close_confirmed(run.valve, run.name):
                run.abort_reason = (
                    f"la valvola {run.valve} non ha confermato la chiusura"
                )
                return False
            self._mark_open(None)

            if outcome != "completato":
                motivo = (
                    "master spento durante l'irrigazione"
                    if outcome == "master_spento"
                    else f"la valvola {run.valve} è stata chiusa dall'esterno"
                )
                _LOGGER.warning("Linea %s interrotta: %s", run.name, motivo)
                self._fire_failed(
                    run.zone_id, self._store.zones.get(run.zone_id) or {}, motivo
                )
                if outcome == "master_spento":
                    run.abort_reason = motivo
                return False

        except asyncio.CancelledError:
            # Fermare l'irrigazione non deve poter lasciare acqua aperta:
            # si insiste sulla chiusura anche qui, dove il task è già
            # stato cancellato. `shield` serve perché un `await` dentro un
            # task cancellato verrebbe interrotto di nuovo all'istante.
            with contextlib.suppress(Exception):
                await asyncio.shield(
                    asyncio.ensure_future(
                        self._close_confirmed(run.valve, run.name)
                    )
                )
            # l'acqua già erogata va comunque scalata dal deficit
            self._store.async_set_deficit(
                run.zone_id, max(0.0, run.deficit - run.applied)
            )
            raise

        return True

    def _finalize(self, run: _ZoneRun, interrupted: bool = False) -> None:
        """Chiude i conti di una linea: deficit, storico, evento.

        Si scrive solo l'acqua **davvero** erogata: una linea interrotta a
        metà lascia il resto a bilancio e lo recupera il giorno dopo.
        """
        new_deficit = max(0.0, run.deficit - run.applied)
        self._store.async_set_deficit(run.zone_id, new_deficit)
        self._store.async_set_runtime(
            run.zone_id,
            last_irrigation=dt_util.now().isoformat(),
            last_duration_min=round(run.minutes_done, 1),
            last_trigger=(
                "interrotta"
                if interrupted
                else ("forzata" if run.forced else "automatica")
            ),
        )

        if interrupted:
            return

        zone = self._store.zones.get(run.zone_id) or {}
        # minuti della giornata, per il grafico dell'irrigazione nel tempo
        self._store.async_add_irrigation(
            zone_category(zone.get("zone_type")), round(run.minutes_done, 1)
        )
        self._hass.bus.async_fire(
            EVENT_ZONE_FINISHED,
            {
                "zone_id": run.zone_id,
                "nome": run.name,
                "minuti": round(run.minutes_done, 1),
                "acqua_mm": round(run.applied, 2),
                "deficit_residuo_mm": round(new_deficit, 2),
                "confermata": run.confirmed,
                "flusso": self._flow_value(),
                "prossima_zone_id": run.next_zone_id,
                "prossima_nome": run.next_name,
            },
        )

def get_executor(hass: HomeAssistant) -> IrrigationExecutor | None:
    return hass.data.get(DOMAIN, {}).get("executor")
