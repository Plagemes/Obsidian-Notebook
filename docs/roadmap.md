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

Every item below is implemented and its logic is covered by automated tests where it can be (see [testing.md](testing.md)); none has been verified on Android hardware. Rendering, gestures and performance only count once the protocol has been run on the device.

| Item | Status | Notes |
|---|---|---|
| Configurable smoothing and stabilization | 🧪 | stabilization slider 0–10, default 2; the perfect-freehand smoothing parameters are fixed constants, not configurable |
| Multiple pens and widths | 🧪 | pen: 9 colours, 5 widths |
| Transparent highlighter | 🧪 experimental | 5 colours, 3 widths, constant width, translucent with multiply blending; format v2 |
| Segment eraser (cuts strokes) | 🧪 | works across pages in one gesture, one undo step |
| Lasso selection: move, resize, rotate | 🧪 basic | one page per selection; uniform resize with a single handle; delete; copy, cut, paste and duplicate arrived later (M7 5, 6) |
| Smooth zoom and pan | 🧪 experimental | pinch and wheel zoom 0.25–8×; one-finger fling; CSS-transform fast path on heavy pages |
| Configurable palm rejection | 🧪 experimental | time window and finger-drawing toggle (from M1) plus a contact-size filter, off by default |
| Multiple pages with virtualization | 🧪 | stacked vertically, only visible pages and strokes are drawn; add page (undoable); delete, duplicate and reorder arrived in M3a |
| Reproducible benchmarks | 🧪 | `npm run bench` (pure logic), in-app benchmark, stress-test notebook (10,000 strokes / 10 pages), performance overlay; input→frame is a software measure, not display latency; PC numbers exist (see testing.md); numbers on the device are still to be collected |

To be confirmed with steps 10 and 13–21 of the protocol in [testing.md](testing.md).

## M3 — Notebook system — split into M3a, M3b and M3c

M3 was too large for one stable release, so it is split. Each part ships as its own version and starts from a stable one.

### M3a — Pages, paper and export (v0.3.0) — 🧪 implemented, waiting for hardware verification

Every item is implemented and its logic is covered by automated tests where it can be (196 unit tests); none has been verified on Android hardware. The PDF was parsed with pdf.js and the SVG rendered with resvg on the PC; neither was opened on a device.

| Item | Status | Notes |
|---|---|---|
| Paper kinds: blank, ruled, grid, dotted, millimetre | 🧪 | per page; format v3 (migration v2 to v3 is the identity; 0.2.x opens v3 files read-only and keeps a backup) |
| Page sizes A4, A5, Letter and orientation | 🧪 | per page; changing the size does not move or scale strokes (strokes outside a smaller page are kept but clipped); no custom sizes yet |
| Page menu: duplicate, move up/down, delete, paper, size, orientation | 🧪 | every action is one undo step; the last page cannot be deleted |
| New-notebook dialog with size, orientation and paper | 🧪 | the last choice is remembered as the default |
| Default paper and page size settings | 🧪 | also set by the dialog |
| Export page or notebook as PDF, page as SVG | 🧪 experimental | files are written next to the notebook; dependency-free PDF writer, uncompressed (large files for a lot of ink) |

To be confirmed with steps 23–26 of the protocol in [testing.md](testing.md).

### M3b — Objects (v0.4.0) — 🧪 implemented, waiting for hardware verification

Shapes (lines, arrows, circles, rectangles) · text boxes · images · ruler.

Status: 🧪 shapes (line, arrow, rectangle, ellipse, with hold-to-recognise), 🧪 text boxes, 🧪 images, 🧪 ruler; the lasso also selects text boxes and images. Logic covered by automated tests; none verified on Android hardware (steps 28–36 of the protocol in [testing.md](testing.md)).

### M3c — Library, PDF and canvas (shipped in v0.4.0) — 🧪 partly implemented, waiting for hardware verification

