# Changelog

Il formato segue [Keep a Changelog](https://keepachangelog.com/it/1.1.0/)
e il progetto usa [Semantic Versioning](https://semver.org/lang/it/).

Le nuove voci vanno scritte sotto la sezione *Unreleased*. Al momento del
rilascio, `scripts/bump.py` le promuove alla nuova versione con la data.

## [Unreleased]

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
