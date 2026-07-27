# Changelog

Il formato segue [Keep a Changelog](https://keepachangelog.com/it/1.1.0/)
e il progetto usa [Semantic Versioning](https://semver.org/lang/it/).

Le nuove voci vanno scritte sotto la sezione *Unreleased*. Al momento del
rilascio, `scripts/bump.py` le promuove alla nuova versione con la data.

## [Unreleased]

### Aggiunto
- Pagina dedicata nella barra laterale ("Irrigazione"): mostra la posizione
  configurata, le sorgenti dati meteo con i valori live dei sensori e la
  sezione Zone (per ora vuota). Prima interfaccia visibile dell'integration.
  Implementata come pannello custom (`www/irrigazione-smart-panel.js`) con
  una piccola API interna `/api/irrigazione_smart/overview` (`panel.py`).
  Usa i componenti nativi di Home Assistant (`ha-top-app-bar-fixed`,
  `ha-card`, `ha-alert`, `ha-menu-button`) e solo variabili di tema, così
  l'aspetto segue automaticamente qualsiasi tema, chiaro o scuro
- Richiede un riavvio di Home Assistant dopo l'aggiornamento perché la voce
  in sidebar venga registrata

### Modificato
- Nuova icona del brand: sagoma "casa" cyan con irrigatore, spruzzi e
  cespugli. Sorgente vettoriale in `brand-src/icon.svg`, PNG rigenerati in
  `custom_components/irrigazione_smart/brand/`
- Versione minima di Home Assistant portata a 2024.7 (uso di
  `async_register_static_paths`)

## [0.1.1] - 2026-07-27

### Corretto
- Il flusso di configurazione non si apriva (400 Bad Request): i selettori
  di latitudine e longitudine usavano `step=0.0001`, sotto il minimo di
  `0.001` imposto da Home Assistant. Sostituito con `step="any"`, che
  consente precisione arbitraria sulle coordinate

### Aggiunto
- Icona e logo dell'integration in `custom_components/irrigazione_smart/brand/`,
  visibili dalla UI senza passare dal repository `home-assistant/brands`
  (richiede Home Assistant 2026.3 o successivo)

## [0.1.0] - 2026-07-27

### Aggiunto
- Motore di calcolo `hydro.py`: ET0 con Hargreaves-Samani e Penman-Monteith
  FAO-56, selezione automatica del metodo in base ai sensori disponibili
- Bilancio idrico per zona con deficit accumulato e conservazione della massa
- Ereditarietà parametri a tre livelli: Sistema, Preset tipo zona, Zona
- Cycle & soak automatico quando la portata supera l'infiltrazione del terreno
- Finestra oraria configurabile con valutazione agronomica della scelta
- Scheduling della sequenza con diagnosi di capienza e politica di overflow
- Tetto massimo di durata ereditabile, con residuo che resta a bilancio
- Config flow con selettori filtrati per `device_class`
- Specifica tecnica completa in `SPEC.md`

### Note
Questa release è lo **scaffold**: l'integration si installa e si configura
ma non crea ancora entità. Il motore di calcolo è completo e testabile in
autonomia con `python hydro.py`.
