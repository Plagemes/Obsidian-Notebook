# Changelog

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
