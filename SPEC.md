# irrigazione_smart — Specifica tecnica

Custom integration per Home Assistant. Gestione irrigazione a zone dinamiche
con bilancio idrico FAO-56, ereditarietà parametri a tre livelli e pannello
di configurazione dedicato in sidebar.

Modello architetturale di riferimento: **Alarmo** (`nielsfaber/alarmo`) —
storage-based, zone create a runtime, pannello frontend custom, API WebSocket.

---

## 1. Obiettivi

| Requisito | Nota |
|---|---|
| Zone dinamiche | Create/eliminate a runtime dal pannello, nessun massimo |
| Ereditarietà a 3 livelli | Sistema → Preset tipo zona → Zona |
| Bilancio idrico | Deficit accumulato, non soglie di temperatura |
| Meteo | OpenWeatherMap o qualunque entity `weather.*` |
| Giorni esclusi | Per sistema e per zona |
| Correttore per zona | Moltiplicatore manuale sulla durata |
| Cycle & soak | Automatico quando portata > infiltrazione |
| Pannello dedicato | Voce in sidebar, non una dashboard Lovelace |

Fuori scope v1: previsioni multi-giorno pesate, sensori di umidità del
suolo, integrazione con flussimetri.

---

## 2. Struttura del progetto

```
custom_components/irrigazione_smart/
├── __init__.py           # setup, registrazione pannello, coordinator
├── manifest.json
├── const.py              # DOMAIN, chiavi storage, default
├── config_flow.py        # setup iniziale: lat/lon, entity meteo, unità
├── store.py              # persistenza zone su .storage (Store helper)
├── coordinator.py        # DataUpdateCoordinator: meteo → ET0 → deficit
├── hydro.py              # ⚠️ motore di calcolo — GIÀ SCRITTO, non riscrivere
├── websocket.py          # API per il pannello frontend
├── services.yaml
├── switch.py             # per zona: enable + trigger manuale
├── number.py             # per zona: correttore, portata, override numerici
├── select.py             # per zona: tipo zona, terreno, erogatore
├── sensor.py             # per zona: deficit, durata prevista, prossima irrigazione
├── binary_sensor.py      # per zona: irriga oggi (sì/no) + motivo in attributo
└── translations/
    ├── it.json
    └── en.json

frontend/                 # progetto TS separato, build → panel.js
├── src/
│   ├── irrigazione-panel.ts
│   ├── views/
│   │   ├── zones-view.ts       # lista zone, CRUD
│   │   ├── zone-editor.ts      # editor singola zona con ereditarietà
│   │   ├── system-view.ts      # default globali
│   │   └── history-view.ts     # grafico deficit/irrigazioni
│   └── components/
│       └── inherit-field.ts    # ⚠️ componente chiave, vedi §7
```

---

## 3. Schema di storage

File: `.storage/irrigazione_smart.zones`

```jsonc
{
  "version": 1,
  "data": {
    "system": {
      "latitude": 45.08,
      "longitude": 7.40,
      "weather_entity": "weather.casa",
      "soil": "franco",
      "master_enabled": true,
      "window_start": "04:00",
      "window_end": "08:00",
      "overflow_policy": "truncate",
      "gap_minutes": 5,
      "max_runtime_min": null,
      "wind_max_kmh": 18.0,
      "rain_forecast_max_mm": 8.0,
      "soak_minutes": 30,
      "excluded_days": ["sun"],
      "sequential": true,
      "max_concurrent": 1
    },
    "zones": {
      "01HXYZ...": {
        "id": "01HXYZ...",          // ULID generato alla creazione
        "name": "Prato Sud - Piscina",
        "valve_entity": "switch.linea_3",
        "enabled": true,
        "zone_type": "prato_microterme",
        "order": 1,

        // ── override: -1 / "eredita" = eredita dal livello superiore
        "soil": "eredita",
        "kc": -1,
        "root_depth_cm": -1,
        "mad": -1,
        "efficiency": -1,
        "window_start": "eredita",
        "window_end": "eredita",
        "max_runtime_min": -1,

        // ── sempre espliciti: descrivono l'impianto, non la coltura
        "rate_mm_h": 12.0,
        "emitter": "statici",
        "corrector": 1.0,
        "excluded_days": [],

        // ── stato runtime
        "deficit_mm": 4.2,
        "last_irrigation": "2026-07-25T05:10:00+02:00",
        "last_duration_min": 133
      }
    }
  }
}
```

