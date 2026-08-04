"""Persistenza delle zone e delle impostazioni di sistema.

Le zone si creano a runtime dal pannello, quindi non vivono nella config
entry ma in `.storage` (vedi SPEC.md §3). I salvataggi sono debounced:
il deficit si aggiorna spesso e la SD di un Raspberry Pi non va martellata.
"""

from __future__ import annotations

from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import (
    CATEGORY_ORDER,
    STORAGE_KEY,
    STORAGE_SAVE_DELAY,
    STORAGE_VERSION,
)

try:  # disponibile nelle versioni recenti di Home Assistant
    from homeassistant.util.ulid import ulid_now
except ImportError:  # pragma: no cover - fallback difensivo
    from uuid import uuid4

    def ulid_now() -> str:
        """Fallback: identificativo opaco quando l'helper ULID manca."""
        return uuid4().hex.upper()


# Default di sistema, allineati a SPEC.md §3.
DEFAULT_SYSTEM: dict[str, Any] = {
    "soil": "franco",
    "master_enabled": True,
    # Chi decide quando esce l'acqua.
    #
    #   "automatico"  — il bilancio idrico: si irriga quando il terreno è
    #                   sceso sotto soglia, per il tempo che serve a
    #                   rimetterlo a posto
    #   "programmato" — l'utente, col Gantt: orari e durate fissi, e il
    #                   bilancio resta a fare da termometro senza decidere
    "mode": "automatico",
    # Anche col programma manuale il meteo può fermare l'acqua: piove, ha
    # appena piovuto, o sta per gelare. Si può spegnere, ma spegnerlo
    # significa irrigare sotto la pioggia.
    "program_guards": True,
    "window_start": "04:00",
    "window_end": "08:00",
    "overflow_policy": "truncate",
    "gap_minutes": 5,
    "max_runtime_min": None,
    "wind_max_kmh": 18.0,
    "rain_forecast_max_mm": 8.0,
    "soak_minutes": 30,
    "excluded_days": [],
    "sequential": True,
    "max_concurrent": 1,
    # Flussostato: informativo, non blocca mai l'irrigazione
    "flow_entity": None,
    "valve_timeout_s": 30,
    # tentativi in più dopo il primo, prima di saltare la linea
    "valve_retries": 2,
    # Segnaposto di irrigazione in corso, per ritrovarla dopo un riavvio.
    # Vuoto quando non sta irrigando; altrimenti dice quando è partita, su
    # quale gruppo, e quale valvola risulta aperta in questo momento.
    "active_run": None,
    # Master di notifiche e azioni: spenti, non parte nulla anche se le
    # singole voci sono abilitate.
    "notifications_enabled": True,
    "actions_enabled": True,
}

# Una notifica è una chiamata di servizio: non è cablata su `notify`, così
# si può richiamare anche uno script proprio.
NOTIFICATION_FIELDS: dict[str, Any] = {
    "name": "Nuova notifica",
    "enabled": True,
    "service": "",
    "title": "Irrigazione",
    "message": "Irrigazione conclusa: {completate} linee in {durata} min",
    # quando inviarla
    "trigger": "after_irrigation",
}

# Un'azione è una chiamata di servizio agganciata a un momento preciso.
ACTION_FIELDS: dict[str, Any] = {
    "name": "Nuova azione",
    "enabled": True,
    "hook": "after_irrigation",
    "service": "",
    "data": "{}",
}

# Impostazioni di ogni gruppo. Prato e aiuole hanno irrigatori diversi e
# quindi anche orari diversi: le aiuole a goccia possono partire col vento
# e più tardi, il prato no.
WEEKDAYS: list[str] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

DEFAULT_GROUP: dict[str, Any] = {
    "enabled": True,
    "window_start": "04:00",
    "window_end": "08:00",
    "days": list(WEEKDAYS),
    # avvio automatico all'inizio della finestra, nei giorni attivi
    "auto": True,
    "last_auto_run": None,
}

# Campi che descrivono *quando* il gruppo deve partire. Toccarne uno
# significa "voglio che parta così": la partenza già consumata oggi non
# deve bloccare il nuovo orario, altrimenti spostare la finestra alle
# 15:07 non fa più nulla fino a domani.
GROUP_SCHEDULE_FIELDS: tuple[str, ...] = ("window_start", "window_end", "days", "auto")

