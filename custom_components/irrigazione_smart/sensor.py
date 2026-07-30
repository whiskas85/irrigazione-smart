"""Sensori esposti da Irrigazione Smart.

Rendono disponibili a dashboard, grafici e automazioni i numeri che
altrimenti vivrebbero solo dentro il pannello: l'ET0 del giorno e, per
ogni linea, il deficit accumulato e la durata calcolata.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Final

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
from homeassistant.util import dt as dt_util

from .const import CATEGORY_LABELS, CATEGORY_ORDER, DOMAIN, SIGNAL_ZONES_CHANGED
from .entity import IrrigazioneEntity, IrrigazioneZoneEntity, system_device_info
from .executor import get_executor
from .hydro import evaluate_zone, resolve_zone_params
from .scheduler import get_scheduler
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
            new.append(ZoneStateSensor(entry.entry_id, store, zone_id))
            new.append(ZoneLastRunSensor(entry.entry_id, store, zone_id))
        known.update(store.zones)
        if new:
            async_add_entities(new)

    async_add_entities(
        [Et0Sensor(entry.entry_id, store), NextRunSensor(entry.entry_id, store)]
    )
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
            # quota di oggi già scaricata sul bilancio: sale ora per ora,
            # ed è quella che spiega un deficit che cresce a metà pomeriggio
            "et0_maturata_oggi_mm": round(
                float(daily.get("et0_charged_mm") or 0.0), 2
            ),
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


class ZoneStateSensor(IrrigazioneZoneEntity, SensorEntity):
    """Stato della linea a colpo d'occhio, per automazioni e dashboard.

    È lo stesso semaforo della pagina, esposto come entità: chi scrive
    un'automazione non deve rifarsi il conto fra deficit, soglia e TAW —
    e soprattutto non deve rifarlo in un template che poi resta indietro
    quando il modello cambia.
    """

    _attr_name = "Stato"
    _attr_icon = "mdi:water-alert-outline"
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options: Final[list[str]] = [
        "in_irrigazione",
        "carenza_forte",
        "chiede_acqua",
        "ok",
        "disattivata",
    ]

    def __init__(self, entry_id: str, store: IrrigazioneStore, zone_id: str) -> None:
        super().__init__(entry_id, store, zone_id)
        self._attr_unique_id = f"{entry_id}_{zone_id}_stato"

    @property
    def native_value(self) -> str | None:
        zone = self.zone
        if zone is None:
            return None

        executor = get_executor(self.hass)
        stato = executor.status() if executor else {}
        if stato.get("active") and stato.get("zone_id") == self._zone_id:
            return "in_irrigazione"
        if not zone.get("enabled", True):
            return "disattivata"

        params = resolve_zone_params(zone, self._store.system)
        deficit = float(zone.get("deficit_mm") or 0.0)
        soglia = params.trigger_threshold_mm
        taw = params.taw_mm
        if soglia > 0 and deficit >= soglia:
            grave = taw > soglia and deficit >= soglia + (taw - soglia) / 2
            return "carenza_forte" if grave else "chiede_acqua"
        return "ok"


class ZoneLastRunSensor(IrrigazioneZoneEntity, SensorEntity):
    """Quando la linea ha ricevuto acqua l'ultima volta."""

    _attr_name = "Ultima irrigazione"
    _attr_icon = "mdi:water-check-outline"
    _attr_device_class = SensorDeviceClass.TIMESTAMP

    def __init__(self, entry_id: str, store: IrrigazioneStore, zone_id: str) -> None:
        super().__init__(entry_id, store, zone_id)
        self._attr_unique_id = f"{entry_id}_{zone_id}_ultima"

    @property
    def native_value(self) -> datetime | None:
        zone = self.zone
        quando = (zone or {}).get("last_irrigation")
        return dt_util.parse_datetime(quando) if quando else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        zone = self.zone or {}
        return {
            "durata_min": zone.get("last_duration_min"),
            # "automatica", "forzata" o "interrotta"
            "tipo": zone.get("last_trigger"),
        }


class NextRunSensor(IrrigazioneEntity, SensorEntity):
    """La prima partenza automatica in programma, fra tutti i gruppi."""

    _attr_name = "Prossima irrigazione"
    _attr_icon = "mdi:calendar-clock"
    _attr_device_class = SensorDeviceClass.TIMESTAMP

    def __init__(self, entry_id: str, store: IrrigazioneStore) -> None:
        super().__init__(entry_id, store)
        self._attr_unique_id = f"{entry_id}_prossima"

    @property
    def device_info(self) -> DeviceInfo:
        return system_device_info(self._entry_id)

    def _runs(self) -> dict[str, dict[str, Any]]:
        scheduler = get_scheduler(self.hass)
        if scheduler is None:
            return {}
        return {cat: scheduler.next_run(cat) for cat in CATEGORY_ORDER}

    @property
    def native_value(self) -> datetime | None:
        istanti = [
            dt_util.parse_datetime(run.get("when") or "")
            for run in self._runs().values()
            if run.get("scheduled")
        ]
        validi = [i for i in istanti if i is not None]
        return min(validi) if validi else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        # il dettaglio per gruppo: quale parte quando, e chi non parte
        return {
            f"{CATEGORY_LABELS.get(cat, cat).lower()}": (
                run.get("when") if run.get("scheduled") else run.get("reason")
            )
            for cat, run in self._runs().items()
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
