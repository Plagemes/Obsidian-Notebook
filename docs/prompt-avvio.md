Leggi CLAUDE.md e docs/spec.md. Obiettivo di questa sessione: **milestone M1 (MVP v0.1)** e nient'altro.

## 1. Ricerca mirata (subagenti in parallelo, uno per repo)
Per ogni repo in docs/spec.md rispondi solo a queste domande:
- licenza e possibilità concreta di riuso in un progetto MIT;
- come gestisce input del pennino, pressione e palm rejection;
- modello dati dei tratti e formato su disco;
- cosa conviene riusare (dipendenza, idea o niente).
Leggi README, i file chiave e la documentazione; non esplorare interi codebase.
Verifica anche le API Obsidian necessarie (FileView/TextFileView, registerView, registerExtensions, vault.process/modify, vincoli mobile) consultando la documentazione ufficiale e i file .d.ts del pacchetto `obsidian`.
Output: `docs/research.md` con una matrice comparativa (max ~2 pagine).

## 2. Architettura
Risolvi la "decisione aperta: formato file" di docs/spec.md. Definisci lo schema JSON v1 del documento e il flusso di salvataggio.
Scrivi tutto in `docs/architecture.md`, poi procedi senza fermarti.

## 3. Implementazione M1
1. Scaffold dal sample plugin (TS, esbuild, eslint, vitest).
2. Sezione Quaderni: ribbon più comandi "Nuovo quaderno" e "Apri quaderni".
3. Creazione del quaderno → file nel vault (cartella configurabile, default `Quaderni/`).
4. Pagina A4 quadrettata, con zoom adattato alla larghezza.
5. Input Pointer Events: pen/touch/mouse, coalesced events, pressione con fallback.
6. Penna (colore e spessore base) e gomma a tratto intero.
7. Undo/redo (stack di comandi, non snapshot dell'intero documento).
8. Salvataggio automatico e riapertura identica, rispettando la regola 4 di CLAUDE.md.

## 4. Verifica
- Test vitest: serializzazione round-trip, migrazione (anche solo v0→v1 fittizia), undo/redo, hit-test della gomma, trasformazione coordinate schermo↔pagina a diversi zoom, rifiuto di file corrotti senza sovrascriverli.
- `npm run build`, `npm run lint` e `npm test` devono passare: correggi finché non passano.
- Controlla che il bundle non contenga import Node/Electron (grep su main.js).

## 5. Documentazione
- `README.md`: installazione manuale (copia di `main.js`, `manifest.json` e `styles.css` in `<vault>/.obsidian/plugins/quaderni/`, poi attivazione nei plugin della community) per Windows e Android, incluso come portare i file sul telefono (Obsidian Sync, Syncthing o USB).
- `docs/testing.md`: tabella di stato delle funzioni più protocollo di test manuale su Android con S Pen. Il protocollo deve coprire: latenza percepita, pressione, mano appoggiata mentre si scrive, pinch/zoom, chiusura forzata dell'app durante la scrittura, riapertura, rotazione dello schermo, documento con molti tratti.
- `CHANGELOG.md`, `docs/roadmap.md` (estratto da spec.md con lo stato aggiornato).

Se una parte si blocca, documenta il limite e continua sulle parti indipendenti.

## Report finale
Architettura realizzata, file principali, cosa funziona davvero, test eseguiti con i risultati, limitazioni note, cosa devo testare io su Android, prossimi 3 passi per M2.
