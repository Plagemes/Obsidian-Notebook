# Architecture — Notebook v0.3 (M3a)

## 1. Decision: file format

**Choice: option A — custom `.notebook` extension with versioned JSON content**, opened by a `FileView` registered with `registerExtensions(['notebook'])`.

Reasons, in order of weight for M1 (data reliability first):

1. **No one else writes to the file.** A `.md` (options B and C) is touched by Obsidian and by other plugins: Linter, Templater, automatic link updates on rename, frontmatter changes, a Markdown editor opened by mistake. Any of these can corrupt a large data block. With our own extension the file is written only by Notebook.
2. **No workspace patching.** B requires intercepting `WorkspaceLeaf.setViewState` (as Excalidraw does with monkey-around): fragile code across Obsidian versions and with the "deferred" tabs of 1.7.2+. `registerExtensions` is a public API.
3. **No indexing cost.** A `.md` with thousands of points is indexed by search and the metadata cache on every save; on Android that is a real cost.
4. **The advantages of B/C (links, tags, backlinks, Graph) belong to M4.** The format is designed to get there without rewriting the data (see §5).

Accepted and documented costs:
- Native search, tags and backlinks do not see notebooks (until M4).
- **Obsidian Sync** syncs unknown extensions only with the "Sync all other types" option enabled (stated in the README). Syncthing and USB copy have no limits.

## 2. JSON schema v3

```json
{
  "format": "obsidian-notebook",
  "version": 3,
  "id": "6f1c…",
  "createdAt": "2026-10-29T14:30:00.000Z",
  "modifiedAt": "2026-10-29T14:42:10.000Z",
  "pages": [
    {
      "id": "a91e…",
      "width": 595.28,
      "height": 841.89,
      "paper": { "kind": "grid", "spacing": 14.17 },
      "strokes": [
        { "id": "c03d…", "tool": "pen", "color": "#1e293b", "width": 2,
          "points": [[72.5, 90.12, 0.512], [73.1, 90.4, 0.534]] },
        { "id": "d71a…", "tool": "highlighter", "color": "#facc15", "width": 14,
          "points": [[72.5, 120.0, 0.5], [180.2, 120.3, 0.5]] }
      ]
    }
  ]
}
```

| Field | Rule |
|---|---|
| `format` | always `"obsidian-notebook"`: distinguishes the file from any random JSON |
| `version` | integer. A version higher than the supported one → the file opens **read-only** with a warning and is never rewritten |
| units | **typographic points (pt, 1/72 inch)**, origin at the top left of the page. A4 = 595.28 × 841.89 pt. Chosen because it is PDF's native unit (used as is by the M3a export) and independent of the screen |
| `pages` | at least one. They are stacked vertically by the layout (§6), not by coordinates. Stroke ids are unique across the whole document |
| `paper` | `kind` is one of `blank`, `ruled`, `grid`, `dotted`, `millimetre` (all but `grid` are new in v3); `spacing` in pt. See "Paper and page sizes" below |
| `points` | `[x, y, pressure]` in the page's own coordinates, x/y rounded to 0.01 pt, pressure in [0, 1] rounded to 0.001. **The saved pressure is the one actually used**: if the device does not provide it, the pressure simulated from velocity is written. Rendering is therefore deterministic. With stabilization on, the stored points are the stabilized ones (§6) |
| `tool` | `"pen"` or `"highlighter"` (new in v2). The eraser produces no strokes |
| `color` | `#rrggbb` |
| `width` | nominal diameter in pt, > 0 |
| `id` | unique strings (UUID when available) |

Unknown fields are ignored on read. Every schema change increments `version` and adds a tested migration (`src/model/migrations.ts`).

**Version history**

