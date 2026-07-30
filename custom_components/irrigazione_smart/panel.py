"""Pannello laterale e API di supporto per Irrigazione Smart.

Registra una voce nella barra laterale con una pagina propria (un web
component servito da `www/`) e le API REST che il pannello usa per leggere
lo stato e gestire le zone.

I valori agronomici mostrati (TAW, soglia, durate, cicli) non sono
ricalcolati qui: arrivano da `hydro.py`, che resta l'unica fonte di verità.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from aiohttp import web
from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import HomeAssistantView, StaticPathConfig
from homeassistant.const import CONF_LATITUDE, CONF_LONGITUDE
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import Unauthorized
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.storage import STORAGE_DIR
from homeassistant.loader import async_get_integration
from homeassistant.util import dt as dt_util

from .activity_log import get_log
from .const import (
    CATEGORY_ICONS,
    CATEGORY_LABELS,
    CATEGORY_ORDER,
    CONF_ELEVATION,
    CONF_HUMIDITY_ENTITY,
    CONF_IRRADIANCE_ENTITY,
    CONF_RAIN_ENTITY,
    CONF_TEMPERATURE_ENTITY,
    CONF_WEATHER_ENTITY,
    CONF_WIND_ENTITY,
    DOMAIN,
    SIGNAL_STATE_CHANGED,
    SIGNAL_ZONES_CHANGED,
    zone_category,
)
from .executor import get_executor
from .hydro import (
    EMITTER_EFFICIENCY,
    SOIL_PROPS,
    ZONE_PRESETS,
    RunPlan,
    TimeWindow,
    evaluate_zone,
    resolve_zone_params,
    schedule_sequence,
    window_quality,
)
from .notifier import HOOK_LABELS, build_context, get_notifier
from .scheduler import get_scheduler
from .store import (
    WEEKDAYS,
    IrrigazioneStore,
    rate_from_flow,
    ulid_now,
    zone_area_m2,
)

PANEL_URL_PATH = "irrigazione-smart"
PANEL_TITLE = "Irrigazione"
PANEL_ICON = "mdi:sprinkler-variant"
COMPONENT_NAME = "irrigazione-smart-panel"
STATIC_URL = "/irrigazione_smart_frontend"

_HTTP_FLAG = "_http_registered"
_PANEL_FLAG = "_panel_registered"
_STORE = "store"

# Formati accettati per la planimetria, con l'estensione con cui il file
# viene salvato. Si controlla il tipo dichiarato e non l'estensione del
# nome: è l'unica delle due che il browser calcola davvero.
IMAGE_EXTENSIONS: dict[str, str] = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
}
# Una foto aerea di un giardino sta ampiamente sotto: oltre, è quasi
# sempre un file scelto per sbaglio.
MAX_IMAGE_BYTES = 12 * 1024 * 1024


def _get_store(hass: HomeAssistant) -> IrrigazioneStore | None:
    return hass.data.get(DOMAIN, {}).get(_STORE)


def _require_admin(request) -> None:
    """Le modifiche sono riservate agli amministratori."""
    user = request.get("hass_user")
    if user is None or not user.is_admin:
        raise Unauthorized()


def _entry_config(hass: HomeAssistant) -> dict[str, Any] | None:
    entries = hass.config_entries.async_entries(DOMAIN)
    return dict(entries[0].data) if entries else None


def _notify(hass: HomeAssistant, zones_changed: bool = False) -> None:
    """Allinea le entità esposte dopo una modifica fatta dal pannello."""
    if zones_changed:
        async_dispatcher_send(hass, SIGNAL_ZONES_CHANGED)
    async_dispatcher_send(hass, SIGNAL_STATE_CHANGED)


def _remove_zone_device(hass: HomeAssistant, zone_id: str) -> None:
    """Elimina il dispositivo della linea, e con esso le sue entità."""
    entries = hass.config_entries.async_entries(DOMAIN)
    if not entries:
        return
    registry = dr.async_get(hass)
    device = registry.async_get_device(
        identifiers={(DOMAIN, f"{entries[0].entry_id}_{zone_id}")}
    )
    if device is not None:
        registry.async_remove_device(device.id)


def _zone_computed(zone: dict[str, Any], params, plan: RunPlan) -> dict[str, Any]:
    """Valori derivati di una zona, già calcolati con il motore idrico."""
    deficit = float(zone.get("deficit_mm") or 0.0)

    return {
        "taw_mm": round(params.taw_mm, 1),
        "trigger_threshold_mm": round(params.trigger_threshold_mm, 1),
        "kc": params.kc,
        "root_depth_cm": params.root_depth_cm,
        "mad": params.mad,
        "soil": params.soil,
        "infiltration_mm_h": params.infiltration_mm_h,
        "efficiency": params.efficiency,
        "max_runtime_min": params.max_runtime_min,
        "needs_water": deficit >= params.trigger_threshold_mm,
        "plan": {
            "should_run": plan.should_run,
            "reason": plan.reason,
            "total_minutes": plan.total_minutes,
            "cycles": plan.cycles,
            "minutes_per_cycle": plan.minutes_per_cycle,
            "soak_minutes": plan.soak_minutes,
            "capped": plan.capped,
            "gross_mm": plan.gross_mm,
        },
    }


def _build_overview(hass: HomeAssistant) -> dict[str, Any]:
    """Payload completo per il pannello."""
    config = _entry_config(hass)
    store = _get_store(hass)

    if config is None or store is None:
        return {"configured": False, "system": None, "zones": [], "options": {}}

    coordinator = hass.data.get(DOMAIN, {}).get("coordinator")
    cdata = (coordinator.data if coordinator else None) or {}
    wind_kmh = float(cdata.get("wind_kmh") or 0.0)
    rain_forecast_mm = float(cdata.get("rain_forecast_mm") or 0.0)
    executor = get_executor(hass)

    system = store.system
    window = TimeWindow.from_strings(
        system.get("window_start", "04:00"), system.get("window_end", "08:00")
    )
    level, why = window_quality(window)

    # Un solo passaggio sul motore: gli stessi piani servono sia alle righe
    # delle zone sia alla sequenza della notte.
    # giorno della settimana corrente, per dire il vero sui gruppi che oggi
    # non irrigano
    today_key = WEEKDAYS[dt_util.now().weekday()]

    zones: list[dict[str, Any]] = []
    plans: list[tuple[str, str, RunPlan]] = []
    for zone in store.zones_sorted():
        category = zone_category(zone.get("zone_type"))
        group = store.group(category)
        params = resolve_zone_params(zone, system)
        plan = evaluate_zone(
            zone,
            system,
            float(zone.get("deficit_mm") or 0.0),
            wind_kmh=wind_kmh,
            rain_forecast_mm=rain_forecast_mm,
            day_excluded=(
                not group.get("enabled", True)
                or today_key not in (group.get("days") or [])
            ),
        )
        zones.append(
            {
                **zone,
                "category": category,
                "computed": _zone_computed(zone, params, plan),
            }
        )
        plans.append((zone["id"], zone.get("name", ""), plan))

    return {
        "configured": True,
        # mostrata in pagina: permette di verificare a colpo d'occhio se
        # l'aggiornamento è davvero arrivato al browser
        "version": hass.data.get(DOMAIN, {}).get("panel_version", "?"),
        "system": {
            "latitude": config.get(CONF_LATITUDE),
            "longitude": config.get(CONF_LONGITUDE),
            "elevation": config.get(CONF_ELEVATION),
            "weather_entity": config.get(CONF_WEATHER_ENTITY),
            "sensors": {
                "temperature": config.get(CONF_TEMPERATURE_ENTITY),
                "humidity": config.get(CONF_HUMIDITY_ENTITY),
                "wind_speed": config.get(CONF_WIND_ENTITY),
                "precipitation": config.get(CONF_RAIN_ENTITY),
                "irradiance": config.get(CONF_IRRADIANCE_ENTITY),
            },
            **system,
            "window": {
                "label": str(window),
                "duration_min": window.duration_min,
                "quality": level,
                "quality_reason": why,
            },
        },
        "zones": zones,
        "groups": _groups_payload(hass, store, plans),
        "map": _map_payload(store),
        # esito dell'ultima taratura, per riproporlo alla riapertura
        "calibration": store.calibration,
        "running": executor.status() if executor else {"active": False},
        "flow": _flow_payload(hass, system),
        "schedule": _schedule_payload(plans, window, system),
        "meteo": _meteo_payload(cdata, store),
        "notifications": sorted(
            store.notifications.values(), key=lambda i: i.get("name", "")
        ),
        "actions": sorted(store.actions.values(), key=lambda i: i.get("name", "")),
        "options": {
            "zone_types": sorted(ZONE_PRESETS),
            "soils": sorted(SOIL_PROPS),
            "emitters": sorted(EMITTER_EFFICIENCY),
            "hooks": list(HOOK_LABELS),
            "hook_labels": HOOK_LABELS,
            "categories": CATEGORY_ORDER,
            "category_labels": CATEGORY_LABELS,
            "category_icons": CATEGORY_ICONS,
        },
    }


def _groups_payload(
    hass: HomeAssistant,
    store: IrrigazioneStore,
    plans: list[tuple[str, str, RunPlan]],
) -> dict[str, Any]:
    """Impostazioni, finestra e programma di ciascun gruppo."""
    scheduler = get_scheduler(hass)
    by_zone = {zone_id: plan for zone_id, _name, plan in plans}
    out: dict[str, Any] = {}

    for category in CATEGORY_ORDER:
        group = store.group(category)
        window = TimeWindow.from_strings(
            group.get("window_start", "04:00"), group.get("window_end", "08:00")
        )
        level, why = window_quality(window)

        zone_plans = [
            (zone["id"], zone.get("name", ""), by_zone[zone["id"]])
            for zone in store.zones_sorted()
            if zone_category(zone.get("zone_type")) == category
            and zone["id"] in by_zone
        ]

        out[category] = {
            **group,
            "window": {
                "label": str(window),
                "duration_min": window.duration_min,
                "quality": level,
                "quality_reason": why,
            },
            "next_run": scheduler.next_run(category) if scheduler else {},
            "schedule": _schedule_payload(zone_plans, window, store.system),
        }

    return out


def _map_image_path(hass: HomeAssistant, image_id: str, extension: str) -> Path:
    """Percorso su disco della planimetria caricata."""
    return Path(hass.config.path(STORAGE_DIR, DOMAIN, f"{image_id}{extension}"))


def _map_payload(store: IrrigazioneStore) -> dict[str, Any]:
    """Planimetria e aree disegnate sopra.

    L'indirizzo dell'immagine si risolve qui e non nel pannello: la
    pagina deve limitarsi a mostrarlo, senza sapere se dietro c'è un file
    caricato o un percorso scritto a mano.
    """
    settings = store.map
    image_id = settings.get("image_id")

    if image_id:
        # l'identificativo nell'indirizzo cambia a ogni caricamento: è
        # ciò che costringe il browser a rileggere la nuova planimetria
        image_src = f"/api/irrigazione_smart/map/image/{image_id}"
    else:
        image_src = settings.get("image_url") or None

    return {
        **{k: v for k, v in settings.items() if k != "areas"},
        "image_src": image_src,
        "areas": store.areas_sorted(),
    }


def _flow_payload(hass: HomeAssistant, system: dict[str, Any]) -> dict[str, Any]:
    """Lettura del flussostato. Di sola lettura: non blocca l'irrigazione."""
    entity_id = system.get("flow_entity")
    if not entity_id:
        return {"configured": False}

    state = hass.states.get(entity_id)
    if state is None or state.state in ("unknown", "unavailable"):
        return {"configured": True, "entity_id": entity_id, "available": False}

    return {
        "configured": True,
        "entity_id": entity_id,
        "available": True,
        "value": state.state,
        "unit": state.attributes.get("unit_of_measurement", ""),
        "name": state.attributes.get("friendly_name", entity_id),
    }


