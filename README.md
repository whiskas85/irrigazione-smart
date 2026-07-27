# Irrigazione Smart

[![Validate](https://github.com/whiskas85/irrigazione-smart/actions/workflows/validate.yml/badge.svg)](https://github.com/whiskas85/irrigazione-smart/actions/workflows/validate.yml)
[![hacs](https://img.shields.io/badge/HACS-custom-41BDF5.svg)](https://hacs.xyz)

Integration per Home Assistant che sostituisce i timer a durata fissa con un
**bilancio idrico reale**. Calcola quanta acqua ha perso il terreno per
evapotraspirazione, quanta gliene ha restituita la pioggia, e irriga solo
quando serve — per il tempo che serve.

> **Stato: scaffold (v0.1.0).** Il motore di calcolo è completo e
> verificabile. L'integration si installa e si configura, ma non crea
> ancora entità. Vedi la [roadmap](SPEC.md#11-roadmap).

## Perché

Un timer che irriga 20 minuti ogni due giorni sbaglia due volte: spreca
acqua nelle settimane piovose e lascia il prato in stress durante le
ondate di calore. E irrigare poco e spesso è peggio che non irrigare:
mantiene le radici in superficie, dove alla prima canicola si cuociono.

Questa integration applica il modello FAO-56 usato dai controller
professionali:

```
Deficit(oggi) = Deficit(ieri) + ET0 × Kc − Pioggia_efficace
```

Si irriga quando il deficit accumulato supera la riserva utile del
terreno, non quando lo dice il calendario.

## Caratteristiche

- **Zone dinamiche** — create e rimosse a runtime, nessun limite
- **Ereditarietà a tre livelli** — Sistema → Preset tipo zona → Zona.
  Imposti un default una volta e lo sovrascrivi solo dove serve
- **Due modelli ET0** — Penman-Monteith FAO-56 se hai sensori di umidità
  e vento, Hargreaves-Samani altrimenti. La scelta è automatica
- **Sensori locali con fallback** — ogni grandezza usa il sensore in
  giardino se c'è, il servizio meteo se manca, e dichiara quale sta usando
- **Cycle & soak** — se l'impianto eroga più in fretta di quanto il terreno
  assorba, l'irrigazione si spezza in passate con pause di assorbimento
- **Prati e aiuole insieme** — preset separati per tappeto erboso,
  arbusti, fioriere e orto, ognuno col suo terreno e la sua profondità
  radicale
- **Finestra oraria con parere agronomico** — configurabile liberamente,
  ma il sistema ti dice cosa stai barattando
- **Tetto massimo di durata** — opzionale, e il deficit non coperto resta
  a bilancio invece di sparire

## Installazione via HACS

Il repository non è nel catalogo predefinito: va aggiunto come
**repository personalizzato**.

1. In Home Assistant apri **HACS**
2. Menu **⋮** in alto a destra → **Repository personalizzati**
3. Incolla `https://github.com/whiskas85/irrigazione-smart`
4. Categoria: **Integration**
5. **Aggiungi**, poi cerca *Irrigazione Smart* e installa
6. **Riavvia Home Assistant**
7. **Impostazioni → Dispositivi e servizi → Aggiungi integrazione** →
   *Irrigazione Smart*

### Installazione manuale

Copia `custom_components/irrigazione_smart/` in `/config/custom_components/`
e riavvia.

## Configurazione

Al primo avvio servono posizione e quota (precompilate da quelle di Home
Assistant) e almeno una fonte dati.

I sensori locali sono tutti opzionali. Il selettore li filtra per
`device_class`, quindi nell'elenco compaiono solo entità compatibili:

| Campo | `device_class` richiesta |
|---|---|
| Temperatura | `temperature` |
| Umidità | `humidity` |
| Vento | `wind_speed` |
| Pluviometro | `precipitation` |
| Irraggiamento | `irradiance` |

Dove manca il sensore si usa l'entità `weather.*` indicata come fallback.

> I sensori devono avere `state_class: measurement`, altrimenti Home
> Assistant non ne registra le statistiche a lungo termine e il calcolo
> di Tmin/Tmax giornaliere non funziona.

## Provare il motore di calcolo

Non serve Home Assistant: `hydro.py` non ha dipendenze.

```bash
python custom_components/irrigazione_smart/hydro.py
```

Stampa il confronto tra i metodi ET0, una simulazione di dieci giorni su
due zone con terreni diversi, e la diagnostica di capienza della finestra
oraria.

## Calibrazione

Prima di fidarsi dei numeri servono due misure sul campo.

**Portata di ogni linea.** Cinque o sei barattoli distribuiti sulla zona,
quindici minuti di irrigazione, media dei millimetri raccolti × 4. È
l'unico dato che il sistema non può stimare: senza, le durate sono
arbitrarie.

**Profondità radicale.** Dopo un'irrigazione, infila un cacciavite lungo
nel terreno: si ferma dove il suolo è asciutto. Se si ferma a 8 cm mentre
hai configurato 20, il modello sta sovrastimando la riserva.

Il primo mese è taratura: confronta quello che il sistema propone con
quello che l'occhio dice del prato e correggi il *correttore* di zona.
Non toccare Kc e MAD finché la portata non è verificata.

## Sviluppo

```bash
# rilascio
python scripts/bump.py patch     # o minor / major / X.Y.Z
git push && git push --tags
```

Il tag git e il campo `version` del manifest devono restare allineati:
HACS legge i tag per sapere cosa è disponibile e il manifest per sapere
cosa è installato. La GitHub Action di release blocca il push se
divergono.

L'architettura completa è in **[SPEC.md](SPEC.md)**.

## Crediti

Il modello di bilancio idrico segue la FAO Irrigation and Drainage Paper
56 (Allen et al., 1998). L'architettura a zone dinamiche con pannello
dedicato si ispira a [Alarmo](https://github.com/nielsfaber/alarmo).

## Licenza

MIT
