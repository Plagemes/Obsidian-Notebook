# The `.notebook` file format (version 28)

This guide is for people who write tools that read (or carefully write) Notebook files: converters, search indexes, viewers, backup scripts. The machine-readable contract is the JSON Schema [`docs/schema/notebook-v28.schema.json`](schema/notebook-v28.schema.json) (draft 2020-12). The reasoning behind the format and the full history of every field is in [architecture.md](architecture.md), section 2.

A schema file is also kept in the test suite: `tests/format-schema.test.ts` validates real serializer output (a document that uses every element type and every optional field) against it, and checks that invalid documents are refused. If the plugin changes the format, that test fails until the schema is updated.

## File layout

- A notebook is **one UTF-8 JSON file** with the extension `.notebook`, anywhere under the notebooks folder of the vault (the folders are real folders; a folder is a subject).
- The file is written by the plugin with a fixed key order and **one stroke, one element, one comment and one asset per line**, tab-indented. It is ordinary JSON: parse it with any JSON parser, do not rely on the line layout.
- Units are **typographic points** (1/72 inch), origin at the **top left** of the page, y grows downwards. A4 is 595.28 x 841.89. Strokes and elements use **page coordinates**, never screen coordinates. Pages are stacked vertically by the viewer; their coordinates are not related to each other.
- Colours are `#rrggbb`. Times are ISO 8601 strings (`createdAt`, `modifiedAt`, `position.at`, `marker.at`) or integers in milliseconds since 1970 (comments, `lockAt`, checkbox `at`/`taskAt`, page `startAt`/`endAt`). Booleans that mean "on" are written **only when true** (`hidden`, `locked`, `done`, `checked`, ...): absent means false.

Top level:

| Field | Meaning |
|---|---|
| `format` | always `"obsidian-notebook"` |
| `version` | integer, currently `28` |
| `id` | document id; survives renames and "Make a copy" |
| `createdAt`, `modifiedAt` | ISO times |
| `meta` | `tags`, `favorite`, `cover` (colour), `bookmarks` (page ids), optional `bookmarkInfo`, `description`, `coverArt` |
| `position` | optional: where the notebook was last read (`page`, `y`, `at`) |
| `slides` | optional: PDF pages that were shown beside the notes (`Stroke.slide` points here) |
| `views` | optional (v21): the saved views, in list order: `{ id, name, page, x, y, width, height, zoom }` (see below) |
| `sections` | optional (v28): the coloured sections (tab dividers) of the notebook: `{ id, title, color, page }`, each anchored to the id of the page it starts at (see below) |
| `assets` | `{ [id]: { id, kind: "pdf" or "image", path, name, bytes } }`, the files in `_assets/` |
| `pages` | at least one page |

A page has `id`, `width`, `height`, `paper` (`kind`, `spacing`), `strokes`, and optionally `background` (a PDF page or an image), `margins`, `infinite`, `tags`, `locked`, `startAt` and `endAt` (v19: when the first and the last ink or element were added to the page, written together), `states`, `comments`, `elements`.

