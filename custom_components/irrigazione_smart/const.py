"""Costanti di irrigazione_smart."""

from __future__ import annotations

from typing import Final

from homeassistant.const import Platform

DOMAIN: Final = "irrigazione_smart"

# Chiavi di configurazione
CONF_ELEVATION: Final = "elevation"
CONF_WEATHER_ENTITY: Final = "weather_entity"
CONF_TEMPERATURE_ENTITY: Final = "temperature_entity"
CONF_HUMIDITY_ENTITY: Final = "humidity_entity"
CONF_WIND_ENTITY: Final = "wind_entity"
CONF_RAIN_ENTITY: Final = "rain_entity"
CONF_IRRADIANCE_ENTITY: Final = "irradiance_entity"

# Storage
STORAGE_KEY: Final = f"{DOMAIN}.zones"
STORAGE_VERSION: Final = 1
STORAGE_SAVE_DELAY: Final = 10  # secondi di debounce: protegge la SD del Pi

# Cadenza di campionamento del meteo. Serve ad accumulare gli estremi della
# giornata, non a reagire in tempo reale: 10 minuti bastano e non pesano.
UPDATE_INTERVAL_MIN: Final = 10

PLATFORMS: Final[list[Platform]] = [Platform.SWITCH, Platform.SENSOR]

# Segnali interni: le zone si creano a runtime, quindi le entità vanno
# aggiunte e rimosse a caldo senza riavviare Home Assistant.
SIGNAL_ZONES_CHANGED: Final = f"{DOMAIN}_zones_changed"
SIGNAL_STATE_CHANGED: Final = f"{DOMAIN}_state_changed"

# Secondi di attesa per la conferma di apertura della valvola. Non si
# assume mai che una linea stia irrigando solo perché è stato dato il
# comando: senza conferma la linea viene saltata.
VALVE_CONFIRM_TIMEOUT: Final = 30

# Eventi sul bus di Home Assistant, richiamabili anche da fuori
# dall'integration (automazioni, script, altre integrazioni).
EVENT_STARTED: Final = f"{DOMAIN}_started"
EVENT_FINISHED: Final = f"{DOMAIN}_finished"
EVENT_ZONE_STARTED: Final = f"{DOMAIN}_zone_started"
EVENT_ZONE_FINISHED: Final = f"{DOMAIN}_zone_finished"

# Servizi
SERVICE_RUN_ZONE: Final = "irriga_linea"
SERVICE_RUN_ALL: Final = "avvia_sequenza"
SERVICE_STOP: Final = "ferma"
