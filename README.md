# Notebook — handwritten notes for Obsidian

Handwritten notebooks inside your Obsidian vault, designed first for **Android tablets with a stylus (S Pen)** and also usable on Windows.

- Pressure-sensitive vector ink (each point is `[x, y, pressure]` in page coordinates) with a wet-ink writing engine: the line is painted as the pen moves and does not change shape when you lift it.
- A library of notebooks (folders, favourites, tags, covers, search), PDF and scanned pages you can write on, shapes, text boxes, images, a ruler and infinite pages.
- Multiple pages stacked vertically; only the visible pages are drawn. Paper per page: blank, ruled, grid, dotted or millimetre; sizes A4, A5 and Letter, portrait or landscape. Export a page or a notebook as PDF, or a page as SVG.
- Automatic saving into the vault as a `.notebook` file (versioned JSON), an instant save journal for crash recovery and automatic version history. Unreadable files are never overwritten; a backup copy is kept.
- Local-first: no account, no cloud, no telemetry.
- UI in English, and in Italian when Obsidian is set to Italian.

> **Status: v0.4.1 (milestones M3b and M3c, plus a hotfix), early development.** The automated tests pass, but the plugin has **not been verified on Android hardware yet**, and many features are experimental (including the writing engine, the scanner and export: the PDF and SVG were checked with other software on a PC, not opened on Android). See [docs/testing.md](docs/testing.md) for what is verified and how to test it.

## Usage

- Ribbon icon **Open library** or the command palette → **Notebook: Open library**, **Notebook: New notebook** / **Notebook: Open notebooks** (a quick search list).
- **New notebook** asks for a name, a page size (A4, A5, Letter), landscape or portrait, and a paper (blank, ruled, grid, dotted, millimetre). The last choice is remembered and used as the default next time; the defaults can also be changed in the settings.
- New notebooks go to the `Notebooks/` folder (configurable in the settings). **Open notebooks** lists the notebooks in that folder and its subfolders; notebooks stored elsewhere open from the file explorer.

### Library

The library is a screen with a sidebar (**All notebooks**, **Favourites**, **Recent**, the folder tree, tags) and a grid of cards showing the cover, name, page count and date. Covers are thumbnails of the first page, also for PDF and image pages, on a cover colour you choose.

- Sort by last modified, name or date created.
- Per notebook: open, rename, move to a folder (menu or drag onto a folder), duplicate, delete (to the Obsidian trash), favourite, edit tags, cover colour. Folders are real vault folders: create, rename, delete (empty ones only).
- **Search** looks in notebook titles, tags and the text of text boxes, everywhere, in this folder or in this view. A text hit shows a snippet and opens the notebook at that page. Handwriting is not searched (no OCR).
- Metadata and thumbnails are cached in `library-index.json` in the plugin folder. It is only a cache: it can be deleted at any time and is rebuilt (the library shows "Indexing…").

### Tools

The toolbar has these tools:

- **Pen**: 9 colours, 5 widths, pressure-sensitive.
- **Highlighter**: 5 colours, 3 widths, constant width, translucent. It darkens the ink and grid below it instead of covering them.
- **Eraser**, with two modes: **Whole stroke** removes the strokes it touches; **Segment** cuts them and removes only the part under the eraser. It works across pages in one gesture, and one undo restores everything erased in that gesture.
- **Lasso**: draw a loop around strokes, text boxes and images (a stroke is selected when at least half of its points are inside). Drag inside the frame to move them, drag the handle at the bottom-right corner to resize (uniform), drag the handle above the top edge to rotate. The trash button, Delete or Backspace deletes the selection; Escape or changing tool clears it. A selection stays on one page.
- **Shape**: line, arrow, rectangle or ellipse, dragged out with the pen. With the pen, **hold still for about 0.6 s at the end of a rough line, rectangle, ellipse or arrow** and it is replaced by the clean shape.
- **Text**: tap to place a text box and type; the text size is in the toolbar. Text in text boxes is searchable in the library.
- **Image**: insert an image from the vault or the device as an element (select it with the lasso to move, scale or rotate it).
- **Ruler**: place a straight edge with two fingers; the pen follows it, so a stroke started on its edge stays on the edge.

Undo/redo: toolbar buttons, Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (or Ctrl+Y) on desktop. Each transform, delete, insertion or eraser gesture is one step. The history lives in memory and is lost when the notebook is closed.

### Pages and navigation

