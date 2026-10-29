# Public API

Other plugins and scripts (Templater, QuickAdd, Dataview JS, your own plugin) can create and edit notebooks through a small, versioned API:

```js
const api = app.plugins.plugins["notebook"]?.api;
```

`api` is `undefined` when the Notebook plugin is not installed or not enabled yet, so check before using it. In a Templater script it is `tp.app.plugins.plugins["notebook"].api`; in QuickAdd, `this.app...` or `params.app...`.

API version: **1.0.0** (`api.version`). It is the version of this interface, not of the plugin. A new method or option raises the minor number; a change that breaks existing calls raises the major number, so a script can check `api.version.startsWith("1.")`.

## Rules every call follows

- **Notebooks** are given as a `TFile`, as a vault path (`"Notebooks/Physics.notebook"`, the extension may be left out), or as any object with a `path`.
- **Page numbers are 1-based**, as in the page menu and in `[[Physics.notebook#p3]]` links.
- **Arguments are checked.** A wrong type, an out-of-range number or an unknown option name throws; nothing is ignored silently.
- **Errors are typed.** Every call throws (or rejects with) a `NotebookApiError` with a stable `code` and a `details` object. `api.NotebookApiError` is the class; checking `error.name === "NotebookApiError"` works across plugins too.
- **Writes are as safe as writing by hand.**
  - A notebook that is **open** is changed through its own session: one undo step in that notebook, saved by the normal save path. If the notebook is loading or a pen is down the call waits up to 3 seconds, then fails with `busy`.
  - A notebook that is **closed** is read, changed, fully re-validated, and only then written: a copy of the previous file is kept in the backup folder (`<notebooks folder>/_backup`, reason `before-api`), the file is written only if it still holds what was read, and it is read back and checked. A file that cannot be read is never overwritten. Calls on the same notebook run one after the other.
  - Each write to a closed notebook keeps one backup, so a loop of many small calls fills the backup folder: prefer one call with a count (`addPages(file, 20)`) or open the notebook first.
- The document format is not changed by any of this; notebooks written through the API are ordinary notebooks.

## Methods

### `api.createNotebook(folder, name, options?)`

Creates `<folder>/<name>.notebook` (creating the folder if needed) and returns `{ path, name, id, file }`. If the name is taken, ` 2`, ` 3`… is appended; `name` in the result is the real one. `folder` is a vault path, `""` or `"/"` is the vault root.

Options (all optional): `pageSize` (`"a4"`, `"a5"`, `"letter"`), `landscape`, `paper` (`"blank"`, `"ruled"`, `"grid"`, `"dotted"`, `"millimetre"`), `pages` (1 to 500), `tags` (written like Obsidian tags: `#exam` becomes `exam`, spaces become `-`, `a/b` is a nested tag; a tag that is only digits throws), `favorite`, `cover` (`"#rrggbb"`), `open` (open it in a tab). What is left out follows the defaults of the *New notebook* dialog.

```js
const nb = await api.createNotebook("Notebooks/Physics", "Lecture 12", { paper: "ruled", tags: ["physics", "lecture"], open: true });
```

### `api.addPages(file, pages, after?)`

Inserts pages and returns `{ added, firstPage, pageCount }`. `pages` is a count (1 to 500) or a template `{ count?, pageSize?, landscape?, paper?, spacing?, infinite? }`. Whatever the template leaves out is copied from the page next to the insertion point, like the *Add page* button (no content and no background are copied). `after` is the page to insert after: `0` at the start, omitted or the page count at the end.

```js
await api.addPages("Notebooks/Physics/Lecture 12", 3);
await api.addPages(file, { count: 1, paper: "millimetre", landscape: true }, 2); // after page 2
```

### `api.insertImage(file, page, image, options?)`

Places an image on a page as an image element and returns `{ elementId, assetId, page }`. `image` is a `Uint8Array`/`ArrayBuffer` with the file's bytes, or the vault path of an image file. PNG, JPEG, GIF and WebP are accepted (recognised by their first bytes, not by the name); anything else throws `unsupported-image`. The file is stored once in `_assets/` named by its content, like every image in a notebook. By default the image is centred and sized as the toolbar's *Insert image* does (96 dpi, at most 60 % of the page); `options` `{ x, y, width, height }` are in points (width alone or height alone keeps the proportions).