# Campi accettati su una zona, con il valore usato quando non arrivano.
# Le sentinelle -1 / "eredita" significano "eredita dal livello superiore".
ZONE_FIELDS: dict[str, Any] = {
    "name": "Nuova zona",
    "valve_entity": None,
    # Batteria della valvola, per gli irrigatori che non sono a filo.
    # Una batteria scarica non blocca niente: fa però fallire l'apertura
    # nel cuore della notte, e chi guarda la pagina deve poterlo prevedere
    # invece di scoprirlo dal prato secco.
    "battery_entity": None,
    "enabled": True,
    "zone_type": "prato_microterme",
    "order": 0,
    # icona mostrata in pagina; vuota = si usa quella del tipo di zona
    "icon": None,
    # override ereditabili
    "soil": "eredita",
    "kc": -1,
    "root_depth_cm": -1,
    "mad": -1,
    "efficiency": -1,
    "max_runtime_min": -1,
    # sempre espliciti: descrivono l'impianto
    "rate_mm_h": 10.0,
    # Geometria della linea: quanti irrigatori e a che distanza fra loro.
    # Sono le due cose che si misurano davvero in giardino — una fettuccia
    # fra due testine — e da lì esce la superficie bagnata, che nessuno ha
    # voglia di misurare a mano su un prato a elle.
    "sprinklers": None,
    "spacing_m": None,
    # "quadrata" o "triangolare": cambia l'area servita del 13%
    "layout": "quadrata",
    "area_m2": None,
    # Contatore o flussostato che vede questa linea. Vuoto = quello di
    # sistema: la maggior parte degli impianti ne ha uno solo, a monte.
    "flow_entity": None,
    # Da dove viene il numero in mm/h: metodo, data e misure grezze. Serve
    # a sapere di chi fidarsi fra sei mesi.
    "rate_source": None,
    "emitter": "statici",
    "corrector": 1.0,
    "excluded_days": [],
}

# Stato runtime: non modificabile direttamente dal form di modifica.
ZONE_RUNTIME: dict[str, Any] = {
    "deficit_mm": 0.0,
    "last_irrigation": None,
    "last_duration_min": None,
    # "automatica" o "forzata": le forzature si segnalano ma contano meno
    "last_trigger": None,
}

# Accumulatori della giornata in corso. Persistiti perché un riavvio a
# metà pomeriggio non deve far perdere la massima già registrata.
DEFAULT_DAILY: dict[str, Any] = {
    "date": None,
    "t_min": None,
    "t_max": None,
    "rain_mm": 0.0,
    "rh_sum": 0.0,
    "rh_n": 0,
    "wind_sum": 0.0,
    "wind_n": 0,
    "irr_sum": 0.0,
    "irr_n": 0,
    # Quanto della giornata è già stato scaricato sul deficit. Il bilancio
    # si aggiorna a ogni ciclo, non solo a mezzanotte: questi contatori
    # dicono fin dove si è arrivati, così la chiusura del giorno addebita
    # il residuo invece di ricontare tutto da capo.
    "et0_charged_mm": 0.0,
    "rain_charged_mm": 0.0,
    "et0_today_method": None,
    # minuti irrigati oggi, per gruppo
    "irrigated": {},
    # esito dell'ultimo giorno chiuso
    "last_et0_mm": None,
    "last_et0_method": None,
    "last_closed_date": None,
    "last_update": None,
}

# Giorni di storico conservati per i grafici. Tre mesi bastano a leggere
# una stagione senza far crescere il file all'infinito.
HISTORY_DAYS: int = 90

# ------------------------------------------------------------- programma
#
# L'irrigazione decisa a mano: una barra per ogni accensione, con la linea
# che apre, il minuto in cui parte e quanto dura. Due barre che si
# sovrappongono sono due linee aperte insieme — è la ragione per cui il
# programma si disegna invece di scriverlo: la sovrapposizione si vede.
#
# I giorni valgono per tutto il programma: uno schema solo, ripetuto nei
# giorni scelti, è quello che si riesce a tenere in testa. Sette schemi
# diversi si disallineano al primo cambio di stagione.

DEFAULT_PROGRAM: dict[str, Any] = {
    "days": ["mon", "wed", "fri", "sun"],
    "bars": [],
}

# Una barra del Gantt.
PROGRAM_BAR_FIELDS: dict[str, Any] = {
    "zone_id": None,
    # minuti dalla mezzanotte: 04:30 = 270
    "start_min": 240,
    "minutes": 15,
}

