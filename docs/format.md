# The `.notebook` file format (version 20)

This guide is for people who write tools that read (or carefully write) Notebook files: converters, search indexes, viewers, backup scripts. The machine-readable contract is the JSON Schema [`docs/schema/notebook-v20.schema.json`](schema/notebook-v20.schema.json) (draft 2020-12). The reasoning behind the format and the full history of every field is in [architecture.md](architecture.md), section 2.

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
| `version` | integer, currently `20` |
| `id` | document id; survives renames and "Make a copy" |
| `createdAt`, `modifiedAt` | ISO times |
| `meta` | `tags`, `favorite`, `cover` (colour), `bookmarks` (page ids), optional `bookmarkInfo`, `description`, `coverArt` |
| `position` | optional: where the notebook was last read (`page`, `y`, `at`) |
| `slides` | optional: PDF pages that were shown beside the notes (`Stroke.slide` points here) |
| `assets` | `{ [id]: { id, kind: "pdf" or "image", path, name, bytes } }`, the files in `_assets/` |
| `pages` | at least one page |

A page has `id`, `width`, `height`, `paper` (`kind`, `spacing`), `strokes`, and optionally `background` (a PDF page or an image), `margins`, `infinite`, `tags`, `locked`, `startAt` and `endAt` (v19: when the first and the last ink or element were added to the page, written together), `states`, `comments`, `elements`.

A **stroke** is vector ink: `id`, `tool` (`pen`, `highlighter`, `shape`, and from v20 `fountain`, `brush`, `marker`), `color`, `width` (pt), `render` (`1` or `2`: which geometry draws it), and `points`, a list of `[x, y, pressure]` with pressure in 0..1. Optional: `hidden`, `slide`, `group`, and (v20, fountain pen and marker only) `nib`, the angle of the nib in whole degrees (0..179, counter-clockwise on the page; absent means 45). The new pens are always `render: 2`. The plugin draws the outline of a stroke with the perfect-freehand algorithm (for `render: 1` with the frozen parameters in architecture.md); a tool that only needs the ink can draw a polyline through the points with a width scaled by pressure. Highlighter strokes are translucent (alpha 0.35, multiply) and constant width. Marker strokes are constant width, 85% opaque and painted in stroke order (above the ink written before them); a fountain pen or marker line is thinner where it runs along the nib and wider across it; a brush line is thinner for light pressure and fast movement. These widths are drawn by the plugin from the points, not stored: a tool that only needs the ink can use `width` as the line width.

**Elements** (`page.elements`, drawn above the background and below the ink, in list order) have a `type`:

| `type` | What it is |
|---|---|
| `text` | text box (`x`, `y`, `width`, `text`, `fontSize`, `color`) |
| `image` | a picture from `assets`, with `rotation` in radians |
| `marker` | a small badge: `gap`, `question`, `important`, `critical`, `star`, `homework` |
| `box` | labelled frame: `definition`, `theorem`, `example`, `proof`, `remark` |
| `equation` | LaTeX source plus an optional cached vector `outline` (`M`, `L`, `Z` path) |
| `graph` | function graph: view, up to 12 functions (expressions are strings), parameters, table |
| `excerpt` | a region of a page of this or another notebook, with an optional PNG snapshot asset |
| `sticky` | coloured note with text; ink written on it is ordinary page ink |
| `checkbox` | handwritten checkbox, optionally linked to a task line of a note |

Every element may also carry `group`, `locked` and `lockAt` (v18).

Rules a JSON Schema cannot say (the plugin enforces them when it writes and checks them when it reads):

- Ids of strokes and elements are **unique across the whole document**; page ids are unique; comment ids are unique within their page.
- `assets` keys equal the asset `id`; a page `background`, an `image` element, an `excerpt.asset` and `meta.coverArt` of kind `image` must name an asset of the right kind.
- A **group** is two or more strokes/elements of one page with the same `group` id (the id is scoped to the page). A lone member is never written.
- `states.parts[].items`, `states.list[].poses[].part`, `states.active`, a collapsed sticky note's `ink` and `Stroke.slide` refer to ids that must exist (strokes of the same page, parts, states, entries of `slides`).
- `margins.left + margins.right < width` and `margins.bottom < height`.
- Graph function ids and parameter names are unique within the graph; `table.fn` names one of its functions.
- A page has `startAt` and `endAt` both or neither, and `endAt` is not before `startAt`.
- A comment is either a note (`region`, optional `sketch`/`resolved`) or a reply (`parent` names a note, never another reply); replies have text.

## Versioning and migrations

- `version` is an integer that grows with every schema change. Every change adds a tested migration (`src/model/migrations.ts`), and every older valid document stays valid after migration (most steps are "the identity plus the new version number").
- Newer fields are always **optional** and written only when used; the version of a file is the version of the plugin that last saved it. v20 added the fountain pen, the brush and the marker (three more `tool` values) and the nib angle of a stroke; v19 added the start and end time of a page; v18 groups and locks; v17 checkboxes; v16 margin comments; v15 sticky notes; v14 page lock; v13 states; v12 slides; v11 description and cover art; v10 excerpts; v9 equations and graphs; v8 markers, boxes and hidden ink; v7 bookmark details, page tags, reading position and more paper kinds; v6 margins; v5 the per-stroke `render`; v4 metadata, assets, backgrounds and elements. The table of what each version added is in architecture.md.
- **This schema describes version 20 only.** A file with another `version` is not valid against it. The schema file name carries the version (`notebook-v20.schema.json`); a future format version ships its own schema next to this one, and older schemas stay available in the repository history.
- A plugin never rewrites a file of a **newer** version than it understands: it opens it read-only and keeps a backup copy in `<notebooks folder>/_backup/`. A tool that writes notebooks should follow the same rule: never save a file whose `version` it does not know.

## Reading leniently

The plugin itself reads in two modes, and a third-party reader should do the same:

1. **Parse and check `format` and `version`.** Not `"obsidian-notebook"` means "not a notebook". A higher `version` than you support means "newer notebook": show it read-only or refuse it, never edit it.
2. **Ignore unknown fields.** Objects are open: fields you do not know (from a newer version of the plugin, or another tool) must be skipped on read and, if you write, kept.
3. **Treat optional details as optional.** A marker with a bad due date, a graph function that does not parse, a bookmark with a strange colour or a comment outside the page should lose that detail only, not make the whole notebook unreadable. The plugin counts such things as "dropped" and keeps a backup before it overwrites them. Required data (a stroke's points, an element's frame) that is invalid means that object is skipped.
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
	"version": 20,
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
schema = json.load(open("docs/schema/notebook-v20.schema.json"))
doc = json.load(open("Physics.notebook"))
jsonschema.Draft202012Validator(schema).validate(doc)
```

The schema is deliberately open (unknown fields pass) and says what the plugin writes. A file that fails it was either written by a different version or has been damaged or edited by hand; the plugin's own reader is a little more forgiving than the schema for optional details (see above).
