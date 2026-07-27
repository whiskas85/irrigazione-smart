/*
 * Pannello laterale di Irrigazione Smart.
 *
 * Web component vanilla (nessun passo di build): Home Assistant assegna la
 * proprietà `hass`; il pannello legge la configurazione dall'API interna
 * `/api/irrigazione_smart/overview` e i valori live da `hass.states`.
 */

const SENSORS = [
  { key: "temperature", label: "Temperatura", icon: "mdi:thermometer" },
  { key: "humidity", label: "Umidità", icon: "mdi:water-percent" },
  { key: "wind_speed", label: "Vento", icon: "mdi:weather-windy" },
  { key: "precipitation", label: "Pioggia", icon: "mdi:weather-rainy" },
  { key: "irradiance", label: "Irraggiamento", icon: "mdi:white-balance-sunny" },
];

class IrrigazioneSmartPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._overview = null;
    this._loading = false;
    this._error = null;
    this._lastRender = 0;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._overview) {
      if (!this._loading) this._fetchOverview();
      return;
    }
    // Ridisegna al massimo una volta al secondo per i valori live.
    if (Date.now() - this._lastRender > 1000) this._render();
  }

  set narrow(value) {
    this._narrow = value;
  }
  set route(_value) {}
  set panel(_value) {}

  async _fetchOverview() {
    this._loading = true;
    this._render();
    try {
      this._overview = await this._hass.callApi(
        "GET",
        "irrigazione_smart/overview"
      );
      this._error = null;
    } catch (err) {
      this._error = err && err.message ? err.message : String(err);
    } finally {
      this._loading = false;
      this._render();
    }
  }

  _toggleMenu() {
    this.dispatchEvent(
      new CustomEvent("hass-toggle-menu", { bubbles: true, composed: true })
    );
  }

  _liveState(entityId) {
    if (!entityId || !this._hass) return null;
    const st = this._hass.states[entityId];
    if (!st) {
      return { missing: true, name: entityId };
    }
    return {
      name: st.attributes.friendly_name || entityId,
      value: st.state,
      unit: st.attributes.unit_of_measurement || "",
      entityId,
    };
  }

  _fmtCoord(v) {
    return typeof v === "number" ? v.toFixed(4) : "—";
  }

  _render() {
    this._lastRender = Date.now();
    this.shadowRoot.innerHTML = `
      <style>${this._css()}</style>
      <div class="app">
        <header class="bar">
          <button class="menu" title="Menu" aria-label="Menu">
            <ha-icon icon="mdi:menu"></ha-icon>
          </button>
          <ha-icon class="brand" icon="mdi:sprinkler-variant"></ha-icon>
          <span class="title">Irrigazione Smart</span>
        </header>
        <main class="content">${this._body()}</main>
      </div>
    `;
    const menu = this.shadowRoot.querySelector(".menu");
    if (menu) menu.addEventListener("click", () => this._toggleMenu());
  }

  _body() {
    if (this._loading && !this._overview) {
      return `<div class="empty">Caricamento…</div>`;
    }
    if (this._error) {
      return `<div class="card error">
        <ha-icon icon="mdi:alert-circle-outline"></ha-icon>
        <div>Impossibile leggere la configurazione.<br><small>${this._error}</small></div>
      </div>`;
    }
    if (!this._overview || !this._overview.configured) {
      return `<div class="card">
        <div class="card-head"><ha-icon icon="mdi:cog-outline"></ha-icon><h2>Non ancora configurata</h2></div>
        <p class="muted">Aggiungi l'integrazione da <b>Impostazioni → Dispositivi e servizi</b> per impostare posizione e sensori.</p>
      </div>`;
    }

    const sys = this._overview.system;
    return `
      ${this._banner()}
      ${this._locationCard(sys)}
      ${this._sensorsCard(sys)}
      ${this._zonesCard()}
    `;
  }

  _banner() {
    return `<div class="banner">
      <ha-icon icon="mdi:information-outline"></ha-icon>
      <span>Questa versione mostra la configurazione e i sensori. La gestione delle zone e i calcoli in tempo reale arrivano nelle prossime versioni.</span>
    </div>`;
  }

  _locationCard(sys) {
    return `<div class="card">
      <div class="card-head"><ha-icon icon="mdi:map-marker-outline"></ha-icon><h2>Posizione</h2></div>
      <div class="grid">
        <div class="cell"><span class="k">Latitudine</span><span class="v">${this._fmtCoord(sys.latitude)}</span></div>
        <div class="cell"><span class="k">Longitudine</span><span class="v">${this._fmtCoord(sys.longitude)}</span></div>
        <div class="cell"><span class="k">Altitudine</span><span class="v">${sys.elevation ?? "—"} m</span></div>
      </div>
    </div>`;
  }

  _sensorsCard(sys) {
    const hasWeather = !!sys.weather_entity;
    const rows = SENSORS.map((s) => {
      const entityId = sys.sensors ? sys.sensors[s.key] : null;
      const live = this._liveState(entityId);
      let right;
      if (!entityId) {
        right = `<span class="badge muted">${
          hasWeather ? "Fallback meteo" : "Non configurato"
        }</span>`;
      } else if (live && live.missing) {
        right = `<span class="badge warn">non disponibile</span>`;
      } else {
        right = `<span class="reading">${live.value}${
          live.unit ? " " + live.unit : ""
        }</span>`;
      }
      const sub = entityId
        ? `<span class="sub">${(live && live.name) || entityId}</span>`
        : "";
      return `<div class="row">
        <ha-icon icon="${s.icon}"></ha-icon>
        <div class="row-main"><span class="row-label">${s.label}</span>${sub}</div>
        ${right}
      </div>`;
    }).join("");

    const weather = `<div class="row">
      <ha-icon icon="mdi:weather-partly-cloudy"></ha-icon>
      <div class="row-main"><span class="row-label">Meteo di fallback</span></div>
      ${
        hasWeather
          ? `<span class="reading small">${sys.weather_entity}</span>`
          : `<span class="badge muted">nessuno</span>`
      }
    </div>`;

    return `<div class="card">
      <div class="card-head"><ha-icon icon="mdi:gauge"></ha-icon><h2>Sorgenti dati meteo</h2></div>
      ${rows}
      <div class="divider"></div>
      ${weather}
    </div>`;
  }

  _zonesCard() {
    return `<div class="card">
      <div class="card-head"><ha-icon icon="mdi:sprinkler"></ha-icon><h2>Zone</h2></div>
      <div class="empty-state">
        <ha-icon icon="mdi:sprinkler-variant"></ha-icon>
        <p>Nessuna zona configurata.</p>
        <p class="muted small">La creazione e la gestione delle zone di irrigazione arriveranno in una versione successiva.</p>
      </div>
    </div>`;
  }

  _css() {
    return `
      :host { display: block; background: var(--primary-background-color); min-height: 100vh; color: var(--primary-text-color); }
      .app { display: flex; flex-direction: column; min-height: 100vh; }
      .bar { display: flex; align-items: center; gap: 12px; height: 56px; padding: 0 12px;
             background: var(--app-header-background-color, var(--primary-color));
             color: var(--app-header-text-color, #fff); box-shadow: var(--ha-card-box-shadow, 0 2px 4px rgba(0,0,0,.2)); }
      .bar .brand { --mdc-icon-size: 26px; }
      .bar .title { font-size: 20px; font-weight: 500; }
      .menu { background: none; border: none; color: inherit; cursor: pointer; padding: 6px; display: flex; border-radius: 50%; }
      .menu:hover { background: rgba(255,255,255,.12); }
      .content { padding: 16px; max-width: 720px; width: 100%; margin: 0 auto; box-sizing: border-box; }
      .banner { display: flex; gap: 10px; align-items: center; padding: 12px 14px; margin-bottom: 16px;
                background: var(--card-background-color); border-left: 4px solid var(--info-color, var(--primary-color));
                border-radius: 8px; font-size: 14px; color: var(--secondary-text-color); }
      .banner ha-icon { color: var(--info-color, var(--primary-color)); flex: 0 0 auto; }
      .card { background: var(--card-background-color); border-radius: var(--ha-card-border-radius, 12px);
              box-shadow: var(--ha-card-box-shadow, 0 2px 6px rgba(0,0,0,.12)); padding: 16px; margin-bottom: 16px; }
      .card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
      .card-head ha-icon { color: var(--primary-color); }
      .card-head h2 { font-size: 16px; font-weight: 600; margin: 0; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; }
      .cell { display: flex; flex-direction: column; gap: 2px; }
      .cell .k { font-size: 12px; color: var(--secondary-text-color); text-transform: uppercase; letter-spacing: .03em; }
      .cell .v { font-size: 20px; font-weight: 600; }
      .row { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--divider-color); }
      .row:last-child { border-bottom: none; }
      .row > ha-icon { color: var(--state-icon-color, var(--secondary-text-color)); flex: 0 0 auto; }
      .row-main { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; }
      .row-label { font-size: 15px; }
      .sub { font-size: 12px; color: var(--secondary-text-color); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .reading { font-size: 16px; font-weight: 600; white-space: nowrap; }
      .reading.small { font-size: 13px; font-weight: 500; color: var(--secondary-text-color); }
      .badge { font-size: 12px; padding: 3px 8px; border-radius: 12px; white-space: nowrap; }
      .badge.muted { background: var(--divider-color); color: var(--secondary-text-color); }
      .badge.warn { background: var(--warning-color, #ffa600); color: #222; }
      .divider { height: 1px; background: var(--divider-color); margin: 4px 0; }
      .muted { color: var(--secondary-text-color); }
      .small { font-size: 13px; }
      .empty, .empty-state { text-align: center; color: var(--secondary-text-color); padding: 24px 8px; }
      .empty-state ha-icon { --mdc-icon-size: 40px; color: var(--disabled-text-color); }
      .empty-state p { margin: 6px 0; }
      .card.error { display: flex; gap: 12px; align-items: center; border-left: 4px solid var(--error-color, #db4437); }
      .card.error ha-icon { color: var(--error-color, #db4437); }
    `;
  }
}

customElements.define("irrigazione-smart-panel", IrrigazioneSmartPanel);
