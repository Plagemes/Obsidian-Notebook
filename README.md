# Notebook — handwritten notes for Obsidian

Handwritten notebooks inside your Obsidian vault, designed first for **Android tablets with a stylus (S Pen)** and also usable on Windows.

- Pressure-sensitive vector ink (each point is `[x, y, pressure]` in page coordinates) with a wet-ink writing engine: the line is painted as the pen moves and does not change shape when you lift it.
- A library of notebooks (folders, favourites, tags, covers, search), PDF and scanned pages you can write on, shapes, text boxes, images, a ruler and infinite pages.
- Multiple pages stacked vertically; only the visible pages are drawn. Paper per page: blank, ruled, grid, dotted or millimetre; sizes A4, A5 and Letter, portrait or landscape. Export a page or a notebook as PDF, or a page as SVG.
- Automatic saving into the vault as a `.notebook` file (versioned JSON), an instant save journal for crash recovery and automatic version history. Unreadable files are never overwritten; a backup copy is kept.
- Local-first: no account, no cloud, no telemetry.
- UI in English, and in Italian when Obsidian is set to Italian.

> **Status: v0.12.0 (document format 11), early development.** The automated tests pass, but the plugin has **not been verified on Android hardware yet**, and most features are new in 0.5.x, 0.6.0, 0.7.0, 0.8.0 and 0.9.0 (the interface was redesigned in 0.7.0; markers, pen gestures and page operations came in 0.8.0; equations, graphs, export choices and night mode came in 0.9.0) and many are experimental (including the writing engine, the scanner, export and, in 0.9.0, equations, which have never been run with Obsidian's maths engine outside a test stand-in: the PDF and SVG were checked with other software on a PC, not opened on Android). See [docs/testing.md](docs/testing.md) for what is verified and how to test it.

## Usage

- Ribbon icon **Open library** or the command palette → **Notebook: Open library**, **Notebook: New notebook** / **Notebook: Open notebooks** (a quick search list).
- **New notebook** asks for a name, a page size (A4, A5, Letter), landscape or portrait, and a paper (blank, ruled, grid, dotted, millimetre). The last choice is remembered and used as the default next time; the defaults can also be changed in the settings.
- New notebooks go to the `Notebooks/` folder (configurable in the settings). **Open notebooks** lists the notebooks in that folder and its subfolders; notebooks stored elsewhere open from the file explorer.

### Library

The library is a screen with a sidebar (**All notebooks**, **Favourites**, **Recent**, the folder tree, tags) and a grid of cards showing the cover, name, page count and date. Covers are thumbnails of the first page, also for PDF and image pages, on a cover colour you choose.

- Sort by last modified, name or date created, or by hand (**Manual order**: drag a card onto another, or *Move up* / *Move down* in its menu). *Pin to the top* keeps a notebook first; *Archive* hides a notebook everywhere (under **Archived** in the sidebar, where *Restore from the archive* brings it back) without moving or changing its file. This is kept per device in `_meta/library-<device>.json`, so it merges when two devices sync. **Check library** (sidebar) lists notebooks that cannot be read and unused files in `_assets`, and moves the unused ones to the trash after you confirm.
- Per notebook: open, rename, move to a folder (menu or drag onto a folder), duplicate, delete (to the library trash, with restore), favourite, edit tags, cover colour. Folders are real vault folders: create, rename, delete (to the trash, also non-empty ones). **Trash** in the sidebar lists the deleted notebooks and folders: restore (to the original place, or under `Name 2` if the name is taken), delete permanently or empty it, both after a confirmation; setting *Empty the trash automatically* (days, off by default).
- **Search** looks in notebook titles, tags and the text of text boxes, everywhere, in this folder or in this view. A text hit shows a snippet and opens the notebook at that page. Handwriting is not searched (no OCR).
- Metadata and thumbnails are cached in `library-index.json` in the plugin folder. It is only a cache: it can be deleted at any time and is rebuilt (the library shows "Indexing…").

### Interface

Every action is described once in an action registry and the interface is built from it and from the context (design notes in [docs/design-ui.md](docs/design-ui.md)). Command ids did not change with the redesign, so hotkeys keep working.

- **Toolbar**: tools in the first row; undo/redo, the current pen (opens the tool options), favourite pens, up to six **quick actions** (ranked by priority and by your own use on this device), the page indicator and the save state in the second; one row on wide views.
- **Contextual bar** at the bottom of the page: the actions of the selection (copy, cut, duplicate, paste, white to transparent, save as stamp, delete, colour and width), of a PDF page (search, hide annotations, dim, margins, side by side), of the side-by-side pane and, while a class of the timetable is on, the lecture actions. It can be collapsed.
- **All actions sheet** (the ⊞ button): every action in grouped, searchable sections with a *Recent* section. A bottom sheet on a phone.
- **Page sheet**: the actions of one page, with paper and size as chips (see *Pages and navigation*).
- **Radial dial** at the pen tip (S Pen side button, or a long press): undo/redo, a width bubble, a colour bubble (12 colours, a custom colour and an eyedropper), the active tool, and favourites · pen case · shapes.
- Built on Obsidian's CSS variables, so light, dark and community themes apply; *reduced motion* is respected. Not verified on Android hardware.
- **Toolbar size** (setting): compact, normal or large buttons and icons for the toolbar, the contextual bar, the option popovers and the radial dial. In large the row of tools wraps onto a second line on a narrow phone.

#### Obsidian mobile toolbar

Obsidian's mobile toolbar is set up by you (*Settings > Mobile*): a plugin cannot add buttons to it, so the plugin only makes its commands good candidates, each with a clear name and the icon of its action. Worth adding (they act on the notebook in view and are inactive elsewhere): *Notebook: Next page*, *Previous page*, *Undo (notebook)*, *Redo (notebook)*, *Add page*, *Toggle the pages panel*, *Go to page number…*, *Tool: pen*, *Tool: eraser*, *Tool: lasso selection*, *Toggle pen only*, *Fit page to width*, *Add page to Obsidian bookmarks*. *Continue last notebook* and *Open library* also work from a note.

#### Page turner and Bluetooth clickers

While a notebook is the active view, **PageDown, ArrowRight, ArrowDown and space** go to the next page and **PageUp, ArrowLeft, ArrowUp and Shift+space** to the previous one, unless a text field or text box is being edited, a stroke is being drawn, or a dialog or menu is open. Bluetooth presentation clickers send PageUp/PageDown or the arrow keys, so they work; turn it off with *Turn pages with the keyboard*. The Android **volume keys cannot be used**: the system handles them and web content (so Obsidian plugins) never receives them. Undo and redo keep their keys (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y).

#### S Pen on Android

Obsidian's Android app does not pass stylus **hover** to plugins (Chrome on the same tablet gets it; tracked on the Obsidian forum in the thread "Android Hover Support"). So the plugin never sees the pen while it hovers, and the side button works only in these ways (0.11.2, not yet verified on every device):

- **Click while hovering**: the click arrives as a single "context menu" event, so it opens the **radial menu** (where the pen is if the event says so, otherwise where the pen last touched, otherwise in the middle of the page). With *Button click: next stroke erases* on, the click instead **arms the eraser for the next stroke** (a small ring on the current-pen indicator); click again, change tool or press Escape to cancel.
- **Hold the button, then touch**: that stroke **erases** (or uses the tool chosen in *Pen side button*). On the Samsung tablet tested, the pen's own events do not show the button: it shows only as that same "context menu" event, just before or just after the nib lands, so the plugin decides within a short window (150 ms before, 350 ms after, adjustable under *Side button timing*); a click while hovering therefore acts about 150 ms late.
- **Press the button while writing**: the ink written so far is kept and the rest of the stroke erases; lifting the pen brings the tool back.
- **What does not work**: anything that needs hover, such as a cursor preview, opening the menu on press and choosing by releasing over an action, or holding the button in the air. Android 14 and later also keep the stylus button key codes from apps and accessibility services.

**Pen key with Key Mapper + Shizuku (optional, advanced).** The *Pen key* setting (F9 to F12, or any key you capture) makes a key act as the side button: *Open the radial menu* or *Next stroke erases* (the default). With [Key Mapper](https://github.com/keymapperorg/KeyMapper) and [Shizuku](https://shizuku.rikka.app/) you can map the S Pen's remote button to that key: start Shizuku (wireless debugging), allow Key Mapper to use it, create a key map whose trigger is the pen button and whose action is the key code F9, then choose F9 as *Pen key*. Be aware: it is a **toggle only** (one press = one action, no holding), it works only with an S Pen that has **Bluetooth** (Air actions), there is **some delay**, and Key Mapper must keep running. If Obsidian already uses the key as a hotkey, the setting warns you. These settings are, for now, at the top of the *Pen button test* (Settings → *Pen button test*).

### Tools

The toolbar has these tools:

- **Pen**: 9 colours, 5 widths, pressure-sensitive.
- **Highlighter**: 5 colours, 3 widths, constant width, translucent. It darkens the ink and grid below it instead of covering them.
- **Eraser**, with two modes: **Whole stroke** removes the strokes it touches; **Segment** cuts them and removes only the part under the eraser. It works across pages in one gesture, and one undo restores everything erased in that gesture.
- **Lasso**: draw a loop around strokes, text boxes and images (a stroke is selected when at least half of its points are inside). Drag inside the frame to move them, drag the handle at the bottom-right corner to resize (uniform), drag the handle above the top edge to rotate. The trash button, Delete or Backspace deletes the selection; Escape or changing tool clears it. A selection stays on one page.
- **Shape**: line, arrow, rectangle or ellipse, dragged out with the pen. With the pen, **hold still for about 0.6 s at the end of a rough line, rectangle, ellipse or arrow** and it is replaced by the clean shape.
- **Text**: tap to place a text box and type; the text size is in the toolbar. Text in text boxes is searchable in the library.
- **Image**: insert an image from the vault or the device as an element (select it with the lasso to move, scale or rotate it).
- **Ruler**: place a straight edge with two fingers; the pen follows it, so a stroke started on its edge stays on the edge.
- **Eraser filter and size**: the eraser can be limited to all ink, the highlighter only, the pen only or one colour; five sizes, with a circle that follows the pen. Mode **Area**: draw an outline and everything inside is erased in one undo step (text boxes and images only with the setting *Erase area also removes text and images*).
- **Insert or remove space**: touch a line and drag; everything below moves, onto the next page (created when needed) if it no longer fits. Removing never takes away more than the empty gap.
- **Favourite pens** (six slots), a **Pen only** toggle, and a command for every tool and action (no default hotkeys). The tool options are in a popover. See *Interface* below for the toolbar, the contextual bar and the sheets.
- **Selection bar** (lasso): copy, cut, duplicate, paste, change colour and width, and make white transparent in an image. With the lasso, a double tap selects a word and a triple tap a line (found from the strokes, no OCR). Paste also takes a picture or text from the system clipboard; Android WebViews may refuse it, so a paste box is the fallback.
- **Pen side button**: a click (press and release with the pen hovering just above the screen) opens the radial dial at the pen; pressing it and then touching the page erases while held (other options: radial menu only, erase only, lasso, previous tool, nothing). Press the button *before* touching the page. On a Samsung tablet: click while the pen hovers = radial dial; hold the button and touch the page = eraser. Not verified on hardware by the author; a user report says that on a Samsung tablet the button arrives as a press with zero pressure while the pen hovers, and that on some devices it never reaches Obsidian. The command *Pen button test* shows what the pen sends. Without the button: *Open the radial menu by holding the pen still* (on by default until the device has delivered a button signal) and *a finger long-press* (pen-only mode) open the same menu.
- **Gestures**: a tap with two fingers undoes and a tap with three fingers redoes (setting *Finger taps*, on by default); **Scribble to erase** (off by default): a fast back-and-forth scratch with the pen over ink deletes the strokes it crosses, in one undo step; **Scroll up when writing near the bottom** (off by default). Experimental, thresholds not tried on a device.
- **Stamps** (*All actions* sheet and quick actions): three built-in stamps and your own, saved from a lasso selection in `<notebooks folder>/_stamps/`; tap one to place it, or drag it onto the page. **Ink follows objects** (setting, on by default): ink written over an image or a text box moves, scales and rotates with it.
- **Edge rejection zones** (off by default): touches near the chosen edges are ignored.

Undo/redo: toolbar buttons, Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (or Ctrl+Y) on desktop. Each transform, delete, insertion or eraser gesture is one step. The history lives in memory and is lost when the notebook is closed.

### Pages and navigation

- A notebook can have several pages, stacked vertically. **Add page** (toolbar button or command) inserts a blank page after the page in view, with the same size and paper as that page, and can be undone. The toolbar shows the current page as `n / total`.
- The **Pages panel** (toolbar) shows page thumbnails: tap to jump, drag to reorder, star to bookmark, and a filter to show bookmarked pages only. The panel also has an **outline** of coloured bookmarks (title, colour, category such as *Important* or *To review*) and a filter by **page tags** (page sheet → *Page tags…*; the library search finds them too).
- The **page sheet** (tap the page indicator in the toolbar, or a thumbnail's menu) acts on the page in view. Its first section, **Go to**, has *Go to page number…*, *Recently edited pages* and *One page at a time*; then: duplicate, move up or down, delete (not the only page), change the paper, change the size, switch between portrait and landscape, insert a PDF, a blank page, an image or a scan after it, make the page infinite, bookmark it, and export. Each change is one undo step. Changing the size does not move or scale the ink: ink that falls outside a smaller page is kept in the file but not shown or exported, and comes back if you enlarge the page again.
- **Infinite page** (page sheet): when you write in the bottom fifth of the page it grows by half a page, up to 20 times its width. Undoing the stroke undoes the growth.
- Ruled paper has its first line below a top margin and a red margin line about 25 mm from the left edge; dotted paper has a dot at every grid intersection; millimetre paper has a darker line every 10 mm. On screen the fine lines and dots fade out when zoomed far out.
- With the default settings a finger scrolls (one finger) and zooms (two fingers); it does not draw. A quick one-finger flick keeps scrolling for a moment (fling). Turn on **Draw with finger** in the settings to draw with a finger.
- **Automatic next page** (setting, on by default): writing in the bottom tenth of the last page appends a page. **New lecture** adds a dated page at the end; **Loose sheet** is a quick-notes notebook opened from the ribbon, a command or the library; **Move to notebook…** moves chosen pages to another notebook.
- **Instant board shot**: a toolbar button takes a photo, crops it, applies the whiteboard filter and puts it under your last ink. **Instant start** reopens the notebook and page you were on (**Continue last notebook**).
- **One page at a time** (setting *Scrolling*, or the page sheet): pages side by side, a sideways swipe turns the page. **Reopen where you left off**: the page, zoom and scroll position are restored. The page and height where you stopped reading are also stored in the notebook, so another device opens it there.
- **Quick navigation**: the command **Go to page…** is a quick switcher over every notebook (notebook name, page number such as `12` or `physics 12`, bookmark title, page tag or text-box words, with page thumbnails); **Recently edited pages** (command and *Recent pages* in the library) comes from a small log kept on each device only; **Go to page number…** (also from the page indicator) takes `12`, `p12` or a bookmark title.
- **Zoomed-out drawing and heavy pages**: below 50 % zoom, and in thumbnails, committed strokes are drawn from a simplified shape (within 0.5 device pixels of the exact one) to keep scrolling smooth; a page with more than 3,000 strokes, 120,000 points or 20 MB of images shows a bar with **Split page** (one undo step) and **Dismiss**. Not measured on Android.
- Notebooks over about 2 MB open with the wanted page first (read-only) while the other pages are read in the background (**progressive loading**).
- More papers: Cornell, music staff, isometric, hexagonal, calligraphy, daily and weekly planner.
- **Delete page** keeps the page in the page trash (**Deleted pages…**, at most 50 pages per notebook for 30 days). **Page templates**: *Save page as template…* and *New page from template…*, with built-in Cornell, meeting notes and to-do templates. **Exercise page here** inserts a blank page with your exercise paper after the current one.
- **Fit to width** in the toolbar restores the default zoom.
- **Bookmarks pane**: *Add page to Obsidian bookmarks* (page sheet, All actions, command palette) adds the page in view to Obsidian's core Bookmarks pane as `Notebook.notebook#pN&id=...`; opening the bookmark goes to that page even if pages moved. It needs the core *Bookmarks* plugin turned on and uses an internal Obsidian API, so it says so in a notice when it is not available.
- Mouse: left button draws, wheel scrolls, Ctrl + wheel zooms, middle button pans.

### Study tools (0.8.0)

All of this is new in 0.8.0 and **not verified on Android hardware**; the manual steps are in [docs/testing.md](docs/testing.md) (steps 178-232).

- **Markers**: *To complete* (a gap, with the time and the slide in view), *Question*, importance (!, !!, ★) and *Homework* with a due date. Tap to place, drag to mark a region; tap a badge to resolve or cycle it. The **End of lecture** panel lists them for a lecture or the whole notebook. Homework becomes Obsidian tasks in the companion note (ticking one there is read back into the notebook) and **structured boxes** (Definition, Theorem, Example, Proof, Remark) become callouts.
- **Invisible ink** (*Toggle invisible ink*): write answers that are saved hidden; *Show solutions* reveals them (view only). Hidden ink is not erased, selected or exported while hidden.
- **Pen gestures** (gesture mode, the S Pen side button held, or an optional long press): circle to select, scribble to delete, "^" to insert space, "#" for page tags, a star to bookmark, "?" to search, a line from a selection to a thumbnail to move it, plus your own gestures bound to any command. The command is previewed before you lift the pen and moving back cancels it. Gestures never start while you just write.
- **Several pages at once** in the Pages panel (move, duplicate, bookmark, tags, paper, size, export, delete), **stable page links** (`#p3&id=…` keep working after pages are reordered; *Update links to notebook pages…* fixes old links) and **quiet while writing** (the plugin's own notices and background work wait while the pen is on the screen).
- **Zettelkasten inbox** (*Open the inbox*): the loose jots on the quick-notes sheet and the PDF highlights waiting to be made into permanent or literature cards, linked to an existing card, or discarded (nothing is deleted).
- **Textbook references**: "p. 134" typed in a text box opens the textbook PDF you chose (*Set textbook for this notebook…*) at that page.
- **Redo the exercise**: a practice copy of a page with your ink hidden (all, some colours or tools, or the selection), linked to the original, with attempts, a peek at the solution and an optional timer.
- **Links written with the pen**: `[[Note]]` in a text box is a link, circled ink can be linked to a note, and two handwritten brackets offer the note chooser.
- Per-device files in `<notebooks folder>/_meta/` (inbox, practice, textbooks, moved pages) are merged when read, so synced devices never write the same file.

### Equations, graphs and more (0.9.0)

All of this is new in 0.9.0 and **not verified on Android hardware**; the manual steps are in [docs/testing.md](docs/testing.md) (steps 233-274).

- **Equations**: *Insert equation* (*All actions* > Insert, or the command) opens an editor with a live preview typeset by Obsidian's maths engine, a palette of structures (fractions, roots, powers, matrices, integrals, sums, systems, aligned lines), display or inline style, automatic numbering, size and colour. The typeset glyphs are stored as a vector outline, so equations are drawn and exported without the maths engine. *Convert to ink* turns an equation into strokes.
- **Function graphs**: *Insert graph* adds a graph with a panel: cartesian, parametric, polar, implicit and piecewise functions, parameters with sliders, roots, extrema, intersections, tangents, shaded area, table of values, axes and grid. Pan and zoom inside the graph; ink written on it keeps its graph coordinates. Expressions are read by a small built-in parser (no `eval`).
- **Layer order**: *To front*, *To back*, *Forward* and *Backward* for the selected strokes and elements (contextual bar and *All actions*).
- **Find and replace in text boxes** across the notebook, with *Match case* and *Whole word*; *Replace all* is one undo step.
- **Page information** (page sheet): size, paper, strokes, objects, files, tags, markers and dates. **A page in the middle**: writing at the bottom of a page that is not the last offers a chip *Add a page after this one*.
- **Export…** (page sheet, *All actions*, notebook menu): PDF or SVG, one page or the whole notebook, with ink and background, ink only or background only. **Export as Markdown with page images…** writes `page-001.png`… and a `notebook.md` into a vault folder. See *Export*.
- **Night mode** (*All actions*): a dark page with light ink, applied when drawing only; stored colours and exports are unchanged.
- **Crop PDF margins** (PDF contextual bar, *All actions*): fits the content of each PDF page to the screen width, a view setting for small screens; the document and exports are untouched.
- **Obsidian integration and input**: command icons for the mobile toolbar, *Add page to Obsidian bookmarks*, the page turner and the *Toolbar size* setting are described under *Interface*.

### Navigation, selection and library (0.10.0)

All of this is new in 0.10.0 and **not verified on Android hardware**; the manual steps are in [docs/testing.md](docs/testing.md) (steps 275-379). The notebook format does not change.

- **Tabs of open notebooks** (setting, off by default): a strip above the toolbar lists the open notebooks; a two-finger sideways swipe on the toolbar goes to the next or previous one.
- **Automatic line break** (setting, off by default): on ruled or grid paper, lifting the pen at the right edge scrolls to the start of the next line.
- **Back and Forward** through the pages you jumped between; a **fast scrollbar** with a page preview; a **status bar item** ("p. 3/12 · Saved", desktop only).
- **Date and time stamp** at the pen position; **lasso selection across pages**; **Copy to other devices** / **Paste from another device…** through the vault.
- **Selection tools**: rectangle selection, select by colour or tool, align and distribute, rotate 90°, mirror and exact size.
- **Library**: pin notebooks, archive them, order them by hand, and **Check library** (unreadable notebooks, unused files moved inside the vault, never deleted).
- **Read-only mode** per notebook view; **Export…** to PNG images, page ranges for every format, and **Print** (desktop).
- **Free colour picker** with recent colours, a page **eyedropper** and a **style eyedropper** (colour, width and tool from a stroke).

### Language (0.10.1)

- **Interface language** (*Settings, Language*): Automatic (follows Obsidian), English or Italiano. Command names follow the language chosen at startup. Not verified on Android hardware (manual steps 380-383 in `docs/testing.md`).

### Anchored excerpts (0.11.0)

New in 0.11.0 and **not verified on Android hardware**; the manual steps are in [docs/testing.md](docs/testing.md) (steps 384-403). This version writes **document format 10**: notebooks saved by 0.11.0 open read-only (with a backup) in 0.10.x and older.

- **Excerpt to page…**: lasso something (or, with nothing selected, drag over a region, for example a figure of a PDF page), choose the target page (this page, the next one, a new page, a number or a bookmark) and the region is placed there as an excerpt you can move and resize.
- **Copy as excerpt**: the same, onto the clipboard, to paste on a page of another notebook.
- **Tap the corner badge** (or *Go to source*) to jump back to the exact place it came from, even in another notebook and in read-only mode; the region is outlined for a moment.
- An excerpt of a page of the same notebook follows its source live; otherwise it shows a snapshot taken when it was made. A source page or notebook that is gone never breaks anything: the excerpt keeps its picture and says "Source not found".

### PDFs and scans

- **Import PDF as notebook** (library button or command): one notebook page per PDF page, with the PDF page as the background; you write on top of it.
- **Insert PDF after this page** (page sheet): the whole file or a page range. Blank pages can be inserted between PDF pages at any time. **Insert image as page** makes a page whose background is the image.
- **Scanner**: **Scan into this notebook** (command or page sheet), **New notebook from scan** (command or library), or **Insert scan as image** (page sheet). Take a photo with the device camera (or choose one), drag the four corners to the edges of the sheet (a loupe shows the corner under your finger; the corners are detected automatically when possible), pick a filter (*Original*, *Document*, *Whiteboard*), rotate or retake, then go on with the next sheet or finish. The result is a page whose background is the corrected photo, like a PDF page.
- PDFs and images are copied once into `<notebooks folder>/_assets/`, named by a hash of their content, so the same file used twice is stored once and saving a notebook with a long PDF writes only the ink. If an asset file is deleted, the page shows a placeholder with the file name and the ink is kept. Do not delete or rename files in `_assets`.

- **Page margins…** (page sheet): widen a PDF or scanned page to the left, right and bottom to write beside the slide, for one page or every page of the PDF.
- **Update PDF from a new version…**: slides already in the notebook are recognised by their content, new ones are added after the last page of that PDF and your notes stay on their slides.
- **Search PDF text** (command, contextual bar of a PDF page, *All actions* sheet): accent-insensitive search with hits marked on the pages; the highlighter has **Snap to text lines**; **Show or hide annotations** to reread the clean PDF; **Dim the background** (PDF and image backgrounds lighter, strength slider). These need the PDF's text layer (not scanned PDFs).
- **Open PDF side by side**: a PDF of the vault, or another notebook with PDF backgrounds, beside the notes; turning the PDF page shows the linked notes page and the other way round, with **Add notes page for this slide**.
- **New lecture from slides…**: the lecture notebook is created from the course slides PDF with a layout of slide + notes area on the right or below (one slide per page), an optional notes page after every slide and a header. The same layout options apply to *Insert PDF*.
- **Class timetable** (settings → *Edit timetable*, stored in `_timetable.json`): opening Obsidian during a class offers the class's notebook with a new lecture page tagged with the course; the library shows **Now: <course>**.
- **Export PDF annotations to Markdown**: highlights (with the PDF text under them when the PDF has a text layer) and text boxes, each with a link to its page, in a new note.

### Export

From the page sheet: **Export page as PDF**, **Export notebook as PDF** and **Export page as SVG**; the command palette also has **Notebook: Export notebook as PDF**. The file is written next to the notebook (`My notebook.pdf`; single pages as `My notebook p3.pdf` or `My notebook p3.svg`), with ` 2`, ` 3`… added if the name is taken, and a notice shows the path. The export includes the paper pattern and keeps the ink as vector shapes; the highlighter stays translucent. PDF page backgrounds and images are rasterised as JPEG (PDF pages at 200 dpi). Page sizes are the real sizes (A4 prints as A4).

**Export…** (page sheet, *All actions*, notebook menu and command palette) lets you choose PDF or SVG, this page or the whole notebook (SVG: one file per page), and what is drawn: **ink and background**, **ink only** (writing, text, pictures, boxes and markers on no paper; an SVG is transparent) or **background only** (paper and PDF or picture, no writing). File names say the choice (`My notebook ink.pdf`) and an existing file is never replaced. Equations and graphs are exported as vectors. **Export as Markdown with page images…** asks for a vault folder and a resolution (100, 150 or 200 dpi) and writes `page-001.png`… (each page drawn like the PDF export) and `notebook.md` with the page images, the text of the text boxes, the equations as `$$…$$` and a heading for each bookmarked page; nothing is overwritten.

The PDF writer has no dependencies and does not compress, so a page with a lot of ink or images can give a large file. The exported PDF was parsed with pdf.js and the SVG rendered with resvg on a PC; they have not been opened on Android yet.

### Embeds and links

- **Embed a page in a note**: the command **Notebook: Insert notebook embed** (in a Markdown note) adds a code block like the one below. The preview shows that page, refreshes when the notebook changes, and opens the notebook at that page when clicked.

  ````
  ```notebook
  path: Notebooks/Physics.notebook
  page: 3
  ```
  ````

  The block also accepts `Notebooks/Physics.notebook#3` and the wikilink form `[[Physics#p3]]` (resolved by name). The page defaults to 1.
- **Links**: `obsidian://notebook?path=<vault path>&page=<n>` opens the notebook at that page from other apps, bookmarks or a QR code (`vault=<name>` is optional).
- Opening a notebook from a link, an embed or a search result scrolls to the requested page.
- **Page links and embeds**: `[[Physics.notebook#p3]]` opens the notebook at page 3, with page suggestions while typing; `![[Physics.notebook#p3]]` shows the page preview. The page menu can copy a link or insert a link or preview into the active note, and the file explorer has *New notebook here* (folders) and *Annotate in Notebook* (PDFs). Not verified in Obsidian on Android; live preview needs a feature of Obsidian that is not in its public typings, so the `notebook` code block is the fallback.
- **Card subpaths (Zettelkasten)**: a page link or embed can name the page by id and show only a region of it, in page units (pt from the top-left corner): `![[Box.notebook#p3&id=<page id>&r=x,y,w,h]]`. Parameters after `&` come in any order: `id=` finds the page even after it was moved (`p3` is then only a fallback; if the page was deleted the preview says so), `r=` crops the live preview to that rectangle. The same subpath works in the `notebook` code block (`path: Notebooks/Box.notebook#p3&id=…&r=…`). Card notes write these for you.
- **Zettelkasten cards** (commands and the notebook tab's ⋯ menu; not verified on Android): *Make card from selection* (lasso) or *Make card from this page* creates a note in `Zettelkasten/` with an id (timestamp or Luhmann numbering, setting), a typed title (also an alias), type, source, tags, date, a link to the notebook and the ink embedded live, plus a *Transcription* section. *New slip-box* makes a notebook of A6 card pages where every new page gets its card note automatically (*Make this notebook a slip-box* converts an existing one). An arrow drawn with the shape tool from one card region to another adds a two-way link (`links` property, visible in the graph). Card regions are outlined on the page with their id (setting *Show card regions*). Cards are never deleted: when their page is deleted they get `orphaned: true` and appear in *Show orphaned cards*. Nothing is stored in the notebook file.
- **Shared tags**: the tag editor (*Edit tags…*, command *Edit tags of this notebook…*) suggests the tags of your vault and writes them the way Obsidian does; the library filter follows nested tags (`physics` also lists `physics/optics`).
- **Public API for other plugins** (Templater, QuickAdd, Dataview): `app.plugins.plugins["notebook"].api`, documented in [docs/api.md](docs/api.md).
- **Companion notes** (setting, **off by default**): every notebook gets a Markdown note with properties and the text of its text boxes per page, so Obsidian search, graph, tags and Dataview see notebooks. Your own text and properties in the note are kept. Handwriting is not included (no OCR).

### Versions and recovery

- **Instant save journal**: about 200 ms after a change (never during a gesture) the change is recorded in a small journal in the plugin folder. If the app was killed before the regular save, the next time the notebook opens the changes are restored and a notice says so. If the journal does not match the file (it was changed elsewhere), nothing is applied and a copy goes to `Notebooks/_backup/`.
- **Version history**: when you open or change a notebook, a snapshot is saved if the last one is older than the interval (24 h by default); beyond the limit (10 by default) the oldest go to the trash. **Notebook: Restore a previous version** lists them; restoring first saves the current content as a backup, and a version of another notebook is refused. Snapshots are in `Notebooks/_backup/history/`.
- **Repair a damaged notebook**: recovers what can be read from a damaged file, the journal, snapshots and backups into a new notebook; the damaged file is not changed.
- **Merge conflicted copies** made by sync apps (only copies with the same notebook id), and **Restore a single page** from a previous version.
- **Safe mode**: if opening a notebook crashed or froze last time, the next open skips low-latency ink, thumbnails, the companion note and PDF/image backgrounds, with a banner offering *Open normally* and *Repair…*.
- **Storage full**: a failing save shows a persistent *Not saved* banner with *Retry now* and retries by itself; the edits stay in memory and in the journal, and every write is read back so a full disk never leaves a half-written notebook when the old one can be put back.
- **Integrity check**: each device remembers fingerprints of the versions it wrote; a file that is an older version (a sync service put back a stale copy) shows an *Unexpected change on disk* banner with *Restore a version…*, *Keep this version* and, when it replaced the open one, *Restore the newer version*. Nothing is restored automatically. The command **Check notebooks integrity** checks every notebook.
- **Sync safety** (Google Drive, OneDrive and similar folder-sync apps): an **Open on another device** banner (small presence files in `_meta/presence/`, never blocking) with *Open read-only* or *Open anyway*; images and PDFs that have not arrived yet show *Waiting for sync*; a 0-byte online-only notebook shows *Not downloaded yet* instead of being treated as damaged; the command **Check sync safety** lists folder and file problems.

### Settings

| Setting | What it does |
|---|---|
| Notebooks folder | where new notebooks are created (default `Notebooks`); `_assets` and `_backup` live inside it |
| Default paper | paper for new notebooks (blank, ruled, grid, dotted, millimetre) |
| Default page size | A4, A5 or Letter for new notebooks |
| Landscape by default | new notebooks are landscape |
| Draw with finger | fingers draw instead of only scrolling |
| Palm rejection time | touch is ignored for this long after the pen was seen (default 500 ms) |
| Pressure | use the device pressure, or always simulate it from speed. Decided at the start of each stroke |
| Predicted ink | draw the pen's predicted path ahead of the tip (never saved). Off by default: it can overshoot at turns and at the end of a stroke |
| Low-latency ink (experimental) | show the ink being written on a low-latency layer and read pen samples as soon as they arrive. Off by default: on some devices it can turn the page black or hide the ink |
| Stabilization | 0–10, default 2. Adaptive smoothing of hand tremor: strong when the pen is slow, almost none when it is fast; higher values trail further behind the pen. The filtered points are what is saved |
| Ignore large touches | experimental, 0 = off. Touches with a contact larger than this many px are treated as a palm and ignored, scrolling included. Depends on what the device reports |
| Performance overlay | shows frame time, input-to-frame and input-to-paint times, whether raw input is in use, redraw time, and strokes and pages drawn |
| Add a page when writing at the bottom | on by default; appends a page after the last page (not infinite or PDF/image pages) |
| Scrolling | continuous (vertical) or one page at a time |
| Toolbar size | compact, normal or large buttons and icons for the toolbar, the contextual bar and the radial menu (large is easier with a finger; on a narrow phone the tools wrap onto a second line) |
| Turn pages with the keyboard | on by default; arrow keys, PageUp / PageDown and space (Shift+space back), also from a Bluetooth presentation clicker |
| Finger taps | two fingers undo / three redo (default), swapped, or off |
| Scribble to erase | off by default |
| Scroll up when writing near the bottom | off by default |
| Ink follows objects | on by default |
| Templates folder | where page templates are stored (default `_templates` in the notebooks folder) |
| Empty the trash automatically | days, off by default |
| Pen side button | radial menu on click + erase while held (default), radial menu only, erase while held, lasso while held, previous tool while held, or nothing |
| A zero-pressure press is the side button | on by default; what Samsung tablets report for the button pressed while the pen hovers. Turn off if the pen reports pressure 0 while writing |
| Side button pressed while writing | experimental, on by default; a pen move with `button 0` during contact finishes the stroke and switches to the button's tool. Turn off if writing is interrupted by itself |
| Open the radial menu by holding the pen still | automatic: on until the device has delivered a side-button signal, then off; your own choice always wins. 0.7 s within 6 px of the first contact |
| Open the radial menu with a finger long-press | on by default; 0.5 s within 10 px, only while finger drawing is off and the pen is not near |
| Pen button test | opens a log of the events the pen sends, to see how its side button is reported |
| Edge rejection zones | off by default; width 4-80 px and one switch per edge |
| Erase area also removes text and images | off by default |
| Loose sheet location | where the quick-notes notebook is created |
| Companion notes | off by default; location, name template |
| Version history interval | at most one snapshot per notebook per this many hours (default 24); 0 turns snapshots off |
| Versions to keep | snapshots kept per notebook (default 10) |

### Performance tools

- **Notebook: Run performance benchmark** renders a generated 10,000-stroke, 10-page notebook off-screen at the size of the current view and reports first draw, redraw, scrolling (150 frames), 3x zoom, save check and open times, eraser timings, JS heap where available, and a replay of synthetic pen strokes through the old and the new writing pipeline. Nothing is written to your vault. Results can be copied.
- **Notebook: Create stress-test notebook** writes the same kind of notebook (10,000 strokes, 10 pages) to the notebooks folder, to try real writing, scrolling and zooming on a large document.
- The **Performance overlay** setting shows live numbers while you use a notebook.
- `npm run bench` runs benchmarks of the pure logic from the command line (see Development). Those are PC numbers; on a tablet use the in-app benchmark.

## Install

### From the community plugins directory

Submitted, waiting for review. Once it is approved: **Settings → Community plugins → Browse**, search for **Notebook**, then **Install** and **Enable**.

### With BRAT (works now, updates automatically)

1. **Settings → Community plugins → Browse**, search for **BRAT** (Obsidian42 - BRAT), install and enable it.
2. Command palette → **BRAT: Add a beta plugin for testing** → enter `https://github.com/Plagemes/Obsidian-Notebook` → choose the latest version → **Add plugin**.
3. Enable **Notebook** in **Settings → Community plugins**.

### Manual install

Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/Plagemes/Obsidian-Notebook/releases/latest), or build them yourself:

```bash
npm install
```

```bash
npm run build
```

This produces `main.js` in the repo root; `manifest.json` and `styles.css` are already there.

Requires Obsidian 1.8.7 or later.

#### Windows

1. Close Obsidian or keep it open, either works.
2. Open your vault folder and create `<vault>\.obsidian\plugins\notebook\` (`.obsidian` is a hidden folder: in File Explorer turn on *View → Show → Hidden items*).
3. Copy `main.js`, `manifest.json` and `styles.css` into it.
4. In Obsidian: **Settings → Community plugins** → turn off *Restricted mode* if needed → click the reload icon next to *Installed plugins* → enable **Notebook**.

#### Android

The plugin folder has to end up at `<vault>/.obsidian/plugins/notebook/` on the phone or tablet. Three ways to get it there:

**A. Obsidian Sync**
1. Install the plugin on the desktop as above.
2. On both devices: **Settings → Sync → Vault configuration sync** → turn on **Installed community plugins** (and *Active community plugins list*).
3. In the same Sync settings turn on **Other types** (*Sync all other types*): `.notebook` files are an unknown extension for Sync and are **not** synced without it.
4. Wait for Sync to finish on Android, restart Obsidian, then enable **Notebook** in **Settings → Community plugins**.

**B. Syncthing** (or any folder sync tool)
1. Sync the whole vault folder, including the hidden `.obsidian` folder (check that it is not in the ignore patterns).
2. On Android restart Obsidian and enable **Notebook** in **Settings → Community plugins**.

**C. USB cable**
1. Connect the device and open its storage on the PC.
2. Find the vault folder (for vaults in shared storage usually `Documents/<vault>` or `Obsidian/<vault>`; vaults in Obsidian's private app storage are not reachable over USB — move the vault to shared storage first).
3. Create `.obsidian/plugins/notebook/` inside the vault and copy the three files there. Some file managers hide folders starting with a dot; the PC's file explorer shows them if hidden items are visible.
4. On Android open Obsidian → **Settings → Community plugins** → turn off *Restricted mode* if needed → enable **Notebook**.

To update, replace the three files and restart Obsidian (or disable and re-enable the plugin).

### Debugging on Android

Enable USB debugging on the device, connect it to a PC with Chrome and open `chrome://inspect`: the Obsidian WebView appears there with its console. Errors from this plugin are prefixed with `[notebook]`.

## File format

A `.notebook` file is JSON with `format: "obsidian-notebook"` and an integer `version` (currently 10). Version 2 added the highlighter, 3 the paper kinds, 4 the notebook metadata, assets, PDF/image page backgrounds, text and image elements, infinite pages and the shape tool, and 5 a per-stroke `render` field (1 = the previous pen look, kept for every existing stroke; 2 = the new ink engine), 6 optional page margins (files saved by 0.5.0 with margins open read-only in 0.4.x), and 7 bookmark details, page tags, the last reading position and the new paper kinds (files saved by 0.6.0 open read-only in 0.5.x, with a backup), and 8 markers, structured boxes and hidden (invisible) ink (files saved by 0.8.0 open read-only in 0.7.x, with a backup), and 9 equations and function graphs (files saved by 0.9.0 open read-only in 0.8.x, with a backup), and 10 anchored excerpts (files saved by 0.11.0 open read-only in 0.10.x, with a backup). Older notebooks open normally and are rewritten in the current version only when you edit them; after that, **older versions of the plugin open them read-only** (and keep a backup copy) instead of editing them. Coordinates are in typographic points (A4 = 595.28 × 841.89 pt). PDFs and images are not inside the file: they are in `<notebooks folder>/_assets/` and referenced by id. Details and the reasoning behind the format choice are in [docs/architecture.md](docs/architecture.md).

Backups of unreadable files, of versions changed elsewhere (conflicts), of changes that could not be saved and of journals that could not be applied are written to `Notebooks/_backup/` as `.bak` files; version snapshots go to `Notebooks/_backup/history/`. Obsidian does not show these folders in the file explorer; open them with a file manager. If you sync the vault, sync `_assets` and `_backup` too (with Obsidian Sync, turn on **Other types** so that `.notebook` files, PDFs and snapshots are synced). The journal and the library index live in the plugin folder and are not meant to be synced.

Because the extension is custom, Obsidian's search, tags, backlinks and graph do not see notebooks unless *Companion notes* is on (off by default; the rest is planned for M4, see [docs/roadmap.md](docs/roadmap.md)); the library has its own search, and notes can embed and link to notebook pages (see above).

## Development

| Command | What it does |
|---|---|
| `npm run dev` | build in watch mode |
| `npm run build` | type-check, production build, check that `main.js` requires nothing but `obsidian` |
| `npm test` | vitest (unit tests) |
| `npm run lint` | eslint + `tsc --noEmit` |
| `npm run bench` | benchmarks of the pure logic (serialize, open, save check, eraser, lasso, stroke geometry, input filter) on a generated 10,000-stroke notebook; not part of `npm test` |
| `node scripts/make-stress-notebook.mjs 5000` | writes `stress.notebook` with 5000 strokes for performance tests |

### Releasing

Releases are built by the **Release** workflow (`.github/workflows/release.yml`): when a version tag is pushed it builds the plugin and attests `main.js`, `manifest.json` and `styles.css`.

Order matters: **publish the release (push the tag) before merging a manifest version bump into `main`.** The community plugin directory reads `manifest.json` at the head of `main` and complains if no release with that version exists yet.

Beta versions: on the feature branch, push a tag made of the manifest version plus a suffix (for example `0.4.0-beta.1`). The workflow publishes it as a GitHub pre-release, which BRAT can install; directory users are not affected until the version bump is merged into `main` and the `0.4.0` tag is pushed.

Rules for contributors are in [CLAUDE.md](CLAUDE.md) (no Node/Electron modules at runtime, vector strokes only, versioned format with tested migrations, zero data loss).

## Licence

MIT. Third-party code: perfect-freehand (MIT). PDFs are rendered with the pdf.js that Obsidian provides. No code was copied from the other projects studied in [docs/research.md](docs/research.md).
