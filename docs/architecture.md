# Architecture — Notebook v0.1 (M1)

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

## 2. JSON schema v1

```json
{
  "format": "obsidian-notebook",
  "version": 1,
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
          "points": [[72.5, 90.12, 0.512], [73.1, 90.4, 0.534]] }
      ]
    }
  ]
}
```

| Field | Rule |
|---|---|
| `format` | always `"obsidian-notebook"`: distinguishes the file from any random JSON |
| `version` | integer. A version higher than the supported one → the file opens **read-only** with a warning and is never rewritten |
| units | **typographic points (pt, 1/72 inch)**, origin at the top left of the page. A4 = 595.28 × 841.89 pt. Chosen because it is PDF's native unit (M3 export) and independent of the screen |
| `paper` | M1: only `grid` with `spacing` in pt (5 mm = 14.17 pt). M3 adds other `kind`s |
| `points` | `[x, y, pressure]`, x/y rounded to 0.01 pt, pressure in [0, 1] rounded to 0.001. **The saved pressure is the one actually used**: if the device does not provide it, the pressure simulated from velocity is written. Rendering is therefore deterministic |
| `tool` | M1: only `"pen"`. The eraser produces no strokes |
| `color` | `#rrggbb` |
| `width` | nominal diameter in pt, > 0 |
| `id` | unique strings (UUID when available) |

Unknown fields are ignored on read. Every schema change increments `version` and adds a tested migration (`src/model/migrations.ts`). There is a v0 → v1 migration from an unversioned test format (`{ strokes: [{ points: [{x, y, p}], color, size }] }`), which serves to establish the mechanism.

**v1 pen rendering parameters** (perfect-freehand): `size = width`, `thinning 0.6`, `smoothing 0.5`, `streamline 0.35`, `simulatePressure false`, round caps. They are code constants: if M2 makes them configurable per stroke, schema v2 will be needed, with a migration that assigns the v1 values to existing strokes.

## 3. Modules

```
src/
  main.ts                 plugin: view, extension, ribbon, commands, settings, flush on unload
  settings.ts             settings types and defaults
  i18n.ts                 UI strings: English, Italian when Obsidian's language is Italian
  model/                  (does not import 'obsidian')
    types.ts              Document, Page, Stroke, A4 constants
    document.ts           document/page/stroke creation, ids, quantization
    serialize.ts          deterministic serialize() + parse() with validation and migrations
    migrations.ts         chain of vN → vN+1 migrations
    history.ts            command-stack undo/redo (AddStroke, EraseStrokes)
  ink/                    (does not import 'obsidian')
    viewport.ts           screen ↔ page transform, fit-width, zoom around a point, pan
    pressure.ts           real vs constant pressure detection, pressure simulated from velocity
    input-policy.ts       pen/touch/mouse routing and palm rejection (pure logic)
    hit-test.ts           whole-stroke eraser (segment-segment distance + bounding box)
    stroke-shape.ts       perfect-freehand → SVG path (pure, testable)
    renderer.ts           two canvases (static + live), DPR, Path2D cache, rAF
    pointer-controller.ts Pointer Events: coalesced/predicted, capture, pan and pinch
  storage/
    session.ts            document lifecycle: load, dirty, debounce, flush, conflicts (pure, testable)
    vault-io.ts           Vault API adapter (read, process, backup)
    notebooks.ts          notebook creation in the configured folder
  view/
    notebook-view.ts      FileView: mounts canvas and toolbar, wires session, history and input
    toolbar.ts            pen, eraser, colors, widths, undo/redo, fit to width
    modals.ts             "New notebook" (name) and "Open notebooks" (fuzzy search)
    settings-tab.ts       settings UI
scripts/check-bundle.mjs  fails the build if main.js requires anything but 'obsidian'
tests/                    vitest on model/, ink/ and storage/session.ts
```

## 4. Save flow (rule 4: zero data loss)

Session state: `doc`, `revision` (incremented on every change), `savedRevision`, `diskContent` (last content read or written by us), `mode` = `ok` | `readonly` (future version) | `broken` (unreadable).

