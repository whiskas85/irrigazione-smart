"""Basi comuni alle entità di Irrigazione Smart.

Ogni linea diventa un dispositivo a sé in Home Assistant: così le sue
entità si raggruppano da sole, si possono assegnare a un'area e restano
ordinate anche con dieci linee.
"""

from __future__ import annotations

from typing import Any

from homeassistant.core import callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity import Entity

from .const import DOMAIN, SIGNAL_STATE_CHANGED
from .store import IrrigazioneStore

MANUFACTURER = "Irrigazione Smart"

# Dalla scheda del dispositivo si arriva alla pagina dell'integration con
# un clic, invece di doverla cercare nella barra laterale.
PANEL_LINK = "homeassistant://irrigazione-smart"


def system_device_info(entry_id: str) -> DeviceInfo:
    """Dispositivo che rappresenta l'impianto nel suo insieme."""
    return DeviceInfo(
        identifiers={(DOMAIN, f"{entry_id}_system")},
        name="Irrigazione Smart",
        manufacturer=MANUFACTURER,
        configuration_url=PANEL_LINK,
        entry_type=None,
    )


def zone_device_info(entry_id: str, zone: dict[str, Any]) -> DeviceInfo:
    """Dispositivo che rappresenta una singola linea."""
    return DeviceInfo(
        identifiers={(DOMAIN, f"{entry_id}_{zone['id']}")},
        name=zone.get("name") or "Linea",
        manufacturer=MANUFACTURER,
        model="Linea di irrigazione",
        configuration_url=PANEL_LINK,
        via_device=(DOMAIN, f"{entry_id}_system"),
    )


class IrrigazioneEntity(Entity):
    """Entità che si ridisegna quando cambia lo stato condiviso."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, entry_id: str, store: IrrigazioneStore) -> None:
        self._entry_id = entry_id
        self._store = store

    async def async_added_to_hass(self) -> None:
        """Si aggancia al segnale interno di cambio stato.

        Il pannello e le entità scrivono sullo stesso store: senza questo
        aggancio, spegnere il master dalla pagina non aggiornerebbe
        l'interruttore esposto (e viceversa).
        """
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass, SIGNAL_STATE_CHANGED, self._handle_state_changed
            )
        )

    @callback
    def _handle_state_changed(self) -> None:
        """Riscrive lo stato dell'entità.

        Il decoratore non è un dettaglio: senza, Home Assistant considera
        questa funzione lavoro sincrono e la esegue in un thread del pool.
        `async_write_ha_state` da lì solleva un RuntimeError, che il
        dispatcher inghiotte come errore isolato — e l'entità resta ferma
        all'ultimo valore scritto all'avvio, mentre il pannello, che legge
        lo store via HTTP, mostra il numero aggiornato. Da fuori sembrava
        che i due si contraddicessero.
        """
        if self.hass is not None:
            self.async_write_ha_state()


class IrrigazioneZoneEntity(IrrigazioneEntity):
    """Entità legata a una zona, che può sparire se la zona viene eliminata."""

    def __init__(self, entry_id: str, store: IrrigazioneStore, zone_id: str) -> None:
        super().__init__(entry_id, store)
        self._zone_id = zone_id

    @property
    def zone(self) -> dict[str, Any] | None:
        return self._store.zones.get(self._zone_id)

    @property
    def available(self) -> bool:
        return self.zone is not None

    @property
    def device_info(self) -> DeviceInfo | None:
        zone = self.zone
        return zone_device_info(self._entry_id, zone) if zone else None
