/*
 * Icona di Garden Assistant per la barra laterale di Home Assistant.
 *
 * La sidebar disegna `<ha-icon>`, che accetta solo icone note: mdi, o un
 * insieme registrato a mano. Un `<img>` col nostro logo non si può
 * mettere, e comunque sarebbe sbagliato — resterebbe azzurro anche
 * quando tutte le altre voci sono grigie, e diventerebbe una macchia di
 * colore su una voce come le altre.
 *
 * Registrando invece il tracciato SVG, l'icona si colora da sola come le
 * sorelle: grigia a riposo, del colore d'accento quando la voce è
 * quella aperta.
 *
 * Questo file viene caricato su *ogni* pagina del frontend (serve prima
 * che il pannello sia aperto, perché la barra laterale c'è comunque):
 * per questo non fa altro che dichiarare un oggetto e uscire.
 */

const ICONE = {
  // La casetta del marchio, col getto dell'irrigatore dentro: sagoma
  // piena col foro (regola evenodd sul verso dei sottotracciati), lo
  // stelo dell'irrigatore, i due ciuffi d'erba e la nuvola di gocce.
  assistant:
    // sagoma della casa, con il foro dentro (il verso opposto del
    // secondo tracciato è ciò che lo rende un contorno e non un blocco)
    "M12 2 2.6 9.4V21a1 1 0 0 0 1 1h16.8a1 1 0 0 0 1-1V9.4L12 2Zm0 2.6 " +
    "7.4 5.8V20H4.6v-9.6L12 4.6Z" +
    // irrigatore: piede, stelo e testa, al centro della casa
    "M9.6 19.4h4.8V21H9.6v-1.6Z" +
    "M11.1 13.6h1.8v5.2h-1.8v-5.2Z" +
    "M9.9 12h4.2v1.6H9.9V12Z" +
    // il getto: tre gocce per lato, grandi abbastanza da vedersi anche
    // a ventiquattro pixel
    "M12 6.5a.85.85 0 1 1 0 1.7.85.85 0 0 1 0-1.7Z" +
    "M8.9 7.5a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6Z" +
    "M15.1 7.5a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6Z" +
    "M6.7 9.6a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Z" +
    "M17.3 9.6a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Z",
};

window.customIconsets = window.customIconsets || {};
window.customIconsets.garden = (nome) =>
  ICONE[nome] ? Promise.resolve({ path: ICONE[nome] }) : Promise.resolve(null);
