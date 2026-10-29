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

## M7 — Additional features (backlog, planned 2026-10-29)

Beyond the original spec. Priority: **P1** next, **P2** very useful, **P3** nice to have. Status: ⏳ for all.

### Writing and tools
1. **P1** Favourite pens: 4–6 saved presets (tool + colour + width), one tap to switch.
2. **P1** Configurable S Pen side button: hold for eraser, lasso or last tool.
3. **P1** Multi-finger gestures: two-finger tap = undo, three-finger tap = redo (configurable).
4. **P1** Scribble to erase: scratching over strokes deletes them.
5. **P1** Restyle selection: change colour and width of lasso-selected strokes.
6. **P1** Copy, paste and duplicate selections across pages and notebooks.
7. **P2** Free colour picker with recent colours and an eyedropper.
8. **P2** Pressure curve calibration per device, with a test area.
9. **P2** Tilt-aware pencil (tiltX/tiltY widen and lighten the stroke).
10. **P2** Study tape: opaque strips that hide parts of a page and reveal on tap.
11. **P2** Zoom window for writing small on a large page.
12. **P3** Laser pointer (fading temporary ink) for presentations.
13. **P3** Protractor and compass alongside the ruler.

### Organisation and navigation
14. **P1** Two scroll modes: continuous vertical (current) or one page at a time with horizontal swipe.
15. **P1** Notebook outline: titled bookmarks shown as a table of contents.
16. **P1** Global search in the library: titles, tags, text boxes (OCR later).
17. **P2** Links on the page: a region or element opens another page, notebook, Obsidian note or URL.
18. **P2** Back/forward history of visited pages.
19. **P2** Notebook templates: create a notebook from a saved notebook (planner, lab book).
20. **P2** Sticky notes: movable coloured notes on the page.
21. **P3** Paper colours (cream, dark, chalkboard) with ink adapted for contrast.

### Obsidian integration
22. **P1** Embed a page in a Markdown note: a `notebook` code block renders a page preview.
23. **P2** Optional always-updated PDF copy next to each notebook (sharing, NotebookLM).
24. **P2** Flashcards from the lasso: question and answer regions become a Markdown flashcard compatible with spaced-repetition plugins.

### Data and reliability
25. **P1** Version history: automatic snapshots (e.g. daily per notebook) with restore.
26. **P1** Page trash: deleted pages stay recoverable after the session ends.
27. **P2** Library check: find unreadable notebooks and orphaned assets, free space.
28. **P3** Password-protected notebooks: local encryption with Web Crypto, no cloud.

### Capture and sharing
29. **P1** Scan into the notebook: the camera scan goes straight into the notebook as a page whose background is the cropped, perspective-corrected and enhanced photo (like a PDF page), so you write on it, reorder it in the navigator and export it like any other page. A multi-sheet session adds consecutive pages after the current one; alternatively a scan can be placed as an image on the current page. Enhancement filters: original, document (high-contrast black and white), whiteboard.
30. **P2** Quick share of a page as PNG or PDF through the Android share sheet.

## File format transition (applies to M4 and to every milestone before it)

M4 may move notebooks from `.notebook` to Markdown (option B, `.md` with the data in a block) or add a companion `.md` (option C), so that links, backlinks, search and the graph work natively (see architecture.md §1 and §5). Until that decision is taken, all code must keep the move cheap:

- One format layer decides what a notebook file is and how it is read and written (`isNotebookFile`, `readNotebookText`, `writeNotebookText` in `src/storage/format.ts`). Library, index, links, embeds, version history, scanner and import never test the extension themselves.
- Assets, links, bookmarks and the library index reference notebooks by vault path and document id, never by extension-dependent names; a rename keeps working.
- The document JSON (format version, migrations) is independent of the container, so the same data can live in a `.notebook` file or inside a Markdown block.
- When the switch happens it ships as a format container change with a one-click migration command, a backup of every converted file, and support for reading both containers for at least one release.
