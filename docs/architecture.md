# Architettura — Quaderni v0.1 (M1)

## 1. Decisione: formato file

**Scelta: opzione A — estensione custom `.quaderno` con contenuto JSON versionato**, aperta da una `FileView` registrata con `registerExtensions(['quaderno'])`.

Motivi, in ordine di peso per M1 (affidabilità dei dati prima di tutto):

1. **Nessun altro scrive nel file.** Un `.md` (opzioni B e C) viene toccato da Obsidian e da altri plugin: Linter, Templater, aggiornamento automatico dei link alla rinomina, modifiche al frontmatter, editor Markdown aperto per sbaglio. Ognuno di questi può corrompere un blocco dati di grandi dimensioni. Con un'estensione propria il file è scritto solo da Quaderni.
2. **Nessuna patch del workspace.** Per B serve intercettare `WorkspaceLeaf.setViewState` (come fa Excalidraw con monkey-around): codice fragile tra versioni di Obsidian e con le tab "deferred" della 1.7.2+. `registerExtensions` è un'API pubblica.
3. **Nessun costo di indicizzazione.** Un `.md` con migliaia di punti viene indicizzato da ricerca e metadata cache a ogni salvataggio; su Android è un costo reale.
4. **I vantaggi di B/C (link, tag, backlink, Graph) sono M4.** Il formato è progettato per arrivarci senza riscrivere i dati (vedi §5).

Costi accettati e documentati:
- Ricerca, tag e backlink nativi non vedono i quaderni (fino a M4).
- **Obsidian Sync** sincronizza le estensioni sconosciute solo con l'opzione "Sincronizza tutti gli altri tipi di file" attiva (indicato nel README). Syncthing e la copia via USB non hanno limiti.

## 2. Schema JSON v1

```json
{
  "format": "quaderni",
  "version": 1,
  "id": "6f1c…",
  "createdAt": "2026-10-29T14:30:00.000Z",
  "modifiedAt": "2026-10-29T14:42:10.000Z",
  "pages": [
    {
      "id": "a91e…",
      "width": 595.28,
      "height": 841.89,
      "paper": { "kind": "grid", "spacing": 14.17 },
      "strokes": [
        { "id": "c03d…", "tool": "pen", "color": "#1e293b", "width": 2,
          "points": [[72.5, 90.12, 0.512], [73.1, 90.4, 0.534]] }
      ]
    }
  ]
}
```

| Campo | Regola |
|---|---|
| `format` | sempre `"quaderni"`: distingue il file da un JSON qualsiasi |
| `version` | intero. Versione più alta di quella supportata → il file si apre **in sola lettura** con avviso e non viene mai riscritto |
| unità | **punti tipografici (pt, 1/72 di pollice)**, origine in alto a sinistra della pagina. A4 = 595.28 × 841.89 pt. Scelti perché sono l'unità nativa del PDF (export M3) e indipendenti dallo schermo |
| `paper` | M1: solo `grid` con `spacing` in pt (5 mm = 14.17 pt). M3 aggiunge altri `kind` |
| `points` | `[x, y, pressione]`, x/y arrotondati a 0.01 pt, pressione in [0, 1] arrotondata a 0.001. **La pressione salvata è quella effettivamente usata**: se il dispositivo non la fornisce, viene scritta quella simulata dalla velocità. Il rendering è quindi deterministico |
| `tool` | M1: solo `"pen"`. La gomma non produce tratti |
| `color` | `#rrggbb` |
| `width` | diametro nominale in pt, > 0 |
| `id` | stringhe uniche (UUID quando disponibile) |

Campi sconosciuti vengono ignorati in lettura. Ogni cambio di schema incrementa `version` e aggiunge una migrazione testata (`src/model/migrations.ts`). Esiste una migrazione v0 → v1 da un formato di prova senza versione (`{ strokes: [{ points: [{x, y, p}], color, size }] }`), che serve a fissare il meccanismo.