- **v0 → v1**: v0 is an unversioned test format (`{ strokes: [{ points: [{x, y, p}], color, size }] }`) that served to establish the mechanism.
- **v1 → v2** (M2): the only change is the new `highlighter` tool. The migration is the identity plus `version: 2`: every valid v1 document is a valid v2 document. A v1 file opened by 0.2 is migrated in memory and rewritten as v2 only on the first edit.
- **v2 → v3** (M3a): v3 adds the paper kinds `blank`, `ruled`, `dotted` and `millimetre` (the v2 reader accepted only `grid`); page sizes were already free numbers (`width`, `height`). The migration is the identity plus `version: 3`: every valid v2 document is a valid v3 document. A v2 file opened by 0.3 is migrated in memory and rewritten as v3 only on the first edit.
- **v3 → v4** (M3): adds `meta` (`tags`, `favorite`, `cover`, `bookmarks`) and `assets` (keyed by lowercase-hex id) to the document; `background`, `elements` (text and image) and `infinite` to pages, written only when present; and the stroke tool `shape`. Migration: default meta (`DEFAULT_META`), empty assets; a pre-v4 file that already contains `shape` is rejected. Validation: asset references (page backgrounds, image elements) must resolve to an asset of the right kind; ids are unique across strokes and elements; `meta.tags` are de-duplicated and `meta.bookmarks` filtered to existing pages on read and on write. Order of keys: `meta`, `assets` before `pages`; per page `background`, `infinite`, `elements`, `strokes`. `serializeChecked` validates meta, assets, backgrounds and elements on every save, also on the incremental path.
- **Compatibility**: a plugin that supports an older version sees a newer `version` as a future version, so it opens the file read-only (and keeps a backup copy of it, as for any file it cannot edit) and never rewrites it. Once 0.2 has saved a file, 0.1.x cannot edit it; once 0.3 has saved a file, 0.2.x cannot edit it.

**Stroke rendering parameters** (perfect-freehand) are code constants, not per-stroke fields:
- pen (`PEN_V1`): `size = width`, `thinning 0.6`, `smoothing 0.5`, `streamline 0.35`, `simulatePressure false`, round caps. Unchanged since v1;
- highlighter (`HIGHLIGHTER_V2`): `thinning 0` (constant width, pressure ignored), `smoothing 0.5`, `streamline 0.35`, flat ends. Painted with alpha 0.35 and `multiply` compositing.

Changing these constants changes how existing files look; making them per-stroke would need another schema version with a migration.

### Paper and page sizes

Both are per page, so one notebook can mix them. Constants are in `model/types.ts` (sizes, default spacing) and `ink/paper.ts` (pattern geometry).

| Paper `kind` | Default `spacing` | Pattern |
|---|---|---|
| `blank` | unused | nothing drawn |
| `ruled` | 8 mm | horizontal lines every `spacing`, the first at 3 × `spacing` from the top (`RULED_TOP_LINES`); a red vertical margin line at 25 mm from the left edge |
| `grid` | 5 mm (14.17 pt) | vertical and horizontal lines every `spacing` |
| `dotted` | 5 mm | a dot at every grid intersection |
| `millimetre` | 1 mm | lines every `spacing`; every 10th (10 mm) is a major line, drawn darker |

Lines and dots are never drawn on the page edge. `paperPattern(page, visible, { includeMinor })` is pure (no canvas): it returns lines (`minor` / `major` / `margin`) and dots in page coordinates, limited to the visible rectangle. The canvas renderer (`drawPaper`) and both exporters use it, with shared colours (`PAPER_COLORS`), so screen and export show the same pattern. On screen, minor lines and dots are left out when they would be closer than about 3 CSS px (`minorVisible`), which keeps millimetre paper cheap and readable when zoomed out; major and margin lines stay. Exports always draw the full pattern.

Page size presets (portrait, pt): A4 595.28 × 841.89, A5 419.53 × 595.28, Letter 612 × 792. Landscape swaps width and height; there is no stored orientation field, it follows from `width > height`. The format accepts any positive `width` and `height`, but 0.3 offers only the presets (custom sizes are M3c).

**Changing the size of a page does not move or scale its strokes.** They keep their page coordinates; strokes that end up outside a smaller page stay in the file (nothing is deleted) and are clipped when drawn and exported. Making the page large again shows them again.

A page added with **Add page** copies the size and paper of the page in view (0.2 always added an A4 grid page); `createPage()` without arguments still gives A4 grid.

## 3. Modules

