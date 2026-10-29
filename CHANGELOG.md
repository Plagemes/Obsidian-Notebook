# Changelog

## Unreleased

### Added
- **Class timetable** (roadmap 115). Define your weekly classes (course, weekday, start and end time, room, a linked notebook or course folder, alternating odd/even weeks, term start and end dates) from *Settings, Class timetable, Edit timetable* or the command **Edit class timetable**. Stored in the plain JSON file `<notebooks folder>/_timetable.json` (human-editable, syncs like any file; an unreadable file is never overwritten, a copy goes to `_backup/` before it is replaced). Times are local; overlapping classes are flagged in the editor.
  - Opening Obsidian or the library during a class (or up to a few minutes before, setting *Count a class as started this many minutes early*) shows a notice with **Open lecture page**; setting *Open it without asking* does it by itself. The class's notebook opens with a new lecture page (header: course and date, as in New lecture); if that page already exists it is shown instead. With no linked notebook, the one named like the course is used, else a new one is created. Command **Open the current class** does the same on demand.
  - **New lecture** prefills the course from the class in progress (the one linked to the open notebook, else one linked to nothing).
  - The library shows a **Now: <course>** shortcut while a class is in progress.
  - Tagging pages with the course waits for page tags: the hook `applyCourseTag` in `src/timetable/page-tag.ts` is called but does nothing yet. No document format change.
  - Not yet verified on Android hardware.
