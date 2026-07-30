"""Sensori binari: sta uscendo acqua, e da dove.

Esistono perché un'automazione o una dashboard esterna non devono
interpretare una stringa di stato per sapere se l'impianto è in funzione:
`binary_sensor.<linea>_in_irrigazione` è on mentre la valvola di quella
linea è aperta, e basta.
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
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
    """Crea il sensore d'impianto e quello di ogni linea."""
    store: IrrigazioneStore = hass.data[DOMAIN]["store"]
    known: set[str] = set()

    @callback
    def _add_new_zones() -> None:
        new = [
            ZoneWateringSensor(entry.entry_id, store, zone_id)
            for zone_id in store.zones
            if zone_id not in known
        ]
        known.update(store.zones)
        if new:
            async_add_entities(new)

    async_add_entities([SystemRunningSensor(entry.entry_id, store)])
    _add_new_zones()

    entry.async_on_unload(
        async_dispatcher_connect(hass, SIGNAL_ZONES_CHANGED, _add_new_zones)
    )


class SystemRunningSensor(IrrigazioneEntity, BinarySensorEntity):
    """On mentre una qualsiasi linea sta ricevendo acqua."""

    _attr_name = "Irrigazione in corso"
    _attr_device_class = BinarySensorDeviceClass.RUNNING

    def __init__(self, entry_id: str, store: IrrigazioneStore) -> None:
        super().__init__(entry_id, store)
        self._attr_unique_id = f"{entry_id}_in_corso"

    @property
    def device_info(self) -> DeviceInfo:
        return system_device_info(self._entry_id)

    def _status(self) -> dict[str, Any]:
        executor = get_executor(self.hass)
        return (executor.status() if executor else {}) or {}

    @property
    def is_on(self) -> bool:
        return bool(self._status().get("active"))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        stato = self._status()
        if not stato.get("active"):
            return {}
        return {
            "linea": stato.get("zone_name"),
            # "irrigazione", "assorbimento" o "pausa_tra_linee": durante le
            # due attese l'impianto è in funzione ma l'acqua non esce
            "fase": stato.get("phase"),
            "passata": stato.get("cycle"),
            "passate": stato.get("cycles"),
            "avanzamento_pct": stato.get("progress_overall"),
            "minuti_erogati": stato.get("progress_done_min"),
            "minuti_totali": stato.get("progress_total_min"),
        }


class ZoneWateringSensor(IrrigazioneZoneEntity, BinarySensorEntity):
    """On mentre la valvola di questa linea è aperta.

    Non basta guardare l'interruttore della valvola: quello dice che il
    comando è partito, non che l'irrigazione di *questa* sequenza è in
    corso — e durante le pause di assorbimento la valvola è chiusa mentre
    la linea è ancora in mezzo al suo programma.
    """

    _attr_name = "In irrigazione"
    _attr_device_class = BinarySensorDeviceClass.RUNNING

    def __init__(self, entry_id: str, store: IrrigazioneStore, zone_id: str) -> None:
        super().__init__(entry_id, store, zone_id)
        self._attr_unique_id = f"{entry_id}_{zone_id}_in_irrigazione"

    def _status(self) -> dict[str, Any]:
        executor = get_executor(self.hass)
        return (executor.status() if executor else {}) or {}

    @property
    def is_on(self) -> bool:
        stato = self._status()
        return bool(
            stato.get("active")
            and stato.get("zone_id") == self._zone_id
            and stato.get("phase") == "irrigazione"
        )

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        stato = self._status()
        mie = (stato.get("progress_zones") or {}).get(self._zone_id)
        if not mie:
            return {}
        return {
            "minuti_erogati": mie.get("fatti_min"),
            "minuti_previsti": mie.get("totale_min"),
            "passate_fatte": mie.get("passate_fatte"),
            "passate": mie.get("passate"),
            "esito": mie.get("stato"),
        }