- A notebook can have several pages, stacked vertically. **Add page** (toolbar button or command) inserts a blank page after the page in view, with the same size and paper as that page, and can be undone. The toolbar shows the current page as `n / total`.
- The **Pages panel** (toolbar) shows page thumbnails: tap to jump, drag to reorder, star to bookmark, and a filter to show bookmarked pages only.
- The **page menu** (three-dot button next to Add page) acts on the page in view: duplicate, move up or down, delete (not the only page), change the paper, change the size, switch between portrait and landscape, insert a PDF, a blank page, an image or a scan after it, make the page infinite, bookmark it, and export. Each change is one undo step. Changing the size does not move or scale the ink: ink that falls outside a smaller page is kept in the file but not shown or exported, and comes back if you enlarge the page again.
- **Infinite page** (page menu): when you write in the bottom fifth of the page it grows by half a page, up to 20 times its width. Undoing the stroke undoes the growth.
- Ruled paper has its first line below a top margin and a red margin line about 25 mm from the left edge; dotted paper has a dot at every grid intersection; millimetre paper has a darker line every 10 mm. On screen the fine lines and dots fade out when zoomed far out.
- With the default settings a finger scrolls (one finger) and zooms (two fingers); it does not draw. A quick one-finger flick keeps scrolling for a moment (fling). Turn on **Draw with finger** in the settings to draw with a finger.
- **Fit to width** in the toolbar restores the default zoom.
- Mouse: left button draws, wheel scrolls, Ctrl + wheel zooms, middle button pans.

### PDFs and scans

- **Import PDF as notebook** (library button or command): one notebook page per PDF page, with the PDF page as the background; you write on top of it.
- **Insert PDF after this page** (page menu): the whole file or a page range. Blank pages can be inserted between PDF pages at any time. **Insert image as page** makes a page whose background is the image.
- **Scanner**: **Scan into this notebook** (command or page menu), **New notebook from scan** (command or library), or **Insert scan as image** (page menu). Take a photo with the device camera (or choose one), drag the four corners to the edges of the sheet (a loupe shows the corner under your finger; the corners are detected automatically when possible), pick a filter (*Original*, *Document*, *Whiteboard*), rotate or retake, then go on with the next sheet or finish. The result is a page whose background is the corrected photo, like a PDF page.
- PDFs and images are copied once into `<notebooks folder>/_assets/`, named by a hash of their content, so the same file used twice is stored once and saving a notebook with a long PDF writes only the ink. If an asset file is deleted, the page shows a placeholder with the file name and the ink is kept. Do not delete or rename files in `_assets`.

### Export

From the page menu: **Export page as PDF**, **Export notebook as PDF** and **Export page as SVG**; the command palette also has **Notebook: Export notebook as PDF**. The file is written next to the notebook (`My notebook.pdf`; single pages as `My notebook p3.pdf` or `My notebook p3.svg`), with ` 2`, ` 3`… added if the name is taken, and a notice shows the path. The export includes the paper pattern and keeps the ink as vector shapes; the highlighter stays translucent. PDF page backgrounds and images are rasterised as JPEG (PDF pages at 200 dpi). Page sizes are the real sizes (A4 prints as A4).

The PDF writer has no dependencies and does not compress, so a page with a lot of ink or images can give a large file. The exported PDF was parsed with pdf.js and the SVG rendered with resvg on a PC; they have not been opened on Android yet.

### Embeds and links

- **Embed a page in a note**: the command **Notebook: Insert notebook embed** (in a Markdown note) adds a code block like the one below. The preview shows that page, refreshes when the notebook changes, and opens the notebook at that page when clicked.

  ````
  ```notebook
  path: Notebooks/Physics.notebook
  page: 3
  ```
  ````

  The block also accepts `Notebooks/Physics.notebook#3` and the wikilink form `[[Physics#p3]]` (resolved by name). The page defaults to 1.
- **Links**: `obsidian://notebook?path=<vault path>&page=<n>` opens the notebook at that page from other apps, bookmarks or a QR code (`vault=<name>` is optional).
- Opening a notebook from a link, an embed or a search result scrolls to the requested page.

### Versions and recovery

