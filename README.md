# Notebook — handwritten notes for Obsidian

Handwritten notebooks inside your Obsidian vault, designed first for **Android tablets with a stylus (S Pen)** and also usable on Windows.

- Pressure-sensitive vector ink (each point is `[x, y, pressure]` in page coordinates), drawn with [perfect-freehand](https://github.com/steveruizok/perfect-freehand).
- A4 grid page, fitted to the screen width.
- Pen (4 colours, 3 widths), whole-stroke eraser, undo/redo.
- Automatic saving into the vault as a `.notebook` file (versioned JSON). Unreadable files are never overwritten; a backup copy is kept.
- Local-first: no account, no cloud, no telemetry.
- UI in English, and in Italian when Obsidian is set to Italian.

> **Status: v0.1 (milestone M1), early development.** The automated tests pass, but the plugin has **not been verified on Android hardware yet**. See [docs/testing.md](docs/testing.md) for what is verified and how to test it.

## Usage

- Ribbon icon **Open notebooks** (book) or the command palette → **Notebook: New notebook** / **Notebook: Open notebooks**.
- New notebooks go to the `Notebooks/` folder (configurable in the settings).
- Write with the pen. With the default settings a finger scrolls (one finger) and zooms (two fingers); it does not draw. Turn on **Draw with finger** in the settings to draw with a finger.
- Mouse: left button draws, wheel scrolls, Ctrl + wheel zooms, middle button pans.
- Undo/redo: toolbar buttons, Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (or Ctrl+Y) on desktop.

## Install (manual)

The plugin is not in the community plugin list yet. You need three files: `main.js`, `manifest.json` and `styles.css`.

### Build the files

```bash
npm install
```

```bash
npm run build
```

This produces `main.js` in the repo root; `manifest.json` and `styles.css` are already there.

### Windows

1. Close Obsidian or keep it open, either works.
2. Open your vault folder and create `<vault>\.obsidian\plugins\notebook\` (`.obsidian` is a hidden folder: in File Explorer turn on *View → Show → Hidden items*).
3. Copy `main.js`, `manifest.json` and `styles.css` into it.
4. In Obsidian: **Settings → Community plugins** → turn off *Restricted mode* if needed → click the reload icon next to *Installed plugins* → enable **Notebook**.

### Android

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

A `.notebook` file is JSON with `format: "obsidian-notebook"` and an integer `version`. Coordinates are in typographic points (A4 = 595.28 × 841.89 pt). Details and the reasoning behind the format choice are in [docs/architecture.md](docs/architecture.md).

Backups of unreadable files, of versions changed elsewhere (conflicts) and of changes that could not be saved are written to `Notebooks/_backup/` as `.bak` files (Obsidian does not show them in the file explorer; open the folder with a file manager).

Because the extension is custom, Obsidian's search, tags, backlinks and graph do not see notebooks yet (planned for M4, see [docs/roadmap.md](docs/roadmap.md)).

## Development

| Command | What it does |
|---|---|
| `npm run dev` | build in watch mode |
| `npm run build` | type-check, production build, check that `main.js` requires nothing but `obsidian` |
| `npm test` | vitest |
| `npm run lint` | eslint + `tsc --noEmit` |
| `node scripts/make-stress-notebook.mjs 5000` | writes `stress.notebook` with 5000 strokes for performance tests |

Rules for contributors are in [CLAUDE.md](CLAUDE.md) (no Node/Electron modules at runtime, vector strokes only, versioned format with tested migrations, zero data loss).

## Licence

MIT. Third-party code: perfect-freehand (MIT). No code was copied from the other projects studied in [docs/research.md](docs/research.md).
