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
| Lasso selection: move, resize, rotate | 🧪 basic | one page per selection; uniform resize with a single handle; delete; no copy/paste |
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

### M3b — Objects (v0.4.0) — ⏳

Shapes (lines, arrows, circles, rectangles) · text boxes · images · ruler.

### M3c — Library, PDF and canvas (v0.5.0) — ⏳

Library with folders, covers, tags, metadata, favourites and bookmarks · PDF import with annotation (Obsidian's `loadPdfJs()` first) · infinite canvas and custom page sizes · custom templates.

## M4 — Obsidian integration — ⏳

Links to notebooks and to a specific page · backlinks, search and graph (need a Markdown representation: see the format notes in [architecture.md](architecture.md) §5) · Markdown representation of the notebook (title, tags, links, OCR text).

## M5 — AI and academic features — ⏳ (only after M1–M3 are stable)

Swappable providers, local first, cloud only as explicit opt-in · handwriting OCR, formulas → LaTeX · summaries, quizzes, flashcards, contextual chat, semantic search · audio recording synced with strokes · NotebookLM integration in layers (export package everywhere, optional Drive folder, optional experimental desktop-only direct send).

## M6 — Premium UX (cross-cutting) — ⏳

Floating customizable toolbar, fullscreen, UI that hides while writing, quick colour/width picker, portrait/landscape, dark mode, accessibility, light animations that do not affect latency.

## M7 — Additional features (backlog, planned 2026-10-29)

Beyond the original spec. Priority: **P1** next, **P2** very useful, **P3** nice to have. Status: ⏳ for all.

### Writing and tools
1. **P1** Favourite pens: 4–6 saved presets (tool + colour + width), one tap to switch.
2. **P1** Configurable S Pen side button: hold for eraser, lasso or last tool.
3. **P1** Multi-finger gestures: two-finger tap = undo, three-finger tap = redo (configurable).
4. **P1** Scribble to erase: scratching over strokes deletes them.
5. **P1** Restyle selection: change colour and width of lasso-selected strokes.
6. **P1** Copy, paste and duplicate selections across pages and notebooks.
7. **P2** Free colour picker with recent colours and an eyedropper.
8. **P2** Pressure curve calibration per device, with a test area.
9. **P2** Tilt-aware pencil (tiltX/tiltY widen and lighten the stroke).
10. **P2** Study tape: opaque strips that hide parts of a page and reveal on tap.
11. **P2** Zoom window for writing small on a large page.
12. **P3** Laser pointer (fading temporary ink) for presentations.
13. **P3** Protractor and compass alongside the ruler.

### Organisation and navigation
14. **P1** Two scroll modes: continuous vertical (current) or one page at a time with horizontal swipe.
15. **P1** Notebook outline: titled bookmarks shown as a table of contents.
16. **P1** Global search in the library: titles, tags, text boxes (OCR later).
17. **P2** Links on the page: a region or element opens another page, notebook, Obsidian note or URL.
18. **P2** Back/forward history of visited pages.
19. **P2** Notebook templates: create a notebook from a saved notebook (planner, lab book).
20. **P2** Sticky notes: movable coloured notes on the page.
21. **P3** Paper colours (cream, dark, chalkboard) with ink adapted for contrast.

### Obsidian integration
22. **P1** Embed a page in a Markdown note: a `notebook` code block renders a page preview.
23. **P2** Optional always-updated PDF copy next to each notebook (sharing, NotebookLM).
24. ~~**P2** Flashcards from the lasso: question and answer regions become a Markdown flashcard compatible with spaced-repetition plugins.~~ — moved to the "Study and exam update" (to be designed later, user decision 2026-10-29)

### Data and reliability
25. **P1** Version history: automatic snapshots (e.g. daily per notebook) with restore.
26. **P1** Page trash: deleted pages stay recoverable after the session ends.
27. **P2** Library check: find unreadable notebooks and orphaned assets, free space.
28. **P3** Password-protected notebooks: local encryption with Web Crypto, no cloud.

### Capture and sharing
29. **P1** Scan into the notebook: the camera scan goes straight into the notebook as a page whose background is the cropped, perspective-corrected and enhanced photo (like a PDF page), so you write on it, reorder it in the navigator and export it like any other page. A multi-sheet session adds consecutive pages after the current one; alternatively a scan can be placed as an image on the current page. Enhancement filters: original, document (high-contrast black and white), whiteboard.
30. **P2** Quick share of a page as PNG or PDF through the Android share sheet.

## M8 — More features (backlog, planned 2026-10-29)

Continues the M7 numbering. Priority **P1** next, **P2** very useful, **P3** nice to have. Status: ⏳ for all.

### Reliability and performance
31. **P1** Instant save journal: each stroke is appended within milliseconds to a small journal next to the notebook and merged on the regular save, so even the last stroke survives Android killing the app.
32. ~~**P1** Diagnostic report: one command writes versions, device, settings and performance figures to a file for bug reports.~~ — dropped (user decision, 2026-10-29)
33. ~~**P2** Battery saver mode: fewer redraws, no predicted points, lighter thumbnails.~~ — dropped (user decision, 2026-10-29)
34. **P3** Optional compression of very large notebooks (compatible with the planned Markdown container).

### Advanced writing
35. **P1** New pen types: fountain pen (angle-dependent width), brush, marker.
36. **P1** Auto-scroll while writing near the bottom of the screen.
37. **P2** Filled shapes and dashed or dotted lines.
38. **P2** Align and distribute the selection.
39. **P2** Group elements and lock elements (for example a background image that must not move).
40. **P2** Layers: annotations on a layer separate from the PDF, which can be hidden or locked.
41. **P2** Hand-drawn tables: insert a grid of cells and write inside it.
42. **P3** Symbol keyboard (Greek, maths) for text boxes.

### PDF
43. **P1** Highlighter that snaps to the PDF's text lines (pdf.js text content).
44. **P1** Search the PDF text, with hits highlighted on the pages.
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
58. **P1** Direct `obsidian://` links to a page, to open it from other apps, bookmarks or a QR code.
59. **P2** Lasso selection as an image inserted at the cursor of the active Markdown note.
60. ~~**P2** Left-handed mode: toolbar on the other side and palm rejection tuned for left-handed writing.~~ — dropped (user decision, 2026-10-29)

## M9 — More features (backlog, planned 2026-10-29)

Priority **P1** next, **P2** very useful, **P3** nice to have. Status: ⏳ for all.

### Writing and tools
61. ~~**P1** Pen hover preview: with the S Pen near the screen, a circle shows the nib size and colour.~~ — dropped: the S Pen and Android already show the hover pointer (user decision, 2026-10-29)
62. **P1** Adjustable eraser size with a visible eraser circle.
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
73. **P1** More papers: Cornell, music staff, isometric, hexagonal, calligraphy, planner.
74. **P1** Save a page as a template, with a template gallery.
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
85. **P1** Coloured bookmarks with categories ("important", "to review").
86. **P2** Margin comments attached to a region of the page.
87. **P2** Presentation mode: full-screen pages, with the laser pointer (#12).
88. **P3** Study timer (pomodoro) with a session log.
89. ~~**P2** Scheduled review: "review this page in 3 days", with a list of pages due.~~ — moved to the "Study and exam update" (to be designed later, user decision 2026-10-29)
90. **P2** Highlights digest: every highlighted region collected in a summary page.

## M10 — Native Obsidian integration (backlog, planned 2026-10-29)

Goal: notebooks behave like first-class Obsidian content. Several items depend on the container decision ("File format transition" below): O1 is the companion-note option (C) and must be designed together with it.

- **O1 P1** Automatic companion note: every notebook has a `.md` with properties (tags, course, pages, dates) and the text of its text boxes, so search, graph, Dataview and Bases see notebooks.
- **O2 P1** Shared tags: notebook tags are real Obsidian tags, visible in the Tags pane.
- **O3 P2** Native properties: course, teacher, exam date and similar edited from Obsidian's Properties panel.
- **O4 P1** Page links: `[[Physics#p3]]` opens the notebook at that page, with link suggestions while typing.
- **O5 P2** Hover preview: hovering a notebook link shows the page thumbnail (page preview).
- **O6 P1** Native embed syntax: `![[Physics.notebook#p3]]` renders the page in reading view and live preview.
- **O7 P2** Linked mentions: inside the notebook, for each page, the notes that link to it.
- **O8 P1** Links written with the pen: writing `[[` by hand (two bracket strokes) — or circling ink and choosing "Link" — opens the note suggester; the chosen note becomes a link attached to that ink, tapping it opens the note. The ink stays as written. The same works in text boxes with the keyboard.
- **O9 P1** File explorer menu: "New notebook here" on folders, "Annotate in Notebook" on PDFs.
- **O10 P2** From Obsidian's PDF viewer: an "Annotate in Notebook" action.
- **O11 P3** Pages on Canvas: notebook pages as cards on an Obsidian Canvas.
- **O12 P2** Daily notebook: "Today's page" adds a dated page and links it from the daily note.
- **O13 P2** Obsidian templates: template notebooks and embeds in Templates/Templater.
- **O14 P1** Commands and hotkeys for every tool (pen, eraser, lasso…), assignable in Hotkeys.
- **O15 P2** Status bar: "p. 3/12" and save state; tap opens the navigator.
- **O16 P1** Reopen where you left off: workspace/session restore brings back the same page and zoom.
- ~~**O17 P1** Theme integration: colours, accent and dark mode followed everywhere; documented CSS variables for snippets.~~ — dropped (user decision, 2026-10-29)
- ~~**O18 P1** Sync conflicts: when Obsidian Sync creates a conflicted copy, a dialog compares both versions and merges their strokes.~~ — dropped: sync will go through Google Drive or OneDrive, not Obsidian Sync (user decision, 2026-10-29)
- **O19 P2** Obsidian search: text boxes (and OCR later) appear in global search through the companion note.
- **O20 P1** Page into a note: "Copy link to this page" and "Insert this page into the active note" (link or embed).

## M11 — Original and advanced features (backlog, planned 2026-10-29)

Non-trivial features, many of them original to this project. Priority **P1** next, **P2** very useful, **P3** nice to have. Status: ⏳ for all.

### A. Smart writing (geometry, no AI)
91. **P1** Insert or remove space: drag a line and everything below moves down (onto the next page if needed) or back up.
92. **P2** Handwriting reflow: handwritten lines re-wrap to a different width like text, words found from the gaps between strokes.
93. **P2** Align to baseline: crooked handwritten words are moved onto a common baseline.
94. **P2** Ghost guide lines on blank paper: they appear while writing and fade when you stop.
95. **P1** Automatic next page: writing at the bottom of the last page appends a new page (different from infinite pages).
96. **P2** Strike-through as logical deletion: a line over a word marks it as deleted; it stays readable struck through and can be hidden.
97. **P1** Selective eraser: erase only one kind of ink (only highlighter, only one colour) and leave the rest.
98. **P2** Per-page undo: each page has its own history; undo on one page never touches another.
99. **P2** Area highlighter: translucent rectangles, ideal on scanned PDFs.
100. **P1** Invisible ink for self-testing: write answers with a hidden pen and reveal them with "show solutions".
101. **P2** Colours with meaning: define what each colour means (red = definition, blue = example), filter the view by it and generate a digest per colour.
102. **P2** Headings from handwriting size (no OCR): lines written large become outline entries, shown as images of the ink.
103. **P2** Handwritten checklists: a drawn square becomes a tappable checkbox, linked to Obsidian tasks.

### B. PDF and study material
104. **P1** Expandable margins on PDFs: widen a PDF page sideways to annotate without covering the text.
105. **P1** Anchored excerpts: cut a region of a PDF, drop it on another page as an excerpt; tapping the excerpt jumps back to the exact source location.
106. **P1** Synchronised PDF ↔ notes view: the PDF on one side and the linked note pages on the other; turning a PDF page follows on the notes side.
107. **P2** Floating reference window: another page or notebook stays visible while you write.
108. ~~**P3** Read the PDF text aloud with the system's speech synthesis, offline.~~ — dropped (user decision, 2026-10-29)
109. ~~**P3** Reading ruler on PDFs: highlights the line being read (accessibility, dyslexia).~~ — dropped (user decision, 2026-10-29)

### C. Rich native Obsidian elements
110. **P1** Formulas and equations (advanced): an equation element with a live-preview editor and a palette of structures (fractions, matrices, integrals, systems); multi-line equations aligned on "=", optional automatic numbering; size adapts to the handwriting around it so formulas sit naturally next to the notes; configurable style (size, colour, numbering, inline or display); edited in place on the page; can be converted to vector ink to annotate or tweak by hand. Rendered with Obsidian's maths engine. Later, handwriting recognition (M5) fills the same element: write the formula by hand and it is typeset.
111. **P2** Markdown boxes on the page: real Markdown (lists, callouts, links) rendered by Obsidian.
112. **P2** Back of the page: each page can have a Markdown note as its back side; flip the page to type.
113. **P1** Function graphs (advanced), designed as a full element: several functions per graph (cartesian, parametric, polar, implicit, piecewise); parameters with sliders (a, b…) updating curves live; pan and zoom inside the graph; roots, intersections, maxima and minima found numerically and marked; tangents and shaded areas under curves; table of values; configurable axes, grid, labels and units (degrees/radians); ink written on the graph stays attached to the graph's coordinates when the graph is moved or zoomed; expressions parsed by a safe math parser (never eval); exported as vectors.
114. **P1** Paste from the system clipboard: images and text become page elements.

### D. Study and planning
115. **P1** Class timetable: define the weekly timetable; new pages are tagged with the course in progress, and opening the app during a class opens that course's notebook on a new page.
116. ~~**P1** Exam review plan: set an exam date per notebook and its pages are spread over the remaining days for review.~~ — moved to the "Study and exam update" (to be designed later, user decision 2026-10-29)
117. ~~**P2** Review coverage map: thumbnails coloured from "never reviewed" to "reviewed often".~~ — moved to the "Study and exam update" (to be designed later, user decision 2026-10-29)
118. **P2** Planner generator: a planner notebook with dated month, week and day pages linked to each other.
119. **P1** Page tags: tags on single pages, filterable in the navigator and in search.
120. **P2** Smart collections in the library: saved rules (tag + folder + period + favourite).

### E. Versions, review, collaboration
121. **P2** Visual version diff: additions in green, removals in red, between the current version and a snapshot.
122. **P1** Merge conflicted copies created by Google Drive or OneDrive: compare both copies and merge the strokes (by id) without losing anything.
123. **P3** Stroke authors in notebooks shared through a common folder: filter and colour by person or device.
124. **P2** Lock a finished page.
125. **P1** Last position shared across devices: reopen on the phone at the page you were on with the tablet (stored in the notebook, so it travels with the sync).

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
140. **P1** Guided repair of damaged notebooks: recovers valid pages and strokes from an unreadable file into a new notebook, never touching the original.

## M12 — More advanced features (backlog, planned 2026-10-29)

Priority **P1** next, **P2** very useful, **P3** nice to have. Status: ⏳ for all.

### A. Ink and geometry
141. **P2** Touch-up brush: push or pull an existing stroke to fix its shape without rewriting it.
142. **P1** Personal stamps: drawings, symbols and signatures you reuse, saved in a palette and dragged onto pages.
143. **P2** Subject symbol kits with snapping: rings and bonds for chemistry, components for circuits, vectors for physics.
144. **P2** Parametric 3D solids (cube, cylinder, cone, prism) with editable dimensions and perspective.
145. **P2** Automatic geometric constraints while drawing shapes: snap to parallels, perpendiculars, tangents and midpoints of existing shapes.
146. **P3** Symmetric drawing: mirror or radial axis.
147. **P2** Computable table: typed cells with spreadsheet-like formulas (sums, averages, percentages).
148. **P2** Timeline element: dated events with automatic spacing.
149. **P1** Ink attached to objects: ink written over an image, table, graph or formula moves and scales with it.
150. **P2** Free page rotation with two fingers, like turning real paper.
151. **P1** Configurable edge rejection zones: a palm resting on the screen edge does nothing.
152. **P1** Radial menu at the pen tip: pressing the S Pen button shows tools in a circle around the nib.

### B. PDF
153. **P2** Fill PDF forms (fields) by hand or keyboard; export them filled.
154. **P2** Reusable signature and date stamp for documents.
155. **P1** Export PDF annotations to a Markdown note: highlights, excerpts and comments, each with a page link.
156. **P2** Import existing annotations from PDFs annotated in other apps, as editable items.
157. **P3** Export ink as native PDF annotations, editable in other PDF readers.
158. **P2** Zotero and literature-note link: from a PDF page to its citation.
159. **P3** Split scanned two-page spreads into two pages.

### C. Library
160. **P1** Library trash with restore.
161. **P2** Board view with statuses (in progress, done, to print).
162. **P2** Calendar view: what you wrote on a given day.
163. **P2** Per-notebook settings: stabilization, palm rejection, default paper, sync.

### D. Sharing and open formats
164. **P2** Interactive HTML export: zoomable vector pages that open anywhere, without Obsidian.
165. **P3** Shared session on the local network: several people writing on the same notebook over Wi-Fi, no cloud.
166. **P3** InkML export (open standard for digital ink).
167. **P2** Documented format with a JSON Schema, so other tools can read notebooks.

### E. Automation
168. **P1** Public API for other plugins (Templater, QuickAdd, Dataview): create notebooks, add pages, insert images, export.
169. **P2** If/then rules (e.g. "notebook in folder Physics → millimetre paper", "on close → update the PDF copy").
170. **P2** Macros: a sequence of commands on one toolbar button.

### F. Images and view
171. **P2** Image editing: crop, rotate, brightness and contrast.
172. **P1** White background made transparent: pasted images and screenshots blend with the paper.
173. **P2** Minimap for infinite pages and high zoom.

### G. More original ideas
174. **P2** Draft and fair copy: write a draft, then the draft dims and you rewrite cleanly on top; the draft can be hidden.
175. **P2** Magnifier lens following the pen, to read small PDF text while writing.
176. **P1** Loose sheet: a quick-notes notebook opened from anywhere in Obsidian; move its content to the right notebook later.
177. **P2** Inbox folder: files shared from other Android apps land there and the plugin offers to put them into a notebook.
178. **P2** Split an infinite page into A4 pages for export and printing.
179. **P2** Two-way page references: if page 3 refers to page 7, page 7 shows "referenced on page 3".
180. **P1** Restore a single page from a previous version, leaving the rest untouched.
181. **P3** Reference sheets per subject (periodic table, formula sheets, constants) kept at hand.
182. **P2** Built-in scientific calculator with unit conversion; the result is inserted on the page.
183. **P3** Gentle snapping of handwriting to the lines while writing on ruled paper.
184. **P2** Paint bucket: fill closed areas with colour (diagrams, maps).
185. **P1** Erase area: draw an outline and everything inside disappears, in one gesture.
186. **P2** Copy a page into another notebook, with a link back to the source page.
187. **P2** Back-of-book index: mark terms or regions and an index page with references is generated.
188. **P1** Show/hide all annotations, to reread a clean PDF.
189. **P2** Attachments on the page: Word files, zips and others as icons that open on tap.
190. **P2** Page QR code: scan it with the phone and the page opens on the other device.

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
