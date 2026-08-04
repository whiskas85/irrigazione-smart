"""Avvio automatico dell'irrigazione all'inizio della finestra.

È il pezzo che rende il sistema autonomo: senza, il bilancio idrico viene
calcolato e il piano mostrato, ma l'acqua non esce mai da sola.

Ogni gruppo ha la propria finestra e i propri giorni: il prato con gli
statici parte presto, le aiuole a goccia possono partire più tardi. Allo
scoccare dell'orario di inizio, nei giorni attivi, si avvia la sequenza di
quel gruppo — che poi irriga solo le linee davvero sotto soglia.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.util import dt as dt_util

from .activity_log import WARNING, get_log
from .const import CATEGORY_LABELS, CATEGORY_ORDER, DOMAIN, FROST_LIMIT_C
from .executor import get_executor
from .hydro import TimeWindow
from .store import WEEKDAYS, IrrigazioneStore

_LOGGER = logging.getLogger(__name__)

# Si controlla ogni minuto: la finestra si imposta al minuto, non al secondo.
CHECK_INTERVAL = timedelta(minutes=1)


def _hhmm_to_minutes(value: str | None) -> int | None:
    """"04:30" -> 270. `None` se il valore non è un orario."""
    if not value or ":" not in value:
        return None
    try:
        hours, _, minutes = value.partition(":")
        return int(hours) * 60 + int(minutes[:2])
    except ValueError:
        return None


def _window_of(group: dict[str, Any]) -> TimeWindow | None:
    """Finestra del gruppo, gestendo anche lo scavalco di mezzanotte."""
    try:
        return TimeWindow.from_strings(
            group.get("window_start") or "", group.get("window_end") or ""
        )
    except (ValueError, IndexError):
        return None


class IrrigationScheduler:
    """Fa partire i gruppi all'orario previsto."""

    def __init__(self, hass: HomeAssistant, store: IrrigazioneStore) -> None:
        self._hass = hass
        self._store = store
        # ultimo motivo di sospensione già scritto nel registro: senza,
        # una giornata di pioggia riempirebbe il log di righe identiche
        self._blocked_note: str | None = None

    def next_run(self, category: str) -> dict[str, Any]:
        """Quando partirà il gruppo, e perché eventualmente non partirà."""
        group = self._store.group(category)

        if not self._store.system.get("master_enabled", True):
            return {"scheduled": False, "reason": "master_disattivo"}
        if not group.get("enabled", True):
            return {"scheduled": False, "reason": "gruppo_disattivato"}
        if not group.get("auto", True):
            return {"scheduled": False, "reason": "avvio_automatico_spento"}

        days = group.get("days") or []
        if not days:
            return {"scheduled": False, "reason": "nessun_giorno_attivo"}

        window = _window_of(group)
        start = _hhmm_to_minutes(group.get("window_start"))
        if window is None or start is None:
            return {"scheduled": False, "reason": "finestra_non_valida"}

        now = dt_util.now()
        now_minutes = now.hour * 60 + now.minute
        today_key = WEEKDAYS[now.weekday()]
        # Una sola partenza automatica al giorno: se è già stata consumata,
        # oggi non succederà più nulla — e va detto, invece di promettere
        # un orario che il programmatore poi ignora.
        already_ran = group.get("last_auto_run") == now.date().isoformat()

        # Se siamo già dentro la finestra e oggi non è ancora partita, il
        # momento buono è adesso: la finestra dice quando è permesso
        # irrigare, non solo l'istante in cui cominciare.
        if today_key in days and window.contains(now_minutes) and not already_ran:
            return {
                "scheduled": True,
                "when": now.isoformat(),
                "today": True,
                "now": True,
            }

        # Altrimenti il prossimo inizio utile — **oggi compreso**, se
        # l'orario di apertura deve ancora arrivare. Ripartire da domani
        # faceva dire "mercoledì" a una finestra che apriva fra sei minuti.
        for offset in range(8):
            day = now + timedelta(days=offset)
            if WEEKDAYS[day.weekday()] not in days:
                continue
            if offset == 0 and (now_minutes >= start or already_ran):
                continue
            return {
                "scheduled": True,
                "when": day.replace(
                    hour=start // 60, minute=start % 60, second=0, microsecond=0
                ).isoformat(),
                "today": offset == 0,
                "already_ran": already_ran,
            }

        return {"scheduled": False, "reason": "nessun_giorno_attivo"}

    @callback
    def async_start(self):
        """Avvia il controllo periodico. Ritorna la funzione di rimozione."""
        return async_track_time_interval(self._hass, self._tick, CHECK_INTERVAL)

    # ------------------------------------------------------- programmato

    def _program_desired(self, now) -> tuple[set[str], list[dict[str, Any]]]:
        """Quali linee devono avere la valvola aperta in questo istante.

        Non si tiene traccia di cosa è già partito: si guarda l'orologio e
        si dice cosa dovrebbe essere aperto adesso. Un riavvio a metà
        programma non perde niente, e due barre sovrapposte diventano due
        valvole aperte senza che nessuno debba orchestrarle.
        """
        program = self._store.program
        if WEEKDAYS[now.weekday()] not in (program.get("days") or []):
            return set(), []

        minuti = now.hour * 60 + now.minute
        attive = [
            barra
            for barra in program.get("bars") or []
            if barra["start_min"] <= minuti < barra["start_min"] + barra["minutes"]
        ]
        zone_ids = set()
        for barra in attive:
            zone = self._store.zones.get(barra["zone_id"])
            if zone and zone.get("enabled", True) and zone.get("valve_entity"):
                zone_ids.add(barra["zone_id"])
        return zone_ids, attive

    def _program_blocked(self) -> str | None:
        """Motivo per cui il meteo ferma il programma, se lo ferma."""
        if not self._store.system.get("program_guards", True):
            return None

        coordinator = self._hass.data.get(DOMAIN, {}).get("coordinator")
        data = (coordinator.data if coordinator else None) or {}
        system = self._store.system

        pioggia = float(data.get("rain_forecast_mm") or 0.0)
        soglia_pioggia = float(system.get("rain_forecast_max_mm") or 0.0)
        if soglia_pioggia and pioggia > soglia_pioggia:
            return f"pioggia prevista {pioggia:.1f} mm"

        vento = float(data.get("wind_kmh") or 0.0)
        soglia_vento = float(system.get("wind_max_kmh") or 0.0)
        if soglia_vento and vento > soglia_vento:
            return f"vento {vento:.0f} km/h"

        # Il gelo si guarda adesso, non sulla minima della notte: alle due
        # del pomeriggio una minima di zero è storia, e bloccherebbe
        # un'irrigazione che non ha nulla da temere.
        temperatura = (data.get("live") or {}).get("temperature")
        if temperatura is not None and float(temperatura) <= FROST_LIMIT_C:
            return "rischio gelo"
        return None

    async def _run_program(self, now) -> None:
        """Allinea le valvole a quello che il programma prevede adesso."""
        executor = get_executor(self._hass)
        if executor is None:
            return

        program = self._store.program
        governate = {
            barra["zone_id"]
            for barra in program.get("bars") or []
            if barra.get("zone_id") in self._store.zones
        }
        if not governate:
            return

        volute: set[str] = set()
        if self._store.system.get("master_enabled", True):
            motivo = self._program_blocked()
            if motivo is None:
                volute, _attive = self._program_desired(now)
            elif self._blocked_note != motivo:
                self._blocked_note = motivo
                activity = get_log(self._hass)
                if activity is not None:
                    activity.add(
                        "config", f"Programma sospeso: {motivo}", level=WARNING
                    )
        if volute:
            self._blocked_note = None

        await executor.async_apply_program(governate, volute)

    async def _tick(self, _now) -> None:
        executor = get_executor(self._hass)
        if executor is None or executor.running:
            return

        # In modalità programmata comanda il Gantt: il bilancio idrico
        # continua a girare, ma non fa più partire niente da sé.
        if self._store.system.get("mode") == "programmato":
            await self._run_program(dt_util.now())
            return

        if not self._store.system.get("master_enabled", True):
            return

        now = dt_util.now()
        today = now.date().isoformat()
        now_minutes = now.hour * 60 + now.minute

        for category in CATEGORY_ORDER:
            group = self._store.group(category)
            if not group.get("enabled", True) or not group.get("auto", True):
                continue
            if WEEKDAYS[now.weekday()] not in (group.get("days") or []):
                continue
            # una sola partenza automatica al giorno per gruppo
            if group.get("last_auto_run") == today:
                continue

            # Basta essere dentro la finestra, non centrarne l'istante
            # iniziale: così l'irrigazione parte anche se Home Assistant
            # era spento a quell'ora, o se la finestra viene spostata a
            # cavallo dell'orario corrente.
            window = _window_of(group)
            if window is None or not window.contains(now_minutes):
                continue

            label = CATEGORY_LABELS.get(category, category)
            partita = await executor.async_start_sequence(
                trigger="programmato", category=category
            )

            if not partita:
                # Nessuna linea sotto soglia: il gruppo NON si segna come
                # eseguito. Marcarlo qui significherebbe che spostando la
                # finestra più avanti nella giornata — o forzando un
                # deficit dopo — l'irrigazione non partirebbe più fino al
                # giorno successivo.
                _LOGGER.debug("%s: orario raggiunto, nessuna linea da irrigare", label)
                continue

            # una sola partenza automatica al giorno per gruppo
            self._store.async_update_group(category, {"last_auto_run": today})

            _LOGGER.info("Avvio automatico del gruppo %s", label)
            activity = get_log(self._hass)
            if activity is not None:
                activity.add("started", f"{label}: avvio automatico programmato")

            # un gruppo per volta: l'impianto ha una sola pressione
            return


def get_scheduler(hass: HomeAssistant) -> IrrigationScheduler | None:
    return hass.data.get(DOMAIN, {}).get("scheduler")