**Open**
1. `vault.read(file)` → `parse()`.
2. Success → `mode = ok`, any migration happens in memory (the migrated file is rewritten only on the first change).
3. Failure (invalid JSON, invalid schema, empty file) → `mode = broken`; future version → `mode = readonly`. In both cases: **a backup of the raw content is created** in `<notebooks folder>/_backup/<name> <date-time> <reason> <hash>.bak` (no duplicates: the content hash is in the name), the view shows a message and **no write path is active**.

**Change** → `revision++` → scheduled save: 1.5 s debounce from the last change, at most 10 s of waiting during continuous writing.

**Flush** (debounce, view close `onUnloadFile`/`onClose`, plugin `onunload`, `visibilitychange` → hidden, `pagehide`, `workspace 'quit'` best effort):
1. If `mode ≠ ok` or there are no changes → nothing.
2. `next = serialize(doc)`; **re-validation**: `parse(next)` must succeed and `serialize(parse(next)) === next`. If it fails: no write, warning, changes kept in memory.
3. `vault.process(file, current => …)` (atomic): if `current ≠ diskContent` the file changed outside of us (Sync, another device) → the `current` content is kept and saved as a `conflict` backup right after the write, and the user is notified.
4. `diskContent = next`, `savedRevision = revision` captured at step 2. Flushes are serialized (never two parallel writes); changes arriving during a flush schedule another one.

**External modification** (`vault.on('modify')` on the open file): if the content matches `diskContent` it is the echo of our own write → ignored. Otherwise, with no pending local changes → reload the document (if unreadable → `broken` + backup, without overwriting); with pending changes → ours are kept and on flush the external content ends up in the `conflict` backup.

**Stroke in progress**: on `visibilitychange`/`pagehide`/`pointercancel` the stroke in progress is closed and saved as a normal stroke before the flush, so leaving the app mid-writing does not lose it.

Known limit: if Android kills the process without notifying `visibilitychange`, at most the last ~1.5 s of changes are lost (or 10 s during continuous writing). Closing from recent apps first goes through the "background" state, so the flush happens; this needs to be verified on hardware.

## 5. Format evolution (toward M4)

- **C (hybrid)**: a command will generate a companion `.md` (title, tags, links, OCR text) next to the `.notebook`; the JSON does not change.
- **B (`.md` with data block)**: if B is chosen, the migration will be a file → file conversion: the v1 JSON becomes the content of a code block, with `format`/`version` unchanged. The parser stays the same.
- Many pages: if a single JSON becomes too large (M2, 10,000+ strokes), v2 may split the pages; `version` enables the migration.

## 6. Input and rendering

- `touch-action: none` on the container; `pointerType` distinguishes `pen`/`touch`/`mouse`.
- **Basic palm rejection**: if the pen is active or was seen (even hovering) in the last N ms (default 500, configurable), touch does not draw and only pans (one finger) or zooms (two fingers). "Write with finger" mode is a setting (default off). If the pen touches down while a finger is drawing, the finger stroke is discarded.
- `getCoalescedEvents()` for every `pointermove`; `getPredictedEvents()` optional (setting) and drawn **only** on the live layer, never saved.
- Pressure: for the pen, real pressure is used only after seeing at least 3 distinct values in (0, 1) different from 0.5; otherwise, and always for mouse and finger, pressure simulated from velocity (exponential average) is used. "Always simulate pressure" setting.
- Two stacked canvases, sized to the view × `devicePixelRatio`: **static** (paper, grid, saved strokes, redrawn only when the document or the view changes; a new stroke is added without redrawing everything) and **live** (stroke in progress + prediction, redrawn with `requestAnimationFrame`). Stroke `Path2D`s are in page coordinates and cached by id.
- Initial zoom: fit to the view width; recomputed on resize/rotation until the user zooms. Pinch, wheel and Ctrl+wheel are a basic version (smooth zoom is M2).
- Whole-stroke eraser: 10 screen px radius converted to pt; the segment traveled by the eraser between two events is tested against the stroke's segments (with half the stroke width), with a bounding-box prefilter. All strokes erased in one gesture form a single undo command.

## 7. Undo/redo

Command stack, not snapshots: `AddStroke { pageId, stroke, index }` and `EraseStrokes { pageId, items: [{ stroke, index }] }`. Each command knows how to apply and undo itself; a new command clears the redo stack; maximum 500 commands. The history lives in memory (it is not saved in the file) and is reset on reopening or on reload after an external modification.
