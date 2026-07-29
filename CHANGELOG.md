# Changelog

Il formato segue [Keep a Changelog](https://keepachangelog.com/it/1.1.0/)
e il progetto usa [Semantic Versioning](https://semver.org/lang/it/).

Le nuove voci vanno scritte sotto la sezione *Unreleased*. Al momento del
rilascio, `scripts/bump.py` le promuove alla nuova versione con la data.

## [Unreleased]

### Modificato
- **Il badge della batteria resta in alto a destra della linea.** Sul
  telefono era finito a capo insieme agli altri stati: non è uno stato
  fra gli altri, è la ragione per cui una valvola non aprirà, e in fondo
  alla riga lo si vede quando è troppo tardi. Ora tiene la prima riga
  accanto al nome, all'estremità destra

## [1.7.1] - 2026-07-29

### Corretto
- **Il pannello si legge anche dal telefono.** Ogni riga della pagina è
  fatta allo stesso modo — un'icona, un testo, e in coda badge e comandi
  — e su uno schermo da telefono la coda si prendeva quasi tutto: al
  nome restavano quaranta pixel, dove *«Prato davanti alla casa»*
  scendeva in verticale una lettera per riga. Nella scheda di un gruppo
  il nome della linea arrivava a **zero pixel** di larghezza, coi
  pulsanti di modifica spinti fuori dallo schermo. Ora sotto i 700 px la
  coda va a capo: il nome tiene la prima riga insieme al suo
  interruttore, badge e comandi stanno sotto, allineati a destra
  - I sette giorni della settimana stanno in una riga sola invece di
    spezzarsi in sei più uno
  - Le maniglie dei vertici sulla mappa e i pulsanti crescono dove si
    tocca con un dito invece che con un puntatore
  - Le finestre di dialogo non sforano più su schermi stretti
- **I grafici non sono più stirati.** Erano disegnati su una larghezza
  fissa di 640 unità e poi schiacciati su quella vera: su un telefono le
  date dell'asse uscivano compresse a metà, alte e strettissime, e anche
  su desktop il testo era allungato di un decimo. Ora il disegno è fatto
  sulla larghezza misurata, e si rifà quando quella cambia — il telefono
  che ruota, la finestra che si stringe
- **Tre riquadri di numeri e la barra del deficit erano invisibili.** Un
  rinomino di classi CSS aveva staccato dalla loro grafica la griglia di
  *Linee attive / Chiedono acqua / Tempo totale*, quella di *Accumulo di
  oggi*, quella di *Posizione* e la barra del deficit di ogni linea: i
  numeri si incolonnavano uno sotto l'altro e la barra non si vedeva più
- La scheda attiva viene portata in vista quando la barra delle schede
  non ci sta tutta, e il metodo di calcolo dell'ET0 non si spezza più in
  tre righe a caratteri cubitali

## [1.7.0] - 2026-07-29

### Aggiunto
- **La valvola che non chiude è ora il caso più serio del sistema.** Una
  valvola che non apre lascia un prato asciutto; una che non chiude allaga
  il giardino, svuota il pozzo e continua a farlo finché qualcuno non se
  ne accorge di persona. Fra i due errori non c'è simmetria, e il codice
  ora lo riflette: **sei tentativi** di chiusura (non configurabili, non
  c'è motivo per cui qualcuno debba poterli abbassare), poi una
  **notifica persistente** che resta davanti agli occhi finché non la si
  scarta, l'irrigazione interrotta per non aprire altre valvole, e
  l'evento `irrigazione_smart_valve_stuck` per chi vuole agganciarci una
  sirena o la chiusura della generale
  - Vale anche quando si preme *Ferma tutto*: fermare l'irrigazione non
    deve poter lasciare acqua aperta
- **Ripresa dopo un riavvio.** Un'irrigazione dura ore, e in quelle ore
  Home Assistant può riavviarsi o aggiornarsi: il task che seguiva la
  sequenza sparisce, ma **l'acqua no** — un relè chiuso resta chiuso. Ora
  un segnaposto su disco dice quale valvola era aperta, e al riavvio il
  sistema la chiude, lo scrive nel registro e avvisa con una notifica
  - La giornata torna in gioco: il marcatore "già partito oggi" viene
    cancellato per i gruppi che hanno ancora linee a secco, così
    l'irrigazione interrotta riprende invece di essere persa fino a
    domani. Non si ricostruisce nessuno stato — ci pensa il bilancio
    idrico a sapere cosa manca, e le linee già servite sono sotto soglia
  - L'acqua erogata si mette a bilancio **a ogni passata** e non a fine
    linea: se il riavvio arriva fra una passata e l'altra, quella passata
    è comunque uscita e il terreno l'ha ricevuta

### Modificato
- **Le schede in alto restano visibili mentre la pagina scorre.** Sono la
  navigazione, e doverla riesumare risalendo una pagina lunga di linee è
  la ragione per cui si finisce a scorrere avanti e indietro

## [1.6.0] - 2026-07-29

### Modificato
- **La valvola che non risponde viene ritentata, non abbandonata.** Il
  controllo di apertura c'era già, ma al primo silenzio la linea veniva
  saltata: un silenzio solo però non prova che la valvola sia guasta —
  una radio o una batteria possono perdere un comando e rispondere al
  successivo, e così bastava un pacchetto perso per saltare
  un'irrigazione. Ora si riprova **due volte** (configurabile, 0 = come
  prima), con cinque secondi di respiro: riprovare nell'istante in cui è
  scaduta l'attesa ricadrebbe nella stessa condizione che ha fatto
  fallire il primo comando
  - Prima di ogni nuovo tentativo la valvola viene richiusa, così si
    riparte da una condizione nota invece che da un comando appeso
  - Ogni tentativo a vuoto finisce nel registro come avviso, e anche il
    recupero: «valvola aperta al tentativo 2 di 3». Una valvola che
    funziona solo al secondo colpo sta dicendo qualcosa, e va vista prima
    che smetta del tutto
  - Esauriti i tentativi, la linea viene saltata per questa irrigazione
    esattamente come prima, col deficit che resta a bilancio

## [1.5.0] - 2026-07-29

### Aggiunto
- **Batteria della valvola, per linea e per aiuola.** Gli irrigatori a
  batteria muoiono in silenzio: la valvola non apre, la linea non irriga,
  e lo si scopre dal prato secco qualche giorno dopo. Ora ogni linea può
  puntare la propria batteria, e il badge compare in dashboard accanto al
  nome — grigio finché non serve guardarlo, ambra sotto il 30%, rosso
  sotto il 15% con scritto perché importa: *«la valvola potrebbe non
  aprire»*
  - Vanno bene entrambi i modi in cui Home Assistant la dichiara: un
    sensore con la percentuale, o un `binary_sensor` che dice soltanto se
    è scarica
  - Se il sensore diventa non disponibile lo scrive, invece di far
    sparire il badge: una batteria che non risponde è essa stessa una
    notizia
  - La percentuale si aggiorna dal vivo, senza aspettare il giro di
    ricarica della pagina
  - Il campo è facoltativo: senza, il badge non compare e niente cambia

## [1.4.0] - 2026-07-29

### Corretto
- **«Ferma» ferma tutto l'impianto, non la linea.** Il pulsante stava su
  una scheda intitolata al nome della linea in corso, e si leggeva come
  "salta questa linea": annulla invece l'intera sequenza, e non si torna
  indietro. Ora si chiama **Ferma tutto**, ovunque compaia

### Aggiunto
- **La scheda principale dice cosa sta succedendo, e permette di
  fermare.** Mentre irrigava non diceva niente e non offriva niente:
  l'unico comando per fermare era sulla scheda della linea in corso.
  Ora c'è una riga di stato — «Sta irrigando Sprinkler Line 5 · passata 2
  di 4», «Il terreno sta assorbendo · Line 1 riprende fra 12 min»,
  «Cambio linea · Line 2 apre fra 30 s» — col pulsante di arresto
  accanto. La frase è la stessa che compare sulla scheda dell'irrigazione
  in corso: due riquadri che descrivono lo stesso istante non possono
  raccontarlo in due modi diversi

## [1.3.0] - 2026-07-29

### Corretto
- **La lista segnava "in irrigazione" la linea sbagliata.** In cima si
  leggeva "Sprinkler Line 5, pausa di assorbimento" e nella lista sotto
  lampeggiava Line 1. Due cause: durante l'attesa venivano aggiornati
  l'identificativo della linea ma non il nome, quindi la scheda parlava
  di chi aveva appena finito e la lista di chi doveva ancora cominciare;
  e soprattutto **durante l'attesa nessuna valvola è aperta**, ma la
  lista continuava a marcare "in irrigazione" la prossima linea. Ora
  quello stato compare solo mentre l'acqua sta davvero uscendo, e nome,
  identificativo e numero di passata descrivono sempre la stessa linea

### Aggiunto
- **Conto alla rovescia dell'attesa**, con una barra che si svuota
  invece di riempirsi: è un tempo che scade, non un lavoro che avanza.
  Colore di terra per l'assorbimento — l'azzurro vuol dire "sta uscendo
  acqua" e qui è l'opposto — e ambra per il varco fra due linee. Il
  conto scorre di secondo in secondo, calcolato dalla pagina: aggiornarlo
  solo a ogni giro di rete lo farebbe scattare di tre secondi in tre
- **Avanzamento per ogni linea** nella lista: minuti d'acqua ricevuti sul
  totale, percentuale e a che passata è arrivata. Con le passate alternate
  una linea può essere a tre quarti e un'altra non aver ancora cominciato,
  e la scheda in cima parla solo di quella del momento. Verde quando ha
  finito, rossa se non è partita
- **Percentuale complessiva della sequenza** sulla scheda principale,
  contata sui minuti d'acqua di tutte le linee insieme, con quante linee
  sono concluse. "Sta irrigando la 5" non dice quanto manca alla fine:
  la 5 può essere alla prima passata di quattro

## [1.2.3] - 2026-07-29

### Corretto
- **"Pausa di assorbimento" e "pausa tra le linee" sembravano la stessa
  cosa.** Due nomi che si somigliano per due attese che non c'entrano
  niente: il varco fra due linee (5 min) serve alla pressione
  dell'impianto, l'assorbimento (30 min) serve al terreno e vale solo
  **fra due passate della stessa linea**. Chiamarli entrambi "pausa"
  faceva credere che l'impianto stesse fermo mezz'ora prima di passare
  alla linea successiva, mentre nel frattempo sta irrigando le altre
  - I due campi nelle impostazioni ora si chiamano *Assorbimento* e
    *Varco fra due linee*, e ognuno spiega a cosa serve
  - Durante l'attesa la scheda scrive «il terreno sta assorbendo,
    nessun'altra linea da irrigare» invece di «pausa di assorbimento»:
    quel momento arriva solo quando non c'è più niente da bagnare

## [1.2.2] - 2026-07-29

### Corretto
- **«7.5 min · 4 cicli» si leggeva come "7.5 minuti quattro volte".** Era
  il contrario: 7.5 minuti *in tutto*, spezzati in quattro passate da 1.9.
  Chi leggeva si aspettava mezz'ora d'acqua e ne riceveva un quarto — e
  non c'era modo di accorgersene dal badge. Ora dice «7.5 min in totale,
  4 passate», e la riga sotto scrive per esteso «4 passate da 1.9 min, 30
  min di assorbimento fra una e l'altra (riempiti irrigando le altre
  linee)» invece di un moltiplicatore che si poteva leggere al contrario

## [1.2.1] - 2026-07-29

### Corretto
- **La pagina saltava in cima a ogni aggiornamento.** Il ridisegno rifaceva
  l'intero pannello, distruggendo anche il contenitore che scorre: il
  browser non aveva più niente su cui tenere la posizione, e ogni trenta
  secondi — tre al secondo mentre l'irrigazione è in corso — si tornava
  in testa. Ora si ricostruisce solo ciò che è cambiato davvero:
  l'ossatura una volta sola, le schede quando cambiano, il corpo quando
  il suo contenuto è diverso da quello già a schermo. Un aggiornamento
  che non cambia niente non tocca più il DOM, quindi niente sfarfallio
  sugli interruttori, e la posizione viene comunque rimessa dov'era se
  il contenuto si accorcia

## [1.2.0] - 2026-07-28

### Modificato
- **Le passate si alternano fra le linee: dieci ore diventano due e
  mezza.** Un ciclo non è "irriga e aspetta", è *irriga* e poi lascia
  assorbire — e tenere la valvola ferma per quella mezz'ora è tempo
  buttato, perché nel frattempo può bagnare un'altra linea. Sei linee da
  quattro passate occupavano 610 minuti su una finestra di 240, con
  l'avviso di sforamento al 254%; ora sono 161 minuti, il 67%. È la
  funzione che i programmatori commerciali chiamano *cycle & soak*
  - L'esecutore usa **la stessa funzione** che disegna il programma in
    pagina: se irrigasse in un ordine suo, la pagina mostrerebbe una cosa
    e l'impianto ne farebbe un'altra
  - Il programma mostra la sequenza reale delle passate, richiudibile.
    Le righe delle linee ora si sovrappongono nel tempo, ed è giusto così
  - Il badge di ogni linea dice i **minuti d'acqua**, non l'occupazione
  - La barra di avanzamento conta i minuti d'acqua e non l'orologio:
    misurando il tempo reale segnerebbe il 100% quando la linea ha
    ricevuto un quarto dell'acqua
  - Una linea la cui valvola non conferma non riprova le passate rimaste:
    se non risponde adesso non risponderà fra dieci minuti

## [1.1.1] - 2026-07-28

### Corretto
- **«480 L/h → 10 mm/h» prometteva una conversione mai avvenuta.** I litri
  da soli non dicono quanto bagnano: serve la superficie. Senza, il motore
  ripiega sui mm/h del campo apposito e i litri non entrano in nessun
  conto — ma la riga della linea mostrava lo stesso la freccia, facendo
  credere che il numero a destra venisse da quello a sinistra. Ora, se la
  superficie manca, la riga scrive «480 L/h senza superficie: in uso 10
  mm/h» e compare un avviso che spiega cosa inserire. Con la superficie,
  la freccia dice anche su quanti metri quadri: «480 L/h su 12 m² → 40 mm/h»

## [1.1.0] - 2026-07-28

### Aggiunto
- **Card di Home Assistant accanto alla mappa.** La previsione meteo, una
  markdown col riassunto di quello che farà l'irrigazione, vento e
  pioggia dei prossimi giorni: si aggiungono dalla scheda Mappa, in
  modifica, scrivendo la stessa configurazione YAML che si userebbe in
  una dashboard. Non le disegna questo pannello — le costruisce il
  frontend di Home Assistant, quindi funziona qualunque card, comprese
  quelle installate da HACS. Una card scritta male diventa un avviso al
  posto suo e non porta via le altre
- **La mappa occupa tutta la larghezza della pagina.** Restava stretta
  nei 780 pixel buoni per una lista, che su una planimetria vuol dire
  non distinguere le aree. Ora la scheda Mappa si allarga e le card
  stanno a fianco; sotto i 1000 pixel la colonna scende sotto la mappa
  invece di stringerla a un francobollo

## [1.0.1] - 2026-07-28

### Aggiunto
- **Il pannello si accorge se manca il riavvio.** Aggiornando da HACS i
  file cambiano su disco e il browser rilegge subito il JavaScript nuovo,
  ma il Python resta quello già caricato in memoria: ricaricare
  l'integration non basta, perché il modulo non viene riletto. La pagina
  chiedeva quindi funzioni che il server non aveva ancora, e la risposta
  era un «non trovato» che non spiegava niente — è successo con il
  caricamento dell'immagine della mappa. Ora la pagina confronta la
  propria versione con quella dell'integration in esecuzione e, se
  differiscono, lo scrive in cima: *riavvia Home Assistant*
- `scripts/bump.py` allinea da sé la versione dichiarata dal pannello,
  così le due non possono divergere per una dimenticanza

### Modificato
- **L'area della mappa prende il nome dalla linea collegata.** Le aree
  nuove non si chiamano più "Area 3": senza un nome proprio mostrano
  quello della linea, come già fanno con l'icona. Chiamare "Area 3" il
  pezzo di prato che si chiama "Prato Sud" costringeva a ribattere lo
  stesso nome e a tenerlo allineato a mano. Un nome scritto a mano
  continua ad avere la precedenza

## [1.0.0] - 2026-07-28

### Aggiunto
- **Mappa del giardino.** Nuova scheda con la planimetria — una foto
  aerea, un disegno, uno screenshot di una mappa — e sopra le aree
  irrigate, disegnate a mano. Ogni area prende il colore dal bilancio
  idrico della sua linea: trasparente se sta bene, gialla se chiede
  acqua, rossa in carenza forte, azzurra pulsante mentre irriga. È la
  risposta a colpo d'occhio a una domanda che le liste rendono faticosa:
  *dove* manca acqua
  - Toccare un'area, o la sua icona, fa partire l'irrigazione di quella
    linea. Vale anche il poligono e non solo l'icona: su un telefono
    centrare un'icona è più difficile che toccare il prato
  - Le aree si disegnano posando i vertici sull'immagine, si correggono
    trascinando le maniglie, si allargano dai punti a metà lato e si
    spostano tutte insieme trascinandone l'interno. Possono
    sovrapporsi: l'ordine di disegno decide chi sta sopra
  - Di ogni area si scelgono nome, linea collegata, colore del bordo,
    icona e suo colore, e un'entità da mostrare sotto l'icona. Il
    riempimento no: quello lo dice il bilancio idrico, ed è tutto il
    motivo per cui la pagina esiste
  - L'immagine si carica dal pannello e viene conservata **intera**. Non
    passa da `image_upload` di Home Assistant, che serve solo miniature
    quadrate da 512 pixel: una planimetria ritagliata a quadrato non si
    legge più. In alternativa si può indicare un indirizzo, per chi il
    file ce l'ha già in `www/`
  - Le coordinate sono normalizzate sui lati dell'immagine: la stessa
    mappa regge telefono e desktop, e cambiare planimetria con una a
    risoluzione diversa non butta via il disegno
  - Dalla barra in alto si avvia l'irrigazione di tutte le aree

## [0.9.4] - 2026-07-28

### Aggiunto
- **Il bilancio idrico si aggiorna durante la giornata, non solo a
  mezzanotte.** Con 30 gradi il prato consuma acqua dalla mattina, ma il
  deficit restava a 0.0 mm fino allo scoccare della mezzanotte: la
  pagina mostrava il falso proprio nelle ore in cui si decide se
  irrigare, e l'impianto partiva con un giorno di ritardo. Ora a ogni
  ciclo del coordinator (ogni 10 minuti) viene addebitata la quota di
  ET0 già maturata, distribuita sulla curva della radiazione fra alba e
  tramonto. La chiusura di mezzanotte resta e ricalcola l'ET0
  definitiva sui dati misurati, addebitando solo il residuo: nessun
  doppio conteggio
- Finché la giornata è in corso la stima usa gli estremi di temperatura
  previsti, se più larghi di quelli già osservati. A metà mattina il
  massimo del giorno non è ancora arrivato, e usare la sola escursione
  vista finora azzerava l'ET0 proprio nelle ore utili
- La scheda *Bilancio idrico* mostra l'ET0 maturata oggi (prima mostrava
  solo quella dell'ultimo giorno chiuso, cioè "nessuna" al primo avvio),
  e il sensore ET0 la espone come attributo `et0_maturata_oggi_mm`

### Corretto
- **"Prossima irrigazione oggi alle 15:07", e alle 15:07 non parte
  niente.** L'avvio automatico è uno al giorno per gruppo, ma il conto
  della prossima partenza non ne teneva conto: un gruppo già partito la
  mattina continuava a promettere l'orario di oggi, per poi saltare a
  domani nel momento esatto in cui sarebbe dovuto partire — senza che
  nessuna valvola si aprisse. Ora la partenza già consumata è considerata
  anche nel calcolo, e la pagina lo scrive ("mercoledì alle 15:07, oggi è
  già partita") invece di far sparire l'orario di nascosto
- **Spostare la finestra non aveva effetto fino al giorno dopo** se il
  gruppo era già partito. Cambiare orario, giorni o avvio automatico
  rimette in gioco la giornata in corso: il nuovo orario vale da subito

## [0.9.3] - 2026-07-28

### Corretto
- **"Prossima irrigazione mercoledì" con la finestra che apriva fra sei
  minuti.** Correggendo il programmatore nella 0.9.2 avevo fatto partire
  la ricerca dal giorno *successivo*, così il caso "l'orario di oggi deve
  ancora arrivare" non veniva più considerato e si saltava sempre a
  domani. Ora oggi torna in gioco
- **Il programma scartava in silenzio le linee che non entravano nella
  finestra**, e lo stato vuoto dava la colpa al bilancio idrico: una
  finestra di 14 minuti con una linea da 15 mostrava "nessuna irrigazione
  necessaria" mentre la linea, poco sopra, diceva "15 min". L'esecutore
  intanto quella linea l'avrebbe irrigata comunque, perché la finestra
  stabilisce quando l'irrigazione può *cominciare*, non quanto può durare.
  Ora il programma mostra ciò che accadrà davvero e, se l'irrigazione
  supera la finestra, lo dichiara invece di far sparire la linea
- Quando una linea non è in programma per un motivo diverso dal bilancio
  idrico (vento, pioggia prevista, giorno escluso), il motivo è scritto
  linea per linea
- La dashboard non mostra più la finestra di sistema 04:00–08:00, che non
  esiste più da quando ogni gruppo ha la propria

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