# ---------------------------------------------------------------- mappa
#
# La planimetria del giardino con le aree disegnate sopra. Il file non
# vive qui: sta in `.storage/irrigazione_smart/`, e qui se ne conserva
# solo il nome. In alternativa si può puntare un indirizzo qualunque
# (tipico: un file in `www/`, servito come `/local/...`), per chi il file
# ce l'ha già dove vuole lui.

DEFAULT_MAP: dict[str, Any] = {
    "image_id": None,
    "image_ext": None,
    "image_url": None,
    "image_name": None,
    # trasparenza del riempimento delle aree: la planimetria sotto deve
    # restare leggibile
    "fill_opacity": 0.35,
    "areas": {},
    # Card Lovelace mostrate accanto alla mappa. Si conservano come
    # configurazioni grezze e non si interpretano: le disegna il
    # frontend di Home Assistant con le sue, quindi qualunque card —
    # meteo, markdown, o una installata da HACS — funziona senza che
    # questa integration ne sappia niente.
    "cards": [],
}

# Un'area è un poligono sopra l'immagine, di norma legato a una linea.
#
# I vertici sono in coordinate **normalizzate 0..1** sui lati
# dell'immagine, non in pixel: la stessa mappa deve reggere lo schermo
# del telefono e quello del desktop, e una planimetria sostituita con una
# a risoluzione diversa non deve buttare via il disegno.
AREA_FIELDS: dict[str, Any] = {
    # Vuoto di proposito: senza un nome proprio l'area prende quello
    # della linea collegata, che è quasi sempre come la si chiama davvero.
    "name": "",
    # linea irrigata da quest'area: da qui arrivano stato e comando
    "zone_id": None,
    "points": [],
    # Colore identificativo del bordo. Il *riempimento* non si configura:
    # dice il bilancio idrico, ed è tutto il punto della mappa.
    "color": None,
    "icon": None,
    "icon_color": None,
    # entità mostrata dall'icona, per chi vuole vederci altro (un sensore
    # di umidità del terreno, la valvola stessa)
    "icon_entity": None,
    # posizione dell'icona; vuota = baricentro del poligono
    "icon_x": None,
    "icon_y": None,
    "show_icon": True,
    "show_label": True,
    "order": 0,
}


def clean_points(raw: Any) -> list[list[float]]:
    """Vertici validi e dentro l'immagine, scartando il resto.

    Arriva dal pannello, che è amministratore, ma un disegno storto o un
    payload monco non devono poter rompere il rendering della pagina.
    """
    points: list[list[float]] = []
    for point in raw or []:
        try:
            x, y = float(point[0]), float(point[1])
        except (TypeError, ValueError, IndexError, KeyError):
            continue
        points.append(
            [round(max(0.0, min(1.0, x)), 5), round(max(0.0, min(1.0, y)), 5)]
        )
    return points


# Posa degli irrigatori: quanta superficie serve una testina, in rapporto
# al quadrato dell'interasse. Con la posa a triangolo le testine sono
# sfalsate e ognuna copre meno.
LAYOUT_FACTOR: dict[str, float] = {"quadrata": 1.0, "triangolare": 0.866}


def zone_area_m2(zone: dict[str, Any]) -> float | None:
    """Superficie bagnata dalla linea, dalla sua geometria.

    Gli irrigatori si posano testa a testa — il getto di ognuno arriva
    sulla testina vicina — quindi il raggio bagnato coincide con
    l'interasse, e l'area servita da una testina è l'interasse al
    quadrato. È un'approssimazione, ma è l'approssimazione che usano i
    progettisti, e sbaglia molto meno di un'area stimata a occhio.
    """
    try:
        n = float(zone.get("sprinklers") or 0)
        passo = float(zone.get("spacing_m") or 0)
    except (TypeError, ValueError):
        return None
    if n <= 0 or passo <= 0:
        return None
    fattore = LAYOUT_FACTOR.get(zone.get("layout") or "quadrata", 1.0)
    return round(n * passo * passo * fattore, 1)


def rate_from_flow(litres_per_hour: float, area_m2: float) -> float:
    """mm/h da litri all'ora e superficie.

    Un litro steso su un metro quadro è alto un millimetro: tutta la
    conversione sta qui.
    """
    if litres_per_hour <= 0 or area_m2 <= 0:
        return 0.0
    return round(litres_per_hour / area_m2, 2)