**Punti critici**

- `id` è un ULID, mai il nome: rinominare una zona non deve rompere nulla.
- `deficit_mm` va persistito ad ogni aggiornamento. È lo stato più prezioso
  del sistema: perderlo azzera settimane di storia idrica.
- Lo storage va **debounced** (Alarmo usa `Store.async_delay_save` con
  delay 10s) per non martellare la SD del Pi.

---

## 4. Entità dinamiche

Ogni zona genera un set di entità. Alla creazione di una zona vanno
aggiunte a caldo, senza riavvio.

| Platform | Entity ID | Note |
|---|---|---|
| `switch` | `switch.irrigazione_<slug>_enabled` | abilitazione zona |
| `number` | `number.irrigazione_<slug>_correttore` | 0.5–2.0, step 0.05 |
| `number` | `number.irrigazione_<slug>_portata` | mm/h dal tuna can test |
| `select` | `select.irrigazione_<slug>_tipo` | preset |
| `select` | `select.irrigazione_<slug>_terreno` | `↑ Eredita` + tessiture |
| `sensor` | `sensor.irrigazione_<slug>_deficit` | mm, `state_class: measurement` |
| `sensor` | `sensor.irrigazione_<slug>_durata` | minuti previsti oggi |
| `binary_sensor` | `binary_sensor.irrigazione_<slug>_irriga_oggi` | + attributi `reason`, `soglia`, `cicli` |

**Pattern di implementazione**: ogni platform espone un
`async_setup_entry` che registra un listener sul coordinator; alla
creazione di una zona il coordinator emette un segnale dispatcher
`irrigazione_smart_zone_added` e le platform chiamano
`async_add_entities` per la nuova zona. Alla rimozione, si deregistra
dall'entity registry.

Riferimento diretto: `alarmo/binary_sensor.py` + `alarmo/__init__.py`
implementano esattamente questo ciclo per le aree.

---

## 5. Coordinator — flusso dati

Ciclo ogni `UPDATE_INTERVAL_MIN` minuti, con chiusura del giorno a
mezzanotte:

```
1. Leggi meteo             → temperatura, umidità, vento, pioggia, previsioni
2. Accumula la giornata    → t_min, t_max, medie, pioggia cumulata
3. Stima ET0 del giorno    → hydro.compute_et0(t_min, t_max, ...)
4. Quota già maturata      → hydro.et_fraction_elapsed(lat, doy, ora)
5. Per ogni zona, addebita solo il delta non ancora scaricato:
   a. params  = hydro.resolve_zone_params(zone, system)
   b. deficit = hydro.apply_water_balance(deficit, ΔETc, Δpioggia, params)
   c. plan    = hydro.evaluate_zone(zone, system, deficit, vento, previsioni)
   d. persisti deficit, esponi plan sulle entità
6. A mezzanotte: ET0 definitiva sui dati misurati, si addebita il residuo
7. All'orario di start, per le zone con plan.should_run:
   → esegui la sequenza (§6)
```

**Perché il bilancio non aspetta mezzanotte.** ET0 è una grandezza
giornaliera, ma un deficit che resta a zero per tutta la giornata e
salta di colpo dopo mezzanotte mostra il falso proprio nelle ore in cui
si decide se irrigare, e fa partire l'impianto con un giorno di
ritardo. La giornata si distribuisce quindi sulla curva della radiazione
(una semisinusoide fra alba e tramonto, integrata da
`et_fraction_elapsed`) e si addebita a piccoli passi.

