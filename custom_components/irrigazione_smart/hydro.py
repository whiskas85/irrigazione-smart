"""
Motore di calcolo idrico per l'integration `irrigazione_smart`.

Modulo puro: nessuna dipendenza da Home Assistant, testabile stand-alone.
Tutta la logica agronomica vive qui; il resto dell'integration si limita a
raccogliere input (meteo, config zone) e a pilotare le valvole.

Riferimenti:
  - FAO-56 (Allen et al., 1998) per il bilancio idrico e i coefficienti colturali
  - Hargreaves-Samani (1985) per la stima di ET0 da sole temperature
  - Valori AWC / infiltrazione: USDA NRCS, ranges tipici per tessitura
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

# --------------------------------------------------------------------------
# Sentinelle per l'ereditarietà
# --------------------------------------------------------------------------

INHERIT_NUM = -1.0
INHERIT_STR = "eredita"


def _is_set(value: Any) -> bool:
    """True se il valore è un override esplicito (non 'eredita')."""
    if value is None:
        return False
    if isinstance(value, str):
        return value != INHERIT_STR
    return float(value) != INHERIT_NUM


def resolve(*candidates: Any, default: Any = None) -> Any:
    """Risolve una catena di ereditarietà: primo valore esplicito vince.

    resolve(zona, preset, sistema) -> il primo che non sia 'eredita'.
    """
    for value in candidates:
        if _is_set(value):
            return value
    return default


# --------------------------------------------------------------------------
# Preset e proprietà del terreno
# --------------------------------------------------------------------------

# kc            = coefficiente colturale (FAO-56)
# root_depth_cm = profondità zona radicale efficace
# mad           = Management Allowed Depletion, frazione di TAW consumabile
#                 prima di irrigare
ZONE_PRESETS: dict[str, dict[str, float]] = {
    "prato_microterme": {"kc": 0.80, "root_depth_cm": 20.0, "mad": 0.50},
    "prato_macroterme": {"kc": 0.60, "root_depth_cm": 25.0, "mad": 0.50},
    "aiuola_arbusti": {"kc": 0.50, "root_depth_cm": 40.0, "mad": 0.60},
    "aiuola_fiorita": {"kc": 0.75, "root_depth_cm": 30.0, "mad": 0.40},
    "orto": {"kc": 1.00, "root_depth_cm": 40.0, "mad": 0.40},
}

# awc_mm_cm         = acqua disponibile per cm di profondità
# infiltration_mm_h = velocità di infiltrazione a regime
SOIL_PROPS: dict[str, dict[str, float]] = {
    "sabbioso": {"awc_mm_cm": 0.7, "infiltration_mm_h": 25.0},
    "franco": {"awc_mm_cm": 1.4, "infiltration_mm_h": 10.0},
    "argilloso": {"awc_mm_cm": 1.7, "infiltration_mm_h": 4.0},
}

# Efficienza di distribuzione per tipo di erogazione.
# Serve a maggiorare il lordo: parte dell'acqua non arriva mai alla pianta.
EMITTER_EFFICIENCY: dict[str, float] = {
    "statici": 0.70,
    "turbine": 0.75,
    "goccia": 0.90,
}

# Tetto di sicurezza assoluto, applicato quando né la zona né il sistema
# ne specificano uno. Non è un vincolo agronomico: è la rete che impedisce
# a un errore di configurazione (portata inserita 1.2 invece di 12) di
# tenere una valvola aperta per mezza giornata.
ABSOLUTE_MAX_RUNTIME_MIN = 240.0


# --------------------------------------------------------------------------
# Evapotraspirazione di riferimento (ET0)
# --------------------------------------------------------------------------


def extraterrestrial_radiation(latitude_deg: float, day_of_year: int) -> float:
    """Radiazione extraterrestre Ra in MJ/m²/giorno (FAO-56 eq. 21).

    Dipende solo da latitudine e giorno dell'anno: nessun dato meteo richiesto.
    """
    lat = math.radians(latitude_deg)
    # distanza relativa inversa Terra-Sole
    dr = 1.0 + 0.033 * math.cos(2.0 * math.pi * day_of_year / 365.0)
    # declinazione solare
    delta = 0.409 * math.sin(2.0 * math.pi * day_of_year / 365.0 - 1.39)
    # angolo orario al tramonto (clamp per latitudini polari)
    ws_arg = max(-1.0, min(1.0, -math.tan(lat) * math.tan(delta)))
    ws = math.acos(ws_arg)

    return (
        (24.0 * 60.0 / math.pi)
        * 0.0820
        * dr
        * (
            ws * math.sin(lat) * math.sin(delta)
            + math.cos(lat) * math.cos(delta) * math.sin(ws)
        )
    )


def et0_hargreaves(
    t_min: float, t_max: float, latitude_deg: float, day_of_year: int
) -> float:
    """ET0 in mm/giorno con Hargreaves-Samani.

    Scelto rispetto a Penman-Monteith perché richiede solo Tmin/Tmax:
    dati che qualunque servizio meteo (OpenWeatherMap incluso) fornisce
    in modo affidabile, senza radiazione solare misurata.
    """
    if t_max < t_min:
        t_min, t_max = t_max, t_min

    t_mean = (t_min + t_max) / 2.0
    ra_mm = extraterrestrial_radiation(latitude_deg, day_of_year) * 0.408
    et0 = 0.0023 * (t_mean + 17.8) * math.sqrt(t_max - t_min) * ra_mm

    return max(0.0, et0)


# --------------------------------------------------------------------------
# Penman-Monteith FAO-56
#
# Metodo di riferimento mondiale, ma richiede umidità e vento oltre alle
# temperature. Si attiva solo se l'utente ha sensori locali: con i soli
# dati di un servizio meteo, Hargreaves è più onesto.
# --------------------------------------------------------------------------

STEFAN_BOLTZMANN = 4.903e-9  # MJ K⁻⁴ m⁻² giorno⁻¹
ALBEDO_GRASS = 0.23


def saturation_vapour_pressure(t_c: float) -> float:
    """Pressione di vapore a saturazione in kPa (FAO-56 eq. 11)."""
    return 0.6108 * math.exp(17.27 * t_c / (t_c + 237.3))


def slope_vapour_pressure_curve(t_c: float) -> float:
    """Pendenza della curva di pressione di vapore, kPa/°C (FAO-56 eq. 13)."""
    return (4098.0 * saturation_vapour_pressure(t_c)) / ((t_c + 237.3) ** 2)


def atmospheric_pressure(elevation_m: float) -> float:
    """Pressione atmosferica in kPa da quota (FAO-56 eq. 7)."""
    return 101.3 * (((293.0 - 0.0065 * elevation_m) / 293.0) ** 5.26)


def psychrometric_constant(elevation_m: float) -> float:
    """Costante psicrometrica in kPa/°C (FAO-56 eq. 8)."""
    return 0.000665 * atmospheric_pressure(elevation_m)


def wind_speed_at_2m(wind_ms: float, measured_height_m: float = 10.0) -> float:
    """Riporta la velocità del vento a 2m (FAO-56 eq. 47).

    I servizi meteo danno il vento a 10m; gli anemometri domestici sono
    a altezze varie. Penman-Monteith vuole il dato a 2m.
    """
    if measured_height_m <= 0:
        return wind_ms
    return wind_ms * 4.87 / math.log(67.8 * measured_height_m - 5.42)


def solar_radiation_from_temp(
    t_min: float,
    t_max: float,
    ra_mj: float,
    krs: float = 0.16,
) -> float:
    """Stima Rs dall'escursione termica (FAO-56 eq. 50).

    Fallback quando non c'è un piranometro. krs 0.16 per località
    interne, 0.19 per zone costiere. Avigliana è interna.
    """
    return krs * math.sqrt(max(0.0, t_max - t_min)) * ra_mj


def et0_penman_monteith(
    t_min: float,
    t_max: float,
    rh_mean: float,
    wind_ms: float,
    latitude_deg: float,
    day_of_year: int,
    *,
    elevation_m: float = 350.0,
    solar_radiation_mj: float | None = None,
    wind_height_m: float = 10.0,
    krs: float = 0.16,
) -> float:
    """ET0 in mm/giorno con Penman-Monteith FAO-56.

    `solar_radiation_mj` è opzionale: se manca viene stimata
    dall'escursione termica. Se hai un sensore di irraggiamento
    (device_class `irradiance`, W/m²), convertilo in MJ/m²/giorno
    con: MJ = media_W_m2 * 0.0864
    """
    if t_max < t_min:
        t_min, t_max = t_max, t_min

    t_mean = (t_min + t_max) / 2.0
    ra_mj = extraterrestrial_radiation(latitude_deg, day_of_year)

    rs = (
        solar_radiation_mj
        if solar_radiation_mj is not None
        else solar_radiation_from_temp(t_min, t_max, ra_mj, krs)
    )
    # radiazione in cielo sereno: serve al termine di onda lunga
    rso = (0.75 + 2e-5 * elevation_m) * ra_mj
    rs = min(rs, rso)  # Rs non può superare il cielo sereno

    # pressioni di vapore
    es = (saturation_vapour_pressure(t_max) + saturation_vapour_pressure(t_min)) / 2.0
    ea = es * max(0.0, min(100.0, rh_mean)) / 100.0
    vpd = max(0.0, es - ea)

    # bilancio radiativo
    rns = (1.0 - ALBEDO_GRASS) * rs
    rnl = (
        STEFAN_BOLTZMANN
        * (((t_max + 273.16) ** 4 + (t_min + 273.16) ** 4) / 2.0)
        * (0.34 - 0.14 * math.sqrt(max(0.0, ea)))
        * (1.35 * (rs / rso if rso > 0 else 0.0) - 0.35)
    )
    rn = rns - rnl

    # termini dell'equazione
    delta = slope_vapour_pressure_curve(t_mean)
    gamma = psychrometric_constant(elevation_m)
    u2 = wind_speed_at_2m(wind_ms, wind_height_m)

    numerator = 0.408 * delta * rn + gamma * (900.0 / (t_mean + 273.0)) * u2 * vpd
    denominator = delta + gamma * (1.0 + 0.34 * u2)

    return max(0.0, numerator / denominator)


# --------------------------------------------------------------------------
# Dispatcher: sceglie il metodo migliore disponibile
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Et0Result:
    """ET0 con tracciabilità del metodo e delle fonti usate."""

    value_mm: float
    method: str
    sources: dict[str, str]

    def __str__(self) -> str:
        return f"{self.value_mm:.2f} mm/g ({self.method})"


def compute_et0(
    *,
    t_min: float,
    t_max: float,
    latitude_deg: float,
    day_of_year: int,
    rh_mean: float | None = None,
    wind_ms: float | None = None,
    solar_radiation_mj: float | None = None,
    elevation_m: float = 350.0,
    wind_height_m: float = 10.0,
    krs: float = 0.16,
    sources: dict[str, str] | None = None,
) -> Et0Result:
    """Calcola ET0 col metodo più accurato consentito dai dati disponibili.

    Penman-Monteith se ci sono umidità e vento, altrimenti Hargreaves.
    Il campo `method` va esposto in dashboard: l'utente deve sapere su
    quale modello sta girando il suo impianto.
    """
    sources = sources or {}

    if rh_mean is not None and wind_ms is not None:
        value = et0_penman_monteith(
            t_min,
            t_max,
            rh_mean,
            wind_ms,
            latitude_deg,
            day_of_year,
            elevation_m=elevation_m,
            solar_radiation_mj=solar_radiation_mj,
            wind_height_m=wind_height_m,
            krs=krs,
        )
        method = (
            "penman_monteith"
            if solar_radiation_mj is not None
            else "penman_monteith_rs_stimata"
        )
        return Et0Result(value, method, sources)

    value = et0_hargreaves(t_min, t_max, latitude_deg, day_of_year)
    return Et0Result(value, "hargreaves", sources)


# --------------------------------------------------------------------------
# Risoluzione delle fonti dati
# --------------------------------------------------------------------------

# Device class attese per ciascuna grandezza. Il selettore del pannello
# filtra le entità su queste, così l'utente non può collegare un sensore
# sbagliato.
SENSOR_DEVICE_CLASSES: dict[str, str] = {
    "temperature": "temperature",
    "humidity": "humidity",
    "wind_speed": "wind_speed",
    "precipitation": "precipitation",
    "irradiance": "irradiance",
}


def resolve_measurement(
    local_value: float | None,
    weather_value: float | None,
    *,
    name: str = "",
) -> tuple[float | None, str]:
    """Sensore locale se disponibile, altrimenti servizio meteo.

    Ritorna anche la provenienza, che va mostrata in dashboard: quando
    un sensore va offline e il sistema silenziosamente ripiega sul meteo,
    l'utente deve poterlo vedere.
    """
    if local_value is not None:
        return local_value, "sensore_locale"
    if weather_value is not None:
        return weather_value, "servizio_meteo"
    return None, "non_disponibile"


def effective_rain(
    rain_mm: float, min_threshold: float = 2.0, efficiency: float = 0.80
) -> float:
    """Pioggia realmente utile alla pianta.

    Piogge sotto soglia evaporano dalla superficie fogliare senza mai
    raggiungere la zona radicale: contano zero, non poco.
    """
    if rain_mm < min_threshold:
        return 0.0
    return rain_mm * efficiency


# --------------------------------------------------------------------------
# Parametri risolti di una zona
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class ZoneParams:
    """Parametri di una zona dopo la risoluzione dell'ereditarietà."""

    kc: float
    root_depth_cm: float
    mad: float
    soil: str
    awc_mm_cm: float
    infiltration_mm_h: float
    rate_mm_h: float
    corrector: float
    emitter: str
    efficiency: float
    max_runtime_min: float = 0.0

    @property
    def taw_mm(self) -> float:
        """Total Available Water: acqua utile nell'intera zona radicale."""
        return self.awc_mm_cm * self.root_depth_cm

    @property
    def trigger_threshold_mm(self) -> float:
        """Deficit oltre il quale la pianta inizia a soffrire."""
        return self.taw_mm * self.mad

    def applied_mm(self, minutes: float) -> float:
        """Millimetri realmente assorbiti in `minutes` di valvola aperta.

        Serve quando la durata viene troncata dal tetto massimo: il
        deficit va scalato di quanto è stato dato davvero, non azzerato.
        """
        return self.rate_mm_h * (minutes / 60.0) * self.efficiency


