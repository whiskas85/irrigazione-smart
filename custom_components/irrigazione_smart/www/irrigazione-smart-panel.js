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
/* Versione di questo file, tenuta allineata da `scripts/bump.py`.

   Serve a riconoscere il disallineamento più insidioso di questo
   progetto: HACS sostituisce i file su disco, il browser rilegge subito
   il JavaScript nuovo, ma il Python resta quello già caricato in memoria
   finché Home Assistant non riparte. La pagina sa quindi di funzioni che
   il server non ha ancora, e le chiamate rispondono 404 senza che si
   capisca perché. */
const PANEL_VERSION = "1.1.1";

const BASE_TABS = [
  { id: "dashboard", label: "Dashboard", icon: "mdi:view-dashboard-outline" },
  { id: "mappa", label: "Mappa", icon: "mdi:map-outline" },
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

/* Colori dei grafici.

   Non arrivano dal tema di Home Assistant: servono tinte che restino
   distinguibili anche a chi non percepisce bene i colori, e quelle vanno
   scelte e verificate. Questi tre slot sono stati validati sulle
   superfici reali delle card HA (chiaro #ffffff, scuro #1c1c1c): passano
   banda di luminosità, soglia di croma, separazione per daltonismo e
   distanza a vista normale. Il verde acqua resta sotto 3:1 sul chiaro,
   perciò ogni serie porta sempre anche l'etichetta e la tabella. */
const CHART_COLORS = {
  light: ["#2a78d6", "#eb6834", "#1baf7a"],
  dark: ["#3987e5", "#d95926", "#199e70"],
};

const chartPalette = () => {
  // il tema di HA non espone un flag: si deduce dalla luminosità del testo
  const ink = getComputedStyle(document.documentElement)
    .getPropertyValue("--primary-text-color")
    .trim();
  const m = ink.match(/\d+/g);
  const scuro = m ? Number(m[0]) > 128 : false;
  return scuro ? CHART_COLORS.dark : CHART_COLORS.light;
};

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
    // stato della mappa: vive nel componente, non nel server, perché
    // descrive cosa sta facendo l'utente adesso e non cosa è configurato
    this._mapEdit = false;
    this._selArea = null;
    this._selVertex = null;
    this._draft = null;
    this._mapDragging = false;
    this._cardEls = [];
  }

  /* True mentre si sta disegnando o trascinando sulla mappa.

     Un ridisegno dell'intera pagina in quel momento toglierebbe da sotto
     le dita il vertice che si sta spostando: stessa ragione per cui non
     si ridisegna mentre si scrive in un campo. */
  _mapBusy() {
    return this._tab === "mappa" && (this._mapDragging || !!this._draft);
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
    // le card Lovelace si aggiornano da sole, ma solo se ricevono `hass`
    (this._cardEls || []).forEach((card) => {
      card.hass = hass;
    });
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
      if (this._isTyping() || this._mapBusy()) {
        if (logChanged) this._updateLogList();
        return;
      }
      // sulla mappa basta rifare i poligoni: ridisegnare la pagina
      // intera farebbe saltare lo scorrimento a ogni giro
      if ((changed || logChanged) && this._tab === "mappa") {
        this._repaintMap();
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
      if (this._isTyping() || this._mapBusy()) return;
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
          ${
            this._overview && this._overview.version
              ? `<span class="app-version" title="Versione in esecuzione">${esc(this._overview.version)}</span>`
              : ""
          }
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
        <div class="content${this._tab === "mappa" ? " wide" : ""}">${this._body()}</div>
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
    if (this._tab === "mappa") {
      this._bindMap();
      this._renderCards();
    }
    onClick(".add-zone", () => this._openZoneDialog(null));
    onClick(".edit-zone", (e) =>
      this._openZoneDialog(e.currentTarget.getAttribute("data-id"))
    );
    onClick(".delete-zone", (e) =>
      this._confirmDelete(e.currentTarget.getAttribute("data-id"))
    );
    onClick(".edit-system", () => this._openSystemDialog());
    onClick(".edit-sources", () => this._openSourcesDialog());
    // la tabella è l'equivalente leggibile del grafico, non un extra
    onClick(".toggle-table", (e) => {
      const card = e.currentTarget.closest(".inner");
      const tabella = card && card.querySelector(".data-table");
      if (!tabella) return;
      const mostrata = tabella.classList.toggle("shown");
      e.currentTarget.textContent = mostrata ? "Grafico" : "Tabella";
      const grafico = card.querySelector(".chart");
      if (grafico) grafico.style.display = mostrata ? "none" : "";
      const legenda = card.querySelector(".legend");
      if (legenda) legenda.style.display = mostrata ? "none" : "";
    });
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

  /* Avviso quando la pagina è più nuova dell'integration in esecuzione.

     Aggiornando da HACS i file cambiano su disco e il browser rilegge
     subito questo JavaScript, ma il Python continua a essere quello già
     caricato: ricaricare l'integration non basta, perché il modulo è in
     memoria e non viene riletto. Finché non si riavvia Home Assistant la
     pagina chiede funzioni che il server non ha, e la risposta è un 404
     che non spiega niente. Meglio dirlo prima che succeda. */
  _staleBackend() {
    const running = this._overview && this._overview.version;
    if (!running || running === PANEL_VERSION || running === "?") return "";

    return `<ha-alert alert-type="warning" title="Riavvia Home Assistant">
      Questa pagina è la ${esc(PANEL_VERSION)}, ma l'integration in esecuzione
      è ancora la ${esc(running)}: l'aggiornamento è arrivato su disco e non
      in memoria. Finché non riavvii, le funzioni nuove rispondono
      «non trovato».
    </ha-alert>`;
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

    const err =
      this._staleBackend() +
      (this._error ? `<ha-alert alert-type="error">${esc(this._error)}</ha-alert>` : "");

    if (this._tab.startsWith("g:")) return err + this._groupTab(this._tab.slice(2));
    if (this._tab === "mappa") return err + this._mapTab();
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
    // dentro la finestra e non ancora partita: il momento è adesso
    if (next.now) return { text: "in finestra adesso", ok: true };

    const d = new Date(next.when);
    const two = (n) => String(n).padStart(2, "0");
    const ora = `${two(d.getHours())}:${two(d.getMinutes())}`;
    if (next.today) return { text: `oggi alle ${ora}`, ok: true };
    const giorno = d.toLocaleDateString("it-IT", { weekday: "long" });
    // Saltare a domani senza dire perché sembrava un errore: l'avvio
    // automatico è uno al giorno, e oggi è già stato speso.
    const nota = next.already_ran ? " (oggi è già partita)" : "";
    return { text: `${giorno} alle ${ora}${nota}`, ok: true };
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
      // Si dice il motivo vero, linea per linea: dare la colpa al
      // bilancio idrico quando la causa è un'altra manda fuori strada.
      const zone = (this._overview.zones || []).filter(
        (z) => (z.category || "altro") === category
      );
      const bloccate = zone.filter((z) => {
        const p = (z.computed || {}).plan || {};
        return !p.should_run && isBlocked(p.reason);
      });

      return `<ha-card><div class="inner">
        <div class="card-head">
          <ha-icon icon="mdi:playlist-check"></ha-icon>
          <h2>Programma</h2>
        </div>
        ${
          bloccate.length
            ? `<div class="empty-state">
                 <ha-icon icon="mdi:cancel"></ha-icon>
                 <p>Nessuna irrigazione in programma.</p>
               </div>
               ${bloccate
                 .map(
                   (z) => `<div class="row">
                     <ha-icon icon="mdi:alert-circle-outline"></ha-icon>
                     <div class="row-main"><span class="row-label">${esc(z.name)}</span></div>
                     <span class="badge warn">${esc(reasonLabel(((z.computed || {}).plan || {}).reason))}</span>
                   </div>`
                 )
                 .join("")}`
            : `<div class="empty-state">
                 <ha-icon icon="mdi:water-check"></ha-icon>
                 <p>Nessuna irrigazione necessaria adesso.</p>
                 <p class="muted small">
                   Il terreno di ${esc(label.toLowerCase())} non ha ancora perso
                   abbastanza acqua per superare la soglia. Quando la supererà,
                   l'irrigazione partirà da sola alla prossima finestra utile.
                 </p>
               </div>`
        }
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
              <span class="sub">${
                r.cycles > 1
                  ? `${r.cycles} passate, alternate con le altre linee`
                  : "passata unica"
              }</span>
            </div>
            <span class="reading small">${esc(r.start)}–${esc(r.end)}</span>
            <span class="badge run">${r.minutes} min d'acqua</span>
          </div>`
        )
        .join("")}
      ${this._cycleTimeline(sched)}
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
          : `<ha-alert alert-type="warning">
               L'irrigazione dura più della finestra: sforerà di
               ${sched.overflow_minutes} min. Una volta partita viene portata a
               termine — allarga la finestra se vuoi che rientri.
             </ha-alert>`
      }
    </div></ha-card>`;
  }

  /* La successione vera delle passate, richiudibile.

     Le righe qui sopra dicono da quando a quando è impegnata una linea,
     ma con le passate alternate quegli intervalli si sovrappongono e da
     soli sembrano un errore. Qui si vede cosa succede davvero: mentre
     una linea assorbe, l'acqua va su un'altra. */
  _cycleTimeline(sched) {
    const cycles = sched.cycles || [];
    if (cycles.length <= 1) return "";

    const righe = cycles
      .map(
        (c) => `<div class="cycle-step">
          <span class="cycle-time">${esc(c.start)}</span>
          <span class="cycle-name">${esc(c.zone_name)}</span>
          <span class="cycle-num muted">${c.cycle}/${c.cycles}</span>
        </div>`
      )
      .join("");

    return `<details class="cycle-list">
      <summary>Sequenza delle passate (${cycles.length})</summary>
      <p class="muted small nomargin">
        Un ciclo è irrigare <b>e poi</b> lasciare assorbire. L'attesa di una
        linea si riempie irrigandone un'altra, così sei linee da quattro
        passate stanno in una finestra invece che in dieci ore.
      </p>
      <div class="cycle-grid">${righe}</div>
    </details>`;
  }

  // ------------------------------------------------------------- GRAFICI

  async _fetchHistory() {
    try {
      const res = await this._api("GET", "history");
      this._history = (res && res.entries) || [];
    } catch (_e) {
      this._history = [];
    }
    this._render();
  }

  _dayTick(iso) {
    const d = new Date(iso);
    return isNaN(d) ? "" : `${d.getDate()}/${d.getMonth() + 1}`;
  }

  /* Struttura comune: cornice, griglia orizzontale a filo, asse discreto.
     Nessuna griglia verticale e nessun tratteggio: aggiungono rumore e
     basta. */
  _chartFrame(id, { width = 640, height = 170, pad = 28 } = {}) {
    return {
      id, width, height,
      left: pad + 18, right: width - 10,
      top: 10, bottom: height - 22,
      get w() { return this.right - this.left; },
      get h() { return this.bottom - this.top; },
    };
  }

  /* L'unità non si scrive dentro al grafico: finirebbe addosso al valore
     più alto dell'asse. Sta nel sottotitolo della card. */
  _axisAndGrid(f, min, max, ticks = 3) {
    const parts = [];
    for (let i = 0; i <= ticks; i++) {
      const v = min + ((max - min) * i) / ticks;
      const y = f.bottom - ((v - min) / (max - min || 1)) * f.h;
      parts.push(
        `<line class="c-grid" x1="${f.left}" y1="${y.toFixed(1)}" x2="${f.right}" y2="${y.toFixed(1)}"></line>`,
        `<text class="c-tick" x="${f.left - 6}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${
          Math.abs(max - min) < 5 ? v.toFixed(1) : Math.round(v)
        }</text>`
      );
    }
    return parts.join("");
  }

  _xLabels(f, entries) {
    // solo alcune etichette: una per ogni punto sarebbe illeggibile
    const step = Math.max(1, Math.ceil(entries.length / 6));
    return entries
      .map((e, i) => {
        if (i % step !== 0 && i !== entries.length - 1) return "";
        const x = f.left + (entries.length === 1 ? f.w / 2 : (i / (entries.length - 1)) * f.w);
        return `<text class="c-tick" x="${x.toFixed(1)}" y="${f.bottom + 14}" text-anchor="middle">${this._dayTick(e.date)}</text>`;
      })
      .join("");
  }

  /* Fascia minima–massima: una sola grandezza, una sola tinta. */
  _bandChart(entries, color) {
    const f = this._chartFrame("temp");
    const vals = entries.flatMap((e) => [e.t_min, e.t_max]).filter((v) => v != null);
    if (!vals.length) return "";
    const min = Math.floor(Math.min(...vals) - 1);
    const max = Math.ceil(Math.max(...vals) + 1);
    const x = (i) => f.left + (entries.length === 1 ? f.w / 2 : (i / (entries.length - 1)) * f.w);
    const y = (v) => f.bottom - ((v - min) / (max - min || 1)) * f.h;

    const alto = entries.map((e, i) => `${x(i).toFixed(1)},${y(e.t_max).toFixed(1)}`);
    const basso = entries.map((e, i) => `${x(i).toFixed(1)},${y(e.t_min).toFixed(1)}`).reverse();
    const ultimo = entries[entries.length - 1];

    return `<svg class="chart" viewBox="0 0 ${f.width} ${f.height}" preserveAspectRatio="none" role="img">
      ${this._axisAndGrid(f, min, max)}
      <polygon class="c-band" points="${[...alto, ...basso].join(" ")}" fill="${color}"></polygon>
      <polyline class="c-line" points="${alto.join(" ")}" stroke="${color}"></polyline>
      <polyline class="c-line c-thin" points="${basso.slice().reverse().join(" ")}" stroke="${color}"></polyline>
      ${this._xLabels(f, entries)}
      <text class="c-endlabel" x="${(x(entries.length - 1) - 4).toFixed(1)}" y="${(y(ultimo.t_max) - 6).toFixed(1)}" text-anchor="end">${ultimo.t_max}°</text>
      <text class="c-endlabel" x="${(x(entries.length - 1) - 4).toFixed(1)}" y="${(y(ultimo.t_min) + 13).toFixed(1)}" text-anchor="end">${ultimo.t_min}°</text>
    </svg>`;
  }

  /* Serie singola: area tenue più linea sottile. */
  _areaChart(entries, key, color, { min0 = false } = {}) {
    const f = this._chartFrame("area");
    const vals = entries.map((e) => e[key]).filter((v) => v != null);
    if (!vals.length) return "";
    const min = min0 ? 0 : Math.floor(Math.min(...vals) - 2);
    const max = Math.ceil(Math.max(...vals) + 2);
    const x = (i) => f.left + (entries.length === 1 ? f.w / 2 : (i / (entries.length - 1)) * f.w);
    const y = (v) => f.bottom - ((v - min) / (max - min || 1)) * f.h;

    const punti = entries
      .map((e, i) => (e[key] == null ? null : `${x(i).toFixed(1)},${y(e[key]).toFixed(1)}`))
      .filter(Boolean);
    if (!punti.length) return "";
    const area = `${f.left},${f.bottom} ${punti.join(" ")} ${x(entries.length - 1).toFixed(1)},${f.bottom}`;
    const ultimo = [...entries].reverse().find((e) => e[key] != null);

    return `<svg class="chart" viewBox="0 0 ${f.width} ${f.height}" preserveAspectRatio="none" role="img">
      ${this._axisAndGrid(f, min, max)}
      <polygon class="c-band" points="${area}" fill="${color}"></polygon>
      <polyline class="c-line" points="${punti.join(" ")}" stroke="${color}"></polyline>
      ${this._xLabels(f, entries)}
      ${
        ultimo
          ? `<text class="c-endlabel" x="${(x(entries.length - 1) - 4).toFixed(1)}" y="${(y(ultimo[key]) - 7).toFixed(1)}" text-anchor="end">${Math.round(ultimo[key])}</text>`
          : ""
      }
    </svg>`;
  }

  /* Barre impilate per gruppo: qui le serie SONO il soggetto. */
  _stackedBars(entries, categories, colors, labels) {
    const f = this._chartFrame("bars");
    const totale = (e) =>
      categories.reduce((s, c) => s + Number((e.irrigated || {})[c] || 0), 0);
    const max = Math.max(10, Math.ceil(Math.max(...entries.map(totale)) / 10) * 10);

    const passo = f.w / entries.length;
    const larghezza = Math.max(3, Math.min(22, passo - 4));

    const barre = entries
      .map((e, i) => {
        const cx = f.left + passo * i + passo / 2;
        let y = f.bottom;
        const segmenti = categories
          .map((c, ci) => {
            const v = Number((e.irrigated || {})[c] || 0);
            if (v <= 0) return "";
            const h = (v / max) * f.h;
            y -= h;
            // 2px di stacco fra i segmenti: separa senza disegnare bordi
            const alt = Math.max(1, h - 2);
            return `<rect class="c-bar" x="${(cx - larghezza / 2).toFixed(1)}" y="${y.toFixed(1)}"
              width="${larghezza}" height="${alt.toFixed(1)}" rx="2" fill="${colors[ci]}"></rect>`;
          })
          .join("");
        return segmenti;
      })
      .join("");

    return `<svg class="chart" viewBox="0 0 ${f.width} ${f.height}" preserveAspectRatio="none" role="img">
      ${this._axisAndGrid(f, 0, max)}
      ${barre}
      ${this._xLabels(f, entries)}
    </svg>`;
  }

  _legend(labels, colors) {
    return `<div class="legend">${labels
      .map(
        (l, i) =>
          `<span class="legend-item"><span class="swatch" style="background:${colors[i]}"></span>${esc(l)}</span>`
      )
      .join("")}</div>`;
  }

  _chartCard(titolo, icona, sottotitolo, contenuto, tabellaId) {
    return `<ha-card><div class="inner">
      <div class="card-head">
        <ha-icon icon="${icona}"></ha-icon>
        <h2>${esc(titolo)}</h2>
        <span class="spacer"></span>
        <button type="button" class="btn toggle-table" data-table="${tabellaId}">Tabella</button>
      </div>
      ${sottotitolo ? `<p class="muted small nomargin">${esc(sottotitolo)}</p>` : ""}
      ${contenuto}
    </div></ha-card>`;
  }

  _historyTable(entries, colonne) {
    const righe = [...entries]
      .reverse()
      .map(
        (e) =>
          `<tr><td>${esc(e.date || "")}</td>${colonne
            .map((c) => `<td>${c.get(e) ?? "—"}</td>`)
            .join("")}</tr>`
      )
      .join("");
    return `<table class="data-table">
      <thead><tr><th>Giorno</th>${colonne.map((c) => `<th>${esc(c.label)}</th>`).join("")}</tr></thead>
      <tbody>${righe}</tbody>
    </table>`;
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
      ${this._irrigationChart()}
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
                ? "orari e giorni si impostano nelle schede dei gruppi"
                : "il master generale è spento: nessuna linea verrà irrigata"
            }</span>
          </div>
          <ha-switch data-master ${on ? "checked" : ""}></ha-switch>
        </div>
        <div class="c-grid">
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

  /* Portata: si mostra il valore inserito dall'utente e, se è in litri,
     anche i mm/h che ne derivano — quelli con cui il motore calcola. */
  /* La freccia "480 L/h → 10 mm/h" va scritta solo se la conversione è
     davvero avvenuta.

     I litri da soli non dicono quanto bagnano: serve la superficie. Se
     manca, il motore ripiega sui mm/h del campo apposito e i litri non
     entrano in nessun conto — ma la riga mostrava lo stesso la freccia,
     facendo credere che il numero a destra venisse da quello a sinistra. */
  _rateText(z) {
    const mm = `${z.rate_mm_h} mm/h`;
    if (!z.rate_mode || z.rate_mode === "mm_h" || !z.flow_value) return mm;

    const unita = z.rate_mode === "l_min" ? "L/min" : "L/h";
    if (!(Number(z.area_m2) > 0)) {
      return `${z.flow_value} ${unita} senza superficie: in uso ${mm}`;
    }
    return `${z.flow_value} ${unita} su ${z.area_m2} m² → ${mm}`;
  }

  /* True se la portata è stata inserita in litri ma manca la superficie:
     i litri non vengono usati e la durata esce da un numero di riserva. */
  _rateIncomplete(z) {
    return (
      z.rate_mode &&
      z.rate_mode !== "mm_h" &&
      !!z.flow_value &&
      !(Number(z.area_m2) > 0)
    );
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

  /* Programma complessivo: si compone dai programmi dei singoli gruppi,
     ognuno con la propria finestra. Calcolarlo su un'unica finestra di
     sistema mostrava orari sbagliati — le aiuole alle 04:00 quando la
     loro finestra è alle 13:45. */
  _sequenceCard(_schedIgnorato, sys) {
    const groups = this._overview.groups || {};
    const options = this._overview.options || {};
    const ordine = options.categories || ["prato", "aiuole", "orto", "altro"];
    const etichette = options.category_labels || {};

    const conRun = ordine
      .map((key) => ({ key, label: etichette[key] || key, g: groups[key] }))
      .filter((x) => x.g && ((x.g.schedule || {}).runs || []).length);

    if (!conRun.length) {
      return `<ha-card><div class="inner">
        <div class="card-head">
          <ha-icon icon="mdi:playlist-play"></ha-icon>
          <h2>Programma di irrigazione</h2>
        </div>
        <div class="empty-state">
          <ha-icon icon="mdi:water-check"></ha-icon>
          <p>Nessuna irrigazione necessaria adesso.</p>
          <p class="muted small">
            Non c'è nessun programma da creare: il sistema calcola da solo
            quanta acqua serve e irriga quando il terreno scende sotto
            soglia. Gli orari e i giorni si impostano nelle schede dei
            singoli gruppi.
          </p>
        </div>
      </div></ha-card>`;
    }

    const sezioni = conRun
      .map(({ key, label, g }) => {
        const sched = g.schedule || {};
        const prossima = this._nextRunText(g.next_run);
        return `<div class="sched-group">
          <div class="row">
            <ha-icon icon="${esc((options.category_icons || {})[key] || "mdi:sprinkler")}"></ha-icon>
            <div class="row-main">
              <span class="row-label">${esc(label)}</span>
              <span class="sub">finestra ${esc((g.window || {}).label || "")} · ${esc(prossima.text)}</span>
            </div>
            <span class="badge run">${sched.total_minutes} min</span>
          </div>
          ${(sched.runs || [])
            .map(
              (r) => `<div class="row sched-run">
                <span class="log-time">${esc(r.start)}</span>
                <div class="row-main"><span class="row-label">${esc(r.zone_name)}</span></div>
                <span class="reading small">${esc(r.start)}–${esc(r.end)}</span>
                <span class="badge run">${r.minutes} min</span>
              </div>`
            )
            .join("")}
        </div>`;
      })
      .join("");

    return `<ha-card><div class="inner">
      <div class="card-head">
        <ha-icon icon="mdi:playlist-play"></ha-icon>
        <h2>Programma di irrigazione</h2>
        <span class="spacer"></span>
        <span class="sub">ogni gruppo nella sua finestra</span>
      </div>
      ${sezioni}
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

      <div class="c-bar" title="Deficit ${deficit.toFixed(1)} mm su TAW ${taw.toFixed(1)} mm">
        <div class="bar-fill${deficit >= threshold ? " over" : ""}" style="width:${pct}%"></div>
        <div class="bar-thr" style="left:${thrPct}%"></div>
      </div>
      <div class="zone-meta">
        <span><b>${deficit.toFixed(1)}</b> mm deficit</span>
        <span class="${this._rateIncomplete(z) ? "warntext" : "muted"}">soglia ${threshold.toFixed(1)} · TAW ${taw.toFixed(1)} mm · ${esc(this._rateText(z))}</span>
        <span class="spacer"></span>
        ${valve}
      </div>
      ${
        this._rateIncomplete(z)
          ? `<ha-alert alert-type="warning">
               La portata è in litri ma manca la superficie della zona, quindi
               i litri non vengono usati: la durata esce dai ${z.rate_mm_h} mm/h
               del campo apposito. Un litro su un metro quadro fa un
               millimetro — senza sapere su quanti metri quadri cade, i litri
               non dicono quanto bagnano.
             </ha-alert>`
          : ""
      }
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

  /* ---------------------------------------------------------------------
     MAPPA

     La planimetria del giardino con le aree disegnate sopra. Il colore
     del riempimento non si configura: lo decide il bilancio idrico, ed è
     tutto il motivo per cui questa pagina esiste — si guarda la foto e si
     capisce dove manca acqua senza leggere un numero.

     I vertici sono in coordinate 0..1 sui lati dell'immagine, quindi il
     disegno regge il telefono e il desktop senza ridisegnarlo. Il
     riquadro segue esattamente l'immagine (`width:100%; height:auto`),
     così l'SVG sovrapposto combacia con `preserveAspectRatio="none"`
     senza calcoli di lettering.
     --------------------------------------------------------------------- */

  _mapData() {
    const map = (this._overview && this._overview.map) || {};
    return { map, areas: map.areas || [] };
  }

  _areaById(id) {
    return this._mapData().areas.find((a) => a.id === id) || null;
  }

  _areaZone(area) {
    if (!area || !area.zone_id) return null;
    return (this._overview.zones || []).find((z) => z.id === area.zone_id) || null;
  }

  /* Stato dell'area: quello della linea collegata, così mappa, dashboard
     e scheda del gruppo raccontano la stessa cosa. */
  _areaStatus(area) {
    const zone = this._areaZone(area);
    if (!zone) return { level: "none", label: "nessuna linea collegata" };
    return zoneStatus(zone, (this._overview.running || {}).zone_id || null);
  }

  /* Nome dell'area: il suo, se gliene è stato dato uno, altrimenti
     quello della linea collegata.

     Chiamare "Area 3" il pezzo di prato che si chiama "Prato Sud"
     costringe a ribattere lo stesso nome due volte e a tenerlo allineato
     a mano. Stesso criterio dell'icona, che pure eredita dalla linea. */
  _areaName(area) {
    if (area && area.name) return area.name;
    const zone = this._areaZone(area);
    return (zone && zone.name) || "Area senza nome";
  }

  _areaIcon(area) {
    if (area.icon) return area.icon;
    const zone = this._areaZone(area);
    if (zone) return zone.icon || ZONE_TYPE_ICONS[zone.zone_type] || "mdi:sprinkler";
    return "mdi:vector-polygon";
  }

  /* Baricentro del poligono (formula dell'area con segno).

     Non la media dei vertici: un lato spezzato in molti punti tirerebbe
     l'icona verso quel lato invece che al centro dell'area. */
  _centroid(points) {
    if (!points || !points.length) return [0.5, 0.5];
    if (points.length < 3) return points[0].slice();

    let twiceArea = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < points.length; i++) {
      const [x0, y0] = points[i];
      const [x1, y1] = points[(i + 1) % points.length];
      const cross = x0 * y1 - x1 * y0;
      twiceArea += cross;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
    }
    // poligono degenere (tutti i punti allineati): l'area è zero e la
    // formula divide per zero, si ripiega sulla media
    if (!twiceArea) {
      const n = points.length;
      return [
        points.reduce((s, p) => s + p[0], 0) / n,
        points.reduce((s, p) => s + p[1], 0) / n,
      ];
    }
    return [cx / (3 * twiceArea), cy / (3 * twiceArea)];
  }

  _iconPos(area) {
    if (area.icon_x != null && area.icon_y != null) {
      return [Number(area.icon_x), Number(area.icon_y)];
    }
    return this._centroid(area.points || []);
  }

  /* La colonna delle card sta fuori da ciò che viene ridisegnato.

     Le card Lovelace sono elementi veri, costruiti da Home Assistant e
     con uno stato loro (un grafico a metà animazione, una previsione
     appena caricata): ricrearle a ogni movimento del dito su un vertice
     sarebbe uno spreco e le farebbe sfarfallare. `_repaintMap` tocca
     quindi solo la colonna di sinistra. */
  _mapTab() {
    return `<div class="map-tab">
      <div class="map-grid">
        <div class="map-main">${this._mapTabInner()}</div>
        <div class="map-side"></div>
      </div>
    </div>`;
  }

  _mapTabInner() {
    const { map, areas } = this._mapData();
    const edit = !!this._mapEdit;

    if (!map.image_src) return this._mapEmpty();

    return `
      ${this._mapToolbar(areas)}
      <ha-card class="map-card">
        <div class="map-wrap${edit ? " editing" : ""}"
             style="--fill-op:${Number(map.fill_opacity ?? 0.35)}">
          <img class="map-img" src="${esc(map.image_src)}" alt="Planimetria" draggable="false">
          <svg class="map-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
            ${this._mapSvgInner()}
          </svg>
          <div class="map-layer">${this._mapLayerInner()}</div>
        </div>
      </ha-card>
      ${edit ? this._mapAreaList(areas) : this._mapLegend()}
      <input type="file" class="map-file" accept="image/*" hidden>`;
  }

  _mapEmpty() {
    return `
      <ha-card><div class="inner">
        <div class="card-head">
          <ha-icon icon="mdi:map-outline"></ha-icon><h2>Mappa del giardino</h2>
        </div>
        <p class="muted small nomargin">
          Carica una planimetria — una foto aerea, un disegno, uno screenshot
          da una mappa — e disegnaci sopra le aree irrigate. Ogni area prende
          il colore dal bilancio idrico della sua linea, e toccandone l'icona
          si fa partire l'irrigazione.
        </p>
        <div class="tab-actions">
          ${this._button("map-upload", "Carica immagine", { primary: true })}
          ${this._button("map-url", "Usa un indirizzo")}
        </div>
      </div></ha-card>
      <input type="file" class="map-file" accept="image/*" hidden>`;
  }

  _mapToolbar(areas) {
    const edit = !!this._mapEdit;
    const busy = !!(this._overview.running || {}).active;
    const drawing = !!this._draft;
    const selected = this._selArea ? this._areaById(this._selArea) : null;
    const canRemoveVertex =
      selected && this._selVertex != null && (selected.points || []).length > 3;

    if (!edit) {
      return `<div class="map-toolbar">
        ${
          busy
            ? this._button("stop-all", "Ferma", { danger: true })
            : this._button("run-all", "Irriga tutte le aree", { primary: true })
        }
        <span class="spacer"></span>
        <span class="sub">${areas.length} ${areas.length === 1 ? "area" : "aree"}</span>
        ${this._button("map-edit", "Modifica")}
      </div>`;
    }

    if (drawing) {
      return `<div class="map-toolbar">
        <span class="sub">
          Tocca l'immagine per posare i vertici · ${this._draft.length}
          ${this._draft.length === 1 ? "punto" : "punti"}
        </span>
        <span class="spacer"></span>
        ${this._button("draw-undo", "Annulla punto")}
        ${this._button("draw-cancel", "Annulla")}
        ${this._draft.length >= 3
          ? this._button("draw-close", "Chiudi area", { primary: true })
          : ""}
      </div>`;
    }

    return `<div class="map-toolbar">
      ${this._button("area-add", "Nuova area", { primary: true })}
      ${selected ? this._button("area-edit", "Impostazioni") : ""}
      ${canRemoveVertex ? this._button("vertex-del", "Elimina punto") : ""}
      ${selected ? this._button("area-del", "Elimina area", { danger: true }) : ""}
      <span class="spacer"></span>
      ${this._button("map-image", "Immagine")}
      ${this._button("map-done", "Fine")}
    </div>`;
  }

  _mapSvgInner() {
    const { areas } = this._mapData();
    const toPts = (points) =>
      points
        .map((p) => `${(p[0] * 100).toFixed(3)},${(p[1] * 100).toFixed(3)}`)
        .join(" ");

    const shapes = areas
      .filter((a) => (a.points || []).length >= 3)
      .map((area) => {
        const status = this._areaStatus(area);
        const sel = this._mapEdit && this._selArea === area.id ? " selected" : "";
        const stroke = area.color ? `--area-stroke:${esc(area.color)};` : "";
        return `<polygon class="area s-${status.level}${sel}" data-area="${esc(area.id)}"
                  points="${toPts(area.points)}" style="${stroke}"></polygon>`;
      })
      .join("");

    // area in corso di disegno: linea aperta, così si vede che non è
    // ancora chiusa
    const draft = this._draft && this._draft.length
      ? `<polyline class="draft" points="${toPts(this._draft)}"></polyline>`
      : "";

    return shapes + draft;
  }

  _mapLayerInner() {
    const { areas } = this._mapData();
    const edit = !!this._mapEdit;
    const pct = (v) => `${(v * 100).toFixed(3)}%`;

    const icons = areas
      .filter((a) => a.show_icon !== false && (a.points || []).length >= 3)
      .map((area) => {
        const [x, y] = this._iconPos(area);
        const status = this._areaStatus(area);
        const color = area.icon_color ? `--icon-color:${esc(area.icon_color)};` : "";
        const live = area.icon_entity ? this._liveState(area.icon_entity) : null;
        // marcata con data-entity: si aggiorna a ogni cambio di stato,
        // senza aspettare il giro di ricarica della pagina
        const readout =
          live && !live.missing
            ? `<span class="map-read" data-entity="${esc(area.icon_entity)}">${esc(
                live.value
              )}${live.unit ? ` ${esc(live.unit)}` : ""}</span>`
            : "";
        const name = area.show_label === false ? "" :
          `<span class="map-name">${esc(this._areaName(area))}</span>`;

        return `<button type="button" class="map-icon s-${status.level}"
                  data-icon-area="${esc(area.id)}" style="left:${pct(x)};top:${pct(y)};${color}"
                  title="${esc(this._areaName(area))} — ${esc(status.label)}">
                  <ha-icon icon="${esc(this._areaIcon(area))}"></ha-icon>
                  ${name}${readout}
                </button>`;
      })
      .join("");

    if (!edit) return icons;

    // maniglie: solo per l'area selezionata, altrimenti la mappa diventa
    // un puntaspilli e non si distingue più cosa si sta modificando
    const area = this._selArea ? this._areaById(this._selArea) : null;
    const points = (area && area.points) || [];
    const handles = points
      .map((p, i) => {
        const sel = this._selVertex === i ? " on" : "";
        const [nx, ny] = points[(i + 1) % points.length];
        const mid = `<span class="map-mid" data-mid="${i}"
            style="left:${pct((p[0] + nx) / 2)};top:${pct((p[1] + ny) / 2)}"
            title="Aggiungi un punto"></span>`;
        return `<span class="map-vertex${sel}" data-vertex="${i}"
            style="left:${pct(p[0])};top:${pct(p[1])}"></span>${
          points.length >= 3 ? mid : ""
        }`;
      })
      .join("");

    const draftHandles = (this._draft || [])
      .map(
        (p, i) => `<span class="map-vertex draft" data-draft="${i}"
            style="left:${pct(p[0])};top:${pct(p[1])}"></span>`
      )
      .join("");

    return icons + handles + draftHandles;
  }

  _mapAreaList(areas) {
    if (!areas.length) {
      return `<ha-card><div class="inner"><div class="empty-state">
        <ha-icon icon="mdi:vector-polygon"></ha-icon>
        <p>Nessuna area disegnata. Tocca <b>Nuova area</b> e posa i vertici
           sull'immagine.</p>
      </div></div></ha-card>`;
    }

    const rows = areas
      .map((area) => {
        const zone = this._areaZone(area);
        const status = this._areaStatus(area);
        const sel = this._selArea === area.id ? " selected" : "";
        return `<div class="row area-row${sel}" data-area-row="${esc(area.id)}">
          <ha-icon icon="${esc(this._areaIcon(area))}"></ha-icon>
          <div class="row-main">
            <span class="row-label">${esc(this._areaName(area))}</span>
            <span class="sub">${
              zone ? esc(zone.name) : "nessuna linea collegata"
            } · ${(area.points || []).length} punti</span>
          </div>
          <span class="badge st-${status.level}">${esc(status.label)}</span>
          <ha-icon-button class="area-settings" data-id="${esc(area.id)}" label="Impostazioni">
            <ha-icon icon="mdi:pencil"></ha-icon>
          </ha-icon-button>
          <ha-icon-button class="area-remove" data-id="${esc(area.id)}" label="Elimina">
            <ha-icon icon="mdi:delete"></ha-icon>
          </ha-icon-button>
        </div>`;
      })
      .join("");

    return `<ha-card><div class="inner">
      <div class="card-head">
        <ha-icon icon="mdi:vector-polygon"></ha-icon><h2>Aree</h2>
      </div>
      <p class="muted small nomargin">
        Tocca un'area sull'immagine per selezionarla: compaiono le maniglie
        dei vertici, i punti a metà lato ne aggiungono di nuovi, e
        trascinando l'interno si sposta tutta l'area.
      </p>
      ${rows}
    </div></ha-card>`;
  }

  _mapLegend() {
    const voci = [
      ["ok", "a posto"],
      ["thirsty", "chiede acqua"],
      ["critical", "carenza forte"],
      ["watering", "in irrigazione"],
    ];
    return `<ha-card><div class="inner">
      <div class="map-legend">
        ${voci
          .map(
            ([level, testo]) =>
              `<span class="legend-item"><i class="swatch s-${level}"></i>${testo}</span>`
          )
          .join("")}
      </div>
    </div></ha-card>`;
  }

  // ------------------------------------------------------ mappa: comandi

  _repaintMap() {
    const main = this.shadowRoot.querySelector(".map-main");
    if (!main) {
      this._render();
      return;
    }
    main.innerHTML = this._mapTabInner();
    this._bindMap();
    this._renderCards();
  }

  /* Ridisegna i soli poligoni e maniglie.

     Durante un trascinamento si passa di qui e non da `_repaintMap`:
     rifare a ogni movimento del dito anche barra e lista costa, e
     soprattutto sostituirebbe l'elemento su cui il browser sta seguendo
     il puntatore. */
  _repaintMapLayers() {
    const tab = this.shadowRoot.querySelector(".map-tab");
    const svg = tab && tab.querySelector(".map-svg");
    const layer = tab && tab.querySelector(".map-layer");
    if (!svg || !layer) {
      this._repaintMap();
      return;
    }
    svg.innerHTML = this._mapSvgInner();
    layer.innerHTML = this._mapLayerInner();
  }

  /* Posizione del puntatore in coordinate 0..1 sull'immagine.

     Il riquadro si misura **una volta sola**, all'inizio del
     trascinamento: durante il gesto la pagina viene ridisegnata, e
     misurare un elemento appena staccato dal documento darebbe zero. */
  _pointIn(ev, box) {
    const clamp = (v) => Math.min(1, Math.max(0, v));
    return [
      clamp((ev.clientX - box.left) / (box.width || 1)),
      clamp((ev.clientY - box.top) / (box.height || 1)),
    ];
  }

  /* ------------------------------------------------------ card Lovelace

     Accanto alla mappa si possono mettere card di Home Assistant: la
     previsione, una markdown col riassunto, quello che serve. Non le
     disegna questo pannello — le costruisce il frontend con
     `loadCardHelpers()`, lo stesso meccanismo delle dashboard. Vuol dire
     che funziona qualunque card, comprese quelle installate da HACS, e
     che questa integration non deve sapere niente di nessuna di esse. */

  async _renderCards() {
    const side = this.shadowRoot.querySelector(".map-side");
    if (!side) return;

    const configs = this._mapData().map.cards || [];
    const edit = !!this._mapEdit;

    // Firma della colonna: si ricostruisce solo se è cambiato qualcosa.
    // Senza, ogni giro di aggiornamento butterebbe via card vive — un
    // grafico a metà animazione, una previsione appena caricata.
    const key = JSON.stringify([configs, edit]);
    if (side._key === key && side.childElementCount) return;
    side._key = key;

    side.innerHTML = "";
    this._cardEls = [];

    if (edit) side.appendChild(this._cardsEditor(configs));

    if (!configs.length) {
      if (!edit) {
        const hint = document.createElement("ha-card");
        hint.innerHTML = `<div class="inner"><div class="empty-state">
          <ha-icon icon="mdi:view-dashboard-outline"></ha-icon>
          <p>Nessuna card. Da <b>Modifica</b> puoi affiancare alla mappa
             la previsione meteo, una markdown, quello che ti serve.</p>
        </div></div>`;
        side.appendChild(hint);
      }
      return;
    }

    let helpers = null;
    try {
      helpers = window.loadCardHelpers ? await window.loadCardHelpers() : null;
    } catch (_e) {
      helpers = null;
    }
    if (!helpers) {
      const alert = document.createElement("ha-alert");
      alert.setAttribute("alert-type", "warning");
      alert.textContent =
        "Le card di Home Assistant non sono disponibili in questa pagina.";
      side.appendChild(alert);
      return;
    }

    for (const config of configs) {
      let card;
      try {
        card = await helpers.createCardElement(config);
        card.hass = this._hass;
      } catch (err) {
        // una card scritta male non deve portarsi dietro le altre
        card = document.createElement("ha-alert");
        card.setAttribute("alert-type", "error");
        card.textContent = `Card "${(config && config.type) || "?"}" non valida: ${
          (err && err.message) || err
        }`;
      }
      side.appendChild(card);
      this._cardEls.push(card);
    }
  }

  /* Elenco delle card, con l'ordine in cui compaiono. */
  _cardsEditor(configs) {
    const card = document.createElement("ha-card");
    const rows = configs
      .map(
        (config, index) => `<div class="row">
          <ha-icon icon="mdi:card-outline"></ha-icon>
          <div class="row-main">
            <span class="row-label">${esc(config.type || "card")}</span>
            <span class="sub">${esc(
              config.entity || config.title || `posizione ${index + 1}`
            )}</span>
          </div>
          <ha-icon-button class="card-up" data-i="${index}" label="Su">
            <ha-icon icon="mdi:arrow-up"></ha-icon>
          </ha-icon-button>
          <ha-icon-button class="card-down" data-i="${index}" label="Giù">
            <ha-icon icon="mdi:arrow-down"></ha-icon>
          </ha-icon-button>
          <ha-icon-button class="card-edit" data-i="${index}" label="Modifica">
            <ha-icon icon="mdi:pencil"></ha-icon>
          </ha-icon-button>
          <ha-icon-button class="card-del" data-i="${index}" label="Elimina">
            <ha-icon icon="mdi:delete"></ha-icon>
          </ha-icon-button>
        </div>`
      )
      .join("");

    card.innerHTML = `<div class="inner">
      <div class="card-head">
        <ha-icon icon="mdi:view-dashboard-outline"></ha-icon><h2>Card</h2>
        <span class="spacer"></span>
        ${this._button("card-add", "Aggiungi", { primary: true })}
      </div>
      ${rows || `<p class="muted small nomargin">Nessuna card accanto alla mappa.</p>`}
    </div>`;

    const on = (sel, fn) =>
      card.querySelectorAll(sel).forEach((el) => el.addEventListener("click", fn));
    const at = (e) => Number(e.currentTarget.getAttribute("data-i"));

    on(".card-add", () => this._openCardDialog(null));
    on(".card-edit", (e) => this._openCardDialog(at(e)));
    on(".card-del", (e) => this._saveCards(configs.filter((_c, i) => i !== at(e))));
    on(".card-up", (e) => this._moveCard(at(e), -1));
    on(".card-down", (e) => this._moveCard(at(e), 1));
    return card;
  }

  _moveCard(index, direction) {
    const cards = [...(this._mapData().map.cards || [])];
    const target = index + direction;
    if (target < 0 || target >= cards.length) return;
    [cards[index], cards[target]] = [cards[target], cards[index]];
    this._saveCards(cards);
  }

  async _saveCards(cards) {
    await this._mutate("POST", "map", { cards });
  }

  /* La configurazione si scrive in YAML, come in una dashboard: è il
     formato in cui la si trova scritta ovunque, e da cui la si copia. */
  _openCardDialog(index) {
    const cards = [...(this._mapData().map.cards || [])];
    const current = index == null ? null : cards[index];
    const yamlReady = has("ha-yaml-editor");

    const dlg = this._makeDialog(current ? "Modifica card" : "Aggiungi card");
    const wrap = document.createElement("div");
    wrap.className = "form";

    const hint = document.createElement("p");
    hint.className = "muted small nomargin";
    hint.textContent = yamlReady
      ? "La stessa configurazione che scriveresti in una dashboard."
      : "Editor YAML non disponibile: scrivi la configurazione in JSON.";
    wrap.appendChild(hint);

    const starter = current || { type: "weather-forecast", show_forecast: true };
    let value = starter;
    let editor;

    if (yamlReady) {
      editor = document.createElement("ha-yaml-editor");
      editor.defaultValue = starter;
      editor.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        if (ev.detail.isValid !== false) value = ev.detail.value;
      });
    } else {
      editor = document.createElement("textarea");
      editor.className = "ha-control card-json";
      editor.rows = 12;
      editor.value = JSON.stringify(starter, null, 2);
      editor.addEventListener("input", () => {
        try {
          value = JSON.parse(editor.value);
        } catch (_e) {
          /* la validità si controlla al salvataggio */
        }
      });
    }
    wrap.appendChild(editor);
    dlg.appendChild(wrap);

    const close = () => dlg.remove();
    dlg.appendChild(
      this._actionBar(
        "Salva",
        async () => {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            close();
            this._error = "La configurazione della card non è valida.";
            this._render();
            return;
          }
          if (index == null) cards.push(value);
          else cards[index] = value;
          close();
          await this._saveCards(cards);
        },
        close
      )
    );

    this.shadowRoot.appendChild(dlg);
    this._layoutFallback(dlg);
  }

  _bindMap() {
    const tab = this.shadowRoot.querySelector(".map-tab");
    if (!tab) return;

    const on = (sel, fn) =>
      tab.querySelectorAll(sel).forEach((el) => el.addEventListener("click", fn));

    on(".map-upload, .map-image", () => tab.querySelector(".map-file").click());
    on(".map-url", () => this._openMapImageDialog());
    on(".map-edit", () => {
      this._mapEdit = true;
      this._repaintMap();
    });
    on(".map-done", () => {
      this._mapEdit = false;
      this._selArea = null;
      this._selVertex = null;
      this._draft = null;
      this._repaintMap();
    });
    on(".area-add", () => {
      this._draft = [];
      this._selArea = null;
      this._selVertex = null;
      this._repaintMap();
    });
    on(".draw-cancel", () => {
      this._draft = null;
      this._repaintMap();
    });
    on(".draw-undo", () => {
      if (this._draft) this._draft.pop();
      this._repaintMap();
    });
    on(".draw-close", () => this._closeDraft());
    on(".area-edit", () => this._openAreaDialog(this._selArea));
    on(".area-del", () => this._confirmDeleteArea(this._selArea));
    on(".vertex-del", () => this._removeVertex());
    // i due pulsanti stanno dentro la riga, che a sua volta seleziona:
    // senza fermare la risalita si aprirebbe anche la selezione
    on(".area-settings", (e) => {
      e.stopPropagation();
      this._openAreaDialog(e.currentTarget.getAttribute("data-id"));
    });
    on(".area-remove", (e) => {
      e.stopPropagation();
      this._confirmDeleteArea(e.currentTarget.getAttribute("data-id"));
    });
    on(".area-row", (e) => {
      this._selArea = e.currentTarget.getAttribute("data-area-row");
      this._selVertex = null;
      this._repaintMap();
    });
    on(".run-all", () => this._mutate("POST", "run", {}));
    on(".stop-all", () => this._mutate("POST", "stop", {}));

    const file = tab.querySelector(".map-file");
    if (file) {
      file.addEventListener("change", (e) => {
        const chosen = e.target.files && e.target.files[0];
        e.target.value = "";
        this._uploadImage(chosen);
      });
    }

    const wrap = tab.querySelector(".map-wrap");
    if (!wrap) return;
    wrap.addEventListener("pointerdown", (e) => this._mapPointerDown(e, wrap));
    wrap.addEventListener("dragstart", (e) => e.preventDefault());
  }

  _mapPointerDown(ev, wrap) {
    const path = ev.composedPath ? ev.composedPath() : [ev.target];
    const hit = (attr) => path.find((n) => n.getAttribute && n.getAttribute(attr) != null);
    // misurato adesso, prima di qualunque ridisegno
    const box = wrap.getBoundingClientRect();

    // disegno in corso: ogni tocco posa un vertice
    if (this._draft) {
      ev.preventDefault();
      this._draft.push(this._pointIn(ev, box));
      this._repaintMap();
      return;
    }

    const iconNode = hit("data-icon-area");
    const polyHit = hit("data-area");

    if (!this._mapEdit) {
      // In visualizzazione la mappa è un pannello di comando, non un
      // editor: vale sia l'icona sia l'area sotto, perché su un telefono
      // centrare l'icona è più difficile che toccare il prato.
      const tapped = iconNode || polyHit;
      if (tapped) {
        this._areaTapped(
          tapped.getAttribute("data-icon-area") || tapped.getAttribute("data-area")
        );
      }
      return;
    }

    const vertexNode = hit("data-vertex");
    const midNode = hit("data-mid");
    const polyNode = polyHit;

    if (midNode) {
      const area = this._areaById(this._selArea);
      const index = Number(midNode.getAttribute("data-mid"));
      if (!area) return;
      const next = (index + 1) % area.points.length;
      const middle = [
        (area.points[index][0] + area.points[next][0]) / 2,
        (area.points[index][1] + area.points[next][1]) / 2,
      ];
      area.points.splice(index + 1, 0, middle);
      this._selVertex = index + 1;
      this._repaintMap();
      this._saveArea(area);
      return;
    }

    if (vertexNode) {
      const area = this._areaById(this._selArea);
      if (!area) return;
      const index = Number(vertexNode.getAttribute("data-vertex"));
      this._selVertex = index;
      this._repaintMap();
      this._dragOn(ev, box, area, (point) => {
        area.points[index] = point;
      });
      return;
    }

    if (iconNode) {
      const area = this._areaById(iconNode.getAttribute("data-icon-area"));
      if (!area) return;
      this._selArea = area.id;
      this._selVertex = null;
      this._repaintMap();
      // l'icona si stacca dal baricentro solo se la si sposta davvero
      this._dragOn(ev, box, area, (point) => {
        area.icon_x = point[0];
        area.icon_y = point[1];
      });
      return;
    }

    if (polyNode) {
      const area = this._areaById(polyNode.getAttribute("data-area"));
      if (!area) return;
      const first = this._selArea !== area.id;
      this._selArea = area.id;
      this._selVertex = null;
      this._repaintMap();
      // il primo tocco seleziona e basta: trascinare per sbaglio un'area
      // appena scelta è il modo più facile per rovinare un disegno
      if (first) return;

      const start = this._pointIn(ev, box);
      const origin = area.points.map((p) => p.slice());
      this._dragOn(ev, box, area, (point) => {
        const dx = point[0] - start[0];
        const dy = point[1] - start[1];
        area.points = origin.map(([x, y]) => [
          Math.min(1, Math.max(0, x + dx)),
          Math.min(1, Math.max(0, y + dy)),
        ]);
      });
      return;
    }

    // fuori da tutto: si deseleziona
    if (this._selArea) {
      this._selArea = null;
      this._selVertex = null;
      this._repaintMap();
    }
  }

  /* Trascinamento: si ridisegna a ogni movimento, si salva solo alla
     fine. Una chiamata al server per ogni pixel percorso intaserebbe la
     rete e la scheda SD del Raspberry. */
  _dragOn(ev, box, area, onMove) {
    ev.preventDefault();
    this._mapDragging = true;
    let moved = false;

    const move = (e) => {
      moved = true;
      onMove(this._pointIn(e, box));
      this._repaintMapLayers();
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      this._mapDragging = false;
      if (moved) this._saveArea(area);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  async _saveArea(area) {
    try {
      await this._api("POST", `areas/${area.id}`, {
        points: area.points,
        icon_x: area.icon_x ?? null,
        icon_y: area.icon_y ?? null,
      });
      this._error = null;
    } catch (err) {
      this._error = (err && err.message) || String(err);
      this._render();
    }
  }

  async _closeDraft() {
    const points = this._draft || [];
    if (points.length < 3) return;
    this._draft = null;

    try {
      // senza nome: lo prenderà dalla linea che si sta per collegare, che
      // è il passo subito successivo
      const res = await this._api("POST", "areas", { name: "", points });
      if (res && res.overview) this._overview = res.overview;
      this._selArea = res && res.area ? res.area.id : null;
      this._repaintMap();
      // il disegno è la parte difficile: appena chiuso si chiede subito a
      // cosa serve, invece di lasciare in giro un poligono senza nome
      if (this._selArea) this._openAreaDialog(this._selArea);
    } catch (err) {
      this._error = (err && err.message) || String(err);
      this._render();
    }
  }

  _removeVertex() {
    const area = this._areaById(this._selArea);
    if (!area || this._selVertex == null) return;
    if ((area.points || []).length <= 3) return; // sotto i tre non è più un'area
    area.points.splice(this._selVertex, 1);
    this._selVertex = null;
    this._repaintMap();
    this._saveArea(area);
  }

  /* Tocco su un'icona in visualizzazione: è la scorciatoia per irrigare.
     Senza linea collegata si apre l'entità, che è l'unica cosa sensata
     che si possa fare. */
  _areaTapped(areaId) {
    const area = this._areaById(areaId);
    if (!area) return;
    const zone = this._areaZone(area);

    if (zone) {
      if (!zone.enabled) {
        this._error = `${zone.name} è disattivata: riattivala per irrigarla.`;
        this._render();
        return;
      }
      this._openForceDialog(zone.id);
      return;
    }
    if (area.icon_entity) {
      this.dispatchEvent(
        new CustomEvent("hass-more-info", {
          detail: { entityId: area.icon_entity },
          bubbles: true,
          composed: true,
        })
      );
    }
  }

  /* Il caricamento non passa da `callApi`: quello serializza in JSON, e
     qui va spedito il file così com'è. */
  async _uploadImage(file) {
    if (!file) return;
    try {
      const body = new FormData();
      body.append("file", file);
      const url = "/api/irrigazione_smart/map/image";
      const resp = this._hass.fetchWithAuth
        ? await this._hass.fetchWithAuth(url, { method: "POST", body })
        : await fetch(url, {
            method: "POST",
            body,
            headers: { authorization: `Bearer ${this._hass.auth.data.access_token}` },
          });

      if (!resp.ok) {
        const detail = await resp.json().catch(() => null);
        throw new Error(
          (detail && detail.message) || `Caricamento non riuscito (${resp.status})`
        );
      }

      const data = await resp.json();
      if (data && data.overview) this._overview = data.overview;
      this._error = null;
      this._render();
    } catch (err) {
      this._error = (err && err.message) || String(err);
      this._render();
    }
  }

  _openMapImageDialog() {
    const { map } = this._mapData();
    this._showForm(
      "Immagine della mappa",
      [
        {
          key: "image_url",
          label: "Indirizzo dell'immagine",
          helper: "Per esempio /local/giardino.png, cioè config/www/giardino.png",
        },
        {
          key: "fill_opacity",
          label: "Trasparenza delle aree",
          type: "number",
          min: 0,
          max: 1,
          step: 0.05,
          helper: "0 = solo il contorno, 1 = riempimento pieno",
        },
      ],
      { image_url: map.image_url || "", fill_opacity: map.fill_opacity ?? 0.35 },
      async (values) => {
        await this._mutate("POST", "map", {
          image_url: values.image_url || null,
          ...(values.image_url ? { image_id: null } : {}),
          fill_opacity: Number(values.fill_opacity ?? 0.35),
        });
      }
    );
  }

  _openAreaDialog(areaId) {
    const area = this._areaById(areaId);
    if (!area) return;

    const zones = this._overview.zones || [];
    const zoneLabels = { "": "Nessuna" };
    zones.forEach((z) => {
      zoneLabels[z.id] = z.name;
    });

    this._showForm(
      "Area della mappa",
      [
        {
          key: "zone_id",
          label: "Linea collegata",
          type: "select",
          options: ["", ...zones.map((z) => z.id)],
          labels: zoneLabels,
          helper:
            "Da qui arrivano nome, icona, colore del riempimento e l'irrigazione al tocco",
        },
        {
          key: "name",
          label: "Nome",
          helper: "Vuoto = quello della linea collegata",
        },
        { type: "section", label: "Aspetto" },
        {
          key: "color",
          label: "Colore del bordo",
          type: "color",
          helper: "Il riempimento non si sceglie: lo decide il bilancio idrico",
        },
        { key: "icon", label: "Icona", type: "icon",
          helper: "Vuota = quella della linea collegata" },
        { key: "icon_color", label: "Colore dell'icona", type: "color" },
        { key: "show_icon", label: "Mostra l'icona", type: "boolean" },
        { key: "show_label", label: "Mostra il nome", type: "boolean" },
        {
          key: "icon_entity",
          label: "Entità mostrata dall'icona",
          type: "entity",
          domains: ["sensor", "binary_sensor", "switch", "valve", "number"],
          helper: "Il suo valore compare sotto l'icona. Facoltativa",
        },
      ],
      {
        name: area.name || "",
        zone_id: area.zone_id || "",
        color: area.color || null,
        icon: area.icon || undefined,
        icon_color: area.icon_color || null,
        show_icon: area.show_icon !== false,
        show_label: area.show_label !== false,
        icon_entity: area.icon_entity || undefined,
      },
      async (values) => {
        await this._mutate("POST", `areas/${areaId}`, {
          ...values,
          zone_id: values.zone_id || null,
          icon: values.icon || null,
          icon_entity: values.icon_entity || null,
        });
        this._repaintMap();
      }
    );
  }

  _confirmDeleteArea(areaId) {
    const area = this._areaById(areaId);
    if (!area) return;

    const dlg = this._makeDialog("Eliminare l'area?");
    const body = document.createElement("p");
    body.className = "muted small";
    body.textContent = `"${this._areaName(area)}" verrà rimossa dalla mappa. La linea collegata resta.`;
    dlg.appendChild(body);

    const close = () => dlg.remove();
    dlg.appendChild(
      this._actionBar("Elimina", async () => {
        close();
        if (this._selArea === areaId) this._selArea = null;
        await this._mutate("DELETE", `areas/${areaId}`);
      }, close, true)
    );

    this.shadowRoot.appendChild(dlg);
    this._layoutFallback(dlg);
  }

  _meteoTab() {
    return `${this._et0Card()}
      ${this._forecastCard()}
      ${this._weatherCharts()}
      ${this._sensorsCard(this._overview.system)}
      ${this._locationCard(this._overview.system)}`;
  }

  /* Temperatura e umidità: due grandezze con scale diverse, quindi due
     grafici distinti. Sovrapporle su un solo riquadro con due assi
     inventerebbe una correlazione che nei dati non c'è. */
  _weatherCharts() {
    if (this._history === undefined) {
      this._fetchHistory();
      return "";
    }
    const dati = this._history.slice(-30);
    if (dati.length < 2) {
      return `<ha-card><div class="inner">
        <div class="card-head"><ha-icon icon="mdi:chart-line"></ha-icon><h2>Andamento</h2></div>
        <div class="empty-state">
          <ha-icon icon="mdi:chart-line"></ha-icon>
          <p>Servono almeno due giornate concluse.</p>
          <p class="muted small">Ogni notte il sistema archivia il riepilogo del giorno: i grafici si popolano da soli.</p>
        </div>
      </div></ha-card>`;
    }

    const c = chartPalette();
    const conUmidita = dati.some((e) => e.rh_mean != null);

    return `
      ${this._chartCard(
        "Temperatura",
        "mdi:thermometer",
        `Minima e massima degli ultimi ${dati.length} giorni · °C`,
        this._bandChart(dati, c[0]) +
          this._historyTable(dati, [
            { label: "Min °C", get: (e) => e.t_min },
            { label: "Max °C", get: (e) => e.t_max },
          ]),
        "temp"
      )}
      ${
        conUmidita
          ? this._chartCard(
              "Umidità",
              "mdi:water-percent",
              "Media giornaliera · %",
              this._areaChart(dati, "rh_mean", c[2], { min0: true }) +
                this._historyTable(dati, [{ label: "Umidità %", get: (e) => e.rh_mean }]),
              "umid"
            )
          : ""
      }
      ${this._chartCard(
        "Evapotraspirazione",
        "mdi:weather-sunny",
        "Quanta acqua ha perso il terreno, giorno per giorno · mm",
        this._areaChart(dati, "et0_mm", c[1], { min0: true }) +
          this._historyTable(dati, [
            { label: "ET0 mm", get: (e) => e.et0_mm },
            { label: "Pioggia mm", get: (e) => e.rain_mm },
          ]),
        "et0"
      )}`;
  }

  /* Minuti irrigati per gruppo: qui i gruppi SONO il soggetto, quindi
     tinte distinte, legenda ed etichette — mai il colore da solo. */
  _irrigationChart() {
    if (this._history === undefined) {
      this._fetchHistory();
      return "";
    }
    const dati = this._history.slice(-30);
    const options = this._overview.options || {};
    const etichette = options.category_labels || {};

    const presenti = (options.categories || ["prato", "aiuole", "orto"]).filter((cat) =>
      dati.some((e) => Number((e.irrigated || {})[cat] || 0) > 0)
    );

    if (!dati.length || !presenti.length) {
      return `<ha-card><div class="inner">
        <div class="card-head"><ha-icon icon="mdi:chart-bar"></ha-icon><h2>Irrigazione nel tempo</h2></div>
        <div class="empty-state">
          <ha-icon icon="mdi:water-off"></ha-icon>
          <p>Nessuna irrigazione ancora registrata.</p>
          <p class="muted small">Il grafico si popola dopo la prima notte di irrigazione.</p>
        </div>
      </div></ha-card>`;
    }

    const c = chartPalette().slice(0, presenti.length);
    const nomi = presenti.map((cat) => etichette[cat] || cat);

    return this._chartCard(
      "Irrigazione nel tempo",
      "mdi:chart-bar",
      `Minuti erogati per gruppo, ultimi ${dati.length} giorni · min`,
      this._legend(nomi, c) +
        this._stackedBars(dati, presenti, c, nomi) +
        this._historyTable(
          dati,
          presenti.map((cat, i) => ({
            label: `${nomi[i]} min`,
            get: (e) => (e.irrigated || {})[cat] || 0,
          }))
        ),
      "irrig"
    );
  }

  /* Pioggia prevista: è la lettura che fa saltare l'irrigazione quando
     sta per piovere, quindi va mostrata insieme alla soglia. */
  _forecastCard() {
    const f = (this._overview.meteo || {}).forecast || {};
    const sys = this._overview.system || {};
    const soglia = Number(sys.rain_forecast_max_mm ?? 8);

    if (!f.available) {
      return `<ha-card><div class="inner">
        <div class="card-head">
          <ha-icon icon="mdi:weather-pouring"></ha-icon>
          <h2>Pioggia prevista</h2>
        </div>
        <p class="muted small nomargin">
          ${
            sys.weather_entity
              ? "Il servizio meteo configurato non fornisce previsioni giornaliere."
              : "Nessun servizio meteo configurato: senza previsioni, l'irrigazione non può essere sospesa in vista della pioggia."
          }
        </p>
      </div></ha-card>`;
    }

    const rain = Number(f.rain_mm || 0);
    const blocca = rain > soglia;

    return `<ha-card><div class="inner">
      <div class="card-head">
        <ha-icon icon="mdi:weather-pouring"></ha-icon>
        <h2>Pioggia prevista</h2>
        <span class="spacer"></span>
        <span class="badge ${blocca ? "warn" : "ok"}">
          ${blocca ? "irrigazione sospesa" : "sotto soglia"}
        </span>
      </div>
      <div class="et0">
        <div class="et0-value"><b>${rain.toFixed(1)}</b> <span>mm</span></div>
        <div class="et0-meta">
          <span class="row-label">previsti oggi${
            f.probability != null ? ` · ${Math.round(f.probability)}% di probabilità` : ""
          }</span>
          <span class="sub">oltre ${soglia} mm l'irrigazione viene saltata</span>
        </div>
      </div>
    </div></ha-card>`;
  }

  _et0Card() {
    const m = this._overview.meteo || {};
    const num = (v, unit, dec = 1) =>
      v == null ? "—" : `${Number(v).toFixed(dec)}${unit ? " " + unit : ""}`;
    const et0 = m.last_et0_mm;
    const rawMethod = m.et0_today_method || m.last_et0_method;
    const method = ET0_METHOD_LABELS[rawMethod] || rawMethod || "";
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
        <div class="et0">
          <div class="et0-value"><b>${Number(m.et0_today_mm || 0).toFixed(2)}</b> <span>mm</span></div>
          <div class="et0-meta">
            <span class="row-label">ET0 maturata oggi</span>
            <span class="sub">
              cresce dall'alba al tramonto e si scarica sui deficit a ogni
              aggiornamento${
                et0 == null
                  ? ""
                  : ` · ${esc(m.last_closed_date || "giorno precedente")}: ${Number(et0).toFixed(2)} mm`
              }
            </span>
          </div>
        </div>
        ${
          et0 == null
            ? `<ha-alert alert-type="info">
                 Nessun giorno ancora chiuso: il totale definitivo, coi dati
                 completi di temperatura, si calcola dopo la mezzanotte.
               </ha-alert>`
            : ""
        }
        <div class="form-section">Accumulo di oggi</div>
        <div class="c-grid">
          <div class="cell"><span class="k">T min</span><span class="v">${num(m.t_min, "°C")}</span></div>
          <div class="cell"><span class="k">T max</span><span class="v">${num(m.t_max, "°C")}</span></div>
          <div class="cell"><span class="k">Pioggia</span><span class="v">${num(m.rain_mm, "mm")}</span></div>
          <div class="cell"><span class="k">Umidità media</span><span class="v">${num(m.rh_mean, "%", 0)}</span></div>
          <div class="cell"><span class="k">Vento medio</span><span class="v">${num(m.wind_mean_kmh, "km/h")}</span></div>
          <div class="cell"><span class="k">Metodo</span><span class="v">${esc(method || "—")}</span></div>
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
        <div class="card-head">
          <ha-icon icon="mdi:gauge"></ha-icon>
          <h2>Sorgenti dati</h2>
          <span class="spacer"></span>
          ${this._button("edit-sources", "Modifica")}
        </div>
        ${rows}
        <div class="row">
          <ha-icon icon="mdi:weather-partly-cloudy"></ha-icon>
          <div class="row-main">
            <span class="row-label">Meteo di fallback</span>
            <span class="sub">usato dove manca il sensore locale, e per le previsioni</span>
          </div>
          ${hasWeather ? `<span class="reading small">${esc(sys.weather_entity)}</span>` : `<span class="badge muted">nessuno</span>`}
        </div>
      </div></ha-card>`;
  }

  _openSourcesDialog() {
    const sys = this._overview.system || {};
    const sensors = sys.sensors || {};

    const specs = [
      {
        key: "weather_entity", label: "Servizio meteo", type: "entity",
        domains: ["weather"],
        helper: "Usato dove manca il sensore locale, e per la pioggia prevista",
      },
      { type: "section", label: "Sensori locali (hanno la precedenza)" },
      {
        key: "temperature_entity", label: "Temperatura", type: "entity",
        domains: ["sensor"],
      },
      {
        key: "humidity_entity", label: "Umidità", type: "entity",
        domains: ["sensor"],
        helper: "Con umidità e vento si usa Penman-Monteith invece di Hargreaves",
      },
      { key: "wind_entity", label: "Vento", type: "entity", domains: ["sensor"] },
      {
        key: "rain_entity", label: "Pioggia caduta", type: "entity",
        domains: ["sensor"], helper: "Pluviometro: millimetri cumulati nella giornata",
      },
      {
        key: "irradiance_entity", label: "Irraggiamento", type: "entity",
        domains: ["sensor"],
        helper: "Piranometro in W/m². Senza, viene stimato dall'escursione termica",
      },
    ];

    this._showForm(
      "Sorgenti dati",
      specs,
      {
        weather_entity: sys.weather_entity || undefined,
        temperature_entity: sensors.temperature || undefined,
        humidity_entity: sensors.humidity || undefined,
        wind_entity: sensors.wind_speed || undefined,
        rain_entity: sensors.precipitation || undefined,
        irradiance_entity: sensors.irradiance || undefined,
      },
      async (values) => {
        try {
          await this._api("POST", "sources", values);
          // il cambio ricarica l'integration: si rilegge tutto da capo
          setTimeout(() => this._fetchOverview(), 1500);
        } catch (err) {
          this._error = (err && err.message) || String(err);
          this._render();
        }
      }
    );
  }

  _locationCard(sys) {
    return `<ha-card><div class="inner">
        <div class="card-head"><ha-icon icon="mdi:map-marker-outline"></ha-icon><h2>Posizione</h2></div>
        <p class="muted small nomargin">Serve al calcolo della radiazione extraterrestre, che dipende da latitudine e giorno dell'anno.</p>
        <div class="c-grid">
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

  /* Colore, con la possibilità di non sceglierne uno.

     `input type=color` non sa dire "nessun colore", ma qui serve: senza
     scelta l'area prende la tinta del suo stato, che è quasi sempre la
     cosa giusta. La casella "automatico" è quel valore mancante. */
  _colorField(spec, values) {
    const row = document.createElement("div");
    row.className = "ha-field";

    const lab = document.createElement("label");
    lab.className = "ha-field-label";
    lab.textContent = spec.label;

    const box = document.createElement("div");
    box.className = "ha-field-box color-box";

    const input = document.createElement("input");
    input.type = "color";
    input.className = "color-input";
    input.value = values[spec.key] || spec.fallback || "#03a9f4";

    const auto = document.createElement("label");
    auto.className = "color-auto";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = !values[spec.key];
    auto.append(check, document.createTextNode("automatico"));

    const sync = () => {
      values[spec.key] = check.checked ? null : input.value;
      input.disabled = check.checked;
    };
    input.addEventListener("input", () => {
      check.checked = false;
      sync();
    });
    check.addEventListener("change", sync);
    sync();

    box.append(input, auto);
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
    if (spec.type === "color") return this._colorField(spec, values);
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
      rate_mode: "mm_h", flow_value: undefined, area_m2: undefined,
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
      { type: "section", label: "Portata" },
      {
        key: "rate_mode", label: "Unità di misura", type: "select",
        options: ["mm_h", "l_h", "l_min"],
        labels: {
          mm_h: "Millimetri all'ora (mm/h)",
          l_h: "Litri all'ora (L/h)",
          l_min: "Litri al minuto (L/min)",
        },
        helper: "In litri serve anche la superficie: la stessa portata bagna molto o poco secondo l'area",
      },
      {
        key: "rate_mm_h", label: "Portata in mm/h", type: "number", suffix: "mm/h",
        helper: "Misurata col tuna can test. Usata se l'unità sopra è mm/h",
      },
      {
        key: "flow_value", label: "Portata in litri", type: "number", suffix: "L",
        helper: "Il valore di targa dell'impianto, all'ora o al minuto",
      },
      {
        key: "area_m2", label: "Superficie della zona", type: "number", suffix: "m²",
        helper:
          "Obbligatoria se la portata è in litri: senza, i litri vengono " +
          "ignorati. È l'area che questa linea bagna davvero, e la portata " +
          "è la somma di tutti gli irrigatori della linea",
      },
      { type: "section", label: "Taratura" },
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
      rate_mode: z.rate_mode || "mm_h",
      flow_value: z.flow_value ?? undefined,
      area_m2: z.area_m2 ?? undefined,
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
      .app-version { font-size: 12px; font-weight: 400; opacity: .7;
                     padding: 2px 8px; border-radius: 10px;
                     background: rgba(255,255,255,.15); }

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
      .sched-group + .sched-group { margin-top: 10px; }
      .sched-run { padding-left: 12px; }

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

      /* -------------------------------------------------------------- mappa

         Il riquadro segue esattamente l'immagine: l'immagine occupa tutta
         la larghezza e detta l'altezza, SVG e maniglie si sovrappongono al
         100%. Così le coordinate normalizzate combaciano senza calcoli, e
         il disegno viene deformato esattamente come l'immagine. */
      /* La planimetria è il contenuto: prende tutta la larghezza che
         c'è, e le card le stanno a fianco. Sotto i 1000px la colonna
         scende sotto la mappa invece di stringerla a un francobollo. */
      .content.wide { max-width: 1800px; }
      .map-grid { display: grid; gap: 16px; align-items: start;
                  grid-template-columns: minmax(0, 1fr) minmax(300px, 380px); }
      @media (max-width: 1000px) {
        .map-grid { grid-template-columns: minmax(0, 1fr); }
      }
      .map-side { min-width: 0; }
      .map-side > * { margin-bottom: 16px; display: block; }
      .card-json { width: 100%; min-height: 240px; font-family: ui-monospace,
                   SFMono-Regular, Menlo, monospace; font-size: 13px; resize: vertical; }

      /* sequenza delle passate: righe fitte, si scorre con l'occhio */
      .cycle-list { margin: 10px 0 4px; }
      .cycle-list summary { cursor: pointer; font-size: 13px;
                            color: var(--secondary-text-color); padding: 4px 0; }
      .cycle-grid { display: grid; gap: 2px 12px; margin-top: 8px;
                    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); }
      .cycle-step { display: flex; align-items: baseline; gap: 8px; font-size: 13px;
                    padding: 3px 8px; border-radius: 6px;
                    background: var(--secondary-background-color); }
      .cycle-time { font-variant-numeric: tabular-nums; font-weight: 600; }
      .cycle-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis;
                    white-space: nowrap; }
      .cycle-num { font-variant-numeric: tabular-nums; }

      .map-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
                     margin-bottom: 12px; }
      .map-card { overflow: hidden; }
      .map-wrap { position: relative; line-height: 0; touch-action: pan-y;
                  user-select: none; -webkit-user-select: none; }
      .map-wrap.editing { touch-action: none; cursor: crosshair; }
      .map-img { display: block; width: 100%; height: auto; }
      .map-svg, .map-layer { position: absolute; inset: 0; width: 100%; height: 100%; }
      .map-svg { overflow: visible; }
      /* le maniglie sono elementi veri: il livello lascia passare i clic */
      .map-layer { pointer-events: none; }
      .map-layer > * { pointer-events: auto; }

      /* Il riempimento dice il bilancio idrico, il bordo dice quale area
         è: a posto si vede solo il contorno, perché una planimetria tutta
         colorata non la si legge più. */
      .area { fill: var(--area-fill, transparent);
              fill-opacity: var(--area-op, var(--fill-op, .35));
              stroke: var(--area-stroke, var(--primary-color));
              stroke-width: 2; stroke-linejoin: round;
              vector-effect: non-scaling-stroke; cursor: pointer;
              transition: fill-opacity .3s ease; }
      .area.s-ok { --area-fill: var(--success-color, #43a047); --area-op: 0;
                   --area-stroke: var(--success-color, #43a047); }
      .area.s-thirsty { --area-fill: var(--warning-color, #ffa600);
                        --area-stroke: var(--warning-color, #ffa600); }
      .area.s-critical { --area-fill: var(--error-color, #db4437);
                         --area-stroke: var(--error-color, #db4437); }
      .area.s-watering { --area-fill: var(--info-color, var(--primary-color));
                         --area-stroke: var(--info-color, var(--primary-color));
                         animation: area-breathe 2.4s ease-in-out infinite; }
      .area.s-off, .area.s-none { --area-fill: var(--disabled-text-color, #9e9e9e);
                                  --area-op: .12;
                                  --area-stroke: var(--disabled-text-color, #9e9e9e); }
      .area.selected { stroke-width: 3; stroke-dasharray: 6 3; }
      .draft { fill: none; stroke: var(--primary-color); stroke-width: 2;
               stroke-dasharray: 5 4; vector-effect: non-scaling-stroke; }

      /* l'azzurro respira: è l'unico stato che sta cambiando mentre lo
         guardi, e deve distinguersi da un'area semplicemente fredda */
      @keyframes area-breathe {
        0%, 100% { fill-opacity: calc(var(--fill-op, .35) * .45); }
        50% { fill-opacity: calc(var(--fill-op, .35) * 1.35); }
      }

      .map-icon { position: absolute; transform: translate(-50%, -50%);
                  display: flex; flex-direction: column; align-items: center; gap: 2px;
                  background: none; border: 0; padding: 4px; cursor: pointer;
                  font-family: inherit; color: var(--icon-color, #fff);
                  text-shadow: 0 1px 3px rgba(0,0,0,.65); }
      .map-icon ha-icon { --mdc-icon-size: 30px;
                          filter: drop-shadow(0 1px 3px rgba(0,0,0,.6)); }
      .map-icon.s-thirsty { --icon-color: var(--warning-color, #ffa600); }
      .map-icon.s-critical { --icon-color: var(--error-color, #db4437); }
      .map-icon.s-watering { --icon-color: var(--info-color, var(--primary-color)); }
      .map-icon.s-off { --icon-color: var(--disabled-text-color, #bdbdbd); }
      .map-name { font-size: 12px; font-weight: 600; white-space: nowrap; }
      .map-read { font-size: 11px; opacity: .9; white-space: nowrap; }

      .map-vertex { position: absolute; width: 16px; height: 16px; margin: -8px 0 0 -8px;
                    border-radius: 50%; background: var(--card-background-color);
                    border: 2px solid var(--primary-color); cursor: grab;
                    box-shadow: 0 1px 4px rgba(0,0,0,.4); touch-action: none; }
      .map-vertex.on { background: var(--primary-color); }
      .map-vertex.draft { border-style: dashed; }
      .map-mid { position: absolute; width: 10px; height: 10px; margin: -5px 0 0 -5px;
                 border-radius: 50%; background: var(--primary-color); opacity: .55;
                 cursor: copy; touch-action: none; }
      .map-mid:hover { opacity: 1; }

      .area-row { cursor: pointer; border-radius: 8px; }
      .area-row.selected { background: color-mix(in srgb, var(--primary-color) 12%, transparent); }
      .map-legend { display: flex; gap: 16px; flex-wrap: wrap; }
      .swatch { width: 14px; height: 14px; border-radius: 4px; display: inline-block;
                border: 2px solid currentColor; }
      .swatch.s-ok { color: var(--success-color, #43a047); background: transparent; }
      .swatch.s-thirsty { color: var(--warning-color, #ffa600);
                          background: color-mix(in srgb, var(--warning-color, #ffa600) 35%, transparent); }
      .swatch.s-critical { color: var(--error-color, #db4437);
                           background: color-mix(in srgb, var(--error-color, #db4437) 35%, transparent); }
      .swatch.s-watering { color: var(--info-color, var(--primary-color));
                           background: color-mix(in srgb, var(--info-color, var(--primary-color)) 35%, transparent); }

      .badge.st-ok { background: color-mix(in srgb, var(--success-color, #43a047) 18%, transparent); color: var(--success-color, #43a047); }
      .badge.st-thirsty { background: color-mix(in srgb, var(--warning-color, #ffa600) 22%, transparent); color: var(--warning-color, #ffa600); }
      .badge.st-critical { background: color-mix(in srgb, var(--error-color, #db4437) 18%, transparent); color: var(--error-color, #db4437); }
      .badge.st-watering { background: color-mix(in srgb, var(--info-color, var(--primary-color)) 18%, transparent); color: var(--info-color, var(--primary-color)); }
      .badge.st-off, .badge.st-none { background: var(--divider-color); color: var(--secondary-text-color); }

      .color-box { display: flex; align-items: center; gap: 12px; }
      .color-input { width: 52px; height: 36px; padding: 0; border-radius: 8px;
                     border: 1px solid var(--divider-color); background: none;
                     cursor: pointer; }
      .color-input:disabled { opacity: .4; cursor: default; }
      .color-auto { display: inline-flex; align-items: center; gap: 6px;
                    font-size: 13px; color: var(--secondary-text-color); cursor: pointer; }

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

      /* Grafici: marchi sottili, griglia a filo e non tratteggiata,
         assi discreti. Il colore lo portano solo i dati. */
      .chart { display: block; width: 100%; height: 170px; margin-top: 10px; overflow: visible; }
      .chart .c-grid { stroke: var(--divider-color); stroke-width: 1; }
      .chart .c-tick { fill: var(--secondary-text-color); font-size: 10px;
                     font-family: inherit; font-variant-numeric: tabular-nums; }
      .chart .c-line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
      .chart .c-line.c-thin { stroke-width: 1.5; opacity: .75; }
      .chart .c-band { opacity: .16; }
      .chart .c-endlabel { fill: var(--primary-text-color); font-size: 11px;
                         font-weight: 600; font-family: inherit; }
      

      .legend { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 10px; }
      .legend-item { display: inline-flex; align-items: center; gap: 6px;
                     font-size: 12px; color: var(--secondary-text-color); }
      .swatch { width: 10px; height: 10px; border-radius: 3px; flex: 0 0 auto; }

      /* Vista tabellare: l'equivalente leggibile di ogni grafico */
      .data-table { display: none; width: 100%; border-collapse: collapse;
                    margin-top: 12px; font-size: 13px; }
      .data-table.shown { display: table; }
      .data-table th, .data-table td { text-align: left; padding: 6px 8px;
                    border-bottom: 1px solid var(--divider-color);
                    font-variant-numeric: tabular-nums; }
      .data-table th { font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
                    color: var(--secondary-text-color); font-weight: 600; }
      .data-table td { color: var(--primary-text-color); }

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

