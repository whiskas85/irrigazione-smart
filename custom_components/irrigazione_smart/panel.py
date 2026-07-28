"""Pannello laterale e API di supporto per Irrigazione Smart.

Registra una voce nella barra laterale con una pagina propria (un web
component servito da `www/`) e le API REST che il pannello usa per leggere
lo stato e gestire le zone.

I valori agronomici mostrati (TAW, soglia, durate, cicli) non sono
ricalcolati qui: arrivano da `hydro.py`, che resta l'unica fonte di verità.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import HomeAssistantView, StaticPathConfig
from homeassistant.const import CONF_LATITUDE, CONF_LONGITUDE
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import Unauthorized
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.loader import async_get_integration

from .const import (
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
from .logbook import get_log
from .notifier import HOOK_LABELS, build_context, get_notifier
from .store import IrrigazioneStore

PANEL_URL_PATH = "irrigazione-smart"
PANEL_TITLE = "Irrigazione"
PANEL_ICON = "mdi:sprinkler-variant"
COMPONENT_NAME = "irrigazione-smart-panel"
STATIC_URL = "/irrigazione_smart_frontend"

_HTTP_FLAG = "_http_registered"
_PANEL_FLAG = "_panel_registered"
_STORE = "store"


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
    executor = get_executor(hass)

    system = store.system
    window = TimeWindow.from_strings(
        system.get("window_start", "04:00"), system.get("window_end", "08:00")
    )
    level, why = window_quality(window)

    # Un solo passaggio sul motore: gli stessi piani servono sia alle righe
    # delle zone sia alla sequenza della notte.
    zones: list[dict[str, Any]] = []
    plans: list[tuple[str, str, RunPlan]] = []
    for zone in store.zones_sorted():
        params = resolve_zone_params(zone, system)
        plan = evaluate_zone(
            zone, system, float(zone.get("deficit_mm") or 0.0), wind_kmh=wind_kmh
        )
        zones.append({**zone, "computed": _zone_computed(zone, params, plan)})
        plans.append((zone["id"], zone.get("name", ""), plan))

    return {
        "configured": True,
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
        },
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


def _schedule_payload(
    plans: list[tuple[str, str, RunPlan]],
    window: TimeWindow,
    system: dict[str, Any],
) -> dict[str, Any]:
    """Sequenza della notte con la diagnosi di capienza della finestra."""
    sched = schedule_sequence(
        plans,
        window,
        gap_minutes=int(system.get("gap_minutes", 5) or 0),
        allow_overflow=system.get("overflow_policy") != "truncate",
    )

    return {
        "runs": [
            {
                "zone_id": run.zone_id,
                "zone_name": run.zone_name,
                "start": run.start_hhmm,
                "end": run.end_hhmm,
                "minutes": round(run.plan.wall_clock_minutes, 1),
                "cycles": run.plan.cycles,
            }
            for run in sched.runs
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
        "last_closed_date": daily.get("last_closed_date"),
        "last_update": daily.get("last_update"),
        "sources": live.get("sources") or {},
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
        else:
            await executor.async_start_sequence()

        return self.json({"overview": _build_overview(hass)})


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
        hass.http.register_view(ZoneDetailView())
        hass.http.register_view(SystemView())
        hass.http.register_view(ZoneMoveView())
        hass.http.register_view(LogView())
        hass.http.register_view(ItemsView())
        hass.http.register_view(ItemDetailView())
        hass.http.register_view(RunView())
        hass.http.register_view(StopView())
        domain_data[_HTTP_FLAG] = True

    if not domain_data.get(_PANEL_FLAG):
        integration = await async_get_integration(hass, DOMAIN)
        await panel_custom.async_register_panel(
            hass,
            webcomponent_name=COMPONENT_NAME,
            frontend_url_path=PANEL_URL_PATH,
            module_url=f"{STATIC_URL}/{COMPONENT_NAME}.js?v={integration.version}",
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