def resolve_zone_params(
    zone: dict[str, Any],
    system: dict[str, Any],
) -> ZoneParams:
    """Applica l'ereditarietà Zona -> Preset -> Sistema.

    `zone` può contenere sentinelle INHERIT_NUM / INHERIT_STR su qualunque
    campo agronomico; i campi fisici (portata, correttore) sono sempre
    espliciti perché descrivono l'impianto, non la coltura.
    """
    preset_name = zone.get("zone_type", "prato_microterme")
    preset = ZONE_PRESETS.get(preset_name, ZONE_PRESETS["prato_microterme"])

    kc = float(resolve(zone.get("kc"), preset["kc"], system.get("kc"), default=0.8))
    root_depth_cm = float(
        resolve(
            zone.get("root_depth_cm"),
            preset["root_depth_cm"],
            system.get("root_depth_cm"),
            default=20.0,
        )
    )
    mad = float(
        resolve(zone.get("mad"), preset["mad"], system.get("mad"), default=0.5)
    )

    soil = str(
        resolve(zone.get("soil"), system.get("soil"), default="franco")
    )
    soil_props = SOIL_PROPS.get(soil, SOIL_PROPS["franco"])

    emitter = str(zone.get("emitter", "statici"))
    efficiency = float(
        resolve(
            zone.get("efficiency"),
            EMITTER_EFFICIENCY.get(emitter),
            system.get("efficiency"),
            default=0.75,
        )
    )

    return ZoneParams(
        kc=kc,
        root_depth_cm=root_depth_cm,
        mad=mad,
        soil=soil,
        awc_mm_cm=soil_props["awc_mm_cm"],
        infiltration_mm_h=soil_props["infiltration_mm_h"],
        rate_mm_h=float(zone.get("rate_mm_h", 10.0)),
        corrector=float(zone.get("corrector", 1.0)),
        emitter=emitter,
        efficiency=efficiency,
        max_runtime_min=float(
            resolve(
                zone.get("max_runtime_min"),
                system.get("max_runtime_min"),
                default=ABSOLUTE_MAX_RUNTIME_MIN,
            )
        ),
    )