def _hhmm(minute: float) -> str:
    """Minuti dalla mezzanotte in 'HH:MM', anche oltre le 24."""
    m = round(minute) % (24 * 60)
    return f"{m // 60:02d}:{m % 60:02d}"


def _schedule_payload(
    plans: list[tuple[str, str, RunPlan]],
    window: TimeWindow,
    system: dict[str, Any],
) -> dict[str, Any]:
    """Sequenza della notte con la diagnosi di capienza della finestra."""
    # Il programma mostrato deve dire cosa succederà davvero. La finestra
    # stabilisce quando l'irrigazione può *cominciare*; una volta partita
    # l'esecutore la porta a termine, e non scarta nulla. Calcolare qui
    # con l'esclusione delle linee eccedenti faceva sparire dal programma
    # una linea che poi veniva comunque irrigata: si mostra tutto e, se
    # sfora, lo si segnala.
    sched = schedule_sequence(
        plans,
        window,
        gap_minutes=int(system.get("gap_minutes", 5) or 0),
        allow_overflow=True,
    )

    return {
        "runs": [
            {
                "zone_id": run.zone_id,
                "zone_name": run.zone_name,
                "start": run.start_hhmm,
                "end": run.end_hhmm,
                # minuti di valvola aperta, non di occupazione: con le
                # passate alternate le linee si intrecciano, e la somma
                # delle occupazioni non vorrebbe dire più niente
                "minutes": round(run.plan.total_minutes, 1),
                "cycles": run.plan.cycles,
            }
            for run in sched.runs
        ],
        # la successione vera, passata per passata
        "cycles": [
            {
                "zone_id": c.zone_id,
                "zone_name": c.zone_name,
                "cycle": c.cycle,
                "cycles": c.cycles,
                "start": _hhmm(c.start_min),
                "end": _hhmm(c.end_min),
            }
            for c in sched.cycles
        ],
        "total_minutes": sched.total_minutes,
        "window_minutes": window.duration_min,
        "utilization": round(sched.utilization * 100, 0),
        "fits": sched.fits,
        "overflow_minutes": sched.overflow_minutes,
        "dropped": sched.dropped,
    }