- **Instant save journal**: about 200 ms after a change (never during a gesture) the change is recorded in a small journal in the plugin folder. If the app was killed before the regular save, the next time the notebook opens the changes are restored and a notice says so. If the journal does not match the file (it was changed elsewhere), nothing is applied and a copy goes to `Notebooks/_backup/`.
- **Version history**: when you open or change a notebook, a snapshot is saved if the last one is older than the interval (24 h by default); beyond the limit (10 by default) the oldest go to the trash. **Notebook: Restore a previous version** lists them; restoring first saves the current content as a backup, and a version of another notebook is refused. Snapshots are in `Notebooks/_backup/history/`.

### Settings

| Setting | What it does |
|---|---|
| Notebooks folder | where new notebooks are created (default `Notebooks`); `_assets` and `_backup` live inside it |
| Default paper | paper for new notebooks (blank, ruled, grid, dotted, millimetre) |
| Default page size | A4, A5 or Letter for new notebooks |
| Landscape by default | new notebooks are landscape |
| Draw with finger | fingers draw instead of only scrolling |
| Palm rejection time | touch is ignored for this long after the pen was seen (default 500 ms) |
| Pressure | use the device pressure, or always simulate it from speed. Decided at the start of each stroke |
| Predicted ink | draw the pen's predicted path ahead of the tip (never saved). Off by default: it can overshoot at turns and at the end of a stroke |
| Low-latency ink (experimental) | show the ink being written on a low-latency layer and read pen samples as soon as they arrive. Off by default: on some devices it can turn the page black or hide the ink |
| Stabilization | 0–10, default 2. Adaptive smoothing of hand tremor: strong when the pen is slow, almost none when it is fast; higher values trail further behind the pen. The filtered points are what is saved |
| Ignore large touches | experimental, 0 = off. Touches with a contact larger than this many px are treated as a palm and ignored, scrolling included. Depends on what the device reports |
| Performance overlay | shows frame time, input-to-frame and input-to-paint times, whether raw input is in use, redraw time, and strokes and pages drawn |
| Version history interval | at most one snapshot per notebook per this many hours (default 24); 0 turns snapshots off |
| Versions to keep | snapshots kept per notebook (default 10) |

### Performance tools

- **Notebook: Run performance benchmark** renders a generated 10,000-stroke, 10-page notebook off-screen at the size of the current view and reports first draw, redraw, scrolling (150 frames), 3x zoom, save check and open times, eraser timings, JS heap where available, and a replay of synthetic pen strokes through the old and the new writing pipeline. Nothing is written to your vault. Results can be copied.
- **Notebook: Create stress-test notebook** writes the same kind of notebook (10,000 strokes, 10 pages) to the notebooks folder, to try real writing, scrolling and zooming on a large document.
- The **Performance overlay** setting shows live numbers while you use a notebook.
- `npm run bench` runs benchmarks of the pure logic from the command line (see Development). Those are PC numbers; on a tablet use the in-app benchmark.

## Install

### From the community plugins directory

Submitted, waiting for review. Once it is approved: **Settings → Community plugins → Browse**, search for **Notebook**, then **Install** and **Enable**.

### With BRAT (works now, updates automatically)

1. **Settings → Community plugins → Browse**, search for **BRAT** (Obsidian42 - BRAT), install and enable it.
2. Command palette → **BRAT: Add a beta plugin for testing** → enter `https://github.com/Plagemes/Obsidian-Notebook` → choose the latest version → **Add plugin**.
3. Enable **Notebook** in **Settings → Community plugins**.

### Manual install

Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/Plagemes/Obsidian-Notebook/releases/latest), or build them yourself:

```bash
npm install
```

```bash
npm run build
```

This produces `main.js` in the repo root; `manifest.json` and `styles.css` are already there.

Requires Obsidian 1.8.7 or later.

#### Windows