# --------------------------------------------------------------------------
# Bilancio idrico
# --------------------------------------------------------------------------


def update_deficit(
    previous_deficit_mm: float,
    et0_mm: float,
    params: ZoneParams,
    rain_mm: float = 0.0,
    irrigation_mm: float = 0.0,
) -> float:
    """Aggiorna il deficit idrico accumulato (il 'bucket').

    Deficit(t) = Deficit(t-1) + ETc - Pioggia_efficace - Irrigazione

    Vincolato tra 0 (capacità di campo: l'eccesso percola via) e TAW
    (oltre, la pianta è in stress permanente e accumulare non ha senso).
    """
    etc = et0_mm * params.kc
    deficit = (
        previous_deficit_mm
        + etc
        - effective_rain(rain_mm)
        - irrigation_mm
    )
    return max(0.0, min(deficit, params.taw_mm))


# --------------------------------------------------------------------------
# Piano di irrigazione
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class RunPlan:
    """Piano operativo per una singola zona."""

    should_run: bool
    reason: str
    net_mm: float = 0.0
    gross_mm: float = 0.0
    total_minutes: float = 0.0
    cycles: int = 1
    minutes_per_cycle: float = 0.0
    soak_minutes: int = 0
    capped: bool = False
    uncapped_minutes: float = 0.0
    applied_mm: float = 0.0
    residual_mm: float = 0.0

    @property
    def wall_clock_minutes(self) -> float:
        """Durata reale inclusi i tempi di assorbimento tra i cicli.

        Il tetto massimo NON include le pause: limita i minuti di valvola
        aperta, non l'occupazione della finestra.
        """
        return self.total_minutes + self.soak_minutes * max(0, self.cycles - 1)


