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

# Campi accettati su una zona, con il valore usato quando non arrivano.
# Le sentinelle -1 / "eredita" significano "eredita dal livello superiore".
ZONE_FIELDS: dict[str, Any] = {
    "name": "Nuova zona",
    "valve_entity": None,
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
    # esito dell'ultimo giorno chiuso
    "last_et0_mm": None,
    "last_et0_method": None,
    "last_closed_date": None,
    "last_update": None,
}


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
            }
        else:
            self._data = {
                "system": dict(DEFAULT_SYSTEM),
                "zones": {},
                "daily": dict(DEFAULT_DAILY),
                "notifications": {},
                "actions": {},
                "groups": {},
            }

        self._ensure_groups()
        return self._data

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

    def async_save_daily(self, daily: dict[str, Any]) -> None:
        """Sostituisce gli accumulatori giornalieri e persiste."""
        self._data["daily"] = daily
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
        for key in DEFAULT_GROUP:
            if key in payload:
                group[key] = payload[key]
        self._save()
        return group

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

    def async_update_system(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Aggiorna le sole chiavi di sistema previste dai default."""
        for key in DEFAULT_SYSTEM:
            if key in payload:
                self._data["system"][key] = payload[key]
        self._save()
        return self._data["system"]