def resolve_rate_mm_h(zone: dict[str, Any]) -> float:
    """Portata della linea in mm/h — l'unico numero che usa il motore."""
    return float(zone.get("rate_mm_h") or 0.0)


def migrate_zone_rate(zone: dict[str, Any]) -> dict[str, Any]:
    """Porta le vecchie zone al campo unico.

    Fino alla 1.9 la portata poteva essere in litri, con un'unità di
    misura e una superficie da tenere allineate a mano: tre campi che
    dovevano essere coerenti fra loro, e se non lo erano i litri venivano
    ignorati in silenzio. Adesso il numero è uno solo, quindi la
    conversione si fa una volta qui e i campi vecchi spariscono.
    """
    mode = zone.pop("rate_mode", None)
    flow = zone.pop("flow_value", None)
    if mode in (None, "mm_h"):
        return zone

    try:
        litri = float(flow)
        area = float(zone.get("area_m2"))
    except (TypeError, ValueError):
        return zone

    if litri <= 0 or area <= 0:
        return zone

    l_h = litri * 60.0 if mode == "l_min" else litri
    zone["rate_mm_h"] = rate_from_flow(l_h, area)
    zone["rate_source"] = {
        "metodo": "litri_convertiti",
        "l_h": round(l_h, 1),
        "area_m2": area,
    }
    return zone


