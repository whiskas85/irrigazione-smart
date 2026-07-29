"""Ripresa dopo un'interruzione di Home Assistant.

Un'irrigazione dura ore. In quelle ore Home Assistant può riavviarsi, può
aggiornarsi, può andare via la corrente al Raspberry: quando torna, il
task che seguiva la sequenza non c'è più, ma **l'acqua no**. Un relè che
era chiuso resta chiuso, e la valvola continua a bagnare finché qualcuno
non se ne accorge di persona.

Questo modulo è ciò che si fa al ritorno, in quest'ordine:

1. si chiudono le valvole delle proprie linee che risultano ancora aperte
2. lo si dice forte — registro, evento e notifica persistente
3. si rimette in gioco la giornata, così l'irrigazione interrotta può
   riprendere invece di essere persa fino al giorno dopo

Il punto 3 non ricostruisce nessuno stato: si limita a cancellare il
marcatore "già partito oggi" dei gruppi. Ci pensa il bilancio idrico a
sapere cosa manca — le linee che avevano già ricevuto la loro acqua sono
sotto soglia e verranno saltate da sole, quelle rimaste a secco no. È il
motivo per cui l'acqua erogata si scrive a bilancio a ogni passata e non
alla fine della linea.
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.core import HomeAssistant

from .const import DOMAIN, EVENT_RECOVERED, CATEGORY_ORDER, zone_category
from .logbook import ERROR, WARNING, get_log
from .store import IrrigazioneStore

_LOGGER = logging.getLogger(__name__)

OPEN_STATES = ("on", "open", "opening")


def _is_open(hass: HomeAssistant, entity_id: str) -> bool:
    state = hass.states.get(entity_id)
    return state is not None and state.state in OPEN_STATES


async def async_recover_interrupted_run(
    hass: HomeAssistant, store: IrrigazioneStore
) -> None:
    """Rimette in sicurezza e riapre la partita, se serve."""
    active = store.system.get("active_run")
    if not active:
        return

    # Il segnaposto c'è: l'ultima volta il processo se n'è andato mentre
    # un'irrigazione era in corso. Prima di ogni altra cosa, l'acqua.
    valvole = list(active.get("valvole") or [])
    sospetta = active.get("aperta")
    if sospetta and sospetta not in valvole:
        valvole.append(sospetta)

    chiuse: list[str] = []
    for entity_id in valvole:
        if not _is_open(hass, entity_id):
            continue
        _LOGGER.warning(
            "Ripresa dopo interruzione: la valvola %s è ancora aperta, la chiudo",
            entity_id,
        )
        try:
            await hass.services.async_call(
                "valve" if entity_id.startswith("valve.") else "homeassistant",
                "close_valve" if entity_id.startswith("valve.") else "turn_off",
                {"entity_id": entity_id},
                blocking=True,
            )
            chiuse.append(entity_id)
        except Exception:
            _LOGGER.exception("Non sono riuscito a chiudere %s", entity_id)

    store.async_set_active_run(None)

    activity = get_log(hass)
    quando = active.get("started_at") or "?"

    if chiuse:
        if activity is not None:
            activity.add(
                "zone_failed",
                "Home Assistant si è interrotto durante l'irrigazione: "
                f"{', '.join(chiuse)} era rimasta aperta ed è stata chiusa",
                level=ERROR,
            )
        await hass.services.async_call(
            "persistent_notification",
            "create",
            {
                "title": "Irrigazione interrotta da un riavvio",
                "message": (
                    "Home Assistant si è fermato mentre l'irrigazione era in "
                    f"corso (partita alle {quando}).\n\n"
                    f"Ho trovato ancora aperta: **{', '.join(chiuse)}**, e l'ho "
                    "chiusa.\n\nControlla che sia davvero chiusa."
                ),
                "notification_id": f"{DOMAIN}_ripresa",
            },
            blocking=False,
        )
    elif activity is not None:
        activity.add(
            "finished",
            "Home Assistant si è interrotto durante l'irrigazione: "
            "nessuna valvola era rimasta aperta",
            level=WARNING,
        )

    riaperti = _rearm_groups(store)

    hass.bus.async_fire(
        EVENT_RECOVERED,
        {
            "partita_alle": quando,
            "valvole_chiuse": chiuse,
            "gruppi_riaperti": riaperti,
        },
    )

    _LOGGER.info(
        "Ripresa completata: %d valvole chiuse, gruppi rimessi in gioco: %s",
        len(chiuse),
        ", ".join(riaperti) or "nessuno",
    )


def _rearm_groups(store: IrrigazioneStore) -> list[str]:
    """Cancella il "già partito oggi" dei gruppi con linee ancora a secco.

    Senza, un riavvio a metà sequenza costerebbe l'irrigazione dell'intera
    giornata: il gruppo risulterebbe già eseguito e il programmatore non
    lo guarderebbe più fino a domani.

    Si rimettono in gioco solo i gruppi che hanno ancora qualcosa da
    bagnare. Riaprire un gruppo già servito lo farebbe ripartire a vuoto,
    e la partenza consumata è anche ciò che impedisce i doppioni.
    """
    da_riaprire: set[str] = set()

    for zone in store.zones.values():
        if not zone.get("enabled", True):
            continue
        deficit = float(zone.get("deficit_mm") or 0.0)
        if deficit <= 0:
            continue
        da_riaprire.add(zone_category(zone.get("zone_type")))

    riaperti: list[str] = []
    for category in CATEGORY_ORDER:
        if category not in da_riaprire:
            continue
        group = store.groups.get(category)
        if group and group.get("last_auto_run"):
            store.async_update_group(category, {"last_auto_run": None})
            riaperti.append(category)

    return riaperti
