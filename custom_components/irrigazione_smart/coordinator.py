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
from functools import partial
from typing import Any

from homeassistant.components.recorder import get_instance as get_recorder
from homeassistant.components.recorder import history
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_LATITUDE
from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.helpers.start import async_at_started
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
from .hydro import (
    Et0Result,
    apply_water_balance,
    compute_et0,
    effective_rain,
    et_fraction_elapsed,
    resolve_zone_params,
)
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
            # La cadenza la tiene `async_start`, non il coordinator: vedi lì
            # il perché. Lasciarla anche qui farebbe due giri per volta il
            # giorno in cui qualcuno aggiungesse un'entità in ascolto.
            update_interval=None,
        )
        self._entry = entry
        self._store = store

    @callback
    def async_start(self) -> CALLBACK_TYPE:
        """Avvia il ciclo periodico. Ritorna la funzione per fermarlo.

        Il timer è nostro e non quello del `DataUpdateCoordinator`: quello
        viene armato solo finché almeno un'entità è in ascolto del
        coordinator, e qui nessuna lo è — i sensori leggono lo store e si
        aggiornano su un segnale. Il risultato era che dopo il primo
        aggiornamento all'avvio non ne partiva più nessuno: il bilancio
        idrico avanzava soltanto quando si riavviava Home Assistant, e una
        giornata a 34 gradi passava con ET0 zero.

        Il primo giro aspetta che Home Assistant sia avviato del tutto.
        Durante il caricamento l'entità meteo può non esistere ancora: la
        lettura tornerebbe a vuoto e la giornata resterebbe senza Tmin e
        Tmax, cioè senza ET0, fino a mezzanotte.
        """
        unsub_periodico = async_track_time_interval(
            self.hass,
            self._async_tick,
            timedelta(minutes=UPDATE_INTERVAL_MIN),
        )
        unsub_avvio = async_at_started(self.hass, self._async_tick)

        @callback
        def _stop() -> None:
            unsub_periodico()
            unsub_avvio()

        return _stop

    async def _async_tick(self, _quando: Any = None) -> None:
        """Un giro del ciclo. Gli errori li assorbe il coordinator."""
        await self.async_refresh()

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

    async def _fetch_forecast(self) -> dict[str, Any]:
        """Pioggia prevista dal servizio meteo configurato.

        Serve alla guardia che salta l'irrigazione quando sta per piovere:
        senza questa lettura la soglia esiste ma non può mai scattare.
        Si chiede la previsione giornaliera e si guarda solo oggi: la
        pioggia di dopodomani non deve impedire di irrigare stanotte.
        """
        entity_id = self._entry.data.get(CONF_WEATHER_ENTITY)
        if not entity_id or self._state(entity_id) is None:
            return {"available": False}

        try:
            response = await self.hass.services.async_call(
                "weather",
                "get_forecasts",
                {"entity_id": entity_id, "type": "daily"},
                blocking=True,
                return_response=True,
            )
        except Exception:
            # un servizio meteo che non risponde non deve fermare il resto
            # del ciclo: si prosegue senza previsione
            _LOGGER.debug("Previsioni non disponibili da %s", entity_id)
            return {"available": False}

        forecasts = ((response or {}).get(entity_id) or {}).get("forecast") or []
        if not forecasts:
            return {"available": False}

        today = forecasts[0]
        rain = _as_float(today.get("precipitation"))
        probability = _as_float(today.get("precipitation_probability"))

        return {
            "available": True,
            "entity_id": entity_id,
            "rain_mm": rain if rain is not None else 0.0,
            "probability": probability,
            "condition": today.get("condition"),
            "t_min": _as_float(today.get("templow")),
            "t_max": _as_float(today.get("temperature")),
        }

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

    # ------------------------------------------------ ricostruzione storica

    def _source_of(self, key: str, attr: str) -> tuple[str | None, str | None]:
        """Da dove arriva una grandezza: (entità, attributo).

        Stessa precedenza delle letture in tempo reale — sensore locale se
        c'è, altrimenti l'entità meteo — ma restituita in forma leggibile
        anche dallo storico. Sul meteo il numero sta in un attributo, non
        nello stato: `weather.casa` vale «sereno», non 28,4.
        """
        entity_id = self._entry.data.get(key)
        if entity_id and self.hass.states.get(entity_id) is not None:
            return entity_id, None
        weather = self._entry.data.get(CONF_WEATHER_ENTITY)
        return (weather, attr) if weather else (None, None)

    async def _history_values(
        self, entity_id: str | None, attr: str | None, start: Any, end: Any
    ) -> list[float]:
        """Valori numerici registrati fra due istanti."""
        if not entity_id:
            return []
        try:
            recorder = get_recorder(self.hass)
        except (KeyError, RuntimeError):
            # senza recorder si resta ai campionamenti dal vivo
            return []

        try:
            rows = await recorder.async_add_executor_job(
                partial(
                    history.state_changes_during_period,
                    self.hass,
                    start,
                    end,
                    entity_id,
                    no_attributes=attr is None,
                    include_start_time_state=True,
                )
            )
        except Exception:
            # lo storico è un di più: se non si legge, si resta ai
            # campionamenti dal vivo invece di fermare il ciclo
            _LOGGER.debug("Storico non leggibile per %s", entity_id, exc_info=True)
            return []

        valori: list[float] = []
        for state in rows.get(entity_id) or []:
            grezzo = state.attributes.get(attr) if attr else state.state
            numero = _as_float(grezzo)
            if numero is not None:
                valori.append(numero)
        return valori

    async def _sync_from_history(self, daily: dict[str, Any]) -> None:
        """Ricostruisce la giornata in corso dallo storico di Home Assistant.

        Gli accumulatori vivono in memoria: se l'integration parte a
        mezzogiorno — un riavvio, un aggiornamento da HACS — la mattina è
        persa, e con lei la temperatura minima. Senza minima non c'è
        escursione termica, e senza escursione l'ET0 esce vicina a zero
        per tutto il resto della giornata.

        Ma quei numeri Home Assistant li ha già registrati. Invece di
        ricostruire una minima campionando da adesso in poi, si legge la
        giornata com'è andata davvero. Le medie sostituiscono gli
        accumulatori invece di sommarsi: lo storico contiene già i
        campioni che il ciclo aveva raccolto.
        """
        giorno = dt_util.parse_date(daily.get("date") or "")
        inizio = dt_util.start_of_local_day(giorno or dt_util.now())
        fine = min(dt_util.now(), inizio + timedelta(days=1))

        eid, attr = self._source_of(CONF_TEMPERATURE_ENTITY, "temperature")
        temperature = await self._history_values(eid, attr, inizio, fine)
        if temperature:
            unita = self._unit_of(eid, attr)
            temperature = [_to_celsius(v, unita) for v in temperature]
            minima, massima = min(temperature), max(temperature)
            t_min, t_max = daily.get("t_min"), daily.get("t_max")
            daily["t_min"] = minima if t_min is None else min(t_min, minima)
            daily["t_max"] = massima if t_max is None else max(t_max, massima)

        eid, attr = self._source_of(CONF_HUMIDITY_ENTITY, "humidity")
        umidita = await self._history_values(eid, attr, inizio, fine)
        if umidita:
            daily["rh_sum"], daily["rh_n"] = sum(umidita), len(umidita)

        # il vento va in m/s: l'unità è quella dichiarata dalla sorgente
        eid, attr = self._source_of(CONF_WIND_ENTITY, "wind_speed")
        vento = await self._history_values(eid, attr, inizio, fine)
        if vento:
            unita = self._unit_of(eid, attr)
            daily["wind_sum"] = sum(_to_ms(v, unita) for v in vento)
            daily["wind_n"] = len(vento)

        # Piranometro e pluviometro solo se sono sensori veri: il servizio
        # meteo non espone né l'irraggiamento istantaneo né la pioggia
        # cumulata della giornata, e leggerne lo stato darebbe «sereno».
        irraggiamento = await self._history_values(
            self._entry.data.get(CONF_IRRADIANCE_ENTITY), None, inizio, fine
        )
        if irraggiamento:
            daily["irr_sum"], daily["irr_n"] = sum(irraggiamento), len(irraggiamento)

        pioggia = await self._history_values(
            self._entry.data.get(CONF_RAIN_ENTITY), None, inizio, fine
        )
        if pioggia:
            # il pluviometro cumula sulla giornata: conta il massimo visto
            daily["rain_mm"] = max(float(daily.get("rain_mm") or 0.0), max(pioggia))

    def _unit_of(self, entity_id: str | None, attr: str | None) -> str | None:
        """Unità dichiarata da una sorgente, per convertire lo storico."""
        state = self._state(entity_id)
        if state is None:
            return None
        # l'entità meteo dichiara l'unità di ogni grandezza a parte, il
        # sensore ne ha una sola e vale per il suo stato
        if attr == "wind_speed":
            return state.attributes.get("wind_speed_unit")
        if attr == "temperature":
            return state.attributes.get("temperature_unit")
        return state.attributes.get("unit_of_measurement")

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

    @property
    def _latitude(self) -> float:
        return float(self._entry.data.get(CONF_LATITUDE) or self.hass.config.latitude)

    def _et0_of(
        self, daily: dict[str, Any], t_min: float, t_max: float
    ) -> Et0Result:
        """ET0 della giornata coi dati accumulati finora."""
        config = self._entry.data
        rh_mean = daily["rh_sum"] / daily["rh_n"] if daily["rh_n"] else None
        wind_mean = daily["wind_sum"] / daily["wind_n"] if daily["wind_n"] else None
        solar_mj = None
        if daily["irr_n"]:
            # media W/m² sull'intera giornata → MJ/m²/giorno
            solar_mj = (daily["irr_sum"] / daily["irr_n"]) * 0.0864

        closed = dt_util.parse_date(daily["date"]) if daily.get("date") else None
        reference = closed or dt_util.now()

        return compute_et0(
            t_min=t_min,
            t_max=t_max,
            latitude_deg=self._latitude,
            day_of_year=reference.timetuple().tm_yday,
            rh_mean=rh_mean,
            wind_ms=wind_mean,
            solar_radiation_mj=solar_mj,
            elevation_m=float(config.get(CONF_ELEVATION) or 0.0),
        )

    def _charge(self, daily: dict[str, Any], et0_target_mm: float) -> bool:
        """Scarica sul deficit la quota di giornata non ancora addebitata.

        Si ragiona per differenze, non per totali: l'irrigazione scala il
        deficit per conto suo mentre la giornata avanza, e ricalcolare da
        capo cancellerebbe l'acqua appena erogata.

        Il conto non torna mai indietro: se la stima cala — succede, perché
        Tmin e Tmax si assestano solo a fine giornata — si lascia stare
        invece di restituire acqua che la pianta ha già consumato.
        """
        charged = float(daily.get("et0_charged_mm") or 0.0)
        rain_total = float(daily.get("rain_mm") or 0.0)
        rain_charged = float(daily.get("rain_charged_mm") or 0.0)

        et0_delta = max(0.0, et0_target_mm - charged)
        # la pioggia utile non è proporzionale a quella caduta: si fa la
        # differenza fra i due cumulati, non fra i millimetri grezzi
        rain_delta = max(
            0.0, effective_rain(rain_total) - effective_rain(rain_charged)
        )
        if et0_delta <= 0.0 and rain_delta <= 0.0:
            return False

        system = self._store.system
        for zone_id, zone in self._store.zones.items():
            params = resolve_zone_params(zone, system)
            new_deficit = apply_water_balance(
                float(zone.get("deficit_mm") or 0.0),
                et0_delta * params.kc,
                rain_delta,
                params,
            )
            self._store.async_set_deficit(zone_id, new_deficit)

        daily["et0_charged_mm"] = round(charged + et0_delta, 4)
        daily["rain_charged_mm"] = max(rain_total, rain_charged)
        return True

    def _accrue(self, daily: dict[str, Any], forecast: dict[str, Any]) -> None:
        """Aggiorna il deficit durante la giornata, non solo a mezzanotte.

        Con 30 gradi il prato consuma acqua dalla mattina: un bilancio che
        si muove solo allo scoccare della mezzanotte mostra zero per tutto
        il giorno e fa partire l'irrigazione con un giorno di ritardo.
        """
        t_min, t_max = self._day_temperatures(daily, forecast)
        if t_min is None or t_max is None:
            return

        now = dt_util.now()
        et0 = self._et0_of(daily, t_min, t_max)
        fraction = et_fraction_elapsed(
            self._latitude,
            now.timetuple().tm_yday,
            now.hour + now.minute / 60.0,
        )

        daily["et0_today_method"] = et0.method
        if self._charge(daily, et0.value_mm * fraction):
            # i sensori e la pagina leggono lo store, non il coordinator
            async_dispatcher_send(self.hass, SIGNAL_STATE_CHANGED)

    def _day_temperatures(
        self, daily: dict[str, Any], forecast: dict[str, Any]
    ) -> tuple[float | None, float | None]:
        """Tmin e Tmax da usare per la stima in corso di giornata.

        A metà mattina il minimo osservato è quello vero, ma il massimo
        deve ancora arrivare: prendere l'escursione vista finora
        sottostima l'ET0 proprio nelle ore in cui serve. Se la previsione
        di oggi dà estremi più larghi si usano quelli, e la chiusura del
        giorno rimette comunque i conti sui dati misurati.
        """
        t_min, t_max = daily.get("t_min"), daily.get("t_max")
        if not forecast.get("available"):
            return t_min, t_max

        f_min, f_max = forecast.get("t_min"), forecast.get("t_max")
        if f_min is not None:
            t_min = f_min if t_min is None else min(t_min, f_min)
        if f_max is not None:
            t_max = f_max if t_max is None else max(t_max, f_max)
        return t_min, t_max

    def _close_day(self, daily: dict[str, Any]) -> dict[str, Any] | None:
        """Chiude la giornata: calcola ET0 definitivo e salda il bilancio.

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

        et0 = self._et0_of(daily, t_min, t_max)
        rain_mm = float(daily.get("rain_mm") or 0.0)
        rh_mean = daily["rh_sum"] / daily["rh_n"] if daily["rh_n"] else None
        wind_mean = daily["wind_sum"] / daily["wind_n"] if daily["wind_n"] else None
        # addebita il residuo: quello che la giornata ha già scaricato sul
        # deficit ora per ora non va contato una seconda volta
        self._charge(daily, et0.value_mm)

        _LOGGER.info(
            "Giorno %s chiuso: ET0 %.2f mm (%s), pioggia %.1f mm, %d zone aggiornate",
            daily.get("date"),
            et0.value_mm,
            et0.method,
            rain_mm,
            len(self._store.zones),
        )
        # riepilogo della giornata, per i grafici
        self._store.async_append_history(
            {
                "date": daily.get("date"),
                "t_min": round(t_min, 1),
                "t_max": round(t_max, 1),
                "rh_mean": round(rh_mean, 1) if rh_mean is not None else None,
                "wind_mean_kmh": (
                    round(wind_mean * 3.6, 1) if wind_mean is not None else None
                ),
                "rain_mm": round(rain_mm, 1),
                "et0_mm": round(et0.value_mm, 2),
                "method": et0.method,
                "irrigated": dict(daily.get("irrigated") or {}),
            }
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
            # è passata la mezzanotte: si chiude il giorno accumulato.
            # Prima però lo si rilegge dallo storico: se l'integration è
            # rimasta ferma per una parte di quel giorno, i suoi
            # accumulatori raccontano solo i pezzi in cui era accesa —
            # e senza temperature la chiusura non calcola nulla.
            await self._sync_from_history(daily)
            summary = self._close_day(daily)
            carried = {
                "last_et0_mm": (summary or daily).get("last_et0_mm"),
                "last_et0_method": (summary or daily).get("last_et0_method"),
                "last_closed_date": (summary or daily).get("last_closed_date"),
            }
            daily = {**DEFAULT_DAILY, **carried, "date": today}

        # La giornata in corso si riallinea allo storico a ogni giro: costa
        # una lettura al recorder e rende il bilancio indifferente ai
        # riavvii, che è esattamente il punto in cui si rompeva.
        await self._sync_from_history(daily)
        self._accumulate(daily, live)

        # La previsione serve prima del bilancio, non dopo: a metà mattina
        # è l'unica cosa che sa quanto salirà ancora la temperatura.
        forecast = await self._fetch_forecast()
        self._accrue(daily, forecast)

        daily["last_update"] = now.isoformat()
        self._store.async_save_daily(daily)

        wind_ms = live.get("wind_ms")
        return {
            "live": live,
            "daily": daily,
            "forecast": forecast,
            "rain_forecast_mm": float(forecast.get("rain_mm") or 0.0),
            "wind_kmh": wind_ms * 3.6 if wind_ms is not None else 0.0,
        }
