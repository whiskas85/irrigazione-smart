/*
 * Pannello laterale di Irrigazione Smart.
 *
 * Web component vanilla (nessun passo di build), diviso in tre schede:
 *   - Dashboard : master generale, master di linea, sequenza della notte
 *   - Zone      : gestione completa delle linee (parametri, creazione, modifica)
 *   - Meteo     : sorgenti dati, accumulo della giornata, ET0
 *
 * Usa i componenti nativi di Home Assistant e solo variabili di tema, così
 * l'aspetto segue qualsiasi tema attivo. I valori agronomici arrivano già
 * calcolati dal backend (`hydro.py`): qui non si duplica nessuna formula.
 */

const SENSORS = [
  { key: "temperature", label: "Temperatura", icon: "mdi:thermometer" },
  { key: "humidity", label: "Umidità", icon: "mdi:water-percent" },
  { key: "wind_speed", label: "Vento", icon: "mdi:weather-windy" },
  { key: "precipitation", label: "Pioggia", icon: "mdi:weather-rainy" },
  { key: "irradiance", label: "Irraggiamento", icon: "mdi:white-balance-sunny" },
];

/* Le schede fisse. Prato, Aiuole e Orto si aggiungono in mezzo, perché
   sono impianti diversi con orari propri e vanno tenuti separati. */
const BASE_TABS = [
  { id: "dashboard", label: "Dashboard", icon: "mdi:view-dashboard-outline" },
];
const TAIL_TABS = [
  { id: "meteo", label: "Meteo", icon: "mdi:weather-partly-cloudy" },
  { id: "azioni", label: "Azioni", icon: "mdi:bell-cog-outline" },
  { id: "log", label: "Log", icon: "mdi:format-list-bulleted" },
];

const DAY_LABELS = {
  mon: "Lun", tue: "Mar", wed: "Mer", thu: "Gio",
  fri: "Ven", sat: "Sab", sun: "Dom",
};
const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/* Segnaposto utilizzabili nei messaggi delle notifiche. */
const PLACEHOLDERS =
  "{linea} {minuti} {acqua_mm} {durata} {completate} {fallite} {motivo} {prossima}";

/* Icona predefinita per tipo di zona, quando la linea non ne ha una sua. */
const ZONE_TYPE_ICONS = {
  prato_microterme: "mdi:grass",
  prato_macroterme: "mdi:grass",
  aiuola_arbusti: "mdi:flower",
  aiuola_fiorita: "mdi:flower-tulip",
  orto: "mdi:carrot",
};

const LOG_ICONS = {
  started: "mdi:play-circle-outline",
  finished: "mdi:check-circle-outline",
  zone_started: "mdi:water",
  zone_finished: "mdi:water-check",
  zone_failed: "mdi:alert-circle-outline",
  config: "mdi:cog-outline",
};

const ZONE_TYPE_LABELS = {
  prato_microterme: "Prato microterme",
  prato_macroterme: "Prato macroterme",
  aiuola_arbusti: "Aiuola / arbusti",
  aiuola_fiorita: "Aiuola fiorita",
  orto: "Orto",
};
const SOIL_LABELS = { sabbioso: "Sabbioso", franco: "Franco", argilloso: "Argilloso" };
const EMITTER_LABELS = {
  statici: "Irrigatori statici",
  turbine: "Turbine",
  goccia: "Ala gocciolante",
};
const ET0_METHOD_LABELS = {
  hargreaves: "Hargreaves-Samani (sole temperature)",
  penman_monteith: "Penman-Monteith FAO-56",
  penman_monteith_rs_stimata: "Penman-Monteith (radiazione stimata)",
};
const SOURCE_LABELS = {
  sensore_locale: "sensore locale",
  servizio_meteo: "servizio meteo",
  non_disponibile: "non disponibile",
};

const INHERIT_NUM = -1;
const INHERIT_STR = "eredita";

/* Non tutte le versioni del frontend registrano gli stessi componenti
   (`mwc-button` e `mwc-list-item` mancano nelle più recenti). Si verifica
   a runtime cosa esiste davvero: se manca, si usa un controllo HTML
   equivalente stilizzato col tema, così la pagina resta sempre usabile. */
const has = (tag) => !!customElements.get(tag);

const label = (map, key) => map[key] || key;
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);

/* I motivi arrivano dal motore come slug, a volte con valori in coda
   (es. "vento_eccessivo_25kmh"): si traducono per prefisso. */
function reasonLabel(reason) {
  if (!reason) return "";
  const exact = {
    deficit_nullo: "terreno alla capacità di campo",
    portata_non_configurata: "portata non configurata",
    master_disattivo: "sistema in pausa",
    zona_disabilitata: "linea disattivata",
    rischio_gelo: "rischio gelo",
    giorno_escluso: "giorno escluso",
    deficit_oltre_soglia: "deficit oltre soglia",
    troncato_da_tetto_massimo: "troncato dal tetto massimo",
  };
  if (exact[reason]) return exact[reason];
  if (reason.startsWith("sotto_soglia")) return "sotto soglia";
  if (reason.startsWith("fuori_finestra")) return "fuori finestra";
  if (reason.startsWith("vento_eccessivo")) return "vento eccessivo";
  if (reason.startsWith("pioggia_prevista")) return "pioggia prevista";
  return reason.replace(/_/g, " ");
}

/* Un blocco è diverso dal semplice "non serve acqua": va evidenziato. */
const BLOCKING = [
  "master_disattivo", "zona_disabilitata", "rischio_gelo", "giorno_escluso",
  "fuori_finestra", "vento_eccessivo", "pioggia_prevista", "portata_non_configurata",
];
const isBlocked = (reason) => !!reason && BLOCKING.some((b) => reason.startsWith(b));

/* Stato a colpo d'occhio di una linea:
     azzurro = sta irrigando ora
     rosso   = carenza forte (oltre metà strada tra soglia e TAW)
     giallo  = deficit oltre soglia, chiede acqua
     verde   = tutto a posto
   La soglia "grave" non è arbitraria: oltre quel punto la pianta è in
   stress prolungato, non solo assetata. */
function zoneStatus(zone, runningZoneId) {
  if (runningZoneId && zone.id === runningZoneId) {
    return { level: "watering", label: "in irrigazione" };
  }
  if (!zone.enabled) return { level: "off", label: "disattivata" };

  const c = zone.computed || {};
  const deficit = Number(zone.deficit_mm || 0);
  const threshold = Number(c.trigger_threshold_mm || 0);
  const taw = Number(c.taw_mm || 0);

  if (threshold > 0 && deficit >= threshold) {
    const grave = taw > threshold && deficit >= threshold + (taw - threshold) / 2;
    return grave
      ? { level: "critical", label: "carenza forte" }
      : { level: "thirsty", label: "chiede acqua" };
  }
  return { level: "ok", label: "ok" };
}

class IrrigazioneSmartPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._overview = null;
    this._loading = false;
    this._error = null;
    this._tab = "dashboard";
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._warmUpComponents();
    if (!this._overview) {
      if (!this._loading) this._fetchOverview();
      return;
    }
    this._updateLiveValues();
    this._updateMenuButton();
  }

  set narrow(value) {
    this._narrow = value;
    this._updateMenuButton();
  }
  set route(_v) {}
  set panel(_v) {}

  connectedCallback() {
    // Master e linee sono entità: possono cambiare da automazioni o da
    // un'altra dashboard. La pagina si riallinea da sola, più spesso
    // mentre l'irrigazione è in corso (la barra di progresso deve avanzare).
    this._schedulePoll();
  }

  disconnectedCallback() {
    clearTimeout(this._timer);
    clearTimeout(this._softTimer);
  }

  _schedulePoll() {
    clearTimeout(this._timer);
    const busy = !!(this._overview && (this._overview.running || {}).active);
    this._timer = setTimeout(async () => {
      await this._refreshSilent();
      this._schedulePoll();
    }, busy ? 3000 : 30000);
  }

  /* True se il fuoco è dentro a un campo del pannello. */
  _isTyping() {
    const active = this.shadowRoot && this.shadowRoot.activeElement;
    if (!active) return false;
    return ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName);
  }

  async _refreshSilent() {
    // non ricaricare mentre l'utente sta compilando un dialogo
    if (!this._hass || this.shadowRoot.querySelector("ha-dialog")) return;
    try {
      const fresh = await this._api("GET", "overview");
      let changed = JSON.stringify(fresh) !== JSON.stringify(this._overview);
      this._overview = fresh;

      // il registro si aggiorna solo quando lo si sta guardando
      let logChanged = false;
      if (this._tab === "log") {
        const res = await this._api("GET", "log");
        const entries = (res && res.entries) || [];
        if (JSON.stringify(entries) !== JSON.stringify(this._log)) {
          this._log = entries;
          logChanged = true;
        }
      }

      // Se l'utente sta scrivendo, ridisegnare tutto gli toglierebbe il
      // campo da sotto le dita: si aggiorna solo la lista.
      if (this._isTyping()) {
        if (logChanged) this._updateLogList();
        return;
      }
      if (changed || logChanged) this._render();
    } catch (_e) {
      /* un errore di rete transitorio non deve svuotare la pagina */
    }
  }

  /* Carica i componenti dei form del frontend.
     `ha-selector` e i suoi selettori (entità, icona, tendine) vivono nel
     chunk degli editor delle card: senza forzarne il caricamento non sono
     registrati e i campi resterebbero vuoti. Creare una card e chiederne
     l'editor è il modo con cui ci si arriva dall'esterno. */
  async _warmUpComponents() {
    try {
      if (!window.loadCardHelpers) return;
      const helpers = await window.loadCardHelpers();
      const card = await helpers.createCardElement({
        type: "entities",
        entities: [],
      });
      if (card && card.constructor && card.constructor.getConfigElement) {
        await card.constructor.getConfigElement();
      }
    } catch (_e) {
      /* non bloccante: senza i selettori si usano i controlli di riserva */
    } finally {
      this._componentsReady = true;
    }
  }

  // ---------------------------------------------------------------- API

  _api(method, path, body) {
    return this._hass.callApi(method, `irrigazione_smart/${path}`, body);
  }

  async _fetchOverview() {
    this._loading = true;
    this._render();
    try {
      this._overview = await this._api("GET", "overview");
      this._error = null;
    } catch (err) {
      this._error = (err && err.message) || String(err);
    } finally {
      this._loading = false;
      this._render();
    }
  }

  async _mutate(method, path, body) {
    try {
      const res = await this._api(method, path, body);
      if (res && res.overview) this._overview = res.overview;
      this._error = null;
    } catch (err) {
      this._error = (err && err.message) || String(err);
    } finally {
      this._render();
    }
  }

  /* Salvataggio senza ridisegnare subito.

     Per i comandi che hanno già dato riscontro sullo schermo — un
     interruttore che scatta, un giorno che si accende — ridisegnare
     appena arriva la risposta fa sfarfallare la pagina e, peggio, fa
     sembrare il comando lento: si finisce per cliccare due volte. Lo
     stato viene aggiornato subito in locale, e la pagina si riallinea
     poco dopo, quando l'utente ha smesso di toccare. */
  async _mutateQuiet(method, path, body, revert) {
    try {
      const res = await this._api(method, path, body);
      if (res && res.overview) this._overview = res.overview;
      this._error = null;
      this._softRender();
    } catch (err) {
      this._error = (err && err.message) || String(err);
      if (revert) revert();
      this._render();
    }
  }

  /* Ridisegno differito: se arrivano altri clic, si rimanda ancora. */
  _softRender() {
    clearTimeout(this._softTimer);
    this._softTimer = setTimeout(() => {
      if (this._isTyping()) return;
      if (this.shadowRoot.querySelector("ha-dialog, .dlg-fallback")) return;
      this._render();
    }, 700);
  }

  // -------------------------------------------------------------- utils

  _toggleMenu() {
    this.dispatchEvent(
      new CustomEvent("hass-toggle-menu", { bubbles: true, composed: true })
    );
  }

  _liveState(entityId) {
    if (!entityId || !this._hass) return null;
    const st = this._hass.states[entityId];
    if (!st) return { missing: true, name: entityId };
    return {
      name: st.attributes.friendly_name || entityId,
      value: st.state,
      unit: st.attributes.unit_of_measurement || "",
    };
  }

  _fmtCoord(v) {
    return typeof v === "number" ? v.toFixed(4) : "—";
  }

  _updateLiveValues() {
    this.shadowRoot.querySelectorAll("[data-entity]").forEach((node) => {
      const live = this._liveState(node.getAttribute("data-entity"));
      if (live && !live.missing) {
        node.textContent = live.value + (live.unit ? " " + live.unit : "");
      }
    });
  }

  _updateMenuButton() {
    const mb = this.shadowRoot.querySelector("ha-menu-button");
    if (mb) {
      mb.hass = this._hass;
      mb.narrow = this._narrow;
    }
  }

  /* Schede: una per gruppo che abbia linee, più Prato e Aiuole sempre
     presenti — sono i due impianti che l'utente si aspetta di trovare. */
  _tabs() {
    const options = (this._overview && this._overview.options) || {};
    const order = options.categories || ["prato", "aiuole", "orto", "altro"];
    const labels = options.category_labels || {};
    const icons = options.category_icons || {};
    const zones = (this._overview && this._overview.zones) || [];

    const groupTabs = order
      .filter(
        (key) =>
          key === "prato" ||
          key === "aiuole" ||
          zones.some((z) => (z.category || "altro") === key)
      )
      .map((key) => ({
        id: `g:${key}`,
        label: labels[key] || key,
        icon: icons[key] || "mdi:sprinkler-variant",
      }));

    return [...BASE_TABS, ...groupTabs, ...TAIL_TABS];
  }

  // ------------------------------------------------------------- render

  _render() {
    this.shadowRoot.innerHTML = `
      <style>${this._css()}</style>
      <ha-top-app-bar-fixed>
        <ha-menu-button slot="navigationIcon"></ha-menu-button>
        <div slot="title" class="app-title">
          <ha-icon icon="mdi:sprinkler-variant"></ha-icon>
          <span>Irrigazione Smart</span>
        </div>
        <div class="tabs">
          ${this._tabs()
            .map(
              (t) => `<button class="tab${t.id === this._tab ? " active" : ""}" data-tab="${t.id}">
                      <ha-icon icon="${t.icon}"></ha-icon><span>${t.label}</span>
                    </button>`
            )
            .join("")}
        </div>
        <div class="content">${this._body()}</div>
      </ha-top-app-bar-fixed>
    `;
    this._updateMenuButton();
    this._bind();
  }

  _bind() {
    const sr = this.shadowRoot;
    const onClick = (sel, fn) =>
      sr.querySelectorAll(sel).forEach((el) => el.addEventListener("click", fn));

    onClick(".tab", (e) => {
      this._tab = e.currentTarget.getAttribute("data-tab");
      this._render();
    });
    onClick(".add-zone", () => this._openZoneDialog(null));
    onClick(".edit-zone", (e) =>
      this._openZoneDialog(e.currentTarget.getAttribute("data-id"))
    );
    onClick(".delete-zone", (e) =>
      this._confirmDelete(e.currentTarget.getAttribute("data-id"))
    );
    onClick(".edit-system", () => this._openSystemDialog());
    onClick(".retry", () => this._fetchOverview());
    onClick(".run-all", () => this._mutate("POST", "run", {}));
    onClick(".run-group", (e) =>
      this._mutate("POST", "run", {
        categoria: e.currentTarget.getAttribute("data-cat"),
      })
    );
    onClick(".edit-group", () => this._openGroupDialog(this._tab.slice(2)));
    onClick(".day-chip", (e) => {
      const el = e.currentTarget;
      const cat = el.getAttribute("data-cat");
      const day = el.getAttribute("data-day");
      const group = (this._overview.groups || {})[cat];
      if (!group) return;

      // il giorno si accende subito: aspettare la risposta del server
      // faceva sembrare il comando ignorato
      const acceso = el.classList.toggle("on");

      const days = new Set(group.days || []);
      if (acceso) days.add(day);
      else days.delete(day);
      // si mantiene l'ordine della settimana, non quello dei clic
      const ordered = DAY_ORDER.filter((d) => days.has(d));
      group.days = ordered;

      this._mutateQuiet("POST", `groups/${cat}`, { days: ordered }, () => {
        el.classList.toggle("on", !acceso);
        group.days = (group.days || []).filter((d) => d !== day);
      });
    });

    // Gli interruttori scattano da soli: si evita di ridisegnare subito,
    // altrimenti la pagina sfarfalla e il comando sembra lento.
    const bindToggle = (attr, field, pathFor) =>
      sr.querySelectorAll(`[${attr}]`).forEach((el) => {
        el.addEventListener("change", (e) => {
          const value = !!e.target.checked;
          const key = el.getAttribute(attr);
          this._mutateQuiet("POST", pathFor(key), { [field]: value }, () => {
            e.target.checked = !value;
          });
        });
      });

    bindToggle("data-group-toggle", "enabled", (k) => `groups/${k}`);
    bindToggle("data-group-auto", "auto", (k) => `groups/${k}`);
    onClick(".stop-all", () => this._mutate("POST", "stop", {}));
    onClick(".run-zone", (e) =>
      this._openForceDialog(e.currentTarget.getAttribute("data-id"))
    );
    this._bindDragReorder();
    onClick(".add-item", (e) =>
      this._openItemDialog(e.currentTarget.getAttribute("data-kind"), null)
    );
    onClick(".edit-item", (e) =>
      this._openItemDialog(
        e.currentTarget.getAttribute("data-kind"),
        e.currentTarget.getAttribute("data-id")
      )
    );
    onClick(".delete-item", (e) => {
      const el = e.currentTarget;
      this._mutate(
        "DELETE",
        `items/${el.getAttribute("data-kind")}/${el.getAttribute("data-id")}`
      );
    });
    onClick(".test-item", async (e) => {
      const el = e.currentTarget;
      const kind = el.getAttribute("data-kind");
      el.disabled = true;
      el.textContent = "Invio…";
      try {
        const res = await this._api(
          "POST",
          `items/${kind}/${el.getAttribute("data-id")}`,
          { test: true }
        );
        el.textContent = res && res.tested ? "Inviata" : "Fallita";
      } catch (_err) {
        el.textContent = "Fallita";
      }
      // l'esito resta visibile un istante, poi si torna al pulsante
      setTimeout(() => this._render(), 2500);
    });

    // master di notifiche e azioni
    sr.querySelectorAll("[data-flag]").forEach((el) => {
      el.addEventListener("change", (e) => {
        const value = !!e.target.checked;
        this._mutateQuiet(
          "POST",
          "system",
          { [el.getAttribute("data-flag")]: value },
          () => {
            e.target.checked = !value;
          }
        );
      });
    });
    sr.querySelectorAll("[data-item-toggle]").forEach((el) => {
      el.addEventListener("change", (e) => {
        const value = !!e.target.checked;
        this._mutateQuiet(
          "POST",
          `items/${el.getAttribute("data-kind")}/${el.getAttribute("data-item-toggle")}`,
          { enabled: value },
          () => {
            e.target.checked = !value;
          }
        );
      });
    });

    // Ricerca nel registro. Si aggiorna solo l'elenco: ridisegnare tutta
    // la pagina distruggeva il campo, il fuoco si perdeva e i tasti
    // successivi arrivavano alle scorciatoie di Home Assistant (la "e"
    // apre la ricerca delle entità).
    const search = sr.querySelector(".log-search");
    if (search) {
      search.addEventListener("input", (e) => {
        this._logQuery = e.target.value;
        this._updateLogList();
      });
    }
    const range = sr.querySelector(".log-range");
    if (range) {
      range.addEventListener("change", (e) => {
        this._logDays = Number(e.target.value);
        this._updateLogList();
      });
    }

    // I tasti premuti dentro ai nostri campi non devono raggiungere le
    // scorciatoie globali di Home Assistant.
    sr.querySelectorAll("input, select, textarea").forEach((el) => {
      el.addEventListener("keydown", (ev) => ev.stopPropagation());
      el.addEventListener("keyup", (ev) => ev.stopPropagation());
      el.addEventListener("keypress", (ev) => ev.stopPropagation());
    });

    onClick(".clear-log", async () => {
      try {
        await this._api("DELETE", "log");
        this._log = [];
      } catch (err) {
        this._error = (err && err.message) || String(err);
      }
      this._render();
    });

    // master generale
    const master = sr.querySelector("[data-master]");
    if (master) {
      master.addEventListener("change", (e) => {
        const value = !!e.target.checked;
        this._mutateQuiet("POST", "system", { master_enabled: value }, () => {
          e.target.checked = !value;
        });
      });
    }
    // master di ogni linea
    sr.querySelectorAll("[data-zone-toggle]").forEach((el) => {
      el.addEventListener("change", (e) => {
        const value = !!e.target.checked;
        this._mutateQuiet(
          "POST",
          `zones/${el.getAttribute("data-zone-toggle")}`,
          { enabled: value },
          () => {
            e.target.checked = !value;
          }
        );
      });
    });
  }

  /* Riordino per trascinamento della maniglia.
     La riga trascinata viene spostata subito nel DOM per dare riscontro
     immediato; l'ordine definitivo si invia solo al rilascio. */
  _bindDragReorder() {
    const sr = this.shadowRoot;
    const handles = sr.querySelectorAll("[data-drag]");
    if (!handles.length) return;

    let draggedId = null;

    const rowOf = (id) => sr.querySelector(`[data-zone-row="${id}"]`);

    handles.forEach((handle) => {
      const row = handle.closest("[data-zone-row]");

      handle.addEventListener("dragstart", (ev) => {
        draggedId = handle.getAttribute("data-drag");
        row.classList.add("dragging");
        ev.dataTransfer.effectAllowed = "move";
        // Firefox non avvia il trascinamento senza dati impostati
        ev.dataTransfer.setData("text/plain", draggedId);
      });

      handle.addEventListener("dragend", () => {
        row.classList.remove("dragging");
        draggedId = null;
      });
    });

    sr.querySelectorAll("[data-zone-row]").forEach((row) => {
      row.addEventListener("dragover", (ev) => {
        if (!draggedId) return;
        ev.preventDefault();
        const dragged = rowOf(draggedId);
        if (!dragged || dragged === row) return;

        // sopra o sotto, secondo la metà della riga in cui si è
        const box = row.getBoundingClientRect();
        const after = ev.clientY > box.top + box.height / 2;
        row.parentNode.insertBefore(dragged, after ? row.nextSibling : row);
      });

      row.addEventListener("drop", (ev) => {
        ev.preventDefault();
        const order = [...sr.querySelectorAll("[data-zone-row]")].map((r) =>
          r.getAttribute("data-zone-row")
        );
        this._mutate("POST", "zones/reorder", { order });
      });
    });
  }

  _body() {
    if (this._loading && !this._overview) {
      return `<div class="empty">Caricamento…</div>`;
    }
    if (this._error && !this._overview) {
      return `<ha-alert alert-type="error" title="Errore">${esc(this._error)}</ha-alert>
              ${this._button("retry", "Riprova", { primary: true })}`;
    }
    if (!this._overview || !this._overview.configured) {
      return `<ha-alert alert-type="info" title="Non ancora configurata">
        Aggiungi l'integrazione da Impostazioni → Dispositivi e servizi per
        impostare posizione e sensori.
      </ha-alert>`;
    }

    const err = this._error
      ? `<ha-alert alert-type="error">${esc(this._error)}</ha-alert>`
      : "";

    if (this._tab.startsWith("g:")) return err + this._groupTab(this._tab.slice(2));
    if (this._tab === "meteo") return err + this._meteoTab();
    if (this._tab === "log") return err + this._logTab();
    if (this._tab === "azioni") return err + this._actionsTab();
    return err + this._dashboardTab();
  }

  // ------------------------------------------------------ NOTIFICHE/AZIONI

  _actionsTab() {
    const sys = this._overview.system;
    const notifications = this._overview.notifications || [];
    const actions = this._overview.actions || [];
    const hookLabels = (this._overview.options || {}).hook_labels || {};

    const list = (items, kind, emptyText) =>
      items.length
        ? items
            .map(
              (it) => `<div class="row${it.enabled ? "" : " dim"}">
          <ha-icon icon="${kind === "notifications" ? "mdi:bell-outline" : "mdi:flash-outline"}"></ha-icon>
          <div class="row-main">
            <span class="row-label">${esc(it.name)}</span>
            <span class="sub">${esc(it.service || "servizio non impostato")} · ${esc(
              hookLabels[kind === "notifications" ? it.trigger : it.hook] || ""
            )}</span>
          </div>
          <button type="button" class="btn test-item" data-kind="${kind}" data-id="${it.id}">Prova</button>
          <ha-icon-button class="edit-item" data-kind="${kind}" data-id="${it.id}" label="Modifica">
            <ha-icon icon="mdi:pencil"></ha-icon>
          </ha-icon-button>
          <ha-icon-button class="delete-item" data-kind="${kind}" data-id="${it.id}" label="Elimina">
            <ha-icon icon="mdi:delete"></ha-icon>
          </ha-icon-button>
          <ha-switch data-item-toggle="${it.id}" data-kind="${kind}" ${it.enabled ? "checked" : ""}></ha-switch>
        </div>`
            )
            .join("")
        : `<div class="empty-state">
             <ha-icon icon="${kind === "notifications" ? "mdi:bell-off-outline" : "mdi:flash-off"}"></ha-icon>
             <p>${esc(emptyText)}</p>
           </div>`;

    return `
      <ha-card><div class="inner">
        <div class="card-head">
          <ha-icon icon="mdi:bell-outline"></ha-icon>
          <h2>Notifiche</h2>
          <span class="spacer"></span>
          <ha-switch data-flag="notifications_enabled" ${sys.notifications_enabled ? "checked" : ""}></ha-switch>
        </div>
        <p class="muted small nomargin">
          Inviate quando l'irrigazione raggiunge il momento scelto. Il servizio
          può essere una notifica o un tuo script. Master spento: non parte nulla.
        </p>
        ${list(notifications, "notifications", "Nessuna notifica configurata.")}
        <div class="actions">
          <button type="button" class="btn primary add-item" data-kind="notifications">Aggiungi notifica</button>
        </div>
      </div></ha-card>

      <ha-card><div class="inner">
        <div class="card-head">
          <ha-icon icon="mdi:flash-outline"></ha-icon>
          <h2>Azioni</h2>
          <span class="spacer"></span>
          <ha-switch data-flag="actions_enabled" ${sys.actions_enabled ? "checked" : ""}></ha-switch>
        </div>
        <p class="muted small nomargin">
          Chiamano un servizio nei momenti chiave dell'irrigazione: impostare un
          numero, avviare uno script, accendere una pompa.
        </p>
        ${list(actions, "actions", "Nessuna azione configurata.")}
        <div class="actions">
          <button type="button" class="btn primary add-item" data-kind="actions">Aggiungi azione</button>
        </div>
      </div></ha-card>`;
  }

  _itemSpecs(kind, options) {
    const hooks = options.hooks || [];
    const labels = options.hook_labels || {};
    const common = [
      { key: "name", label: "Nome", type: "text" },
      {
        key: "service", label: "Servizio da chiamare", type: "text",
        helper: "Es. notify.mobile_app_telefono, oppure script.mio_script",
      },
    ];

    if (kind === "notifications") {
      return [
        ...common,
        {
          key: "trigger", label: "Quando inviarla", type: "select",
          options: hooks, labels,
        },
        { key: "title", label: "Titolo", type: "text" },
        {
          key: "message", label: "Messaggio", type: "text",
          helper: `Segnaposto: ${PLACEHOLDERS}`,
        },
        { key: "enabled", label: "Attiva", type: "boolean" },
      ];
    }
    return [
      ...common,
      { key: "hook", label: "Quando eseguirla", type: "select", options: hooks, labels },
      {
        key: "data", label: "Dati (JSON)", type: "text",
        helper: `Es. {"entity_id": "switch.pompa"}. Segnaposto: ${PLACEHOLDERS}`,
      },
      { key: "enabled", label: "Attiva", type: "boolean" },
    ];
  }

  _openItemDialog(kind, itemId) {
    const options = this._overview.options || {};
    const items = this._overview[kind] || [];
    const existing = itemId ? items.find((i) => i.id === itemId) : null;

    const initial = existing
      ? { ...existing }
      : kind === "notifications"
      ? {
          name: "", service: "", trigger: "after_irrigation",
          title: "Irrigazione",
          message: "Irrigazione conclusa: {completate} linee in {durata} min",
          enabled: true,
        }
      : { name: "", service: "", hook: "after_irrigation", data: "{}", enabled: true };

    const isNotif = kind === "notifications";
    this._showForm(
      existing
        ? isNotif ? "Modifica notifica" : "Modifica azione"
        : isNotif ? "Nuova notifica" : "Nuova azione",
      this._itemSpecs(kind, options),
      initial,
      async (values) => {
        const data = { ...values };
        if (!data.name) data.name = isNotif ? "Notifica" : "Azione";
        if (existing) await this._mutate("POST", `items/${kind}/${existing.id}`, data);
        else await this._mutate("POST", `items/${kind}`, data);
      },
      existing ? "Salva" : "Aggiungi"
    );
  }

  // -------------------------------------------------------- SCHEDA GRUPPO

  /* Quando partirà, detto in italiano. */
  _nextRunText(next) {
    if (!next || !next.scheduled) {
      return {
        text: {
          master_disattivo: "il master generale è spento",
          gruppo_disattivato: "questo gruppo è disattivato",
          avvio_automatico_spento: "avvio automatico spento: parte solo a mano",
          nessun_giorno_attivo: "nessun giorno attivo",
          finestra_non_valida: "orario di inizio non valido",
        }[(next || {}).reason] || "non programmato",
        ok: false,
      };
    }
    const d = new Date(next.when);
    const two = (n) => String(n).padStart(2, "0");
    const ora = `${two(d.getHours())}:${two(d.getMinutes())}`;
    if (next.today) return { text: `oggi alle ${ora}`, ok: true };
    const giorno = d.toLocaleDateString("it-IT", { weekday: "long" });
    return { text: `${giorno} alle ${ora}`, ok: true };
  }

  _groupTab(category) {
    const groups = this._overview.groups || {};
    const group = groups[category];
    const options = this._overview.options || {};
    const label = (options.category_labels || {})[category] || category;
    const icon = (options.category_icons || {})[category] || "mdi:sprinkler-variant";
    const zones = (this._overview.zones || []).filter(
      (z) => (z.category || "altro") === category
    );

    if (!group) return `<ha-alert alert-type="error">Gruppo sconosciuto.</ha-alert>`;

    const w = group.window || {};
    const next = this._nextRunText(group.next_run);
    const days = group.days || [];

    const dayChips = DAY_ORDER.map(
      (d) => `<button type="button" class="day-chip${days.includes(d) ? " on" : ""}"
                 data-day="${d}" data-cat="${esc(category)}">${DAY_LABELS[d]}</button>`
    ).join("");

    return `
      <ha-card><div class="inner">
        <div class="master-row">
          <div class="master-icon${group.enabled ? " on" : ""}">
            <ha-icon icon="${esc(icon)}"></ha-icon>
          </div>
          <div class="master-main">
            <span class="master-title">${esc(label)}</span>
            <span class="sub">${zones.length} ${zones.length === 1 ? "linea" : "linee"} · prossima irrigazione ${esc(next.text)}</span>
          </div>
          <ha-switch data-group-toggle="${esc(category)}" ${group.enabled ? "checked" : ""}></ha-switch>
        </div>
      </div></ha-card>

      <ha-card><div class="inner">
        <div class="card-head">
          <ha-icon icon="mdi:calendar-clock"></ha-icon>
          <h2>Quando irrigare</h2>
          <span class="spacer"></span>
          ${this._button("edit-group", "Modifica", {})}
        </div>
        <p class="muted small nomargin">
          Il sistema decide da solo <b>quanta</b> acqua serve. Qui si stabilisce
          soltanto <b>quando</b> può darla: all'orario di inizio, nei giorni
          attivi, parte e irriga le linee sotto soglia.
        </p>

        <div class="row">
          <ha-icon icon="mdi:clock-outline"></ha-icon>
          <div class="row-main">
            <span class="row-label">Finestra ${esc(w.label || "")}</span>
            <span class="sub">${esc(w.quality_reason || "")}</span>
          </div>
          <span class="badge q-${esc(w.quality)}">${esc(w.quality || "")}</span>
        </div>

        <div class="row">
          <ha-icon icon="mdi:play-circle-outline"></ha-icon>
          <div class="row-main">
            <span class="row-label">Avvio automatico</span>
            <span class="sub">${group.auto ? esc(next.text) : "spento: parte solo a mano"}</span>
          </div>
          <ha-switch data-group-auto="${esc(category)}" ${group.auto ? "checked" : ""}></ha-switch>
        </div>

        <div class="days-row">
          <span class="fld-label">Giorni attivi</span>
          <div class="day-chips">${dayChips}</div>
        </div>
      </div></ha-card>

      ${this._groupScheduleCard(group, label, category)}

      <div class="tab-actions">
        ${this._button("add-zone", "Aggiungi linea", { primary: true })}
      </div>
      ${
        zones.length
          ? `<ha-card><div class="inner">
               <div class="card-head">
                 <ha-icon icon="${esc(icon)}"></ha-icon><h2>Linee</h2>
               </div>
               ${zones.map((z) => this._zoneRow(z)).join("")}
             </div></ha-card>`
          : `<ha-card><div class="inner"><div class="empty-state">
               <ha-icon icon="mdi:sprinkler-variant"></ha-icon>
               <p>Nessuna linea in questo gruppo.</p>
             </div></div></ha-card>`
      }`;
  }

  /* Programma del gruppo: cosa farà alla prossima partenza. */
  _groupScheduleCard(group, label, category) {
    const sched = group.schedule || {};
    const runs = sched.runs || [];
    const busy = !!(this._overview.running || {}).active;

    if (!runs.length) {
      return `<ha-card><div class="inner">
        <div class="card-head">
          <ha-icon icon="mdi:playlist-check"></ha-icon>
          <h2>Programma</h2>
        </div>
        <div class="empty-state">
          <ha-icon icon="mdi:water-check"></ha-icon>
          <p>Nessuna irrigazione necessaria adesso.</p>
          <p class="muted small">
            Non è un errore: il terreno di ${esc(label.toLowerCase())} non ha ancora
            perso abbastanza acqua per superare la soglia. Quando la supererà,
            l'irrigazione partirà da sola alla prossima finestra utile.
          </p>
        </div>
      </div></ha-card>`;
    }

    const util = Number(sched.utilization || 0);
    return `<ha-card><div class="inner">
      <div class="card-head">
        <ha-icon icon="mdi:playlist-check"></ha-icon>
        <h2>Programma</h2>
        <span class="spacer"></span>
        ${
          busy
            ? ""
            : `<button type="button" class="btn primary run-group" data-cat="${esc(category)}">Avvia ora</button>`
        }
      </div>
      ${runs
        .map(
          (r) => `<div class="row">
            <ha-icon icon="mdi:clock-outline"></ha-icon>
            <div class="row-main">
              <span class="row-label">${esc(r.zone_name)}</span>
              <span class="sub">${r.cycles > 1 ? r.cycles + " cicli" : "ciclo unico"}</span>
            </div>
            <span class="reading small">${esc(r.start)}–${esc(r.end)}</span>
            <span class="badge run">${r.minutes} min</span>
          </div>`
        )
        .join("")}
      <div class="bar big">
        <div class="bar-fill${sched.fits ? "" : " over"}" style="width:${Math.min(100, util)}%"></div>
      </div>
      <div class="zone-meta">
        <span>${sched.total_minutes} min su ${sched.window_minutes} disponibili</span>
        <span class="spacer"></span>
        <span class="${sched.fits ? "muted" : "warntext"}">${util}%</span>
      </div>
      ${
        sched.fits
          ? ""
          : `<ha-alert alert-type="warning">La sequenza sfora la finestra di ${sched.overflow_minutes} min.</ha-alert>`
      }
    </div></ha-card>`;
  }

  // ---------------------------------------------------------------- LOG

  async _fetchLog() {
    try {
      const res = await this._api("GET", "log");
      this._log = (res && res.entries) || [];
    } catch (_e) {
      this._log = [];
    }
    this._render();
  }

  /* Intestazione di giornata: "Oggi" e "Ieri" si leggono meglio di una
     data, quando si sta cercando cos'è successo stanotte. */
  _dayLabel(date) {
    const today = new Date();
    const sameDay = (a, b) =>
      a.getDate() === b.getDate() &&
      a.getMonth() === b.getMonth() &&
      a.getFullYear() === b.getFullYear();

    if (sameDay(date, today)) return "Oggi";
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (sameDay(date, yesterday)) return "Ieri";

    return date.toLocaleDateString("it-IT", {
      weekday: "long", day: "numeric", month: "long",
    });
  }

  /* Voci filtrate e raggruppate per giornata. Separato dal disegno, così
     scrivendo nella ricerca si può aggiornare la sola lista senza
     ricostruire la pagina — e senza perdere il fuoco dal campo. */
  _logGroups() {
    const days = this._logDays ?? 7;
    const query = (this._logQuery || "").trim().toLowerCase();

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    cutoff.setHours(0, 0, 0, 0);

    const filtered = (this._log || []).filter((e) => {
      const d = new Date(e.ts);
      if (!isNaN(d) && days > 0 && d < cutoff) return false;
      return !query || (e.text || "").toLowerCase().includes(query);
    });

    // raggruppamento per giornata, mantenendo l'ordine (più recente prima)
    const groups = [];
    filtered.forEach((entry) => {
      const d = new Date(entry.ts);
      const key = isNaN(d) ? "?" : d.toDateString();
      let group = groups.find((g) => g.key === key);
      if (!group) {
        group = { key, label: isNaN(d) ? "Data ignota" : this._dayLabel(d), items: [] };
        groups.push(group);
      }
      group.items.push(entry);
    });

    return { groups, filtered };
  }

  _logListHtml() {
    const { groups } = this._logGroups();
    const two = (n) => String(n).padStart(2, "0");
    return groups.length
      ? groups
          .map(
            (g) => `<div class="log-day">${esc(g.label)}</div>
        ${g.items
          .map((e) => {
            const d = new Date(e.ts);
            const when = isNaN(d) ? "" : `${two(d.getHours())}:${two(d.getMinutes())}`;
            return `<div class="row log-row lv-${esc(e.level)}">
              <span class="log-time">${esc(when)}</span>
              <ha-icon icon="${LOG_ICONS[e.kind] || "mdi:information-outline"}"></ha-icon>
              <div class="row-main"><span class="row-label">${esc(e.text)}</span></div>
            </div>`;
          })
          .join("")}`
          )
          .join("")
      : `<div class="empty-state">
           <ha-icon icon="mdi:history"></ha-icon>
           <p>${this._log.length ? "Nessun risultato." : "Nessuna attività registrata."}</p>
           <p class="muted small">${
             this._log.length
               ? "Prova ad allargare il periodo o a cambiare la ricerca."
               : "Qui finiscono avvii, irrigazioni concluse e linee non partite."
           }</p>
         </div>`;
  }

  _logTab() {
    if (this._log === undefined) {
      this._fetchLog();
      return `<div class="empty">Caricamento…</div>`;
    }

    const days = this._logDays ?? 7;
    const { filtered } = this._logGroups();

    const ranges = [
      { value: 1, label: "Oggi" },
      { value: 7, label: "Ultimi 7 giorni" },
      { value: 30, label: "Ultimi 30 giorni" },
      { value: 0, label: "Tutto" },
    ];

    return `<ha-card><div class="inner">
      <div class="card-head">
        <ha-icon icon="mdi:format-list-bulleted"></ha-icon>
        <h2>Attività</h2>
        <span class="spacer"></span>
        ${this._button("clear-log", "Svuota")}
      </div>

      <div class="log-tools">
        <div class="ha-field grow">
          <div class="ha-field-box">
            <ha-icon class="ha-field-lead" icon="mdi:magnify"></ha-icon>
            <input class="ha-control with-lead log-search" type="search"
                   placeholder="Cerca nel registro" value="${esc(this._logQuery || "")}">
          </div>
        </div>
        <div class="ha-field">
          <div class="ha-field-box">
            <select class="ha-control log-range">
              ${ranges
                .map(
                  (r) =>
                    `<option value="${r.value}"${r.value === days ? " selected" : ""}>${r.label}</option>`
                )
                .join("")}
            </select>
            <ha-icon class="ha-field-arrow" icon="mdi:menu-down"></ha-icon>
          </div>
        </div>
      </div>
      <p class="muted small nomargin log-count">${filtered.length} di ${this._log.length} voci</p>

      <div class="log-list">${this._logListHtml()}</div>
    </div></ha-card>`;
  }

  /* Aggiorna solo l'elenco e il conteggio: il campo di ricerca resta lo
     stesso elemento, quindi non perde il fuoco e i tasti successivi non
     finiscono alle scorciatoie di Home Assistant. */
  _updateLogList() {
    const list = this.shadowRoot.querySelector(".log-list");
    if (list) list.innerHTML = this._logListHtml();

    const count = this.shadowRoot.querySelector(".log-count");
    if (count) {
      const { filtered } = this._logGroups();
      count.textContent = `${filtered.length} di ${(this._log || []).length} voci`;
    }
  }

  // --------------------------------------------------------- DASHBOARD

  _dashboardTab() {
    const sys = this._overview.system;
    const zones = this._overview.zones || [];
    const sched = this._overview.schedule || {};
    const running = zones.filter((z) => (z.computed || {}).plan?.should_run);

    return `
      ${this._runningCard()}
      ${this._masterCard(sys, zones, running, sched)}
      ${this._linesCard(zones)}
      ${this._sequenceCard(sched, sys)}
      ${this._systemCard(sys)}
    `;
  }

  /* Mostrata solo mentre l'irrigazione è davvero in corso: la barra
     avanza sul tempo della linea corrente. */
  _runningCard() {
    const r = this._overview.running || {};
    if (!r.active) return "";

    const phase = {
      irrigazione: "in irrigazione",
      assorbimento: "pausa di assorbimento",
      pausa_tra_linee: "pausa tra le linee",
    }[r.phase] || r.phase || "";

    const pct = Number(r.progress || 0);
    return `<ha-card class="running"><div class="inner">
      <div class="master-row">
        <div class="master-icon on pulse"><ha-icon icon="mdi:sprinkler-variant"></ha-icon></div>
        <div class="master-main">
          <span class="master-title">${esc(r.zone_name || "Irrigazione in corso")}</span>
          <span class="sub">${esc(phase)}${
            r.cycles > 1 ? ` · ciclo ${r.cycle}/${r.cycles}` : ""
          }</span>
        </div>
        ${this._button("stop-all", "Ferma", { danger: true })}
      </div>
      ${
        r.phase === "irrigazione"
          ? `<div class="bar big"><div class="bar-fill" style="width:${pct}%"></div></div>
             <div class="zone-meta">
               <span>${r.elapsed_min ?? 0} di ${r.zone_total_min ?? 0} min</span>
               <span class="spacer"></span><span class="muted">${pct}%</span>
             </div>`
          : ""
      }
    </div></ha-card>`;
  }

  _masterCard(sys, zones, running, sched) {
    const on = !!sys.master_enabled;
    const w = sys.window || {};
    const enabled = zones.filter((z) => z.enabled).length;
    const busy = !!(this._overview.running || {}).active;

    return `<ha-card><div class="inner">
        <div class="master-row">
          <div class="master-icon${on ? " on" : ""}">
            <ha-icon icon="${on ? "mdi:water" : "mdi:water-off"}"></ha-icon>
          </div>
          <div class="master-main">
            <span class="master-title">Irrigazione ${on ? "attiva" : "disattivata"}</span>
            <span class="sub">${
              on
                ? `finestra ${esc(w.label || "")}`
                : "il master generale è spento: nessuna linea verrà irrigata"
            }</span>
          </div>
          <ha-switch data-master ${on ? "checked" : ""}></ha-switch>
        </div>
        <div class="grid">
          <div class="cell"><span class="k">Linee attive</span><span class="v">${enabled}<span class="of">/${zones.length}</span></span></div>
          <div class="cell"><span class="k">Chiedono acqua</span><span class="v">${running.length}</span></div>
          <div class="cell"><span class="k">Tempo totale</span><span class="v">${sched.total_minutes || 0}<span class="of"> min</span></span></div>
        </div>
        ${this._flowRow()}
        ${
          on && !busy
            ? `<div class="actions">${this._button("run-all", "Avvia irrigazione ora", { primary: true })}</div>`
            : ""
        }
      </div></ha-card>`;
  }

  /* Flussostato: sola lettura, come richiesto. Non blocca nulla. */
  _flowRow() {
    const f = this._overview.flow || {};
    if (!f.configured) return "";
    return `<div class="row">
      <ha-icon icon="mdi:waves-arrow-right"></ha-icon>
      <div class="row-main">
        <span class="row-label">Flusso</span>
        <span class="sub">${esc(f.name || f.entity_id)} · solo lettura</span>
      </div>
      ${
        f.available
          ? `<span class="reading" data-entity="${esc(f.entity_id)}">${esc(f.value)}${f.unit ? " " + esc(f.unit) : ""}</span>`
          : `<span class="badge warn">non disponibile</span>`
      }
    </div>`;
  }

  /* Raggruppa le linee per categoria, nell'ordine previsto, saltando i
     gruppi vuoti. Prato e aiuole hanno irrigatori diversi: tenerli
     mescolati in un unico elenco confonde. */
  _groupZones(zones) {
    const options = this._overview.options || {};
    const order = options.categories || ["prato", "aiuole", "orto", "altro"];
    const labels = options.category_labels || {};
    const icons = options.category_icons || {};

    return order
      .map((key) => ({
        key,
        label: labels[key] || key,
        icon: icons[key] || "mdi:sprinkler-variant",
        zones: zones.filter((z) => (z.category || "altro") === key),
      }))
      .filter((group) => group.zones.length);
  }

  _linesCard(zones) {
    if (!zones.length) {
      return `<ha-card><div class="inner">
        <div class="card-head"><ha-icon icon="mdi:pipe"></ha-icon><h2>Linee</h2></div>
        <div class="empty-state">
          <ha-icon icon="mdi:sprinkler-variant"></ha-icon>
          <p>Nessuna linea configurata.</p>
          <p class="muted small">Vai nella scheda <b>Zone</b> per crearne una.</p>
        </div>
      </div></ha-card>`;
    }

    const running = this._overview.running || {};
    const busyNow = !!running.active;
    const groups = this._groupZones(zones);

    const rowFor = (z) => {
      const c = z.computed || {};
      const plan = c.plan || {};
      const st = zoneStatus(z, running.active ? running.zone_id : null);
      const deficit = Number(z.deficit_mm || 0);
      const thr = Number(c.trigger_threshold_mm || 0);
      const busy = !!running.active;

      // "irriga oggi" è l'informazione che si cerca per prima guardando
      // la dashboard: la si mostra come stato, non nascosta nei dettagli.
      let state;
      if (st.level === "watering") {
        state = `<span class="badge run">in irrigazione</span>`;
      } else if (plan.should_run) {
        state = `<span class="badge run">irriga oggi · ${plan.total_minutes} min</span>`;
      } else if (isBlocked(plan.reason)) {
        state = `<span class="badge warn">${esc(reasonLabel(plan.reason))}</span>`;
      } else {
        state = `<span class="badge ok">${esc(reasonLabel(plan.reason) || "ok")}</span>`;
      }

      return `<div class="row line${z.enabled ? "" : " dim"}">
        <span class="dot st-${st.level}" title="${esc(st.label)}"></span>
        <ha-icon icon="${esc(z.icon || ZONE_TYPE_ICONS[z.zone_type] || "mdi:pipe-valve")}"></ha-icon>
        <div class="row-main">
          <span class="row-label">${esc(z.name)}</span>
          <span class="sub">${deficit.toFixed(1)} / ${thr.toFixed(1)} mm${this._lastRunText(z)}</span>
        </div>
        ${state}
        ${
          z.enabled && !busy
            ? `<ha-icon-button class="run-zone" data-id="${z.id}" label="Irriga ora" title="Irriga ora">
                 <ha-icon icon="mdi:play-circle-outline"></ha-icon>
               </ha-icon-button>`
            : ""
        }
        <ha-switch data-zone-toggle="${z.id}" ${z.enabled ? "checked" : ""}></ha-switch>
      </div>`;
    };

    // Una card per gruppo: prato e aiuole si comandano separatamente.
    return groups
      .map((group) => {
        const chiedono = group.zones.filter(
          (z) => ((z.computed || {}).plan || {}).should_run
        ).length;
        const attive = group.zones.filter((z) => z.enabled).length;

        return `<ha-card><div class="inner">
          <div class="card-head">
            <ha-icon icon="${esc(group.icon)}"></ha-icon>
            <h2>${esc(group.label)}</h2>
            <span class="sub">${attive}/${group.zones.length} attive</span>
            <span class="spacer"></span>
            ${
              chiedono && !busyNow
                ? `<button type="button" class="btn primary run-group" data-cat="${esc(group.key)}">
                     Irriga ${esc(group.label.toLowerCase())}
                   </button>`
                : chiedono
                ? `<span class="badge run">${chiedono} in attesa</span>`
                : `<span class="badge ok">a posto</span>`
            }
          </div>
          ${group.zones.map(rowFor).join("")}
        </div></ha-card>`;
      })
      .join("");
  }

  /* Ultima irrigazione: le forzature si segnalano ma restano secondarie
     rispetto a quelle automatiche. */
  _lastRunText(z) {
    if (!z.last_irrigation) return "";
    const d = new Date(z.last_irrigation);
    if (isNaN(d)) return "";
    const two = (n) => String(n).padStart(2, "0");
    const when = `${two(d.getDate())}/${two(d.getMonth() + 1)} ${two(d.getHours())}:${two(d.getMinutes())}`;
    const forced = z.last_trigger === "forzata" ? " (forzata)" : "";
    return ` · ultima ${when}${forced}`;
  }

  _sequenceCard(sched, sys) {
    const runs = sched.runs || [];
    const body = runs.length
      ? runs.map((r) => `<div class="row">
            <ha-icon icon="mdi:clock-outline"></ha-icon>
            <div class="row-main">
              <span class="row-label">${esc(r.zone_name)}</span>
              <span class="sub">${r.cycles > 1 ? r.cycles + " cicli" : "ciclo unico"}</span>
            </div>
            <span class="reading small">${esc(r.start)}–${esc(r.end)}</span>
            <span class="badge run">${r.minutes} min</span>
          </div>`).join("")
      : `<div class="empty-state">
           <ha-icon icon="mdi:water-check"></ha-icon>
           <p>Nessuna irrigazione necessaria adesso.</p>
           <p class="muted small">
             Non c'è nessun programma da creare: il sistema calcola da solo
             quanta acqua serve e irriga quando il terreno scende sotto
             soglia. Gli orari e i giorni si impostano nelle schede dei
             singoli gruppi.
           </p>
         </div>`;

    const util = Number(sched.utilization || 0);
    const capacity = runs.length
      ? `<div class="bar big">
           <div class="bar-fill${sched.fits ? "" : " over"}" style="width:${Math.min(100, util)}%"></div>
         </div>
         <div class="zone-meta">
           <span>${sched.total_minutes} min su ${sched.window_minutes} disponibili</span>
           <span class="spacer"></span>
           <span class="${sched.fits ? "muted" : "warntext"}">${util}%</span>
         </div>
         ${
           sched.fits
             ? ""
             : `<ha-alert alert-type="warning">La sequenza sfora la finestra di ${sched.overflow_minutes} min.</ha-alert>`
         }
         ${
           (sched.dropped || []).length
             ? `<ha-alert alert-type="warning">Escluse per mancanza di tempo: ${esc((sched.dropped || []).join(", "))}</ha-alert>`
             : ""
         }`
      : "";

    return `<ha-card><div class="inner">
      <div class="card-head">
        <ha-icon icon="mdi:playlist-play"></ha-icon>
        <h2>Programma di irrigazione</h2>
        <span class="spacer"></span>
        <span class="sub">tutte le linee</span>
      </div>
      ${body}
      ${capacity}
    </div></ha-card>`;
  }

  // -------------------------------------------------------------- ZONE

  _zoneRow(z) {
    const c = z.computed || {};
    const plan = c.plan || {};
    const deficit = Number(z.deficit_mm || 0);
    const threshold = Number(c.trigger_threshold_mm || 0);
    const taw = Number(c.taw_mm || 0);
    const pct = taw > 0 ? Math.min(100, (deficit / taw) * 100) : 0;
    const thrPct = taw > 0 ? Math.min(100, (threshold / taw) * 100) : 0;

    let status;
    if (plan.should_run) {
      status = `<span class="badge run">${plan.total_minutes} min · ${plan.cycles} ${plan.cycles > 1 ? "cicli" : "ciclo"}</span>`;
    } else if (isBlocked(plan.reason)) {
      status = `<span class="badge warn">${esc(reasonLabel(plan.reason))}</span>`;
    } else {
      status = `<span class="badge ok">${esc(reasonLabel(plan.reason) || "sotto soglia")}</span>`;
    }

    const valve = z.valve_entity
      ? `<span class="chip"><ha-icon icon="mdi:valve"></ha-icon>${esc(z.valve_entity)}</span>`
      : `<span class="chip warnchip"><ha-icon icon="mdi:valve"></ha-icon>nessuna valvola</span>`;

    return `<div class="zone${z.enabled ? "" : " dim"}" data-zone-row="${z.id}">
      <div class="zone-head">
        <span class="drag-handle" draggable="true" data-drag="${z.id}" title="Trascina per riordinare">
          <ha-icon icon="mdi:drag-horizontal-variant"></ha-icon>
        </span>
        <ha-switch data-zone-toggle="${z.id}" ${z.enabled ? "checked" : ""}></ha-switch>
        <ha-icon class="zone-icon" icon="${esc(z.icon || ZONE_TYPE_ICONS[z.zone_type] || "mdi:sprinkler")}"></ha-icon>
        <div class="zone-title">
          <span class="zone-name">${esc(z.name)}</span>
          <span class="sub">${esc(label(ZONE_TYPE_LABELS, z.zone_type))} · ${esc(label(SOIL_LABELS, c.soil))} · ${esc(label(EMITTER_LABELS, z.emitter))}</span>
        </div>
        ${status}
        <ha-icon-button class="edit-zone" data-id="${z.id}" label="Modifica">
          <ha-icon icon="mdi:pencil"></ha-icon>
        </ha-icon-button>
        <ha-icon-button class="delete-zone" data-id="${z.id}" label="Elimina">
          <ha-icon icon="mdi:delete"></ha-icon>
        </ha-icon-button>
      </div>

      <div class="bar" title="Deficit ${deficit.toFixed(1)} mm su TAW ${taw.toFixed(1)} mm">
        <div class="bar-fill${deficit >= threshold ? " over" : ""}" style="width:${pct}%"></div>
        <div class="bar-thr" style="left:${thrPct}%"></div>
      </div>
      <div class="zone-meta">
        <span><b>${deficit.toFixed(1)}</b> mm deficit</span>
        <span class="muted">soglia ${threshold.toFixed(1)} · TAW ${taw.toFixed(1)} mm · ${z.rate_mm_h} mm/h</span>
        <span class="spacer"></span>
        ${valve}
      </div>
      ${
        plan.should_run
          ? `<div class="zone-plan">
               <ha-icon icon="mdi:water"></ha-icon>
               <span>${plan.minutes_per_cycle} min × ${plan.cycles}${plan.soak_minutes ? ` con pause di ${plan.soak_minutes} min` : ""} · ${plan.gross_mm} mm lordi</span>
               ${plan.capped ? `<span class="badge warn">troncato dal tetto</span>` : ""}
             </div>`
          : ""
      }
    </div>`;
  }

  _systemCard(sys) {
    return `<ha-card><div class="inner">
        <div class="card-head">
          <ha-icon icon="mdi:cog-outline"></ha-icon>
          <h2>Impostazioni comuni</h2>
          <span class="spacer"></span>
          ${this._button("edit-system", "Modifica")}
        </div>
        <p class="muted small nomargin">
          Valgono per tutti i gruppi. Orari e giorni si impostano invece
          nella scheda di ciascun gruppo.
        </p>
        <div class="row">
          <ha-icon icon="mdi:shovel"></ha-icon>
          <div class="row-main"><span class="row-label">Terreno predefinito</span></div>
          <span class="reading small">${esc(label(SOIL_LABELS, sys.soil))}</span>
        </div>
        <div class="row">
          <ha-icon icon="mdi:weather-windy"></ha-icon>
          <div class="row-main"><span class="row-label">Blocchi meteo</span>
            <span class="sub">vento oltre ${sys.wind_max_kmh} km/h · pioggia prevista oltre ${sys.rain_forecast_max_mm} mm</span>
          </div>
        </div>
        <div class="row">
          <ha-icon icon="mdi:timer-sand"></ha-icon>
          <div class="row-main"><span class="row-label">Pause</span>
            <span class="sub">assorbimento ${sys.soak_minutes} min · tra linee ${sys.gap_minutes} min</span>
          </div>
        </div>
      </div></ha-card>`;
  }

  // ------------------------------------------------------------- METEO

  _meteoTab() {
    return `${this._et0Card()}${this._sensorsCard(this._overview.system)}${this._locationCard(this._overview.system)}`;
  }

  _et0Card() {
    const m = this._overview.meteo || {};
    const num = (v, unit, dec = 1) =>
      v == null ? "—" : `${Number(v).toFixed(dec)}${unit ? " " + unit : ""}`;
    const et0 = m.last_et0_mm;
    const method = ET0_METHOD_LABELS[m.last_et0_method] || m.last_et0_method || "";
    const when = m.last_update ? new Date(m.last_update) : null;
    const hhmm = when
      ? `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`
      : "—";

    return `<ha-card><div class="inner">
        <div class="card-head">
          <ha-icon icon="mdi:chart-bell-curve-cumulative"></ha-icon>
          <h2>Bilancio idrico</h2>
          <span class="spacer"></span>
          <span class="sub">aggiornato ${hhmm}</span>
        </div>
        ${
          et0 == null
            ? `<ha-alert alert-type="info">
                 Nessun giorno ancora chiuso. L'ET0 viene calcolato dopo la
                 mezzanotte, sui dati accumulati nella giornata.
               </ha-alert>`
            : `<div class="et0">
                 <div class="et0-value"><b>${Number(et0).toFixed(2)}</b> <span>mm</span></div>
                 <div class="et0-meta">
                   <span class="row-label">ET0 del ${esc(m.last_closed_date || "")}</span>
                   <span class="sub">${esc(method)}</span>
                 </div>
               </div>`
        }
        <div class="form-section">Accumulo di oggi</div>
        <div class="grid">
          <div class="cell"><span class="k">T min</span><span class="v">${num(m.t_min, "°C")}</span></div>
          <div class="cell"><span class="k">T max</span><span class="v">${num(m.t_max, "°C")}</span></div>
          <div class="cell"><span class="k">Pioggia</span><span class="v">${num(m.rain_mm, "mm")}</span></div>
          <div class="cell"><span class="k">Umidità media</span><span class="v">${num(m.rh_mean, "%", 0)}</span></div>
          <div class="cell"><span class="k">Vento medio</span><span class="v">${num(m.wind_mean_kmh, "km/h")}</span></div>
        </div>
      </div></ha-card>`;
  }

  _sensorsCard(sys) {
    const hasWeather = !!sys.weather_entity;
    const sources = (this._overview.meteo || {}).sources || {};
    const rows = SENSORS.map((s) => {
      const entityId = sys.sensors ? sys.sensors[s.key] : null;
      const live = this._liveState(entityId);
      const origin = sources[s.key];
      let right;
      if (!entityId) {
        right = `<span class="badge muted">${hasWeather ? "Fallback meteo" : "Non configurato"}</span>`;
      } else if (live && live.missing) {
        right = `<span class="badge warn">non disponibile</span>`;
      } else {
        right = `<span class="reading" data-entity="${esc(entityId)}">${esc(live.value)}${live.unit ? " " + esc(live.unit) : ""}</span>`;
      }
      // La provenienza effettiva conta: se un sensore cade e il sistema
      // ripiega sul meteo, deve vedersi.
      const originTag =
        origin && origin !== "non_disponibile"
          ? ` · <span class="origin">${esc(label(SOURCE_LABELS, origin))}</span>`
          : "";
      const sub = entityId
        ? `<span class="sub">${esc((live && live.name) || entityId)}${originTag}</span>`
        : origin === "servizio_meteo"
        ? `<span class="sub"><span class="origin">${esc(label(SOURCE_LABELS, origin))}</span></span>`
        : "";
      return `<div class="row">
        <ha-icon icon="${s.icon}"></ha-icon>
        <div class="row-main"><span class="row-label">${s.label}</span>${sub}</div>
        ${right}
      </div>`;
    }).join("");

    return `<ha-card><div class="inner">
        <div class="card-head"><ha-icon icon="mdi:gauge"></ha-icon><h2>Sorgenti dati</h2></div>
        ${rows}
        <div class="row">
          <ha-icon icon="mdi:weather-partly-cloudy"></ha-icon>
          <div class="row-main"><span class="row-label">Meteo di fallback</span></div>
          ${hasWeather ? `<span class="reading small">${esc(sys.weather_entity)}</span>` : `<span class="badge muted">nessuno</span>`}
        </div>
        <p class="muted small note">Le sorgenti si cambiano da Impostazioni → Dispositivi e servizi → Irrigazione Smart.</p>
      </div></ha-card>`;
  }

  _locationCard(sys) {
    return `<ha-card><div class="inner">
        <div class="card-head"><ha-icon icon="mdi:map-marker-outline"></ha-icon><h2>Posizione</h2></div>
        <p class="muted small nomargin">Serve al calcolo della radiazione extraterrestre, che dipende da latitudine e giorno dell'anno.</p>
        <div class="grid">
          <div class="cell"><span class="k">Latitudine</span><span class="v">${this._fmtCoord(sys.latitude)}</span></div>
          <div class="cell"><span class="k">Longitudine</span><span class="v">${this._fmtCoord(sys.longitude)}</span></div>
          <div class="cell"><span class="k">Altitudine</span><span class="v">${sys.elevation ?? "—"} m</span></div>
        </div>
      </div></ha-card>`;
  }

  // ------------------------------------------------------------- dialoghi

  /* Pulsante: `ha-button` se c'è, altrimenti un <button> stilizzato.
     Mai `mwc-button` da solo: sulle versioni recenti non è registrato e
     resterebbe invisibile. */
  _button(cls, text, opts = {}) {
    const { primary = false, danger = false } = opts;
    const kind = `${primary ? " primary" : ""}${danger ? " danger" : ""}`;
    return `<button type="button" class="btn${kind} ${cls}">${esc(text)}</button>`;
  }

  /* ---------------------------------------------------------------------
     Costruzione dei campi.

     I componenti del frontend vanno creati da JavaScript impostandone le
     proprietà: costruirli scrivendo HTML non funziona (le tendine non
     registrano le voci, i selettori restano vuoti). `ha-selector` è lo
     stesso componente usato dai config flow di Home Assistant, quindi i
     campi hanno l'aspetto e il comportamento a cui l'utente è abituato:
     ricerca fra le entità, elenco delle icone, tendine native.
     --------------------------------------------------------------------- */

  /* Traduce un campo nel selettore corrispondente di Home Assistant. */
  _selectorFor(spec) {
    switch (spec.type) {
      case "entity":
        return { entity: { domain: spec.domains, multiple: false } };
      case "icon":
        return { icon: {} };
      case "number":
        return {
          number: {
            mode: "box",
            step: spec.step ?? "any",
            ...(spec.min != null ? { min: spec.min } : {}),
            ...(spec.max != null ? { max: spec.max } : {}),
            ...(spec.suffix ? { unit_of_measurement: spec.suffix } : {}),
          },
        };
      case "select":
        return {
          select: {
            mode: "dropdown",
            options: spec.options.map((o) => ({
              value: o,
              label: spec.labels ? label(spec.labels, o) : o,
            })),
          },
        };
      case "boolean":
        return { boolean: {} };
      case "time":
        return { time: {} };
      default:
        return { text: {} };
    }
  }

  /* Campo costruito col selettore nativo di Home Assistant. */
  _haField(spec, values) {
    const row = document.createElement("div");
    row.className = "field";

    const selector = document.createElement("ha-selector");
    selector.hass = this._hass;
    selector.selector = this._selectorFor(spec);
    selector.label = spec.label;
    selector.required = false;
    selector.value = values[spec.key] ?? undefined;
    selector.addEventListener("value-changed", (ev) => {
      ev.stopPropagation();
      values[spec.key] = ev.detail.value;
    });

    row.appendChild(selector);
    if (spec.helper) {
      const help = document.createElement("span");
      help.className = "fld-helper";
      help.textContent = spec.helper;
      row.appendChild(help);
    }
    return row;
  }

  /* Riserva usata solo se `ha-selector` non è disponibile. Stesso
     aspetto dei campi HA, così la pagina resta coerente. */
  _plainField(spec, values) {
    const row = document.createElement("div");
    row.className = "ha-field";

    const lab = document.createElement("label");
    lab.className = "ha-field-label";
    lab.textContent = spec.suffix ? `${spec.label} (${spec.suffix})` : spec.label;
    row.appendChild(lab);

    let input;
    if (spec.type === "select" || spec.type === "entity" || spec.type === "icon") {
      input = document.createElement("select");
      input.className = "ha-control";
      let items;
      if (spec.type === "entity") {
        items = this._entityOptions(spec.domains, values[spec.key]).map((it) => ({
          value: it.id,
          text: `${it.name} — ${it.id}`,
        }));
        items.unshift({ value: "", text: "— nessuna —" });
      } else if (spec.type === "icon") {
        input = document.createElement("input");
        input.className = "ha-control";
        input.type = "text";
        input.placeholder = "mdi:flower";
      } else {
        items = spec.options.map((o) => ({
          value: o,
          text: spec.labels ? label(spec.labels, o) : o,
        }));
      }
      if (items) {
        items.forEach((it) => {
          const opt = document.createElement("option");
          opt.value = it.value;
          opt.textContent = it.text;
          input.appendChild(opt);
        });
      }
    } else if (spec.type === "boolean") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!values[spec.key];
    } else {
      input = document.createElement("input");
      input.className = "ha-control";
      input.type = spec.type === "number" ? "number" : spec.type === "time" ? "time" : "text";
      if (spec.type === "number") input.step = "any";
    }

    if (spec.type !== "boolean") {
      const current = values[spec.key];
      input.value = current == null ? "" : String(current);
    }

    const read = () =>
      spec.type === "boolean"
        ? input.checked
        : spec.type === "number"
        ? input.value === "" ? null : Number(input.value)
        : input.value;

    input.addEventListener("change", () => {
      values[spec.key] = read();
    });
    input.addEventListener("input", () => {
      values[spec.key] = read();
    });

    row.appendChild(input);
    if (spec.helper) {
      const help = document.createElement("span");
      help.className = "fld-helper";
      help.textContent = spec.helper;
      row.appendChild(help);
    }
    return row;
  }

  /* Tendina nativa vestita come un campo di Home Assistant.

     I menu a tendina del frontend si sono rotti due volte in ambienti
     reali (voci non registrate, menu tagliato dentro al dialogo). Una
     `<select>` nativa non può rompersi: qui le si dà l'aspetto di un
     campo HA, invece di inseguire il componente. */
  _styledSelect(spec, values) {
    const row = document.createElement("div");
    row.className = "ha-field";

    const lab = document.createElement("label");
    lab.className = "ha-field-label";
    lab.textContent = spec.label;

    const box = document.createElement("div");
    box.className = "ha-field-box";

    const select = document.createElement("select");
    select.className = "ha-control";
    (spec.options || []).forEach((option) => {
      const opt = document.createElement("option");
      opt.value = option;
      opt.textContent = spec.labels ? label(spec.labels, option) : option;
      select.appendChild(opt);
    });
    select.value = values[spec.key] ?? (spec.options || [])[0] ?? "";
    select.addEventListener("change", () => {
      values[spec.key] = select.value;
    });

    const arrow = document.createElement("ha-icon");
    arrow.className = "ha-field-arrow";
    arrow.setAttribute("icon", "mdi:menu-down");

    box.append(select, arrow);
    row.append(lab, box);

    if (spec.helper) {
      const help = document.createElement("span");
      help.className = "fld-helper";
      help.textContent = spec.helper;
      row.appendChild(help);
    }
    return row;
  }

  _makeField(spec, values) {
    // Le tendine restano native: è l'unico modo per cui funzionino sempre.
    if (spec.type === "select") return this._styledSelect(spec, values);
    return has("ha-selector")
      ? this._haField(spec, values)
      : this._plainField(spec, values);
  }

  /* Costruisce il corpo del form da una lista di campi. */
  _buildForm(specs, values) {
    const form = document.createElement("div");
    form.className = "form";

    specs.forEach((spec) => {
      if (spec.type === "section") {
        const head = document.createElement("div");
        head.className = "form-section";
        head.textContent = spec.label;
        form.appendChild(head);
        return;
      }
      if (spec.type === "note") {
        const note = document.createElement("p");
        note.className = spec.warn ? "warntext small nomargin" : "muted small nomargin";
        note.textContent = spec.label;
        form.appendChild(note);
        return;
      }
      form.appendChild(this._makeField(spec, values));
    });

    return form;
  }

  /* Elenco delle entità di Home Assistant fra cui scegliere, usato dai
     controlli di riserva quando `ha-selector` non è disponibile. */
  _entityOptions(domains, current, filter) {
    const states = (this._hass && this._hass.states) || {};
    let ids = Object.keys(states).filter((id) =>
      domains.includes(id.split(".")[0])
    );

    if (filter) {
      const narrowed = ids.filter((id) => filter(states[id]));
      // se il filtro non trova nulla si mostra tutto: meglio una lista
      // lunga di un elenco vuoto in cui non si può scegliere
      if (narrowed.length) ids = narrowed;
    }

    const items = ids
      .map((id) => ({
        id,
        name: (states[id].attributes || {}).friendly_name || id,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // l'entità già impostata resta selezionabile anche se ora non esiste
    if (current && !ids.includes(current)) {
      items.unshift({ id: current, name: `${current} (non disponibile)` });
    }
    return items;
  }


  _openZoneDialog(zoneId) {
    const opts = this._overview.options || {};
    const zone =
      (zoneId && (this._overview.zones || []).find((z) => z.id === zoneId)) || null;
    const z = zone || {
      name: "", valve_entity: "", enabled: true, zone_type: "prato_microterme",
      rate_mm_h: 10, emitter: "statici", corrector: 1.0, soil: INHERIT_STR,
      kc: INHERIT_NUM, root_depth_cm: INHERIT_NUM, mad: INHERIT_NUM,
      max_runtime_min: INHERIT_NUM, deficit_mm: 0, icon: "",
    };
    const inh = (v) => (v == null || Number(v) === INHERIT_NUM ? "" : v);

    const specs = [
      { key: "name", label: "Nome zona", type: "text" },
      {
        key: "valve_entity",
        label: "Valvola della linea",
        type: "entity",
        domains: ["switch", "valve", "input_boolean"],
        helper: "L'entità che apre la linea. Senza, la zona non può irrigare",
      },
      {
        key: "zone_type", label: "Tipo di zona", type: "select",
        options: opts.zone_types || [], labels: ZONE_TYPE_LABELS,
      },
      {
        key: "emitter", label: "Erogazione", type: "select",
        options: opts.emitters || [], labels: EMITTER_LABELS,
      },
      {
        key: "icon", label: "Icona", type: "icon",
        helper: "Vuoto = icona predefinita del tipo di zona",
      },
      {
        key: "rate_mm_h", label: "Portata", type: "number", suffix: "mm/h",
        helper: "Misurata col tuna can test: senza questo dato le durate sono arbitrarie",
      },
      {
        key: "corrector", label: "Correttore", type: "number",
        helper: "1.0 = nessuna correzione. Si tara osservando il prato",
      },

      { type: "section", label: "Override (vuoto = eredita)" },
      {
        key: "soil", label: "Terreno", type: "select",
        options: [INHERIT_STR, ...(opts.soils || [])],
        labels: { ...SOIL_LABELS, eredita: "Eredita dal sistema" },
      },
      { key: "kc", label: "Coefficiente colturale Kc", type: "number" },
      { key: "root_depth_cm", label: "Profondità radici", type: "number", suffix: "cm" },
      {
        key: "mad", label: "MAD", type: "number",
        helper: "Frazione consumabile prima di irrigare (0–1)",
      },
      { key: "max_runtime_min", label: "Durata massima", type: "number", suffix: "min" },

      { type: "section", label: "Stato" },
      {
        key: "deficit_mm", label: "Deficit attuale", type: "number", suffix: "mm",
        helper: "Azzeralo dopo un'irrigazione manuale",
      },
      { key: "enabled", label: "Linea abilitata", type: "boolean" },
    ];

    const initial = {
      name: z.name,
      valve_entity: z.valve_entity || undefined,
      zone_type: z.zone_type,
      emitter: z.emitter,
      icon: z.icon || undefined,
      rate_mm_h: z.rate_mm_h,
      corrector: z.corrector,
      soil: z.soil,
      kc: inh(z.kc),
      root_depth_cm: inh(z.root_depth_cm),
      mad: inh(z.mad),
      max_runtime_min: inh(z.max_runtime_min),
      deficit_mm: z.deficit_mm,
      enabled: !!z.enabled,
    };

    this._showForm(
      zone ? "Modifica zona" : "Nuova zona",
      specs,
      initial,
      async (values) => {
        const data = { ...values };
        // campo lasciato vuoto = eredita dal preset o dal sistema
        ["kc", "root_depth_cm", "mad", "max_runtime_min"].forEach((k) => {
          if (data[k] === "" || data[k] == null) data[k] = INHERIT_NUM;
        });
        if (!data.name) data.name = "Nuova zona";
        if (!data.valve_entity) data.valve_entity = null;
        if (!data.icon) data.icon = null;

        if (zone) await this._mutate("POST", `zones/${zone.id}`, data);
        else await this._mutate("POST", "zones", data);
      },
      zone ? "Salva" : "Aggiungi linea"
    );
  }

  /* Forzatura di una linea: durata precompilata con quella calcolata, ma
     modificabile. Il campo vuoto lascia decidere al bilancio idrico. */
  _openForceDialog(zoneId) {
    const zone = (this._overview.zones || []).find((z) => z.id === zoneId);
    if (!zone) return;
    const plan = (zone.computed || {}).plan || {};
    const suggested = plan.should_run ? plan.total_minutes : 10;

    const specs = [
      { type: "note", label: `Irrigazione forzata di ${zone.name}.` },
      {
        key: "minuti", label: "Durata", type: "number", suffix: "min", min: 1,
        helper: "Svuota il campo per usare la durata calcolata dal deficit",
      },
      zone.valve_entity
        ? {
            type: "note",
            label: `Valvola: ${zone.valve_entity}. L'irrigazione parte solo se la valvola conferma l'apertura.`,
          }
        : {
            type: "note",
            warn: true,
            label: "Questa linea non ha una valvola configurata: non partirà.",
          },
    ];

    this._showForm(
      "Irriga ora",
      specs,
      { minuti: suggested },
      async (values) => {
        const body = { zone_id: zoneId };
        if (values.minuti) body.minuti = Number(values.minuti);
        await this._mutate("POST", "run", body);
      },
      "Avvia"
    );
  }

  _openGroupDialog(category) {
    const group = (this._overview.groups || {})[category];
    if (!group) return;
    const options = this._overview.options || {};
    const label = (options.category_labels || {})[category] || category;

    this._showForm(
      `Quando irrigare — ${label}`,
      [
        { key: "window_start", label: "Inizio finestra", type: "time",
          helper: "L'irrigazione parte a quest'ora, nei giorni attivi" },
        { key: "window_end", label: "Fine finestra", type: "time",
          helper: "Entro quest'ora l'irrigazione dovrebbe essere conclusa" },
        { key: "auto", label: "Avvio automatico", type: "boolean" },
      ],
      {
        window_start: group.window_start,
        window_end: group.window_end,
        auto: !!group.auto,
      },
      async (values) => {
        await this._mutate("POST", `groups/${category}`, values);
      }
    );
  }

  _openSystemDialog() {
    const sys = this._overview.system;
    const opts = this._overview.options || {};
    const specs = [
      {
        key: "soil", label: "Terreno predefinito", type: "select",
        options: opts.soils || [], labels: SOIL_LABELS,
      },
      { key: "soak_minutes", label: "Pausa di assorbimento", type: "number", suffix: "min" },
      { key: "gap_minutes", label: "Pausa tra linee", type: "number", suffix: "min" },
      { key: "wind_max_kmh", label: "Vento massimo", type: "number", suffix: "km/h" },
      {
        key: "rain_forecast_max_mm", label: "Pioggia prevista massima",
        type: "number", suffix: "mm",
      },
      {
        key: "overflow_policy", label: "Se la finestra non basta", type: "select",
        options: ["truncate", "overflow"],
        labels: {
          truncate: "Escludi le linee eccedenti",
          overflow: "Sfora la finestra",
        },
      },
      {
        key: "flow_entity", label: "Flussostato", type: "entity", domains: ["sensor"],
        helper: "Solo lettura: viene mostrato e registrato, non blocca l'irrigazione",
      },
      {
        key: "valve_timeout_s", label: "Attesa conferma valvola",
        type: "number", suffix: "s", min: 5,
        helper: "Oltre questo tempo senza conferma, la linea viene saltata",
      },
    ];

    const initial = {
      soil: sys.soil,
      soak_minutes: sys.soak_minutes,
      gap_minutes: sys.gap_minutes,
      wind_max_kmh: sys.wind_max_kmh,
      rain_forecast_max_mm: sys.rain_forecast_max_mm,
      overflow_policy: sys.overflow_policy,
      flow_entity: sys.flow_entity || undefined,
      valve_timeout_s: sys.valve_timeout_s,
    };

    this._showForm("Impostazioni sistema", specs, initial, async (values) => {
      const data = { ...values };
      if (!data.flow_entity) data.flow_entity = null; // svuotato = rimosso
      await this._mutate("POST", "system", data);
    });
  }


  /* Crea il contenitore del dialogo: ha-dialog se registrato, altrimenti
     un overlay equivalente. Espone la stessa interfaccia (querySelector +
     evento "closed"), così il codice chiamante non cambia. */
  _makeDialog(heading) {
    if (has("ha-dialog")) {
      const dlg = document.createElement("ha-dialog");
      dlg.heading = heading;
      dlg.setAttribute("open", "");
      return dlg;
    }
    const dlg = document.createElement("div");
    dlg.className = "dlg-fallback";
    dlg._isFallback = true;
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) dlg.dispatchEvent(new CustomEvent("closed"));
    });
    dlg._heading = heading;
    return dlg;
  }

  /* Nel fallback i pulsanti hanno slot="…" ma nessuno slot reale: si
     raccolgono in una barra azioni in fondo al riquadro. */
  _layoutFallback(dlg) {
    if (!dlg._isFallback) return;
    const box = document.createElement("div");
    box.className = "dlg-box";
    box.innerHTML = `<h3>${esc(dlg._heading)}</h3>`;
    const actions = document.createElement("div");
    actions.className = "dlg-actions";
    [...dlg.childNodes].forEach((node) => {
      if (node.nodeType === 1 && node.getAttribute("slot")) actions.appendChild(node);
      else box.appendChild(node);
    });
    box.appendChild(actions);
    dlg.appendChild(box);
  }

  /* Barra dei pulsanti, sempre dentro al corpo del dialogo.
     Gli slot "primaryAction"/"secondaryAction" esistono solo in alcune
     versioni di `ha-dialog`: usandoli, i pulsanti sparivano del tutto. */
  _actionBar(confirmText, onConfirm, close, danger = false) {
    const bar = document.createElement("div");
    bar.className = "dlg-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn";
    cancel.textContent = "Annulla";
    cancel.addEventListener("click", close);

    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = `btn primary${danger ? " danger" : ""}`;
    confirm.textContent = confirmText;
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      await onConfirm();
      close();
    });

    bar.append(cancel, confirm);
    return bar;
  }

  /* Dialogo con form costruito dai `specs`. `onSave` riceve i valori. */
  _showForm(heading, specs, initial, onSave, confirmText = "Salva") {
    const values = { ...initial };
    const dlg = this._makeDialog(heading);

    const body = document.createElement("div");
    body.className = "dlg-body";
    body.appendChild(this._buildForm(specs, values));

    const close = () => dlg.parentNode && dlg.parentNode.removeChild(dlg);
    body.appendChild(
      this._actionBar(confirmText, () => onSave(values), close)
    );

    dlg.appendChild(body);
    dlg.addEventListener("closed", close);
    this._layoutFallback(dlg);
    this.shadowRoot.appendChild(dlg);
  }

  _confirmDelete(zoneId) {
    const zone = (this._overview.zones || []).find((z) => z.id === zoneId);
    if (!zone) return;
    const dlg = this._makeDialog("Eliminare la zona?");
    const body = document.createElement("div");
    body.className = "dlg-body";

    const text = document.createElement("p");
    text.className = "nomargin";
    text.textContent =
      `La zona "${zone.name}" verrà rimossa insieme alla sua storia idrica ` +
      `(deficit ${Number(zone.deficit_mm || 0).toFixed(1)} mm). ` +
      `L'operazione non è reversibile.`;
    body.appendChild(text);

    const close = () => dlg.parentNode && dlg.parentNode.removeChild(dlg);
    body.appendChild(
      this._actionBar(
        "Elimina",
        () => this._mutate("DELETE", `zones/${zoneId}`),
        close,
        true
      )
    );

    dlg.appendChild(body);
    dlg.addEventListener("closed", close);
    this._layoutFallback(dlg);
    this.shadowRoot.appendChild(dlg);
  }

  // ---------------------------------------------------------------- css

  _css() {
    return `
      :host { display: block; height: 100%; background: var(--primary-background-color); }
      .app-title { display: flex; align-items: center; gap: 8px; }

      .tabs { display: flex; gap: 4px; padding: 0 8px; overflow-x: auto;
              background: var(--app-header-background-color, var(--primary-color));
              color: var(--app-header-text-color, #fff); }
      .tab { display: flex; align-items: center; gap: 6px; padding: 12px 16px; border: none;
             background: none; color: inherit; opacity: .7; cursor: pointer; font-size: 14px;
             font-family: inherit; white-space: nowrap; border-bottom: 3px solid transparent; }
      .tab.active { opacity: 1; border-bottom-color: currentColor; font-weight: 500; }
      .tab ha-icon { --mdc-icon-size: 20px; }

      .content { padding: 16px; max-width: 780px; margin: 0 auto; box-sizing: border-box; }
      ha-alert { display: block; margin-bottom: 16px; }
      ha-card { display: block; margin-bottom: 16px; }
      .inner { padding: 16px; }
      .spacer { flex: 1 1 auto; }
      .card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
      .card-head ha-icon { color: var(--primary-color); }
      .card-head h2 { font-size: 16px; font-weight: 600; margin: 0; color: var(--primary-text-color); }

      /* master generale */
      .master-row { display: flex; align-items: center; gap: 14px; }
      .master-icon { width: 46px; height: 46px; border-radius: 50%; display: flex; align-items: center;
                     justify-content: center; background: var(--divider-color); color: var(--secondary-text-color); }
      .master-icon.on { background: color-mix(in srgb, var(--info-color, var(--primary-color)) 20%, transparent);
                        color: var(--info-color, var(--primary-color)); }
      .master-main { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; }
      .master-title { font-size: 18px; font-weight: 600; color: var(--primary-text-color); }

      .row { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--divider-color); }
      .row:last-of-type { border-bottom: none; }
      .row > ha-icon { color: var(--state-icon-color, var(--secondary-text-color)); flex: 0 0 auto; }
      .row-main { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; }
      .row-label { font-size: 15px; color: var(--primary-text-color); }
      .sub { font-size: 12px; color: var(--secondary-text-color); overflow: hidden; text-overflow: ellipsis; }
      .reading { font-size: 16px; font-weight: 600; white-space: nowrap; color: var(--primary-text-color); }
      .reading.small { font-size: 13px; font-weight: 500; color: var(--secondary-text-color); }
      .dim { opacity: .55; }

      .badge { font-size: 12px; padding: 3px 10px; border-radius: 14px; white-space: nowrap; }
      .badge.muted { background: var(--divider-color); color: var(--secondary-text-color); }
      .badge.ok { background: color-mix(in srgb, var(--success-color, #43a047) 18%, transparent); color: var(--success-color, #43a047); }
      .badge.run { background: color-mix(in srgb, var(--info-color, var(--primary-color)) 18%, transparent); color: var(--info-color, var(--primary-color)); }
      .badge.warn { background: color-mix(in srgb, var(--warning-color, #ffa600) 22%, transparent); color: var(--warning-color, #ffa600); }
      .badge.q-ottimale { background: color-mix(in srgb, var(--success-color, #43a047) 18%, transparent); color: var(--success-color, #43a047); }
      .badge.q-accettabile { background: color-mix(in srgb, var(--warning-color, #ffa600) 20%, transparent); color: var(--warning-color, #ffa600); }
      .badge.q-sconsigliata { background: color-mix(in srgb, var(--error-color, #db4437) 18%, transparent); color: var(--error-color, #db4437); }
      .warntext { color: var(--warning-color, #ffa600); }
      .actions { display: flex; gap: 8px; margin-top: 14px; }
      .tab-actions { display: flex; justify-content: flex-end; margin-bottom: 12px; }

      /* giorni della settimana: un interruttore per giorno */
      .days-row { display: flex; flex-direction: column; gap: 8px; margin-top: 16px; }
      .day-chips { display: flex; gap: 6px; flex-wrap: wrap; }
      .day-chip { font-family: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
                  min-width: 46px; padding: 8px 10px; border-radius: 18px;
                  border: 1px solid var(--divider-color); background: none;
                  color: var(--secondary-text-color); transition: all .15s; }
      .day-chip:hover { border-color: var(--primary-color); }
      .day-chip.on { background: var(--primary-color); border-color: transparent;
                     color: var(--text-primary-color, #fff); }
      .card-head .sub { flex: 0 0 auto; }

      /* pallino di stato: verde ok, giallo assetata, rosso in carenza,
         azzurro mentre irriga */
      .dot { width: 10px; height: 10px; border-radius: 50%; flex: 0 0 auto; }
      .dot.st-ok { background: var(--success-color, #43a047); }
      .dot.st-thirsty { background: var(--warning-color, #ffa600); }
      .dot.st-critical { background: var(--error-color, #db4437); }
      .dot.st-off { background: var(--disabled-text-color, #bdbdbd); }
      .dot.st-watering { background: var(--info-color, var(--primary-color));
                         animation: pulse 1.6s ease-in-out infinite; }

      .zone-icon { color: var(--state-icon-color, var(--secondary-text-color)); }

      /* maniglia di trascinamento per riordinare le linee */
      .drag-handle { display: inline-flex; align-items: center; cursor: grab;
                     color: var(--disabled-text-color); flex: 0 0 auto; touch-action: none; }
      .drag-handle:active { cursor: grabbing; }
      .drag-handle:hover { color: var(--secondary-text-color); }
      .zone.dragging { opacity: .5; background: var(--secondary-background-color);
                       border-radius: 8px; }

      /* strumenti del registro */
      .log-tools { display: flex; gap: 10px; margin: 10px 0 8px; flex-wrap: wrap; align-items: flex-end; }
      .log-day { font-size: 12px; font-weight: 600; text-transform: uppercase;
                 letter-spacing: .04em; color: var(--secondary-text-color);
                 margin: 16px 0 2px; }
      .log-time { font-size: 12px; color: var(--secondary-text-color);
                  min-width: 38px; flex: 0 0 auto; font-variant-numeric: tabular-nums; }

      .log-row.lv-warning > ha-icon { color: var(--warning-color, #ffa600); }
      .log-row.lv-error > ha-icon { color: var(--error-color, #db4437); }
      .log-row.lv-error .row-label { color: var(--error-color, #db4437); }
      /* pulsazione mentre l'acqua scorre davvero */
      .master-icon.pulse { animation: pulse 1.6s ease-in-out infinite; }
      @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .45; } }
      @media (prefers-reduced-motion: reduce) { .master-icon.pulse { animation: none; } }

      .zone { padding: 14px 0; border-bottom: 1px solid var(--divider-color); }
      .zone:last-child { border-bottom: none; padding-bottom: 0; }
      .zone-head { display: flex; align-items: center; gap: 8px; }
      .zone-title { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; }
      .zone-name { font-size: 16px; font-weight: 500; color: var(--primary-text-color); }
      .zone-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13px; color: var(--primary-text-color); margin-top: 6px; }
      /* velatura del colore d'accento: resta distinguibile dalla card
         sia in tema chiaro sia in tema scuro */
      .zone-plan { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 13px;
                   color: var(--primary-text-color);
                   background: color-mix(in srgb, var(--info-color, var(--primary-color)) 12%, transparent);
                   padding: 8px 10px; border-radius: 8px; }
      .zone-plan ha-icon { --mdc-icon-size: 18px; color: var(--info-color, var(--primary-color)); }
      .chip { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--secondary-text-color); }
      .chip ha-icon { --mdc-icon-size: 16px; }
      .chip.warnchip { color: var(--warning-color, #ffa600); }

      .bar { position: relative; height: 8px; border-radius: 4px; background: var(--divider-color); margin-top: 10px; overflow: hidden; }
      .bar.big { height: 10px; margin-top: 14px; }
      .bar-fill { height: 100%; background: var(--info-color, var(--primary-color)); transition: width .3s; }
      .bar-fill.over { background: var(--warning-color, #ffa600); }
      .bar-thr { position: absolute; top: -2px; width: 2px; height: 12px; background: var(--primary-text-color); opacity: .55; }

      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 12px; margin-top: 10px; }
      .cell { display: flex; flex-direction: column; gap: 2px; }
      .cell .k { font-size: 11px; color: var(--secondary-text-color); text-transform: uppercase; letter-spacing: .03em; }
      .cell .v { font-size: 18px; font-weight: 600; color: var(--primary-text-color); }
      .cell .v .of { font-size: 13px; font-weight: 400; color: var(--secondary-text-color); }

      .et0 { display: flex; align-items: center; gap: 14px; padding: 4px 0 2px; }
      .et0-value { font-size: 30px; font-weight: 600; color: var(--primary-text-color); line-height: 1; }
      .et0-value span { font-size: 15px; font-weight: 400; color: var(--secondary-text-color); }
      .et0-meta { display: flex; flex-direction: column; min-width: 0; }

      .origin { color: var(--info-color, var(--primary-color)); }
      .muted { color: var(--secondary-text-color); }
      .small { font-size: 13px; }
      .note { margin: 12px 0 0; }
      .nomargin { margin: 0 0 4px; }
      .empty, .empty-state { text-align: center; color: var(--secondary-text-color); padding: 24px 8px; }
      .empty-state ha-icon { --mdc-icon-size: 40px; color: var(--disabled-text-color); }
      .empty-state p { margin: 6px 0; }

      /* Pulsanti in stile Home Assistant, disegnati a mano: i componenti
         del frontend non sono affidabili da costruire fuori da HA. */
      .btn { font-family: inherit; font-size: 14px; font-weight: 500; cursor: pointer;
             padding: 9px 18px; border-radius: 24px; border: none;
             background: none; color: var(--primary-color);
             letter-spacing: .02em; transition: background-color .15s; }
      .btn:hover { background: color-mix(in srgb, var(--primary-color) 12%, transparent); }
      .btn:disabled { opacity: .5; cursor: default; }
      .btn.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); }
      .btn.primary:hover { filter: brightness(1.08); }
      .btn.danger { background: var(--error-color, #db4437); color: #fff; }
      .empty-cta { margin-top: 14px; }

      /* riga di un campo costruito con ha-selector */
      .field { display: flex; flex-direction: column; gap: 4px; }
      .field ha-selector { display: block; width: 100%; }
      .dlg-body { display: flex; flex-direction: column; }

      /* campi di riserva, quando ha-textfield/ha-select non esistono */
      .fld { display: flex; flex-direction: column; gap: 4px; }
      .fld-label { font-size: 12px; color: var(--secondary-text-color); }
      .fld-helper { font-size: 11px; color: var(--secondary-text-color); padding-left: 2px; }
      .native { font-family: inherit; font-size: 14px; padding: 10px; border-radius: 6px;
                border: 1px solid var(--divider-color); background: var(--secondary-background-color);
                color: var(--primary-text-color); width: 100%; box-sizing: border-box; }

      /* Campo disegnato come quelli di Home Assistant: bordo sottile,
         etichetta sopra, colore d'accento al fuoco. Usato per le tendine
         e per i controlli del registro. */
      .ha-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
      .ha-field.grow { flex: 1 1 200px; }
      .ha-field-label { font-size: 12px; color: var(--secondary-text-color); padding-left: 2px; }
      .ha-field-box { position: relative; display: flex; align-items: center; }
      .ha-control {
        width: 100%; box-sizing: border-box; font-family: inherit; font-size: 15px;
        padding: 13px 40px 13px 15px; border-radius: 4px;
        border: 1px solid var(--mdc-text-field-outlined-idle-border-color, rgba(127,127,127,.45));
        background: var(--mdc-text-field-fill-color, transparent);
        color: var(--primary-text-color);
        appearance: none; -webkit-appearance: none;
      }
      .ha-control.with-lead { padding-left: 42px; padding-right: 15px; }
      .ha-control:hover {
        border-color: var(--mdc-text-field-outlined-hover-border-color, rgba(127,127,127,.8));
      }
      .ha-control:focus {
        outline: none; border-color: var(--primary-color); border-width: 2px;
        padding: 12px 39px 12px 14px;
      }
      .ha-control.with-lead:focus { padding-left: 41px; padding-right: 14px; }
      .ha-field-arrow, .ha-field-lead {
        position: absolute; pointer-events: none; color: var(--secondary-text-color);
      }
      .ha-field-arrow { right: 10px; }
      .ha-field-lead { left: 12px; --mdc-icon-size: 20px; }
      /* le opzioni sono disegnate dal sistema: si forza il tema scuro */
      .ha-control option { background: var(--card-background-color); color: var(--primary-text-color); }

      .form { display: flex; flex-direction: column; gap: 14px; min-width: 300px; }
      .form ha-textfield { width: 100%; }
      .form select.ha-control { max-width: 100%; }
      /* fallback dialogo: usato solo se ha-dialog non è registrato */
      .dlg-fallback { position: fixed; inset: 0; z-index: 99; display: flex;
                      align-items: center; justify-content: center; background: rgba(0,0,0,.45); }
      .dlg-box { background: var(--card-background-color); color: var(--primary-text-color);
                 border-radius: 12px; padding: 20px; max-height: 85vh; overflow: auto;
                 max-width: 92vw; box-shadow: 0 8px 32px rgba(0,0,0,.3); }
      .dlg-box h3 { margin: 0 0 14px; font-size: 18px; }
      .dlg-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
      .form-section { font-size: 13px; font-weight: 600; color: var(--secondary-text-color);
                      text-transform: uppercase; letter-spacing: .04em; margin-top: 6px; }
      .danger { --mdc-theme-primary: var(--error-color, #db4437); }
    `;
  }
}

customElements.define("irrigazione-smart-panel", IrrigazioneSmartPanel);