**Parametri di rendering della penna v1** (perfect-freehand): `size = width`, `thinning 0.6`, `smoothing 0.5`, `streamline 0.35`, `simulatePressure false`, cap arrotondati. Sono costanti di codice: se M2 li rende configurabili per tratto, servirà la v2 dello schema con migrazione che assegna i valori v1 ai tratti esistenti.

## 3. Moduli

```
src/
  main.ts                 plugin: vista, estensione, ribbon, comandi, impostazioni, flush su unload
  settings.ts             tipi e default delle impostazioni
  model/                  (non importa 'obsidian')
    types.ts              Document, Page, Stroke, costanti A4
    document.ts           creazione documento/pagina/tratto, id, quantizzazione
    serialize.ts          serialize() deterministico + parse() con validazione e migrazioni
    migrations.ts         catena di migrazioni vN → vN+1
    history.ts            undo/redo a stack di comandi (AddStroke, EraseStrokes)
  ink/                    (non importa 'obsidian')
    viewport.ts           trasformazione schermo ↔ pagina, fit-width, zoom attorno a un punto, pan
    pressure.ts           rilevamento pressione reale vs costante, pressione simulata dalla velocità
    input-policy.ts       instradamento pen/touch/mouse e palm rejection (logica pura)
    hit-test.ts           gomma a tratto intero (distanza segmento-segmento + bounding box)
    stroke-shape.ts       perfect-freehand → path SVG (puro, testabile)
    renderer.ts           due canvas (statico + live), DPR, cache Path2D, rAF
    pointer-controller.ts Pointer Events: coalesced/predicted, capture, pan e pinch
  storage/
    session.ts            ciclo di vita del documento: load, dirty, debounce, flush, conflitti (puro, testabile)
    vault-io.ts           adattatore Vault API (read, process, backup)
    notebooks.ts          creazione di un quaderno nella cartella configurata
  view/
    notebook-view.ts      FileView: monta canvas e toolbar, collega sessione, history e input
    toolbar.ts            penna, gomma, colori, spessori, undo/redo, adatta alla larghezza
    modals.ts             "Nuovo quaderno" (nome) e "Apri quaderni" (ricerca fuzzy)
tests/                    vitest su model/, ink/ e storage/session.ts
```

## 4. Flusso di salvataggio (regola 4: zero perdita dati)

Stato della sessione: `doc`, `revision` (incrementata a ogni modifica), `savedRevision`, `diskContent` (ultimo contenuto letto o scritto da noi), `mode` = `ok` | `readonly` (versione futura) | `broken` (illeggibile).