def build_run_plan(
    deficit_mm: float,
    params: ZoneParams,
    soak_minutes: int = 30,
    max_cycles: int = 4,
) -> RunPlan:
    """Traduce un deficit in minuti di valvola aperta.

    Cycle & soak: se l'impianto eroga più velocemente di quanto il terreno
    assorba, l'acqua in eccesso ruscella via. Si spezza allora l'irrigazione
    in più passate con pause di assorbimento. È la regola che i timer
    commerciali non applicano e che su terreno argilloso fa la differenza
    tra irrigare e allagare.

    Tetto massimo: se `params.max_runtime_min` tronca la durata, il
    deficit non coperto resta a bilancio e verrà recuperato nei giorni
    successivi. Il sistema non deve mai "dimenticare" l'acqua non data.
    """
    if deficit_mm <= 0:
        return RunPlan(should_run=False, reason="deficit_nullo")

    if params.rate_mm_h <= 0:
        return RunPlan(should_run=False, reason="portata_non_configurata")

    # lordo = netto maggiorato dell'inefficienza di distribuzione
    gross_mm = (deficit_mm / params.efficiency) * params.corrector
    uncapped_minutes = (gross_mm / params.rate_mm_h) * 60.0

    cap = params.max_runtime_min if params.max_runtime_min > 0 else math.inf
    total_minutes = min(uncapped_minutes, cap)
    capped = total_minutes < uncapped_minutes

    cycles = 1
    if params.rate_mm_h > params.infiltration_mm_h:
        cycles = min(
            max_cycles,
            math.ceil(params.rate_mm_h / params.infiltration_mm_h),
        )

    applied = params.applied_mm(total_minutes)
    residual = max(0.0, deficit_mm - applied)

    return RunPlan(
        should_run=True,
        reason="troncato_da_tetto_massimo" if capped else "deficit_oltre_soglia",
        net_mm=round(deficit_mm, 2),
        gross_mm=round(gross_mm, 2),
        total_minutes=round(total_minutes, 1),
        cycles=cycles,
        minutes_per_cycle=round(total_minutes / cycles, 1),
        soak_minutes=soak_minutes if cycles > 1 else 0,
        capped=capped,
        uncapped_minutes=round(uncapped_minutes, 1),
        applied_mm=round(applied, 2),
        residual_mm=round(residual, 2),
    )


