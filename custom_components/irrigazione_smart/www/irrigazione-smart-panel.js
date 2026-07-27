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

const TABS = [
  { id: "dashboard", label: "Dashboard", icon: "mdi:view-dashboard-outline" },
  { id: "zone", label: "Zone", icon: "mdi:sprinkler-variant" },
  { id: "meteo", label: "Meteo", icon: "mdi:weather-partly-cloudy" },
];

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
    // un'altra dashboard. La pagina si riallinea da sola.
    this._timer = setInterval(() => this._refreshSilent(), 30000);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
  }

  async _refreshSilent() {
    // non ricaricare mentre l'utente sta compilando un dialogo
    if (!this._hass || this.shadowRoot.querySelector("ha-dialog")) return;
    try {
      const fresh = await this._api("GET", "overview");
      if (JSON.stringify(fresh) !== JSON.stringify(this._overview)) {
        this._overview = fresh;
        this._render();
      }
    } catch (_e) {
      /* un errore di rete transitorio non deve svuotare la pagina */
    }
  }

  /* Fa caricare al frontend il chunk con i componenti dei form, così
     ha-dialog / ha-textfield / ha-select sono definiti quando servono. */
  async _warmUpComponents() {
    try {
      if (window.loadCardHelpers) await window.loadCardHelpers();
    } catch (_e) {
      /* non bloccante: i componenti si aggiornano da soli se arrivano dopo */
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
          ${TABS.map(
            (t) => `<button class="tab${t.id === this._tab ? " active" : ""}" data-tab="${t.id}">
                      <ha-icon icon="${t.icon}"></ha-icon><span>${t.label}</span>
                    </button>`
          ).join("")}
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

    // master generale
    const master = sr.querySelector("[data-master]");
    if (master) {
      master.addEventListener("change", (e) =>
        this._mutate("POST", "system", { master_enabled: !!e.target.checked })
      );
    }
    // master di ogni linea
    sr.querySelectorAll("[data-zone-toggle]").forEach((el) => {
      el.addEventListener("change", (e) =>
        this._mutate("POST", `zones/${el.getAttribute("data-zone-toggle")}`, {
          enabled: !!e.target.checked,
        })
      );
    });
  }

  _body() {
    if (this._loading && !this._overview) {
      return `<div class="empty">Caricamento…</div>`;
    }
    if (this._error && !this._overview) {
      return `<ha-alert alert-type="error" title="Errore">${esc(this._error)}</ha-alert>
              <mwc-button class="retry" raised label="Riprova"></mwc-button>`;
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

    if (this._tab === "zone") return err + this._zoneTab();
    if (this._tab === "meteo") return err + this._meteoTab();
    return err + this._dashboardTab();
  }

  // --------------------------------------------------------- DASHBOARD

  _dashboardTab() {
    const sys = this._overview.system;
    const zones = this._overview.zones || [];
    const sched = this._overview.schedule || {};
    const running = zones.filter((z) => (z.computed || {}).plan?.should_run);

    return `
      ${this._masterCard(sys, zones, running, sched)}
      ${this._linesCard(zones)}
      ${this._sequenceCard(sched, sys)}
    `;
  }

  _masterCard(sys, zones, running, sched) {
    const on = !!sys.master_enabled;
    const w = sys.window || {};
    const enabled = zones.filter((z) => z.enabled).length;

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
      </div></ha-card>`;
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

    const rows = zones.map((z) => {
      const c = z.computed || {};
      const plan = c.plan || {};
      let state;
      if (plan.should_run) {
        state = `<span class="badge run">${plan.total_minutes} min</span>`;
      } else if (isBlocked(plan.reason)) {
        state = `<span class="badge warn">${esc(reasonLabel(plan.reason))}</span>`;
      } else {
        state = `<span class="badge ok">${esc(reasonLabel(plan.reason) || "ok")}</span>`;
      }
      const deficit = Number(z.deficit_mm || 0);
      const thr = Number(c.trigger_threshold_mm || 0);
      return `<div class="row line${z.enabled ? "" : " dim"}">
        <ha-icon icon="mdi:pipe-valve"></ha-icon>
        <div class="row-main">
          <span class="row-label">${esc(z.name)}</span>
          <span class="sub">${deficit.toFixed(1)} / ${thr.toFixed(1)} mm</span>
        </div>
        ${state}
        <ha-switch data-zone-toggle="${z.id}" ${z.enabled ? "checked" : ""}></ha-switch>
      </div>`;
    }).join("");

    return `<ha-card><div class="inner">
      <div class="card-head">
        <ha-icon icon="mdi:pipe"></ha-icon><h2>Master di linea</h2>
      </div>
      <p class="muted small nomargin">Ogni interruttore abilita o esclude la singola linea.</p>
      ${rows}
    </div></ha-card>`;
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
           <ha-icon icon="mdi:sleep"></ha-icon>
           <p>Nessuna irrigazione prevista.</p>
           <p class="muted small">Tutte le linee sono sotto soglia o bloccate.</p>
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
        <h2>Sequenza della notte</h2>
        <span class="spacer"></span>
        <span class="sub">${esc((sys.window || {}).label || "")}</span>
      </div>
      ${body}
      ${capacity}
    </div></ha-card>`;
  }

  // -------------------------------------------------------------- ZONE

  _zoneTab() {
    const zones = this._overview.zones || [];
    const body = zones.length
      ? zones.map((z) => this._zoneRow(z)).join("")
      : `<div class="empty-state">
           <ha-icon icon="mdi:sprinkler-variant"></ha-icon>
           <p>Nessuna zona configurata.</p>
           <p class="muted small">Aggiungi la prima zona per iniziare a calcolare il bilancio idrico.</p>
         </div>`;

    return `<ha-card><div class="inner">
        <div class="card-head">
          <ha-icon icon="mdi:sprinkler"></ha-icon>
          <h2>Zone e linee</h2>
          <span class="spacer"></span>
          <mwc-button class="add-zone" label="Aggiungi zona"></mwc-button>
        </div>
        ${body}
      </div></ha-card>
      ${this._systemCard(this._overview.system)}`;
  }

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

    return `<div class="zone${z.enabled ? "" : " dim"}">
      <div class="zone-head">
        <ha-switch data-zone-toggle="${z.id}" ${z.enabled ? "checked" : ""}></ha-switch>
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
    const w = sys.window || {};
    const qIcon = {
      ottimale: "mdi:check-circle",
      accettabile: "mdi:alert-circle-outline",
      sconsigliata: "mdi:close-circle",
    }[w.quality] || "mdi:clock-outline";

    return `<ha-card><div class="inner">
        <div class="card-head">
          <ha-icon icon="mdi:cog-outline"></ha-icon>
          <h2>Impostazioni sistema</h2>
          <span class="spacer"></span>
          <mwc-button class="edit-system" label="Modifica"></mwc-button>
        </div>
        <div class="row">
          <ha-icon icon="${qIcon}"></ha-icon>
          <div class="row-main">
            <span class="row-label">Finestra ${esc(w.label || "")}</span>
            <span class="sub">${esc(w.quality_reason || "")}</span>
          </div>
          <span class="badge q-${esc(w.quality)}">${esc(w.quality || "")}</span>
        </div>
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

  _field(field, labelText, value, opts = {}) {
    const { type = "text", suffix = "", helper = "" } = opts;
    return `<ha-textfield
      data-field="${field}" label="${labelText}" type="${type}"
      ${type === "number" ? 'step="any"' : ""}
      value="${value == null ? "" : esc(value)}"
      ${suffix ? `suffix="${suffix}"` : ""}
      ${helper ? `helper="${esc(helper)}" helperPersistent` : ""}
    ></ha-textfield>`;
  }

  _select(field, labelText, options, current, labels) {
    const items = options
      .map(
        (o) =>
          `<mwc-list-item value="${esc(o)}"${o === current ? " selected" : ""}>${esc(labels ? label(labels, o) : o)}</mwc-list-item>`
      )
      .join("");
    return `<ha-select data-field="${field}" label="${labelText}" fixedMenuPosition naturalMenuWidth>${items}</ha-select>`;
  }

  _openZoneDialog(zoneId) {
    const opts = this._overview.options || {};
    const zone =
      (zoneId && (this._overview.zones || []).find((z) => z.id === zoneId)) || null;
    const z = zone || {
      name: "", valve_entity: "", enabled: true, zone_type: "prato_microterme",
      rate_mm_h: 10, emitter: "statici", corrector: 1.0, soil: INHERIT_STR,
      kc: INHERIT_NUM, root_depth_cm: INHERIT_NUM, mad: INHERIT_NUM,
      max_runtime_min: INHERIT_NUM, deficit_mm: 0,
    };
    const inh = (v) => (v == null || Number(v) === INHERIT_NUM ? "" : v);

    const content = `
      <div class="form">
        ${this._field("name", "Nome zona", z.name)}
        ${this._field("valve_entity", "Entità valvola", z.valve_entity, {
          helper: "entity_id dello switch/valve che apre la linea",
        })}
        ${this._select("zone_type", "Tipo di zona", opts.zone_types || [], z.zone_type, ZONE_TYPE_LABELS)}
        ${this._select("emitter", "Erogazione", opts.emitters || [], z.emitter, EMITTER_LABELS)}
        ${this._field("rate_mm_h", "Portata", z.rate_mm_h, {
          type: "number", suffix: "mm/h",
          helper: "Misurata col tuna can test: senza questo dato le durate sono arbitrarie",
        })}
        ${this._field("corrector", "Correttore", z.corrector, {
          type: "number", helper: "1.0 = nessuna correzione. Si tara osservando il prato",
        })}

        <div class="form-section">Override (vuoto = eredita)</div>
        ${this._select("soil", "Terreno", [INHERIT_STR, ...(opts.soils || [])], z.soil, { ...SOIL_LABELS, eredita: "Eredita dal sistema" })}
        ${this._field("kc", "Coefficiente colturale Kc", inh(z.kc), { type: "number" })}
        ${this._field("root_depth_cm", "Profondità radici", inh(z.root_depth_cm), { type: "number", suffix: "cm" })}
        ${this._field("mad", "MAD", inh(z.mad), { type: "number", helper: "Frazione consumabile prima di irrigare (0–1)" })}
        ${this._field("max_runtime_min", "Durata massima", inh(z.max_runtime_min), { type: "number", suffix: "min" })}

        <div class="form-section">Stato</div>
        ${this._field("deficit_mm", "Deficit attuale", z.deficit_mm, {
          type: "number", suffix: "mm", helper: "Azzeralo dopo un'irrigazione manuale",
        })}
        <ha-formfield label="Linea abilitata">
          <ha-switch data-field="enabled"${z.enabled ? " checked" : ""}></ha-switch>
        </ha-formfield>
      </div>`;

    this._showDialog(zone ? "Modifica zona" : "Nuova zona", content, async (dlg) => {
      const data = this._collect(dlg, {
        numbers: ["rate_mm_h", "corrector", "kc", "root_depth_cm", "mad", "max_runtime_min", "deficit_mm"],
        inheritNumbers: ["kc", "root_depth_cm", "mad", "max_runtime_min"],
        booleans: ["enabled"],
      });
      if (!data.name) data.name = "Nuova zona";
      if (zone) await this._mutate("POST", `zones/${zone.id}`, data);
      else await this._mutate("POST", "zones", data);
    });
  }

  _openSystemDialog() {
    const sys = this._overview.system;
    const opts = this._overview.options || {};
    const content = `
      <div class="form">
        ${this._field("window_start", "Inizio finestra", sys.window_start, { type: "time" })}
        ${this._field("window_end", "Fine finestra", sys.window_end, { type: "time" })}
        ${this._select("soil", "Terreno predefinito", opts.soils || [], sys.soil, SOIL_LABELS)}
        ${this._field("soak_minutes", "Pausa di assorbimento", sys.soak_minutes, { type: "number", suffix: "min" })}
        ${this._field("gap_minutes", "Pausa tra linee", sys.gap_minutes, { type: "number", suffix: "min" })}
        ${this._field("wind_max_kmh", "Vento massimo", sys.wind_max_kmh, { type: "number", suffix: "km/h" })}
        ${this._field("rain_forecast_max_mm", "Pioggia prevista massima", sys.rain_forecast_max_mm, { type: "number", suffix: "mm" })}
        ${this._select("overflow_policy", "Se la finestra non basta", ["truncate", "overflow"], sys.overflow_policy, { truncate: "Escludi le linee eccedenti", overflow: "Sfora la finestra" })}
      </div>`;

    this._showDialog("Impostazioni sistema", content, async (dlg) => {
      const data = this._collect(dlg, {
        numbers: ["soak_minutes", "gap_minutes", "wind_max_kmh", "rain_forecast_max_mm"],
        booleans: [],
      });
      await this._mutate("POST", "system", data);
    });
  }

  _collect(dlg, spec) {
    const out = {};
    dlg.querySelectorAll("[data-field]").forEach((el) => {
      const key = el.getAttribute("data-field");
      if ((spec.booleans || []).includes(key)) {
        out[key] = !!el.checked;
        return;
      }
      const v = el.value;
      if ((spec.numbers || []).includes(key)) {
        if (v === "" || v == null) {
          // vuoto = eredita per i campi ereditabili, altrimenti si omette
          if ((spec.inheritNumbers || []).includes(key)) out[key] = INHERIT_NUM;
          return;
        }
        const n = Number(v);
        if (!Number.isNaN(n)) out[key] = n;
        return;
      }
      out[key] = v;
    });
    return out;
  }

  _showDialog(heading, contentHtml, onSave) {
    const dlg = document.createElement("ha-dialog");
    dlg.heading = heading;
    dlg.setAttribute("open", "");
    dlg.innerHTML = `
      ${contentHtml}
      <mwc-button slot="secondaryAction" dialogAction="cancel" label="Annulla"></mwc-button>
      <mwc-button slot="primaryAction" class="save" label="Salva"></mwc-button>
    `;
    const close = () => dlg.parentNode && dlg.parentNode.removeChild(dlg);
    dlg.addEventListener("closed", close);
    dlg.querySelector(".save").addEventListener("click", async () => {
      await onSave(dlg);
      close();
    });
    this.shadowRoot.appendChild(dlg);
    // I valori delle ha-select vanno impostati dopo l'upgrade del componente.
    requestAnimationFrame(() => {
      dlg.querySelectorAll("ha-select").forEach((sel) => {
        const sl = sel.querySelector("mwc-list-item[selected]");
        if (sl) sel.value = sl.getAttribute("value");
      });
    });
  }

  _confirmDelete(zoneId) {
    const zone = (this._overview.zones || []).find((z) => z.id === zoneId);
    if (!zone) return;
    const dlg = document.createElement("ha-dialog");
    dlg.heading = "Eliminare la zona?";
    dlg.setAttribute("open", "");
    dlg.innerHTML = `
      <p>La zona <b>${esc(zone.name)}</b> verrà rimossa insieme alla sua storia idrica (deficit ${Number(zone.deficit_mm || 0).toFixed(1)} mm). L'operazione non è reversibile.</p>
      <mwc-button slot="secondaryAction" dialogAction="cancel" label="Annulla"></mwc-button>
      <mwc-button slot="primaryAction" class="confirm danger" label="Elimina"></mwc-button>
    `;
    const close = () => dlg.parentNode && dlg.parentNode.removeChild(dlg);
    dlg.addEventListener("closed", close);
    dlg.querySelector(".confirm").addEventListener("click", async () => {
      await this._mutate("DELETE", `zones/${zoneId}`);
      close();
    });
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

      .form { display: flex; flex-direction: column; gap: 14px; min-width: 300px; }
      .form ha-textfield, .form ha-select { width: 100%; }
      .form-section { font-size: 13px; font-weight: 600; color: var(--secondary-text-color);
                      text-transform: uppercase; letter-spacing: .04em; margin-top: 6px; }
      .danger { --mdc-theme-primary: var(--error-color, #db4437); }
    `;
  }
}

customElements.define("irrigazione-smart-panel", IrrigazioneSmartPanel);