```js
await api.insertImage(file, 1, "Attachments/diagram.png", { width: 300 });
```

### `api.exportPdf(file, options?)`

Writes a PDF of the whole notebook next to it (`Physics.pdf`, ` 2`… if taken) and returns `{ path, pages, skippedImages }`. PDF pages and images that cannot be loaded are left out and counted in `skippedImages`; with `{ strict: true }` the call throws `export-incomplete` and writes nothing instead. For an open notebook the current, possibly unsaved content is exported.

### `api.getNotebookInfo(file)`

Returns a plain, JSON-safe object: `path`, `name`, `id`, `formatVersion`, `createdAt`, `modifiedAt`, `pageCount`, `pages` (per page: `number`, `id`, `width`, `height`, `paper`, `infinite`, `strokes`, `textBoxes`, `images`, `background` = `"pdf"`, `"image"` or `null`, `bookmarked`), `tags`, `meta` (`favorite`, `cover`, `bookmarks` as page numbers) and `open`. Tags are the notebook's own, as stored; with companion notes on they are also in the companion note's `tags` property and therefore in Dataview and in Obsidian's Tags pane.

### `api.openNotebook(file, page?)`

Opens the notebook in a tab (focusing the tab that already shows it), at `page` if given. A page number past the end opens the last page.

### `api.listNotebooks(options?)`

Returns, synchronously, `{ path, name, folder, mtime, size, open }` for every notebook in the vault, sorted by path. `options.folder` limits it to a folder and its subfolders.

## Errors

`error.code` is one of:

| Code | Meaning |
|---|---|
| `invalid-argument` | An argument is missing, has the wrong type, is out of range, or an option name is unknown. `details.argument` names it. |
| `not-found` | The notebook, or the image file given by path, does not exist. |
| `not-a-notebook` | The file exists but is not a notebook. |
| `unreadable` | The notebook cannot be read (damaged, or written by a newer version). It is not changed. |
| `unsupported-image` | The image is not a PNG, JPEG, GIF or WebP, or cannot be decoded (HEIC must be converted first). |
| `busy` | The notebook is open but cannot be edited right now (loading, read-only, a pen is down). Retry. |
| `changed-elsewhere` | The file changed while the call was writing it (sync, another app). Nothing was written. Retry. |
| `write-failed` | The change could not be written, saved or verified. For a closed notebook the file was not replaced by a partial result; for an open one the message says whether the change is in the open notebook but not yet saved. |
| `open-failed` | The notebook could not be opened in a tab. |
| `export-failed` | The PDF could not be produced. |
| `export-incomplete` | `exportPdf` with `strict: true` and some images could not be loaded. |

```js
try {
  await api.addPages(file, 2, 99);
} catch (e) {
  if (e.name === "NotebookApiError" && e.code === "invalid-argument") new Notice(e.message);
  else throw e;
}
```

## Typings

Copy this into your plugin (or a `.d.ts`) for completion and type checking. `TFile` is Obsidian's.