A **stroke** is vector ink: `id`, `tool` (`pen`, `highlighter`, `shape`, and from v20 `fountain`, `brush`, `marker`), `color`, `width` (pt), `render` (`1` or `2`: which geometry draws it), and `points`, a list of `[x, y, pressure]` with pressure in 0..1. Optional: `hidden`, `slide`, `group`, (v22, `shape` strokes only) `fill` (`#rrggbb`: the colour a CLOSED shape, one that ends where it starts, is filled with, painted under the line), `fillTint` (`true`: the fill is a translucent tint, alpha 0.25, instead of solid; needs `fill`) and `dash` (`"dashed"` or `"dotted"`: the line is cut into runs by arc length, a dash is three line widths long with a gap of three, a dot every two widths; absent means solid), and (v20, fountain pen and marker only) `nib`, the angle of the nib in whole degrees (0..179, counter-clockwise on the page; absent means 45), and (v24, any pen) `opacity`, a number from 0.05 to 1 that multiplies the translucency the pen has without it (the highlighter's 0.35, the marker's 0.85, the tint of a fill; absent means full strength, the look of every earlier version; the plugin writes it only below 1), and (v25, the pen, the fountain pen and the brush, `render: 2` only) `taperStart` and `taperEnd`, numbers from 0.05 to 1 that say how much the line thins towards its first and its last point: the taper is a length of `value * 12` line widths (so a setting looks the same on a fine and on a broad pen), but never more than half of the stroke's length, over which the radius of the line grows from 4 % at the very tip to the full size along an ease-out curve (`t * (2 - t)`); absent means no taper, the look of every earlier version, and the plugin writes a key only for an end that is tapered. The highlighter, the marker and shapes never have one (their ends stay flat). A cut of the stroke (the eraser, a redaction) leaves a taper only on the piece that still reaches that end. The new pens are always `render: 2`. The plugin draws the outline of a stroke with the perfect-freehand algorithm (for `render: 1` with the frozen parameters in architecture.md); a tool that only needs the ink can draw a polyline through the points with a width scaled by pressure. Highlighter strokes are translucent (alpha 0.35, multiply) and constant width. Marker strokes are constant width, 85% opaque and painted in stroke order (above the ink written before them); a fountain pen or marker line is thinner where it runs along the nib and wider across it; a brush line is thinner for light pressure and fast movement. These widths are drawn by the plugin from the points, not stored: a tool that only needs the ink can use `width` as the line width.

**Elements** (`page.elements`, drawn above the background and below the ink, in list order) have a `type`:

| `type` | What it is |
|---|---|
| `text` | text box (`x`, `y`, `width`, `text`, `fontSize`, `color`) |
| `image` | a picture from `assets`, with `rotation` in radians and (v24) an optional `opacity` from 0.05 to 1 (absent means opaque) |
| `marker` | a small badge: `gap`, `question`, `important`, `critical`, `star`, `homework` |
| `box` | labelled frame: `definition`, `theorem`, `example`, `proof`, `remark` |
| `equation` | LaTeX source plus an optional cached vector `outline` (`M`, `L`, `Z` path) |
| `graph` | function graph: view, up to 12 functions (expressions are strings), parameters, table |
| `excerpt` | a region of a page of this or another notebook, with an optional PNG snapshot asset |
| `sticky` | coloured note with text; ink written on it is ordinary page ink |
| `checkbox` | handwritten checkbox, optionally linked to a task line of a note |
| `area` | area highlighter (v23): a translucent axis-aligned rectangle `x`, `y`, `width`, `height` in a highlighter `color`, drawn under the ink, with an optional `opacity` (v24, 0.05 to 1) that multiplies the highlighter's own translucency; a file older than v23 that holds one is refused, like any element type before its version |
| `tape` | study tape (v27): an **opaque** axis-aligned rectangle `x`, `y`, `width`, `height` (each side 4 to 20000 pt) in a tape `color`, drawn above all the ink and every other element, that hides what is under it. Whether a tape is revealed is **never stored** (it is view-only and every tape is covered again when the notebook opens): a reader shows every tape covering. A tape has no `opacity` and never rotates; a file older than v27 that holds one is refused. A tape is a **visual study aid, not redaction**: what it covers stays in the file, and exports draw the tape over it ("Study tapes only cover content visually; text under them can still be found in exported files. Use Redact to remove content from exports.") |

Every element may also carry `group`, `locked` and `lockAt` (v18).

A **PDF background** is `{ "kind": "pdf", "asset", "page" }` and, from v26, optionally `rotate` and `crop`: the page shows a turned and/or cropped part of the PDF page.

