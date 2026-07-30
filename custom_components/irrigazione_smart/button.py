"""Pulsanti: avviare l'irrigazione da fuori dal pannello.

Un interruttore sarebbe sbagliato: irrigare non è uno stato che si tiene
acceso, è un comando che parte e finisce da solo. Con i pulsanti la
stessa cosa si fa da una dashboard, da un'automazione o da un assistente
vocale, senza chiamare l'API del pannello.
"""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, SIGNAL_ZONES_CHANGED
from .entity import IrrigazioneEntity, IrrigazioneZoneEntity, system_device_info
from .executor import get_executor
from .store import IrrigazioneStore


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Crea i pulsanti d'impianto e quelli di ogni linea."""
    store: IrrigazioneStore = hass.data[DOMAIN]["store"]
    known: set[str] = set()

    @callback
    def _add_new_zones() -> None:
        new = [
            ZoneRunButton(entry.entry_id, store, zone_id)
            for zone_id in store.zones
            if zone_id not in known
        ]
        known.update(store.zones)
        if new:
            async_add_entities(new)

    async_add_entities(
        [
            SequenceRunButton(entry.entry_id, store),
            StopButton(entry.entry_id, store),
        ]
    )
    _add_new_zones()

    entry.async_on_unload(
        async_dispatcher_connect(hass, SIGNAL_ZONES_CHANGED, _add_new_zones)
    )


class SequenceRunButton(IrrigazioneEntity, ButtonEntity):
    """Avvia la sequenza: irriga le linee sotto soglia, nell'ordine."""

    _attr_name = "Avvia irrigazione"
    _attr_icon = "mdi:play-circle-outline"

    def __init__(self, entry_id: str, store: IrrigazioneStore) -> None:
        super().__init__(entry_id, store)
        self._attr_unique_id = f"{entry_id}_avvia"

    @property
    def device_info(self) -> DeviceInfo:
        return system_device_info(self._entry_id)

    async def async_press(self) -> None:
        executor = get_executor(self.hass)
        if executor is not None:
            await executor.async_start_sequence()


class StopButton(IrrigazioneEntity, ButtonEntity):
    """Ferma tutto e chiude la valvola aperta."""

    _attr_name = "Ferma irrigazione"
    _attr_icon = "mdi:stop-circle-outline"

    def __init__(self, entry_id: str, store: IrrigazioneStore) -> None:
        super().__init__(entry_id, store)
        self._attr_unique_id = f"{entry_id}_ferma"

    @property
    def device_info(self) -> DeviceInfo:
        return system_device_info(self._entry_id)

    async def async_press(self) -> None:
        executor = get_executor(self.hass)
        if executor is not None:
            await executor.async_stop()


class ZoneRunButton(IrrigazioneZoneEntity, ButtonEntity):
    """Irriga questa linea adesso, per la durata che il motore calcola.

    È una forzatura: non guarda la soglia — chi preme sa perché lo sta
    facendo — ma rispetta l'interruttore della linea, perché una linea
    spenta di solito lo è per un guasto.
    """

    _attr_name = "Irriga ora"
    _attr_icon = "mdi:water"

    def __init__(self, entry_id: str, store: IrrigazioneStore, zone_id: str) -> None:
        super().__init__(entry_id, store, zone_id)
        self._attr_unique_id = f"{entry_id}_{zone_id}_irriga"

    @property
    def available(self) -> bool:
        zone = self.zone
        return zone is not None and bool(zone.get("enabled", True))

    async def async_press(self) -> None:
        executor = get_executor(self.hass)
        if executor is not None:
            await executor.async_run_zone(self._zone_id)