```ts
import type { TFile } from "obsidian";

type NotebookFileRef = TFile | string | { path: string };
type PaperKind = "blank" | "ruled" | "grid" | "dotted" | "millimetre";
type PageSizeName = "a4" | "a5" | "letter";

interface NotebookApi {
  readonly version: string;
  readonly NotebookApiError: new (code: NotebookApiErrorCode, message: string, details?: Record<string, unknown>) => NotebookApiError;
  createNotebook(folder: string, name: string, options?: CreateNotebookOptions): Promise<NotebookRef>;
  addPages(file: NotebookFileRef, pages: number | PageTemplate, after?: number): Promise<AddPagesResult>;
  insertImage(file: NotebookFileRef, page: number, image: Uint8Array | ArrayBuffer | string, options?: InsertImageOptions): Promise<InsertImageResult>;
  exportPdf(file: NotebookFileRef, options?: { strict?: boolean }): Promise<{ path: string; pages: number; skippedImages: number }>;
  getNotebookInfo(file: NotebookFileRef): Promise<NotebookInfo>;
  openNotebook(file: NotebookFileRef, page?: number): Promise<void>;
  listNotebooks(options?: { folder?: string }): NotebookSummary[];
}

type NotebookApiErrorCode =
  | "invalid-argument" | "not-found" | "not-a-notebook" | "unreadable" | "unsupported-image" | "busy"
  | "changed-elsewhere" | "write-failed" | "open-failed" | "export-failed" | "export-incomplete";

interface NotebookApiError extends Error {
  name: "NotebookApiError";
  code: NotebookApiErrorCode;
  details: Record<string, unknown>;
}

interface CreateNotebookOptions {
  pageSize?: PageSizeName;
  landscape?: boolean;
  paper?: PaperKind;
  pages?: number;
  tags?: string[];
  favorite?: boolean;
  cover?: string;
  open?: boolean;
}

interface NotebookRef { path: string; name: string; id: string; file: TFile }

interface PageTemplate {
  count?: number;
  pageSize?: PageSizeName;
  landscape?: boolean;
  paper?: PaperKind;
  spacing?: number;
  infinite?: boolean;
}

interface AddPagesResult { added: number; firstPage: number; pageCount: number }
interface InsertImageOptions { x?: number; y?: number; width?: number; height?: number }
interface InsertImageResult { elementId: string; assetId: string; page: number }

interface PageInfo {
  number: number;
  id: string;
  width: number;
  height: number;
  paper: { kind: PaperKind; spacing: number };
  infinite: boolean;
  strokes: number;
  textBoxes: number;
  images: number;
  background: "pdf" | "image" | null;
  bookmarked: boolean;
}

interface NotebookInfo {
  path: string;
  name: string;
  id: string;
  formatVersion: number;
  createdAt: string;
  modifiedAt: string;
  pageCount: number;
  pages: PageInfo[];
  tags: string[];
  meta: { favorite: boolean; cover: string; bookmarks: number[] };
  open: boolean;
}

interface NotebookSummary { path: string; name: string; folder: string; mtime: number; size: number; open: boolean }
```

## Templater

A user script (`Scripts/new-lecture.js`, set as *Script files folder* in Templater) that makes a notebook for today's lecture and adds a link to it in the current note:

```js
// Usage in a template: <% await tp.user["new-lecture"](tp, "Physics") %>
module.exports = async (tp, course) => {
  const api = tp.app.plugins.plugins["notebook"]?.api;
  if (!api) return "(Notebook plugin is not enabled)";
  const day = tp.date.now("YYYY-MM-DD");
  try {
    const nb = await api.createNotebook(`Notebooks/${course}`, `${course} ${day}`, {
      paper: "ruled",
      pages: 2,
      tags: [course.toLowerCase(), "lecture"],
    });
    return `[[${nb.path}|${nb.name}]]`;
  } catch (e) {
    return `(could not create the notebook: ${e.message})`;
  }
};
```

## QuickAdd

A QuickAdd *Macro* with a user script that adds pages to the notebook open in the active tab and exports it:

```js
// QuickAdd user script: add 5 ruled pages to the notebook in the active tab, then export a PDF.
module.exports = async (params) => {
  const { app, quickAddApi } = params;
  const api = app.plugins.plugins["notebook"]?.api;
  if (!api) return new Notice("Notebook plugin is not enabled");
  const file = app.workspace.getActiveFile();
  if (!file || file.extension !== "notebook") return new Notice("Open a notebook first");
  try {
    const { firstPage, pageCount } = await api.addPages(file, { count: 5, paper: "ruled" });
    const wantPdf = await quickAddApi.yesNoPrompt("Export a PDF too?", `Added pages ${firstPage}-${pageCount}.`);
    if (wantPdf) new Notice(`Saved ${(await api.exportPdf(file)).path}`);
  } catch (e) {
    new Notice(`Notebook: ${e.message}`, 8000);
  }
};
```

## Dataview

Dataview JS can list notebooks without a companion note, and with companion notes on the plain Dataview query already sees them (`TABLE pages, tags FROM "Notebooks" WHERE notebook-id`):

```js
const api = app.plugins.plugins["notebook"]?.api;
const rows = [];
for (const nb of api.listNotebooks({ folder: "Notebooks" })) {
  const info = await api.getNotebookInfo(nb.path);
  rows.push([dv.fileLink(nb.path), info.pageCount, info.tags.join(", ")]);
}
dv.table(["Notebook", "Pages", "Tags"], rows);
```

## Status

Written and covered by unit tests for the argument checks, the generated documents and the write plan of a closed notebook. Not yet run inside Obsidian or on Android; see `docs/testing.md` (steps A1 to A6).
