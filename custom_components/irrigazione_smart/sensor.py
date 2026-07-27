"""Sensori esposti da Irrigazione Smart.

Rendono disponibili a dashboard, grafici e automazioni i numeri che
altrimenti vivrebbero solo dentro il pannello: l'ET0 del giorno e, per
ogni linea, il deficit accumulato e la durata calcolata.
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, SIGNAL_ZONES_CHANGED
from .entity import IrrigazioneEntity, IrrigazioneZoneEntity, system_device_info
from .hydro import evaluate_zone, resolve_zone_params
from .store import IrrigazioneStore


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Crea i sensori di sistema e quelli di ogni linea."""
    store: IrrigazioneStore = hass.data[DOMAIN]["store"]
    known: set[str] = set()

    @callback
    def _add_new_zones() -> None:
        new: list[SensorEntity] = []
        for zone_id in store.zones:
            if zone_id in known:
                continue
            new.append(ZoneDeficitSensor(entry.entry_id, store, zone_id))
            new.append(ZoneRuntimeSensor(entry.entry_id, store, zone_id))
        known.update(store.zones)
        if new:
            async_add_entities(new)

    async_add_entities([Et0Sensor(entry.entry_id, store)])
    _add_new_zones()

    entry.async_on_unload(
        async_dispatcher_connect(hass, SIGNAL_ZONES_CHANGED, _add_new_zones)
    )


class Et0Sensor(IrrigazioneEntity, SensorEntity):
    """Evapotraspirazione di riferimento dell'ultimo giorno chiuso."""

    _attr_name = "ET0 giornaliera"
    _attr_icon = "mdi:weather-sunny"
    _attr_native_unit_of_measurement = "mm"
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_suggested_display_precision = 2

    def __init__(self, entry_id: str, store: IrrigazioneStore) -> None:
        super().__init__(entry_id, store)
        self._attr_unique_id = f"{entry_id}_et0"

    @property
    def device_info(self) -> DeviceInfo:
        return system_device_info(self._entry_id)

    @property
    def native_value(self) -> float | None:
        return self._store.daily.get("last_et0_mm")

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        daily = self._store.daily
        return {
            # il metodo va esposto: l'utente deve sapere su quale modello
            # sta girando il suo impianto
            "metodo": daily.get("last_et0_method"),
            "giorno": daily.get("last_closed_date"),
            "t_min_oggi": daily.get("t_min"),
            "t_max_oggi": daily.get("t_max"),
            "pioggia_oggi_mm": daily.get("rain_mm"),
        }


class ZoneDeficitSensor(IrrigazioneZoneEntity, SensorEntity):
    """Deficit idrico accumulato dalla linea."""

    _attr_name = "Deficit idrico"
    _attr_icon = "mdi:water-minus"
    _attr_native_unit_of_measurement = "mm"
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_suggested_display_precision = 1

    def __init__(self, entry_id: str, store: IrrigazioneStore, zone_id: str) -> None:
        super().__init__(entry_id, store, zone_id)
        self._attr_unique_id = f"{entry_id}_{zone_id}_deficit"

    @property
    def native_value(self) -> float | None:
        zone = self.zone
        return round(float(zone.get("deficit_mm") or 0.0), 2) if zone else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        zone = self.zone
        if zone is None:
            return {}
        params = resolve_zone_params(zone, self._store.system)
        return {
            "soglia_mm": round(params.trigger_threshold_mm, 1),
            "taw_mm": round(params.taw_mm, 1),
            "terreno": params.soil,
            "kc": params.kc,
        }


class ZoneRuntimeSensor(IrrigazioneZoneEntity, SensorEntity):
    """Minuti di irrigazione che la linea richiede adesso."""

    _attr_name = "Durata prevista"
    _attr_icon = "mdi:timer-outline"
    _attr_native_unit_of_measurement = "min"
    _attr_device_class = SensorDeviceClass.DURATION
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_suggested_display_precision = 0

    def __init__(self, entry_id: str, store: IrrigazioneStore, zone_id: str) -> None:
        super().__init__(entry_id, store, zone_id)
        self._attr_unique_id = f"{entry_id}_{zone_id}_runtime"

    def _plan(self):
        zone = self.zone
        if zone is None:
            return None
        return evaluate_zone(
            zone, self._store.system, float(zone.get("deficit_mm") or 0.0)
        )

    @property
    def native_value(self) -> float | None:
        plan = self._plan()
        if plan is None:
            return None
        return plan.total_minutes if plan.should_run else 0.0

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        plan = self._plan()
        if plan is None:
            return {}
        return {
            "irriga": plan.should_run,
            "motivo": plan.reason,
            "cicli": plan.cycles,
            "minuti_per_ciclo": plan.minutes_per_cycle,
            "pausa_min": plan.soak_minutes,
            "troncato": plan.capped,
        }
