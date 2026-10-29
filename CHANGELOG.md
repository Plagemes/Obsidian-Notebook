# Changelog

## 0.2.0 — 2026-10-29 (M2)

Not yet verified on Android hardware (see `docs/testing.md`).

### Added
- Multiple pages stacked vertically (24 pt gap), with a page indicator `n / total` and an undoable **Add page** button and command that inserts a page after the one in view. Only visible pages and strokes are drawn.
- Highlighter tool: 5 colours, 3 widths, constant width, translucent with multiply blending. The pen now has 9 colours and 5 widths.
- Segment eraser (eraser mode **Segment**, next to **Whole stroke**): cuts strokes instead of removing them whole; works across pages in one gesture and is one undo step.
- Lasso selection (a stroke is selected when at least 50% of its points are inside): move, resize (bottom-right handle), rotate (handle above the top edge), delete (toolbar, Delete/Backspace). Escape clears the selection. Each action is one undo step.
- Input stabilization setting (0–10, default 2).
- Palm contact-size filter setting (experimental, off by default).
- One-finger fling (inertial scrolling).
- Performance overlay setting: frame time, input-to-frame time, redraw time, strokes and pages drawn.
- Commands **Run performance benchmark** (off-screen render of a generated 10,000-stroke, 10-page notebook, with copyable results) and **Create stress-test notebook**.
- `npm run bench`: benchmarks of the pure logic on a generated 10,000-stroke notebook.
- Italian translation of the new UI.

### Changed
- **File format v2**: adds the `highlighter` tool. The v1 to v2 migration only changes the version number. A 0.1 notebook is rewritten as v2 on its first edit. Files written by 0.2 cannot be edited by 0.1.x, which opens them read-only (and keeps a backup copy).
- Committed strokes are immutable (frozen). The save check validates each stroke line once and caches it (strokes read from a file are not parsed a second time, and the cache is warmed in the background after opening); documents under 1 MB are still fully re-parsed on every save, larger ones get an incremental check (document skeleton, new strokes, duplicate ids).
- Pan and zoom: while moving a page that is slow to redraw, the existing bitmap is moved with a CSS transform and redrawn 120 ms after the gesture pauses.
- Undo history gained `ReplaceStroke`, `AddPage` and `Batch` commands; an eraser gesture is recorded as one batch.

## 0.1.1 — 2026-10-29

Changes requested by the community directory review.

### Changed
- Settings use Obsidian's declarative settings API on Obsidian 1.13+, so they appear in the settings search. Older versions keep the previous settings tab.
- **Open notebooks** lists only notebooks inside the notebooks folder (and its subfolders) instead of scanning the whole vault. Notebooks elsewhere can still be opened from the file explorer.
- No `!important` in the stylesheet.

### Added
- Releases are built by GitHub Actions with artifact attestations for `main.js`, `manifest.json` and `styles.css`.

## 0.1.0 — 2026-10-29 (M1, MVP)

First development version. Not yet verified on Android hardware (see `docs/testing.md`).

### Added
- "Notebooks" section: ribbon icon, **New notebook** and **Open notebooks** commands, settings tab.
- `.notebook` file format v1 (versioned JSON, coordinates in pt, points `[x, y, pressure]`), with validation, deterministic serialization and a test migration from v0.
- A4 grid page fitted to the view width; basic pan, pinch zoom, wheel and Ctrl+wheel zoom.
- Pen input with Pointer Events: coalesced events, optional predicted points, pressure with simulated fallback, basic palm rejection, optional finger drawing.
- Pen with 4 colours and 3 widths, whole-stroke eraser, command-based undo/redo.
- Autosave with debounce and max wait; flush on view close, file switch, plugin unload, `visibilitychange` and `pagehide`.
- Data safety: re-validation before every write, unreadable files never overwritten and backed up, newer format versions opened read-only, conflict backups taken before overwriting a file changed on disk, retries on close with an "unsaved" backup as last resort, deleted files never rewritten.
- English UI with Italian translation.
- Build check that `main.js` requires nothing but `obsidian`; stress-notebook generator script.
- Requires Obsidian 1.8.7 or later. Follows the community plugin guidelines (checked with eslint-plugin-obsidianmd).