def _meteo_payload(cdata: dict[str, Any], store: IrrigazioneStore) -> dict[str, Any]:
    """Stato del bilancio: accumulo della giornata e ultimo ET0 calcolato."""
    daily = cdata.get("daily") or store.daily or {}
    live = cdata.get("live") or {}
    rh_mean = daily["rh_sum"] / daily["rh_n"] if daily.get("rh_n") else None
    wind_mean = daily["wind_sum"] / daily["wind_n"] if daily.get("wind_n") else None

    return {
        "date": daily.get("date"),
        "t_min": daily.get("t_min"),
        "t_max": daily.get("t_max"),
        "rain_mm": daily.get("rain_mm"),
        "rh_mean": round(rh_mean, 1) if rh_mean is not None else None,
        "wind_mean_kmh": round(wind_mean * 3.6, 1) if wind_mean is not None else None,
        "last_et0_mm": daily.get("last_et0_mm"),
        "last_et0_method": daily.get("last_et0_method"),
        # ET0 già maturata oggi: è ciò che sta muovendo i deficit adesso
        "et0_today_mm": round(float(daily.get("et0_charged_mm") or 0.0), 2),
        "et0_today_method": daily.get("et0_today_method"),
        "last_closed_date": daily.get("last_closed_date"),
        "last_update": daily.get("last_update"),
        "sources": live.get("sources") or {},
        "forecast": cdata.get("forecast") or {"available": False},
    }


