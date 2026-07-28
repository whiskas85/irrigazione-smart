"""Notifiche e azioni agganciate agli eventi dell'irrigazione.

Notifiche e azioni sono la stessa cosa vista da due lati: entrambe
chiamano un servizio di Home Assistant quando succede qualcosa. La
differenza è l'uso — una manda un messaggio, l'altra fa agire l'impianto —
e quindi il form con cui si configurano.

Niente è cablato su `notify`: si può richiamare qualunque servizio, anche
uno script proprio. Così l'utente resta libero di decidere *come* essere
avvisato.

Due livelli di interruttore, come per le linee: il master generale e
l'abilitazione della singola voce. Se il master è spento non parte nulla.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from homeassistant.core import Event, HomeAssistant, callback

from .const import (
    DOMAIN,
    EVENT_FINISHED,
    EVENT_STARTED,
    EVENT_ZONE_FAILED,
    EVENT_ZONE_FINISHED,
    EVENT_ZONE_STARTED,
)
from .logbook import ERROR, get_log
from .store import IrrigazioneStore

_LOGGER = logging.getLogger(__name__)

# I momenti a cui si può agganciare un'azione, con l'evento che li produce.
HOOKS: dict[str, str] = {
    "before_irrigation": EVENT_STARTED,
    "after_irrigation": EVENT_FINISHED,
    "before_zone": EVENT_ZONE_STARTED,
    "after_zone": EVENT_ZONE_FINISHED,
    "zone_failed": EVENT_ZONE_FAILED,
}

HOOK_LABELS: dict[str, str] = {
    "before_irrigation": "Prima dell'irrigazione",
    "after_irrigation": "Dopo l'irrigazione",
    "before_zone": "Prima di ogni linea",
    "after_zone": "Dopo ogni linea",
    "zone_failed": "Quando una linea non parte",
}


class _SafeDict(dict):
    """Lascia intatti i segnaposto sconosciuti invece di far fallire tutto."""

    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


def build_context(event_data: dict[str, Any]) -> dict[str, Any]:
    """Segnaposto disponibili nei messaggi, con nomi in italiano."""
    completate = event_data.get("linee_completate") or []
    fallite = event_data.get("linee_fallite") or []
    return {
        "linea": event_data.get("nome", ""),
        "minuti": event_data.get("minuti", ""),
        "acqua_mm": event_data.get("acqua_mm", ""),
        "deficit_mm": event_data.get("deficit_mm", ""),
        "deficit_residuo_mm": event_data.get("deficit_residuo_mm", ""),
        "durata": event_data.get("durata_min", ""),
        "completate": len(completate),
        "fallite": len(fallite),
        "motivo": event_data.get("motivo", ""),
        "valvola": event_data.get("valvola", ""),
        "prossima": event_data.get("prossima_nome") or "",
        "flusso": event_data.get("flusso", ""),
    }


def render(text: str, context: dict[str, Any]) -> str:
    """Sostituisce i segnaposto `{nome}` senza mai sollevare eccezioni."""
    if not text:
        return ""
    try:
        return str(text).format_map(_SafeDict(context))
    except (ValueError, IndexError):
        # una graffa spaiata non deve impedire l'invio
        return str(text)


def render_deep(value: Any, context: dict[str, Any]) -> Any:
    """Sostituisce i segnaposto dentro una struttura già interpretata.

    Il JSON dei dati non si può passare a `render` così com'è: usa le
    graffe, che verrebbero scambiate per segnaposto e ne romperebbero la
    sintassi. Prima si interpreta il JSON, poi si sostituisce dentro alle
    stringhe che contiene.
    """
    if isinstance(value, str):
        return render(value, context)
    if isinstance(value, dict):
        return {key: render_deep(val, context) for key, val in value.items()}
    if isinstance(value, list):
        return [render_deep(item, context) for item in value]
    return value


def _split_service(service: str) -> tuple[str, str] | None:
    """`notify.mobile_app_x` -> ("notify", "mobile_app_x")."""
    if not service or "." not in service:
        return None
    domain, _, name = service.partition(".")
    return (domain, name) if domain and name else None


class Notifier:
    """Esegue notifiche e azioni quando arrivano gli eventi."""

    def __init__(self, hass: HomeAssistant, store: IrrigazioneStore) -> None:
        self._hass = hass
        self._store = store

    # ------------------------------------------------------------ invio

    async def _call(self, service: str, data: dict[str, Any], label: str) -> bool:
        """Chiama il servizio, registrando l'esito nel log attività."""
        parts = _split_service(service)
        if parts is None:
            self._log(f"{label}: servizio non valido ({service!r})", ERROR)
            return False

        domain, name = parts
        try:
            await self._hass.services.async_call(domain, name, data, blocking=False)
        except Exception as err:
            _LOGGER.exception("Chiamata a %s fallita", service)
            self._log(f"{label}: {service} non riuscito — {err}", ERROR)
            return False
        return True

    def _log(self, text: str, level: str = "info") -> None:
        activity = get_log(self._hass)
        if activity is not None:
            activity.add("config", text, level=level)

    async def async_send_notification(
        self, item: dict[str, Any], context: dict[str, Any], *, test: bool = False
    ) -> bool:
        """Invia una notifica. `test` ignora gli interruttori."""
        if not test:
            if not self._store.system.get("notifications_enabled", True):
                return False
            if not item.get("enabled", True):
                return False

        data = {
            "title": render(item.get("title", ""), context),
            "message": render(item.get("message", ""), context),
        }
        label = f"Notifica «{item.get('name')}»"
        sent = await self._call(item.get("service", ""), data, label)
        if sent:
            self._log(f"{label}: inviata{' (prova)' if test else ''}")
        return sent

    async def async_run_action(
        self, item: dict[str, Any], context: dict[str, Any], *, test: bool = False
    ) -> bool:
        """Esegue un'azione. `test` ignora gli interruttori."""
        if not test:
            if not self._store.system.get("actions_enabled", True):
                return False
            if not item.get("enabled", True):
                return False

        raw = item.get("data") or "{}"
        try:
            payload = json.loads(raw) if raw.strip() else {}
            if not isinstance(payload, dict):
                raise ValueError("i dati devono essere un oggetto JSON")
        except (ValueError, TypeError) as err:
            self._log(f"Azione «{item.get('name')}»: dati non validi — {err}", ERROR)
            return False

        payload = render_deep(payload, context)

        label = f"Azione «{item.get('name')}»"
        done = await self._call(item.get("service", ""), payload, label)
        if done:
            self._log(f"{label}: eseguita{' (prova)' if test else ''}")
        return done

    # ------------------------------------------------------------ eventi

    async def _handle(self, hook: str, event: Event) -> None:
        context = build_context(dict(event.data))

        for item in list(self._store.actions.values()):
            if item.get("hook") == hook:
                await self.async_run_action(item, context)

        # Le notifiche seguono i propri momenti, indipendenti dalle azioni.
        for item in list(self._store.notifications.values()):
            if item.get("trigger", "after_irrigation") == hook:
                await self.async_send_notification(item, context)

    @callback
    def async_subscribe(self) -> list:
        """Aggancia un ascoltatore per ogni momento previsto."""
        unsubs = []
        for hook, event_type in HOOKS.items():

            def _make(hook_name: str):
                async def _listener(event: Event) -> None:
                    await self._handle(hook_name, event)

                return _listener

            unsubs.append(self._hass.bus.async_listen(event_type, _make(hook)))
        return unsubs


def get_notifier(hass: HomeAssistant) -> Notifier | None:
    return hass.data.get(DOMAIN, {}).get("notifier")