Il conto si tiene per **differenze**, non per totali: `daily` conserva
`et0_charged_mm` e `rain_charged_mm`, cioè fin dove si è già arrivati.
Due conseguenze volute — l'irrigazione che scala il deficit durante il
giorno non viene cancellata da un ricalcolo, e la chiusura di mezzanotte
addebita solo il residuo rispetto all'ET0 definitiva. La pioggia
efficace si calcola sempre sul cumulato e poi si sottrae la quota già
contata: la soglia dei 2 mm non è additiva.

### 5.1 Fonti dei dati: sensori locali con fallback meteo

Ogni grandezza si risolve con la stessa logica di ereditarietà usata per
i parametri agronomici:

```
Sensore locale → Servizio meteo → Non disponibile
```

| Grandezza | `device_class` | Se manca |
|---|---|---|
| Temperatura | `temperature` | forecast daily `templow` / `temperature` |
| Umidità | `humidity` | `humidity` dell'entity weather |
| Vento | `wind_speed` | `wind_speed` dell'entity weather |
| Pioggia | `precipitation` | `precipitation` dalla forecast |
| Irraggiamento | `irradiance` | stimato dall'escursione termica |

Il selettore nel pannello filtra le entità sulla `device_class` corretta,
così non è possibile collegare un sensore sbagliato. Configurabile a
livello di sistema e — opzionalmente — per zona: un'aiuola all'ombra del
garage e il prato in pieno sole hanno microclimi diversi e possono
puntare a sensori diversi.

**La provenienza va sempre mostrata in dashboard.** Se l'anemometro va
offline e il sistema ripiega silenziosamente sul dato regionale, l'utente
deve poterlo vedere: `resolve_measurement()` in `hydro.py` ritorna già la
coppia `(valore, provenienza)` proprio per questo.

### 5.2 Il modello ET0 cambia in base ai sensori

Questa è la conseguenza importante dell'avere sensori locali:

| Dati disponibili | Metodo | Accuratezza |
|---|---|---|
| Solo temperature | Hargreaves-Samani | Buona |
| \+ umidità e vento | Penman-Monteith (Rs stimata) | Molto buona |
| \+ irraggiamento | Penman-Monteith completo | Riferimento FAO |

`hydro.compute_et0()` sceglie da solo il metodo migliore disponibile e
ritorna un `Et0Result` con il campo `method`. **Esporre `method` come
attributo del sensore ET0**: sapere su quale modello sta girando
l'impianto è diagnostica di prima necessità.

Lo scarto tra Hargreaves e Penman-Monteith su una giornata estiva tipo è
circa l'8% — che su una stagione diventa una cinquantina di mm di errore
cumulato, cioè due o tre irrigazioni in più o in meno.

### 5.3 Da valore istantaneo a Tmin/Tmax giornaliere

Un sensore locale dà lo stato istantaneo, ma il bilancio idrico vuole i
valori **giornalieri**. Due strade:

1. **Recorder statistics** (preferita): interrogare
   `statistics_during_period` per min/max/mean del giorno. Richiede che
   il sensore abbia `state_class: measurement`, altrimenti non genera
   statistiche a lungo termine. Verificarlo in fase di setup e segnalarlo
   all'utente se manca.
2. **Campionamento nel coordinator**: tracciare min/max nell'arco della
   giornata e persisterli. Più semplice ma perde i dati a ogni riavvio.

Per umidità e vento serve la **media** giornaliera, non il valore
puntuale. Il vento per la regola di guardia (deriva dello spray) è invece
il valore **istantaneo al momento della partenza**: sono due usi diversi
dello stesso sensore.

