"""Servizi di Irrigazione Smart.

Rendono l'irrigazione comandabile da automazioni, script e dal pannello:
forzare una singola linea, avviare la sequenza completa, fermare tutto.
"""

from __future__ import annotations

import voluptuous as vol
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv

from .const import (
    CATEGORY_ORDER,
    DOMAIN,
    SERVICE_RUN_ALL,
    SERVICE_RUN_ZONE,
    SERVICE_STOP,
)
from .executor import get_executor

RUN_ZONE_SCHEMA = vol.Schema(
    {
        vol.Required("zone_id"): cv.string,
        # durata fissa opzionale: se assente si usa quella calcolata
        vol.Optional("minuti"): vol.All(vol.Coerce(float), vol.Range(min=1, max=600)),
    }
)

RUN_ALL_SCHEMA = vol.Schema(
    {
        # senza categoria si irriga tutto
        vol.Optional("categoria"): vol.In(CATEGORY_ORDER),
    }
)


async def async_setup_services(hass: HomeAssistant) -> None:
    """Registra i servizi una volta sola."""
    if hass.services.has_service(DOMAIN, SERVICE_RUN_ZONE):
        return

    async def _run_zone(call: ServiceCall) -> None:
        executor = get_executor(hass)
        if executor is None:
            return
        store = hass.data[DOMAIN]["store"]
        zone_id = call.data["zone_id"]
        zone = store.zones.get(zone_id)

        # La forzatura vale solo se la linea è abilitata: il master di
        # linea deve restare l'ultima parola.
        if zone is None or not zone.get("enabled"):
            return
        await executor.async_run_zone(zone_id, call.data.get("minuti"))

    async def _run_all(call: ServiceCall) -> None:
        executor = get_executor(hass)
        if executor is not None:
            await executor.async_start_sequence(
                category=call.data.get("categoria")
            )

    async def _stop(_call: ServiceCall) -> None:
        executor = get_executor(hass)
        if executor is not None:
            await executor.async_stop()

    hass.services.async_register(DOMAIN, SERVICE_RUN_ZONE, _run_zone, RUN_ZONE_SCHEMA)
    hass.services.async_register(DOMAIN, SERVICE_RUN_ALL, _run_all, RUN_ALL_SCHEMA)
    hass.services.async_register(DOMAIN, SERVICE_STOP, _stop)
