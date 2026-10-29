# Quaderni — Visione e roadmap

Documento di riferimento. Le sessioni di lavoro implementano **una milestone alla volta**; ogni milestone parte da una versione stabile e la lascia stabile.

## Utente target
Studente universitario che prende appunti a mano per ore su un tablet Android con pennino, dentro il proprio vault Obsidian. Le priorità, in ordine: precisione e bassa latenza del tratto, affidabilità dei dati, comfort d'uso prolungato, estetica.

---

## M1 — MVP (v0.1)
- Sezione "Quaderni": icona nel ribbon e comando nella palette.
- Creazione di un quaderno con una pagina quadrettata.
- Scrittura vettoriale con il pennino, sensibile alla pressione.
- Penna e gomma (a tratto intero).
- Undo/redo.
- Salvataggio automatico nel vault e riapertura identica.
- Build installabile più istruzioni per Android e Windows.

**Criterio di successo:** apro Obsidian, creo un quaderno, scrivo, chiudo l'app, la riapro e ritrovo esattamente gli stessi tratti.

## M2 — Motore di scrittura completo
- Smoothing e stabilizzazione configurabili; più penne e spessori; evidenziatore trasparente.
- Gomma a segmento (taglia i tratti).
- Selezione lazo: sposta, ridimensiona, ruota.
- Zoom e pan fluidi (pinch, due dita).
- Palm rejection configurabile.
- Pagine multiple con virtualizzazione (si renderizzano solo le pagine visibili).
- Benchmark riproducibili: frame time, latenza input→pixel misurata in-app, memoria, documento con 10.000 o più tratti.

## M3 — Sistema quaderni
- Libreria con cartelle, copertine, tag e metadati, preferiti, segnalibri.
- Formati: A4, A5, personalizzato, canvas infinita.
- Carta: bianca, rigata, quadrettata, puntinata, millimetrata, più template personalizzati.
- Pagine: duplica, riordina, elimina.
- Immagini, caselle di testo, forme (linee, frecce, cerchi, rettangoli), righello.
- Esportazione PDF/SVG; importazione PDF con annotazione (usando il pdf.js già incluso in Obsidian tramite `loadPdfJs()`, prima di valutare una dipendenza propria).

## M4 — Integrazione con Obsidian
- Link `[[Quaderno]]` e link a una pagina specifica (es. `[[Quaderno#p3]]` o equivalente verificato).
- Backlink, ricerca e Graph View: funzionano nativamente **solo** se il file è `.md` (vedi la decisione sul formato). Per un'estensione custom servono meccanismi propri, da verificare prima di prometterli.
- Rappresentazione Markdown del quaderno (titolo, tag, link, testo OCR quando disponibile).

## M5 — AI e funzioni accademiche (solo dopo M1–M3 stabili)
Architettura a provider intercambiabili, con il locale come preferenza e il cloud solo come opt-in esplicito, accompagnato da informazioni su costi e privacy:
- OCR della scrittura a mano, riconoscimento formule → LaTeX.
- Riassunti, quiz e flashcard, chat contestuale, ricerca semantica.
- Registrazione audio sincronizzata ai tratti (stile Notability/Goodnotes).
- Integrazione NotebookLM (vedi sezione dedicata).

### Integrazione NotebookLM
Vincoli verificati (ott 2026):
- Non esiste un'API pubblica per la versione consumer. L'API ufficiale esiste solo per NotebookLM Enterprise (Google Cloud).
- Esistono librerie non ufficiali reverse-engineered (`notebooklm-py`, MIT; CLI `nlm` di notebooklm-mcp-cli): funzionano, ma si autenticano con i cookie del browser e possono rompersi a ogni aggiornamento di Google.
- Plugin community esistenti: **Star NotebookLM** (MIT, webview incorporata, solo desktop), **Gemini NotebookLM Studio** (usa il CLI `nlm` tramite child_process, solo desktop), **Context Pack for NotebookLM** (MIT, desktop e mobile, solo esportazione pulita).

Design a livelli:
1. **Livello base, ovunque (Android incluso):** comando "Prepara per NotebookLM" su un quaderno, una cartella o un tag. Genera in `NotebookLM/<corso>/` un PDF delle pagine scritte a mano e un `.md` pulito con il testo OCR e le formule in LaTeX, senza sintassi Obsidian. Il testo OCR serve perché NotebookLM lavora meglio sul testo che sulla calligrafia. Caricamento manuale o tramite la condivisione di sistema di Android.
2. **Livello Drive (opzionale):** il pacchetto viene salvato in una cartella sincronizzata con Google Drive, da aggiungere come fonte Drive in NotebookLM. Va verificato quanto bene NotebookLM aggiorna le fonti Drive.
3. **Livello diretto (opzionale, solo desktop, sperimentale):** invio automatico tramite il CLI `nlm` / `notebooklm-py`, oppure compatibilità con Star NotebookLM / Gemini NotebookLM Studio, scrivendo file che quei plugin sanno già inviare. Disattivato di default, con l'avviso che usa API non ufficiali.

Da non fare: reimplementare nel plugin le chiamate RPC non ufficiali di NotebookLM. Sono fragili, sono in zona grigia rispetto ai termini di Google e non devono diventare una dipendenza del plugin principale.

## M6 — UX premium (trasversale, rifinita a ogni milestone)
Toolbar flottante e personalizzabile, fullscreen, UI che si nasconde durante la scrittura, selezione rapida di colori e spessori, portrait/landscape, dark mode, accessibilità, animazioni leggere che non incidono sulla latenza.

---

## Decisione aperta: formato file (va risolta in M1)
| Opzione | Pro | Contro |
|---|---|---|
| A. Estensione custom (`.quaderno`, JSON) + `registerExtensions` | semplice, file pulito | niente ricerca, backlink, tag o Graph nativi |
| B. `.md` con frontmatter + blocco dati (approccio Excalidraw `.excalidraw.md`) | link, tag, ricerca e backlink nativi | va intercettata l'apertura dei file per mostrare la vista custom; file grandi indicizzati da Obsidian |
| C. Ibrido: dati in JSON più un `.md` "companion" con metadati e link | indicizzazione più dati separati | due file da tenere sincronizzati |

Scegliere, motivare in `docs/architecture.md` e progettare il formato in modo da poter migrare in seguito.

## Progetti di riferimento
| Repo | Cosa guardare |
|---|---|
| obsidianmd/obsidian-sample-plugin | struttura, build, manifest |
| zsviczian/obsidian-excalidraw-plugin | formato `.md` ibrido, viste custom, compatibilità mobile |
| ellimist-afk/handwriting | scrittura a mano dentro Obsidian (verificare licenza e stato) |
| steveruizok/perfect-freehand | forma dei tratti con pressione |
| saber-notes/saber, LinwoodDev/Butterfly | UX e modello dati di app di note a mano (solo idee: sono in Flutter e con licenze copyleft da verificare) |
| mozilla/pdf.js | rendering PDF |

Prodotti da studiare come benchmark UX: Samsung Notes, Goodnotes, Notewise, MyScript Notes.