**Apertura**
1. `vault.read(file)` → `parse()`.
2. Successo → `mode = ok`, eventuale migrazione in memoria (il file migrato si riscrive solo alla prima modifica).
3. Fallimento (JSON non valido, schema non valido, file vuoto) → `mode = broken`; versione futura → `mode = readonly`. In entrambi i casi: **si crea un backup** del contenuto grezzo in `<cartella quaderni>/_backup/<nome> <data-ora> <motivo> <hash>.bak` (niente duplicati: l'hash del contenuto è nel nome), la vista mostra un messaggio e **nessun percorso di scrittura è attivo**.

**Modifica** → `revision++` → salvataggio programmato: debounce 1,5 s dall'ultima modifica, al massimo 10 s di attesa durante la scrittura continua.

**Flush** (debounce, chiusura vista `onUnloadFile`/`onClose`, `onunload` del plugin, `visibilitychange` → hidden, `pagehide`, `workspace 'quit'` best effort):
1. Se `mode ≠ ok` o non ci sono modifiche → niente.
2. `next = serialize(doc)`; **ri-validazione**: `parse(next)` deve riuscire e `serialize(parse(next)) === next`. Se fallisce: niente scrittura, avviso, modifiche tenute in memoria.
3. `vault.process(file, current => …)` (atomico): se `current ≠ diskContent` il file è cambiato fuori da noi (Sync, altro dispositivo) → il contenuto `current` viene conservato e salvato come backup `conflitto` subito dopo la scrittura, e l'utente viene avvisato.
4. `diskContent = next`, `savedRevision = revision` catturata al punto 2. I flush sono serializzati (mai due scritture in parallelo); modifiche arrivate durante un flush ne programmano un altro.

**Modifica esterna** (`vault.on('modify')` sul file aperto): se il contenuto coincide con `diskContent` è l'eco della nostra scrittura → ignorato. Altrimenti, senza modifiche locali pendenti → ricarica il documento (se illeggibile → `broken` + backup, senza sovrascrivere); con modifiche pendenti → si tengono le nostre e al flush il contenuto esterno finisce nel backup `conflitto`.

**Tratto in corso**: su `visibilitychange`/`pagehide`/`pointercancel` il tratto in corso viene chiuso e salvato come tratto normale prima del flush, così l'uscita dall'app durante la scrittura non lo perde.

Limite noto: se Android uccide il processo senza notificare `visibilitychange`, si perdono al massimo le modifiche degli ultimi ~1,5 s (o 10 s durante una scrittura continua). La chiusura dalle app recenti passa prima dallo stato "in background", quindi il flush avviene; va verificato su hardware.

## 5. Evoluzione del formato (verso M4)

- **C (ibrido)**: un comando genererà un `.md` companion (titolo, tag, link, testo OCR) accanto al `.quaderno`; il JSON non cambia.
- **B (`.md` con blocco dati)**: se si sceglierà B, la migrazione sarà una conversione file → file: il JSON v1 diventa il contenuto di un blocco di codice, con `format`/`version` invariati. Il parser resta lo stesso.
- Molte pagine: se un unico JSON diventa troppo grande (M2, 10.000+ tratti), la v2 potrà dividere le pagine; `version` permette la migrazione.

## 6. Input e rendering

- `touch-action: none` sul contenitore; `pointerType` distingue `pen`/`touch`/`mouse`.
- **Palm rejection base**: se la penna è attiva o è stata vista (anche in hover) negli ultimi N ms (default 500, configurabile), il tocco non disegna e fa solo pan (un dito) o zoom (due dita). La modalità "scrivi con il dito" è un'impostazione (default off). Se la penna tocca mentre un dito sta disegnando, il tratto del dito viene scartato.
- `getCoalescedEvents()` per ogni `pointermove`; `getPredictedEvents()` opzionale (impostazione) e disegnato **solo** sul layer live, mai salvato.
- Pressione: per la penna si usa quella reale solo dopo aver visto almeno 3 valori distinti in (0, 1) diversi da 0,5; altrimenti, e sempre per mouse e dito, si usa la pressione simulata dalla velocità (media esponenziale). Impostazione "pressione sempre simulata".
- Due canvas sovrapposti, dimensionati sulla vista × `devicePixelRatio`: **statico** (carta, quadretti, tratti salvati, ridisegnato solo quando cambia il documento o la vista; un nuovo tratto viene aggiunto senza ridisegnare tutto) e **live** (tratto in corso + predizione, ridisegnato con `requestAnimationFrame`). I `Path2D` dei tratti sono in coordinate pagina e messi in cache per id.
- Zoom iniziale: adattato alla larghezza della vista; ricalcolato su resize/rotazione finché l'utente non zooma. Pinch, rotella e Ctrl+rotella sono una versione base (lo zoom fluido è M2).
- Gomma a tratto intero: raggio 10 px schermo convertiti in pt; si testa il segmento percorso dalla gomma tra due eventi contro i segmenti del tratto (con mezza larghezza del tratto), con prefiltro per bounding box. Tutti i tratti cancellati in un gesto formano un solo comando di undo.

## 7. Undo/redo

Stack di comandi, non snapshot: `AddStroke { pageId, stroke, index }` e `EraseStrokes { pageId, items: [{ stroke, index }] }`. Ogni comando sa applicarsi e annullarsi; un nuovo comando svuota il redo; massimo 500 comandi. La cronologia vive in memoria (non è salvata nel file) e si azzera alla riapertura o al ricaricamento da modifica esterna.
