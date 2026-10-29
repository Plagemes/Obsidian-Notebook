# Ricerca — progetti di riferimento e API Obsidian

Data: 2026-10-29. Fonti: README, LICENSE e file chiave dei repository; `obsidian.d.ts` del pacchetto `obsidian@1.14.4`; docs.obsidian.md. Nessun codice esterno è stato copiato nel repo.

## Matrice comparativa

| Repo | Licenza | Riuso in MIT | Pennino / pressione / palm rejection | Modello dati e formato su disco | Cosa riusiamo |
|---|---|---|---|---|---|
| obsidianmd/obsidian-sample-plugin | 0-BSD | Sì, senza vincoli | — | `manifest.json`, `main.js` (CJS), `styles.css` | **Struttura e build**: esbuild (CJS, `external` obsidian/electron/codemirror/lezer/builtin di Node), tsconfig strict. Adattato, non copiato alla lettera. |
| zsviczian/obsidian-excalidraw-plugin | AGPL-3.0 | **No** per il codice (copyleft di rete). Solo idee riscritte da zero. | Delegato alla libreria Excalidraw; il plugin passa solo `penMode`. In pen mode il dito fa pan. Nessuna palm rejection per area/pressione. Issue aperte su ergonomia S Pen e mano appoggiata. | `.excalidraw.md`: frontmatter `excalidraw-plugin: parsed`, sezione testo ricercabile, JSON della scena in blocco ```compressed-json``` (LZ-String). Apertura intercettata con `around(WorkspaceLeaf.prototype, {setViewState})` (monkey-around). Vista `TextFileView`, autosave 30 s mobile / 60 s desktop, backup in cache con prompt di ripristino se la scena si carica vuota. | **Idee**: coordinatore di salvataggio con flag dirty e flush su unload; backup e ripristino; formato `.md` ibrido come possibile evoluzione M4. **Lezione negativa**: patch del workspace fragile, file grandi indicizzati, cronologia che gonfia Sync (#958). |
| ellimist-afk/handwriting | CC BY-NC-ND 4.0 | **No** (vieta uso commerciale e opere derivate) | Router dei pointer per dispositivo (penna disegna, touch pan/pinch, mouse off di default), calibrazione pressione, "palm gate", wet canvas + commit su pen-up, predizione. | Sidecar JSON `.handwriting/<id>.json` per nota; scrittura `.tmp` + rename; `schemaVersion` come primo campo; versioni future in sola lettura; campi sconosciuti preservati; coordinate in px CSS a zoom 1. | **Solo idee**, riscritte da zero: sola lettura per versioni future, preservare campi sconosciuti, layer "wet" separato. Attivo (push 2026-10-28). |
| steveruizok/perfect-freehand | MIT | **Sì, come dipendenza** (v1.2.3, zero dipendenze) | Input `[x, y, pressure]`; `simulatePressure` (default true) per dispositivi senza pressione. | Nessuno: `getStroke(points, options) → [x, y][]` (poligono di contorno). | **Dipendenza** per la forma dei tratti. Ricalcola tutto il contorno a ogni chiamata: per il tratto live va bene (tratti di scrittura corti), per i tratti salvati si mette in cache il `Path2D`. |
| saber-notes/saber | GPL-3.0 | **No** per il codice. Solo idee. Flutter/Dart. | Distingue stylus da resto; pressione normalizzata su min/max del dispositivo, `null` se non disponibile; nessuna vera palm rejection: dopo il primo stylus disattiva il disegno col dito; pulsante dello stylus come evento a parte. | `.sbn2` (BSON), versione intera `v` (oggi 19), migrazioni a catena `if (v < N)`, file più nuovi in sola lettura, file corrotti mostrati come segnaposto. Alla chiusura del tratto la pressione simulata viene scritta nei punti. | **Idee**: versione intera + migrazioni a catena; sola lettura per versioni future; scrivere nei punti la pressione simulata (rendering deterministico). |
| LinwoodDev/Butterfly | AGPL-3.0 (app), Apache-2.0 (`api/`), CC-BY-SA (immagini/docs) | **No** per l'app; `api/` compatibile ma in Dart, non serve. | Mappatura configurabile sorgente→azione (penna, penna invertita, pulsanti, tocco); modalità "solo penna"; modalità di pressione (ignora primo tratto / tutti / nessuno). | `.bfly` = zip con manifest, `pages/{i}.{nome}.json`, asset con nome = hash. `PenElement { points: PathPoint(x,y,pressure), property }`. | **Idee**: una pagina per voce (utile quando le pagine saranno tante), asset per hash (M3), mappatura configurabile degli input (M2). |
| mozilla/pdf.js | Apache-2.0 | Sì (attribuzione/NOTICE) | — | — | **Niente in M1.** Per M3 usare `loadPdfJs(): Promise<any>` di Obsidian (presente in `obsidian.d.ts` 1.14.4) prima di valutare `pdfjs-dist`. |

## API Obsidian verificate (`obsidian.d.ts` 1.14.4)

- `registerView(type, (leaf) => View)` e `registerExtensions(['quaderno'], type)` (estensioni senza punto).
- `FileView` (`file: TFile | null`, `allowNoFile`, `onLoadFile(file)`, `onUnloadFile(file)`, `getDisplayText()`, `canAcceptExtension(ext)`). `TextFileView` aggiunge `data`, `requestSave` (debounce di 2 s documentato, logica interna non ispezionabile), `save()`, `getViewData()`/`setViewData(data, clear)`; il ricaricamento su modifica esterna non è documentato nel `.d.ts`.
- `vault.create`, `vault.createFolder` (lancia se esiste), `vault.read` (da usare per read-modify-write, non `cachedRead`), `vault.modify`, `vault.process(file, fn)` (atomico, `fn` sincrona, dalla 1.1.0), `vault.getFileByPath`/`getFolderByPath` (dalla 1.5.7), `normalizePath`, `vault.on('modify' | 'delete' | 'rename')`.
- `Platform.isMobile`, `Platform.isAndroidApp`; `addRibbonIcon`, `addCommand`, `PluginSettingTab`, `loadData`/`saveData`, `registerDomEvent`, `registerEvent`.
- Dalla 1.7.2 le tab sono "deferred": `leaf.view` può non essere ancora istanziata.
- `workspace.on('quit')` è "best effort" e non affidabile su mobile: il salvataggio non può contare su di esso → flush su `visibilitychange` (hidden) e `pagehide`.
- Mobile: nessun modulo Node/Electron (crash), regex lookbehind solo iOS ≥ 16.4, debug Android con `chrome://inspect`.

## Conseguenze per M1

1. **Vista**: `FileView` (non `TextFileView`) per avere il controllo completo del salvataggio: serializza → ri-valida → scrive con `vault.process`, e non scrive mai se il file non era leggibile. `TextFileView` scriverebbe quello che restituisce `getViewData()` con una logica interna non verificabile.
2. **Forma dei tratti**: perfect-freehand come unica dipendenza runtime (MIT).
3. **Formato**: JSON versionato con estensione custom (vedi `docs/architecture.md`).
4. **Licenze**: nessun codice GPL/AGPL/CC-NC copiato. Le idee prese da Excalidraw, Handwriting, Saber e Butterfly sono state reimplementate da zero.
