/*
 * Pannello laterale di Irrigazione Smart.
 *
 * Web component vanilla (nessun passo di build). Usa i componenti nativi di
 * Home Assistant (ha-top-app-bar-fixed, ha-card, ha-alert, ha-dialog,
 * ha-textfield, ha-select, ha-switch…) e solo variabili di tema, così
 * l'aspetto segue qualsiasi tema attivo.
 *
 * I valori agronomici mostrati arrivano già calcolati dal backend
 * (`hydro.py`): qui non si duplica nessuna formula.
 */

const SENSORS = [
  { key: "temperature", label: "Temperatura", icon: "mdi:thermometer" },
  { key: "humidity", label: "Umidità", icon: "mdi:water-percent" },
  { key: "wind_speed", label: "Vento", icon: "mdi:weather-windy" },
  { key: "precipitation", label: "Pioggia", icon: "mdi:weather-rainy" },
  { key: "irradiance", label: "Irraggiamento", icon: "mdi:white-balance-sunny" },
];

const ZONE_TYPE_LABELS = {
  prato_microterme: "Prato microterme",
  prato_macroterme: "Prato macroterme",
  aiuola_arbusti: "Aiuola / arbusti",
  aiuola_fiorita: "Aiuola fiorita",
  orto: "Orto",
};
const SOIL_LABELS = {
  sabbioso: "Sabbioso",
  franco: "Franco",
  argilloso: "Argilloso",
};
const EMITTER_LABELS = {
  statici: "Irrigatori statici",
  turbine: "Turbine",
  goccia: "Ala gocciolante",
};

const INHERIT_NUM = -1;
const INHERIT_STR = "eredita";

const label = (map, key) => map[key] || key;
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);

class IrrigazioneSmartPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._overview = null;
    this._loading = false;
    this._error = null;
    this._busy = false;
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

  async _api(method, path, body) {
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
    this._busy = true;
    try {
      const res = await this._api(method, path, body);
      if (res && res.overview) this._overview = res.overview;
      this._error = null;
    } catch (err) {
      this._error = (err && err.message) || String(err);
    } finally {
      this._busy = false;
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
        <div class="content">${this._body()}</div>
      </ha-top-app-bar-fixed>
    `;
    this._updateMenuButton();
    this._bind();
  }

  _bind() {
    const sr = this.shadowRoot;
    const on = (sel, fn) =>
      sr.querySelectorAll(sel).forEach((el) => el.addEventListener("click", fn));

    on(".add-zone", () => this._openZoneDialog(null));
    on(".edit-zone", (e) =>
      this._openZoneDialog(e.currentTarget.getAttribute("data-id"))
    );
    on(".delete-zone", (e) =>
      this._confirmDelete(e.currentTarget.getAttribute("data-id"))
    );
    on(".edit-system", () => this._openSystemDialog());
    on(".retry", () => this._fetchOverview());
  }

  _body() {
    if (this._loading && !this._overview) {
      return `<div class="empty">Caricamento…</div>`;
    }
    if (this._error && !this._overview) {
      return `<ha-alert alert-type="error" title="Errore">
        ${esc(this._error)}
      </ha-alert>
      <mwc-button class="retry" raised label="Riprova"></mwc-button>`;
    }
    if (!this._overview || !this._overview.configured) {
      return `<ha-alert alert-type="info" title="Non ancora configurata">
        Aggiungi l'integrazione da Impostazioni → Dispositivi e servizi per
        impostare posizione e sensori.
      </ha-alert>`;
    }

    const sys = this._overview.system;
    return `
      ${this._error ? `<ha-alert alert-type="error">${esc(this._error)}</ha-alert>` : ""}
      ${sys.master_enabled ? "" : `<ha-alert alert-type="warning">Il sistema è in pausa: nessuna zona verrà irrigata.</ha-alert>`}
      ${this._zonesCard()}
      ${this._systemCard(sys)}
      ${this._sensorsCard(sys)}
    `;
  }

  // ------------------------------------------------------------- zone

  _zonesCard() {
    const zones = this._overview.zones || [];
    const body = zones.length
      ? zones.map((z) => this._zoneRow(z)).join("")
      : `<div class="empty-state">
           <ha-icon icon="mdi:sprinkler-variant"></ha-icon>
           <p>Nessuna zona configurata.</p>
           <p class="muted small">Aggiungi la prima zona per iniziare a calcolare il bilancio idrico.</p>
         </div>`;

    return `<ha-card>
      <div class="inner">
        <div class="card-head">
          <ha-icon icon="mdi:sprinkler"></ha-icon>
          <h2>Zone</h2>
          <span class="spacer"></span>
          <mwc-button class="add-zone" label="Aggiungi zona" icon="mdi:plus"></mwc-button>
        </div>
        ${body}
      </div>
    </ha-card>`;
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
    if (!z.enabled) {
      status = `<span class="badge muted">disabilitata</span>`;
    } else if (plan.should_run) {
      status = `<span class="badge run">${plan.total_minutes} min · ${plan.cycles} ${plan.cycles > 1 ? "cicli" : "ciclo"}</span>`;
    } else {
      status = `<span class="badge ok">sotto soglia</span>`;
    }

    const valve = z.valve_entity
      ? `<span class="chip"><ha-icon icon="mdi:valve"></ha-icon>${esc(z.valve_entity)}</span>`
      : `<span class="chip warnchip"><ha-icon icon="mdi:valve"></ha-icon>nessuna valvola</span>`;

    return `<div class="zone">
      <div class="zone-head">
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
        <span class="muted">soglia ${threshold.toFixed(1)} mm · TAW ${taw.toFixed(1)} mm</span>
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

  // ------------------------------------------------------------ sistema

  _systemCard(sys) {
    const w = sys.window || {};
    const qIcon = { ottimale: "mdi:check-circle", accettabile: "mdi:alert-circle-outline", sconsigliata: "mdi:close-circle" }[w.quality] || "mdi:clock-outline";
    return `<ha-card>
      <div class="inner">
        <div class="card-head">
          <ha-icon icon="mdi:cog-outline"></ha-icon>
          <h2>Impostazioni sistema</h2>
          <span class="spacer"></span>
          <mwc-button class="edit-system" label="Modifica"></mwc-button>
        </div>

        <div class="row">
          <ha-icon icon="mdi:power"></ha-icon>
          <div class="row-main"><span class="row-label">Sistema</span></div>
          <span class="badge ${sys.master_enabled ? "ok" : "muted"}">${sys.master_enabled ? "attivo" : "in pausa"}</span>
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
          <ha-icon icon="mdi:map-marker-outline"></ha-icon>
          <div class="row-main"><span class="row-label">Posizione</span>
            <span class="sub">${this._fmtCoord(sys.latitude)}, ${this._fmtCoord(sys.longitude)} · ${sys.elevation ?? "—"} m</span>
          </div>
        </div>
      </div>
    </ha-card>`;
  }

  _sensorsCard(sys) {
    const hasWeather = !!sys.weather_entity;
    const rows = SENSORS.map((s) => {
      const entityId = sys.sensors ? sys.sensors[s.key] : null;
      const live = this._liveState(entityId);
      let right;
      if (!entityId) {
        right = `<span class="badge muted">${hasWeather ? "Fallback meteo" : "Non configurato"}</span>`;
      } else if (live && live.missing) {
        right = `<span class="badge warn">non disponibile</span>`;
      } else {
        right = `<span class="reading" data-entity="${esc(entityId)}">${esc(live.value)}${live.unit ? " " + esc(live.unit) : ""}</span>`;
      }
      const sub = entityId ? `<span class="sub">${esc((live && live.name) || entityId)}</span>` : "";
      return `<div class="row">
        <ha-icon icon="${s.icon}"></ha-icon>
        <div class="row-main"><span class="row-label">${s.label}</span>${sub}</div>
        ${right}
      </div>`;
    }).join("");

    return `<ha-card>
      <div class="inner">
        <div class="card-head"><ha-icon icon="mdi:gauge"></ha-icon><h2>Sorgenti dati meteo</h2></div>
        ${rows}
        <div class="row">
          <ha-icon icon="mdi:weather-partly-cloudy"></ha-icon>
          <div class="row-main"><span class="row-label">Meteo di fallback</span></div>
          ${hasWeather ? `<span class="reading small">${esc(sys.weather_entity)}</span>` : `<span class="badge muted">nessuno</span>`}
        </div>
        <p class="muted small note">Le sorgenti si cambiano da Impostazioni → Dispositivi e servizi → Irrigazione Smart.</p>
      </div>
    </ha-card>`;
  }

  // ------------------------------------------------------------- dialoghi

  _field(field, labelText, value, opts = {}) {
    const { type = "text", suffix = "", helper = "" } = opts;
    return `<ha-textfield
      data-field="${field}"
      label="${labelText}"
      type="${type}"
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
      name: "",
      valve_entity: "",
      enabled: true,
      zone_type: "prato_microterme",
      rate_mm_h: 10,
      emitter: "statici",
      corrector: 1.0,
      soil: INHERIT_STR,
      kc: INHERIT_NUM,
      root_depth_cm: INHERIT_NUM,
      mad: INHERIT_NUM,
      max_runtime_min: INHERIT_NUM,
      deficit_mm: 0,
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
        ${this._field("mad", "MAD", inh(z.mad), { type: "number", helper: "Frazione di acqua consumabile prima di irrigare (0–1)" })}
        ${this._field("max_runtime_min", "Durata massima", inh(z.max_runtime_min), { type: "number", suffix: "min" })}

        <div class="form-section">Stato</div>
        ${this._field("deficit_mm", "Deficit attuale", z.deficit_mm, {
          type: "number", suffix: "mm",
          helper: "Azzeralo dopo un'irrigazione manuale",
        })}
        <ha-formfield label="Zona abilitata">
          <ha-switch data-field="enabled"${z.enabled ? " checked" : ""}></ha-switch>
        </ha-formfield>
      </div>`;

    this._showDialog(zone ? "Modifica zona" : "Nuova zona", content, async (dlg) => {
      const data = this._collect(dlg, {
        numbers: ["rate_mm_h", "corrector", "kc", "root_depth_cm", "mad", "max_runtime_min", "deficit_mm"],
        inheritNumbers: ["kc", "root_depth_cm", "mad", "max_runtime_min"],
        booleans: ["enabled"],
      });
      if (!data.name) {
        data.name = "Nuova zona";
      }
      if (zone) await this._mutate("POST", `zones/${zone.id}`, data);
      else await this._mutate("POST", "zones", data);
    });
  }

  _openSystemDialog() {
    const sys = this._overview.system;
    const opts = this._overview.options || {};
    const content = `
      <div class="form">
        <ha-formfield label="Sistema attivo">
          <ha-switch data-field="master_enabled"${sys.master_enabled ? " checked" : ""}></ha-switch>
        </ha-formfield>
        ${this._field("window_start", "Inizio finestra", sys.window_start, { type: "time" })}
        ${this._field("window_end", "Fine finestra", sys.window_end, { type: "time" })}
        ${this._select("soil", "Terreno predefinito", opts.soils || [], sys.soil, SOIL_LABELS)}
        ${this._field("soak_minutes", "Pausa di assorbimento", sys.soak_minutes, { type: "number", suffix: "min" })}
        ${this._field("gap_minutes", "Pausa tra zone", sys.gap_minutes, { type: "number", suffix: "min" })}
        ${this._field("wind_max_kmh", "Vento massimo", sys.wind_max_kmh, { type: "number", suffix: "km/h" })}
        ${this._field("rain_forecast_max_mm", "Pioggia prevista massima", sys.rain_forecast_max_mm, { type: "number", suffix: "mm" })}
        ${this._select("overflow_policy", "Se la finestra non basta", ["truncate", "overflow"], sys.overflow_policy, { truncate: "Escludi le zone eccedenti", overflow: "Sfora la finestra" })}
      </div>`;

    this._showDialog("Impostazioni sistema", content, async (dlg) => {
      const data = this._collect(dlg, {
        numbers: ["soak_minutes", "gap_minutes", "wind_max_kmh", "rain_forecast_max_mm"],
        booleans: ["master_enabled"],
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
      let v = el.value;
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
      .content { padding: 16px; max-width: 780px; margin: 0 auto; box-sizing: border-box; }
      ha-alert { display: block; margin-bottom: 16px; }
      ha-card { display: block; margin-bottom: 16px; }
      .inner { padding: 16px; }
      .spacer { flex: 1 1 auto; }
      .card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
      .card-head ha-icon { color: var(--primary-color); }
      .card-head h2 { font-size: 16px; font-weight: 600; margin: 0; color: var(--primary-text-color); }

      .row { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--divider-color); }
      .row:last-of-type { border-bottom: none; }
      .row > ha-icon { color: var(--state-icon-color, var(--secondary-text-color)); flex: 0 0 auto; }
      .row-main { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; }
      .row-label { font-size: 15px; color: var(--primary-text-color); }
      .sub { font-size: 12px; color: var(--secondary-text-color); overflow: hidden; text-overflow: ellipsis; }
      .reading { font-size: 16px; font-weight: 600; white-space: nowrap; color: var(--primary-text-color); }
      .reading.small { font-size: 13px; font-weight: 500; color: var(--secondary-text-color); }

      .badge { font-size: 12px; padding: 3px 10px; border-radius: 14px; white-space: nowrap; }
      .badge.muted { background: var(--divider-color); color: var(--secondary-text-color); }
      .badge.ok { background: color-mix(in srgb, var(--success-color, #43a047) 18%, transparent); color: var(--success-color, #43a047); }
      .badge.run { background: color-mix(in srgb, var(--info-color, var(--primary-color)) 18%, transparent); color: var(--info-color, var(--primary-color)); }
      .badge.warn { background: color-mix(in srgb, var(--warning-color, #ffa600) 22%, transparent); color: var(--warning-color, #ffa600); }
      .badge.q-ottimale { background: color-mix(in srgb, var(--success-color, #43a047) 18%, transparent); color: var(--success-color, #43a047); }
      .badge.q-accettabile { background: color-mix(in srgb, var(--warning-color, #ffa600) 20%, transparent); color: var(--warning-color, #ffa600); }
      .badge.q-sconsigliata { background: color-mix(in srgb, var(--error-color, #db4437) 18%, transparent); color: var(--error-color, #db4437); }

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
      .bar-fill { height: 100%; background: var(--info-color, var(--primary-color)); transition: width .3s; }
      .bar-fill.over { background: var(--warning-color, #ffa600); }
      .bar-thr { position: absolute; top: -2px; width: 2px; height: 12px; background: var(--primary-text-color); opacity: .55; }

      .muted { color: var(--secondary-text-color); }
      .small { font-size: 13px; }
      .note { margin: 12px 0 0; }
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
