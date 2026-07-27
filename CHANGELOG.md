# Changelog

Il formato segue [Keep a Changelog](https://keepachangelog.com/it/1.1.0/)
e il progetto usa [Semantic Versioning](https://semver.org/lang/it/).

Le nuove voci vanno scritte sotto la sezione *Unreleased*. Al momento del
rilascio, `scripts/bump.py` le promuove alla nuova versione con la data.

## [Unreleased]

### Corretto
- La validazione automatica falliva da sempre, su tutti e tre i controlli,
  quindi nessun problema veniva mai segnalato:
  - `hassfest` pretende le chiavi del manifest nell'ordine `domain`, `name`
    e poi alfabetico; non lo erano
  - il controllo `brands` di HACS vale solo per le integration del catalogo
    ufficiale, non per una personalizzata che porta le proprie icone
  - la CI installava `ruff` senza versione fissa: il set di regole cambiava
    da solo a ogni rilascio e il lint poteva rompersi senza modifiche al
    codice. Ora le regole stanno in `pyproject.toml` e la versione è fissata

### Modificato
- Le voci di lint risolte in `hydro.py` sono puramente meccaniche
  (parentesi, `int(round())` ridondante, `if` annidati, righe lunghe): il
  comportamento del motore è invariato e verificato dalle suite di test

## [0.2.0] - 2026-07-27

Prima release utilizzabile: l'integration crea entità, espone una pagina
dedicata e apre davvero le valvole.

### Aggiunto

**Interfaccia**
- Pagina dedicata nella barra laterale, divisa in tre schede: *Dashboard*
  (master, stato delle linee, sequenza della notte), *Zone* (gestione
  completa delle linee e impostazioni), *Meteo* (ET0, accumulo della
  giornata, sorgenti dati, posizione)
- Gestione delle zone dal pannello: creazione, modifica ed eliminazione
  senza riavviare, con ereditarietà a tre livelli (i campi override
  lasciati vuoti ereditano dal preset o dal sistema)
- Ogni zona mostra i valori calcolati da `hydro.py`: barra del bilancio
  idrico con la tacca della soglia, TAW, e il piano di irrigazione
  (minuti, cicli, pause di assorbimento, millimetri lordi, avviso di
  troncamento dal tetto massimo)
- Sequenza della notte con gli orari di ogni linea e la diagnosi di
  capienza della finestra: avvisa se sfora o se deve escludere delle linee
- Impostazioni di sistema modificabili dal pannello: finestra oraria con
  valutazione agronomica, terreno predefinito, pause, soglie di vento e
  pioggia prevista, politica di overflow
- Aspetto costruito sui componenti nativi di Home Assistant e su sole
  variabili di tema: segue qualsiasi tema, chiaro o scuro

**Entità esposte** — usabili in automazioni, scene e dashboard
- `switch` master generale: spento, nessuna linea viene irrigata
- `switch` master per ogni linea, che la esclude senza toccare le altre
- `sensor` ET0 giornaliera, con il metodo di calcolo negli attributi
- `sensor` deficit idrico per linea, con soglia e TAW negli attributi
- `sensor` durata prevista per linea, con cicli e motivo negli attributi
- Ogni linea diventa un **dispositivo** collegato a quello dell'impianto:
  le sue entità si raggruppano da sole e si possono assegnare a un'area
- Le entità si creano e si rimuovono a caldo quando aggiungi o elimini una
  zona, senza riavviare; pannello ed entità restano allineati nei due sensi

**Esecuzione dell'irrigazione**
- `executor.py` apre le valvole, rispetta cicli e pause di assorbimento,
  aggiorna il deficit con l'acqua realmente erogata e registra data e
  durata dell'ultima irrigazione
- **Conferma di apertura della valvola**: non si assume mai che una linea
  stia irrigando solo perché è stato dato il comando. Dopo il comando si
  attende la conferma di stato; se non arriva entro il timeout la linea
  viene saltata e la sequenza prosegue, lasciando il deficit a bilancio
  perché venga recuperato
- Servizi `irrigazione_smart.irriga_linea` (con durata fissa opzionale,
  attivo solo se la linea è abilitata), `avvia_sequenza`, `ferma`
- Eventi sul bus, richiamabili da automazioni esterne:
  `irrigazione_smart_started`, `_finished`, `_zone_started`,
  `_zone_finished`, con nome linea, minuti, acqua erogata, flusso e
  prossima linea
- Dalla pagina: avvio della sequenza, forzatura della singola linea con
  durata modificabile, interruzione immediata, barra di progresso con
  ciclo e fase, data dell'ultima irrigazione
- Flussostato configurabile, di **sola lettura**: mostrato in pagina e
  incluso negli eventi, non blocca né interrompe mai l'irrigazione

**Bilancio idrico automatico**
- `coordinator.py` campiona le sorgenti meteo ogni 10 minuti e accumula gli
  estremi della giornata; dopo la mezzanotte chiude il giorno, calcola ET0
  e aggiorna il deficit di tutte le zone. FAO-56 lavora su grandezze
  giornaliere: usare un valore istantaneo darebbe un ET0 sistematicamente
  sbagliato
- Il metodo ET0 si sceglie da solo secondo i sensori disponibili
  (Hargreaves-Samani con le sole temperature, Penman-Monteith con umidità e
  vento, Penman-Monteith pieno con l'irraggiamento) ed è mostrato in
  pagina: l'utente deve sapere su quale modello gira il suo impianto
- Gli accumulatori giornalieri sono persistiti: un riavvio a metà pomeriggio
  non fa perdere la massima già registrata
- La provenienza di ogni misura (sensore locale o servizio meteo) è
  visibile: se un sensore cade e il sistema ripiega sul meteo, si vede
- Conversione automatica delle unità in ingresso (°F, km/h, mph, nodi)

**Persistenza**
- Le zone vivono in `.storage/irrigazione_smart.zones` con salvataggio
  debounced (`store.py`, vedi SPEC.md §3); l'id è un ULID, così rinominare
  una zona non rompe nulla
- API REST interne per il pannello (`overview`, `zones`, `zones/{id}`,
  `system`, `run`, `stop`); le modifiche richiedono un amministratore

### Corretto
- Il pulsante **Aggiungi zona** era invisibile: usava `mwc-button`, che le
  versioni recenti del frontend non registrano. Lo stesso problema rendeva
  invisibili *Salva* e *Annulla* nei dialoghi, quindi non era possibile
  creare una zona in nessun modo
- I componenti dei form ora vengono rilevati a runtime: si usano quelli
  nativi di Home Assistant se presenti, altrimenti controlli HTML
  equivalenti stilizzati col tema. La pagina resta usabile su qualunque
  versione del frontend

### Modificato
- Nuova icona del brand: sagoma "casa" cyan con irrigatore, spruzzi e
  cespugli. Sorgente vettoriale in `brand-src/icon.svg`
- Versione minima di Home Assistant portata a 2024.7 (uso di
  `async_register_static_paths`)

### Note
Tutto il funzionamento è **locale**: nessuna dipendenza esterna
(`requirements` vuoto), nessuna chiamata di rete, frontend servito
dall'installazione. I dati meteo arrivano dalle entità già presenti in
Home Assistant.

Dopo l'aggiornamento serve un **riavvio di Home Assistant**: questa
release introduce nuove platform (`switch`, `sensor`) e la voce in sidebar.

Prima di lasciare il sistema in automatico, misura la portata reale di
ogni linea col *tuna can test*: senza quel dato le durate calcolate sono
arbitrarie, per quanto la matematica sia corretta.

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
