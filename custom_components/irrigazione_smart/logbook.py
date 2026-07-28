"""Registro delle attività di Irrigazione Smart.

Tiene traccia di cosa ha fatto il sistema: irrigazioni avviate e concluse,
linee saltate, comandi manuali, cambi di configurazione. Serve soprattutto
quando qualcosa non torna — un prato asciutto la mattina dopo — per capire
se l'acqua è davvero uscita e, se no, perché.

Vive in un file di storage separato da quello delle zone: si scrive spesso,
e non deve rimescolare lo stato del bilancio idrico a ogni riga.
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import (
    DOMAIN,
    EVENT_FINISHED,
    EVENT_STARTED,
    EVENT_ZONE_FAILED,
    EVENT_ZONE_FINISHED,
    EVENT_ZONE_STARTED,
    LOG_MAX_ENTRIES,
    SIGNAL_STATE_CHANGED,
    STORAGE_KEY_LOG,
    STORAGE_SAVE_DELAY,
    STORAGE_VERSION,
)

_LOGGER = logging.getLogger(__name__)

# Livelli, usati dal pannello per il colore della riga
INFO = "info"
WARNING = "warning"
ERROR = "error"


class IrrigazioneLog:
    """Elenco cronologico delle attività, il più recente per primo."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY_LOG)
        self._entries: list[dict[str, Any]] = []

    async def async_load(self) -> None:
        stored = await self._store.async_load()
        self._entries = (stored or {}).get("entries", []) if stored else []

    @property
    def entries(self) -> list[dict[str, Any]]:
        return self._entries

    def _save(self) -> None:
        self._store.async_delay_save(
            lambda: {"entries": self._entries}, STORAGE_SAVE_DELAY
        )

    def add(
        self,
        kind: str,
        text: str,
        *,
        level: str = INFO,
        zone_id: str | None = None,
        data: dict[str, Any] | None = None,
    ) -> None:
        """Aggiunge una voce, scartando le più vecchie oltre il limite."""
        self._entries.insert(
            0,
            {
                "ts": dt_util.now().isoformat(),
                "kind": kind,
                "level": level,
                "text": text,
                "zone_id": zone_id,
                "data": data or {},
            },
        )
        # Il registro non deve crescere all'infinito su una SD.
        del self._entries[LOG_MAX_ENTRIES:]
        self._save()
        async_dispatcher_send(self._hass, SIGNAL_STATE_CHANGED)

    def clear(self) -> None:
        self._entries = []
        self._save()
        async_dispatcher_send(self._hass, SIGNAL_STATE_CHANGED)


def _fmt_min(value: Any) -> str:
    try:
        return f"{float(value):.0f}"
    except (TypeError, ValueError):
        return "?"


@callback
def async_subscribe_events(hass: HomeAssistant, log: IrrigazioneLog) -> list:
    """Aggancia il registro agli eventi dell'irrigazione.

    Ritorna le funzioni di rimozione, da chiamare allo scarico dell'entry.
    """

    @callback
    def _started(event: Event) -> None:
        zones = len(event.data.get("zone_ids") or [])
        trigger = event.data.get("trigger", "manuale")
        if event.data.get("singola_linea"):
            log.add("started", f"Avvio irrigazione di una linea ({trigger})")
        else:
            log.add(
                "started",
                f"Avvio sequenza su {zones} "
                f"{'linea' if zones == 1 else 'linee'} ({trigger})",
            )

    @callback
    def _finished(event: Event) -> None:
        failed = event.data.get("linee_fallite") or []
        done = event.data.get("linee_completate") or []
        durata = _fmt_min(event.data.get("durata_min"))
        interrotta = event.data.get("interrotta")

        if interrotta:
            log.add(
                "finished",
                f"Irrigazione interrotta dopo {durata} min: {interrotta}",
                level=WARNING,
                data=dict(event.data),
            )
        elif failed:
            log.add(
                "finished",
                f"Irrigazione conclusa in {durata} min: "
                f"{len(done)} completate, {len(failed)} non partite",
                level=WARNING,
                data=dict(event.data),
            )
        else:
            log.add(
                "finished",
                f"Irrigazione conclusa in {durata} min: "
                f"{len(done)} {'linea' if len(done) == 1 else 'linee'}",
                data=dict(event.data),
            )

    @callback
    def _zone_started(event: Event) -> None:
        nome = event.data.get("nome", "linea")
        minuti = _fmt_min(event.data.get("minuti"))
        cicli = event.data.get("cicli", 1)
        extra = f" in {cicli} cicli" if cicli and cicli > 1 else ""
        log.add(
            "zone_started",
            f"{nome}: apertura valvola per {minuti} min{extra}",
            zone_id=event.data.get("zone_id"),
            data=dict(event.data),
        )

    @callback
    def _zone_finished(event: Event) -> None:
        nome = event.data.get("nome", "linea")
        acqua = event.data.get("acqua_mm")
        residuo = event.data.get("deficit_residuo_mm")
        log.add(
            "zone_finished",
            f"{nome}: irrigata, {acqua} mm erogati "
            f"(deficit residuo {residuo} mm)",
            zone_id=event.data.get("zone_id"),
            data=dict(event.data),
        )

    @callback
    def _zone_failed(event: Event) -> None:
        nome = event.data.get("nome", "linea")
        motivo = event.data.get("motivo", "motivo sconosciuto")
        log.add(
            "zone_failed",
            f"{nome}: non irrigata — {motivo}",
            level=ERROR,
            zone_id=event.data.get("zone_id"),
            data=dict(event.data),
        )

    return [
        hass.bus.async_listen(EVENT_STARTED, _started),
        hass.bus.async_listen(EVENT_FINISHED, _finished),
        hass.bus.async_listen(EVENT_ZONE_STARTED, _zone_started),
        hass.bus.async_listen(EVENT_ZONE_FINISHED, _zone_finished),
        hass.bus.async_listen(EVENT_ZONE_FAILED, _zone_failed),
    ]


def get_log(hass: HomeAssistant) -> IrrigazioneLog | None:
    return hass.data.get(DOMAIN, {}).get("log")