**Fonte meteo di fallback.** Usare il service `weather.get_forecasts`
(l'attributo `forecast` diretto è deprecato). Tmin/Tmax vanno presi dalla
forecast *daily* del giorno corrente, non dalla temperatura istantanea.

### 5.4 Il sensore che conviene aggiungere

Se stai comprando sensori, il **pluviometro** (`device_class:
precipitation`) è quello con il ritorno più alto, più di umidità e vento
messi insieme. Il motivo: "quanto è piovuto davvero nel mio giardino"
batte qualunque previsione, e la pioggia entra nel bilancio idrico con lo
stesso peso dell'evapotraspirazione. Un temporale estivo che il servizio
meteo dà a 5mm e che da te ne scarica 25 sposta il deficit di due giorni
pieni.

**Recupero dopo downtime.** Se HA è stato spento per N giorni, al riavvio
il coordinator deve ricostruire il deficit iterando sullo storico meteo
disponibile, non ripartire da zero. Se lo storico manca, meglio azzerare
e loggare un warning che accumulare un valore falso.

---

## 6. Finestra oraria e capienza

La finestra è **configurabile e ereditabile per zona**, come tutti gli
altri parametri. Il default 04:00–08:00 è agronomicamente ottimale ma
resta un default.

### 6.1 Avviso di qualità, non blocco

`hydro.window_quality()` classifica la finestra scelta in ottimale /
accettabile / sconsigliata, con la motivazione. Il pannello mostra
l'avviso accanto al campo, **senza impedire il salvataggio**:

```
Finestra    [20:00] – [22:00]
            ✗ Sconsigliata — irrigare la sera lascia il fogliame
              bagnato tutta la notte e favorisce le malattie fungine
```

L'utente può avere ragioni che il sistema non conosce (turni di lavoro,
limitazioni comunali sui prelievi, pressione dell'acquedotto). Il
compito dell'integration è informare, non decidere al posto suo.

**Perché l'override per zona ha senso**: la goccia sulle aiuole non ha
il problema della bagnatura fogliare né quello della deriva da vento —
può girare a qualunque ora. Vincolarla alla stessa finestra del prato
sprecherebbe capienza preziosa.

### 6.1-bis Le passate si alternano fra le linee

Un ciclo non è "irriga e aspetta": è **irriga**, e poi il terreno deve
assorbire prima della passata successiva. Tenere la valvola ferma per
quella mezz'ora è tempo buttato — nel frattempo può bagnare un'altra
linea.

Sei linee da quattro passate, in sequenza, occupano dieci ore; alternate,
poco più di due e mezza. È la funzione che i programmatori commerciali
chiamano *cycle & soak*, e senza di essa la finestra non basta mai.

`hydro.interleave_cycles()` decide l'ordine: a ogni passo si sceglie la
zona **disponibile prima**; a parità, quella che ha fatto meno passate, e
solo da ultimo l'ordine di sequenza. Il secondo criterio non è un
dettaglio — senza, appena scade l'assorbimento della prima zona questa
rivince ogni pareggio contro le zone in coda, e l'ultima linea non irriga
finché le altre non hanno finito.

**L'esecutore usa la stessa funzione del programma mostrato in pagina.**
Se irrigasse in un ordine suo, la pagina mostrerebbe una cosa e
l'impianto ne farebbe un'altra. Gli orari calcolati servono però solo a
stabilire la successione: i tempi veri li impone l'esecuzione, che può
slittare aspettando la conferma di una valvola, e l'assorbimento viene
riverificato a ogni passata su quanto è passato davvero.

Conseguenze sul resto del sistema:

- l'occupazione della finestra è l'**arco** dalla prima all'ultima
  passata, non la somma delle durate: le linee si intrecciano
- la barra di avanzamento conta i **minuti d'acqua**, non l'orologio: fra
  una passata e l'altra di una linea ne passano altre, e una barra a
  tempo reale segnerebbe il 100% con un quarto dell'acqua erogata
- una linea la cui valvola non conferma **non riprova** le passate
  rimaste: se non ha risposto adesso non risponderà fra dieci minuti, e
  il suo deficit resta a bilancio per il giorno dopo

### 6.1-ter Tentativi di apertura

Il principio resta quello di sempre: non si dà mai per scontato che una
linea stia irrigando solo perché è stato dato il comando. Ma **un
silenzio solo non prova che la valvola sia guasta** — una radio o una
batteria possono perdere un comando e rispondere al successivo, e
rinunciare al primo tentativo salta un'irrigazione per un pacchetto
perso.

Si riprova quindi `valve_retries` volte (2 di default, configurabile),
con `VALVE_RETRY_PAUSE_S` fra un tentativo e l'altro: riprovare
nell'istante in cui è scaduta l'attesa ricadrebbe nella stessa
condizione che ha fatto fallire il primo comando. Prima di ogni nuovo
tentativo si richiude, così si riparte da una condizione nota invece che
da un comando appeso.

Ogni tentativo andato a vuoto finisce nel registro come avviso, e il
recupero pure ("valvola aperta al tentativo 2 di 3"): una valvola che
funziona solo al secondo colpo sta dicendo qualcosa, e va vista prima
che smetta del tutto. Esaurito l'ultimo tentativo la linea viene saltata
per questa irrigazione, e le passate rimaste non si riprovano.

### 6.2 La finestra è un vincolo di capienza

Questo è il vero motivo per cui la finestra va gestita bene. Con
cycle & soak e zone in sequenza, i minuti si accumulano in fretta:

```
04:00–06:43  Prato Sud     163 min
06:48–08:53  Prato Nord    125 min
08:58–09:38  Aiuola Est     40 min
             totale 338 min su 240 disponibili (141%)
```

`hydro.schedule_sequence()` calcola il piano e ritorna `fits`,
`overflow_minutes` e `utilization`. Due politiche configurabili:

| `overflow_policy` | Comportamento | Quando |
|---|---|---|
| `overflow` | Sfora la finestra, segnala | Impianto dedicato, nessuno in casa sveglio |
| `truncate` | Esclude le zone in coda | Pressione condivisa con l'uso domestico |

**Il default consigliato è `truncate`.** Irrigare alle 9 del mattino
mentre qualcuno fa la doccia è peggio che saltare una zona: quella zona
recupera il giorno dopo con un deficit più alto e una durata maggiore,
il bilancio idrico si autocorregge. La pressione dell'acqua no.

Le zone escluse vanno **notificate**, non silenziate: una zona che viene
troncata sistematicamente ogni notte è il sintomo di una finestra
sottodimensionata, e l'utente deve poterlo capire senza andare a leggere
i log.

### 6.3 Tetto massimo di durata

Campo `max_runtime_min`, con la solita catena:

```
Zona → Sistema → ABSOLUTE_MAX_RUNTIME_MIN (240 min)
```

Lasciato vuoto, decide il sistema. Il fallback finale a 240 minuti **non
è un vincolo agronomico**: è la rete che impedisce a un errore di
configurazione — portata inserita come 1.2 invece di 12 — di tenere una
valvola aperta per mezza giornata. Va tenuto anche quando l'utente non
imposta nulla.

Nel pannello il campo va etichettato per quello che fa:

```
Durata massima    [        ] min
                  Vuoto: decide il sistema in base al deficit
```

**Il tetto limita i minuti di valvola aperta, non le pause.** Un piano
con cycle & soak da 60 minuti totali e 30 di pausa occupa 90 minuti di
finestra ma consuma 60 minuti di tetto. `RunPlan.total_minutes` è la
grandezza soggetta al cap, `wall_clock_minutes` quella che riempie la
finestra.

### 6.4 Il residuo deve restare a bilancio

Questa è la parte da non sbagliare. Quando il tetto tronca la durata, la
zona riceve meno acqua di quanta ne servisse. Il deficit **non va
azzerato**:

```python
deficit = plan.residual_mm    # NON deficit = 0
```

`build_run_plan()` ritorna già `applied_mm` e `residual_mm`, e vale
sempre `applied_mm + residual_mm == deficit`. Azzerare il bucket dopo
un'irrigazione troncata significa cancellare dalla memoria del sistema
l'acqua che non è stata data: il prato va in stress e i numeri in
dashboard dicono che è tutto a posto.

Lo stesso vale nel coordinator quando un ciclo viene interrotto —
riavvio di HA, stop manuale, watchdog: va calcolato
`params.applied_mm(minuti_effettivi)` e scalato solo quello.

### 6.5 Diagnostica del tetto

Un tetto troppo stretto produce un deficit che non rientra mai. Con
portata 12 mm/h e tetto a 45 minuti, in dieci giorni di canicola:

```
g 4  deficit 13.7 → irriga 45min, dà 6.3mm, resta 12.3mm
g 5  deficit 10.7 → irriga 45min, dà 6.3mm, resta 10.7mm
g 6  deficit  7.8 → irriga 45min, dà 6.3mm, resta  7.8mm
...
```

Irriga quasi ogni giorno senza mai recuperare: l'esatto opposto del
"deep & infrequent" che il modello vorrebbe.

Il sistema deve accorgersene e dirlo. **Se una zona risulta `capped` per
più di 3 giorni consecutivi**, emettere una persistent notification che
proponga le tre uscite reali: alzare il tetto, alzare la portata
dell'impianto, o accettare una soglia MAD più bassa (irrigazioni più
frequenti e più brevi, che su terreno sabbioso è comunque legittimo).

