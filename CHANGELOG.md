# Changelog

## Unreleased

- **Writing engine** (wet ink): the stroke being written is painted as each pen sample arrives (`pointerrawupdate` where available), only the new part, on its own low-latency canvas; nothing is rebuilt per frame. New strokes use a new geometry (disc chain on a smooth curve) that is identical while writing and after the pen lifts, so the line no longer changes shape at pen-up or appears late at the start. Highlighter looks the same while writing and after. Saves, journal entries and thumbnails wait while the pen writes. Not verified on Android hardware.
- **File format v5**: every stroke records its render version (`render`: 1 = perfect-freehand as before, 2 = the new geometry). v4 files migrate in memory with every stroke marked 1, so existing notebooks look exactly as before. Files written by this version open read-only in older versions.
- Safety: during continuous writing the journal entry now lands in the first short pen-up gap (120 ms) or after at most 1 s / 1.5 s, instead of up to 4 s / 8 s later; the journal no longer writes while a save of the same revision is in flight (a crash could otherwise turn a "merged" entry into a stale one); a partial erase of a fast curved stroke keeps the curve (inserted points follow the ink geometry, not the chord).
- Stabilization is now an adaptive filter (1€ filter): less jitter at rest and much less lag while writing at the same level (default 2).
- Pressure: real or simulated is decided at the start of each stroke and never switches in the middle of it.
- Settings: *Predicted points* is replaced by *Predicted ink*, **off by default** (predicted samples overshoot at turns and at the end of a stroke).

- Instant save journal (storage side, M8 #31): every change is recorded within ~200 ms in a small plugin-owned journal (full snapshot for small notebooks, line diff for large ones, two alternating slot files) and replayed on open if the app died before the regular save. Not wired into the view yet.
- Document format v4 (model side): notebook `meta`, `assets`, page backgrounds, text and image elements, infinite pages, `shape` tool; v3 files migrate in memory. New undoable commands: `AddElement`, `RemoveElement`, `ReplaceElement`, `SetMeta`, `AddAsset`, `InsertPages`, `SetPageInfinite`.

## 0.3.0 — 2026-10-29 (M3a)

Not yet verified on Android hardware (see `docs/testing.md`). M3 has been split: this release covers pages, paper and export; shapes, text boxes, images and the ruler are planned for 0.4.0 (M3b), the library, PDF import and infinite canvas for 0.5.0 (M3c).

### Safety
- Paper spacing below 0.5 pt is rejected as invalid, and paper patterns are capped, so a hand-edited file cannot freeze the app.
- The page menu re-checks that the notebook is still editable before changing it.

### Added
- Paper kinds per page: blank, ruled (first line below a top margin, red margin line at 25 mm), grid, dotted (a dot at each grid intersection) and millimetre (a major line every 10 mm).
- Page sizes A4, A5 and Letter, portrait or landscape, per page.
- Page menu (three-dot button next to Add page): duplicate, move up, move down, delete, change paper, change size, switch orientation. Every action is one undo step. The only page of a notebook cannot be deleted.
- New-notebook dialog with page size, orientation and paper. The last choice is remembered as the default; the defaults are also in the settings (default paper, default page size, landscape by default).
- Export a page or the whole notebook as PDF, and a page as SVG, from the page menu; **Export notebook as PDF** is also a command. Files are written next to the notebook. The PDF writer has no dependencies and is not compressed. A generated PDF was parsed with pdf.js and a generated SVG rendered with resvg; neither was opened on Android.
- Italian translation of the new UI.

### Changed
- **File format v3**: adds the paper kinds. The v2 to v3 migration only changes the version number. A 0.2 notebook is rewritten as v3 on its first edit. Files written by 0.3 cannot be edited by 0.2.x, which opens them read-only (and keeps a backup copy).
- **Add page** now creates a page with the same size and paper as the page in view (before, always an A4 grid page).
- New notebooks are created with the chosen size, orientation and paper (default: A4 portrait, grid).
- Changing a page size does not move or scale strokes. Strokes outside a smaller page are kept in the file and clipped when drawn and exported.
- On screen, the fine lines and dots of the paper are not drawn when they would be closer than about 3 px.

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