- **Synchronised PDF and notes view** (#106): command **Open PDF side by side** (also in the "…" page menu) shows a PDF beside the notes: a plain `.pdf` of the vault (read-only, rendered with pdf.js, not copied into the notebook) or another notebook whose pages have PDF backgrounds (its pages with your ink on them). The split is inside the notebook view, not a second Obsidian leaf, because Obsidian on phones and tablets has no split panes in the main area: side by side when the view is wide and landscape, stacked otherwise, with a draggable divider. Turning the PDF page shows the notes page linked to it; scrolling the notes shows the PDF page linked to the notes page in view (toggle **Follow**). A slide without a notes page shows **Add notes page for this slide**: it inserts a page in slide order as one undo step and links it. Also **Link** / **Unlink** for existing pages, commands *Close PDF side by side*, *Link this page to the slide in view*, *Add notes page for this slide*, and the menu entry *Show the slide of this page*. The links are stored in a small file in the plugin's folder (`pdf-links.json`, keyed by notebook id and page id, and by the PDF's content id and page number, so renaming the PDF does not break them), written only by these explicit actions and never while scrolling; the notebook format is unchanged. A links file that cannot be read is never overwritten. The pane shows one PDF page at a time and is not remembered across restarts. Not yet verified on Android hardware.
Not yet verified on Android hardware (see `docs/testing.md`, steps K1-K7).

### Added
- **Lecture pack**
  - **New lecture from slides…** (#191; command, library button and folder menu): choose the course slides PDF (vault or device), then the layout, a header (page, text or none), the course and the date. The lecture notebook is created in the folder and opened, with the slides as page backgrounds; the PDF is stored once like any import.
  - **Slide + notes layout** (#192): one slide per page with a ruled (or other) notes area on the right or below the slide, made with page margins, so there is no format change. The slide is scaled to a fixed size so handwriting has the same scale in every course. Two or three slides per page are not possible yet: they need a format change (documented in `docs/architecture.md`).
  - **Notes page after every slide** (#193): optional blank page of the same size and the paper of your choice after each slide.
  - **Exercise page here** (page menu, toolbar … menu, command): one tap inserts a blank page with your exercise paper (grid by default, changeable with *Exercise page paper…*) right after the current page, the same size as that page; one undo step.
  - The same layout options appear when you insert a PDF into an existing notebook (page menu → *Insert PDF*); the last choice is remembered on the device.
Not yet verified on Android hardware (see `docs/testing.md`, steps G1-G6). No change to the document format or to the writing engine (sampling, wet ink, geometry, stabilizer).

### Added
- **Gestures (wave 0.6)**
  - **Finger taps** (roadmap 3): a tap with two fingers undoes, with three fingers redoes (setting *Finger taps*: two undo / three redo, swapped, or off; on by default). A tap needs all fingers to land within 150 ms, move at most 12 px, lift within 150 ms and finish within 350 ms, so panning and pinching never trigger it; touches while the pen is near (palm rejection time), palm-sized or edge-zone contacts, and a pen touching in the middle spoil it. The few pixels the view may have moved are put back, and a tap leaves no ink. A finger that lands among fingers that are already panning or pinching no longer starts a stroke (also with *Draw with finger*).
  - **Scribble to erase** (roadmap 4, setting, off by default): a fast back-and-forth scratch with the pen over existing ink deletes the strokes it crosses; the scribble is not kept and the whole thing is one undo step. Detector in `src/ink/scribble.ts`: at least four direction reversals between legs of 12 pt or more, roughly parallel, mostly piled up instead of travelling along a line (so "mmm" and sweeping zig-zag shading do not count), under 300 ms per leg on average; a stroke is deleted when at least two different legs cross it, and very large strokes (rulings, frames) are left alone. Off by default because a false positive deletes ink.
  - **Auto-scroll while writing** (roadmap 36, setting, off by default): when a stroke ends in the bottom 18 % of the view, the page scrolls up smoothly (320 ms, ease-out) after a 700 ms pause so the tip sits at 40 % of the height. It never moves while a pen or finger is down; a touch cancels it; it stops at the end of the document.
  - **Pen side button** (roadmap 2): the setting *Pen side button* gains *Lasso while held* and *Previous tool while held* (the tool used before the current one; the eraser if there is none). The tool is chosen when the pen touches down. The default stays *Radial menu*. A selection made with the lasso option stays after the button is released and is cleared when you write.
Not yet verified on Android hardware (see `docs/testing.md`, steps L1-L10).

### Added
- **Library trash** (#160): deleting a notebook or a folder (now also a non-empty one) from the library moves it to `<notebooks folder>/_trash/` and remembers its original path. *Trash* in the library sidebar lists the items; *Restore* puts an item back where it was, or under `Name 2` if the name is taken; *Delete permanently* and *Empty trash* ask first (permanent deletion follows Obsidian's *Deleted files* setting). New setting *Empty the trash automatically* (days, default off). The trash is invisible to the library, search, companion notes and conflicted-copy detection; assets are never deleted, so those used only by trashed notebooks stay.
- **Page trash** (#26): *Delete page* keeps the page in `_trash/pages/<notebook id>.json` (not in the notebook format; assets by id). Page menu *Deleted pages...* lists them with thumbnails and restores one after the page that preceded it as one undo step. At most 50 pages per notebook, 30 days.
- **Page templates** (#74): page menu *Save page as template...* (content, paper, size, background) stores a small notebook file in the templates folder (setting *Templates folder*, default `_templates` in the notebooks folder); *New page from template...* and a *Template* row in the *New notebook* dialog open a gallery with thumbnails, including built-in Cornell, meeting notes and to-do templates.
- **Objects (wave 0.6)** (not verified on Android hardware; no change to the notebook format)
  - **Ink attached to objects** (#149): ink written over an image or a text box moves, scales and rotates with it. When the object is moved, scaled or rotated with the lasso (or its handles), the strokes with at least 60% of their points inside the object's box go with it, in the same undo step, and are shown moving during the drag. The link is geometric (nothing is stored in the file); where objects overlap, ink belongs to the topmost one. New setting *Ink follows objects* (on by default). Deleting an object that has ink on it shows a notice with *Delete the ink too* (its own undo step); ignoring it keeps the ink. Logic in `src/ink/attach.ts`.
  - **Personal stamps** (#142): *Stamps* in the toolbar's more menu opens a palette with three built-in stamps (checkmark, star, arrow, drawn with the current pen colour and width) and your own. *Save selection as stamp* stores the lasso selection (strokes, text boxes and images) as `<notebooks folder>/_stamps/<name>.stamp`, a vault file in the notebook document format (one page), so stamps sync with the vault and not with the plugin settings; images are referenced by their content-addressed asset, as in a notebook. Tap a stamp to put it in the middle of the page in view, or drag it onto the page; placed stamps get new ids, are selected so they can be moved at once, and are one undo step. Stamps can be renamed and deleted (to the trash, after a confirmation); a stamp file that cannot be read is listed as unreadable and never rewritten. Logic in `src/ink/stamps.ts`, vault access in `src/storage/stamps.ts`.
Not yet verified in Obsidian or on Android hardware (see `docs/testing.md`, steps A1 to A6).

### Added
- **Shared tags (O2)**: the tag editor of the library (*Edit tags…*) and the new command *Edit tags of this notebook…* suggest the tags that already exist in your vault (the Tags pane), write tags the way Obsidian does (no `#`, spaces become `-`, `a/b` is a nested tag; a tag of only digits is refused with a message) and show the chosen tags as chips. With companion notes off the dialog says that Obsidian's Tags pane and tag search need them and offers *Turn on companion notes*. The companion note is refreshed 2 s after saving tags.
- **Library filter by tag follows nesting**: choosing `physics` also lists notebooks tagged `physics/optics`, and a nested tag counts for its parents in the sidebar, as in Obsidian's Tags pane.
- **Public API for other plugins (#168)**: `app.plugins.plugins["notebook"].api` with `version`, `createNotebook`, `addPages`, `insertImage`, `exportPdf`, `getNotebookInfo`, `openNotebook` and `listNotebooks`, typed `NotebookApiError`s and checked arguments. Open notebooks are changed through their own session (one undo step, normal save); closed ones are rewritten only after validation, with a `before-api` backup and a read-back check. Documented, with TypeScript typings and Templater, QuickAdd and Dataview examples, in `docs/api.md`. No change to the document format.

### Changed
- **Companion notes: which tags the plugin may remove.** The tags of the notebook that the note already had (written by you) are no longer treated as the plugin's: removing such a tag from the notebook leaves it in the note. Only tags the plugin added itself are removed when the notebook drops them. Notes written by 0.5.0 keep their old behaviour until their next update.
- Tags typed in the editor are stored normalised (`linear algebra` becomes `linear-algebra`); tags already stored are not rewritten until you edit them.

## 0.5.0 — 2026-10-29

Not yet verified on Android hardware (see `docs/testing.md`).

### Added
- **Writing tools**
  - **Insert or remove space** (tool *Insert or remove space*): touch a line and drag down to insert space or up to remove it. Everything below the line moves; what no longer fits on its page continues at the top of the next one, and pages are appended when needed (same size and paper as the last page); removing pulls the following content back up and never takes away more than the empty gap, so ink cannot overlap. An infinite page grows instead of overflowing. PDF and image pages are never mixed with their neighbours: nothing moves onto or off such a page, overflow goes to a new blank page next to it. While dragging, the content below the line is shown shifted by the amount that will really be applied. Text boxes and images move with the ink. One undo step.
  - **Automatic next page** (setting *Add a page when writing at the bottom*, on by default): ink that reaches the bottom tenth of the last page appends a page with the same size and paper, in the same undo step as the stroke. Not for infinite pages or for pages with a PDF or image background.
  - **Selective eraser**: the eraser can be limited to *All ink*, *Highlighter only*, *Pen only* (pen and shapes) or *One colour* (swatches). Works with *Whole stroke*, *Segment* and *Area*.
  - **Erase area** (eraser mode *Area*): draw an outline and everything inside disappears in one gesture and one undo step; strokes crossing the outline are cut at it. Setting *Erase area also removes text and images* (off by default).
  - **Favourite pens**: six slots (tool, colour, width) next to the tools, one tap to select, long press or context menu to save the current pen into a slot (or reset it). Stored in the plugin settings.
  - **Eraser size**: five presets in the toolbar for both eraser modes, remembered, and a circle that follows the pen (or mouse) while erasing.
  - **Commands for hotkeys**: every tool and action as a command that only applies when a notebook is active (pen, highlighter, eraser and its mode and size, lasso, shapes, text, favourite pens 1-6, pen only, next/previous page, delete selection, pages panel, ruler). No default hotkeys.
- **Pen and input**
  - **Pen only** toggle in the toolbar: fingers pan and zoom but do not draw. It is the inverse of the *Draw with finger* setting and stays in sync with it.
  - **Edge rejection zones** (#151): settings *Edge rejection zones* (off by default), *Edge zone width* (4-80 px) and one switch per edge (left, right, bottom on; top off). A touch that starts within that distance of an enabled edge of the page area is ignored: it neither draws nor scrolls, so a palm resting on the edge does nothing. The pen, the mouse and a touch that started inside the area are never affected; the zone never takes more than a third of the shorter side.
  - **Radial menu at the pen tip** (#152): pressing the pen's side button opens a ring around the nib with pen, highlighter, eraser, lasso, undo and the last three pen colours. Lift the pen (or tap) on a sector to choose it; releasing the button over a sector also chooses it; tapping elsewhere or Escape closes it. No stroke is drawn. New setting *Pen side button*: radial menu (default), erase while held, or nothing. The eraser end and the eraser button (`buttons & 32`, `button 5`) keep erasing as before. Whether the S Pen reports its side button as `button 2` / `buttons & 2` has not been checked on a device.
  - **Instant start** (#271): the page being read is saved with the workspace layout, so reopening Obsidian (or going back/forward) shows the same page; new command **Continue last notebook** opens the notebook that was open last on the page that was in view (stored in the plugin settings, never in the notebook file).
- **Selection and clipboard**
  - **Selection actions bar** (lasso tool): when something is selected, a bar over the bottom of the page offers Copy, Cut, Duplicate and Paste, the colour and width rows, and (for images) Make white transparent; with the lasso active and nothing selected it offers Paste. Every button works; none of this changes the file format.
  - **Restyle selection** (roadmap 5): change the colour and width of the lasso-selected strokes, and the colour of selected text boxes, as one undo step. Pens and shapes use the pen palettes; a highlighter keeps the highlighter palette and widths (in a mixed selection each group has its own row and the other group is left alone).
  - **Copy, cut, paste and duplicate** (roadmap 6): strokes and elements with their images, across pages and across notebooks. The plugin clipboard lives for the whole session, so it survives switching notebooks; pasting into another notebook stores the needed images again in its `_assets/` folder (content-addressed, so nothing is duplicated). Each paste gets new ids, lands in the middle of the view (a little further each time) and is selected so it can be moved at once. Ctrl/Cmd+C, X and V work too. Copying also writes a short marker text such as `[Notebook selection: 3 strokes]` to the system clipboard, which is how a later paste knows whether something newer was copied elsewhere. A selection still belongs to one page; paste goes to the page in view.
  - **Paste from the system clipboard** (roadmap 114): a picture becomes an image element (same sizing and HEIF/HEIC message as Insert image), plain text becomes a text box (line breaks kept, at most 20,000 characters). Uses `navigator.clipboard` when the WebView allows it; where it does not (Android WebViews often refuse), Paste opens a small box in which you press and hold and choose the system Paste. Not verified on Android.
  - **White to transparent** (roadmap 172): the selection bar's *Make white transparent* stores a processed copy of each selected image (a PNG, at most 2048 px on the long side) as a new asset and points the element at it; undo points it back. No new fields in the file. It is a fixed threshold (near-white pixels, with a short ramp at the edges): it suits screenshots and drawings on white, not photos with grey paper. PDF and SVG exports draw images on white, so a transparent image shows a white box there over a coloured page or a PDF background.
  - **Words and lines without OCR (#255).** With the lasso tool, a **double tap** on handwriting selects the word under it and a **triple tap** the whole line; the result is the normal lasso selection (move, scale, rotate, delete). Words and lines are found geometrically from the strokes (`src/ink/words.ts`); highlighter and shape strokes and oversized strokes (frames, long underlines) are ignored. Taps do nothing to the document: no strokes or dots are created. Not yet verified on Android hardware.
- **PDF**
  - **Expandable margins on PDF pages** (#104): page menu *Page margins…* (or the command) widens a PDF or scanned page to the left, right and bottom to write beside the slide without covering it; optionally for every page of the same PDF, one undo step. The PDF keeps its place and size and the ink moves with it; an infinite page with margins grows below the PDF instead of stretching it. Exports and thumbnails include the margins.
  - **Re-published slides** (#235): *Update PDF from a new version…* (page menu or command) recognises the slides already in the notebook by their content (pdf.js text; a small image hash for slides with little text), not by number. New pages are appended after the last pages of that PDF (with the same margins), notes stay on their slides even when the order changed, changed slides are listed as "updated" and can be switched to the new version keeping the notes or kept as they are. A summary (new, updated, unchanged, missing) is shown first; the whole update is one undo step; old PDFs stay in `_assets/`.
  - **Export PDF annotations to Markdown** (#155): highlights on PDF pages (with the PDF text under them when the PDF has a text layer) and text boxes, page by page, each with a link that opens the notebook at its page, in a new note next to the notebook (never overwrites an existing note).
- **Lecture**
  - **Instant board shot** (toolbar camera button, command): one tap opens the in-app camera; after the shutter the photo is cropped automatically (the scanner's detection; the whole photo if no outline is found), gets the whiteboard filter and is placed as an image on the page in view, under the last ink, with a small "Board HH:MM" text label. On a page with no room it is scaled down, an infinite page grows, and as a last resort it is centred over the content with a notice. One undo step. Not verified on Android hardware.
  - **New lecture** (command, page menu): a small dialog asks for the course or title (default: the notebook name) and the date; a page like the last one is added at the end with the header as a text box, in one undo step. The format has no page titles, so the header is ordinary text.
  - **Loose sheet** (command, ribbon icon, library button): a quick-notes notebook opened from anywhere, created on first use in the notebooks folder or at the path set in the new setting *Loose sheet location*; an existing file is never replaced.
  - **Move to notebook…** (page menu, command): pick pages and a destination notebook. The destination is saved first (an open notebook: one undo step; a closed file: validated, a backup kept, read back), and only then do the pages leave the source (one undo step); pages edited meanwhile stay. Assets are shared by id, so only their records are copied.
- **Obsidian integration** (not verified in Obsidian or on Android hardware, see `docs/testing.md`, step 37)
  - **Page links (O4)**: `[[Physics.notebook#p3]]` opens the notebook at page 3 (the view reads the link subpath through `setEphemeralState`), also when the notebook is already open. Typing `[[Physics.notebook#` lists the pages with their number and first text box (`EditorSuggest`).
  - **Native embed (O6)**: `![[Physics.notebook#p3]]` renders the same page preview as the `notebook` code block, in reading view and live preview, and tapping it opens the page. It uses Obsidian's embed registry (not part of the public typings, so feature-detected); if it is missing, a reading-view post-processor is used and live preview keeps the plain embed (use the code block there).
  - **File explorer menu (O9)**: *New notebook here* on folders and *Annotate in Notebook* on PDFs (a new notebook in the notebooks folder with the PDF as page backgrounds, reusing the PDF import).
  - **Page into a note (O20)**: the page menu has *Copy link to this page*, *Insert link into the active note* and *Insert page preview into the active note* (links follow Obsidian's link-format setting).
- **Companion notes** (O1, setting *Companion notes*, **off by default**): every notebook gets a Markdown note (next to it, or in a folder that mirrors the notebooks' subfolders; name template with `{name}`) with properties — a link to the notebook, its id, page count, created and modified dates, its tags as Obsidian tags and every field of its metadata — and the text of its text boxes per page with a link that opens each page, so Obsidian search, graph, tags, Dataview and Bases see notebooks. The note may be edited: only the marked generated block and the plugin's own properties are rewritten; your text, properties and tags are kept. Written with a debounce, never while the pen is on the screen, and only when something changed; renamed and moved with the notebook, kept when the notebook is deleted. Commands **Update companion notes of all notebooks** and **Open companion note**. Not yet verified on Android hardware.
- **Data safety**
  - **Repair a damaged notebook** (button in the "cannot be opened" view, command *Repair damaged notebook*): recovers every valid page, stroke, text box, image and file reference from a cut-off or damaged file, also after a damaged region in the middle, and from the journal, version-history snapshots and backup copies; shows what each source recovers and loses and writes the chosen result into a new notebook `<name> (repaired)`. The damaged file is never changed.
  - **Merge conflicted copies** made by Google Drive, OneDrive, Dropbox, Syncthing and Android sync apps (notice when a notebook has one, command *Merge conflicted copies*): only files with a conflict-like name **and** the same notebook id are offered; a summary shows what will be added; everything is added and nothing removed (an item changed on both sides is kept twice); one undo step. The copy is kept, or moved to `_backup/conflicts/` only after the merged notebook was saved and checked.
  - **Restore a single page** from a previous version (page menu, command *Restore this page from a previous version*): pick a snapshot or backup, see its pages, insert the old page as a new page or replace the current one; one undo step, the rest of the notebook untouched.
- **Format**: format v6 with optional page margins (see Changed). Files saved by 0.5.0 with margins open read-only in 0.4.x.

### Changed
- **Format v6**: optional page field `margins`. v5 files are migrated in memory (nothing else changes); once saved by this version with margins, 0.4.x opens them read-only with a backup.
- **Compact toolbar**: the toolbar is two rows (tools; undo/redo, current-pen indicator, favourite pens, page, save state, more) that share one line on a wide view and stack on a phone, with no sideways overflow at 360 px. Tool options (colours, widths, eraser mode, eraser filter and its swatches, eraser size, shape kind, text size) moved into a popover that opens when the active tool is tapped again or from the current-pen indicator; favourite pens are a strip that scrolls sideways; *Insert image*, *Board shot*, *Ruler*, *Pen only*, *Add page*, *Page options* and *Fit to width* are in a "…" menu. Touch targets are at least 40 px. A tap outside a popover only closes it (no stray ink); Escape closes it too. The save state is a coloured dot (text in the tooltip, shown in full on wide views). Tools, settings and the document format are unchanged. Not verified on Android hardware.
- `obsidian://notebook` links can leave out `vault=` (the current vault is used); companion notes use that form.
- Opening a notebook no longer parses it a second time in the middle of the first paint: the version-history snapshot reads the file at once (so it keeps the content as it was on open) but parses and writes it once the page is on screen and the browser is idle. The stroke-line warm-up of the save check also starts 400 ms after the load. On the PC benchmark (10,000 strokes, 6.8 MB) the first painted frame went from 414 ms to 233 ms and the page the reader wants (page 7 of 10) from 519 ms to 233 ms; measured on desktop Chrome only, not on Android. No save or validation step was changed.

### Fixed
- **Move to notebook…**: when the destination is open, the pages leave the source only if the destination's file, read back after the flush, contains them (also when the flush reports unsaved changes because the user kept writing in the destination, so the same pages never stay in both); a destination deleted, turned read-only or closed during the move keeps the source pages, with a notice.
- **Companion notes**: a change that arrived by sync (or from another app) waits 30 s even when the notebook is open here, and opening a notebook waits 30 s too; only this device's own saves use the 4 s delay, so two devices no longer write the same note and cause conflicted copies.
- **Companion notes**: frontmatter and generated region are written in one `vault.process` instead of two writes (user properties and text untouched; broken YAML or markers still leave the note alone).
- **Companion notes**: a file copy of a notebook (same document id) no longer takes over the original's note when that note's link does not resolve; it does so only if no other notebook has the id (read from the top of each file, with a full parse when it is not there).
- **Update PDF from a new version**: another PDF joins "that PDF" only with several unchanged pages (3) or more than half of its slides, so one shared "Thank you" slide no longer pulls in an unrelated lecture; the summary names the PDF of each updated slide and only the main PDF's slides start switched on.
- **Update PDF from a new version**: switching an infinite page that grew beyond the slide keeps its height (the extra goes into the bottom margin when the page has margins), so ink below the slide is not cut off.
- **Conflicted copies**: a copy identical to the notebook (e.g. a browser download named `Notes (1)`) is no longer announced; the merge dialog says that a `Notes (1)` copy may be intentional. Merging stays opt-in.
- **Restore a single page** (*Replace current page*) keeps the v6 margins of the restored page, so its PDF is no longer stretched and its ink stays aligned.
- **Merge conflicted copies** keeps the margins of pages that exist only in the copy; when the other device changed a page's left margin, the copy's ink is aligned to this notebook's margins before comparing, so the same ink is no longer added again as shifted duplicates, and when ink or a text box of the copy would fall off this notebook's page (left, right or bottom, also with equal margins) the page grows in the same undo step so it stays visible (wider margins on a PDF or image page, more height on an infinite page, a larger plain page); the summary reports pages with different margins, and the coverage check before moving the copy away compares content in the page's margin frame.
- **Repair a damaged notebook** keeps page margins (validated like the other page fields, reset when invalid) instead of dropping them as unknown, and no longer loses the strokes of pages with a PDF or image background.
- **Insert or remove space** on an infinite page with margins grows the bottom margin instead of stretching the PDF; undo restores the margins exactly.

### Development
- `npm run bench:open`: open-time benchmark of the real view in headless Chrome (10,000 strokes / 10 pages by default), with the phases timed and an emulation of the work the plugin starts on open.


## 0.4.1 — 2026-10-29

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