1. Close Obsidian or keep it open, either works.
2. Open your vault folder and create `<vault>\.obsidian\plugins\notebook\` (`.obsidian` is a hidden folder: in File Explorer turn on *View → Show → Hidden items*).
3. Copy `main.js`, `manifest.json` and `styles.css` into it.
4. In Obsidian: **Settings → Community plugins** → turn off *Restricted mode* if needed → click the reload icon next to *Installed plugins* → enable **Notebook**.

#### Android

The plugin folder has to end up at `<vault>/.obsidian/plugins/notebook/` on the phone or tablet. Three ways to get it there:

**A. Obsidian Sync**
1. Install the plugin on the desktop as above.
2. On both devices: **Settings → Sync → Vault configuration sync** → turn on **Installed community plugins** (and *Active community plugins list*).
3. In the same Sync settings turn on **Other types** (*Sync all other types*): `.notebook` files are an unknown extension for Sync and are **not** synced without it.
4. Wait for Sync to finish on Android, restart Obsidian, then enable **Notebook** in **Settings → Community plugins**.

**B. Syncthing** (or any folder sync tool)
1. Sync the whole vault folder, including the hidden `.obsidian` folder (check that it is not in the ignore patterns).
2. On Android restart Obsidian and enable **Notebook** in **Settings → Community plugins**.

**C. USB cable**
1. Connect the device and open its storage on the PC.
2. Find the vault folder (for vaults in shared storage usually `Documents/<vault>` or `Obsidian/<vault>`; vaults in Obsidian's private app storage are not reachable over USB — move the vault to shared storage first).
3. Create `.obsidian/plugins/notebook/` inside the vault and copy the three files there. Some file managers hide folders starting with a dot; the PC's file explorer shows them if hidden items are visible.
4. On Android open Obsidian → **Settings → Community plugins** → turn off *Restricted mode* if needed → enable **Notebook**.

To update, replace the three files and restart Obsidian (or disable and re-enable the plugin).

### Debugging on Android

Enable USB debugging on the device, connect it to a PC with Chrome and open `chrome://inspect`: the Obsidian WebView appears there with its console. Errors from this plugin are prefixed with `[notebook]`.

## File format

A `.notebook` file is JSON with `format: "obsidian-notebook"` and an integer `version` (currently 5). Version 2 added the highlighter, 3 the paper kinds, 4 the notebook metadata, assets, PDF/image page backgrounds, text and image elements, infinite pages and the shape tool, and 5 a per-stroke `render` field (1 = the previous pen look, kept for every existing stroke; 2 = the new ink engine). Older notebooks open normally and are rewritten as version 5 only when you edit them; after that, **older versions of the plugin open them read-only** (and keep a backup copy) instead of editing them. Coordinates are in typographic points (A4 = 595.28 × 841.89 pt). PDFs and images are not inside the file: they are in `<notebooks folder>/_assets/` and referenced by id. Details and the reasoning behind the format choice are in [docs/architecture.md](docs/architecture.md).

Backups of unreadable files, of versions changed elsewhere (conflicts), of changes that could not be saved and of journals that could not be applied are written to `Notebooks/_backup/` as `.bak` files; version snapshots go to `Notebooks/_backup/history/`. Obsidian does not show these folders in the file explorer; open them with a file manager. If you sync the vault, sync `_assets` and `_backup` too (with Obsidian Sync, turn on **Other types** so that `.notebook` files, PDFs and snapshots are synced). The journal and the library index live in the plugin folder and are not meant to be synced.

Because the extension is custom, Obsidian's search, tags, backlinks and graph do not see notebooks yet (planned for M4, see [docs/roadmap.md](docs/roadmap.md)); the library has its own search, and notes can embed and link to notebook pages (see above).

## Development

| Command | What it does |
|---|---|
| `npm run dev` | build in watch mode |
| `npm run build` | type-check, production build, check that `main.js` requires nothing but `obsidian` |
| `npm test` | vitest (unit tests) |
| `npm run lint` | eslint + `tsc --noEmit` |
| `npm run bench` | benchmarks of the pure logic (serialize, open, save check, eraser, lasso, stroke geometry, input filter) on a generated 10,000-stroke notebook; not part of `npm test` |
| `node scripts/make-stress-notebook.mjs 5000` | writes `stress.notebook` with 5000 strokes for performance tests |

### Releasing

Releases are built by the **Release** workflow (`.github/workflows/release.yml`): when a version tag is pushed it builds the plugin and attests `main.js`, `manifest.json` and `styles.css`.

Order matters: **publish the release (push the tag) before merging a manifest version bump into `main`.** The community plugin directory reads `manifest.json` at the head of `main` and complains if no release with that version exists yet.

Beta versions: on the feature branch, push a tag made of the manifest version plus a suffix (for example `0.4.0-beta.1`). The workflow publishes it as a GitHub pre-release, which BRAT can install; directory users are not affected until the version bump is merged into `main` and the `0.4.0` tag is pushed.

Rules for contributors are in [CLAUDE.md](CLAUDE.md) (no Node/Electron modules at runtime, vector strokes only, versioned format with tested migrations, zero data loss).

## Licence

MIT. Third-party code: perfect-freehand (MIT). PDFs are rendered with the pdf.js that Obsidian provides. No code was copied from the other projects studied in [docs/research.md](docs/research.md).