# --------------------------------------------------------------------------
# Finestra oraria
#
# Il default 04:00-08:00 è quello agronomicamente corretto, ma resta un
# default: l'utente può spostarlo. Il sistema segnala la qualità della
# scelta senza impedirla.
# --------------------------------------------------------------------------

DAY_MINUTES = 24 * 60


@dataclass(frozen=True)
class TimeWindow:
    """Finestra oraria in minuti dalla mezzanotte. Gestisce lo scavalco."""

    start_min: int
    end_min: int

    @classmethod
    def from_strings(cls, start: str, end: str) -> "TimeWindow":
        """Accetta 'HH:MM' o 'HH:MM:SS'."""

        def parse(value: str) -> int:
            parts = value.split(":")
            return int(parts[0]) * 60 + int(parts[1])

        return cls(parse(start), parse(end))

    @property
    def crosses_midnight(self) -> bool:
        return self.end_min <= self.start_min

    @property
    def duration_min(self) -> int:
        if self.crosses_midnight:
            return (DAY_MINUTES - self.start_min) + self.end_min
        return self.end_min - self.start_min

    def contains(self, minute_of_day: int) -> bool:
        if self.crosses_midnight:
            return minute_of_day >= self.start_min or minute_of_day < self.end_min
        return self.start_min <= minute_of_day < self.end_min

    def __str__(self) -> str:
        def fmt(m: int) -> str:
            return f"{m // 60:02d}:{m % 60:02d}"

        return f"{fmt(self.start_min)}-{fmt(self.end_min)}"