class OverviewView(HomeAssistantView):
    """Stato completo: sistema, zone e valori calcolati."""

    url = "/api/irrigazione_smart/overview"
    name = "api:irrigazione_smart:overview"
    requires_auth = True

    async def get(self, request):
        hass: HomeAssistant = request.app["hass"]
        return self.json(_build_overview(hass))


class ZonesView(HomeAssistantView):
    """Creazione di una zona."""

    url = "/api/irrigazione_smart/zones"
    name = "api:irrigazione_smart:zones"
    requires_auth = True

    async def post(self, request):
        _require_admin(request)
        hass: HomeAssistant = request.app["hass"]
        store = _get_store(hass)
        if store is None:
            return self.json_message("Integration non configurata", 400)

        payload = await request.json()
        zone = store.async_create_zone(payload)
        _notify(hass, zones_changed=True)
        return self.json({"zone": zone, "overview": _build_overview(hass)})


class ZoneDetailView(HomeAssistantView):
    """Modifica ed eliminazione di una zona."""

    url = "/api/irrigazione_smart/zones/{zone_id}"
    name = "api:irrigazione_smart:zone_detail"
    requires_auth = True

    async def post(self, request, zone_id: str):
        _require_admin(request)
        hass: HomeAssistant = request.app["hass"]
        store = _get_store(hass)
        if store is None:
            return self.json_message("Integration non configurata", 400)

        payload = await request.json()
        zone = store.async_update_zone(zone_id, payload)
        if zone is None:
            return self.json_message("Zona non trovata", 404)
        _notify(hass)
        return self.json({"zone": zone, "overview": _build_overview(hass)})

    async def delete(self, request, zone_id: str):
        _require_admin(request)
        hass: HomeAssistant = request.app["hass"]
        store = _get_store(hass)
        if store is None:
            return self.json_message("Integration non configurata", 400)

        if not store.async_delete_zone(zone_id):
            return self.json_message("Zona non trovata", 404)
        _remove_zone_device(hass, zone_id)
        _notify(hass, zones_changed=True)
        return self.json({"overview": _build_overview(hass)})


class ZoneReorderView(HomeAssistantView):
    """Nuova sequenza completa, dopo un riordino per trascinamento."""

    url = "/api/irrigazione_smart/zones/reorder"
    name = "api:irrigazione_smart:zone_reorder"
    requires_auth = True

    async def post(self, request):
        _require_admin(request)
        hass: HomeAssistant = request.app["hass"]
        store = _get_store(hass)
        if store is None:
            return self.json_message("Integration non configurata", 400)

        payload = await request.json()
        order = payload.get("order") or []
        if not isinstance(order, list) or not store.async_reorder_zones(order):
            return self.json_message("Ordine non valido", 400)

        _notify(hass)
        return self.json({"overview": _build_overview(hass)})


class ZoneMoveView(HomeAssistantView):
    """Spostamento di una linea nella sequenza."""

    url = "/api/irrigazione_smart/zones/{zone_id}/move"
    name = "api:irrigazione_smart:zone_move"
    requires_auth = True

    async def post(self, request, zone_id: str):
        _require_admin(request)
        hass: HomeAssistant = request.app["hass"]
        store = _get_store(hass)
        if store is None:
            return self.json_message("Integration non configurata", 400)

        payload = await request.json()
        direction = -1 if payload.get("direction") == "up" else 1
        if not store.async_move_zone(zone_id, direction):
            return self.json_message("Spostamento non possibile", 400)

        _notify(hass)
        return self.json({"overview": _build_overview(hass)})


class HistoryView(HomeAssistantView):
    """Storico giornaliero per i grafici."""

    url = "/api/irrigazione_smart/history"
    name = "api:irrigazione_smart:history"
    requires_auth = True

    async def get(self, request):
        hass: HomeAssistant = request.app["hass"]
        store = _get_store(hass)
        if store is None:
            return self.json({"entries": [], "categories": {}})

        return self.json(
            {
                "entries": store.history,
                "categories": CATEGORY_LABELS,
            }
        )


