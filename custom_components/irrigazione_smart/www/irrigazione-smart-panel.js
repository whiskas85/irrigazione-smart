/*
 * Pannello laterale di Irrigazione Smart.
 *
 * Web component vanilla (nessun passo di build). Usa i componenti nativi di
 * Home Assistant (ha-top-app-bar-fixed, ha-menu-button, ha-card, ha-alert,
 * ha-icon) e solo variabili di tema, così l'aspetto segue automaticamente
 * qualsiasi tema attivo. La configurazione arriva dall'API interna
 * `/api/irrigazione_smart/overview`; i valori live da `hass.states`.
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
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._overview) {
      if (!this._loading) this._fetchOverview();
      return;
    }
    // Aggiorna solo i valori live, senza ricostruire i componenti nativi.
    this._updateLiveValues();
    this._updateMenuButton();
  }

  set narrow(value) {
    this._narrow = value;
    this._updateMenuButton();
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
    if (!st) return { missing: true, name: entityId };
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

  _updateLiveValues() {
    if (!this.shadowRoot) return;
    this.shadowRoot.querySelectorAll("[data-entity]").forEach((node) => {
      const live = this._liveState(node.getAttribute("data-entity"));
      if (live && !live.missing) {
        node.textContent = live.value + (live.unit ? " " + live.unit : "");
      }
    });
  }

  _updateMenuButton() {
    const mb = this.shadowRoot && this.shadowRoot.querySelector("ha-menu-button");
    if (mb) {
      mb.hass = this._hass;
      mb.narrow = this._narrow;
    }
  }

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
    const fallback = this.shadowRoot.querySelector(".menu-fallback");
    if (fallback) fallback.addEventListener("click", () => this._toggleMenu());
  }

  _body() {
    if (this._loading && !this._overview) {
      return `<div class="empty">Caricamento…</div>`;
    }
    if (this._error) {
      return `<ha-alert alert-type="error" title="Errore">
        Impossibile leggere la configurazione: ${this._error}
      </ha-alert>`;
    }
    if (!this._overview || !this._overview.configured) {
      return `<ha-alert alert-type="info" title="Non ancora configurata">
        Aggiungi l'integrazione da Impostazioni → Dispositivi e servizi per
        impostare posizione e sensori.
      </ha-alert>`;
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
    return `<ha-alert alert-type="info">
      Questa versione mostra la configurazione e i sensori. La gestione delle
      zone e i calcoli in tempo reale arrivano nelle prossime versioni.
    </ha-alert>`;
  }

  _locationCard(sys) {
    return `<ha-card>
      <div class="inner">
        <div class="card-head"><ha-icon icon="mdi:map-marker-outline"></ha-icon><h2>Posizione</h2></div>
        <div class="grid">
          <div class="cell"><span class="k">Latitudine</span><span class="v">${this._fmtCoord(sys.latitude)}</span></div>
          <div class="cell"><span class="k">Longitudine</span><span class="v">${this._fmtCoord(sys.longitude)}</span></div>
          <div class="cell"><span class="k">Altitudine</span><span class="v">${sys.elevation ?? "—"} m</span></div>
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
        right = `<span class="badge muted">${
          hasWeather ? "Fallback meteo" : "Non configurato"
        }</span>`;
      } else if (live && live.missing) {
        right = `<span class="badge warn">non disponibile</span>`;
      } else {
        right = `<span class="reading" data-entity="${entityId}">${live.value}${
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

    return `<ha-card>
      <div class="inner">
        <div class="card-head"><ha-icon icon="mdi:gauge"></ha-icon><h2>Sorgenti dati meteo</h2></div>
        ${rows}
        ${weather}
      </div>
    </ha-card>`;
  }

  _zonesCard() {
    return `<ha-card>
      <div class="inner">
        <div class="card-head"><ha-icon icon="mdi:sprinkler"></ha-icon><h2>Zone</h2></div>
        <div class="empty-state">
          <ha-icon icon="mdi:sprinkler-variant"></ha-icon>
          <p>Nessuna zona configurata.</p>
          <p class="muted small">La creazione e la gestione delle zone di irrigazione arriveranno in una versione successiva.</p>
        </div>
      </div>
    </ha-card>`;
  }

  _css() {
    return `
      :host { display: block; height: 100%; background: var(--primary-background-color); }
      .app-title { display: flex; align-items: center; gap: 8px; }
      .content { padding: 16px; max-width: 720px; margin: 0 auto; box-sizing: border-box; }
      ha-alert { display: block; margin-bottom: 16px; }
      ha-card { display: block; margin-bottom: 16px; }
      .inner { padding: 16px; }
      .card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
      .card-head ha-icon { color: var(--primary-color); }
      .card-head h2 { font-size: 16px; font-weight: 600; margin: 0; color: var(--primary-text-color); }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin-top: 12px; }
      .cell { display: flex; flex-direction: column; gap: 2px; }
      .cell .k { font-size: 12px; color: var(--secondary-text-color); text-transform: uppercase; letter-spacing: .03em; }
      .cell .v { font-size: 20px; font-weight: 600; color: var(--primary-text-color); }
      .row { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--divider-color); }
      .row:first-of-type { margin-top: 8px; }
      .row:last-child { border-bottom: none; padding-bottom: 0; }
      .row > ha-icon { color: var(--state-icon-color, var(--secondary-text-color)); flex: 0 0 auto; }
      .row-main { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; }
      .row-label { font-size: 15px; color: var(--primary-text-color); }
      .sub { font-size: 12px; color: var(--secondary-text-color); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .reading { font-size: 16px; font-weight: 600; white-space: nowrap; color: var(--primary-text-color); }
      .reading.small { font-size: 13px; font-weight: 500; color: var(--secondary-text-color); }
      .badge { font-size: 12px; padding: 3px 10px; border-radius: 14px; white-space: nowrap; }
      .badge.muted { background: var(--divider-color); color: var(--secondary-text-color); }
      .badge.warn { background: var(--warning-color, #ffa600); color: var(--text-primary-color, #212121); }
      .muted { color: var(--secondary-text-color); }
      .small { font-size: 13px; }
      .empty, .empty-state { text-align: center; color: var(--secondary-text-color); padding: 24px 8px; }
      .empty-state ha-icon { --mdc-icon-size: 40px; color: var(--disabled-text-color); }
      .empty-state p { margin: 6px 0; }
    `;
  }
}

customElements.define("irrigazione-smart-panel", IrrigazioneSmartPanel);
