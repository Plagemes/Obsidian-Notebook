# Design — library, PDF notebooks, elements (M3b + M3c)

Goal: a notebook system in the spirit of Samsung Notes and Notewise (folders → notebooks → pages; PDF pages and handwriting mixed freely in one notebook), built on plain vault files so that sync, backups and the Obsidian file explorer keep working.

## Principles

1. **The vault is the database.** Library folders are real folders under the notebooks folder; a notebook is one `.notebook` file. Moving, renaming and syncing work with any tool. No hidden database that can go out of sync.
2. **Heavy data is referenced, not embedded.** PDFs and images live in `<notebooks folder>/_assets/<sha256-prefix>.<ext>` and are referenced by id from the notebook. Saving a notebook with a 300-page PDF writes only the ink. The same file imported twice is stored once.
3. **Everything stays vector and versioned.** Ink, shapes and text are data in the notebook (format v4); PDF pages are a background that is rendered on demand. Every change is a command (undo/redo).
4. **Container-independent.** Code never tests the `.notebook` extension directly: one format layer (`src/storage/format.ts`) says what a notebook file is and how its text is read and written, so the planned M4 move to Markdown (`.md` with a data block, or a companion `.md`) is a contained change.
5. **Fast library through a disposable index.** Covers and metadata are cached in `index.json` in the plugin folder, keyed by path + mtime + size. The index can be deleted at any time and is rebuilt lazily; the notebooks remain the only source of truth.

## Format v4 (additions)

| Where | Field | Meaning |
|---|---|---|
| document | `meta` | `{ tags, favorite, cover, bookmarks }` |
| document | `assets` | `{ [id]: { id, kind: "pdf" \| "image", path, name, bytes } }` |
| page | `background` | `{ kind: "pdf", asset, page }` or `{ kind: "image", asset }` |
| page | `elements` | text boxes and images (below the ink, above the background) |
| page | `infinite` | the page grows downwards while writing near the bottom |
| stroke | `tool: "shape"` | constant-width ink for lines, arrows, rectangles, ellipses and recognised shapes |

Drawing order: page colour → background (PDF page or image) → paper pattern (none by default on PDF pages) → images → text → ink.

## PDF in a notebook

- **Import as new notebook** (library or command): one notebook page per PDF page, page size = PDF page size, background = that PDF page.
- **Insert into an existing notebook** (page menu / navigator): whole PDF or a page range, after the current page. Blank note pages can be inserted between PDF pages at any time.
- Rendering: pdf.js from Obsidian (`loadPdfJs()`); visible pages are rasterised at the current zoom into an LRU bitmap cache with a memory budget; while zooming, the previous bitmap is scaled until the sharp one is ready.
- Missing asset (file deleted): the page shows a placeholder with the file name; the ink is kept.
- Export: ink stays vector; the PDF page is embedded as a JPEG image at 200 dpi.
- Scans (roadmap M7 #29) reuse the same mechanism: a scanned sheet is an image asset used as a page background (`{ kind: "image" }`), so it behaves exactly like a PDF page.

## Library view

Samsung-Notes-like screen opened from the ribbon:
- Sidebar: **All notebooks**, **Favourites**, **Recent**, folder tree (create, rename, delete empty), tags.
- Grid of cards: cover (first page thumbnail on the cover colour), title, page count, modified date, favourite star. Sort by modified / name / created; search by name and tag.
- Actions: new notebook (in the current folder), new folder, import PDF, rename, move (menu or drag onto a folder), duplicate, delete (to the Obsidian trash), favourite, tags, cover colour.

## Inside a notebook

- **Page navigator**: side panel (drawer on phones) with page thumbnails; tap to jump, drag to reorder, bookmark star, page menu per thumbnail; filter "bookmarked only".
- **Tools**: pen, highlighter, eraser, lasso, **shape** (line, arrow, rectangle, ellipse), **text**, **image**, **ruler** (straight edge you place and rotate with two fingers; the pen snaps along it).
- **Shape recognition**: keep the pen still for ~0.6 s at the end of a stroke and it becomes a clean line, rectangle, ellipse or arrow when the fit is good enough.
- **Infinite page**: page option; writing in the bottom fifth extends it by half a page (undoable with the stroke).