class LogView(HomeAssistantView):
    """Registro attività: lettura e svuotamento."""

    url = "/api/irrigazione_smart/log"
    name = "api:irrigazione_smart:log"
    requires_auth = True

    async def get(self, request):
        hass: HomeAssistant = request.app["hass"]
        activity = get_log(hass)
        return self.json({"entries": activity.entries if activity else []})

    async def delete(self, request):
        _require_admin(request)
        hass: HomeAssistant = request.app["hass"]
        activity = get_log(hass)
        if activity is not None:
            activity.clear()
        return self.json({"entries": []})


class SourcesView(HomeAssistantView):
    """Modifica delle sorgenti dati meteo dal pannello.

    Vivono nella config entry, non nello storage: si aggiorna quella, e
    Home Assistant ricarica l'integration da sola.
    """

    url = "/api/irrigazione_smart/sources"
    name = "api:irrigazione_smart:sources"
    requires_auth = True

    FIELDS = (
        CONF_WEATHER_ENTITY,
        CONF_TEMPERATURE_ENTITY,
        CONF_HUMIDITY_ENTITY,
        CONF_WIND_ENTITY,
        CONF_RAIN_ENTITY,
        CONF_IRRADIANCE_ENTITY,
    )

    async def post(self, request):
        _require_admin(request)
        hass: HomeAssistant = request.app["hass"]
        entries = hass.config_entries.async_entries(DOMAIN)
        if not entries:
            return self.json_message("Integration non configurata", 400)

        payload = await request.json()
        entry = entries[0]
        data = dict(entry.data)

        for field in self.FIELDS:
            if field in payload:
                value = payload[field]
                # campo svuotato = sorgente rimossa
                if value:
                    data[field] = value
                else:
                    data.pop(field, None)

        hass.config_entries.async_update_entry(entry, data=data)
        return self.json({"ok": True})


class GroupView(HomeAssistantView):
    """Finestra, giorni e avvio automatico di un gruppo."""

    url = "/api/irrigazione_smart/groups/{category}"
    name = "api:irrigazione_smart:group"
    requires_auth = True

    async def post(self, request, category: str):
        _require_admin(request)
        hass: HomeAssistant = request.app["hass"]
        store = _get_store(hass)
        if store is None:
            return self.json_message("Integration non configurata", 400)

        payload = await request.json()
        if store.async_update_group(category, payload) is None:
            return self.json_message("Gruppo non trovato", 404)

        _notify(hass)
        return self.json({"overview": _build_overview(hass)})


class MapView(HomeAssistantView):
    """Impostazioni della mappa: immagine di sfondo e trasparenza."""

    url = "/api/irrigazione_smart/map"
    name = "api:irrigazione_smart:map"
    requires_auth = True

    async def post(self, request):
        _require_admin(request)
        hass: HomeAssistant = request.app["hass"]
        store = _get_store(hass)
        if store is None:
            return self.json_message("Integration non configurata", 400)

        store.async_update_map(await request.json())
        _notify(hass)
        return self.json({"overview": _build_overview(hass)})


class MapImageView(HomeAssistantView):
    """Caricamento della planimetria.

    Home Assistant ha `image_upload`, ma serve solo miniature quadrate di
    256 o 512 pixel: una planimetria ritagliata a quadrato e ridotta a
    512 non si legge più. Il file si tiene quindi per intero, come
    caricato, accanto agli altri dati dell'integration.
    """

    url = "/api/irrigazione_smart/map/image"
    name = "api:irrigazione_smart:map_image"
    requires_auth = True

    async def post(self, request):
        _require_admin(request)
        hass: HomeAssistant = request.app["hass"]
        store = _get_store(hass)
        if store is None:
            return self.json_message("Integration non configurata", 400)

        try:
            data = await request.post()
        except ValueError:
            return self.json_message("Immagine troppo grande", 413)

        upload = data.get("file")
        content_type = getattr(upload, "content_type", None)
        if upload is None or content_type not in IMAGE_EXTENSIONS:
            return self.json_message(
                "Serve un'immagine PNG, JPEG, WEBP, GIF o SVG", 400
            )

        payload = upload.file.read()
        if len(payload) > MAX_IMAGE_BYTES:
            return self.json_message(
                f"L'immagine supera {MAX_IMAGE_BYTES // (1024 * 1024)} MB", 413
            )

        settings = store.map
        previous = (
            _map_image_path(hass, settings["image_id"], settings.get("image_ext") or "")
            if settings.get("image_id")
            else None
        )

        image_id = ulid_now()
        extension = IMAGE_EXTENSIONS[content_type]
        target = _map_image_path(hass, image_id, extension)

        def _write() -> None:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
            # la planimetria precedente non serve più a nessuno
            if previous is not None and previous != target:
                previous.unlink(missing_ok=True)

        await hass.async_add_executor_job(_write)

        store.async_update_map(
            {
                "image_id": image_id,
                "image_ext": extension,
                "image_name": getattr(upload, "filename", None),
                "image_url": None,
            }
        )
        _notify(hass)
        return self.json({"overview": _build_overview(hass)})