```
src/
  main.ts                 plugin: view, extension, ribbon, commands (incl. add page, export PDF, benchmark, stress test), settings, flush on unload
  settings.ts             settings types and defaults (incl. default paper, page size, orientation)
  i18n.ts                 UI strings: English, Italian when Obsidian's language is Italian
  model/                  (does not import 'obsidian')
    types.ts              Document, Page, Stroke, Tool, Paper and paper kinds, page size presets, A4 constants, CURRENT_VERSION
    document.ts           document/page/stroke creation (size and paper as parameters), ids, quantization
    pages.ts              duplicatePage(): copy of a page with new page and stroke ids
    serialize.ts          deterministic serialize(), parse() with validation and migrations, serializeChecked() (save check), freezeStroke()
    migrations.ts         chain of vN → vN+1 migrations (v0→v1, v1→v2, v2→v3)
    history.ts            command-stack undo/redo (AddStroke, EraseStrokes, ReplaceStroke, AddPage, DeletePage, MovePage, SetPaper, SetPageSize, Batch)
    stress.ts             deterministic generated notebook (10,000 strokes / 10 pages by default) for benchmarks and the stress-test command
  ink/                    (does not import 'obsidian')
    viewport.ts           screen ↔ page transform, fit-width, zoom around a point (scale 0.25–8), pan
    paper.ts              paper pattern geometry (lines and dots in page coordinates) and paper colours (pure)
    export-svg.ts         page → standalone SVG string (pure)
    export-pdf.ts         pages → PDF bytes, dependency-free writer (pure)
    layout.ts             pages stacked vertically: boxes, page at a point, nearest and visible pages
    pressure.ts           real vs constant pressure detection, pressure simulated from velocity
    stabilizer.ts         exponential-lag input stabilization
    input-policy.ts       pen/touch/mouse routing, time-based palm rejection, contact-size palm filter (pure logic)
    hit-test.ts           whole-stroke eraser (segment-segment distance + bounding box)
    segment-erase.ts      segment eraser: cuts a stroke into the runs that survive
    lasso.ts              point-in-polygon selection, selection bounds, stroke transform
    transform.ts          2D affine matrices (translate, scale and rotate about a point, invert)
    stroke-shape.ts       perfect-freehand → SVG path, pen and highlighter parameters (pure, testable)
    renderer.ts           two canvases (static + live), visible pages only, paper pattern, selection overlay, CSS-transform fast path, DPR, Path2D cache, rAF
    pointer-controller.ts Pointer Events: coalesced/predicted, capture, pan, pinch, fling inertia
  storage/
    session.ts            document lifecycle: load, dirty, debounce, flush, conflicts (pure, testable)
    vault-io.ts           Vault API adapter (read, process, backup)
    notebooks.ts          notebook creation in the configured folder
  view/
    notebook-view.ts      FileView: mounts canvas and toolbar, wires session, history, input, tools, selection, performance overlay
    toolbar.ts            tools, colours, widths, eraser mode, undo/redo, add page, page menu button, delete selection, fit, page indicator
    export.ts             writes PDF/SVG files next to the notebook (Vault API), free file names
    benchmark.ts          in-app benchmark (off-screen render of a generated notebook) and its modal
    modals.ts             "New notebook" (name, page size, orientation, paper) and "Open notebooks" (fuzzy search)
    settings-tab.ts       settings UI
scripts/check-bundle.mjs          fails the build if main.js requires anything but 'obsidian'
scripts/make-stress-notebook.mjs  writes a stress .notebook from the PC (alternative to the in-app command)
tests/                    vitest on model/, ink/ and storage/session.ts ("unit" project, `npm test`); model.perf.ts is the `npm run bench` suite ("perf" project)
```

## 4. Save flow (rule 4: zero data loss)

Session state: `doc`, `revision` (incremented on every change), `savedRevision`, `diskContent` (last content read or written by us), `mode` = `ok` | `readonly` (future version) | `broken` (unreadable) | `deleted`. **All disk operations of a session (load, flush, external-change check) run one at a time through a single queue**, so a check never interleaves with a write.

**Open**
1. `vault.read(file)` → `parse()`.
2. Success → `mode = ok`, any migration happens in memory (the migrated file is rewritten only on the first change).
3. Failure (invalid JSON, invalid schema, empty file) → `mode = broken`; future version → `mode = readonly`. In both cases: **a backup of the raw content is created** in `<notebooks folder>/_backup/<name> <date-time> <reason> <hash>.bak` (no duplicates: a backup is skipped only if a file with the same hash in its name has exactly the same content), the view shows a message and **no write path is active**.

**Change** → `revision++` → scheduled save: 1.5 s debounce from the last change, at most 10 s of waiting during continuous writing.

