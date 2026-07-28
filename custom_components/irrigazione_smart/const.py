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

# Prato e aiuole hanno irrigatori diversi — statici e turbine contro ala
# gocciolante — e quindi portate, durate e abitudini diverse. Vanno tenuti
# separati in pagina e devono poter partire l'uno senza l'altro.
ZONE_CATEGORIES: Final[dict[str, str]] = {
    "prato_microterme": "prato",
    "prato_macroterme": "prato",
    "aiuola_arbusti": "aiuole",
    "aiuola_fiorita": "aiuole",
    "orto": "orto",
}
CATEGORY_ORDER: Final[list[str]] = ["prato", "aiuole", "orto", "altro"]
CATEGORY_LABELS: Final[dict[str, str]] = {
    "prato": "Prato",
    "aiuole": "Aiuole",
    "orto": "Orto",
    "altro": "Altro",
}
CATEGORY_ICONS: Final[dict[str, str]] = {
    "prato": "mdi:grass",
    "aiuole": "mdi:flower",
    "orto": "mdi:carrot",
    "altro": "mdi:sprinkler-variant",
}


def zone_category(zone_type: str | None) -> str:
    """Categoria di una zona; `altro` per i tipi non riconosciuti."""
    return ZONE_CATEGORIES.get(zone_type or "", "altro")

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
# Emesso quando una linea non parte: valvola che non conferma, valvola non
# configurata, o linea saltata. È l'evento su cui agganciare gli allarmi.
EVENT_ZONE_FAILED: Final = f"{DOMAIN}_zone_failed"

# Registro attività: file separato da quello delle zone, così scriverlo
# spesso non riscrive lo stato prezioso del bilancio idrico.
STORAGE_KEY_LOG: Final = f"{DOMAIN}.log"
LOG_MAX_ENTRIES: Final = 300

# Servizi
SERVICE_RUN_ZONE: Final = "irriga_linea"
SERVICE_RUN_ALL: Final = "avvia_sequenza"
SERVICE_STOP: Final = "ferma"
