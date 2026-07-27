"""Interruttori esposti da Irrigazione Smart.

Due livelli, come l'impianto reale:
  - un master generale che ferma tutto
  - un master per ogni linea, che la esclude senza toccare le altre

Sono entità vere: si usano in automazioni, scene, comandi vocali e
dashboard, non solo dal pannello.
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import (
    async_dispatcher_connect,
    async_dispatcher_send,
)
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, SIGNAL_STATE_CHANGED, SIGNAL_ZONES_CHANGED
from .entity import IrrigazioneEntity, IrrigazioneZoneEntity, system_device_info
from .store import IrrigazioneStore


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Crea il master generale e un master per ogni linea esistente."""
    store: IrrigazioneStore = hass.data[DOMAIN]["store"]
    known: set[str] = set()

    @callback
    def _add_new_zones() -> None:
        """Aggiunge le entità delle zone create dopo l'avvio."""
        new = [
            ZoneEnabledSwitch(entry.entry_id, store, zone_id)
            for zone_id in store.zones
            if zone_id not in known
        ]
        known.update(store.zones)
        if new:
            async_add_entities(new)

    async_add_entities([MasterSwitch(entry.entry_id, store)])
    _add_new_zones()

    entry.async_on_unload(
        async_dispatcher_connect(hass, SIGNAL_ZONES_CHANGED, _add_new_zones)
    )


class MasterSwitch(IrrigazioneEntity, SwitchEntity):
    """Master generale: spento, nessuna linea viene irrigata."""

    _attr_name = "Master irrigazione"
    _attr_icon = "mdi:water"

    def __init__(self, entry_id: str, store: IrrigazioneStore) -> None:
        super().__init__(entry_id, store)
        self._attr_unique_id = f"{entry_id}_master"

    @property
    def device_info(self) -> DeviceInfo:
        return system_device_info(self._entry_id)

    @property
    def is_on(self) -> bool:
        return bool(self._store.system.get("master_enabled", True))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        zones = self._store.zones.values()
        return {
            "linee_totali": len(self._store.zones),
            "linee_attive": sum(1 for z in zones if z.get("enabled")),
            "finestra": f"{self._store.system.get('window_start')}–"
            f"{self._store.system.get('window_end')}",
        }

    async def async_turn_on(self, **kwargs: Any) -> None:
        self._set(True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        self._set(False)

    def _set(self, value: bool) -> None:
        self._store.async_update_system({"master_enabled": value})
        self.async_write_ha_state()
        # avvisa il resto: il pannello e le altre entità leggono lo stesso store
        async_dispatcher_send(self.hass, SIGNAL_STATE_CHANGED)


class ZoneEnabledSwitch(IrrigazioneZoneEntity, SwitchEntity):
    """Master di linea: esclude la singola zona lasciando le altre attive."""

    _attr_name = "Abilitata"
    _attr_icon = "mdi:pipe-valve"

    def __init__(self, entry_id: str, store: IrrigazioneStore, zone_id: str) -> None:
        super().__init__(entry_id, store, zone_id)
        self._attr_unique_id = f"{entry_id}_{zone_id}_enabled"

    @property
    def is_on(self) -> bool:
        zone = self.zone
        return bool(zone.get("enabled")) if zone else False

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        zone = self.zone or {}
        return {
            "deficit_mm": zone.get("deficit_mm"),
            "valvola": zone.get("valve_entity"),
            "tipo_zona": zone.get("zone_type"),
            "portata_mm_h": zone.get("rate_mm_h"),
        }

    async def async_turn_on(self, **kwargs: Any) -> None:
        self._set(True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        self._set(False)

    def _set(self, value: bool) -> None:
        if self.zone is None:
            return
        self._store.async_update_zone(self._zone_id, {"enabled": value})
        self.async_write_ha_state()
        async_dispatcher_send(self.hass, SIGNAL_STATE_CHANGED)