L'attributo `capped` va esposto sul sensore della durata, così è
graficabile nello storico.

### 6.6 Indicatore di utilizzo

Il pannello dovrebbe mostrare in permanenza la percentuale di
riempimento della finestra sul piano di stanotte. Sopra il 100% è un
allarme; sopra l'80% è un avviso che il sistema sta andando al limite e
che una zona in più non ci starà.

È anche la diagnostica che spinge l'utente verso la soluzione giusta:
allargare la finestra, oppure alzare la portata dell'impianto, oppure
accettare di irrigare a giorni alterni per zona.

---

## 7. Esecuzione della sequenza

Le zone non partono insieme: la pressione dell'acqua non basta.

```
sequential = true, max_concurrent = 1   (default)
```

Per ogni zona in ordine di `order`:

```
per ciclo in 1..plan.cycles:
    apri valve_entity
    attendi plan.minutes_per_cycle
    chiudi valve_entity
    se non è l'ultimo ciclo:
        attendi plan.soak_minutes
```

Al termine della zona: `deficit_mm = 0`, `last_irrigation = now()`.

**Requisiti di robustezza**

- Un riavvio di HA a metà sequenza deve **chiudere tutte le valvole**.
  Registrare un `homeassistant_stop` listener che spegne tutto.
- Watchdog: se una valvola risulta aperta oltre `total_minutes * 1.5`,
  forzare la chiusura ed emettere una persistent notification. Una valvola
  bloccata aperta è l'unico guasto di questo sistema che costa soldi veri.
