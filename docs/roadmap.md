# Roadmap

Summary of [spec.md](spec.md) with the current status. One milestone at a time; each one starts from a stable version and leaves it stable.

Status: ✅ implemented (automated tests pass) · 🧪 implemented, waiting for hardware verification · ⏳ not started.

## M1 — MVP (v0.1) — 🧪 implemented, waiting for Android verification

| Item | Status |
|---|---|
| "Notebooks" section: ribbon icon and palette commands | 🧪 |
| Create a notebook with a grid page | 🧪 |
| Pressure-sensitive vector writing with the stylus | 🧪 |
| Pen and whole-stroke eraser | 🧪 |
| Undo/redo | ✅ logic tested, 🧪 in the app |
| Autosave in the vault and identical reopening | ✅ logic tested, 🧪 in the app |
| Installable build + Android and Windows instructions | ✅ |

**Success criterion:** open Obsidian, create a notebook, write, close the app, reopen it and find exactly the same strokes. → To be confirmed with steps 1, 7 and 8 of the protocol in [testing.md](testing.md).

## M2 — Complete writing engine (v0.2) — 🧪 implemented, waiting for hardware verification

Every item below is implemented and its logic is covered by automated tests where it can be (see [testing.md](testing.md)); none has been verified on Android hardware. Rendering, gestures and performance only count once the protocol has been run on the device.

| Item | Status | Notes |
|---|---|---|
| Configurable smoothing and stabilization | 🧪 | stabilization slider 0–10, default 2; the perfect-freehand smoothing parameters are fixed constants, not configurable |
| Multiple pens and widths | 🧪 | pen: 9 colours, 5 widths |
| Transparent highlighter | 🧪 experimental | 5 colours, 3 widths, constant width, translucent with multiply blending; format v2 |
| Segment eraser (cuts strokes) | 🧪 | works across pages in one gesture, one undo step |
| Lasso selection: move, resize, rotate | 🧪 basic | one page per selection; uniform resize with a single handle; delete; no copy/paste |
| Smooth zoom and pan | 🧪 experimental | pinch and wheel zoom 0.25–8×; one-finger fling; CSS-transform fast path on heavy pages |
| Configurable palm rejection | 🧪 experimental | time window and finger-drawing toggle (from M1) plus a contact-size filter, off by default |
| Multiple pages with virtualization | 🧪 | stacked vertically, only visible pages and strokes are drawn; add page (undoable); delete, duplicate and reorder arrived in M3a |
| Reproducible benchmarks | 🧪 | `npm run bench` (pure logic), in-app benchmark, stress-test notebook (10,000 strokes / 10 pages), performance overlay; input→frame is a software measure, not display latency; PC numbers exist (see testing.md); numbers on the device are still to be collected |

To be confirmed with steps 10 and 13–21 of the protocol in [testing.md](testing.md).

## M3 — Notebook system — split into M3a, M3b and M3c

M3 was too large for one stable release, so it is split. Each part ships as its own version and starts from a stable one.

### M3a — Pages, paper and export (v0.3.0) — 🧪 implemented, waiting for hardware verification

Every item is implemented and its logic is covered by automated tests where it can be (196 unit tests); none has been verified on Android hardware. The PDF was parsed with pdf.js and the SVG rendered with resvg on the PC; neither was opened on a device.

| Item | Status | Notes |
|---|---|---|
| Paper kinds: blank, ruled, grid, dotted, millimetre | 🧪 | per page; format v3 (migration v2 to v3 is the identity; 0.2.x opens v3 files read-only and keeps a backup) |
| Page sizes A4, A5, Letter and orientation | 🧪 | per page; changing the size does not move or scale strokes (strokes outside a smaller page are kept but clipped); no custom sizes yet |
| Page menu: duplicate, move up/down, delete, paper, size, orientation | 🧪 | every action is one undo step; the last page cannot be deleted |
| New-notebook dialog with size, orientation and paper | 🧪 | the last choice is remembered as the default |
| Default paper and page size settings | 🧪 | also set by the dialog |
| Export page or notebook as PDF, page as SVG | 🧪 experimental | files are written next to the notebook; dependency-free PDF writer, uncompressed (large files for a lot of ink) |

To be confirmed with steps 23–26 of the protocol in [testing.md](testing.md).

### M3b — Objects (v0.4.0) — ⏳

Shapes (lines, arrows, circles, rectangles) · text boxes · images · ruler.

### M3c — Library, PDF and canvas (v0.5.0) — ⏳

Library with folders, covers, tags, metadata, favourites and bookmarks · PDF import with annotation (Obsidian's `loadPdfJs()` first) · infinite canvas and custom page sizes · custom templates.

## M4 — Obsidian integration — ⏳

Links to notebooks and to a specific page · backlinks, search and graph (need a Markdown representation: see the format notes in [architecture.md](architecture.md) §5) · Markdown representation of the notebook (title, tags, links, OCR text).

## M5 — AI and academic features — ⏳ (only after M1–M3 are stable)

Swappable providers, local first, cloud only as explicit opt-in · handwriting OCR, formulas → LaTeX · summaries, quizzes, flashcards, contextual chat, semantic search · audio recording synced with strokes · NotebookLM integration in layers (export package everywhere, optional Drive folder, optional experimental desktop-only direct send).

## M6 — Premium UX (cross-cutting) — ⏳

Floating customizable toolbar, fullscreen, UI that hides while writing, quick colour/width picker, portrait/landscape, dark mode, accessibility, light animations that do not affect latency.
