"""Irrigazione Smart — irrigazione a bilancio idrico con zone dinamiche."""

from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.start import async_at_started

from .activity_log import IrrigazioneLog, async_subscribe_events
from .const import DOMAIN, PLATFORMS
from .coordinator import IrrigazioneCoordinator
from .executor import IrrigationExecutor
from .notifier import Notifier
from .panel import async_remove_panel, async_setup_panel, async_setup_store
from .recovery import async_recover_interrupted_run
from .scheduler import IrrigationScheduler
from .services import async_setup_services
from .valves import ValveWatcher

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Inizializza l'integration da una config entry."""
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = {"config": dict(entry.data)}

    store = await async_setup_store(hass)

    coordinator = IrrigazioneCoordinator(hass, entry, store)
    await coordinator.async_config_entry_first_refresh()
    hass.data[DOMAIN]["coordinator"] = coordinator
    # Il ciclo va acceso a mano: senza, il primo aggiornamento qui sopra
    # resterebbe l'unico di tutta la giornata (vedi `async_start`).
    entry.async_on_unload(coordinator.async_start())
    hass.data[DOMAIN]["executor"] = IrrigationExecutor(hass, store)

    activity_log = IrrigazioneLog(hass)
    await activity_log.async_load()
    hass.data[DOMAIN]["log"] = activity_log
    for unsub in async_subscribe_events(hass, activity_log):
        entry.async_on_unload(unsub)

    notifier = Notifier(hass, store)
    hass.data[DOMAIN]["notifier"] = notifier
    for unsub in notifier.async_subscribe():
        entry.async_on_unload(unsub)

    scheduler = IrrigationScheduler(hass, store)
    hass.data[DOMAIN]["scheduler"] = scheduler
    entry.async_on_unload(scheduler.async_start())

    # Le valvole si ascoltano sempre, non solo quando siamo noi ad
    # aprirle: se una linea si accende da fuori, entità e pagina devono
    # dirlo nell'istante in cui succede.
    watcher = ValveWatcher(hass, store)
    hass.data[DOMAIN]["valves"] = watcher
    entry.async_on_unload(watcher.async_start())

    # Un'irrigazione interrotta da un riavvio va ritrovata e messa in
    # sicurezza. Si aspetta che Home Assistant sia avviato del tutto:
    # adesso le entità delle valvole potrebbero non esistere ancora, e
    # chiederne lo stato risponderebbe "sconosciuta" su tutte.
    async def _recover(_event=None) -> None:
        await async_recover_interrupted_run(hass, store)

    entry.async_on_unload(async_at_started(hass, _recover))

    await async_setup_services(hass)

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
        executor = hass.data[DOMAIN].pop("executor", None)
        if executor is not None:
            await executor.async_stop()
        hass.data[DOMAIN].pop("coordinator", None)
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return unloaded


async def async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Ricarica dopo una modifica alle opzioni."""
    await hass.config_entries.async_reload(entry.entry_id)
