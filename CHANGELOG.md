# Changelog

Il formato segue [Keep a Changelog](https://keepachangelog.com/it/1.1.0/)
e il progetto usa [Semantic Versioning](https://semver.org/lang/it/).

Le nuove voci vanno scritte sotto la sezione *Unreleased*. Al momento del
rilascio, `scripts/bump.py` le promuove alla nuova versione con la data.

## [Unreleased]

## [0.9.2] - 2026-07-28

### Corretto
- **Dentro la finestra, ma non irrigava.** Il programmatore scattava solo
  nell'*istante esatto* dell'orario di inizio: impostare la finestra alle
  14:28 quando erano già le 14:29 rimandava tutto al giorno dopo. Peggio,
  se Home Assistant era spento o stava riavviando a quell'ora,
  l'irrigazione di quella giornata **saltava del tutto**. Ora la finestra
  è ciò che dice di essere — l'intervallo in cui l'irrigazione è
  permessa — e la partenza avviene appena possibile al suo interno,
  restando comunque una sola al giorno per gruppo
- Quando si è dentro la finestra e l'irrigazione non è ancora partita, la
  pagina scrive **"in finestra adesso"** invece di un orario di domani

### Aggiunto
- **Niente più ricaricamento forzato del browser.** L'indirizzo del
  pannello porta ora un'impronta del contenuto, non solo la versione:
  cambia a ogni modifica del file, quindi il browser è costretto a
  riscaricarlo da sé. Utile soprattutto sul telefono, dove svuotare la
  cache non è alla portata di tutti
- La **versione in esecuzione** è mostrata accanto al titolo: si verifica a
  colpo d'occhio se l'aggiornamento è arrivato davvero

## [0.9.1] - 2026-07-28

### Corretto
- **L'avvio automatico si bloccava per il resto della giornata.** Il gruppo
  veniva marcato come "già eseguito oggi" *prima* di sapere se
  l'irrigazione partiva davvero: se all'orario di inizio nessuna linea era
  sotto soglia, il marcatore restava e ogni tentativo successivo veniva
  saltato. Chi poi forzava un deficit, o spostava la finestra più avanti,
  non vedeva partire più nulla fino al giorno dopo. Ora il marcatore si
  scrive solo quando l'irrigazione parte davvero
- **La dashboard mostrava gli orari sbagliati**: calcolava il programma
  sull'unica finestra di sistema (04:00–08:00) invece che sulla finestra di
  ciascun gruppo, così le aiuole comparivano alle 04:00 anche con la loro
  finestra impostata alle 13:45. Ora ogni gruppo compare con i propri orari

## [0.9.0] - 2026-07-28

### Aggiunto
- **Grafici**. Il sistema archivia ogni notte il riepilogo della giornata
  (90 giorni) e lo mostra:
  - *Meteo*: temperatura (fascia minima–massima), umidità media ed
    evapotraspirazione. Sono tre grafici separati e non uno solo con più
    assi: sovrapporre grandezze con scale diverse inventerebbe una
    correlazione che nei dati non c'è
  - *Dashboard*: minuti irrigati per gruppo, giorno per giorno
  - Ogni grafico ha la sua **vista tabellare**: i valori restano leggibili
    anche senza distinguere i colori
  - Le tinte sono state verificate sulle superfici reali delle card di
    Home Assistant, in tema chiaro e scuro, per restare distinguibili
    anche a chi non percepisce bene i colori
- **Portata in litri**. Il motore lavora in mm/h, ma i cataloghi degli
  irrigatori danno litri: ora si può inserire la portata in **L/h** o
  **L/min** indicando la superficie della zona, e la conversione è
  automatica (un litro su un metro quadro è alto un millimetro). La riga
  della linea mostra entrambi i valori, così si rilegge il dato inserito
  e i mm/h che ne derivano

## [0.8.0] - 2026-07-28

### Corretto
- **Il blocco per pioggia prevista non poteva scattare.** La soglia era
  configurabile e la pagina la mostrava, ma nessuno leggeva mai le
  previsioni: `rain_forecast_mm` restava sempre 0. Ora il coordinator
  interroga il servizio meteo configurato (`weather.get_forecasts`) e usa
  la pioggia prevista **per oggi** — quella di dopodomani non deve
  impedire di irrigare stanotte. Se il servizio non risponde, il resto del
  ciclo prosegue senza previsione

### Aggiunto
- **Sorgenti dati modificabili dal pannello**: servizio meteo e i cinque
  sensori locali si scelgono dalla scheda Meteo, senza passare da
  Impostazioni → Dispositivi e servizi
- Card **Pioggia prevista** con i millimetri attesi oggi, la probabilità e
  l'indicazione se superano la soglia che sospende l'irrigazione

## [0.7.4] - 2026-07-28

### Note
Nessuna modifica funzionale: rilascio di verifica, per controllare che su
un'installazione agganciata alle release la notifica di aggiornamento
compaia da sola in HACS.

## [0.7.3] - 2026-07-28

### Corretto
- **Chi installava dal ramo non riceveva mai la notifica di aggiornamento.**
  HACS ricava la versione dal tag dell'ultima release, ma per un
  repository seguito *per ramo* usa l'ultimo commit e le release non le
  guarda proprio: capitava a chi aveva installato prima che esistesse il
  primo tag. Con `hide_default_branch` il ramo non è più offerto in
  download, quindi nessuno può finire in quello stato
- Il README spiega come uscirne se ci si è già finiti: una sola
  riscaricata da HACS scegliendo la versione

## [0.7.2] - 2026-07-28

### Corretto
- **I giorni della settimana sembravano ignorare il clic.** Il giorno si
  accendeva solo dopo la risposta del server e il ridisegno della pagina:
  nel frattempo non succedeva nulla, veniva naturale cliccare di nuovo e
  il secondo clic annullava il primo. Ora il giorno si accende
  **immediatamente** e il salvataggio avviene dietro le quinte; se
  fallisce, torna indietro da solo
- Stesso trattamento per tutti gli interruttori (master generale, gruppo,
  avvio automatico, linee, notifiche e azioni): scattano subito, senza
  attendere il server
- La pagina non si ridisegna più a ogni comando, ma si riallinea poco dopo
  che si è smesso di toccare: niente sfarfallio durante una serie di clic

### Modificato
- Le GitHub Action passano alle versioni su Node 24 (`checkout@v5`,
  `setup-python@v6`): GitHub segnalava Node 20 come deprecato

## [0.7.1] - 2026-07-28

### Corretto
- **La ricerca nel registro accettava una lettera sola.** A ogni tasto si
  ridisegnava l'intera pagina, distruggendo il campo: il cursore spariva e
  i tasti successivi finivano alle scorciatoie di Home Assistant, che
  aprivano la ricerca delle entità. Ora si aggiorna soltanto l'elenco, il
  campo resta lo stesso elemento e non perde mai il fuoco
- I tasti premuti dentro ai campi del pannello non raggiungono più le
  scorciatoie globali di Home Assistant
- L'aggiornamento automatico della pagina non interviene mentre si sta
  scrivendo: aggiorna solo la lista, senza togliere il campo da sotto le
  dita

## [0.7.0] - 2026-07-28

### Aggiunto
- **L'irrigazione ora parte da sola** (`scheduler.py`). Prima il sistema
  calcolava il bilancio e mostrava il piano, ma nessuno apriva le valvole
  all'ora giusta: bisognava premere il pulsante. Allo scoccare dell'orario
  di inizio, nei giorni attivi, il gruppo parte e irriga le linee sotto
  soglia. Una sola partenza automatica al giorno per gruppo, e un gruppo
  per volta: l'impianto ha una sola pressione
- **Una scheda per gruppo** (Prato, Aiuole, Orto), ognuna con:
  - la propria **finestra oraria** e i propri **giorni della settimana**,
    da accendere e spegnere con un tocco
  - il proprio interruttore di gruppo e l'avvio automatico separato
  - **quando partirà la prossima irrigazione**, detto in chiaro
    ("oggi alle 06:30", "giovedì alle 04:00"), o il motivo per cui non
    partirà
  - il programma di quel gruppo con orari e durate
- Le linee sono bloccate nei giorni non attivi del loro gruppo, e la
  pagina lo dice invece di lasciarlo intuire

### Modificato
- **"Sequenza della notte" si chiama ora "Programma di irrigazione"**: la
  finestra è libera, se la si imposta alle 21 non è notte e il nome era
  sbagliato
- Lo stato vuoto non dice più soltanto "nessuna irrigazione prevista":
  spiega che non c'è nessun programma da creare a mano, perché è il
  bilancio idrico a decidere, e indica dove si impostano orari e giorni
- Le impostazioni comuni non contengono più la finestra oraria, che ora
  appartiene ai singoli gruppi

## [0.6.0] - 2026-07-28

### Aggiunto
- **Prato e aiuole sono gestiti separatamente.** Hanno irrigatori diversi
  — statici e turbine contro ala gocciolante — e quindi portate e durate
  diverse: tenerli in un unico elenco confondeva.
  - Dashboard e scheda Zone mostrano una card per gruppo (Prato, Aiuole,
    Orto), ciascuna con le proprie linee e il conteggio di quelle attive
  - Ogni gruppo ha il suo pulsante **"Irriga prato"** / **"Irriga aiuole"**:
    parte solo quel gruppo, senza toccare gli altri
  - Il servizio `avvia_sequenza` accetta il campo `categoria`, così la
    stessa divisione è disponibile nelle automazioni
  - La categoria si ricava dal tipo di zona: non c'è nulla da configurare

## [0.5.1] - 2026-07-28

### Corretto
- **Le tendine non funzionavano di nuovo.** I menu a tendina del frontend
  si sono rotti due volte in installazioni reali, per motivi diversi. Ora
  sono `<select>` native **vestite come i campi di Home Assistant** —
  bordo, angoli, etichetta, colore d'accento al fuoco, freccia: l'aspetto
  è quello giusto e non possono più smettere di funzionare. I selettori di
  entità e di icone restano quelli nativi di HA, dove servono davvero
- I controlli della scheda Log (ricerca e periodo) ora hanno lo stesso
  aspetto, con l'icona della lente

## [0.5.0] - 2026-07-28

### Aggiunto
- **Riordino delle linee per trascinamento**, con maniglia dedicata: la
  riga segue il puntatore e la nuova sequenza si salva al rilascio.
  Sostituisce i pulsanti su/giù
- **Registro diviso per giornata**, con "Oggi" e "Ieri" al posto della
  data, e l'ora sulla sinistra di ogni riga
- **Ricerca nel registro** e filtro per periodo (oggi, 7 giorni, 30 giorni,
  tutto), con il conteggio delle voci mostrate. Il valore predefinito è
  **ultimi 7 giorni**

## [0.4.0] - 2026-07-28

### Aggiunto
- **Notifiche e azioni** (scheda *Azioni*), sul modello di Alarmo:
  - le notifiche non sono cablate su `notify`: chiami il servizio che
    vuoi, anche un tuo script
  - le azioni chiamano un servizio con dati JSON nei momenti chiave:
    prima e dopo l'irrigazione, prima e dopo ogni linea, e quando una
    linea non parte
  - **pulsante Prova** su ogni voce: la invia subito con dati d'esempio,
    ignorando gli interruttori, per verificarla mentre la scrivi
  - due **master condivisi con Home Assistant** (`switch` Master notifiche
    e Master azioni) più l'interruttore della singola voce
  - segnaposto nei messaggi: `{linea}`, `{minuti}`, `{acqua_mm}`,
    `{durata}`, `{completate}`, `{fallite}`, `{motivo}`, `{prossima}`

### Corretto
- **L'irrigazione non si accorgeva di essere stata fermata da fuori**: se
  la valvola veniva chiusa da Home Assistant, l'esecutore continuava ad
  aspettare e la pagina dichiarava un'irrigazione che non stava più
  avvenendo. Ora la valvola viene sorvegliata per tutta la durata: se si
  chiude, l'irrigazione termina, viene registrata come interrotta e il
  deficit scala solo dell'acqua realmente erogata
- Spegnere il **master** durante l'irrigazione ferma l'intera sequenza,
  non solo la linea in corso. Le linee non ancora raggiunte non vengono
  marcate come fallite: non sono state tentate

## [0.3.1] - 2026-07-28

### Corretto
- **I form ora usano i selettori nativi di Home Assistant** (`ha-selector`,
  lo stesso componente dei config flow): selettore di entità con ricerca
  per la valvola e per il flussostato, selettore di icone con anteprima,
  tendine e campi numerici con l'aspetto di sempre. I componenti vengono
  creati da JavaScript impostandone le proprietà: costruirli scrivendo
  HTML non funziona, ed è la causa dei campi vuoti e delle tendine che non
  cambiavano
- **I pulsanti nella finestra di dialogo erano invisibili**: erano
  assegnati agli slot `primaryAction`/`secondaryAction`, che non esistono
  in tutte le versioni di `ha-dialog`. Ora stanno nel corpo del dialogo e
  si vedono sempre
- Se i selettori non sono disponibili si usano controlli equivalenti, così
  il form resta utilizzabile su qualunque versione del frontend

## [0.3.0] - 2026-07-28

### Aggiunto
- **Scheda Log**: registro delle attività con avvii, irrigazioni concluse e
  soprattutto le linee **non** partite, col motivo. Vive in un file di
  storage separato da quello delle zone, così scriverlo spesso non
  rimescola lo stato del bilancio idrico. Tenuto alle ultime 300 voci
- Nuovo evento `irrigazione_smart_zone_failed`, emesso quando una linea non
  parte (valvola che non conferma, valvola non configurata, linea saltata):
  è l'aggancio per gli allarmi
- **Stato a colpo d'occhio** di ogni linea: verde tutto a posto, giallo
  chiede acqua, rosso carenza forte, azzurro in irrigazione
- Indicazione **"irriga oggi"** con i minuti previsti, direttamente in
  dashboard
- **Ordinamento delle linee** con i pulsanti su/giù: l'ordine determina la
  successione di irrigazione
- **Icona personalizzabile** per ogni linea, con un'icona predefinita
  sensata per tipo di zona (prato, aiuola, orto)
- **Flussostato** e **attesa di conferma valvola** ora configurabili dal
  pannello, non più solo da storage
- Dalla scheda del dispositivo si arriva alla pagina dell'integration con
  un clic

### Corretto
- **Il form delle zone era inutilizzabile**: le tendine non cambiavano mai
  selezione, perché `ha-select` costruita da HTML non registra le proprie
  voci in tutte le versioni del frontend. Ora tutte le tendine sono
  controlli nativi, vestiti col tema: più sobri, ma funzionanti ovunque
- **Le entità si scelgono da un elenco**, non si scrivono più a mano:
  valvola della linea (domini `switch`, `valve`, `input_boolean`) e
  flussostato (sensori di portata) mostrano le entità reali col loro nome.
  Un'entità che non esiste più resta selezionata e viene marcata
- La lettura dei campi ricade sul controllo nativo interno quando un
  componente non espone il valore: un salvataggio non può più perdersi
  in silenzio
- La validazione automatica falliva da sempre, su tutti e tre i controlli,
  quindi nessun problema veniva mai segnalato:
  - `hassfest` pretende le chiavi del manifest nell'ordine `domain`, `name`
    e poi alfabetico; non lo erano
  - resta rosso il controllo `Check Repository` di HACS, che pretende
    descrizione e argomenti impostati sul repository GitHub: sono
    impostazioni del repository, non del codice
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