- Il ciclo va implementato come task asincrono cancellabile, non con
  `asyncio.sleep` dentro un service handler.

---

## 8. Pannello frontend

Voce in sidebar `Irrigazione`, icona `mdi:sprinkler-variant`.
Registrazione via `async_register_built_in_panel` con
`frontend_url_path="irrigazione-smart"`.

### Il componente chiave: `inherit-field`

Ogni campo ereditabile è un controllo a due stati che deve rendere
**sempre visibile il valore effettivo**, altrimenti l'utente non capisce
mai cosa sta realmente usando il sistema:

```
┌─────────────────────────────────────────────┐
│ Terreno                                     │
│ ┌─────────────────────────┐                 │
│ │ ↑ Eredita          ▾    │  franco         │
│ └─────────────────────────┘  ← da: Sistema  │
└─────────────────────────────────────────────┘
```

Quando l'utente sceglie un valore esplicito, l'etichetta di provenienza
sparisce e compare un pulsante "ripristina eredità". Il valore effettivo
resta sempre a destra del controllo, mai nascosto dietro un tooltip.

### Viste

| Vista | Contenuto |
|---|---|
| Zone | Lista con nome, stato, deficit, prossima irrigazione. Drag per `order`. |
| Editor zona | Form con `inherit-field` per ogni parametro agronomico |
| Sistema | Default globali, giorni esclusi, finestra oraria, guardie |
| Storico | Grafico deficit nel tempo con marker delle irrigazioni |

