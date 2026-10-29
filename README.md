# Notebook — handwritten notes for Obsidian

Handwritten notebooks inside your Obsidian vault, designed first for **Android tablets with a stylus (S Pen)** and also usable on Windows.

- Pressure-sensitive vector ink (each point is `[x, y, pressure]` in page coordinates), drawn with [perfect-freehand](https://github.com/steveruizok/perfect-freehand).
- Multiple A4 grid pages stacked vertically; only the visible pages are drawn.
- Pen (9 colours, 5 widths), translucent highlighter, whole-stroke and segment eraser, lasso selection (move, resize, rotate, delete), undo/redo.
- Input stabilization, palm rejection, in-app performance tools.
- Automatic saving into the vault as a `.notebook` file (versioned JSON). Unreadable files are never overwritten; a backup copy is kept.
- Local-first: no account, no cloud, no telemetry.
- UI in English, and in Italian when Obsidian is set to Italian.

> **Status: v0.2 (milestone M2), early development.** The automated tests pass, but the plugin has **not been verified on Android hardware yet**, and several M2 features are experimental. See [docs/testing.md](docs/testing.md) for what is verified and how to test it.

## Usage

- Ribbon icon **Open notebooks** (book) or the command palette → **Notebook: New notebook** / **Notebook: Open notebooks**.
- New notebooks go to the `Notebooks/` folder (configurable in the settings). **Open notebooks** lists the notebooks in that folder and its subfolders; notebooks stored elsewhere open from the file explorer.

### Tools

The toolbar has four tools:

- **Pen**: 9 colours, 5 widths, pressure-sensitive.
- **Highlighter**: 5 colours, 3 widths, constant width, translucent. It darkens the ink and grid below it instead of covering them.
- **Eraser**, with two modes: **Whole stroke** removes the strokes it touches; **Segment** cuts them and removes only the part under the eraser. It works across pages in one gesture, and one undo restores everything erased in that gesture.
- **Lasso**: draw a loop around strokes (a stroke is selected when at least half of its points are inside). Drag inside the frame to move them, drag the handle at the bottom-right corner to resize (uniform), drag the handle above the top edge to rotate. The trash button, Delete or Backspace deletes the selection; Escape or changing tool clears it. A selection stays on one page.

Undo/redo: toolbar buttons, Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (or Ctrl+Y) on desktop. Each transform, delete or eraser gesture is one step.

### Pages and navigation

- A notebook can have several pages, stacked vertically. **Add page** (toolbar button or command) inserts a blank page after the page in view and can be undone. The toolbar shows the current page as `n / total`. Deleting and reordering pages is not available yet.
- With the default settings a finger scrolls (one finger) and zooms (two fingers); it does not draw. A quick one-finger flick keeps scrolling for a moment (fling). Turn on **Draw with finger** in the settings to draw with a finger.
- **Fit to width** in the toolbar restores the default zoom.
- Mouse: left button draws, wheel scrolls, Ctrl + wheel zooms, middle button pans.

### Settings

| Setting | What it does |
|---|---|
| Notebooks folder | where new notebooks are created (default `Notebooks`) |
| Draw with finger | fingers draw instead of only scrolling |
| Palm rejection time | touch is ignored for this long after the pen was seen (default 500 ms) |
| Pressure | use the device pressure, or always simulate it from speed |
| Predicted points | draw the pen's predicted path on the live layer to reduce perceived lag (never saved) |
| Stabilization | 0–10, default 2. Smooths hand tremor; higher values trail further behind the pen. The smoothed points are what is saved |
| Ignore large touches | experimental, 0 = off. Touches with a contact larger than this many px are treated as a palm and ignored, scrolling included. Depends on what the device reports |
| Performance overlay | shows frame time, input-to-frame time, redraw time, and strokes and pages drawn |

### Performance tools

- **Notebook: Run performance benchmark** renders a generated 10,000-stroke, 10-page notebook off-screen at the size of the current view and reports first draw, redraw, scrolling (150 frames), 3x zoom, save check and open times, eraser timings and JS heap where available. Nothing is written to your vault. Results can be copied.
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

A `.notebook` file is JSON with `format: "obsidian-notebook"` and an integer `version` (currently 2; version 2 adds the highlighter tool). Notebooks from 0.1 open normally and are rewritten as version 2 only when you edit them; after that, 0.1.x opens them read-only. Coordinates are in typographic points (A4 = 595.28 × 841.89 pt). Details and the reasoning behind the format choice are in [docs/architecture.md](docs/architecture.md).

Backups of unreadable files, of versions changed elsewhere (conflicts) and of changes that could not be saved are written to `Notebooks/_backup/` as `.bak` files (Obsidian does not show them in the file explorer; open the folder with a file manager).

Because the extension is custom, Obsidian's search, tags, backlinks and graph do not see notebooks yet (planned for M4, see [docs/roadmap.md](docs/roadmap.md)).

## Development

| Command | What it does |
|---|---|
| `npm run dev` | build in watch mode |
| `npm run build` | type-check, production build, check that `main.js` requires nothing but `obsidian` |
| `npm test` | vitest |
| `npm run lint` | eslint + `tsc --noEmit` |
| `npm run bench` | benchmarks of the pure logic (serialize, open, save check, eraser, lasso) on a generated 10,000-stroke notebook; not part of `npm test` |
| `node scripts/make-stress-notebook.mjs 5000` | writes `stress.notebook` with 5000 strokes for performance tests |

### Releasing

Releases are built by the **Release** workflow (`.github/workflows/release.yml`): when a version tag is pushed it builds the plugin and attests `main.js`, `manifest.json` and `styles.css`.

Order matters: **publish the release (push the tag) before merging a manifest version bump into `main`.** The community plugin directory reads `manifest.json` at the head of `main` and complains if no release with that version exists yet.

Beta versions: on the feature branch, push a tag made of the manifest version plus a suffix (for example `0.2.0-beta.1`). The workflow publishes it as a GitHub pre-release, which BRAT can install; directory users are not affected until the version bump is merged into `main` and the `0.2.0` tag is pushed.

Rules for contributors are in [CLAUDE.md](CLAUDE.md) (no Node/Electron modules at runtime, vector strokes only, versioned format with tested migrations, zero data loss).

## Licence

MIT. Third-party code: perfect-freehand (MIT). No code was copied from the other projects studied in [docs/research.md](docs/research.md).
