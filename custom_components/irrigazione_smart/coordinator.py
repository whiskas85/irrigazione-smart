"""Coordinator: meteo → ET0 → bilancio idrico.

Accumula i dati meteo durante la giornata e, allo scoccare della mezzanotte
locale, chiude il giorno: calcola ET0 con il metodo migliore consentito dai
dati raccolti e aggiorna il deficit di ogni zona.

Perché accumulare invece di leggere un valore istantaneo: FAO-56 lavora su
grandezze giornaliere (Tmin, Tmax, medie di umidità e vento). Leggere la
temperatura alle 03:00 e chiamarla "massima del giorno" darebbe un ET0
sistematicamente sbagliato.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_LATITUDE
from homeassistant.core import HomeAssistant
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator
from homeassistant.util import dt as dt_util

from .const import (
    CONF_ELEVATION,
    CONF_HUMIDITY_ENTITY,
    CONF_IRRADIANCE_ENTITY,
    CONF_RAIN_ENTITY,
    CONF_TEMPERATURE_ENTITY,
    CONF_WEATHER_ENTITY,
    CONF_WIND_ENTITY,
    SIGNAL_STATE_CHANGED,
    UPDATE_INTERVAL_MIN,
)
from .hydro import compute_et0, resolve_zone_params, update_deficit
from .store import DEFAULT_DAILY, IrrigazioneStore

_LOGGER = logging.getLogger(__name__)

UNAVAILABLE = ("unknown", "unavailable", "none", "")


def _as_float(value: Any) -> float | None:
    """Converte in float, tollerando stati non numerici."""
    if value is None:
        return None
    if isinstance(value, str) and value.strip().lower() in UNAVAILABLE:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _to_celsius(value: float, unit: str | None) -> float:
    return (value - 32.0) * 5.0 / 9.0 if unit == "°F" else value


def _to_ms(value: float, unit: str | None) -> float:
    """Normalizza la velocità del vento in m/s (Penman-Monteith la vuole così)."""
    factors = {
        "km/h": 1 / 3.6,
        "kph": 1 / 3.6,
        "mph": 0.44704,
        "kn": 0.514444,
        "ft/s": 0.3048,
    }
    return value * factors.get(unit or "", 1.0)


class IrrigazioneCoordinator(DataUpdateCoordinator):
    """Raccoglie il meteo, chiude la giornata e aggiorna i deficit."""

    def __init__(
        self, hass: HomeAssistant, entry: ConfigEntry, store: IrrigazioneStore
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name="Irrigazione Smart",
            update_interval=timedelta(minutes=UPDATE_INTERVAL_MIN),
        )
        self._entry = entry
        self._store = store

    # ------------------------------------------------------------ letture

    def _state(self, entity_id: str | None):
        if not entity_id:
            return None
        state = self.hass.states.get(entity_id)
        if state is None or state.state in UNAVAILABLE:
            return None
        return state

    def _sensor(self, key: str) -> tuple[float | None, str | None]:
        """Valore e unità di misura di un sensore configurato."""
        state = self._state(self._entry.data.get(key))
        if state is None:
            return None, None
        return _as_float(state.state), state.attributes.get("unit_of_measurement")

    def _weather_attr(self, attr: str) -> float | None:
        """Attributo dell'entità meteo di fallback."""
        state = self._state(self._entry.data.get(CONF_WEATHER_ENTITY))
        if state is None:
            return None
        return _as_float(state.attributes.get(attr))

    def _read_sources(self) -> dict[str, Any]:
        """Misure correnti, con provenienza per ogni grandezza.

        Il sensore locale ha sempre la precedenza sul servizio meteo: se va
        offline si ripiega sul meteo, ma la provenienza cambia e resta
        visibile in pagina.
        """
        out: dict[str, Any] = {"sources": {}}

        # temperatura (°C)
        value, unit = self._sensor(CONF_TEMPERATURE_ENTITY)
        if value is not None:
            out["temperature"] = _to_celsius(value, unit)
            out["sources"]["temperature"] = "sensore_locale"
        else:
            weather = self._weather_attr("temperature")
            out["temperature"] = weather
            out["sources"]["temperature"] = (
                "servizio_meteo" if weather is not None else "non_disponibile"
            )

        # umidità (%)
        value, _unit = self._sensor(CONF_HUMIDITY_ENTITY)
        if value is None:
            value = self._weather_attr("humidity")
            source = "servizio_meteo" if value is not None else "non_disponibile"
        else:
            source = "sensore_locale"
        out["humidity"] = value
        out["sources"]["humidity"] = source

        # vento (m/s)
        value, unit = self._sensor(CONF_WIND_ENTITY)
        if value is not None:
            out["wind_ms"] = _to_ms(value, unit)
            out["sources"]["wind_speed"] = "sensore_locale"
        else:
            # l'entità weather espone il vento nell'unità di sistema
            raw = self._weather_attr("wind_speed")
            state = self._state(self._entry.data.get(CONF_WEATHER_ENTITY))
            unit = state.attributes.get("wind_speed_unit") if state else None
            out["wind_ms"] = _to_ms(raw, unit) if raw is not None else None
            out["sources"]["wind_speed"] = (
                "servizio_meteo" if raw is not None else "non_disponibile"
            )

        # pioggia (mm cumulati oggi) e irraggiamento (W/m²)
        value, _unit = self._sensor(CONF_RAIN_ENTITY)
        out["rain_mm"] = value
        out["sources"]["precipitation"] = (
            "sensore_locale" if value is not None else "non_disponibile"
        )

        value, _unit = self._sensor(CONF_IRRADIANCE_ENTITY)
        out["irradiance_w"] = value
        out["sources"]["irradiance"] = (
            "sensore_locale" if value is not None else "non_disponibile"
        )

        return out

    # ---------------------------------------------------- ciclo giornaliero

    def _accumulate(self, daily: dict[str, Any], live: dict[str, Any]) -> None:
        """Aggiorna gli estremi e le medie della giornata in corso."""
        temp = live.get("temperature")
        if temp is not None:
            t_min, t_max = daily["t_min"], daily["t_max"]
            daily["t_min"] = temp if t_min is None else min(t_min, temp)
            daily["t_max"] = temp if t_max is None else max(t_max, temp)

        if live.get("humidity") is not None:
            daily["rh_sum"] += live["humidity"]
            daily["rh_n"] += 1

        if live.get("wind_ms") is not None:
            daily["wind_sum"] += live["wind_ms"]
            daily["wind_n"] += 1

        if live.get("irradiance_w") is not None:
            daily["irr_sum"] += live["irradiance_w"]
            daily["irr_n"] += 1

        # Il sensore di pioggia è cumulativo sulla giornata: si tiene il
        # massimo visto, così un azzeramento a mezzanotte non falsa il totale.
        rain = live.get("rain_mm")
        if rain is not None:
            daily["rain_mm"] = max(float(daily.get("rain_mm") or 0.0), rain)

    def _close_day(self, daily: dict[str, Any]) -> dict[str, Any] | None:
        """Chiude la giornata: calcola ET0 e aggiorna i deficit.

        Ritorna il riepilogo del giorno chiuso, oppure None se mancavano
        le temperature (senza Tmin/Tmax nessun metodo ET0 è applicabile).
        """
        t_min, t_max = daily.get("t_min"), daily.get("t_max")
        if t_min is None or t_max is None:
            _LOGGER.warning(
                "Giorno %s chiuso senza temperature: bilancio non aggiornato",
                daily.get("date"),
            )
            return None

        config = self._entry.data
        rh_mean = daily["rh_sum"] / daily["rh_n"] if daily["rh_n"] else None
        wind_mean = daily["wind_sum"] / daily["wind_n"] if daily["wind_n"] else None
        solar_mj = None
        if daily["irr_n"]:
            # media W/m² sull'intera giornata → MJ/m²/giorno
            solar_mj = (daily["irr_sum"] / daily["irr_n"]) * 0.0864

        closed = dt_util.parse_date(daily["date"]) if daily.get("date") else None
        reference = closed or dt_util.now()
        day_of_year = reference.timetuple().tm_yday

        et0 = compute_et0(
            t_min=t_min,
            t_max=t_max,
            latitude_deg=float(config.get(CONF_LATITUDE) or self.hass.config.latitude),
            day_of_year=day_of_year,
            rh_mean=rh_mean,
            wind_ms=wind_mean,
            solar_radiation_mj=solar_mj,
            elevation_m=float(config.get(CONF_ELEVATION) or 0.0),
        )

        rain_mm = float(daily.get("rain_mm") or 0.0)
        system = self._store.system
        for zone_id, zone in self._store.zones.items():
            params = resolve_zone_params(zone, system)
            new_deficit = update_deficit(
                float(zone.get("deficit_mm") or 0.0),
                et0.value_mm,
                params,
                rain_mm=rain_mm,
            )
            self._store.async_set_deficit(zone_id, new_deficit)

        _LOGGER.info(
            "Giorno %s chiuso: ET0 %.2f mm (%s), pioggia %.1f mm, %d zone aggiornate",
            daily.get("date"),
            et0.value_mm,
            et0.method,
            rain_mm,
            len(self._store.zones),
        )
        # i sensori esposti leggono lo store: vanno riallineati subito
        async_dispatcher_send(self.hass, SIGNAL_STATE_CHANGED)

        return {
            "last_et0_mm": round(et0.value_mm, 2),
            "last_et0_method": et0.method,
            "last_closed_date": daily.get("date"),
        }

    # -------------------------------------------------------------- update

    async def _async_update_data(self) -> dict[str, Any]:
        now = dt_util.now()
        today = now.date().isoformat()

        daily = {**DEFAULT_DAILY, **(self._store.daily or {})}
        live = self._read_sources()

        if daily.get("date") is None:
            daily["date"] = today
        elif daily["date"] != today:
            # è passata la mezzanotte: si chiude il giorno accumulato
            summary = self._close_day(daily)
            carried = {
                "last_et0_mm": (summary or daily).get("last_et0_mm"),
                "last_et0_method": (summary or daily).get("last_et0_method"),
                "last_closed_date": (summary or daily).get("last_closed_date"),
            }
            daily = {**DEFAULT_DAILY, **carried, "date": today}

        self._accumulate(daily, live)
        daily["last_update"] = now.isoformat()
        self._store.async_save_daily(daily)

        wind_ms = live.get("wind_ms")
        return {
            "live": live,
            "daily": daily,
            "wind_kmh": wind_ms * 3.6 if wind_ms is not None else 0.0,
        }