### Direzione visiva

Il soggetto è un sistema idraulico agronomico, non un'app generica.
Evitare la palette "smart home" da default (blu/verde acqua saturi).
Ancorare la tavolozza ai materiali reali: terra, ottone delle valvole,
verde smorzato del tappeto erboso in stress idrico. Il deficit va
rappresentato come **livello che scende**, non come percentuale astratta:
è la metafora che rende immediatamente leggibile lo stato.

Rispettare i token di tema HA (`--primary-color`, `--card-background-color`,
ecc.) per non stonare col resto dell'interfaccia.

### 8.1 Mappa del giardino

Una planimetria — foto aerea, disegno, screenshot di una mappa — con le
aree irrigate disegnate sopra. Serve a rispondere a colpo d'occhio a una
domanda che le liste rendono faticosa: *dove* manca acqua.

**Il riempimento non è configurabile.** Il colore lo decide `zoneStatus()`,
lo stesso che colora la dashboard e le schede dei gruppi: trasparente se
la linea sta bene, giallo se chiede acqua, rosso in carenza forte,
azzurro pulsante mentre irriga. Configurabile è il *bordo*, che dice
quale area è quale. Lasciar scegliere anche il riempimento avrebbe reso
la mappa una decorazione invece che uno strumento diagnostico.

**Coordinate normalizzate 0..1** sui lati dell'immagine, non pixel. La
stessa mappa deve reggere il telefono e il desktop, e sostituire la
planimetria con una a risoluzione diversa non deve buttare via il
disegno. Il riquadro segue esattamente l'immagine (`width:100%`,
`height:auto`) e l'SVG ci si sovrappone al 100% con
`preserveAspectRatio="none"`: le coordinate combaciano senza calcoli di
lettering, e il disegno si deforma esattamente come l'immagine.

**L'immagine non passa da `image_upload`** di Home Assistant, che serve
solo miniature quadrate di 256 o 512 pixel: una planimetria ritagliata a
quadrato e ridotta a 512 non si legge più. Il file si salva per intero in
`.storage/irrigazione_smart/` e si serve da `MapImageServeView`, senza
autenticazione — un tag `img` non può portarsi dietro il token, ed è la
stessa scelta che fa `image_upload`. Si serve **solo** la planimetria
attualmente configurata, quindi non c'è modo di farsi restituire un file
arbitrario con un percorso costruito ad arte.

| Gesto | In visualizzazione | In modifica |
|---|---|---|
| Tocco su un'area o sulla sua icona | Irriga quella linea | Seleziona |
| Tocco su un'area già selezionata | — | Trascina tutta l'area |
| Tocco su una maniglia | — | Sposta il vertice |
| Tocco su un punto a metà lato | — | Aggiunge un vertice |

Il primo tocco su un'area seleziona e basta: trascinare per sbaglio
un'area appena scelta è il modo più facile di rovinare un disegno.

Un'area senza nome proprio prende quello della linea collegata, come già
fa con l'icona: chiamare "Area 3" il pezzo di prato che si chiama "Prato
Sud" costringerebbe a tenere allineati a mano due nomi per la stessa cosa.