class MapImageServeView(HomeAssistantView):
    """Serve la planimetria caricata.

    Senza autenticazione, come fa `image_upload` di Home Assistant per le
    sue: un tag `img` non può portarsi dietro il token. L'indirizzo
    contiene un identificativo casuale e si serve **solo** la planimetria
    attualmente configurata, quindi non c'è modo di farsi restituire un
    file arbitrario passando un percorso costruito ad arte.
    """

    url = "/api/irrigazione_smart/map/image/{image_id}"
    name = "api:irrigazione_smart:map_image_serve"
    requires_auth = False

    async def get(self, request, image_id: str):
        hass: HomeAssistant = request.app["hass"]
        store = _get_store(hass)
        if store is None:
            return web.Response(status=404)

        settings = store.map
        if not settings.get("image_id") or settings["image_id"] != image_id:
            return web.Response(status=404)

        path = _map_image_path(hass, image_id, settings.get("image_ext") or "")
        if not await hass.async_add_executor_job(path.is_file):
            return web.Response(status=404)

        return web.FileResponse(path)


class AreasView(HomeAssistantView):
    """Creazione di un'area sulla mappa."""

    url = "/api/irrigazione_smart/areas"
    name = "api:irrigazione_smart:areas"
    requires_auth = True

    async def post(self, request):
        _require_admin(request)
        hass: HomeAssistant = request.app["hass"]
        store = _get_store(hass)
        if store is None:
            return self.json_message("Integration non configurata", 400)

        area = store.async_create_area(await request.json())
        _notify(hass)
        return self.json({"area": area, "overview": _build_overview(hass)})


class AreaDetailView(HomeAssistantView):
    """Modifica ed eliminazione di un'area."""

    url = "/api/irrigazione_smart/areas/{area_id}"
    name = "api:irrigazione_smart:area_detail"
    requires_auth = True

    async def post(self, request, area_id: str):
        _require_admin(request)
        hass: HomeAssistant = request.app["hass"]
        store = _get_store(hass)
        if store is None:
            return self.json_message("Integration non configurata", 400)

        area = store.async_update_area(area_id, await request.json())
        if area is None:
            return self.json_message("Area non trovata", 404)
        _notify(hass)
        return self.json({"area": area, "overview": _build_overview(hass)})

    async def delete(self, request, area_id: str):
        _require_admin(request)
        hass: HomeAssistant = request.app["hass"]
        store = _get_store(hass)
        if store is None:
            return self.json_message("Integration non configurata", 400)

        if not store.async_delete_area(area_id):
            return self.json_message("Area non trovata", 404)
        _notify(hass)
        return self.json({"overview": _build_overview(hass)})


class ItemsView(HomeAssistantView):
    """Creazione di notifiche e azioni."""

    # Prefisso `items/` esplicito: un segnaposto in cima al percorso
    # catturerebbe anche `run` e `stop`.
    url = "/api/irrigazione_smart/items/{kind}"
    name = "api:irrigazione_smart:items"
    requires_auth = True

    async def post(self, request, kind: str):
        if kind not in ("notifications", "actions"):
            return self.json_message("Tipo non valido", 404)
        _require_admin(request)
        hass: HomeAssistant = request.app["hass"]
        store = _get_store(hass)
        if store is None:
            return self.json_message("Integration non configurata", 400)

        payload = await request.json()
        item = store.async_create_item(kind, payload)
        _notify(hass)
        return self.json({"item": item, "overview": _build_overview(hass)})


class ItemDetailView(HomeAssistantView):
    """Modifica, eliminazione e prova di una notifica o di un'azione."""

    url = "/api/irrigazione_smart/items/{kind}/{item_id}"
    name = "api:irrigazione_smart:item_detail"
    requires_auth = True

    async def post(self, request, kind: str, item_id: str):
        if kind not in ("notifications", "actions"):
            return self.json_message("Tipo non valido", 404)
        _require_admin(request)
        hass: HomeAssistant = request.app["hass"]
        store = _get_store(hass)
        if store is None:
            return self.json_message("Integration non configurata", 400)

        payload = await request.json()

        # La prova ignora gli interruttori: serve proprio a verificare la
        # configurazione mentre la si sta scrivendo.
        if payload.get("test"):
            notifier = get_notifier(hass)
            item = {**(store.async_update_item(kind, item_id, {}) or {}), **payload}
            if notifier is None or not item:
                return self.json_message("Voce non trovata", 404)
            context = build_context(_demo_event_data())
            ok = (
                await notifier.async_send_notification(item, context, test=True)
                if kind == "notifications"
                else await notifier.async_run_action(item, context, test=True)
            )
            return self.json({"tested": ok, "overview": _build_overview(hass)})

        item = store.async_update_item(kind, item_id, payload)
        if item is None:
            return self.json_message("Voce non trovata", 404)
        _notify(hass)
        return self.json({"item": item, "overview": _build_overview(hass)})

    async def delete(self, request, kind: str, item_id: str):
        if kind not in ("notifications", "actions"):
            return self.json_message("Tipo non valido", 404)
        _require_admin(request)
        hass: HomeAssistant = request.app["hass"]
        store = _get_store(hass)
        if store is None:
            return self.json_message("Integration non configurata", 400)

        if not store.async_delete_item(kind, item_id):
            return self.json_message("Voce non trovata", 404)
        _notify(hass)
        return self.json({"overview": _build_overview(hass)})