- `rotate` is `90`, `180` or `270`: degrees **clockwise**, on top of the rotation the PDF page already has (its own `/Rotate`, which every PDF reader applies). Absent means upright; the plugin never writes `0`.
- `crop` is `{ "x", "y", "width", "height" }` in PDF points of the page as a reader draws it upright at scale 1 (origin top-left, y down; the page's size is `PdfStore.pageSizes`, not stored in the file). Sides are at least 16 and no value is above 14400. The crop is applied first and the rotation second: the page shows the cropped rectangle, turned. Absent means the whole PDF page. A reader clamps a crop to the PDF page it is applied to (a crop kept for another version of the PDF never shows nothing: if what is left is a sliver, the whole page is shown).
- The page keeps its own `width`/`height`/`margins` as before: the background box (`margins.left`, 0, `width - left - right`, `height - bottom`) holds the *shown* part, scaled to fill it; a page made from a PDF is exactly as large as the shown part (in pt), so one PDF point is one page point. The ink, elements, areas, comment regions and the pivots and poses of states are in page coordinates and are carried with the PDF when the view changes (a quarter turn and a translation: the writer does this in one undo step, a reader never has to), so they stay on the same part of the PDF. Text boxes, equations, graphs, sticky notes and checkboxes (which have no rotated form) keep their orientation and size and only their centre goes where it would go.
- Ink that would end up beyond the left, right or bottom edge of the new page is **kept visible**: the margins grow to hold it. Ink that would end up above the top edge (a page has no top margin) stops the change (nothing is changed, nothing is lost). Comment regions are kept inside the page (moved to the nearest edge).
- A *view-only* option of the plugin ("Crop PDF margins": the white margins of the PDF fall off screen) is separate and writes nothing: it finds the white margins **inside** what the page shows, so it combines with a stored crop (the stored crop first, the view-only fit within it).

Rules a JSON Schema cannot say (the plugin enforces them when it writes and checks them when it reads):

- Ids of strokes and elements are **unique across the whole document**; page ids are unique; comment ids are unique within their page.
- `assets` keys equal the asset `id`; a page `background`, an `image` element, an `excerpt.asset` and `meta.coverArt` of kind `image` must name an asset of the right kind.
- A **group** is two or more strokes/elements of one page with the same `group` id (the id is scoped to the page). A lone member is never written.
- `states.parts[].items`, `states.list[].poses[].part`, `states.active`, a collapsed sticky note's `ink` and `Stroke.slide` refer to ids that must exist (strokes of the same page, parts, states, entries of `slides`).
- `margins.left + margins.right < width` and `margins.bottom < height`.
- Graph function ids and parameter names are unique within the graph; `table.fn` names one of its functions.
- A page has `startAt` and `endAt` both or neither, and `endAt` is not before `startAt`.
- Saved views (`views`): at most 100, ids unique, `name` 1 to 80 characters, trimmed, on one line, with single spaces; `x`, `y`, `width`, `height` are the region of the page `page` that was in view, in page coordinates (pt); `zoom` is the scale relative to the fit-to-width scale of that page (1 = the page fills the width). `page` may name a page the notebook no longer has: the view is then shown as missing and can be removed, and works again if the page returns.
- Sections (`sections`, v28): at most 200, ids unique (at most 64 characters), `title` 1 to 60 characters, trimmed, on one line, with single spaces, `color` a `#rrggbb` colour, and **no two sections name the same `page`**. A section runs from its page to the page before the next page (in page order) that starts a section; pages before the first one belong to no section. The list order does not matter for the reader (the page order decides). `page` may name a page the notebook no longer has: the section is then dormant (shown nowhere, kept in the file) and comes back if the page returns. When the plugin deletes the page a section starts at, the section moves to the next page, or is removed if that page starts a section of its own; when pages are moved, a page that did not move keeps its section: a section whose first page moved away while some of its pages stayed starts at the first page that stayed, a section whose pages all moved goes with exactly those pages, a moved page that is not a whole section takes the section of the page before it, and when a moved block lands inside another section, that section's pages after the block keep its title and colour through a new *continuation* section (no continuation when the list is full: they then join the section before them). Two sections with the same title and colour that a move makes neighbours become one. Pages in no section can only be at the start of the notebook, so a section moved in front of them takes them in. A reader that does not know sections can ignore them: they never change what a page holds. Unknown fields inside a section are not written back; a lenient read counts them as dropped (one per section), so the plugin keeps a backup of the file before the first save that loses them. A `sections` key in a file older than v28 is dropped by the migration (no version before 28 gave it a meaning).
- A comment is either a note (`region`, optional `sketch`/`resolved`) or a reply (`parent` names a note, never another reply); replies have text.

## Versioning and migrations

- `version` is an integer that grows with every schema change. Every change adds a tested migration (`src/model/migrations.ts`), and every older valid document stays valid after migration (most steps are "the identity plus the new version number").
- Newer fields are always **optional** and written only when used; the version of a file is the version of the plugin that last saved it. v28 added the coloured sections (the notebook-level `sections` list); v27 added the study tape (the element type `tape`); v26 added the optional `rotate` and `crop` of a PDF page background; v25 added the optional `taperStart` and `taperEnd` of a pen, fountain pen or brush stroke; v24 added the optional `opacity` of a stroke, an image and an area; v23 added the area highlighter (the element type `area`); v22 added the fill and the line style of shapes (`fill`, `fillTint`, `dash` of a stroke); v21 added the saved views (the notebook-level `views` list); v20 added the fountain pen, the brush and the marker (three more `tool` values) and the nib angle of a stroke; v19 added the start and end time of a page; v18 groups and locks; v17 checkboxes; v16 margin comments; v15 sticky notes; v14 page lock; v13 states; v12 slides; v11 description and cover art; v10 excerpts; v9 equations and graphs; v8 markers, boxes and hidden ink; v7 bookmark details, page tags, reading position and more paper kinds; v6 margins; v5 the per-stroke `render`; v4 metadata, assets, backgrounds and elements. The table of what each version added is in architecture.md.
- **This schema describes version 28 only.** A file with another `version` is not valid against it. The schema file name carries the version (`notebook-v28.schema.json`); a future format version ships its own schema next to this one, and older schemas stay available in the repository history.
- A plugin never rewrites a file of a **newer** version than it understands: it opens it read-only and keeps a backup copy in `<notebooks folder>/_backup/`. A tool that writes notebooks should follow the same rule: never save a file whose `version` it does not know.

## Reading leniently

The plugin itself reads in two modes, and a third-party reader should do the same:

1. **Parse and check `format` and `version`.** Not `"obsidian-notebook"` means "not a notebook". A higher `version` than you support means "newer notebook": show it read-only or refuse it, never edit it.
2. **Ignore unknown fields.** Objects are open: fields you do not know (from a newer version of the plugin, or another tool) must be skipped on read and, if you write, kept. The plugin itself does not keep them: it writes exactly what its schema allows. It can do so because a newer format always raises `version` (so the plugin never rewrites a file that may hold fields it does not know of a newer plugin); fields added by another tool or by hand are lost on the plugin's next save. Inside a section (v28) they are also counted as dropped, so a backup is kept first.
3. **Treat optional details as optional.** A marker with a bad due date, a graph function that does not parse, a bookmark with a strange colour or a comment outside the page should lose that detail only, not make the whole notebook unreadable. The plugin counts such things as "dropped" and keeps a backup before it overwrites them. Required data (a stroke's points, an element's frame) that is invalid means that object is skipped. A stroke whose `tool` name this version does not know is read as a `pen` and counted the same way (the ink is kept and a backup is made); the strict write never accepts such a name, and the next save writes `pen`. An `opacity` outside 0.05 to 1 is clamped to that range, and one that is not a number is dropped (the item is then drawn at full strength), each counted the same way; the strict write refuses both. A `taperStart` or `taperEnd` outside 0.05 to 1 (0 included), one that is not a number, and one on a stroke that cannot taper (a highlighter, a marker, a shape, or a pen of `render: 1`) is dropped and counted the same way (that end is then not tapered; the stroke and every other field stay); the strict write refuses all of them. A background `rotate` that is not `90`, `180` or `270` (`0` included) and a `crop` that is not four finite numbers (`x`, `y` from 0; `width`, `height` from 16; none above 14400) are dropped and counted the same way (the PDF page is then shown as before; the background itself stays); the strict write refuses both. An `opacity` of exactly 1 is valid and kept: it is read and written back as it is, means full strength like an absent one and is not counted as dropped (the plugin itself never writes it, so it appears only in files written by hand or by another tool).
4. **Do not trust references.** An asset id may point at a file that has not synced yet, a `slide` may name no entry, a group may have one member. Draw what you can.
5. **Old files:** if you want to read older versions, the fields only get added; an absent optional field simply means "not used". Stroke `render` is absent before v5 and means `1`.

If you **write** a notebook, write exactly what the schema allows, keep ids unique, round `x`/`y` to 0.01 and pressure to 0.001, and never overwrite a file you could not read. Prefer producing a new `.notebook` file to modifying an existing one that the plugin may have open (sync clients and the plugin both write the file).

## Files next to the notebooks

All of these live under the notebooks folder (a setting, `Notebooks` by default). They are plugin data, not part of the document format; only `_assets` is needed to read a notebook.

| Path | What it holds |
|---|---|
| `_assets/<id>.<ext>` | the files `assets` refers to. **Content-addressed**: `<id>` is a hash of the bytes, so one file is shared by every notebook that uses it (PDFs, pictures, excerpt snapshots, cover pictures). `assets[id].path` is the vault path when stored; if the file moved, look it up by id. |
| `_meta/` | small JSON files with library data (folder look, device lists, quick tabs, collections, practice state, ...). Several are **one file per device** (`<name>-<device>.json`) and merged on read. They are read leniently and unknown fields are kept; do not rely on them. |
| `_backup/` | raw copies of files the plugin could not read or write safely (`.bak`). |
| `_trash/`, `_templates/` | removed pages and notebook templates. |
| companion notes | optional Markdown notes the plugin writes beside a notebook so Obsidian search and graph see it. They are generated from the notebook: the notebook is the source of truth. |

## Minimal example

```json
{
	"format": "obsidian-notebook",
	"version": 28,
	"id": "6f1c2d3e-0000-4000-8000-000000000001",
	"createdAt": "2026-11-05T09:00:00.000Z",
	"modifiedAt": "2026-11-05T09:05:00.000Z",
	"meta": {"tags":[],"favorite":false,"cover":"#3b82f6","bookmarks":[]},
	"assets": {},
	"pages": [
		{
			"id": "a91e0000-0000-4000-8000-000000000002",
			"width": 595.28,
			"height": 841.89,
			"paper": {"kind":"grid","spacing":14.17},
			"elements": [
				{"id":"e1","type":"text","x":72,"y":60,"width":300,"text":"Lecture 1","fontSize":18,"color":"#1e293b"}
			],
			"strokes": [
				{"id":"c03d0000-0000-4000-8000-000000000003","tool":"pen","color":"#1e293b","width":2,"render":2,"points":[[72.5,90.12,0.512],[73.1,90.4,0.534],[80,95.5,0.6]]}
			]
		}
	]
}
```

This file validates against the schema. Pen strokes can be drawn as a polyline through `points`; text boxes wrap at `width`; the grid is paper (`spacing` pt between lines), not content.

## Validating with the schema

Any draft 2020-12 validator works, for example with Python:

```python
import json, jsonschema
schema = json.load(open("docs/schema/notebook-v28.schema.json"))
doc = json.load(open("Physics.notebook"))
jsonschema.Draft202012Validator(schema).validate(doc)
```

The schema is deliberately open (unknown fields pass) and says what the plugin writes. A file that fails it was either written by a different version or has been damaged or edited by hand; the plugin's own reader is a little more forgiving than the schema for optional details (see above).