**Le card a fianco non le disegna questo pannello.** Le costruisce il
frontend di Home Assistant con `loadCardHelpers()`, lo stesso meccanismo
delle dashboard: funziona quindi qualunque card, comprese quelle
installate da HACS, e l'integration non deve sapere niente di nessuna di
esse — conserva configurazioni grezze e non le interpreta. La colonna sta
**fuori** da ciò che `_repaintMap` sostituisce, e si ricostruisce solo
quando la sua firma cambia: una card ha uno stato suo — un grafico a metà
animazione, una previsione appena caricata — che non va buttato via a
ogni movimento del dito su un vertice. Una card scritta male diventa un
avviso al posto suo, senza portarsi dietro le altre.

I salvataggi avvengono a **trascinamento finito**, non a ogni movimento:
una chiamata al server per ogni pixel percorso intaserebbe la rete e la
scheda SD. Durante il gesto si ridisegnano i soli poligoni e maniglie
(`_repaintMapLayers`), e il riquadro si misura una volta sola all'inizio
— misurarlo dopo un ridisegno significherebbe misurare un elemento
appena staccato dal documento, che risponde zero.

---

## 9. API WebSocket

```
irrigazione_smart/zones           → lista zone + parametri risolti
irrigazione_smart/zone/create     → crea zona, ritorna id
irrigazione_smart/zone/update     → aggiorna (patch parziale)
irrigazione_smart/zone/delete     → elimina + rimuove entità
irrigazione_smart/system          → get/set config sistema
irrigazione_smart/preview         → simula un piano senza eseguirlo
irrigazione_smart/history         → serie storica deficit per zona
```

`preview` è il più importante per l'usabilità: l'utente modifica un
parametro e vede subito l'effetto sulla durata, senza aspettare il giorno
dopo.

**Ogni risposta deve includere i parametri risolti**, non solo quelli
grezzi: il frontend non deve reimplementare la logica di ereditarietà.

---

## 10. Servizi

```yaml
irrigazione_smart.run_zone:       # esegue una zona, durata opzionale
irrigazione_smart.run_all:        # esegue la sequenza completa
irrigazione_smart.stop:           # ferma tutto, chiude le valvole
irrigazione_smart.set_deficit:    # forza il deficit (calibrazione/debug)
irrigazione_smart.skip_today:     # salta oggi senza toccare la config
```

---

## 11. Roadmap

| Fase | Contenuto | Verificabile quando |
|---|---|---|
| 1 | `hydro.py` + test | I test passano (già fatto) |
| 2 | Storage, config_flow, coordinator | Le zone si creano via WebSocket |
| 3 | Platform entità dinamiche | Le entità compaiono/spariscono a caldo |
| 4 | Esecuzione sequenza + watchdog | Le valvole si aprono e chiudono |
| 5 | Pannello frontend | Configurazione senza YAML |
| 6 | Storico e preview | Grafici e simulazione |

Le fasi 1-4 producono un sistema **già utilizzabile** pilotandolo da
dashboard Lovelace. La 5 è quella lunga: è un progetto TypeScript a sé.
Non iniziarla prima che la 4 sia stabile in produzione per almeno una
settimana di irrigazioni reali.

---

## 12. Note di calibrazione

Prima di fidarsi dei numeri servono due misure sul campo:

1. **Tuna can test per ogni linea.** 5-6 barattoli distribuiti sulla zona,
   15 minuti di irrigazione, media dei mm raccolti × 4 = `rate_mm_h`.
   Senza questo dato il sistema calcola durate arbitrarie.

2. **Verifica della profondità radicale.** Dopo un'irrigazione, infilare
   un cacciavite lungo nel terreno: si ferma dove il suolo è asciutto.
   Se si ferma a 8cm mentre `root_depth_cm` è 20, il modello sta
   sovrastimando la riserva e la zona andrà in stress prima del previsto.

Il primo mese va trattato come taratura: confrontare quello che il
sistema propone con quello che l'occhio dice del prato, e correggere
`corrector` di zona. Non toccare Kc e MAD finché la portata non è
verificata — sono i parametri giusti da muovere per ultimi.
