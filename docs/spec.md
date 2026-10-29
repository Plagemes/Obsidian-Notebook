# Notebook — Vision and roadmap

Reference document. Work sessions implement **one milestone at a time**; each milestone starts from a stable version and leaves it stable.

## Target user
University student who takes handwritten notes for hours on an Android tablet with a stylus, inside their own Obsidian vault. Priorities, in order: stroke precision and low latency, data reliability, comfort during long use, aesthetics.

---

## M1 — MVP (v0.1)
- "Notebooks" section: ribbon icon and command in the palette.
- Creation of a notebook with one grid page.
- Vector writing with the stylus, pressure-sensitive.
- Pen and eraser (whole-stroke).
- Undo/redo.
- Automatic saving in the vault and identical reopening.
- Installable build plus instructions for Android and Windows.

**Success criterion:** I open Obsidian, create a notebook, write, close the app, reopen it and find exactly the same strokes.

## M2 — Complete writing engine
- Configurable smoothing and stabilization; multiple pens and widths; transparent highlighter.
- Segment eraser (cuts strokes).
- Lasso selection: move, resize, rotate.
- Smooth zoom and pan (pinch, two fingers).
- Configurable palm rejection.
- Multiple pages with virtualization (only visible pages are rendered).
- Reproducible benchmarks: frame time, input→pixel latency measured in-app, memory, document with 10,000 or more strokes.

## M3 — Notebook system
- Library with folders, covers, tags and metadata, favorites, bookmarks.
- Formats: A4, A5, custom, infinite canvas.
- Paper: blank, ruled, grid, dotted, graph paper, plus custom templates.
- Pages: duplicate, reorder, delete.
- Images, text boxes, shapes (lines, arrows, circles, rectangles), ruler.
- PDF/SVG export; PDF import with annotation (using the pdf.js already bundled with Obsidian via `loadPdfJs()`, before considering a dependency of our own).

## M4 — Obsidian integration
- `[[Notebook]]` links and links to a specific page (e.g. `[[Notebook#p3]]` or a verified equivalent).
- Backlinks, search and Graph View: they work natively **only** if the file is `.md` (see the file format decision). A custom extension needs its own mechanisms, to be verified before promising them.
- Markdown representation of the notebook (title, tags, links, OCR text when available).

## M5 — AI and academic features (only after M1–M3 are stable)
Interchangeable-provider architecture, with local preferred and cloud only as an explicit opt-in, accompanied by information on costs and privacy:
- Handwriting OCR, formula recognition → LaTeX.
- Summaries, quizzes and flashcards, contextual chat, semantic search.
- Audio recording synchronized to strokes (Notability/Goodnotes style).
- NotebookLM integration (see dedicated section).

### NotebookLM integration
Verified constraints (Oct 2026):
- There is no public API for the consumer version. The official API exists only for NotebookLM Enterprise (Google Cloud).
- Unofficial reverse-engineered libraries exist (`notebooklm-py`, MIT; the `nlm` CLI from notebooklm-mcp-cli): they work, but authenticate with browser cookies and may break with any Google update.
- Existing community plugins: **Star NotebookLM** (MIT, embedded webview, desktop only), **Gemini NotebookLM Studio** (uses the `nlm` CLI via child_process, desktop only), **Context Pack for NotebookLM** (MIT, desktop and mobile, clean export only).

Tiered design:
1. **Base tier, everywhere (Android included):** "Prepare for NotebookLM" command on a notebook, a folder or a tag. Generates in `NotebookLM/<course>/` a PDF of the handwritten pages and a clean `.md` with the OCR text and formulas in LaTeX, without Obsidian syntax. The OCR text is needed because NotebookLM works better on text than on handwriting. Manual upload or via the Android system share.
2. **Drive tier (optional):** the package is saved in a folder synced with Google Drive, to be added as a Drive source in NotebookLM. How well NotebookLM refreshes Drive sources still needs to be verified.
3. **Direct tier (optional, desktop only, experimental):** automatic upload via the `nlm` CLI / `notebooklm-py`, or compatibility with Star NotebookLM / Gemini NotebookLM Studio, by writing files those plugins already know how to send. Disabled by default, with a warning that it uses unofficial APIs.

Not to do: reimplement NotebookLM's unofficial RPC calls inside the plugin. They are fragile, in a gray area with respect to Google's terms, and must not become a dependency of the main plugin.

## M6 — Premium UX (cross-cutting, refined at every milestone)
Floating, customizable toolbar, fullscreen, UI that hides while writing, quick selection of colors and widths, portrait/landscape, dark mode, accessibility, light animations that do not affect latency.

---

## Open decision: file format (to be resolved in M1)
| Option | Pros | Cons |
|---|---|---|
| A. Custom extension (`.notebook`, JSON) + `registerExtensions` | simple, clean file | no native search, backlinks, tags or Graph |
| B. `.md` with frontmatter + data block (Excalidraw `.excalidraw.md` approach) | native links, tags, search and backlinks | file opening must be intercepted to show the custom view; large files indexed by Obsidian |
| C. Hybrid: data in JSON plus a "companion" `.md` with metadata and links | indexing plus separate data | two files to keep in sync |

Choose, justify in `docs/architecture.md`, and design the format so it can be migrated later.

## Reference projects
| Repo | What to look at |
|---|---|
| obsidianmd/obsidian-sample-plugin | structure, build, manifest |
| zsviczian/obsidian-excalidraw-plugin | hybrid `.md` format, custom views, mobile compatibility |
| ellimist-afk/handwriting | handwriting inside Obsidian (verify license and status) |
| steveruizok/perfect-freehand | pressure-sensitive stroke shape |
| saber-notes/saber, LinwoodDev/Butterfly | UX and data model of handwritten-notes apps (ideas only: they are in Flutter and with copyleft licenses to be verified) |
| mozilla/pdf.js | PDF rendering |

Products to study as UX benchmarks: Samsung Notes, Goodnotes, Notewise, MyScript Notes.