def _demo_event_data() -> dict[str, Any]:
    """Dati verosimili per provare una notifica senza irrigare davvero."""
    return {
        "nome": "Prato Sud",
        "minuti": 25,
        "acqua_mm": 6.2,
        "deficit_mm": 18.4,
        "deficit_residuo_mm": 0.0,
        "durata_min": 47,
        "linee_completate": ["a", "b"],
        "linee_fallite": [],
        "motivo": "prova",
        "valvola": "switch.esempio",
        "prossima_nome": "Aiuola Nord",
    }


class RunView(HomeAssistantView):
    """Avvio forzato: una linea o l'intera sequenza."""

    url = "/api/irrigazione_smart/run"
    name = "api:irrigazione_smart:run"
    requires_auth = True

    async def post(self, request):
        _require_admin(request)
        hass: HomeAssistant = request.app["hass"]
        store = _get_store(hass)
        executor = get_executor(hass)
        if store is None or executor is None:
            return self.json_message("Integration non configurata", 400)

        payload = await request.json()
        zone_id = payload.get("zone_id")

        if zone_id:
            zone = store.zones.get(zone_id)
            if zone is None:
                return self.json_message("Zona non trovata", 404)
            # la forzatura rispetta il master di linea
            if not zone.get("enabled"):
                return self.json_message("La linea è disattivata", 400)
            await executor.async_run_zone(zone_id, payload.get("minuti"))
            avviata = True
        else:
            # `categoria` limita la sequenza a un gruppo: solo il prato,
            # solo le aiuole
            avviata = await executor.async_start_sequence(
                category=payload.get("categoria")
            )

        # Se non è partita niente lo si dice: la sequenza irriga solo le
        # linee sotto soglia, e quando non ce n'è nessuna il comando non
        # ha nulla da fare. Senza questa riga la pagina restava identica e
        # il pulsante sembrava rotto.
        return self.json({"avviata": bool(avviata), "overview": _build_overview(hass)})


class StopView(HomeAssistantView):
    """Interruzione immediata dell'irrigazione in corso."""

    url = "/api/irrigazione_smart/stop"
    name = "api:irrigazione_smart:stop"
    requires_auth = True

    async def post(self, request):
        _require_admin(request)
        hass: HomeAssistant = request.app["hass"]
        executor = get_executor(hass)
        if executor is not None:
            await executor.async_stop()
        return self.json({"overview": _build_overview(hass)})


class CalibrationView(HomeAssistantView):
    """Taratura: misura la portata reale, linea per linea."""

    url = "/api/irrigazione_smart/calibration"
    name = "api:irrigazione_smart:calibration"
    requires_auth = True

    async def post(self, request):
        """Avvia la prova sulle linee indicate.

        La geometria arriva insieme all'elenco e viene salvata subito sulle
        zone: descrive l'impianto, non la prova, e serve comunque a
        ricalcolare i mm/h anche a distanza di mesi.
        """
        _require_admin(request)
        hass: HomeAssistant = request.app["hass"]
        store = _get_store(hass)
        executor = get_executor(hass)
        if store is None or executor is None:
            return self.json_message("Integration non configurata", 400)

        payload = await request.json()
        zone_ids: list[str] = []
        for voce in payload.get("zones") or []:
            zone_id = voce.get("zone_id")
            if zone_id not in store.zones:
                continue
            geometria = {
                chiave: voce[chiave]
                for chiave in ("sprinklers", "spacing_m", "layout", "flow_entity")
                if chiave in voce
            }
            if geometria:
                store.async_update_zone(zone_id, geometria)
            zone_ids.append(zone_id)

        if not zone_ids:
            return self.json_message("Nessuna linea da tarare", 400)

        if not await executor.async_start_calibration(zone_ids):
            return self.json_message("Irrigazione o taratura già in corso", 409)

        return self.json({"avviata": True, "overview": _build_overview(hass)})