class IrrigazioneStore:
    """Wrapper sullo Store di Home Assistant con i default del dominio."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._data: dict[str, Any] = {
            "system": {},
            "zones": {},
            "daily": {},
            "notifications": {},
            "actions": {},
        }

    async def async_load(self) -> dict[str, Any]:
        """Carica da disco, completando i campi mancanti coi default."""
        stored = await self._store.async_load()
        if stored:
            self._data = {
                "system": {**DEFAULT_SYSTEM, **(stored.get("system") or {})},
                "zones": stored.get("zones") or {},
                "daily": {**DEFAULT_DAILY, **(stored.get("daily") or {})},
                "notifications": stored.get("notifications") or {},
                "actions": stored.get("actions") or {},
                "groups": stored.get("groups") or {},
                "history": stored.get("history") or [],
                "map": {**DEFAULT_MAP, **(stored.get("map") or {})},
                "calibration": stored.get("calibration") or [],
                "program": {**DEFAULT_PROGRAM, **(stored.get("program") or {})},
            }
        else:
            self._data = {
                "system": dict(DEFAULT_SYSTEM),
                "zones": {},
                "daily": dict(DEFAULT_DAILY),
                "notifications": {},
                "actions": {},
                "groups": {},
                "history": [],
                "map": dict(DEFAULT_MAP),
                "calibration": [],
                "program": dict(DEFAULT_PROGRAM),
            }

        self._ensure_groups()
        self._migrate_zones()
        return self._data

    def _migrate_zones(self) -> None:
        """Allinea le zone salvate al modello corrente."""
        cambiate = False
        for zone_id, zone in list(self._data["zones"].items()):
            prima = dict(zone)
            aggiornata = migrate_zone_rate({**ZONE_FIELDS, **ZONE_RUNTIME, **zone})
            if aggiornata != prima:
                self._data["zones"][zone_id] = aggiornata
                cambiate = True
        if cambiate:
            self._save()

    def _ensure_groups(self) -> None:
        """Crea i gruppi mancanti, ereditando la finestra di sistema.

        Chi aggiorna da una versione precedente aveva un'unica finestra:
        la si copia su tutti i gruppi, così l'impianto continua a
        comportarsi come prima finché non si differenzia.
        """
        system = self._data["system"]
        for key in CATEGORY_ORDER:
            group = self._data["groups"].get(key) or {}
            start = system.get("window_start", DEFAULT_GROUP["window_start"])
            end = system.get("window_end", DEFAULT_GROUP["window_end"])
            self._data["groups"][key] = {
                **DEFAULT_GROUP,
                "window_start": start,
                "window_end": end,
                **group,
            }

    @property
    def data(self) -> dict[str, Any]:
        return self._data

    @property
    def system(self) -> dict[str, Any]:
        return self._data["system"]

    @property
    def zones(self) -> dict[str, Any]:
        return self._data["zones"]

    @property
    def daily(self) -> dict[str, Any]:
        return self._data["daily"]

    @property
    def history(self) -> list[dict[str, Any]]:
        """Storico giornaliero, dal più vecchio al più recente."""
        return self._data["history"]

    def async_append_history(self, record: dict[str, Any]) -> None:
        """Aggiunge il riepilogo di un giorno chiuso.

        Se il giorno c'è già lo sostituisce: un riavvio non deve creare
        doppioni nei grafici.
        """
        history = self._data["history"]
        history[:] = [r for r in history if r.get("date") != record.get("date")]
        history.append(record)
        history.sort(key=lambda r: r.get("date") or "")
        del history[:-HISTORY_DAYS]
        self._save()

    def async_add_irrigation(self, category: str, minutes: float) -> None:
        """Somma i minuti irrigati oggi da un gruppo, per i grafici."""
        irrigated = self._data["daily"].setdefault("irrigated", {})
        irrigated[category] = round(irrigated.get(category, 0.0) + minutes, 1)
        self._save()

    def async_save_daily(self, daily: dict[str, Any]) -> None:
        """Sostituisce gli accumulatori giornalieri e persiste."""
        self._data["daily"] = daily
        self._save()

    @property
    def program(self) -> dict[str, Any]:
        """Il programma manuale, con le sue barre ordinate per orario."""
        stored = {**DEFAULT_PROGRAM, **(self._data.get("program") or {})}
        stored["bars"] = sorted(
            stored.get("bars") or [], key=lambda b: (b.get("start_min") or 0)
        )
        return stored

    def async_save_program(self, program: dict[str, Any]) -> None:
        """Sostituisce il programma, ripulendo le barre non valide.

        Una barra senza linea, o lunga zero, non è un dato da conservare:
        è il residuo di un trascinamento andato storto, e lasciarla lì
        vorrebbe dire vederla riapparire nel Gantt a ogni ricarica.
        """
        barre = []
        for barra in program.get("bars") or []:
            zone_id = barra.get("zone_id")
            if zone_id not in self._data["zones"]:
                continue
            try:
                inizio = int(barra.get("start_min"))
                durata = int(barra.get("minutes"))
            except (TypeError, ValueError):
                continue
            if durata <= 0:
                continue
            barre.append(
                {
                    "id": barra.get("id") or ulid_now(),
                    "zone_id": zone_id,
                    # il giorno finisce a mezzanotte: una barra che
                    # sforerebbe viene tagliata lì, non spezzata sul
                    # giorno dopo — l'irrigazione notturna si programma
                    # dopo la mezzanotte, non a cavallo
                    "start_min": max(0, min(inizio, 24 * 60 - 1)),
                    "minutes": min(durata, 24 * 60 - max(0, inizio)),
                }
            )

        giorni = [d for d in (program.get("days") or []) if d in WEEKDAYS]
        self._data["program"] = {"days": giorni, "bars": barre}
        self._save()

    @property
    def calibration(self) -> list[dict[str, Any]]:
        """Esito dell'ultima taratura, linea per linea."""
        return self._data.get("calibration") or []

    def async_save_calibration(self, risultati: list[dict[str, Any]]) -> None:
        """Conserva l'ultima taratura.

        Sopravvive alla chiusura della pagina: la misura costa minuti di
        acqua e attesa, e ritrovarsela persa perché si è cambiato scheda
        sarebbe il modo più veloce per non farla più.
        """
        self._data["calibration"] = risultati
        self._save()

    def async_set_runtime(self, zone_id: str, **fields: Any) -> None:
        """Scrive lo stato runtime di una zona (ultima irrigazione, durata).

        Separato da `async_update_zone`, che accetta solo i campi del form:
        senza questo metodo i campi runtime verrebbero scartati.
        """
        zone = self._data["zones"].get(zone_id)
        if zone is None:
            return
        for key, value in fields.items():
            if key in ZONE_RUNTIME:
                zone[key] = value
        self._save()

    def async_set_deficit(self, zone_id: str, deficit_mm: float) -> None:
        """Scrive il deficit calcolato dal coordinator.

        È lo stato più prezioso del sistema: ogni aggiornamento va persistito.
        """
        zone = self._data["zones"].get(zone_id)
        if zone is not None:
            zone["deficit_mm"] = max(0.0, round(float(deficit_mm), 2))
            self._save()

    def _save(self) -> None:
        """Salvataggio ritardato: raggruppa le scritture ravvicinate."""
        self._store.async_delay_save(lambda: self._data, STORAGE_SAVE_DELAY)

    def zones_sorted(self) -> list[dict[str, Any]]:
        """Zone in ordine di sequenza, poi per nome."""
        return sorted(
            self._data["zones"].values(),
            key=lambda z: (z.get("order", 0), z.get("name", "")),
        )

    def async_create_zone(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Crea una zona, ignorando i campi non previsti dallo schema."""
        zone_id = ulid_now()
        zone: dict[str, Any] = {"id": zone_id}

        for key, default in ZONE_FIELDS.items():
            zone[key] = payload.get(key, default)
        zone.update(ZONE_RUNTIME)

        if not zone.get("order"):
            zone["order"] = len(self._data["zones"]) + 1

        # il motore riceve sempre mm/h, qualunque unità sia stata inserita
        zone["rate_mm_h"] = resolve_rate_mm_h(zone)

        self._data["zones"][zone_id] = zone
        self._save()
        return zone

    def async_update_zone(
        self, zone_id: str, payload: dict[str, Any]
    ) -> dict[str, Any] | None:
        """Aggiorna i campi noti di una zona. `None` se non esiste."""
        zone = self._data["zones"].get(zone_id)
        if zone is None:
            return None

        for key in ZONE_FIELDS:
            if key in payload:
                zone[key] = payload[key]

        # Il deficit è modificabile a parte: serve per azzerarlo a mano
        # dopo un'irrigazione manuale o una taratura.
        if "deficit_mm" in payload:
            zone["deficit_mm"] = max(0.0, float(payload["deficit_mm"]))

        zone["rate_mm_h"] = resolve_rate_mm_h(zone)

        self._save()
        return zone

    def async_reorder_zones(self, ordered_ids: list[str]) -> bool:
        """Riscrive la sequenza secondo l'ordine ricevuto.

        Gli id sconosciuti si ignorano e quelli mancanti restano in coda:
        un riordino non deve mai far sparire una linea.
        """
        zones = self._data["zones"]
        seen = [zid for zid in ordered_ids if zid in zones]
        if not seen:
            return False

        rest = [z["id"] for z in self.zones_sorted() if z["id"] not in seen]
        for position, zone_id in enumerate(seen + rest, start=1):
            zones[zone_id]["order"] = position

        self._save()
        return True

    def async_move_zone(self, zone_id: str, direction: int) -> bool:
        """Sposta una linea su (-1) o giù (+1) nella sequenza.

        L'ordine conta: le linee vengono irrigate in questa successione, e
        chi ha poca finestra vuole le zone importanti per prime.
        """
        ordered = self.zones_sorted()
        index = next(
            (i for i, z in enumerate(ordered) if z["id"] == zone_id), None
        )
        if index is None:
            return False

        target = index + direction
        if not 0 <= target < len(ordered):
            return False

        ordered[index], ordered[target] = ordered[target], ordered[index]
        # si rinumera l'intera sequenza: evita buchi e valori duplicati
        for position, zone in enumerate(ordered, start=1):
            zone["order"] = position

        self._save()
        return True

    def async_delete_zone(self, zone_id: str) -> bool:
        """Rimuove una zona. False se l'id non esiste."""
        if zone_id not in self._data["zones"]:
            return False
        del self._data["zones"][zone_id]
        self._save()
        return True

    # ------------------------------------------------ notifiche e azioni

    @property
    def groups(self) -> dict[str, Any]:
        return self._data["groups"]

    def group(self, category: str) -> dict[str, Any]:
        """Impostazioni di un gruppo, coi default se non configurato."""
        return self._data["groups"].get(category) or dict(DEFAULT_GROUP)

    def async_update_group(
        self, category: str, payload: dict[str, Any]
    ) -> dict[str, Any] | None:
        group = self._data["groups"].get(category)
        if group is None:
            return None

        rescheduled = any(
            key in payload and payload[key] != group.get(key)
            for key in GROUP_SCHEDULE_FIELDS
        )

        for key in DEFAULT_GROUP:
            if key in payload:
                group[key] = payload[key]

        # Il nuovo orario vale da subito, anche se oggi il gruppo era già
        # partito: chi sposta la finestra si aspetta di vederla rispettata
        # oggi, non domani.
        if rescheduled:
            group["last_auto_run"] = None

        self._save()
        return group

    # ---------------------------------------------------------- mappa

    @property
    def map(self) -> dict[str, Any]:
        return self._data["map"]

    @property
    def areas(self) -> dict[str, Any]:
        return self._data["map"]["areas"]

    def areas_sorted(self) -> list[dict[str, Any]]:
        """Aree in ordine di disegno: le prime stanno sotto.

        L'ordine conta perché le aree possono sovrapporsi, e chi disegna
        un'aiuola dentro un prato vuole vedere l'aiuola.
        """
        return sorted(
            self._data["map"]["areas"].values(),
            key=lambda a: (a.get("order", 0), a.get("name", "")),
        )

    def async_update_map(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Aggiorna le impostazioni della mappa (immagine, trasparenza)."""
        current = self._data["map"]
        for key in DEFAULT_MAP:
            if key == "areas" or key not in payload:
                continue
            current[key] = payload[key]

        # Le card non si interpretano, ma devono almeno essere una lista
        # di configurazioni: un valore storto qui farebbe fallire il
        # disegno dell'intera colonna.
        if "cards" in payload:
            current["cards"] = [
                card for card in (payload["cards"] or []) if isinstance(card, dict)
            ]

        # Immagine caricata e indirizzo manuale si escludono: tenerli
        # entrambi renderebbe ambiguo quale delle due si vede.
        if payload.get("image_id"):
            current["image_url"] = None
        elif payload.get("image_url"):
            current["image_id"] = None

        self._save()
        return current

    def async_create_area(self, payload: dict[str, Any]) -> dict[str, Any]:
        areas = self._data["map"]["areas"]
        area_id = ulid_now()
        area: dict[str, Any] = {"id": area_id}
        for key, default in AREA_FIELDS.items():
            area[key] = payload.get(key, default)
        area["points"] = clean_points(area["points"])
        if not area.get("order"):
            area["order"] = len(areas) + 1

        areas[area_id] = area
        self._save()
        return area

    def async_update_area(
        self, area_id: str, payload: dict[str, Any]
    ) -> dict[str, Any] | None:
        area = self._data["map"]["areas"].get(area_id)
        if area is None:
            return None
        for key in AREA_FIELDS:
            if key in payload:
                area[key] = payload[key]
        area["points"] = clean_points(area.get("points"))
        self._save()
        return area

    def async_delete_area(self, area_id: str) -> bool:
        if area_id not in self._data["map"]["areas"]:
            return False
        del self._data["map"]["areas"][area_id]
        self._save()
        return True

    @property
    def notifications(self) -> dict[str, Any]:
        return self._data["notifications"]

    @property
    def actions(self) -> dict[str, Any]:
        return self._data["actions"]

    def _collection(self, kind: str) -> tuple[dict[str, Any], dict[str, Any]]:
        """Ritorna (contenitore, campi ammessi) per notifiche o azioni."""
        if kind == "notifications":
            return self._data["notifications"], NOTIFICATION_FIELDS
        return self._data["actions"], ACTION_FIELDS

    def async_create_item(self, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        items, fields = self._collection(kind)
        item_id = ulid_now()
        item: dict[str, Any] = {"id": item_id}
        for key, default in fields.items():
            item[key] = payload.get(key, default)
        items[item_id] = item
        self._save()
        return item

    def async_update_item(
        self, kind: str, item_id: str, payload: dict[str, Any]
    ) -> dict[str, Any] | None:
        items, fields = self._collection(kind)
        item = items.get(item_id)
        if item is None:
            return None
        for key in fields:
            if key in payload:
                item[key] = payload[key]
        self._save()
        return item

    def async_delete_item(self, kind: str, item_id: str) -> bool:
        items, _fields = self._collection(kind)
        if item_id not in items:
            return False
        del items[item_id]
        self._save()
        return True

    def async_set_active_run(self, run: dict[str, Any] | None) -> None:
        """Segna che un'irrigazione è in corso, o che è finita.

        Si scrive **subito**, non col ritardo degli altri salvataggi: se
        Home Assistant se ne va mentre una valvola è aperta, questo è
        l'unico appiglio per ritrovarla al riavvio, e un salvataggio
        rimandato di dieci secondi è esattamente quello che si perde.
        """
        self._data["system"]["active_run"] = run
        self._store.async_delay_save(lambda: self._data, 0)

    def async_update_system(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Aggiorna le sole chiavi di sistema previste dai default."""
        for key in DEFAULT_SYSTEM:
            if key in payload:
                self._data["system"][key] = payload[key]
        self._save()
        return self._data["system"]
