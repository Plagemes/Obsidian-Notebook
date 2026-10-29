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

## M2 — Complete writing engine — ⏳

Configurable smoothing and stabilisation; more pens and widths; transparent highlighter · segment eraser · lasso selection (move, resize, rotate) · smooth zoom and pan (M1 has a basic version) · configurable palm rejection (M1 has the time-based base) · multiple pages with virtualization · reproducible benchmarks (frame time, in-app input→pixel latency, memory, 10,000+ strokes).

## M3 — Notebook system — ⏳

Library with folders, covers, tags, metadata, favourites, bookmarks · A4, A5, custom, infinite canvas · white, ruled, grid, dotted, millimetre paper and custom templates · duplicate, reorder, delete pages · images, text boxes, shapes, ruler · PDF/SVG export; PDF import with annotation (Obsidian's `loadPdfJs()` first).

## M4 — Obsidian integration — ⏳

Links to notebooks and to a specific page · backlinks, search and graph (need a Markdown representation: see the format notes in [architecture.md](architecture.md) §5) · Markdown representation of the notebook (title, tags, links, OCR text).

## M5 — AI and academic features — ⏳ (only after M1–M3 are stable)

Swappable providers, local first, cloud only as explicit opt-in · handwriting OCR, formulas → LaTeX · summaries, quizzes, flashcards, contextual chat, semantic search · audio recording synced with strokes · NotebookLM integration in layers (export package everywhere, optional Drive folder, optional experimental desktop-only direct send).

## M6 — Premium UX (cross-cutting) — ⏳

Floating customizable toolbar, fullscreen, UI that hides while writing, quick colour/width picker, portrait/landscape, dark mode, accessibility, light animations that do not affect latency.