def window_quality(window: TimeWindow) -> tuple[str, str]:
    """Valuta la bontà agronomica di una finestra oraria.

    Ritorna (livello, motivo). Livelli: ottimale / accettabile / sconsigliata.
    Il sistema non blocca nulla: mostra l'avviso e lascia decidere.
    """
    start_h = window.start_min / 60.0
    end_h = window.end_min / 60.0 if not window.crosses_midnight else 24.0

    if end_h > 18.0 or start_h >= 18.0:
        return (
            "sconsigliata",
            "irrigare la sera lascia il fogliame bagnato tutta la notte "
            "e favorisce le malattie fungine",
        )
    if start_h >= 10.0 and end_h <= 17.0:
        return (
            "sconsigliata",
            "nelle ore centrali una quota rilevante dell'acqua evapora "
            "prima di infiltrarsi",
        )
    if 3.0 <= start_h and end_h <= 10.0:
        return (
            "ottimale",
            "il prato è già bagnato di rugiada: l'irrigazione non aggiunge "
            "ore di bagnatura fogliare",
        )
    if start_h < 3.0:
        return (
            "accettabile",
            "va bene dal punto di vista fitosanitario, ma allunga inutilmente "
            "la bagnatura pre-alba",
        )
    return ("accettabile", "finestra praticabile, non ottimale")


# --------------------------------------------------------------------------
# Scheduling della sequenza
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class ScheduledRun:
    """Una zona collocata nel tempo all'interno della finestra."""

    zone_id: str
    zone_name: str
    start_min: int
    end_min: int
    plan: "RunPlan"

    @property
    def start_hhmm(self) -> str:
        m = self.start_min % DAY_MINUTES
        return f"{m // 60:02d}:{m % 60:02d}"

    @property
    def end_hhmm(self) -> str:
        m = self.end_min % DAY_MINUTES
        return f"{m // 60:02d}:{m % 60:02d}"


@dataclass(frozen=True)
class SequenceSchedule:
    """Piano completo della notte, con diagnosi di capienza."""

    runs: list[ScheduledRun]
    window: TimeWindow
    total_minutes: float
    fits: bool
    overflow_minutes: float
    dropped: list[str]

    @property
    def utilization(self) -> float:
        if self.window.duration_min <= 0:
            return 0.0
        return self.total_minutes / self.window.duration_min


def schedule_sequence(
    zone_plans: list[tuple[str, str, "RunPlan"]],
    window: TimeWindow,
    *,
    gap_minutes: int = 5,
    allow_overflow: bool = True,
) -> SequenceSchedule:
    """Colloca le zone nella finestra, in ordine.

    `zone_plans` è una lista di (zone_id, zone_name, plan) già ordinata
    per priorità. Le zone con `should_run=False` vengono ignorate.

    Se la somma eccede la finestra:
      - `allow_overflow=True`  → sfora, segnalando di quanto
      - `allow_overflow=False` → tronca, riportando le zone escluse

    Troncare è la scelta giusta quando l'impianto condivide la pressione
    con l'uso domestico: irrigare alle 9 del mattino mentre qualcuno fa
    la doccia è peggio che saltare una zona.
    """
    runs: list[ScheduledRun] = []
    dropped: list[str] = []
    cursor = window.start_min
    total = 0.0

    active = [(zid, name, p) for zid, name, p in zone_plans if p.should_run]

    for index, (zone_id, zone_name, plan) in enumerate(active):
        duration = plan.wall_clock_minutes
        gap = gap_minutes if index > 0 else 0
        needed = duration + gap

        if not allow_overflow and (total + needed) > window.duration_min:
            dropped.append(zone_name)
            continue

        cursor += gap
        runs.append(
            ScheduledRun(
                zone_id=zone_id,
                zone_name=zone_name,
                start_min=cursor,
                end_min=cursor + int(round(duration)),
                plan=plan,
            )
        )
        cursor += int(round(duration))
        total += needed

    overflow = max(0.0, total - window.duration_min)

    return SequenceSchedule(
        runs=runs,
        window=window,
        total_minutes=round(total, 1),
        fits=overflow <= 0,
        overflow_minutes=round(overflow, 1),
        dropped=dropped,
    )


# --------------------------------------------------------------------------
# Regole di guardia
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class GuardResult:
    blocked: bool
    reason: str = ""


def check_guards(
    *,
    enabled: bool = True,
    master_enabled: bool = True,
    day_excluded: bool = False,
    wind_kmh: float = 0.0,
    wind_max_kmh: float = 18.0,
    rain_forecast_mm: float = 0.0,
    rain_forecast_max_mm: float = 8.0,
    freezing: bool = False,
    window: TimeWindow | None = None,
    now_minute: int | None = None,
) -> GuardResult:
    """Condizioni che bloccano l'irrigazione indipendentemente dal deficit.

    L'ordine conta: si riporta il primo motivo di blocco, quello che
    l'utente vedrà in dashboard.

    La finestra oraria si controlla solo se vengono passati sia `window`
    sia `now_minute`. Gli avvii manuali devono poter partire in qualunque
    momento: chi preme il pulsante sa cosa sta facendo.
    """
    if not master_enabled:
        return GuardResult(True, "master_disattivo")
    if not enabled:
        return GuardResult(True, "zona_disabilitata")
    if freezing:
        return GuardResult(True, "rischio_gelo")
    if day_excluded:
        return GuardResult(True, "giorno_escluso")
    if window is not None and now_minute is not None:
        if not window.contains(now_minute):
            return GuardResult(True, f"fuori_finestra_{window}")
    if wind_kmh > wind_max_kmh:
        return GuardResult(True, f"vento_eccessivo_{wind_kmh:.0f}kmh")
    if rain_forecast_mm > rain_forecast_max_mm:
        return GuardResult(True, f"pioggia_prevista_{rain_forecast_mm:.1f}mm")
    return GuardResult(False)