**Flush** (debounce, view close `onUnloadFile`/`onClose`, plugin `onunload`, `visibilitychange` → hidden, `pagehide`, `workspace 'quit'` best effort):
1. If `mode ≠ ok` or there are no changes → nothing.
2. `serializeChecked(doc)` produces `next` and **re-validates** it (see "Save check" below). If it fails: no write, warning, changes kept in memory.
3. `current = vault.read(file)`; if `current ≠ diskContent` the file changed outside of us (Sync, another device) → `current` is saved as a `conflict` backup **before** anything is overwritten, and the user is notified. If the backup fails, the write does not happen.
4. `vault.process(file, latest => …)` (atomic): if `latest ≠ current` the file changed again since step 3 → it is returned unchanged (nothing overwritten) and steps 3–4 are repeated, at most 3 times; then the save fails and is retried later.
5. `diskContent = next`, `savedRevision = revision` captured at step 2. Changes arriving during a flush schedule another one. A failed write keeps the changes in memory and retries after 5 s.

**Save check** (`serializeChecked`). Committed strokes are frozen (`freezeStroke`: immutable; an edit creates a new stroke), so their serialized line can be cached safely. A **new** stroke (drawn in this session) is serialized, parsed and validated, re-serialized, and the text must be identical; the verified line is cached per stroke object, so each stroke goes through this once. A stroke **read from a file** was already validated field by field by `parse()` and is marked as such (a `WeakSet`), so on the first save it is only serialized, without a second parse. After a successful load the session warms the line cache one page per timer tick (`DocumentSession.warmUp` → `warmStrokeLines`), so that first save is cheap. Duplicate stroke ids are rejected. Then:
- documents whose text is under `FULL_CHECK_LIMIT` (1 MB) are **fully re-parsed** on every save and must satisfy `serialize(parse(next)) === next`, as in 0.1;
- larger documents get the **incremental check**: the skeleton (header, pages, paper, page ids) is parsed and validated on every save, plus the strokes not seen before, plus the duplicate-id check. The full re-parse is skipped, so saving a notebook of several MB no longer re-parses all of it each time.

The text is still assembled in full on every save, so the cost of a save stays proportional to the document; only the parse and validation work is avoided. Opening a file always does a full `parse()`.

**Closing a view or switching file** (`onClose`/`onUnloadFile`): the stroke in progress is committed, then the flush is attempted up to 3 times; if the changes still cannot be written they are saved as an `unsaved` backup before the session is released.

**Deleted file**: the session stops writing (`mode = deleted`); unsaved changes, if any, go to an `unsaved` backup.

**External modification** (`vault.on('modify')` on the open file): the check is queued after any flush in progress and re-reads the file; if the content matches `diskContent` it is the echo of our own write → ignored. Otherwise, with no pending local changes → reload the document (if unreadable → `broken` + backup, without overwriting); with pending changes → ours are kept and on flush the external content ends up in the `conflict` backup.

**Stroke in progress**: on `visibilitychange`/`pagehide`/`pointercancel` the stroke in progress is closed and saved as a normal stroke before the flush, so leaving the app mid-writing does not lose it.

Known limit: if Android kills the process without notifying `visibilitychange`, at most the last ~1.5 s of changes are lost (or 10 s during continuous writing). Closing from recent apps first goes through the "background" state, so the flush happens; this needs to be verified on hardware.

## 5. Format evolution (toward M4)

- **C (hybrid)**: a command will generate a companion `.md` (title, tags, links, OCR text) next to the `.notebook`; the JSON does not change.
- **B (`.md` with data block)**: if B is chosen, the migration will be a file → file conversion: the JSON becomes the content of a code block, with `format`/`version` unchanged. The parser stays the same.
- Many strokes: v2 keeps a single JSON file (a generated 10,000-stroke notebook is about 6.8 MB on the PC). If that proves too slow on the device, a later version may split pages across files; `version` enables the migration. Decide with benchmark numbers from real hardware.

## 6. Input, rendering and tools

