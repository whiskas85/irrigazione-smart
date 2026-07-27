"""Config flow per Irrigazione Smart."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.const import CONF_LATITUDE, CONF_LONGITUDE
from homeassistant.helpers import selector

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


def _sensor_selector(device_class: str) -> selector.EntitySelector:
    """Selettore filtrato per device_class.

    Impedisce di collegare un sensore sbagliato: se l'entità non espone
    la device_class corretta, non compare nemmeno nell'elenco.
    """
    return selector.EntitySelector(
        selector.EntitySelectorConfig(
            domain="sensor",
            device_class=device_class,
            multiple=False,
        )
    )


class IrrigazioneSmartConfigFlow(ConfigFlow, domain=DOMAIN):
    """Setup iniziale: posizione e fonti dei dati."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Passo unico di configurazione."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        if user_input is not None:
            return self.async_create_entry(
                title="Irrigazione Smart",
                data=user_input,
            )

        schema = vol.Schema(
            {
                vol.Required(
                    CONF_LATITUDE, default=self.hass.config.latitude
                ): selector.NumberSelector(
                    selector.NumberSelectorConfig(
                        min=-90, max=90, step=0.0001, mode="box"
                    )
                ),
                vol.Required(
                    CONF_LONGITUDE, default=self.hass.config.longitude
                ): selector.NumberSelector(
                    selector.NumberSelectorConfig(
                        min=-180, max=180, step=0.0001, mode="box"
                    )
                ),
                vol.Required(
                    CONF_ELEVATION, default=int(self.hass.config.elevation or 0)
                ): selector.NumberSelector(
                    selector.NumberSelectorConfig(
                        min=-100, max=5000, step=1, mode="box",
                        unit_of_measurement="m",
                    )
                ),
                # Fonte di fallback: usata quando manca il sensore locale
                vol.Optional(CONF_WEATHER_ENTITY): selector.EntitySelector(
                    selector.EntitySelectorConfig(domain="weather")
                ),
                # Sensori locali, tutti opzionali
                vol.Optional(CONF_TEMPERATURE_ENTITY): _sensor_selector("temperature"),
                vol.Optional(CONF_HUMIDITY_ENTITY): _sensor_selector("humidity"),
                vol.Optional(CONF_WIND_ENTITY): _sensor_selector("wind_speed"),
                vol.Optional(CONF_RAIN_ENTITY): _sensor_selector("precipitation"),
                vol.Optional(CONF_IRRADIANCE_ENTITY): _sensor_selector("irradiance"),
            }
        )

        return self.async_show_form(step_id="user", data_schema=schema)
