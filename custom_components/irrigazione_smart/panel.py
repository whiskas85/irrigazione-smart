"""Pannello laterale e API di supporto per Irrigazione Smart.

Registra una voce nella barra laterale con una pagina propria (un web
component servito da `www/`) e una piccola API interna che espone la
configurazione corrente al frontend.
"""

from __future__ import annotations

from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import HomeAssistantView, StaticPathConfig
from homeassistant.const import CONF_LATITUDE, CONF_LONGITUDE
from homeassistant.core import HomeAssistant
from homeassistant.loader import async_get_integration

from .const import (
    CONF_ELEVATION,
    CONF_HUMIDITY_ENTITY,
    CONF_IRRADIANCE_ENTITY,
    CONF_RAIN_ENTITY,
    CONF_TEMPERATURE_ENTITY,
    CONF_WEATHER_ENTITY,
    CONF_WIND_ENTITY,
    DOMAIN,
)

PANEL_URL_PATH = "irrigazione-smart"
PANEL_TITLE = "Irrigazione"
PANEL_ICON = "mdi:sprinkler-variant"
COMPONENT_NAME = "irrigazione-smart-panel"
STATIC_URL = "/irrigazione_smart_frontend"

_HTTP_FLAG = "_http_registered"
_PANEL_FLAG = "_panel_registered"


class IrrigazioneSmartOverviewView(HomeAssistantView):
    """Espone la configurazione corrente al pannello frontend."""

    url = "/api/irrigazione_smart/overview"
    name = "api:irrigazione_smart:overview"
    requires_auth = True

    async def get(self, request):
        """Restituisce posizione, sensori e zone in formato JSON."""
        hass: HomeAssistant = request.app["hass"]
        entries = hass.config_entries.async_entries(DOMAIN)
        if not entries:
            return self.json({"configured": False, "system": None, "zones": []})

        data = entries[0].data
        return self.json(
            {
                "configured": True,
                "system": {
                    "latitude": data.get(CONF_LATITUDE),
                    "longitude": data.get(CONF_LONGITUDE),
                    "elevation": data.get(CONF_ELEVATION),
                    "weather_entity": data.get(CONF_WEATHER_ENTITY),
                    "sensors": {
                        "temperature": data.get(CONF_TEMPERATURE_ENTITY),
                        "humidity": data.get(CONF_HUMIDITY_ENTITY),
                        "wind_speed": data.get(CONF_WIND_ENTITY),
                        "precipitation": data.get(CONF_RAIN_ENTITY),
                        "irradiance": data.get(CONF_IRRADIANCE_ENTITY),
                    },
                },
                "zones": [],
            }
        )


async def async_setup_panel(hass: HomeAssistant) -> None:
    """Registra la risorsa statica, l'API e la voce in sidebar (una volta)."""
    domain_data = hass.data.setdefault(DOMAIN, {})

    if not domain_data.get(_HTTP_FLAG):
        www_dir = Path(__file__).parent / "www"
        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL, str(www_dir), False)]
        )
        hass.http.register_view(IrrigazioneSmartOverviewView())
        domain_data[_HTTP_FLAG] = True

    if not domain_data.get(_PANEL_FLAG):
        integration = await async_get_integration(hass, DOMAIN)
        await panel_custom.async_register_panel(
            hass,
            webcomponent_name=COMPONENT_NAME,
            frontend_url_path=PANEL_URL_PATH,
            module_url=f"{STATIC_URL}/{COMPONENT_NAME}.js?v={integration.version}",
            sidebar_title=PANEL_TITLE,
            sidebar_icon=PANEL_ICON,
            require_admin=False,
        )
        domain_data[_PANEL_FLAG] = True


async def async_remove_panel(hass: HomeAssistant) -> None:
    """Rimuove la voce dalla sidebar quando la config entry viene scaricata."""
    domain_data = hass.data.get(DOMAIN, {})
    if domain_data.get(_PANEL_FLAG):
        frontend.async_remove_panel(hass, PANEL_URL_PATH)
        domain_data[_PANEL_FLAG] = False