class CalibrationApplyView(HomeAssistantView):
    """Scrive sulla linea la portata appena misurata."""

    url = "/api/irrigazione_smart/calibration/apply"
    name = "api:irrigazione_smart:calibration:apply"
    requires_auth = True

    async def post(self, request):
        _require_admin(request)
        hass: HomeAssistant = request.app["hass"]
        store = _get_store(hass)
        if store is None:
            return self.json_message("Integration non configurata", 400)

        payload = await request.json()
        applicate = 0
        for voce in payload.get("results") or []:
            zone = store.zones.get(voce.get("zone_id"))
            if zone is None:
                continue
            try:
                l_h = float(voce.get("l_h"))
            except (TypeError, ValueError):
                continue

            area = zone_area_m2(zone)
            mm_h = rate_from_flow(l_h, area) if area else 0.0
            if mm_h <= 0:
                continue

            store.async_update_zone(
                zone["id"],
                {
                    "rate_mm_h": mm_h,
                    "area_m2": area,
                    "rate_source": {
                        "metodo": "flussostato",
                        "quando": voce.get("quando") or dt_util.now().isoformat(),
                        "l_h": l_h,
                        "litri": voce.get("litri"),
                        "secondi": voce.get("secondi"),
                        "area_m2": area,
                    },
                },
            )
            applicate += 1

        return self.json({"applicate": applicate, "overview": _build_overview(hass)})


class SystemView(HomeAssistantView):
    """Modifica delle impostazioni di sistema."""

    url = "/api/irrigazione_smart/system"
    name = "api:irrigazione_smart:system"
    requires_auth = True

    async def post(self, request):
        _require_admin(request)
        hass: HomeAssistant = request.app["hass"]
        store = _get_store(hass)
        if store is None:
            return self.json_message("Integration non configurata", 400)

        payload = await request.json()
        store.async_update_system(payload)
        _notify(hass)
        return self.json({"overview": _build_overview(hass)})


def _asset_fingerprint(www_dir: Path, version: str) -> str:
    """Identificativo che cambia ogni volta che il pannello cambia.

    L'indirizzo del JavaScript porta questo valore: se cambia, il browser
    è costretto a riscaricarlo. Legarlo alla sola versione non basta —
    due build della stessa versione avrebbero lo stesso indirizzo e
    resterebbe in cache, costringendo l'utente al ricaricamento forzato,
    che sul telefono è scomodo o impossibile.
    """
    try:
        content = (www_dir / f"{COMPONENT_NAME}.js").read_bytes()
        digest = hashlib.sha256(content).hexdigest()[:10]
    except OSError:
        digest = "0"
    return f"{version}.{digest}"


async def async_setup_store(hass: HomeAssistant) -> IrrigazioneStore:
    """Carica lo storage una volta sola e lo condivide nel dominio."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    store = domain_data.get(_STORE)
    if store is None:
        store = IrrigazioneStore(hass)
        await store.async_load()
        domain_data[_STORE] = store
    return store


async def async_setup_panel(hass: HomeAssistant) -> None:
    """Registra risorsa statica, API e voce in sidebar (una volta sola)."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    await async_setup_store(hass)

    if not domain_data.get(_HTTP_FLAG):
        www_dir = Path(__file__).parent / "www"
        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL, str(www_dir), False)]
        )
        hass.http.register_view(OverviewView())
        hass.http.register_view(ZonesView())
        # prima di ZoneDetailView: `/zones/{zone_id}` catturerebbe "reorder"
        hass.http.register_view(ZoneReorderView())
        hass.http.register_view(ZoneDetailView())
        hass.http.register_view(SystemView())
        hass.http.register_view(ZoneMoveView())
        hass.http.register_view(HistoryView())
        hass.http.register_view(LogView())
        hass.http.register_view(SourcesView())
        hass.http.register_view(GroupView())
        hass.http.register_view(MapView())
        hass.http.register_view(MapImageView())
        hass.http.register_view(MapImageServeView())
        # prima di AreaDetailView, per lo stesso motivo di ZoneReorderView
        hass.http.register_view(AreasView())
        hass.http.register_view(AreaDetailView())
        hass.http.register_view(ItemsView())
        hass.http.register_view(ItemDetailView())
        hass.http.register_view(RunView())
        hass.http.register_view(StopView())
        hass.http.register_view(CalibrationView())
        hass.http.register_view(CalibrationApplyView())
        domain_data[_HTTP_FLAG] = True

    if not domain_data.get(_PANEL_FLAG):
        integration = await async_get_integration(hass, DOMAIN)
        # la lettura del file non va fatta nel loop degli eventi
        fingerprint = await hass.async_add_executor_job(
            _asset_fingerprint,
            Path(__file__).parent / "www",
            str(integration.version),
        )
        domain_data["panel_version"] = str(integration.version)

        await panel_custom.async_register_panel(
            hass,
            webcomponent_name=COMPONENT_NAME,
            frontend_url_path=PANEL_URL_PATH,
            module_url=f"{STATIC_URL}/{COMPONENT_NAME}.js?v={fingerprint}",
            sidebar_title=PANEL_TITLE,
            sidebar_icon=PANEL_ICON,
            require_admin=False,
        )
        domain_data[_PANEL_FLAG] = True


async def async_remove_panel(hass: HomeAssistant) -> None:
    """Rimuove la voce dalla sidebar quando la config entry viene scaricata."""
    domain_data = hass.data.get(DOMAIN, {})
    if domain_data.get(_PANEL_FLAG):
        frontend.async_remove_panel(hass, PANEL_URL_PATH)
        domain_data[_PANEL_FLAG] = False
