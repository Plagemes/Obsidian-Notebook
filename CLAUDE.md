# Quaderni — plugin Obsidian per appunti a mano

## Cos'è
Plugin Obsidian open source (MIT), local-first, che aggiunge la sezione "Quaderni": appunti scritti a mano col pennino, con un'esperienza da app premium (Samsung Notes / Goodnotes / Notewise).
Priorità assoluta: **Android + pennino (S Pen)**. Secondario: Windows.
Visione completa e roadmap: `docs/spec.md`. Non anticipare fasi future senza richiesta.

## Stack
- TypeScript + esbuild, partendo dalla struttura di `obsidian-sample-plugin`.
- `manifest.json`: `"isDesktopOnly": false`.
- Rendering: Canvas 2D. Forma dei tratti: perfect-freehand (MIT), salvo alternativa motivata in `docs/architecture.md`.
- Test: vitest per la logica pura.

## Regole non negoziabili
1. **Mai moduli Node/Electron** (`fs`, `path`, `electron`, `child_process`, `require` dinamici) nel codice runtime: il plugin gira nel WebView Android. File solo tramite `app.vault` / `app.fileManager`.
2. **Tratti sempre vettoriali**: punti `[x, y, pressione]` in coordinate pagina (mai schermo) + stile (strumento, colore, spessore). Mai solo raster.
3. **Formato documento versionato**: campo `version`; ogni cambio di schema ha una funzione di migrazione testata.
4. **Zero perdita dati**: salvataggio debounced, più flush su chiusura vista, `onunload`, `visibilitychange`/`pagehide`. Prima di sovrascrivere si serializza e si ri-valida; i file illeggibili non vengono mai sovrascritti e viene conservata una copia di backup.
5. **Nessun cloud obbligatorio**, nessuna telemetria.
6. **Licenze**: prima di copiare o adattare codice esterno, verifica la licenza e annotala in `docs/research.md`. Niente codice GPL/AGPL nel repo.
7. **Niente AI** finché scrittura e persistenza non sono stabili (vedi roadmap).
8. **Niente UI decorativa**: ogni controllo visibile funziona.
9. **Onestà sullo stato**: non dichiarare completata una funzione non verificata. Non puoi testare su hardware Android: non simulare quei risultati.

## Architettura
```
src/
  main.ts        registrazione plugin, comandi, ribbon, settings
  view/          vista Obsidian, toolbar, UI
  ink/           input (Pointer Events), engine tratti, rendering   ← NON importa 'obsidian'
  model/         tipi documento, (de)serializzazione, migrazioni, undo/redo ← NON importa 'obsidian'
  storage/       lettura/scrittura tramite Vault API
tests/           vitest su ink/ e model/
```
`ink/` e `model/` devono essere testabili in Node senza Obsidian.

## Note tecniche sull'input
- `touch-action: none` sul canvas; distinguere con `pointerType` (`pen` / `touch` / `mouse`).
- `getCoalescedEvents()` per la densità dei punti; `getPredictedEvents()` opzionale per ridurre la latenza percepita.
- Palm rejection base: se il pen è attivo o è stato usato negli ultimi N ms, il touch non disegna e fa solo pan/zoom. Rendere N e la modalità "scrivi con il dito" configurabili.
- Pressione: alcuni dispositivi riportano un valore costante (0.5 o 0) → fallback sulla pressione simulata in base alla velocità.
- Due layer: canvas statico (tratti salvati) e canvas live (tratto in corso). Ridisegnare il layer statico solo quando cambia. Usare `requestAnimationFrame` e tenere conto del `devicePixelRatio`.

## Stato delle funzioni
`docs/testing.md` contiene una tabella per ogni funzione con queste colonne: implementata · test automatico · verificata su hardware · sperimentale · da fare.
La colonna "verificata su hardware" la compila solo l'utente.

## Workflow
- Commit piccoli con messaggi chiari.
- Un task è finito solo se `npm run build`, `npm run lint` e `npm test` passano.
- Aggiorna `CHANGELOG.md` e `docs/` quando cambiano l'architettura o il formato.
- Subagenti solo per lavoro indipendente (ricerca, review). Due agenti non modificano mai lo stesso file.

## Comandi
- `npm run dev` — build in watch
- `npm run build` — build di produzione (`main.js`, `manifest.json`, `styles.css`)
- `npm test` — vitest
- `npm run lint` — eslint + tsc --noEmit