Library with folders, covers, tags, metadata, favourites and bookmarks · PDF import with annotation (Obsidian's `loadPdfJs()` first) · infinite canvas and custom page sizes · custom templates.

Status: 🧪 library (folders, covers and thumbnails, tags, favourites, recent, search, move/duplicate/delete, drag and drop), 🧪 page bookmarks and navigator, 🧪 PDF import and annotation (import as notebook, insert a page range), 🧪 infinite canvas as an infinite page (grows downwards), 🧪 scan into the notebook. ⏳ custom page sizes, ⏳ custom templates. Not verified on Android hardware.

## M4 — Obsidian integration — ⏳

Links to notebooks and to a specific page (🧪 `obsidian://notebook` links and page embeds shipped in 0.4.0; the rest ⏳) · backlinks, search and graph (need a Markdown representation: see the format notes in [architecture.md](architecture.md) §5) · Markdown representation of the notebook (title, tags, links, OCR text).

## M5 — AI and academic features — ⏳ (only after M1–M3 are stable)

Swappable providers, local first, cloud only as explicit opt-in · handwriting OCR, formulas → LaTeX · summaries, quizzes, flashcards, contextual chat, semantic search · audio recording synced with strokes · NotebookLM integration in layers (export package everywhere, optional Drive folder, optional experimental desktop-only direct send).

## M6 — Premium UX (cross-cutting) — ⏳

Floating customizable toolbar, fullscreen, UI that hides while writing, quick colour/width picker, portrait/landscape, dark mode, accessibility, light animations that do not affect latency.

## M7 — Additional features (backlog, planned 2026-10-29)

Beyond the original spec. Priority: **P1** next, **P2** very useful, **P3** nice to have. Status: ⏳ for all, except items marked 🧪 (implemented in 0.4.0 or 0.5.0, waiting for hardware verification).

### Writing and tools
1. **P1** 🧪 Favourite pens: 4–6 saved presets (tool + colour + width), one tap to switch.
2. **P1** 🧪 Configurable S Pen side button: hold for eraser, lasso or last tool.
3. **P1** 🧪 Multi-finger gestures: two-finger tap = undo, three-finger tap = redo (configurable).
4. **P1** 🧪 Scribble to erase: scratching over strokes deletes them.
5. **P1** 🧪 Restyle selection: change colour and width of lasso-selected strokes.
6. **P1** 🧪 Copy, cut, paste and duplicate selections across pages and notebooks.
7. **P2** Free colour picker with recent colours and an eyedropper.
8. **P2** Pressure curve calibration per device, with a test area.
9. **P2** Tilt-aware pencil (tiltX/tiltY widen and lighten the stroke).
10. **P2** Study tape: opaque strips that hide parts of a page and reveal on tap.
11. **P2** Zoom window for writing small on a large page.
12. **P3** Laser pointer (fading temporary ink) for presentations.
13. **P3** Protractor and compass alongside the ruler.

### Organisation and navigation
14. **P1** 🧪 Two scroll modes: continuous vertical (current) or one page at a time with horizontal swipe.
15. **P1** 🧪 Notebook outline: titled bookmarks shown as a table of contents.
16. 🧪 **P1** Global search in the library: titles, tags, text boxes (OCR later).
17. **P2** Links on the page: a region or element opens another page, notebook, Obsidian note or URL.
18. **P2** Back/forward history of visited pages.
19. **P2** Notebook templates: create a notebook from a saved notebook (planner, lab book).
20. **P2** Sticky notes: movable coloured notes on the page.
21. **P3** Paper colours (cream, dark, chalkboard) with ink adapted for contrast.

### Obsidian integration
22. 🧪 **P1** Embed a page in a Markdown note: a `notebook` code block renders a page preview.
23. **P2** Optional always-updated PDF copy next to each notebook (sharing, NotebookLM).
24. ~~**P2** Flashcards from the lasso: question and answer regions become a Markdown flashcard compatible with spaced-repetition plugins.~~ — moved to the "Study and exam update" (to be designed later, user decision 2026-10-29)

### Data and reliability
25. 🧪 **P1** Version history: automatic snapshots (e.g. daily per notebook) with restore.
26. 🧪 **P1** Page trash: deleted pages stay recoverable after the session ends.
27. **P2** Library check: find unreadable notebooks and orphaned assets, free space.
28. **P3** Password-protected notebooks: local encryption with Web Crypto, no cloud.

### Capture and sharing
29. 🧪 **P1** Scan into the notebook: the camera scan goes straight into the notebook as a page whose background is the cropped, perspective-corrected and enhanced photo (like a PDF page), so you write on it, reorder it in the navigator and export it like any other page. A multi-sheet session adds consecutive pages after the current one; alternatively a scan can be placed as an image on the current page. Enhancement filters: original, document (high-contrast black and white), whiteboard.
30. **P2** Quick share of a page as PNG or PDF through the Android share sheet.

## M8 — More features (backlog, planned 2026-10-29)

Continues the M7 numbering. Priority **P1** next, **P2** very useful, **P3** nice to have. Status: ⏳ for all, except items marked 🧪 (implemented in 0.4.0 or 0.5.0, waiting for hardware verification).

### Reliability and performance
31. 🧪 **P1** Instant save journal: each stroke is appended within milliseconds to a small journal next to the notebook and merged on the regular save, so even the last stroke survives Android killing the app.
32. ~~**P1** Diagnostic report: one command writes versions, device, settings and performance figures to a file for bug reports.~~ — dropped (user decision, 2026-10-29)
33. ~~**P2** Battery saver mode: fewer redraws, no predicted points, lighter thumbnails.~~ — dropped (user decision, 2026-10-29)
34. **P3** Optional compression of very large notebooks (compatible with the planned Markdown container).

### Advanced writing
35. **P1** New pen types: fountain pen (angle-dependent width), brush, marker.
36. **P1** 🧪 Auto-scroll while writing near the bottom of the screen.
37. **P2** Filled shapes and dashed or dotted lines.
38. **P2** Align and distribute the selection.
39. **P2** Group elements and lock elements (for example a background image that must not move).
40. **P2** Layers: annotations on a layer separate from the PDF, which can be hidden or locked.
41. **P2** Hand-drawn tables: insert a grid of cells and write inside it.
42. **P3** Symbol keyboard (Greek, maths) for text boxes.

### PDF
43. **P1** 🧪 Highlighter that snaps to the PDF's text lines (pdf.js text content).
44. **P1** 🧪 Search the PDF text, with hits highlighted on the pages.
45. **P2** Copy text from the PDF.
46. **P2** PDF outline and internal links: the PDF outline becomes the notebook outline, internal links work.
47. **P3** Export keeping the original vector PDF pages instead of images (needs an MIT library such as pdf-lib).

### Navigation and view
48. ~~**P1** Double tap to zoom: toggles fit-to-width and 100 %.~~ — dropped (user decision, 2026-10-29)
49. **P2** Two-page spread view (landscape tablets).
50. **P2** Fast scrollbar with a page preview while dragging.
51. **P2** Read-only mode to read without accidental marks.
52. **P2** Coloured sections inside a notebook (tab dividers, as in OneNote).

### Library
53. **P2** Custom covers (image or template).
54. **P2** Pinned notebooks, manual order and an archive that hides notebooks without deleting them.
55. **P3** Study statistics: writing time per notebook and per day, kept on the device.

### Study
56. **P2** Replay handwriting like a video (strokes redrawn in writing order); needs a timestamp per stroke, which also prepares audio sync (M5).
57. **P2** Task from a selection: a region of the page becomes a task in the daily note, linked back to the page.

### Integration and accessibility
58. 🧪 **P1** Direct `obsidian://` links to a page, to open it from other apps, bookmarks or a QR code.
59. **P2** Lasso selection as an image inserted at the cursor of the active Markdown note.
60. ~~**P2** Left-handed mode: toolbar on the other side and palm rejection tuned for left-handed writing.~~ — dropped (user decision, 2026-10-29)

## M9 — More features (backlog, planned 2026-10-29)

Priority **P1** next, **P2** very useful, **P3** nice to have. Status: ⏳ for all.

### Writing and tools
61. ~~**P1** Pen hover preview: with the S Pen near the screen, a circle shows the nib size and colour.~~ — dropped: the S Pen and Android already show the hover pointer (user decision, 2026-10-29)
62. **P1** 🧪 Adjustable eraser size with a visible eraser circle.
63. **P2** Rectangle selection in addition to the lasso.
64. **P2** Select by colour or tool (e.g. all highlighter strokes on this page).
65. **P2** Rotate by 90°, mirror and exact size for the selection.
66. **P2** Smooth or straighten selected strokes.
67. **P2** Textured pens: graphite pencil and gel.
68. **P2** Style eyedropper: take colour, width and tool from an existing stroke.
69. **P2** Smart connectors between shapes (diagrams).
70. **P3** Mind maps: linked text nodes that move together.
71. **P2** Magnetic snap to the grid and alignment guides.
72. **P3** Measuring tool: real distances in cm on the page.

### Pages and documents
73. **P1** 🧪 More papers: Cornell, music staff, isometric, hexagonal, calligraphy, planner.
74. 🧪 **P1** Save a page as a template, with a template gallery.
75. **P2** Automatic header with date and page number.
76. **P2** Rotate and crop imported PDF pages.
77. **P2** Merge notebooks, split a notebook, extract pages into a new notebook.
78. **P2** Move a selection to another page.
79. **P2** Drag files (images, PDFs) straight onto a page.
80. **P2** Bulk import in the library: drop many PDFs or images and they become notebooks.
81. **P2** Export all pages as PNG images, and print.
82. **P3** Portable package: a .zip with the notebook and its assets, to move it to another vault.
83. **P3** Import from Xournal++ and from SVG.

### Study
84. **P2** Action history panel (jump back to a point) and undo that survives reopening.
85. **P1** 🧪 Coloured bookmarks with categories ("important", "to review").
86. **P2** Margin comments attached to a region of the page.
87. **P2** Presentation mode: full-screen pages, with the laser pointer (#12).
88. **P3** Study timer (pomodoro) with a session log.
89. ~~**P2** Scheduled review: "review this page in 3 days", with a list of pages due.~~ — moved to the "Study and exam update" (to be designed later, user decision 2026-10-29)
90. **P2** Highlights digest: every highlighted region collected in a summary page.

## M10 — Native Obsidian integration (backlog, planned 2026-10-29)

Goal: notebooks behave like first-class Obsidian content. Several items depend on the container decision ("File format transition" below): O1 is the companion-note option (C) and must be designed together with it.

- **O1 P1** 🧪 Automatic companion note: every notebook has a `.md` with properties (tags, course, pages, dates) and the text of its text boxes, so search, graph, Dataview and Bases see notebooks.
- **O2 P1** 🧪 Shared tags: notebook tags are real Obsidian tags, visible in the Tags pane (through the companion note's `tags`; tag editor with the vault's tag suggestions, Obsidian-style normalisation, library filter by tag including nested tags; a tag the person added to the note by hand is never removed).
- **O3 P2** Native properties: course, teacher, exam date and similar edited from Obsidian's Properties panel.
- **O4 P1** 🧪 Page links: `[[Physics#p3]]` opens the notebook at that page, with link suggestions while typing.
- **O5 P2** Hover preview: hovering a notebook link shows the page thumbnail (page preview).
- **O6 P1** 🧪 Native embed syntax: `![[Physics.notebook#p3]]` renders the page in reading view and live preview.
- **O7 P2** Linked mentions: inside the notebook, for each page, the notes that link to it.
- **O8 P1** Links written with the pen: writing `[[` by hand (two bracket strokes) — or circling ink and choosing "Link" — opens the note suggester; the chosen note becomes a link attached to that ink, tapping it opens the note. The ink stays as written. The same works in text boxes with the keyboard.
- **O9 P1** 🧪 File explorer menu: "New notebook here" on folders, "Annotate in Notebook" on PDFs.
- **O10 P2** From Obsidian's PDF viewer: an "Annotate in Notebook" action.
- **O11 P3** Pages on Canvas: notebook pages as cards on an Obsidian Canvas.
- **O12 P2** Daily notebook: "Today's page" adds a dated page and links it from the daily note.
- **O13 P2** Obsidian templates: template notebooks and embeds in Templates/Templater.
- **O14 P1** 🧪 Commands and hotkeys for every tool (pen, eraser, lasso…), assignable in Hotkeys.
- **O15 P2** Status bar: "p. 3/12" and save state; tap opens the navigator.
- **O16 P1** 🧪 Reopen where you left off: workspace/session restore brings back the same page and zoom.
- ~~**O17 P1** Theme integration: colours, accent and dark mode followed everywhere; documented CSS variables for snippets.~~ — dropped (user decision, 2026-10-29)
- ~~**O18 P1** Sync conflicts: when Obsidian Sync creates a conflicted copy, a dialog compares both versions and merges their strokes.~~ — dropped: sync will go through Google Drive or OneDrive, not Obsidian Sync (user decision, 2026-10-29)
- **O19 P2** Obsidian search: text boxes (and OCR later) appear in global search through the companion note.
- **O20 P1** 🧪 Page into a note: "Copy link to this page" and "Insert this page into the active note" (link or embed).

## M11 — Original and advanced features (backlog, planned 2026-10-29)

Non-trivial features, many of them original to this project. Priority **P1** next, **P2** very useful, **P3** nice to have. Status: ⏳ for all.

### A. Smart writing (geometry, no AI)
91. **P1** 🧪 Insert or remove space: drag a line and everything below moves down (onto the next page if needed) or back up.
92. **P2** Handwriting reflow: handwritten lines re-wrap to a different width like text, words found from the gaps between strokes.
93. **P2** Align to baseline: crooked handwritten words are moved onto a common baseline.
94. **P2** Ghost guide lines on blank paper: they appear while writing and fade when you stop.
95. **P1** 🧪 Automatic next page: writing at the bottom of the last page appends a new page (different from infinite pages).
96. **P2** Strike-through as logical deletion: a line over a word marks it as deleted; it stays readable struck through and can be hidden.
97. **P1** 🧪 Selective eraser: erase only one kind of ink (only highlighter, only one colour) and leave the rest.
98. **P2** Per-page undo: each page has its own history; undo on one page never touches another.
99. **P2** Area highlighter: translucent rectangles, ideal on scanned PDFs.
100. **P1** Invisible ink for self-testing: write answers with a hidden pen and reveal them with "show solutions".
101. **P2** Colours with meaning: define what each colour means (red = definition, blue = example), filter the view by it and generate a digest per colour.
102. **P2** Headings from handwriting size (no OCR): lines written large become outline entries, shown as images of the ink.
103. **P2** Handwritten checklists: a drawn square becomes a tappable checkbox, linked to Obsidian tasks.

### B. PDF and study material
104. **P1** 🧪 Expandable margins on PDFs: widen a PDF page sideways to annotate without covering the text.
105. **P1** Anchored excerpts: cut a region of a PDF, drop it on another page as an excerpt; tapping the excerpt jumps back to the exact source location.
106. **P1** 🧪 Synchronised PDF ↔ notes view: the PDF on one side and the linked note pages on the other; turning a PDF page follows on the notes side.
107. **P2** Floating reference window: another page or notebook stays visible while you write.
108. ~~**P3** Read the PDF text aloud with the system's speech synthesis, offline.~~ — dropped (user decision, 2026-10-29)
109. ~~**P3** Reading ruler on PDFs: highlights the line being read (accessibility, dyslexia).~~ — dropped (user decision, 2026-10-29)

### C. Rich native Obsidian elements
110. **P1** Formulas and equations (advanced): an equation element with a live-preview editor and a palette of structures (fractions, matrices, integrals, systems); multi-line equations aligned on "=", optional automatic numbering; size adapts to the handwriting around it so formulas sit naturally next to the notes; configurable style (size, colour, numbering, inline or display); edited in place on the page; can be converted to vector ink to annotate or tweak by hand. Rendered with Obsidian's maths engine. Later, handwriting recognition (M5) fills the same element: write the formula by hand and it is typeset.
111. **P2** Markdown boxes on the page: real Markdown (lists, callouts, links) rendered by Obsidian.
112. **P2** Back of the page: each page can have a Markdown note as its back side; flip the page to type.
113. **P1** Function graphs (advanced), designed as a full element: several functions per graph (cartesian, parametric, polar, implicit, piecewise); parameters with sliders (a, b…) updating curves live; pan and zoom inside the graph; roots, intersections, maxima and minima found numerically and marked; tangents and shaded areas under curves; table of values; configurable axes, grid, labels and units (degrees/radians); ink written on the graph stays attached to the graph's coordinates when the graph is moved or zoomed; expressions parsed by a safe math parser (never eval); exported as vectors.
114. **P1** 🧪 Paste from the system clipboard: images and text become page elements.

### D. Study and planning
115. **P1** 🧪 Class timetable: define the weekly timetable; new pages are tagged with the course in progress, and opening the app during a class opens that course's notebook on a new page.
116. ~~**P1** Exam review plan: set an exam date per notebook and its pages are spread over the remaining days for review.~~ — moved to the "Study and exam update" (to be designed later, user decision 2026-10-29)
117. ~~**P2** Review coverage map: thumbnails coloured from "never reviewed" to "reviewed often".~~ — moved to the "Study and exam update" (to be designed later, user decision 2026-10-29)
118. **P2** Planner generator: a planner notebook with dated month, week and day pages linked to each other.
119. **P1** 🧪 Page tags: tags on single pages, filterable in the navigator and in search.
120. **P2** Smart collections in the library: saved rules (tag + folder + period + favourite).

### E. Versions, review, collaboration
121. **P2** Visual version diff: additions in green, removals in red, between the current version and a snapshot.
122. **P1** 🧪 Merge conflicted copies created by Google Drive or OneDrive: compare both copies and merge the strokes (by id) without losing anything.
123. **P3** Stroke authors in notebooks shared through a common folder: filter and colour by person or device.
124. **P2** Lock a finished page.
125. **P1** 🧪 Last position shared across devices: reopen on the phone at the page you were on with the tablet (stored in the notebook, so it travels with the sync).

### F. Sync and storage
126. **P1** Optional Google Drive / OneDrive connector inside the plugin (opt-in only), configurable scope: the whole vault, only selected folders, or include/exclude rules (patterns, file types, size limits). When to sync: on open, on close, on an interval or manually; "Wi-Fi only" option; rules for large files. Conflicts merged with #122; never a mandatory cloud.
127. **P2** Scheduled backups to an external folder or to Drive (e.g. a weekly zip).
128. **P2** Storage manager: size of each notebook, duplicate or unused assets, downscaling of heavy images.

### G. Navigation and workflow
129. **P3** Search by drawing: sketch a shape and find pages with similar drawings (geometric descriptors, no AI).
130. **P2** Semantic zoom: when zoomed out, headings and excerpts are shown large for orientation.
131. **P3** Arrows linking regions of different pages, visible in the side-by-side view.
132. **P2** Live lecture mode: a timer and quick buttons ("new page", "important moment"); each mark becomes a timestamped bookmark.
133. ~~**P2** Course dashboard page that updates itself: next exam, pages due for review, recent notebooks.~~ — moved to the "Study and exam update" (to be designed later, user decision 2026-10-29)
134. **P2** Pen sets per subject, loaded automatically with the notebook (e.g. maths or languages).
135. **P2** Mirror page: a page that always shows the current content of a page in another notebook (transclusion).
136. **P3** Handout printing: several pages per sheet with space for notes.
137. **P2** Templates with fields: title, date and topic filled by hand or keyboard become properties of the companion note.
138. **P3** Progressive reveal in presentation mode: a page is shown piece by piece.
139. **P1** Pen gestures, designed to be genuinely useful:
    - No false positives: gestures start only while the S Pen button is held (or after a long press), never during normal writing.
    - Preview before committing: the recognised command is shown before the pen lifts; moving back along the stroke cancels it.
    - Context-aware: a circle around ink selects it; a scribble deletes (#4); "^" inserts space (#91); "#" tags the page (#119); a star bookmarks; "?" opens search; an arrow from a selection to a navigator thumbnail moves it to that page.
    - Custom gestures: record your own (three samples each) and bind them to any Obsidian command.
    - Cheat sheet overlay listing the available gestures; per-gesture enable/disable.
    - Ink interpreted as a gesture is never saved, but undo restores it as ink.
140. **P1** 🧪 Guided repair of damaged notebooks: recovers valid pages and strokes from an unreadable file into a new notebook, never touching the original.

## M12 — More advanced features (backlog, planned 2026-10-29)

Priority **P1** next, **P2** very useful, **P3** nice to have. Status: ⏳ for all.

### A. Ink and geometry
141. **P2** Touch-up brush: push or pull an existing stroke to fix its shape without rewriting it.
142. **P1** 🧪 Personal stamps: drawings, symbols and signatures you reuse, saved in a palette and dragged onto pages.
143. **P2** Subject symbol kits with snapping: rings and bonds for chemistry, components for circuits, vectors for physics.
144. **P2** Parametric 3D solids (cube, cylinder, cone, prism) with editable dimensions and perspective.
145. **P2** Automatic geometric constraints while drawing shapes: snap to parallels, perpendiculars, tangents and midpoints of existing shapes.
146. **P3** Symmetric drawing: mirror or radial axis.
147. **P2** Computable table: typed cells with spreadsheet-like formulas (sums, averages, percentages).
148. **P2** Timeline element: dated events with automatic spacing.
149. **P1** 🧪 Ink attached to objects: ink written over an image, table, graph or formula moves and scales with it.
150. **P2** Free page rotation with two fingers, like turning real paper.
151. **P1** 🧪 Configurable edge rejection zones: a palm resting on the screen edge does nothing.
152. **P1** 🧪 Radial menu at the pen tip: pressing the S Pen button shows tools in a circle around the nib.

### B. PDF
153. **P2** Fill PDF forms (fields) by hand or keyboard; export them filled.
154. **P2** Reusable signature and date stamp for documents.
155. **P1** 🧪 Export PDF annotations to a Markdown note: highlights, excerpts and comments, each with a page link.
156. **P2** Import existing annotations from PDFs annotated in other apps, as editable items.
157. **P3** Export ink as native PDF annotations, editable in other PDF readers.
158. **P2** Zotero and literature-note link: from a PDF page to its citation.
159. **P3** Split scanned two-page spreads into two pages.

### C. Library
160. 🧪 **P1** Library trash with restore.
161. **P2** Board view with statuses (in progress, done, to print).
162. **P2** Calendar view: what you wrote on a given day.
163. **P2** Per-notebook settings: stabilization, palm rejection, default paper, sync.

### D. Sharing and open formats
164. **P2** Interactive HTML export: zoomable vector pages that open anywhere, without Obsidian.
165. **P2** Collaboration, also with people who do not use Obsidian:
    - Guests join from any browser through a lightweight web viewer/editor; nothing to install.
    - Direct peer-to-peer connection (WebRTC) set up by scanning a QR code; works on the same network even without internet; no mandatory cloud.
    - Live: everyone's pen and cursor visible, a colour per participant (#123), permissions (view only, write on own layer, write anywhere), "follow the presenter", laser pointer, shared PDF pages, optional audio.
    - Conflict-free by design: every stroke has a unique id, so concurrent edits never clash; at the end everything lands in the host's notebook with the author of each stroke.
    - Asynchronous too: people without Obsidian annotate in the web viewer (#164) and send back an annotation package that is imported with one tap; or the notebook is shared on Drive with conflict merging (#122).
166. **P3** InkML export (open standard for digital ink).
167. **P2** Documented format with a JSON Schema, so other tools can read notebooks.

### E. Automation
168. **P1** 🧪 Public API for other plugins (Templater, QuickAdd, Dataview): create notebooks, add pages, insert images, export. See `docs/api.md`.
169. **P2** If/then rules (e.g. "notebook in folder Physics → millimetre paper", "on close → update the PDF copy").
170. **P2** Macros: a sequence of commands on one toolbar button.

### F. Images and view
171. **P2** Image editing: crop, rotate, brightness and contrast.
172. **P1** 🧪 White background made transparent: pasted images and screenshots blend with the paper.
173. **P2** Minimap for infinite pages and high zoom.

### G. More original ideas
174. ~~**P2** Draft and fair copy: write a draft, then the draft dims and you rewrite cleanly on top; the draft can be hidden.~~ — dropped (user decision, 2026-10-29)
175. ~~**P2** Magnifier lens following the pen, to read small PDF text while writing.~~ — dropped (user decision, 2026-10-29)
176. **P1** 🧪 Loose sheet: a quick-notes notebook opened from anywhere in Obsidian; move its content to the right notebook later.
177. **P2** Inbox folder: files shared from other Android apps land there and the plugin offers to put them into a notebook.
178. **P2** Split an infinite page into A4 pages for export and printing.
179. **P2** Two-way page references: if page 3 refers to page 7, page 7 shows "referenced on page 3".
180. **P1** 🧪 Restore a single page from a previous version, leaving the rest untouched.
181. **P2** Reference sheets, dynamic and integrated:
    - Sources: built-in sheets (interactive periodic table with element data, physical constants, formula sheets, unit tables, Greek alphabet), your own notebook pages or Obsidian notes marked as "reference", and sheets you add.
    - Search, subject filters, and suggestions based on the course of the open notebook.
    - Docked side panel or floating window.
    - Drag a formula or an element card onto the page and it becomes a real element (formula #110 or stamp #142); values are available by name in the calculator (#182).
    - Visual style consistent with the rest of the plugin and with Obsidian.
182. **P2** Advanced calculator:
    - Unit-aware expressions ("3 km/h to m/s") and constants by name from the reference sheets (g, c, h…).
    - Variables that persist on the page (a = 3.2, then a·2); exact fractions, complex numbers, matrices and vectors, statistics on lists, numeric equation solver.
    - Degrees/radians, scientific notation and significant figures configurable; calculation history tape; large pen-friendly keys; link to function graphs (#113).
    - The result is inserted as text or as a formula element together with its expression.
    - Same safe math parser as the graphs (no code execution). Later (M5): handwritten calculations.
183. **P3** Gentle snapping of handwriting to the lines while writing on ruled paper.
184. **P2** Paint bucket: fill closed areas with colour (diagrams, maps).
185. **P1** 🧪 Erase area: draw an outline and everything inside disappears, in one gesture.
186. **P2** Copy a page into another notebook, with a link back to the source page.
187. **P2** Back-of-book index: mark terms or regions and an index page with references is generated.
188. **P1** 🧪 Show/hide all annotations, to reread a clean PDF.
189. **P2** Attachments on the page: Word files, zips and others as icons that open on tap.
190. **P2** Page QR code: scan it with the phone and the page opens on the other device.

## M13 — During the lecture (backlog, planned 2026-10-29)

Features for following a lecture live. Exam and review features stay in the separate "Study and exam update". Priority **P1** next, **P2** very useful, **P3** nice to have. Status: ⏳ for all.

### Before the lecture
191. **P1** 🧪 Lecture pack: import the course slides and the lecture notebook is ready (slides as page backgrounds to write on directly, header, dated section). Plus a quick "exercise page here" action (button or gesture) between two slides: inserts a blank page with the same size and an exercise paper of your choice — matching the usual workflow of annotating on the slides and solving exercises on a page inserted between them.
192. **P1** 🧪 Slide + notes layout: each slide scaled down on a page with lines beside or below it (1, 2 or 3 slides per page). 0.6.0 does one slide per page; two or three per page need a format change.
193. **P1** 🧪 A notes page after every slide (import option).
194. ~~**P2** Timetable imported from the university calendar (.ics).~~ — dropped (user decision, 2026-10-29)
195. **P2** Course syllabus page: topics get ticked as lectures cover them, with links to the pages.

### During the lecture: fast capture
196. **P1** 🧪 Instant board shot: one tap, automatic crop and whiteboard filter, the photo lands where you are writing, with the time.
197. **P2** Burst of projected slides: perspective corrected, two shots of the same slide merged.
198. **P2** Phone as the tablet's camera: shoot with the phone and the photo appears in the notebook open on the tablet (paired with a QR code).
199. **P1** 🧪 Dim the background: slides or PDFs become lighter so the ink stands out.
200. **P2** Zoomed detail: crop a region of a slide and place it enlarged beside it, linked to the original.
201. **P1** "To complete" placeholder: when you fall behind, leave a marked gap with time and slide; later you get the list of gaps.
202. **P1** Questions for the lecturer: mark a question on the page; it goes to a list for the end of class or office hours, with a resolved state.
203. **P1** Importance markers (!, !!, ★) on the page, collected per lecture.
204. **P1** Structured boxes: Definition, Theorem, Example, Proof, Remark — frames drawn on the fly that become callouts in the companion note.
205. **P2** Automatic numbering of boxes (Def. 3.2) and an index of the course's definitions and theorems.
206. **P2** Instant axes: one gesture drops Cartesian axes with ticks for quick hand-drawn graphs.
207. **P2** Personal shorthand: your abbreviation symbols with an automatically generated legend.
208. **P1** Quick textbook reference: "p. 134" becomes a link to the textbook PDF at that page.
209. **P1** Assigned homework: a "homework" stamp with a due date that becomes an Obsidian task.
210. **P2** Automatic lecture header: course, lecturer, room, date and time from the timetable.
211. **P1** 🧪 "Pen only" toggle at hand: instantly ignores fingers when you rest your hand.
212. **P2** Recent symbols: the symbols you draw most often (∀, ∫, →) become buttons to insert them quickly.
213. **P2** "Look up later" list: circle a word and it goes to a list, with its image.
214. **P2** Compact lecture toolbar: only 4–5 large tools.
215. **P2** Board photo: keep or trace. Keep the photo as it is, or switch to tracing mode: the photo becomes semi-transparent (removable) and the drawing in it is automatically vectorised into ink — dark lines detected, thinned to centre lines, simplified into smooth curves, each stroke taking the photo's colour; a slider sets the sensitivity. The result is normal ink you can edit, erase or move. Own implementation (potrace is GPL and cannot be used).

### Structure and time
216. **P1** 🧪 "New lecture" command: creates a section with date and title in the course notebook.
217. **P2** Start and end time on every page (also the basis for audio in M5).
218. ~~**P2** Automatic new-lecture suggestion after a long pause since the last writing.~~ — dropped (user decision, 2026-10-29)
219. **P2** "Lecture" and "study" profiles: one tap switches pens, paper and stabilization for fast or careful writing.
220. **P2** End-of-lecture summary: three guided lines (Cornell style), also saved in the companion note.
221. **P2** Lecture log in the daily note.
222. **P2** Automatic snapshot at the end of the lecture (version history).
223. **P1** "End of lecture" panel: open questions, gaps, homework and markers at a glance.

### Slides and board
224. **P2** "Slide explained" ticks: see how far the lecturer has got.
225. **P2** "Back to the current slide" after looking elsewhere.
226. **P1** Automatic notes ↔ slide link: ink remembers which slide was visible in the side-by-side view while you wrote it; tapping it shows that slide again.
227. **P2** Quick tabs: pages pinned during the lecture (e.g. the formula sheet), one tap away.
228. **P2** Lecture figure gallery: all photos and crops of the section in one place.
229. **P3** Peek at the next slide while writing.
230. **P3** Continuous board: a horizontally scrolling page for long blackboards.

### Online or recorded lectures
231. **P2** Course video materials side by side (local files or links; lectures themselves are not recorded): floating video window; each note remembers the minute and tapping it resumes the video there.
232. **P2** Video frame into the notebook.
233. **P2** External audio recording aligned to the notes by clock time (recorded with another app).
234. ~~**P3** Imported subtitles/transcript (.srt, .vtt) aligned in time and shown next to the pages.~~ — dropped: covered by M5 (voice recording, subtitles and transcription live there) (user decision, 2026-10-29)

### After the lecture: completing
235. **P1** 🧪 Re-published slides: handles both ways lecturers publish.
    - The whole PDF re-published with more pages (pages 1…n+x): pages already in the notebook are recognised by a content fingerprint (not by page number), only the new pages are added after the last ones, and existing notes stay attached to their slides even if the order changed.
    - A slide that changed is flagged as "updated": switch it to the new version keeping the notes, or compare the two.
    - Only the new pages published: they are appended.
    - Placeholders left during the lecture (#201) are filled by the matching slides.
236. **P2** Completion walkthrough: a guided tour of the gaps and open questions.
237. **P2** A classmate's notes side by side with yours for the same lecture (PDF or photos).
238. **P2** One-step page tidy-up: align, straighten and compact spacing.
239. **P2** Clean notes export: the lecture as a PDF without placeholders or markers, ready to share.
240. **P2** Lecture shared with the study group: at the end, a rule exports the clean notes to a shared (Drive) folder.

### Dynamic drawings
241. **P1** Drawings with states (e.g. physics exercises): draw a figure once, then mark the parts that change (a block, a force arrow, a spring) and define for each state where they are, their rotation or scale, visibility and colour.
    - States can be named ("A", "B", "impact") or follow a continuous parameter (time t, angle θ); a part's position can follow a formula (e.g. x(t) = v·t), shared with the calculator (#182) and graphs (#113).
    - Several instances of the same drawing on the page, each showing a different state (e.g. "state A" above, "state B" below in the exercise): nothing is redrawn, and editing the original updates every instance.
    - Switch states with tabs or a slider on the figure; optional animation to watch the evolution over time.
    - Export renders each instance at the state it shows.

## M14 — More features (backlog, planned 2026-10-29)

Priority **P1** next, **P2** very useful, **P3** nice to have. Status: ⏳ for all.

### Technical and scientific drawing
242. **P2** Dynamic geometry: points and figures linked by constraints that update when you drag one (a lightweight GeoGebra inside the page).
243. **P2** Scale drawing with dimensions: set the scale (1 cm = 1 m) and measurements and dimension lines show real sizes.
244. **P2** Charts from table data (bar, line, pie), updated when the numbers change.
245. **P2** Hand-drawn flowcharts that tidy themselves: boxes and arrows recognised, aligned and connected.
246. **P2** Leader-line labels, auto-aligned, for annotated figures (anatomy, diagrams).
247. **P2** Numbered markers on a figure (1, 2, 3) with an automatically generated legend.
248. **P2** Figure captions and numbering ("Fig. 3") with references that update themselves.
249. **P2** Automatic course formula sheet: collects every formula element (#110) into one page.
250. **P3** Pattern fills (hatching, dots).
251. **P3** Duplicate in series: copies on a grid or along a path.
252. **P3** Tree diagrams (probability, decisions) with automatic layout.
253. **P3** Even out handwriting: make size and slant of selected words consistent.
254. **P3** Automatic indentation of handwritten lists.

### Ink structure (foundation for many features)
255. **P1** 🧪 Words and lines detected without OCR: double tap selects a word, triple tap a line. Basis for reflow (#92), alignment (#93) and headings (#102).
256. **P2** Line handle: drag whole lines to reorder them.
257. **P2** Overwrite: write over a word and the new one replaces the old.
258. **P3** Smart underline: a line under a word is straightened and fitted to that word.
259. **P3** Self-adjusting boxes: a frame around handwriting grows when lines are added.

### Even closer Obsidian integration
260. **P2** Ink on top of Markdown notes: write by hand directly on a regular note (feasibility study first).
261. **P2** Sketch inside a Markdown note: a small handwriting block inside the note.
262. **P2** Turn a region into an atomic note (Zettelkasten style), with the ink image and a link back. — superseded by the Zettelkasten system (Z1–Z12) below.
263. **P2** Links to a precise region of a page, not only to the page.
264. **P2** Saved views: a named region + zoom, recalled instantly.
265. **P2** Global bookmarks: pages from different notebooks in one list.
266. **P2** Planner pages showing Obsidian tasks and due dates on top.
267. **P2** Linked images: if the file in the vault changes (e.g. a plot exported from Python), the image on the page updates.
268. **P3** Table linked to a CSV in the vault, updating itself.
269. **P3** Export to Excalidraw.
270. **P3** Ink inside Obsidian Canvas.

### Devices and Android
271. **P1** 🧪 Instant start: reopens the last page in under a second.
272. **P2** E-ink mode for Android e-ink tablets (e.g. Boox): high contrast, no animations, refresh-friendly drawing.
273. **P2** Same notebook in two side-by-side views: two different pages, shared edits.
274. **P3** Android home-screen shortcut to the last notebook or page.
275. **P3** S Pen buttons and Air actions to turn pages in presentation mode (to verify whether the WebView receives them).
276. **P3** Graphics tablets on Windows: buttons, pressure, tilt.
277. **P2** Copy to the system clipboard as an image, to paste into messaging, mail and other apps.

### Paper ↔ digital and exports
278. **P2** Paper round trip: print pages with a code, write on paper, scan it and it returns to the right page of the notebook.
279. **P2** Custom paper editor: spacing, colours, margins, header area, combinations.
280. **P2** Export only the written area, or the selection, as transparent PNG or SVG.
281. **P3** Poster printing over several sheets.
282. **P3** Export optimised for e-ink readers.
283. **P3** Export to LaTeX/Overleaf for theses and reports.
284. **P3** Import from other apps (Samsung Notes, Goodnotes, OneNote) where the format allows it (to be researched).

### Privacy and sharing
285. **P2** Redaction before export: cover personal data or parts not to share.
286. **P3** Safe presentation: show only chosen pages; the rest of the notebook stays hidden.
287. **P2** "What changed": opening a notebook edited on another device shows the differences.
288. **P3** Duplicate or similar pages: find slides imported twice and duplicated pages.

### Accessibility and learning
289. ~~**P3** Colour-blind-safe palettes, with simulation.~~ — dropped (user decision, 2026-10-29)
290. ~~**P3** Alternative descriptions of figures and images for screen readers.~~ — dropped (user decision, 2026-10-29)
291. ~~**P3** Handwriting practice with a model and comparison, for languages with other scripts.~~ — dropped (user decision, 2026-10-29)

## M15 — Zettelkasten with handwriting (planned 2026-10-29)

A complete Zettelkasten workflow where handwriting is first-class. Everything goes through the companion note (O1) and the format layer, so it stays valid if notebooks move to a Markdown container. Status: Z1, Z2, Z3, Z11 and Z12 🧪 implemented in wave 0.6 (not verified on hardware; design in `docs/architecture.md` §12 "Zettelkasten"); the rest ⏳.

- **Z1 P1** 🧪 Real cards: a region of a page, or an A6 "card" page, becomes a Zettel — a Markdown note with a unique id (timestamp or Luhmann numbering, configurable), properties (type, source, tags, date) and the ink embedded live (no copy: editing the ink in the notebook updates the card).
- **Z2 P1** 🧪 Slip-box notebook type: every page is a Zettel; a new page creates its note automatically.
- **Z3 P1** 🧪 Drawn links: draw an arrow between two cards (or regions) and a two-way link is created between their notes; visible in Obsidian's graph.
- **Z4 P1** Processing flow: fleeting notes (loose sheet #176, markers, questions) go to an "to process" inbox; PDF excerpts (#105, #155) become literature notes with their source; a guided view lets you discard each one, turn it into a permanent card, or link it to an existing one.
- **Z5 P2** Link suggestions while creating a card: related cards by tags, title and text-box text (MiniSearch), so no card stays isolated.
- **Z6 P2** Drawn maps of content: a page where cards are placed as live transclusions and relations are drawn; it also generates a Markdown MOC.
- **Z7 P2** Sequences and branches (Luhmann style 1, 1a, 1a1), optional, with previous/next/children navigation.
- **Z8 P2** Slip-box view in the library: browse cards like index cards, filter by tag, "draw a random card" to rediscover ideas.
- **Z9 P2** Card templates: concept, question, quote, definition.
- **Z10 P2** System hygiene: orphan cards (no links), duplicates, cards without a typed title.
- **Z11 P1** 🧪 Title and transcription: each card has a typed title (search and graph) and a transcription field, filled by hand or later by handwriting recognition (M5).
- **Z12 P1** 🧪 Container-proof: built on the companion note (O1) and the format layer.

## M16 — More features (backlog, planned 2026-10-29)

Priority **P1** next, **P2** very useful, **P3** nice to have. Status: ⏳ for all.

### STEM tools (no AI)
292. ~~**P2** Step checker: type the steps of a calculation one per line; each line is checked numerically for equivalence with the previous one.~~ — dropped (user decision, 2026-10-29)
293. **P2** Dimensional analysis of formulas: flags inconsistent units.
294. **P2** Balancing of typed chemical reactions.
295. **P2** Statistics from table data: mean, deviation, regression, with the line drawn on the chart.
296. **P3** Step-by-step linear systems and matrices shown on the page.
297. ~~**P3** Basic vector maps as backgrounds for geography and history (public-domain data).~~ — dropped (user decision, 2026-10-29)
298. ~~**P3** Truth tables and simulated logic circuits.~~ — dropped (user decision, 2026-10-29)
299. **P2** Physics simulations on drawings with states (advanced):
    - Declare bodies and quantities on the parts of a drawing with states (#241): mass, initial velocity, forces, friction, springs, constraints (inclined plane, rope, pivot).
    - A numerical engine (own RK4 integrator) computes the motion: projectiles, inclined planes with friction, springs, pendulums, 1D/2D collisions, multi-body systems.
    - Time slider; velocity, acceleration and force vectors drawn automatically to scale; trajectory left as a trace.
    - Linked graphs x(t), v(t), a(t) and energies, built on function graphs (#113); parameters with sliders shared with the calculator (#182); units always consistent.
    - Presets for common exercise types; chosen instants become instances of the drawing on the page (#241).
    - "Check my result": compares the values you computed by hand with the simulation's.

### Annotating vault files without converting them
300. **P2** Annotate vault images: the ink lives in a side file, the image stays untouched.
301. **P2** Annotate vault PDFs in place: the PDF is not modified; the ink lives in a side file.
302. **P3** Clean web page to annotate (to be researched).

### Practice and exercises (not exams)
303. **P1** Redo the exercise (advanced):
    - Choose what to hide: all your ink, only some colours or layers (e.g. the working but not the notes on the statement), or only a selected region; works on PDF exercise sheets (the PDF stays, only your solution disappears).
    - The practice copy goes right after the original or into an "exercises" notebook, always linked to the original.
    - "Peek at the solution": hold a button to see the original working until you let go.
    - Attempts are kept, numbered and dated, to see progress; optional timer per attempt.
    - Variants with different numbers: when the exercise uses variables or drawings with states (#182, #241), a variant is generated for more practice.
304. ~~**P2** Overlay two pages: your working and the solution, one over the other with transparency.~~ — dropped (user decision, 2026-10-29)
305. **P3** Correction layer for tutors or classmates, with accept and reject. Works like "track changes" for ink: a tutor, the lecturer or a classmate writes corrections on a separate layer (through a shared Drive folder or a collaboration session); you go through them and accept (merged into your notes) or reject (removed). (Confirmed by the user, 2026-10-29.)

### Page structure
306. **P2** Nested detail pages: a mark opens a dedicated sub-page, like a full-page footnote.
307. **P3** Nested zoom: a region of a page contains another page in miniature.
308. **P2** Drawn containers: circle a group of ideas and it becomes a container that moves them together.
309. **P3** Handwritten kanban on the page.
310. **P3** Handwritten Gantt chart.
311. **P3** Meeting minutes: attendees, decisions, actions that become tasks.
312. **P2** Virtual notebook: gathers pages from several notebooks by tag or rule without copying them; browse and export it like a real notebook.

### Writing and pen
313. **P2** Automatic joining of broken strokes caused by tiny pen dropouts.
314. **P2** Cleanup of hooks and stray dots at the start and end of strokes.
315. **P2** Thumb bar: a finger of the free hand switches tools while the pen keeps writing.
316. **P2** Editable Bézier curves with handles, for precise drawings.
317. **P3** Freehand arrows: any drawn curve can get an arrowhead.
318. **P3** Snap to the endpoints of existing ink.
319. ~~**P3** Eraser that grows with pressure.~~ — dropped (user decision, 2026-10-29)
320. ~~**P3** Column alignment of handwritten numbers.~~ — dropped (user decision, 2026-10-29)
321. **P3** Local grid: lines or squares only in one region of the page.
322. ~~**P3** Colour by session: ink coloured by when it was written.~~ — dropped (user decision, 2026-10-29)
323. **P3** Configurable haptic confirmation: vibration enabled per event type (gestures, saves, shape recognition), where the device supports it.
324. **P3** Precision cursor for finger writing.

### Obsidian integration
325. **P2** Box with a block of a note, transcluded live with `^block`.
326. **P3** Dynamic list on the page, Dataview style: notes and notebooks filtered, always up to date.
327. **P3** Page properties beyond tags.
328. **P3** Variables shared across the whole notebook for the calculator and graphs.

### Reliability and performance
329. **P1** 🧪 Progressive loading of huge notebooks, page by page.
330. **P3** Tamper-evident lab notebook: dated entries, signatures, hash chain.
331. **P3** HEIC/HEIF photo support.

### Thesis, assignments, sharing
332. **P3** Thesis mode: chapters, numbered figures, bibliography, single export.
333. **P3** Export numbered figures as separate high-resolution files.
334. **P2** Assignment hand-in: export chosen pages as a PDF with a cover (name, course, date) after checking blank pages and open placeholders.
335. **P3** "For correction" export: wide margins and line numbers for the teacher.
336. **P3** Export pages as 16:9 slides.
337. **P3** Timelapse video or GIF of the writing, from the replay feature.
338. **P3** Private presenter notes on a second screen.
339. **P3** Step-by-step procedures with the time recorded at each tick, for labs.
340. **P3** Book from ISBN: scan the barcode and create the book note for the bibliography.
341. ~~**P2** Night mode for PDFs: inverted pages with ink always readable.~~ — dropped (user decision, 2026-10-29)

## M17 — More features (backlog, planned 2026-10-29)

Checked against every earlier item before being added. Priority **P1** next, **P2** very useful, **P3** nice to have. Status: ⏳ for all.

### Sync and data safety
342. **P1** "Open on another device" warning: a small presence file, refreshed while a notebook is open, warns before Google Drive or OneDrive can create a conflicted copy.
343. **P1** Assets waiting for sync: images and PDFs referenced by a page but not yet downloaded show a "waiting for sync" placeholder instead of an error, and appear by themselves when they arrive.
344. **P1** Online-only notebooks: files that the sync client has not downloaded yet (0 bytes) are shown as "not downloaded yet" and never treated as damaged.
345. **P2** Warning when the notebooks folder is excluded from sync, or when a file exceeds the cloud provider's limits.
346. **P1** Safe mode: if opening a notebook crashed last time, it reopens without low-latency ink, thumbnails and companion notes, and says so.
347. **P1** Storage full: edits stay in the journal, a clear warning appears and saving retries by itself.
348. **P3** Readable change summaries for Obsidian Git users: what changed in a notebook in each commit (pages, strokes, assets).

### Writing and pen
349. **P2** Pressure lock: while the pen button is held, the width stays constant (even lines).
350. **P2** Pen width relative to zoom (option): the same width on screen at any zoom.
351. **P2** Stroke taper settings: tapering at the start and end of a stroke.
352. **P2** Write big, store small: write margin notes at a comfortable size and they are shrunk into place.
353. **P2** Automatic line break: when writing reaches the right margin, the view jumps to the start of the next line.
354. **P3** Right-to-left writing: automatic next page, word detection and the space tool also work for Arabic and Hebrew.
355. **P2** Stylus profiles: S Pen, USI and other pens recognised automatically, with settings that suit them.
356. **P2** Quick date and time stamp at the pen position.

### Objects and selection
357. **P2** Layer order: bring to front, send to back.
358. **P2** Opacity slider for ink, highlighter and images.
359. **P2** Lasso selection across page boundaries.
360. **P3** Code text box: monospace with syntax colours.
361. **P2** Find and replace in the text boxes of a notebook.
362. **P2** Cross-device clipboard: copy on the tablet, paste on the phone, through the vault.

### Navigation and view
363. **P2** Tabs of open notebooks, with a swipe from one to the next.
364. **P1** Quick switcher for pages across all notebooks.
365. **P1** Recently edited pages across all notebooks.
366. **P1** Go to page by typing its number.
367. **P2** Night mode: dark page display without changing the stored ink colours.
368. **P3** Projector and high-contrast mode.
369. **P3** One-hand mode on phones.
370. **P2** Adjustable toolbar size and large icons.
371. ~~**P3** Samsung DeX layout for mouse and keyboard.~~ — dropped (user decision, 2026-10-29)
372. **P2** Page turner: volume keys, a Bluetooth clicker or a keyboard turn pages and undo.
373. ~~**P3** Phone as a remote page navigator for the tablet.~~ — dropped (user decision, 2026-10-29)
374. 🧪 **P1** Do not disturb while writing: no notices or pop-ups while the pen is on the screen. (Wave 0.8: the plugin's own notices and non-urgent background work wait for a pause; Obsidian's own notices cannot be held back.)
375. **P2** Workspace presets, e.g. "lecture" (slides, notebook, outline) with one command.

### PDF
376. **P2** View-only crop of a PDF's white margins, for small screens.
377. **P3** Reflowed reading mode for a PDF's text on phones.

### Pages and notebooks
378. 🧪 **P1** Operations on several selected pages: move, change paper, export or delete them together. (Wave 0.8, in the page panel.)
379. **P2** Page information: dates, devices, stroke count, size.
380. **P2** Heavy page warning, with an offer to split the page.

### Export and Obsidian
381. **P2** Export choices: ink only, background only, or both.
382. **P2** Export a notebook as Markdown with page images, for people without Obsidian.
383. **P3** Obsidian Publish support: pages published as images.
384. **P2** Notebook commands in the Obsidian mobile toolbar.
385. **P2** Bookmark a notebook page in Obsidian's Bookmarks pane.

### Performance
386. **P3** Optional WebGL renderer for very large pages.
387. **P2** Level of detail: simplified strokes when zoomed out, for smoother scrolling.

### Extensions of earlier items
388. 🧪 **P1** Stable page links (extends O4): links based on the page id, so they still work after pages are reordered (today `#p3` points at a position). (Wave 0.8: generated links carry the id; command *Update links to notebook pages*. Recent pages and the quick switcher, 364 and 365, still have to use `stablePageSubpath`.)
389. **P2** Automatic page in the middle of a notebook too (extends #95): filling a page offers to insert one right after it.
390. **P1** Integrity check with checksums (extends #27): finds silent corruption caused by sync and offers to restore an earlier version.
391. **P2** Stroke timestamps linked to the lecture video (extends #231): tapping ink jumps the video to the minute it was written.

## M17 — More features (backlog, planned 2026-10-29)

Checked against every earlier item before being added. Priority **P1** next, **P2** very useful, **P3** nice to have. Status: ⏳ for all.

### Sync and data safety
342. **P1** 🧪 "Open on another device" warning: a small presence file, refreshed while a notebook is open, warns before Google Drive or OneDrive can create a conflicted copy.
343. **P1** 🧪 Assets waiting for sync: images and PDFs referenced by a page but not yet downloaded show a "waiting for sync" placeholder instead of an error, and appear by themselves when they arrive.
344. **P1** 🧪 Online-only notebooks: files that the sync client has not downloaded yet (0 bytes) are shown as "not downloaded yet" and never treated as damaged.
345. **P2** 🧪 Warning when the notebooks folder is excluded from sync, or when a file exceeds the cloud provider's limits.
346. **P1** 🧪 Safe mode: if opening a notebook crashed last time, it reopens without low-latency ink, thumbnails and companion notes, and says so.
347. **P1** 🧪 Storage full: edits stay in the journal, a clear warning appears and saving retries by itself.
348. **P3** Readable change summaries for Obsidian Git users: what changed in a notebook in each commit (pages, strokes, assets).

### Writing and pen
349. **P2** Pressure lock: while the pen button is held, the width stays constant (even lines).
350. **P2** Pen width relative to zoom (option): the same width on screen at any zoom.
351. **P2** Stroke taper settings: tapering at the start and end of a stroke.
352. **P2** Write big, store small: write margin notes at a comfortable size and they are shrunk into place.
353. **P2** Automatic line break: when writing reaches the right margin, the view jumps to the start of the next line.
354. **P3** Right-to-left writing: automatic next page, word detection and the space tool also work for Arabic and Hebrew.
355. **P2** Stylus profiles: S Pen, USI and other pens recognised automatically, with settings that suit them.
356. **P2** Quick date and time stamp at the pen position.

### Objects and selection
357. **P2** Layer order: bring to front, send to back.
358. **P2** Opacity slider for ink, highlighter and images.
359. **P2** Lasso selection across page boundaries.
360. **P3** Code text box: monospace with syntax colours.
361. **P2** Find and replace in the text boxes of a notebook.
362. **P2** Cross-device clipboard: copy on the tablet, paste on the phone, through the vault.

### Navigation and view
363. **P2** Tabs of open notebooks, with a swipe from one to the next.
364. **P1** 🧪 Quick switcher for pages across all notebooks.
365. **P1** 🧪 Recently edited pages across all notebooks.
366. **P1** 🧪 Go to page by typing its number.
367. **P2** Night mode: dark page display without changing the stored ink colours.
368. **P3** Projector and high-contrast mode.
369. **P3** One-hand mode on phones.
370. **P2** Adjustable toolbar size and large icons.
371. ~~**P3** Samsung DeX layout for mouse and keyboard.~~ — dropped (user decision, 2026-10-29)
372. **P2** Page turner: volume keys, a Bluetooth clicker or a keyboard turn pages and undo.
373. ~~**P3** Phone as a remote page navigator for the tablet.~~ — dropped (user decision, 2026-10-29)
374. **P1** Do not disturb while writing: no notices or pop-ups while the pen is on the screen.
375. **P2** Workspace presets, e.g. "lecture" (slides, notebook, outline) with one command.

### PDF
376. **P2** View-only crop of a PDF's white margins, for small screens.
377. **P3** Reflowed reading mode for a PDF's text on phones.

### Pages and notebooks
378. **P1** Operations on several selected pages: move, change paper, export or delete them together.
379. **P2** Page information: dates, devices, stroke count, size.
380. **P2** 🧪 Heavy page warning, with an offer to split the page.

### Export and Obsidian
381. **P2** Export choices: ink only, background only, or both.
382. **P2** Export a notebook as Markdown with page images, for people without Obsidian.
383. **P3** Obsidian Publish support: pages published as images.
384. **P2** Notebook commands in the Obsidian mobile toolbar.
385. **P2** Bookmark a notebook page in Obsidian's Bookmarks pane.

### Performance
386. **P3** Optional WebGL renderer for very large pages.
387. **P2** 🧪 Level of detail: simplified strokes when zoomed out, for smoother scrolling.

### Extensions of earlier items
388. **P1** Stable page links (extends O4): links based on the page id, so they still work after pages are reordered (today `#p3` points at a position).
389. **P2** Automatic page in the middle of a notebook too (extends #95): filling a page offers to insert one right after it.
390. **P1** 🧪 Integrity check with checksums (extends #27): finds silent corruption caused by sync and offers to restore an earlier version.
391. **P2** Stroke timestamps linked to the lecture video (extends #231): tapping ink jumps the video to the minute it was written.

### Study and exam update (to be designed later)

Exam and review features will ship as one coherent update, designed later together: #24 (flashcards from the lasso), #89 (scheduled review), #116 (exam review plan), #117 (review coverage map), #133 (course dashboard). Not planned for now.

### Sync with Google Drive or OneDrive (decision 2026-10-29)

The vault will be synchronised through Google Drive or OneDrive (for example with a folder-sync app on Android or a sync plugin), not Obsidian Sync. Consequences for the design:
- Notebooks and assets are plain files, so any folder-sync tool works; nothing depends on Obsidian Sync.
- Conflicts are handled generically: when a notebook changes on disk while it is open, the other version is kept as a `conflict` backup before anything is overwritten (already implemented). Sync tools that create "conflicted copy" files leave them in the folder; the library should show them clearly (future item, to be planned with the companion-note work).
- Large PDFs live in `_assets` once (content hash), which keeps uploads small.

## File format transition (applies to M4 and to every milestone before it)

M4 may move notebooks from `.notebook` to Markdown (option B, `.md` with the data in a block) or add a companion `.md` (option C), so that links, backlinks, search and the graph work natively (see architecture.md §1 and §5). Until that decision is taken, all code must keep the move cheap:

- One format layer decides what a notebook file is and how it is read and written (`isNotebookFile`, `readNotebookText`, `writeNotebookText` in `src/storage/format.ts`). Library, index, links, embeds, version history, scanner and import never test the extension themselves.
- Assets, links, bookmarks and the library index reference notebooks by vault path and document id, never by extension-dependent names; a rename keeps working.
- The document JSON (format version, migrations) is independent of the container, so the same data can live in a `.notebook` file or inside a Markdown block.
- When the switch happens it ships as a format container change with a one-click migration command, a backup of every converted file, and support for reading both containers for at least one release.