### Input
- `touch-action: none` on the container; `pointerType` distinguishes `pen`/`touch`/`mouse`.
- **Palm rejection.** Time-based: if the pen is active or was seen (even hovering) in the last N ms (default 500, configurable), touch does not draw and only pans (one finger) or zooms (two fingers). "Write with finger" mode is a setting (default off). If the pen touches down while a finger is drawing, the finger stroke is discarded. Contact size (experimental, default off): a touch whose `max(width, height)` exceeds the setting (CSS px) is ignored completely, scrolling included; it depends on what the device reports.
- `getCoalescedEvents()` for every `pointermove`; `getPredictedEvents()` optional (setting) and drawn **only** on the live layer, never saved.
- Pressure: for the pen, real pressure is used only after seeing at least 3 distinct values in (0, 1) different from 0.5; otherwise, and always for mouse and finger, pressure simulated from velocity (exponential average) is used. "Always simulate pressure" setting.
- **Stabilization** (`Stabilizer`, setting 0–10, default 2): the stored point follows the raw pointer with an exponential lag, `alpha = 1 / (1 + 0.6 × level)`; level 0 passes points through. It is applied before the point is quantized and stored, so a saved stroke contains the stabilized path (changing the setting later does not alter existing strokes). When the pen lifts, up to 6 interpolated points close the gap between the lagging point and the last raw position. Higher levels trail further behind the pen.
- **Fling**: when a one-finger pan ends with `pointerup`, the speed over the last 80 ms continues as an inertial scroll with exponential decay (time constant 325 ms); a new touch or wheel event stops it. Two-finger pan/zoom has no inertia.

### Pages: layout and virtualization
- `layoutPages` stacks the pages vertically in "document space" (pt) with a 24 pt gap, each page centred horizontally on the widest one. Strokes stay in page coordinates; a page box is only an offset, so layout changes never touch stroke data.
- The viewport maps document space to the screen. Fit-to-width uses the layout width; zoom is clamped to 0.25–8.
- **Virtualization**: the static redraw asks `visiblePages` for the pages intersecting the screen and draws only those; within a page it skips strokes whose cached bounding box is outside the visible area. Stroke `Path2D`s and bounds are cached per (frozen) stroke object and built the first time a stroke is drawn.
- **Add page** (toolbar button and command) inserts a blank page with the size and paper of the page in view **after the page at the centre of the view** as an undoable `AddPage`, then scrolls to it. The toolbar shows `n / total` for the page at the centre of the view. Further page commands are in "Page commands" below.

### Page commands

The toolbar has a page menu button next to Add page. It acts on the page at the centre of the view. Every item is a history command, so each is one undo step; the selection is cleared first, and nothing runs while a stroke is being drawn.

| Menu item | Command |
|---|---|
| Duplicate page | `AddPage` with `duplicatePage(page)` after the current page: new page id, new stroke ids, copied points, same size and paper |
| Move page up / down | `MovePage`; disabled at the first / last page |
| Delete page | `DeletePage`; disabled when the notebook has one page (a document always keeps at least one). Undo re-inserts the same page object |
| Paper: blank / ruled / grid / dotted / millimetre | `SetPaper`; the spacing becomes the default of the new kind |
| Size: A4 / A5 / Letter | `SetPageSize`; keeps the current orientation; strokes are not moved or scaled |
| Portrait / Landscape | `SetPageSize` swapping width and height; shown only when the page has a preset size |
| Export page as PDF / notebook as PDF / page as SVG | see §8 (not history commands) |

After a command the view scrolls to the affected page. The commands tolerate repeated apply/revert: no page is inserted twice and a refused delete is not "undone".

### Rendering
- Two stacked canvases, sized to the view × `devicePixelRatio`: **static** (paper pattern, saved strokes of the visible pages; a new stroke is appended without redrawing everything) and **live** (stroke in progress + prediction, lasso, floating selection; redrawn with `requestAnimationFrame`).
- **Highlighter** strokes are filled with alpha 0.35 and `globalCompositeOperation = "multiply"` in stroke order, so they darken what is under them (paper, grid, earlier ink) instead of covering it. The live preview is on the separate live canvas: translucent, but not multiplied with the page until the stroke is committed.
- **CSS-transform fast path**: pan and zoom gestures call `setViewport(v, interactive = true)`. If the last full static redraw took more than 12 ms, the existing bitmap is moved and scaled with a CSS `matrix(...)` transform instead of being redrawn, and a full redraw runs 120 ms after the last gesture update. Any non-interactive change redraws immediately. While only the transform is applied, areas the old bitmap did not cover are blank and detail is not re-rendered for the new zoom. Pages that redraw in 12 ms or less never use it.
- Initial zoom: fit to the view width; recomputed on resize/rotation until the user zooms. Pinch, wheel and Ctrl+wheel zoom around the focal point.
- **Performance overlay** (setting): per frame it records the frame interval and the time from the last input sample to the next drawn frame (a software measure of input→frame, not display latency), and shows them with the last static redraw time and the strokes and pages drawn, refreshed twice a second.

