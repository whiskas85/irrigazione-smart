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

from .const import CATEGORY_LABELS, CATEGORY_ORDER, DOMAIN
from .executor import get_executor
from .hydro import TimeWindow
from .logbook import get_log
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

        # Se siamo già dentro la finestra e oggi non è ancora partita, il
        # momento buono è adesso: la finestra dice quando è permesso
        # irrigare, non solo l'istante in cui cominciare.
        if (
            today_key in days
            and window.contains(now_minutes)
            and group.get("last_auto_run") != now.date().isoformat()
        ):
            return {
                "scheduled": True,
                "when": now.isoformat(),
                "today": True,
                "now": True,
            }

        # altrimenti il prossimo inizio utile
        for offset in range(1, 8):
            day = now + timedelta(days=offset)
            if WEEKDAYS[day.weekday()] not in days:
                continue
            return {
                "scheduled": True,
                "when": day.replace(
                    hour=start // 60, minute=start % 60, second=0, microsecond=0
                ).isoformat(),
                "today": False,
            }

        return {"scheduled": False, "reason": "nessun_giorno_attivo"}

    @callback
    def async_start(self):
        """Avvia il controllo periodico. Ritorna la funzione di rimozione."""
        return async_track_time_interval(self._hass, self._tick, CHECK_INTERVAL)

    async def _tick(self, _now) -> None:
        executor = get_executor(self._hass)
        if executor is None or executor.running:
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
