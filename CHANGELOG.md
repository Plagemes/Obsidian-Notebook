# Changelog

## Unreleased

Not yet verified on Android hardware (see `docs/testing.md`).

### Added
- **Insert or remove space** (tool *Insert or remove space*, wave p1a): touch a line and drag down to insert space or up to remove it. Everything below the line moves; what no longer fits on its page continues at the top of the next one, and pages are appended when needed (same size and paper as the last page); removing pulls the following content back up and never takes away more than the empty gap, so ink cannot overlap. An infinite page grows instead of overflowing. PDF and image pages are never mixed with their neighbours: nothing moves onto or off such a page, overflow goes to a new blank page next to it. While dragging, the content below the line is shown shifted by the amount that will really be applied. Text boxes and images move with the ink. One undo step.
- **Automatic next page** (setting *Add a page when writing at the bottom*, on by default): ink that reaches the bottom tenth of the last page appends a page with the same size and paper, in the same undo step as the stroke. Not for infinite pages or for pages with a PDF or image background.
- **Selective eraser**: the eraser can be limited to *All ink*, *Highlighter only*, *Pen only* (pen and shapes) or *One colour* (swatches). Works with *Whole stroke*, *Segment* and *Area*.
- **Erase area** (eraser mode *Area*): draw an outline and everything inside disappears in one gesture and one undo step; strokes crossing the outline are cut at it. Setting *Erase area also removes text and images* (off by default).
### Added (Obsidian integration, wave p1b)
- **Page links (O4)**: `[[Physics.notebook#p3]]` opens the notebook at page 3 (the view reads the link subpath through `setEphemeralState`), also when the notebook is already open. Typing `[[Physics.notebook#` lists the pages with their number and first text box (`EditorSuggest`).
- **Native embed (O6)**: `![[Physics.notebook#p3]]` renders the same page preview as the `notebook` code block, in reading view and live preview, and tapping it opens the page. It uses Obsidian's embed registry (not part of the public typings, so feature-detected); if it is missing, a reading-view post-processor is used and live preview keeps the plain embed (use the code block there).
- **File explorer menu (O9)**: *New notebook here* on folders and *Annotate in Notebook* on PDFs (a new notebook in the notebooks folder with the PDF as page backgrounds, reusing the PDF import).
- **Page into a note (O20)**: the page menu has *Copy link to this page*, *Insert link into the active note* and *Insert page preview into the active note* (links follow Obsidian's link-format setting).
- Not verified in Obsidian or on Android hardware (see `docs/testing.md`, step 37).
### Added
- **Favourite pens**: six slots (tool, colour, width) next to the tools, one tap to select, long press or context menu to save the current pen into a slot (or reset it). Stored in the plugin settings.
- **Eraser size**: five presets in the toolbar for both eraser modes, remembered, and a circle that follows the pen (or mouse) while erasing.
- **Pen only** toggle in the toolbar: fingers pan and zoom but do not draw. It is the inverse of the *Draw with finger* setting and stays in sync with it.
- **Commands for hotkeys**: every tool and action as a command that only applies when a notebook is active (pen, highlighter, eraser and its mode and size, lasso, shapes, text, favourite pens 1-6, pen only, next/previous page, delete selection, pages panel, ruler). No default hotkeys.
### Added
- **Instant board shot** (toolbar camera button, command): one tap opens the in-app camera; after the shutter the photo is cropped automatically (the scanner's detection; the whole photo if no outline is found), gets the whiteboard filter and is placed as an image on the page in view, under the last ink, with a small "Board HH:MM" text label. On a page with no room it is scaled down, an infinite page grows, and as a last resort it is centred over the content with a notice. One undo step. Not verified on Android hardware.
- **New lecture** (command, page menu): a small dialog asks for the course or title (default: the notebook name) and the date; a page like the last one is added at the end with the header as a text box, in one undo step. The format has no page titles, so the header is ordinary text.
- **Loose sheet** (command, ribbon icon, library button): a quick-notes notebook opened from anywhere, created on first use in the notebooks folder or at the path set in the new setting *Loose sheet location*; an existing file is never replaced.
- **Move to notebook…** (page menu, command): pick pages and a destination notebook. The destination is saved first (an open notebook: one undo step; a closed file: validated, a backup kept, read back), and only then do the pages leave the source (one undo step); pages edited meanwhile stay. Assets are shared by id, so only their records are copied.
### Added
- **Words and lines without OCR (#255).** With the lasso tool, a **double tap** on handwriting selects the word under it and a **triple tap** the whole line; the result is the normal lasso selection (move, scale, rotate, delete). Words and lines are found geometrically from the strokes (`src/ink/words.ts`); highlighter and shape strokes and oversized strokes (frames, long underlines) are ignored. Taps do nothing to the document: no strokes or dots are created. Not yet verified on Android hardware.

## 0.4.1 — 2026-10-29
### Added
- **Edge rejection zones** (#151): settings *Edge rejection zones* (off by default), *Edge zone width* (4-80 px) and one switch per edge (left, right, bottom on; top off). A touch that starts within that distance of an enabled edge of the page area is ignored: it neither draws nor scrolls, so a palm resting on the edge does nothing. The pen, the mouse and a touch that started inside the area are never affected; the zone never takes more than a third of the shorter side.
- **Radial menu at the pen tip** (#152): pressing the pen's side button opens a ring around the nib with pen, highlighter, eraser, lasso, undo and the last three pen colours. Lift the pen (or tap) on a sector to choose it; releasing the button over a sector also chooses it; tapping elsewhere or Escape closes it. No stroke is drawn. New setting *Pen side button*: radial menu (default), erase while held, or nothing. The eraser end and the eraser button (`buttons & 32`, `button 5`) keep erasing as before.
- **Instant start** (#271): the page being read is saved with the workspace layout, so reopening Obsidian (or going back/forward) shows the same page; new command **Continue last notebook** opens the notebook that was open last on the page that was in view (stored in the plugin settings, never in the notebook file).
- `npm run bench:open`: open-time benchmark of the real view in headless Chrome (10,000 strokes / 10 pages by default), with the phases timed and an emulation of the work the plugin starts on open.

### Changed
- Opening a notebook no longer parses it a second time in the middle of the first paint: the version-history snapshot reads the file at once (so it keeps the content as it was on open) but parses and writes it once the page is on screen and the browser is idle. The stroke-line warm-up of the save check also starts 400 ms after the load. On the PC benchmark (10,000 strokes, 6.8 MB) the first painted frame went from 414 ms to 233 ms and the page the reader wants (page 7 of 10) from 519 ms to 233 ms; measured on desktop Chrome only, not on Android. No save or validation step was changed.
 — 2026-10-29

Hotfix for 0.4.0. Not yet verified on Android hardware.

### Fixed
- **Black page, nothing could be written** (reported on a Samsung tablet with S Pen, dark theme): the page area stayed empty — black in the dark theme — and no tool drew, while the toolbar and the page panel worked. Cause: two merges in the 0.4.0 cycle damaged `styles.css` (the "view wave 2" and "integration P1" sections lost their closing braces and many declarations). Browsers with CSS nesting read the rest of the file as nested rules that never match, so the page container was no longer a flex box: the drawing area had zero height, the canvases were never sized and no pointer event reached them. The two sections are restored from their original commits (embed previews and the page panel's hidden/narrow states were affected too).
- One bad stroke, image, PDF background or text box can no longer stop the page from being drawn: every part of a frame is drawn in its own guard, a failure is skipped and logged once in the console (`[notebook] render …`). If painting wet ink fails, the stroke being written is shown on the regular live layer instead, so the pen always leaves ink. Pointer events are guarded the same way (`[notebook] input …`) and a stroke is always closed when the pen lifts.
- Insert image and Insert image page: HEIF/HEIC photos get the same clear message instead of a generic failure (and are not copied into the vault); sizes are read through the scanner's decoder with its fallbacks.
- Scanner: photos in HEIF/HEIC (Samsung "High efficiency pictures") get a clear message instead of "Could not read this photo"; robust decoding (fallbacks, safe canvas sizes for 12-50 MP photos); in-app camera that always yields JPEG.

### Changed
- New setting **Low-latency ink (experimental)**, **off by default**: the pen's wet-ink canvas asks for a low-latency (`desynchronized`) context and `pointerrawupdate` is listened to only when it is on. On some Android GPUs a low-latency canvas is composited as an opaque layer; off, ink is still painted as each pen event arrives, on a regular canvas, with `pointermove` and coalesced samples. If the low-latency context cannot be created, a regular one is used.

### Development
- Browser harness (`dev/harness/`, `npm run harness`, `npm run harness:check`): the real notebook view on a stand-in for the `obsidian` module, checked headlessly in Chrome on old (v3) and new notebooks, light and dark theme, tablet, phone and desktop viewports with their pixel ratios, synthetic pen input and injected faults, with screenshots and composited-pixel checks. See `docs/testing.md`.
- Unit tests guard `styles.css` (balanced braces, no accidental nesting, the layout declarations) and the new guards and setting.

## 0.4.0 — 2026-10-29 (M3b and M3c)

Not yet verified on Android hardware (see `docs/testing.md`). This release merges the planned 0.4.0 (objects) and 0.5.0 (library, PDF, canvas) of the M3 split.

### Added
- **Library view** (ribbon icon, command **Open library**): folders, favourites, recent, tags, cover colours, thumbnails (also of PDF and image pages), sort by modified, name or created, rename, move (menu or drag and drop), duplicate, delete (to the trash). Search over titles, tags and the text of text boxes, with a snippet and a jump to the page. Notebook metadata and thumbnails are cached in a disposable `library-index.json` in the plugin folder; the notebooks stay the only source of truth.
- **PDFs**: **Import PDF as notebook** (one page per PDF page, page size from the PDF), **Insert PDF after this page** (whole file or a page range), blank pages between PDF pages. Rendered with Obsidian's pdf.js into a bounded bitmap cache; ink stays vector on top. A missing file shows a placeholder and keeps the ink.
- **Scanner**: photo from the device camera or a file, four-corner crop with a loupe and automatic page detection, perspective correction, filters *Original*, *Document* and *Whiteboard*, rotate, retake, several sheets in a row. Into the notebook as pages (**Scan into this notebook**, page menu), as an image (**Insert scan as image**), or as a new notebook (**New notebook from scan**).
- **Assets**: PDFs and images are stored once in `<notebooks folder>/_assets/`, named by the hash of their content, and referenced from the notebook.
- **Page navigator** (Pages panel): thumbnails, tap to jump, drag to reorder, bookmarks and a bookmarks-only filter.
- **Tools**: shapes (line, arrow, rectangle, ellipse) with hold-still recognition of rough lines, rectangles, ellipses and arrows; text boxes; images; ruler placed with two fingers (the pen follows its edge); lasso now selects text boxes and images too; **infinite page** (grows downwards when you write near the bottom).
- **Instant save journal**: changes are recorded within about 200 ms in a plugin-owned journal and replayed when the notebook is opened after a crash or a forced close.
- **Version history**: automatic snapshots (at most one per notebook per 24 h by default, last 10 kept), command **Restore a previous version**; the current content is backed up before a restore.
- **Embeds and links**: a `notebook` code block (or a wikilink form such as `[[Physics#p3]]`) shows a page preview that opens the notebook at that page; command **Insert notebook embed**; `obsidian://notebook?path=…&page=…` links.
- **Writing engine** (wet ink): the stroke being written is painted as each pen sample arrives (`pointerrawupdate` where available, `pointermove` otherwise), only the new part, on its own low-latency canvas. New strokes use a geometry (disc chain on a smooth curve) that is identical while writing and after the pen lifts, so the line no longer jumps at pen-up. The highlighter looks the same while writing and after.
- Export: PDF backgrounds and images are rasterised as JPEG (PDF pages at 200 dpi) and embedded in PDF and SVG exports.
- Settings: *Version history interval*, *Versions to keep*, *Predicted ink*. Commands: **Open library**, **Import PDF as notebook**, **Scan into this notebook**, **New notebook from scan**, **Insert notebook embed**, **Restore a previous version**.
- Italian translation of the new UI.

### Changed
- **File format v4 and v5.** v4 adds notebook `meta`, `assets`, page backgrounds (PDF page or image), text and image elements, infinite pages and the `shape` tool. v5 adds the per-stroke `render` field (1 = the old perfect-freehand look, kept for every existing stroke; 2 = the new ink engine). v3 and v4 files migrate in memory and are rewritten as v5 on the first edit. **Files written by 0.4.0 open read-only in older versions** (with a backup copy).
- Stabilization is an adaptive filter (1€ filter): less jitter at rest and much less lag while writing at the same level (default 2).
- Pressure, real or simulated, is decided at the start of each stroke and never switches in the middle of it.
- *Predicted points* is replaced by *Predicted ink*, **off by default** (predicted samples overshoot at turns and at the end of a stroke).
- Saves, journal entries and thumbnail refreshes wait while the pen writes (and 350 ms after), never longer than a few seconds.
- The notebook container is isolated in one module (`src/storage/format.ts`), so a later move to Markdown (M4) is a contained change.
- Duplicating a notebook gives it a new document id.

### Fixed
- Safety: during continuous writing the journal entry now lands in the first short pen-up gap (120 ms) or after at most 1 s / 1.5 s, instead of up to 4 s / 8 s later; the journal no longer writes while a save of the same revision is in flight (a crash could otherwise turn a "merged" entry into a stale one); a partial erase of a fast curved stroke keeps the curve (inserted points follow the ink geometry, not the chord).
Found by independent reviews of the new data-safety code:
- The journal is keyed per file identity and per session, so two notebooks or two sessions cannot replay each other's entries; an entry that does not match the file on disk is never applied, a copy goes to the backup folder first.
- Recovery works again after a notebook was unreadable and then became readable.
- Assets are verified before a page refers to them.
- Duplicate page ids are rejected on read and on write.
- Restoring a version aborts if the save of the open notebook fails, or if the version belongs to a different notebook.

## 0.3.0 — 2026-10-29 (M3a)

Not yet verified on Android hardware (see `docs/testing.md`). M3 has been split: this release covers pages, paper and export; shapes, text boxes, images and the ruler are planned for 0.4.0 (M3b), the library, PDF import and infinite canvas for 0.5.0 (M3c).

### Safety
- Paper spacing below 0.5 pt is rejected as invalid, and paper patterns are capped, so a hand-edited file cannot freeze the app.
- The page menu re-checks that the notebook is still editable before changing it.

### Added
- Paper kinds per page: blank, ruled (first line below a top margin, red margin line at 25 mm), grid, dotted (a dot at each grid intersection) and millimetre (a major line every 10 mm).
- Page sizes A4, A5 and Letter, portrait or landscape, per page.
- Page menu (three-dot button next to Add page): duplicate, move up, move down, delete, change paper, change size, switch orientation. Every action is one undo step. The only page of a notebook cannot be deleted.
- New-notebook dialog with page size, orientation and paper. The last choice is remembered as the default; the defaults are also in the settings (default paper, default page size, landscape by default).
- Export a page or the whole notebook as PDF, and a page as SVG, from the page menu; **Export notebook as PDF** is also a command. Files are written next to the notebook. The PDF writer has no dependencies and is not compressed. A generated PDF was parsed with pdf.js and a generated SVG rendered with resvg; neither was opened on Android.
- Italian translation of the new UI.

### Changed
- **File format v3**: adds the paper kinds. The v2 to v3 migration only changes the version number. A 0.2 notebook is rewritten as v3 on its first edit. Files written by 0.3 cannot be edited by 0.2.x, which opens them read-only (and keeps a backup copy).
- **Add page** now creates a page with the same size and paper as the page in view (before, always an A4 grid page).
- New notebooks are created with the chosen size, orientation and paper (default: A4 portrait, grid).
- Changing a page size does not move or scale strokes. Strokes outside a smaller page are kept in the file and clipped when drawn and exported.
- On screen, the fine lines and dots of the paper are not drawn when they would be closer than about 3 px.

## 0.2.0 — 2026-10-29 (M2)

Not yet verified on Android hardware (see `docs/testing.md`).

### Added
- Multiple pages stacked vertically (24 pt gap), with a page indicator `n / total` and an undoable **Add page** button and command that inserts a page after the one in view. Only visible pages and strokes are drawn.
- Highlighter tool: 5 colours, 3 widths, constant width, translucent with multiply blending. The pen now has 9 colours and 5 widths.
- Segment eraser (eraser mode **Segment**, next to **Whole stroke**): cuts strokes instead of removing them whole; works across pages in one gesture and is one undo step.
- Lasso selection (a stroke is selected when at least 50% of its points are inside): move, resize (bottom-right handle), rotate (handle above the top edge), delete (toolbar, Delete/Backspace). Escape clears the selection. Each action is one undo step.
- Input stabilization setting (0–10, default 2).
- Palm contact-size filter setting (experimental, off by default).
- One-finger fling (inertial scrolling).
- Performance overlay setting: frame time, input-to-frame time, redraw time, strokes and pages drawn.
- Commands **Run performance benchmark** (off-screen render of a generated 10,000-stroke, 10-page notebook, with copyable results) and **Create stress-test notebook**.
- `npm run bench`: benchmarks of the pure logic on a generated 10,000-stroke notebook.
- Italian translation of the new UI.

### Changed
- **File format v2**: adds the `highlighter` tool. The v1 to v2 migration only changes the version number. A 0.1 notebook is rewritten as v2 on its first edit. Files written by 0.2 cannot be edited by 0.1.x, which opens them read-only (and keeps a backup copy).
- Committed strokes are immutable (frozen). The save check validates each stroke line once and caches it (strokes read from a file are not parsed a second time, and the cache is warmed in the background after opening); documents under 1 MB are still fully re-parsed on every save, larger ones get an incremental check (document skeleton, new strokes, duplicate ids).
- Pan and zoom: while moving a page that is slow to redraw, the existing bitmap is moved with a CSS transform and redrawn 120 ms after the gesture pauses.
- Undo history gained `ReplaceStroke`, `AddPage` and `Batch` commands; an eraser gesture is recorded as one batch.

## 0.1.1 — 2026-10-29

Changes requested by the community directory review.

### Changed
- Settings use Obsidian's declarative settings API on Obsidian 1.13+, so they appear in the settings search. Older versions keep the previous settings tab.
- **Open notebooks** lists only notebooks inside the notebooks folder (and its subfolders) instead of scanning the whole vault. Notebooks elsewhere can still be opened from the file explorer.
- No `!important` in the stylesheet.

### Added
- Releases are built by GitHub Actions with artifact attestations for `main.js`, `manifest.json` and `styles.css`.

## 0.1.0 — 2026-10-29 (M1, MVP)

First development version. Not yet verified on Android hardware (see `docs/testing.md`).

### Added
- "Notebooks" section: ribbon icon, **New notebook** and **Open notebooks** commands, settings tab.
- `.notebook` file format v1 (versioned JSON, coordinates in pt, points `[x, y, pressure]`), with validation, deterministic serialization and a test migration from v0.
- A4 grid page fitted to the view width; basic pan, pinch zoom, wheel and Ctrl+wheel zoom.
- Pen input with Pointer Events: coalesced events, optional predicted points, pressure with simulated fallback, basic palm rejection, optional finger drawing.
- Pen with 4 colours and 3 widths, whole-stroke eraser, command-based undo/redo.
- Autosave with debounce and max wait; flush on view close, file switch, plugin unload, `visibilitychange` and `pagehide`.
- Data safety: re-validation before every write, unreadable files never overwritten and backed up, newer format versions opened read-only, conflict backups taken before overwriting a file changed on disk, retries on close with an "unsaved" backup as last resort, deleted files never rewritten.
- English UI with Italian translation.
- Build check that `main.js` requires nothing but `obsidian`; stress-notebook generator script.
- Requires Obsidian 1.8.7 or later. Follows the community plugin guidelines (checked with eslint-plugin-obsidianmd).