### Tools
- **Whole-stroke eraser**: 10 screen px radius converted to pt; the segment travelled by the eraser between two events is tested against the stroke's segments (with half the stroke width), with a bounding-box prefilter.
- **Segment eraser** (`eraseSegment`): same hit test, then the stroke is densified (no segment longer than half the radius, so a cut cannot slip between two distant points) and the points within `radius + width/2` of the eraser path are removed. Surviving runs of at least two points become new strokes with new ids and the original style; single-point crumbs are dropped. The original is replaced in place by a `ReplaceStroke`. The eraser acts on the page under the pointer, so one gesture can cross pages.
- **Gesture undo**: everything erased in one gesture (either mode, any number of pages) is recorded as a single `Batch`, so one undo restores it.
- **Lasso** (`lasso.ts`): the gesture polygon is tested with an even-odd rule; a stroke is selected when at least 50% of its points are inside. A selection belongs to one page. It shows a dashed frame, a **resize handle** at the bottom-right corner (uniform scale about the top-left corner of the frame, clamped to 0.05–20×) and a **rotate handle** above the top edge (rotation about the centre of the frame). Dragging inside the frame moves it.
- **Transforms** are kept as an affine matrix (`transform.ts`) while the pointer is down: the selected strokes are hidden from the static layer and drawn on the live layer with the matrix, so a drag redraws only the selection. On release the matrix is baked into new strokes (`transformStroke`: points transformed and re-quantized, width scaled by the matrix's uniform factor, same id and style) and applied as a `Batch` of `ReplaceStroke` commands: one undo step. Delete (toolbar button, Delete or Backspace) is a `Batch` of `ReplaceStroke` with no replacement. Escape or changing tool clears the selection. Transformed strokes stay on their page and are clipped to it when drawn.

### Benchmarks
- `npm run bench` (`vitest run --project perf --silent=false`): `tests/model.perf.ts`, a custom timing loop (not vitest's bench API) over `stressDocument(10_000, 10)`: serialize, open (parse + validate), open plus first save with a cold cache, next saves, eraser hit test, segment cut, lasso, stroke outline. It is excluded from `npm test`. Dev-PC reference (Windows, Node 24; 10,000 strokes, 10 pages, 6.69 MB): serialize 153 ms; open 227 ms; open + first save, cold cache, 424 ms in total; next saves 16–19 ms; eraser hit test 0.04 ms per move (1,000 strokes, cached bounds); segment cut 0.005 ms; lasso over a quarter page 2.4 ms; stroke outline 0.04 ms. **These are PC numbers**: Android will be slower and must be measured with the in-app benchmark.
- In-app command **Run performance benchmark** (`view/benchmark.ts`): generates the same notebook, then times serialization, the first and later save checks and parse, and renders it with an **off-screen** `Renderer` at the current view size: first draw (builds paths), 30 redraws at fit width, 150 scroll frames, 30 redraws at 3× zoom. It also times the eraser hit test and segment cuts and reports the JS heap where the WebView exposes it. Nothing is written to the vault; the results can be copied.
- Command **Create stress-test notebook**: writes the generated notebook (10,000 strokes, 10 pages) to the notebooks folder and opens it, to test real interaction on the device. The in-app benchmark does not measure real input latency; the performance overlay does, in the software sense above.

## 7. Undo/redo

Command stack, not snapshots. Each command knows how to apply and undo itself; a new command clears the redo stack; maximum 500 commands. The history lives in memory (it is not saved in the file) and is reset on reopening or on reload after an external modification.

| Command | Used for |
|---|---|
| `AddStroke { pageId, stroke, index }` | pen and highlighter strokes |
| `ReplaceStroke { pageId, before, after[], index }` | segment erase (cut), whole-stroke erase (`after` empty), transforms, delete selection |
| `AddPage { page, index }` | add or duplicate a page; undoing never removes the last page; applying it twice never inserts the page twice |
| `DeletePage { page, index }` | delete page; a no-op (and so is its undo) on the only page |
| `MovePage { pageId, from, to }` | move up/down; undo puts the page back at the exact position it moved from |
| `SetPaper { pageId, before, after }` | change paper kind and spacing; strokes untouched |
| `SetPageSize { pageId, before, after }` | change page size / orientation; strokes untouched |
| `Batch { label, commands }` | one gesture or action made of several commands (eraser gesture, transform, delete); undone in reverse order |
| `EraseStrokes { pageId, items }` | multi-stroke whole erase from M1; kept and tested, no longer used by the view |

Committed strokes are immutable, so commands refer to stroke objects and indices, never to data that can change underneath them.

## 8. Export (PDF and SVG)

Export reads the document and does not go through the history. Files are written with the Vault API next to the notebook (`<name>.pdf`; single pages `<name> p3.pdf` and `<name> p3.svg`), adding ` 2`, ` 3`… if the name is taken; a notice shows the path or the error. The generators are pure functions in `ink/` (no `obsidian`, no DOM), so they run in tests. Entry points: the page menu (page as PDF, notebook as PDF, page as SVG) and the command **Export notebook as PDF**. Both formats always include the paper pattern.

Both exporters reuse `paperPattern` and the stroke outline of the renderer (perfect-freehand, same parameters) and the same colours, so ink has the same geometry as on screen. Strokes stay vector.

**PDF** (`pagesToPdf`, PDF 1.4, written by hand, no library):
- One PDF page per notebook page. **Units: the PDF user unit is 1/72 inch = 1 pt = our document unit**, so `MediaBox` is `[0 0 width height]` with no scaling.
- Objects: 1 catalog, 2 page tree, 3 info (`Producer`, and `Title` = notebook name), then a page object and a content stream per page. The classic `xref` table is built from real byte offsets. Everything is ASCII (the title is a literal string when it is printable ASCII, otherwise UTF-16BE hex with a BOM), so string length equals byte length and the offsets are exact.
- **y-flip.** PDF has its origin at the bottom left, the document at the top left. Each content stream starts with `1 0 0 -1 0 H cm`, so coordinates are written as they are in the document.
- Content: white page rectangle, paper (lines per kind with width and colour via `w` and `RG`; dots as tiny filled squares, to avoid four Béziers per dot), then the strokes in order.
- **Strokes as cubics.** `strokeOutline` returns a polygon; the screen draws it as a chain of quadratic curves (control point = vertex, end point = midpoint to the next vertex). PDF paths have only cubics, so each quadratic is raised exactly: `c1 = p0 + 2/3 (q − p0)`, `c2 = p + 2/3 (q − p)`. The shape is the same as on screen. Each stroke is one closed filled path.
- **Highlighter.** Pages that contain a highlighter stroke declare `/GS1 << /ca 0.35 /BM /Multiply >>` in their resources, and highlighter strokes are wrapped in `q /GS1 gs … Q`: same alpha and multiply blending as the canvas.
- Numbers have at most 2 decimals and never use exponent notation.
- **No compression.** Content streams are not Flate-compressed: no dependency, and the file can be read and checked by eye. The price is size, roughly 100–200 bytes per stroke point, so a page with a lot of ink is several times larger than the same page from a compressing PDF producer. Compression can be added later without changing the structure.

**SVG** (`pageToSvg`): one standalone file per page. `width` and `height` are in mm (it prints at real size), the `viewBox` is in pt. White background rectangle, one path per paper line kind, one path for all dots (circles), one path per stroke; the highlighter has `fill-opacity` 0.35 and `mix-blend-mode: multiply`. The output is deterministic (no ids, dates or random values) and attribute values are escaped.

**What was and was not checked.** Unit tests cover the PDF structure (header and trailer, one page object per page, `xref` offsets and `startxref`, `/Length`, MediaBox, y-flip, colours, ExtGState only with a highlighter, paper on/off, title escaping, two decimals) and the SVG (size, paper, highlighter, escaping, determinism). Beyond the unit tests, an exported PDF was parsed with pdf.js (3 pages, Unicode title, fills, stroked paper lines, highlighter ExtGState) and an exported SVG was rendered with resvg. **Neither was opened on Android**, and how the device displays or shares the files is untested.