# --------------------------------------------------------------------------
# Decisione completa
# --------------------------------------------------------------------------


def evaluate_zone(
    zone: dict[str, Any],
    system: dict[str, Any],
    deficit_mm: float,
    *,
    wind_kmh: float = 0.0,
    rain_forecast_mm: float = 0.0,
    day_excluded: bool = False,
    freezing: bool = False,
) -> RunPlan:
    """Punto di ingresso: decide se e quanto irrigare una zona."""
    params = resolve_zone_params(zone, system)

    guard = check_guards(
        enabled=zone.get("enabled", True),
        master_enabled=system.get("master_enabled", True),
        day_excluded=day_excluded,
        wind_kmh=wind_kmh,
        wind_max_kmh=float(system.get("wind_max_kmh", 18.0)),
        rain_forecast_mm=rain_forecast_mm,
        rain_forecast_max_mm=float(system.get("rain_forecast_max_mm", 8.0)),
        freezing=freezing,
    )
    if guard.blocked:
        return RunPlan(should_run=False, reason=guard.reason)

    if deficit_mm < params.trigger_threshold_mm:
        return RunPlan(
            should_run=False,
            reason=(
                f"sotto_soglia_{deficit_mm:.1f}/"
                f"{params.trigger_threshold_mm:.1f}mm"
            ),
        )

    return build_run_plan(
        deficit_mm,
        params,
        soak_minutes=int(system.get("soak_minutes", 30)),
    )


# --------------------------------------------------------------------------
# Demo
# --------------------------------------------------------------------------

