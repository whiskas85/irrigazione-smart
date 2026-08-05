"""Chi sta bagnando lo dice la valvola.

Per sapere se una linea sta irrigando c'è una sola fonte onesta: lo stato
della sua valvola. Non il piano che abbiamo in mente, non la sequenza che
crediamo di stare eseguendo — quelli dicono cosa *dovrebbe* succedere.

La differenza non è teorica. Una valvola può aprirla un'automazione di
casa, il pulsante sul muro, l'app del produttore o un vecchio programma
rimasto acceso: l'acqua esce lo stesso, il prato la riceve lo stesso, e
un pannello che continuasse a mostrare quell'area spenta racconterebbe
una cosa falsa proprio nel momento in cui conta.

Qui si ascoltano le valvole di tutte le linee e si sveglia il resto
dell'integration a ogni cambio, così le entità esposte e la pagina si
allineano nell'istante in cui l'acqua parte — non al giro di controllo
successivo, che può essere un minuto dopo.
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.helpers.dispatcher import (
    async_dispatcher_connect,
    async_dispatcher_send,
)
from homeassistant.helpers.event import async_track_state_change_event

from .const import DOMAIN, SIGNAL_STATE_CHANGED, SIGNAL_ZONES_CHANGED
from .store import IrrigazioneStore

_LOGGER = logging.getLogger(__name__)

# Stati che contano come "sta uscendo acqua". `switch` e `input_boolean`
# usano `on`, il dominio `valve` usa `open`.
OPEN_STATES = frozenset({"on", "open", "opening"})


def valve_is_open(hass: HomeAssistant, entity_id: str | None) -> bool:
    """True se quella valvola risulta aperta adesso."""
    if not entity_id:
        return False
    state = hass.states.get(entity_id)
    return state is not None and state.state in OPEN_STATES


def zone_is_watering(hass: HomeAssistant, zone: dict[str, Any] | None) -> bool:
    """True se la linea sta ricevendo acqua, chiunque abbia aperto."""
    return valve_is_open(hass, (zone or {}).get("valve_entity"))


def watering_zone_ids(hass: HomeAssistant, store: IrrigazioneStore) -> list[str]:
    """Le linee con la valvola aperta in questo momento."""
    return [
        zone_id
        for zone_id, zone in store.zones.items()
        if zone_is_watering(hass, zone)
    ]


class ValveWatcher:
    """Tiene d'occhio le valvole e sveglia entità e pagina a ogni cambio."""

    def __init__(self, hass: HomeAssistant, store: IrrigazioneStore) -> None:
        self._hass = hass
        self._store = store
        self._unsub_states: CALLBACK_TYPE | None = None

    @callback
    def async_start(self) -> CALLBACK_TYPE:
        """Comincia ad ascoltare. Ritorna la funzione per smettere."""
        self._resubscribe()
        # le linee si creano e si eliminano a runtime: la lista delle
        # valvole da ascoltare va rifatta quando cambiano
        unsub_zones = async_dispatcher_connect(
            self._hass, SIGNAL_ZONES_CHANGED, self._resubscribe
        )

        @callback
        def _stop() -> None:
            unsub_zones()
            if self._unsub_states is not None:
                self._unsub_states()
                self._unsub_states = None

        return _stop

    @callback
    def _resubscribe(self) -> None:
        if self._unsub_states is not None:
            self._unsub_states()
            self._unsub_states = None

        valvole = sorted(
            {
                zone["valve_entity"]
                for zone in self._store.zones.values()
                if zone.get("valve_entity")
            }
        )
        if not valvole:
            return

        self._unsub_states = async_track_state_change_event(
            self._hass, valvole, self._changed
        )
        _LOGGER.debug("In ascolto su %d valvole", len(valvole))

    @callback
    def _changed(self, event) -> None:
        """Una valvola si è mossa: si riallinea tutto quanto."""
        vecchio = event.data.get("old_state")
        nuovo = event.data.get("new_state")
        if vecchio is None or nuovo is None:
            return
        # apre o chiude: i passaggi da e verso `unavailable` non
        # cambiano cosa sta bagnando, e sveglierebbero mezza pagina per
        # una radio che ha perso un pacchetto
        if (vecchio.state in OPEN_STATES) == (nuovo.state in OPEN_STATES):
            return

        async_dispatcher_send(self._hass, SIGNAL_STATE_CHANGED)


def get_valve_watcher(hass: HomeAssistant) -> ValveWatcher | None:
    return hass.data.get(DOMAIN, {}).get("valves")
