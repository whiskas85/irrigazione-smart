"""Irrigazione Smart — irrigazione a bilancio idrico con zone dinamiche."""

from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN, PLATFORMS
from .panel import async_remove_panel, async_setup_panel

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Inizializza l'integration da una config entry."""
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = {"config": dict(entry.data)}

    if PLATFORMS:
        await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    await async_setup_panel(hass)

    entry.async_on_unload(entry.add_update_listener(async_reload_entry))
    _LOGGER.debug("Irrigazione Smart avviata (entry %s)", entry.entry_id)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Scarica la config entry."""
    unloaded = True
    if PLATFORMS:
        unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)

    if unloaded:
        await async_remove_panel(hass)
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return unloaded


async def async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Ricarica dopo una modifica alle opzioni."""
    await hass.config_entries.async_reload(entry.entry_id)