if __name__ == "__main__":
    LAT = 45.08  # Avigliana (TO)

    system_cfg = {
        "soil": "franco",
        "master_enabled": True,
        "wind_max_kmh": 18.0,
        "rain_forecast_max_mm": 8.0,
        "soak_minutes": 30,
    }

    zones = [
        {
            "name": "Prato Sud - Piscina",
            "zone_type": "prato_microterme",
            "soil": INHERIT_STR,        # eredita 'franco' dal sistema
            "kc": INHERIT_NUM,          # eredita 0.80 dal preset
            "rate_mm_h": 12.0,
            "emitter": "statici",
            "corrector": 1.0,
            "enabled": True,
        },
        {
            "name": "Aiuola Nord - Garage",
            "zone_type": "aiuola_arbusti",
            "soil": "argilloso",        # override esplicito
            "kc": INHERIT_NUM,
            "rate_mm_h": 6.0,
            "emitter": "goccia",
            "corrector": 0.8,
            "enabled": True,
        },
    ]

    # ── confronto tra metodi ET0 ────────────────────────────────────────
    print(f"{'=' * 68}")
    print("CONFRONTO METODI ET0 - giornata calda, 18/30°C, UR 55%, vento 2 m/s")
    print(f"{'=' * 68}\n")

    demo_args = {"t_min": 18.0, "t_max": 30.0, "latitude_deg": LAT, "day_of_year": 208}

    only_temp = compute_et0(**demo_args)
    with_sensors = compute_et0(**demo_args, rh_mean=55.0, wind_ms=2.0)
    with_pyranometer = compute_et0(
        **demo_args, rh_mean=55.0, wind_ms=2.0, solar_radiation_mj=25.0
    )

    print(f"   solo temperatura      → {only_temp}")
    print(f"   + umidità e vento     → {with_sensors}")
    print(f"   + piranometro         → {with_pyranometer}")
    print()

    delta = abs(with_sensors.value_mm - only_temp.value_mm)
    pct = delta / only_temp.value_mm * 100 if only_temp.value_mm else 0
    print(
        f"   Scarto tra i due metodi: {delta:.2f} mm/g ({pct:.0f}%)\n"
        f"   Su una stagione, {delta:.2f} mm/g diventano ~{delta * 120:.0f} mm\n"
        f"   di errore cumulato: diverse irrigazioni in più o in meno.\n"
    )

    print(f"{'=' * 68}")
    print("SIMULAZIONE 10 GIORNI - Avigliana (TO), fine luglio")
    print(f"{'=' * 68}\n")

    # meteo sintetico: ondata di calore con un temporale al giorno 6
    weather = [
        (18, 30, 0.0), (19, 32, 0.0), (20, 34, 0.0), (21, 35, 0.0),
        (20, 33, 0.0), (17, 26, 22.0), (16, 24, 3.0), (18, 29, 0.0),
        (19, 31, 0.0), (20, 33, 0.0),
    ]

    for zone in zones:
        params = resolve_zone_params(zone, system_cfg)
        print(f"── {zone['name']}")
        print(
            f"   terreno {params.soil} · Kc {params.kc} · "
            f"radici {params.root_depth_cm:.0f}cm"
        )
        print(
            f"   TAW {params.taw_mm:.1f}mm · soglia {params.trigger_threshold_mm:.1f}mm · "
            f"portata {params.rate_mm_h}mm/h · infiltr. {params.infiltration_mm_h}mm/h"
        )
        print()

        deficit = 0.0
        for day in range(10):
            doy = 208 + day
            t_min, t_max, rain = weather[day]
            et0 = et0_hargreaves(t_min, t_max, LAT, doy)

            deficit = update_deficit(deficit, et0, params, rain_mm=rain)

            plan = evaluate_zone(
                zone, system_cfg, deficit,
                wind_kmh=8.0,
                rain_forecast_mm=0.0,
            )

            marker = "💧" if plan.should_run else "  "
            line = (
                f"   {marker} g{day + 1:>2}  "
                f"{t_min:>2}/{t_max:<2}°C  "
                f"pioggia {rain:>4.1f}mm  "
                f"ET0 {et0:.2f}  "
                f"deficit {deficit:>5.1f}mm"
            )

            if plan.should_run:
                line += (
                    f"  →  {plan.total_minutes:.0f} min"
                    f" in {plan.cycles} cicli da {plan.minutes_per_cycle:.0f}'"
                )
                if plan.capped:
                    line += f" ⚠ TRONCATO (servivano {plan.uncapped_minutes:.0f})"
                # il deficit scende di quanto è stato dato davvero,
                # non a zero: un troncamento lascia un residuo
                deficit = plan.residual_mm

            print(line)
        print()

    # ── finestra oraria e capienza ──────────────────────────────────────
    print(f"{'=' * 68}")
    print("FINESTRA ORARIA - qualità agronomica e capienza")
    print(f"{'=' * 68}\n")

    for start, end in [
        ("04:00", "08:00"),
        ("05:30", "07:00"),
        ("20:00", "22:00"),
        ("11:00", "14:00"),
        ("23:00", "05:00"),
    ]:
        win = TimeWindow.from_strings(start, end)
        level, why = window_quality(win)
        badge = {"ottimale": "✓", "accettabile": "~", "sconsigliata": "✗"}[level]
        print(f"   {badge} {str(win):<12} {win.duration_min:>3} min   {level}")
        print(f"     {why}")
        print()

    # capienza: tre zone che chiedono acqua nella stessa notte
    print(f"{'-' * 68}")
    print("   Capienza con 3 zone attive\n")

    window = TimeWindow.from_strings("04:00", "08:00")
    demo_plans = [
        ("z1", "Prato Sud", RunPlan(True, "ok", total_minutes=133.0, cycles=2,
                                   minutes_per_cycle=66.5, soak_minutes=30)),
        ("z2", "Prato Nord", RunPlan(True, "ok", total_minutes=95.0, cycles=2,
                                     minutes_per_cycle=47.5, soak_minutes=30)),
        ("z3", "Aiuola Est", RunPlan(True, "ok", total_minutes=40.0, cycles=1,
                                     minutes_per_cycle=40.0, soak_minutes=0)),
    ]

    for allow in (True, False):
        sched = schedule_sequence(demo_plans, window, allow_overflow=allow)
        mode = "sfora" if allow else "tronca"
        print(f"   Modalità '{mode}':")
        for run in sched.runs:
            print(
                f"     {run.start_hhmm}–{run.end_hhmm}  {run.zone_name:<12}"
                f" {run.plan.wall_clock_minutes:>5.0f} min"
            )
        print(
            f"     totale {sched.total_minutes:.0f} min su "
            f"{window.duration_min} disponibili "
            f"({sched.utilization * 100:.0f}%)"
        )
        if not sched.fits:
            print(f"     ⚠ sfora di {sched.overflow_minutes:.0f} min")
        if sched.dropped:
            print(f"     ⚠ escluse: {', '.join(sched.dropped)}")
        print()
