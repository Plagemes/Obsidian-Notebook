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

Every item below is implemented and its logic is covered by automated tests where it can be (see [testing.md](testing.md)); none has been verified on Android hardware, and rendering, gestures and performance only count once the protocol has been run on the device.

| Item | Status | Notes |
|---|---|---|
| Configurable stabilization | 🧪 | one slider, 0–10, default 2; no per-tool or adaptive smoothing |
| Multiple pens and widths | 🧪 | pen: 9 colours, 5 widths |
| Transparent highlighter | 🧪 experimental | 5 colours, 3 widths, constant width, translucent with multiply blending; format v2 |
| Segment eraser (cuts strokes) | 🧪 | works across pages in one gesture, one undo step |
| Lasso selection: move, resize, rotate | 🧪 basic | one page per selection; uniform resize with a single handle; delete; no copy/paste |
| Smooth zoom and pan | 🧪 experimental | pinch and wheel zoom 0.25–8×; one-finger fling; CSS-transform fast path on heavy pages |
| Configurable palm rejection | 🧪 experimental | time window and finger-drawing toggle (from M1) plus a contact-size filter, off by default |
| Multiple pages with virtualization | 🧪 | stacked vertically, only visible pages and strokes are drawn; add page (undoable); no delete or reorder (M3) |
| Reproducible benchmarks | 🧪 | `npm run bench` (pure logic), in-app benchmark, stress-test notebook (10,000 strokes / 10 pages), performance overlay; numbers on the device are still to be collected |

**Success criterion:** a 10,000-stroke notebook stays usable on the tablet (scrolling, zooming, writing, saving) and the benchmark numbers are recorded. → To be confirmed with steps 10 and 13–21 of the protocol in [testing.md](testing.md).

## M3 — Notebook system — ⏳

Library with folders, covers, tags, metadata, favourites, bookmarks · A4, A5, custom, infinite canvas · white, ruled, grid, dotted, millimetre paper and custom templates · duplicate, reorder, delete pages · images, text boxes, shapes, ruler · PDF/SVG export; PDF import with annotation (Obsidian's `loadPdfJs()` first).

## M4 — Obsidian integration — ⏳

Links to notebooks and to a specific page · backlinks, search and graph (need a Markdown representation: see the format notes in [architecture.md](architecture.md) §5) · Markdown representation of the notebook (title, tags, links, OCR text).

## M5 — AI and academic features — ⏳ (only after M1–M3 are stable)

Swappable providers, local first, cloud only as explicit opt-in · handwriting OCR, formulas → LaTeX · summaries, quizzes, flashcards, contextual chat, semantic search · audio recording synced with strokes · NotebookLM integration in layers (export package everywhere, optional Drive folder, optional experimental desktop-only direct send).

## M6 — Premium UX (cross-cutting) — ⏳

Floating customizable toolbar, fullscreen, UI that hides while writing, quick colour/width picker, portrait/landscape, dark mode, accessibility, light animations that do not affect latency.
