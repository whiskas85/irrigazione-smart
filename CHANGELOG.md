# Changelog

Il formato segue [Keep a Changelog](https://keepachangelog.com/it/1.1.0/)
e il progetto usa [Semantic Versioning](https://semver.org/lang/it/).

Le nuove voci vanno scritte sotto la sezione *Unreleased*. Al momento del
rilascio, `scripts/bump.py` le promuove alla nuova versione con la data.

## [Unreleased]

### Aggiunto
- **Pannello diviso in schede**: *Dashboard* (master, stato delle linee,
  sequenza della notte), *Zone* (gestione completa delle linee e
  impostazioni), *Meteo* (ET0, accumulo della giornata, sorgenti, posizione)
- **Entità esposte**, usabili in automazioni, scene e dashboard:
  - `switch` master generale — spento, nessuna linea viene irrigata
  - `switch` master per ogni linea — esclude la singola linea
  - `sensor` ET0 giornaliera, con il metodo di calcolo negli attributi
  - `sensor` deficit idrico per linea, con soglia e TAW negli attributi
  - `sensor` durata prevista per linea, con cicli e motivo negli attributi
- Ogni linea diventa un **dispositivo** in Home Assistant, collegato a quello
  dell'impianto: le sue entità si raggruppano da sole e si possono assegnare
  a un'area
- Le entità si creano e si rimuovono **a caldo** quando aggiungi o elimini
  una zona, senza riavviare
- Pannello ed entità restano allineati nei due sensi: spegnere il master
  dalla pagina aggiorna l'interruttore esposto, e viceversa
- Dashboard: sequenza della notte con orari di ogni linea e diagnosi di
  capienza della finestra (avvisi se sfora o se esclude delle linee)
- **Coordinator**: il bilancio idrico ora si aggiorna da solo (`coordinator.py`).
  Ogni 10 minuti campiona le sorgenti meteo e accumula gli estremi della
  giornata; dopo la mezzanotte chiude il giorno, calcola ET0 e aggiorna il
  deficit di tutte le zone. FAO-56 lavora su grandezze giornaliere: leggere
  un valore istantaneo darebbe un ET0 sistematicamente sbagliato
- Il metodo ET0 si sceglie da solo in base ai sensori disponibili
  (Hargreaves-Samani con le sole temperature, Penman-Monteith con umidità e
  vento, Penman-Monteith pieno con l'irraggiamento) ed è mostrato in pagina:
  l'utente deve sapere su quale modello gira il suo impianto
- Card "Bilancio idrico": ET0 dell'ultimo giorno chiuso con il metodo usato,
  e l'accumulo della giornata in corso (T min/max, pioggia, medie di umidità
  e vento)
- Gli accumulatori giornalieri sono persistiti: un riavvio a metà pomeriggio
  non fa perdere la massima già registrata
- La provenienza di ogni misura (sensore locale o servizio meteo) è visibile
  in pagina: se un sensore cade e il sistema ripiega sul meteo, si vede
- Le zone mostrano i blocchi reali (vento eccessivo, sistema in pausa, zona
  disabilitata, gelo) con lo stesso criterio che userà l'esecuzione
- Conversione automatica delle unità in ingresso (°F, km/h, mph, nodi)

### Note
Tutto il funzionamento è **locale**: nessuna dipendenza esterna
(`requirements` vuoto), nessuna chiamata di rete, frontend servito
dall'installazione. I dati meteo arrivano dalle entità già presenti in
Home Assistant.
- **Gestione zone dal pannello**: creazione, modifica ed eliminazione delle
  zone direttamente dalla pagina, senza riavviare. Le zone sono persistite
  in `.storage/irrigazione_smart.zones` con salvataggio debounced (`store.py`,
  vedi SPEC.md §3); l'id è un ULID, così rinominare una zona non rompe nulla
- Ogni zona mostra i valori calcolati da `hydro.py`: deficit sulla barra del
  bilancio idrico con la tacca della soglia, TAW, e il piano di irrigazione
  (minuti, cicli, pause di assorbimento, millimetri lordi, avviso di
  troncamento dal tetto massimo)
- Form di zona con ereditarietà a tre livelli: i campi override lasciati
  vuoti ereditano dal preset o dal sistema
- Impostazioni di sistema modificabili dal pannello: finestra oraria con
  valutazione agronomica, terreno predefinito, pause, soglie di vento e
  pioggia prevista, politica di overflow, pausa generale
- API REST interne per il pannello: `overview`, `zones`, `zones/{id}`,
  `system`. Le modifiche richiedono un utente amministratore
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
