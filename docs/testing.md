# Testing

## Feature status

Legend: ✅ yes · ❌ no · — not applicable. The **Verified on hardware** column is filled in **only by the user** after running the protocol below; nothing in it was tested by the developer tooling (no Android hardware available). "Experimental" means the behaviour depends on the device or WebView and needs tuning from real measurements.

| Feature | Implemented | Automated test | Verified on hardware | Experimental | To do |
|---|---|---|---|---|---|
| Figures gallery (roadmap 228, 0.19 gallery): *Figures…* opens a grid of every photo and anchored crop of the section, the notebook or typed pages; kind chips with counts, page badge, tap to go and outline, long press for Copy image, Insert into note, Open original; thumbnails lazy, one at a time, bounded cache; read-only | yes | yes: collection, scopes, counts, cache and queue (`tests/figures.test.ts`); harness `dev/harness/figures-check.ts` | | | not tried on the tablet with a real photo set; clipboard image copy needs `ClipboardItem` (steps 1600-1619) |
| Split an infinite page into sheets (roadmap 178, 0.18 a4split): *Split into sheets* in the PDF and PNG export dialog for infinite pages; paper A4/Letter/A5, orientation, fit width or 100%, margin, overlap, smart cuts between lines, page numbers, skip empty sheets; preview of the cuts | yes | yes: tiling, smart cuts, split PDF structure, byte-identical non-split PDF (`tests/export-tiles.test.ts`); harness `dev/harness/a4split-check.ts` | | | |
| Companion note holds typed text for search (roadmap O19, 0.19 search): setting *Include typed text in search* (under *Companion notes*, off by default) also writes, per page under its `### p. N` heading with a wikilink `[[notebook#pN&id=…&#124;p. N]]`, the text of sticky notes, margin comments and replies, equation sources (inline code) and marker labels (questions, gaps, importance), escaped so nothing becomes a link, tag, comment or maths; at most 4000 characters per page, a cut says so; same debounce, same region markers, no write when unchanged; text boxes, box titles and homework were already written | ✅ | ✅ `tests/companion-search.test.ts` (escaping, equation code, every source, bounds, off = unchanged, wikilink, deterministic output, setting default and lenient reading) | | | OCR text is not included (no OCR yet); not tried in the real Obsidian search or on Android (steps 1520-1539) |
| Magnetic snap and alignment guides (roadmap 71, 0.17 snap): while a selection is moved or scaled it is pulled onto the paper grid (grid, dotted, millimetre every 5 mm, ruled vertically) and onto the edges and centres of the other items, the page centre and edges and the margins; thin coloured guides on the live layer only during the drag; setting *Snap and guides* (off / grid / guides / both) and *Snap strength*; a second finger held (or Alt), or the *Snap* button of the selection bar, lets the drag move freely; rotation is never snapped | ✅ | ✅ `tests/snap.test.ts` (grid per paper, targets, move and scale snapping, guides, modes), `tests/snap-glue.test.ts` (session from a page, dragged matrices, finger/Alt bookkeeping); ✅ harness `doc=snap` (snap on lands on the edge, off, paused, finger held, guides during the drag) at tablet and phone, light and dark | | | not tried with the real S Pen or a held finger on a tablet; the palm-size filter for the held finger is a guess (steps 1120-1139) |
| Saved collections (roadmap 120, 0.17 collections): *Collections* section in the library rail with a live count per collection and a + row; a collection is a name and rules combined with AND: tags (any / all, nested tags match under their parent), a folder with its subfolders, modified or created in the last 7 / 30 days or a date range, favourite (starred or pinned) or not, has a PDF or not; the editor shows how many notebooks match as the rules change; opening one filters the library grid (same filter and search path as the other places, archived notebooks stay out); edit with the rail's pencil or the header's; delete asks first and never touches a notebook; stored in `_meta/collections-<device>.json`, one file per device merged on read (latest change wins per collection, a delete is a tombstone), read leniently with unknown fields kept, never overwritten when unreadable or empty | ✅ | ✅ `tests/collections.test.ts` (every rule, AND, ranges, lenient reading, unknown fields and items kept, merge and tombstones, later time than the merged one, own file never overwritten when unreadable or empty, other devices' bad files skipped, change events); ✅ harness `doc=library` (make through the real dialog, live count, rail count equals cards, header names it, edit, delete with confirmation, no sideways scroll) at tablet and phone, light and dark | | notebook type / template is not a rule (the library index has no such field; adding one means a new index version); a collection whose folder was renamed matches nothing until edited | not tried on the real tablet or with two synced devices (steps 1220-1239) |
| Copy text from the PDF (roadmap 45, 0.16 pdftext): *Select text* mode on PDF pages (contextual bar, sheet, command): a drag with the pen, a finger or the mouse, or a tap on a word, selects the PDF text; nothing is ever drawn in the mode; bubble with *Copy*, *Copy as quote* (PDF name and page, link back to the notebook page) and clear; Ctrl/Cmd+C; a hyphenated word at the end of a line is joined; text read per page on demand and cached, no DOM text layer | ✅ | ✅ `tests/pdf-text-select.test.ts` (page to PDF coordinates with margins, character boundary with real glyph widths, nearest line then run, word, ranges, copied text, boxes, tap, quote); ✅ harness `doc=pdftext` (pen drag, finger drag, multi-line drag, tap, both copy buttons, no ink, leaving the mode, a page without PDF text) at tablet and phone, light and dark | | | not tried with the real S Pen or a finger on a tablet, with a real PDF (columns, rotated text, scans), or with the Android clipboard (steps 970-979) |
| PDF outline and links (roadmap 46, 0.16 pdftext): the PDF's own outline listed in the notebook outline (mixed in, its own section, or off; setting), mapped to notebook pages by source page (a range, reordered pages, a page twice), cached per PDF on this device; a tap on a link of a PDF page goes to the notebook page that shows the target page, a web address asks first, other kinds are refused, a link to a page that is not in the notebook says so; *Follow links in PDF pages* setting | ✅ | ✅ `tests/pdf-outline.test.ts` (outline flattening with names, references and indices, hostile outlines, link boxes with the page transform, smallest link under a point, safe addresses, mapping by source page, builder nesting and keys, cache bounds and lenient reading, one read per PDF, retry after a failure); ✅ harness `doc=pdftext` (outline rows, order, nesting, jump, read once across a reopen, cache entry, section and off modes, finger tap on a link, pen tap stays ink, web link dialog with Cancel and Open, missing page notice, setting off) | | | pdf.js of the real Obsidian (outline of real PDFs, named destinations, link annotations) and the finger tap on the tablet are not tried (steps 980-989) |
| Board view with statuses (roadmap 161, 0.15 views): library view mode with a column per status (To do, In progress, Done, To print; names, colours, order, add / remove in *Settings › Library › Board columns*); move by dragging (mouse, pen, touch long press; phone: drop on a column tab) or ⋯ › Move to…; statuses in `_meta/board-<device>.json`, one file per device, merged by last writer per notebook, unknown fields kept, unreadable file never overwritten | ✅ | ✅ `tests/board-state.test.ts`, `tests/board-logic.test.ts`; ✅ harness `dev/harness/views-check.ts` (columns, ⋯ move, mouse / pen / touch drag with synthetic pointer events, another device's file, columns editor) at tablet, phone and 1448 px, light and dark | | | not tried with the real S Pen, a finger long press, or two devices syncing (steps 900-915) |
| Calendar view (roadmap 162, 0.15 views): month grid (phone: week strip and agenda) of what was written per day, from the library index (created / last changed, all devices) and this device's activity log (pages per day), without opening notebooks; a day lists its notebooks and pages and opens them at that page | ✅ | ✅ `tests/calendar-logic.test.ts` (aggregation, ranges, month and week grids, daylight saving, week start); ✅ harness `views-check.ts` (month grid, week strip, day list, opening a page) | | | per-page times do not exist in the format: page detail only for days this device wrote; page found by reading one notebook when this device has no record (steps 916-922) |
| Storage manager (roadmap 128, 0.15 storage): total and per-notebook size (file, own pictures, share of shared pictures, backups and history, journal) sortable; unused files = the library check's verdict (never a file a notebook, backup, deleted page or notebook, template, stamp, open notebook or journal names); duplicate pictures (same size, then same hash) merged without deleting; heavy pictures downscaled into a new copy with the notebooks repointed in one undo step, the original kept; old backups and identical conflicted copies moved to the trash; async, chunked, cancellable scan | ✅ | ✅ `tests/storage-manager.test.ts`, `tests/storage-scan.test.ts`, `tests/storage-backups.test.ts`; harness `doc=storage` | | | the scan on a big library and the downscale of a real photo on Android are not tried |
| Notebook editing chrome on the design system (0.13 ds-notebook, DESIGN.md): toolbar capsules, glass popovers, sheets with icon squares, contextual bar, dial, tabs, banners, status bar item, page-operations menu; touch targets 44 px (40 px on a 360 px phone and at the compact size); no blur, glow or transition under reduced motion | ✅ | ✅ `tests/ds-notebook.test.ts` (presets, narrow fallback, CSS block scoped, tokens only, balanced, reduced motion, 44 px on touch), `tests/obsidian-input.test.ts`; ✅ harness `doc=chrome` (target sizes, no overflow, no Obsidian button look, glass panels, banner) at 800 / 412 / 360 px, light and dark; screenshots in `dev/harness/dist/shots/design/notebook-*` | | | rendered in headless Chrome only, not on the tablet; tabs and the page-operations menu are not in the harness (steps 520-529) |
| Dialogs, prompts and cards on the design system (wave 0.13, ds-modals, DESIGN.md §4): one shared shell (header with icon square and art band, body, footer with secondary and primary buttons) for every Modal, SuggestModal, floating card and confirmation; behaviour unchanged | ✅ | ✅ `tests/modal-shell.test.ts` (every surface on the shell, tokens, scoping, balanced CSS, strings in both languages); harness screenshots and touch-target checks of every dialog (`dev/harness/modals-check.ts`) | | ✅ | not checked on the tablet or with the pen (steps 540-559) |
| S Pen side button on Android (0.12.4): the button is seen only while the nib touches; **tap with it = radial menu on the lift (no dot), drag with it = eraser for the whole contact from its first sample (no ink, one undo step)**, whatever the form of the signal (bare `contextmenu` up to 500 ms before the pen down, during the contact within 350 ms, up to 400 ms after the pen up; `pointerdown` with `button 2` / `buttons & 2`; `buttons & 2` or the `button 0` move within 350 ms; the `pointercancel` after a `contextmenu`, the contact going on as a new pointer within 250 ms); a press in the middle of a stroke keeps writing ink; no menu during or after a drag; works with *Radial menu on click* too, and for the tools of *Lasso* / *Previous* / *Gestures while held*; *Pen button test* shows the signal and the decision | ✅ | ✅ `tests/side-button-contact.test.ts` (every form x tap / drag / no button / mid-stroke, five settings, cancel, decision logic, `EventLog`), `tests/pen-hover.test.ts`, `tests/pen-button.test.ts`, `tests/side-button.test.ts`, `tests/input-routing.test.ts`; ✅ harness (tap, drag, mid-stroke with real events) | | | which signal this tablet really sends is not known: the *Pen button test* lines *Signal seen* / *Decision* will tell (steps 493-499) |
| Just-in-time hints (roadmap 425, 0.13): seven situations (first notebook, first pen contact, pen hover with the radial menu, first PDF import, first lasso, palm-rejected touch, first Inbox item), shown once, at most one per 4 minutes, never while writing; Tips setting and Show tips again | ✅ | ✅ `tests/hints.test.ts` (registry, rate limit, seen, writing, off, reset, settings); harness `doc=hints` (the bubble, dismiss, turn off, reset); ❌ real S Pen events, the Inbox and PDF triggers | | ✅ | the pen, palm and radial tips come from pointer events, not from the stroke pipeline: palm tip is a touch within the palm window after the pen with finger drawing on (steps 580-589) |
| Rest-based features next to the side button (0.12.5): a contact that waits on a `contextmenu` alone and rests 350 ms is a rest, not a drag with the button, when the long-press gesture or the hold-still radial menu is on; the barrel bit keeps its meaning; Pen button test log with `dDown` / `dUp`, tap / drag summary, decision next to the event, hover-click timer line, settings line | ✅ | ✅ `tests/hold-gesture-regression.test.ts` (rest then sign over every button form, hold radial, gesture while held, cancel and resume), `tests/pen-test-diagnostics.test.ts`; ✅ harness (rest then draw starts a gesture in the real view) | | | the real device sequence that broke gestures is not known; steps 660-665 |
| Procedural subject art and palette (wave 0.12, DESIGN.md §2.3, §2.6): seven line-art families, card art, header bands, covers, empty states, folder icon, LRU image cache, reduced-motion switch; `colorFor` | ✅ | ✅ `tests/generative-art.test.ts` (determinism, seeds, geometry vs colour, density, left side clean, intensity, surfaces, empty states, switch, cache keys and eviction, palette, folder icon); harness gallery screenshots and timing (`HARNESS_DOC=art`) | | ✅ | no surface uses it yet; timing measured only in headless desktop Chrome (steps 425-429) |
| Procedural art 2.0 (wave 0.13): space-colonization family `veins`, OKLCH colour mixing, multi-pass glow, keyword motifs (EN + IT), `growth`, persistent IndexedDB cache, Worker + OffscreenCanvas rendering with main-thread fallback | ✅ | ✅ `tests/art-wave13.test.ts` (OKLCH round-trip and gamut, keyword map, veins determinism and cost, growth, glow passes, recording and replay, worker handler, pipeline with fake worker and store, 0.12.3 guard) and `tests/generative-art.test.ts` (30 ms budget); harness `art.html` (all families, growth, keywords, pipeline) | | ✅ | the library, subject card and creation dialog still call the synchronous functions, so the Worker is not used by the app yet; timing and look only checked in desktop Chrome (steps 560-568) |
| Operations on several selected pages (roadmap 378, wave 0.8): multi-select in the page navigator (select button, long press on touch, Ctrl/Shift+click, range, select all) and move (start, end, position, another notebook), duplicate, bookmark, tag, paper, size, PDF export, delete through the page trash; one undo step each | ✅ | ✅ `tests/page-ops.test.ts` (order planning, ranges, every command as one step with exact undo, never deleting every page); ❌ the panel, the menus, touch long press, the dialogs | | ✅ | long press on touch both starts a selection and arms the old drag-to-reorder: to be checked on the tablet (steps 200-202) |
| Do not disturb while writing (roadmap 374, wave 0.8): the plugin's own notices and non-urgent background work (thumbnails in the page panel and the library, library re-index, version-history snapshots, the timetable offer) wait while a pen is on the screen and for 1.5 s after | ✅ | ✅ `tests/writing-guard.test.ts` (timing, queue order, same-key replacement, lost pen, reset); ❌ real pen events, the notice wrapper in Obsidian | | ✅ | Obsidian's own notices (and other plugins') cannot be held back; `pointerType` `pen` only (a finger or mouse does not count); notices from the toolbar, stamps, selection actions and Zettelkasten are not routed yet (steps 205-206) |
| Stable page links (roadmap 388, wave 0.8): copy/insert link and embed, page suggestions, `obsidian://` links, companion note links, PDF annotation note links and the API write `#p3&id=<page id>`; opening and embeds resolve by id first; API `getPageLink`, `openNotebook(file, pageId)` | ✅ | ✅ `tests/stable-links.test.ts` (subpaths, protocol, ephemeral state, resolve, API page refs), `tests/page-links.test.ts`; ❌ following a link in Obsidian | | | recent pages and the quick switcher (roadmap 364, 365) are not in this branch: they must use `stablePageSubpath` (steps 203-204) |
| Settings tab by task (DESIGN.md §6): eleven sections in a fixed order (*Writing* … *Diagnostics*; empty ones hidden), icon headers, dependent options shown only while their parent is on, feature groups (pen gestures, timetable, Zettelkasten) collapsed while not in use, a collapsed *Advanced* group per section, a search over every setting in English and Italian; one definition list (`view/settings-schema.ts`) drives the Obsidian 1.13+ definitions and the hand-drawn tab; new rows for PDF reading options, night mode and *Style* (`appearanceStyle`) | ✅ | ✅ `tests/settings-schema.test.ts` (every key in exactly one section, control types, string lengths, visibility, search, extension point); ✅ harness (Chromium, hand-drawn path: sections, a dependent option, Advanced, search, Style, 40 px targets, no overflow at 360, 800, 1280 px); ❌ the declarative path in Obsidian 1.13+, Obsidian's own toggles and sliders (steps 407-413) | | | |
| Robustness on the device (0.12.3): detached elements made with the global `createEl` (never on a Document); the art engine and every component drop a decoration that fails (logged once, engine off after three failures); Home, library and creation-dialog parts drawn on their own with an inline error card (message, first stack frame); rail + removed; native settings surfaces; *Diagnostics → Device info* | ✅ | ✅ `tests/compat.test.ts`, `tests/robustness.test.ts`, `tests/settings-tab-members.test.ts`; ✅ harness `doc=empty` (faithful `Document.createEl`, no rail +, + New aligned) and `doc=empty&hostile=1` (newer built-ins removed, art engine and `toDataURL` failing: everything but the art drawn), `doc=settings` (no panel background, Device info) | | | that the Document `createEl` was what failed on the tablet is inferred from the harness, not read from the device (steps 485-492) |
| Start-up and styles guard (0.12.1): every `onload` step guarded (logged, listed, one notice; the others still start), settings tab registered first, settings definitions that never throw (fallback to the hand-drawn tab), unreadable data.json never written over; design-system CSS scoped under `.nb-ui` above Obsidian's button and input rules; missing-stylesheet notice | ✅ | ✅ harness `doc=plugin` (real `onload`, both settings paths, injected failures); ✅ harness library and creation dialog with Obsidian's real button/input rules (computed layout, no default button look); ✅ `tests/styles.test.ts` (scope) | | | the step that failed on the tablet in 0.12.0 is not known (steps 470-477) |
| Tabs of open notebooks (roadmap 363, wave 0.10): optional strip (setting, off by default) listing the notebook leaves with switching; two-finger sideways swipe on the toolbar strip goes to the next / previous notebook; commands *Go to the next / previous open notebook* | ✅ | ✅ `tests/tabs-lines.test.ts` (neighbour tab, labels, swipe recogniser, registry and settings); the strip and the workspace calls are not covered by Node tests (steps 275-277) | | ✅ | Order of tabs is the order Obsidian lists the leaves; a swipe stops at the first / last notebook, the commands wrap; the swipe on a real touch screen is untested |
| Automatic line break (roadmap 353, wave 0.10): on ruled / grid paper, a stroke that ends in the right band of the view scrolls (animated, after a pause, never while a contact is down) so the next line starts under the hand; respects one-page-at-a-time mode; setting, off by default | ✅ | ✅ `tests/tabs-lines.test.ts` (target computation, paper kinds, band, page mode box, bottom band, animation controller) | | ✅ | The pause, band and animation are tuned on paper, not with a pen; feel is untested (steps 278-280) |
| Notebook commands in the Obsidian mobile toolbar (roadmap 384, wave 0.9): every registry command is registered with its action's icon; no toolbar suggestion API exists, so [features.md](features.md) lists the commands to add | ✅ | ✅ `tests/ui-registry.test.ts` (every command id and name); ❌ the icons in Obsidian's mobile toolbar | | | step 249 |
| Bookmark a page in Obsidian's Bookmarks pane (roadmap 385, wave 0.9): file bookmark with `#pN&id=<page id>`, duplicate detection (also in groups), feature detection of the core plugin with a notice; opening it resolves by id | ✅ | ✅ `tests/obsidian-input.test.ts` (bookmark shape, ephemeral subpath to page by id, moved and deleted page, detection that never throws); ❌ the Bookmarks plugin itself, opening a bookmark in Obsidian | | ✅ | uses an internal, unpublished API of the core Bookmarks plugin: it may change between Obsidian versions (steps 250-251) |
| Page turner (roadmap 372, wave 0.9): arrows, PageUp / PageDown, space and Shift+space turn pages when the notebook is active and nothing else wants the key; setting to turn it off | ✅ | ✅ `tests/obsidian-input.test.ts` (key mapping, modifiers, repeat, text fields, focused buttons); harness (`npm run harness:check`: keys reach the page turn, not in a text field, setting off); ❌ a real Bluetooth clicker | | | Android volume keys cannot be used (the system keeps them); clickers that send other keys are not covered (steps 252-253) |
| Adaptive toolbar (roadmap 392, 393, 402, 0.14 toolbar): the kind of page (slide, PDF, image, ruled, grid, plain) marks the invited tools and puts the snapping highlighter, search and margins first on slides; quick slots ranked per notebook (device local storage, bounded) with up to 3 pinned slots that never move (press and hold a quick slot or a row of All actions); the selection bar by content (ink, picture, text, mixed) with its own label and actions; one switch per family and a reset in Settings; new action *Snap highlighter to text lines* | ✅ | ✅ `tests/adapt-toolbar.test.ts` (page kinds, rules per kind, switches off = designed order, pins, per-notebook counts, bounds, reset, strings); harness doc=toolbar and doc=toolbar-pdf: marks, pin and unpin through the menu, ink selection bar, snap control, 40 px targets, no overflow (Chromium, not Android) | | the long press is not tried on a real S Pen or touch screen | steps 680-695 |
| Toolbar size (roadmap 370, wave 0.9): compact / normal / large scale buttons, icons, contextual bar, popovers and the radial dial through CSS variables; layout counts quick slots for the button size; the tools wrap on a narrow phone in large | ✅ | ✅ `tests/obsidian-input.test.ts` (sizes, dial scale, wrapping rule, slot budget); harness: no overflow, every control in the view, button and icon sizes, popover, sheet and contextual bar inside the view at 360-1280 px (Chromium, not Android) | | | on a 360 px phone large uses three rows of the bar (steps 254-256) |
| Operations on several selected pages (roadmap 378, wave 0.8): multi-select in the page navigator (select button, long press on touch, Ctrl/Shift+click, range, select all) and move (start, end, position, another notebook), duplicate, bookmark, tag, paper, size, PDF export, delete through the page trash; one undo step each | ✅ | ✅ `tests/page-ops.test.ts` (order planning, ranges, every command as one step with exact undo, never deleting every page); ❌ the panel, the menus, touch long press, the dialogs | | ✅ | long press on touch both starts a selection and arms the old drag-to-reorder: to be checked on the tablet (steps 200-202) |
| Do not disturb while writing (roadmap 374, wave 0.8): the plugin's own notices and non-urgent background work (thumbnails in the page panel and the library, library re-index, version-history snapshots, the timetable offer) wait while a pen is on the screen and for 1.5 s after | ✅ | ✅ `tests/writing-guard.test.ts` (timing, queue order, same-key replacement, lost pen, reset); ❌ real pen events, the notice wrapper in Obsidian | | ✅ | Obsidian's own notices (and other plugins') cannot be held back; `pointerType` `pen` only (a finger or mouse does not count); notices from the toolbar, stamps, selection actions and Zettelkasten are not routed yet (steps 205-206) |
| Stable page links (roadmap 388, wave 0.8): copy/insert link and embed, page suggestions, `obsidian://` links, companion note links, PDF annotation note links and the API write `#p3&id=<page id>`; opening and embeds resolve by id first; API `getPageLink`, `openNotebook(file, pageId)` | ✅ | ✅ `tests/stable-links.test.ts` (subpaths, protocol, ephemeral state, resolve, API page refs), `tests/page-links.test.ts`; ❌ following a link in Obsidian | | | recent pages and the quick switcher (roadmap 364, 365) are not in this branch: they must use `stablePageSubpath` (steps 203-204) |
| Update links to notebook pages (wave 0.8): finds `#pN` links and id links in the notes, shows every change in a list first (nothing is written), pins old links to the page id, renumbers links whose page moved, follows an id to the one other notebook that has it, and lists what it leaves alone with the reason | ✅ | ✅ `tests/stable-links.test.ts` (scanning with offsets, code skipped, every plan case, applying from the end, stale text left alone); ❌ the command, the list and the writes in Obsidian | | ✅ | an old `#pN` link cannot be known to have been correct: it is tied to the page that has that number now, and the list says so |
| Back/forward history of visited pages (roadmap 18, wave 0.10): jumps (links, page panel, outline, search, markers, Go to page number, the fast scrollbar, opening another notebook, recent pages, the page switcher) are recorded, plain scrolling and page turning are not; Back/Forward in the registry (quick slots, page sheet, All actions, commands) and with the mouse side buttons on desktop; across notebooks; follows renames, skips deleted notebooks and pages; session only, capped at 50 | ✅ | ✅ `tests/nav-history.test.ts` (stack rules, cap, forward discarded, merge, drop, rename, controller with a fake vault, registry placement); harness (`npm run harness:check`: scrollbar drag is one jump, Back and Forward return, page turns record nothing); ❌ links, other notebooks, the mouse buttons, Obsidian's own tab history | | ✅ | the mouse buttons may also trigger Obsidian's own back/forward if it handles them before the plugin; a page that is deleted is skipped without a message (steps 315-320) |
| Fast scrollbar with a page preview (roadmap 50, wave 0.10): a draggable thumb along the right edge in continuous scroll (appears on scroll or when a mouse nears the edge), bubble with page number and thumbnail from the page panel's cache, drawn only when the thumb rests; setting *Fast scrollbar* | ✅ | ✅ `tests/scrollbar.test.ts` (thumb geometry, pointer to scroll position, round trip, page for an offset); harness: appears after a scroll, drag to the last page, no thumbnail drawn per move, preview drawn once when resting, setting hides it (Chromium, not Android) | | ✅ | not shown in one page at a time mode; the thumb is 24 px wide while shown, so pen strokes that start exactly there grab it (steps 321-327) |
| Obsidian status bar item (roadmap O15, wave 0.10): "p. 3/12 · Saved" for the active notebook, saved / saving / unsaved / error, click opens the page panel; desktop only (no item on mobile) | ✅ | ✅ `tests/nav-history.test.ts` (text); harness: text follows the page and save state, click opens the panel; ❌ the status bar of Obsidian itself | | ✅ | Obsidian mobile has no status bar: the toolbar keeps showing the same two facts (steps 328-332) |
| Class timetable (roadmap 115): pure scheduling (current/next class, odd/even weeks, term dates, local time, overlaps), file parse/serialize round trip, target notebook choice | ✅ | ✅ `tests/timetable.test.ts` | | | |
| Automatic lecture mode (roadmap 401, 0.14): off / ask / automatic from the timetable for the notebook that belongs to the class in progress; banner (Start / Not now), chip with End, lecture bar on while it lasts, ends with the class, never starts or ends under the pen, "Not now"/End and the pages added remembered per class and day in the device's local storage (reopening does not ask again or re-add a deleted page), the lecture page is only added by a user action (Start, the command, or in automatic mode the first stroke written; never by the clock, the timer or a resume), manual command | ✅ | ✅ `tests/lecture-mode.test.ts` (rules, class ↔ notebook matching, settings), `tests/lecture-memory.test.ts` (bounded per-day memory, corrupt data); ✅ harness `dev/harness/lecture-check.ts` (real view: ask, Start, Not now, auto, no page from the clock or a resume, page at the first stroke, pen holds it back, end of class, reopening, setting off, manual); ❌ with the real timetable service and clock in Obsidian | | | |
| Lecture page prefilled from context (roadmap 438 and 210, 0.14): time slot, room, lecturer and the slide/PDF reference as a second text box under the header; timetable *Lecturer* field | ✅ | ✅ `tests/lecture-mode.test.ts` (page build, details text, slide link, round trip through the file, lecturer in the timetable file); ✅ harness (the page made by lecture mode); ❌ the New lecture dialog preview and the slide link in Obsidian | | | |
| Course page tag: a lecture page made with a course from the timetable (New lecture prefill, *Open the current class*) gets the course as a v7 page tag, in the same undo step | ✅ | ✅ `applyCourseTag` (normalisation, no duplicate, undo with `AddPage`); ❌ the two flows in Obsidian | | | |
| Layout by orientation and size (roadmap 430): `classifyViewport` (phone / tablet / desktop × portrait / landscape × short, hysteresis), `nb-vp-*` classes on the notebook view and Home / library, landscape CSS for the toolbar, Home grid and dialogs, sticky PDF split | ✅ | ✅ `tests/viewport-class.test.ts`; ✅ harness `layout-check.ts` (phone / tablet, portrait / landscape, dark / light) | | | not measured on Android |
| Level of detail (roadmap 387): zoom → level (`lodLevel`, tolerance within 0.5 device px at any scale and pixel ratio), Douglas–Peucker on outlines (render 1) and on ink nodes with their radius (render 2), simplified paths kept per stroke and level, thumbnails | ✅ | ✅ `tests/lod.test.ts` (worst outline difference 0.44 device px over handwriting, stress strokes, pen/highlighter/shape); ✅ `npm run bench:lod` (PC pixel comparison and frame times) | | | not measured on Android |
| Heavy page warning (roadmap 380): thresholds (strokes, points, image bytes), split plan (cut at the widest gap near half the load, text boxes and images, one undo step, nothing lost or duplicated), banner with Split page / Dismiss | ✅ | ✅ `tests/heavy-page.test.ts`; ✅ harness check (`npm run bench:lod -- --check-heavy`: banner, split, undo, dismiss) | | | the banner's look on a phone |
| Class timetable editor (settings, command), `_timetable.json` read/write through the Vault API, unreadable file never overwritten | ✅ | ❌ (needs Obsidian) | | | |
| Offer / auto-open the current class at a new lecture page; "New lecture" course prefill; library "Now: <course>" shortcut | ✅ | ❌ (needs Obsidian; the choices behind it are tested) | | | |
| Ribbon icon + "New notebook" / "Open notebooks" commands | ✅ | ❌ (needs Obsidian) | | | |
| Notebook file created in the configured folder (default `Notebooks/`) | ✅ | ❌ (needs Obsidian) | | | |
| A4 grid page, fitted to width, refit on resize/rotation | ✅ | ✅ fit-width, transforms | | | |
| Pen input via Pointer Events (pen/touch/mouse) | ✅ | ✅ routing logic only | | | |
| Coalesced events | ✅ | ❌ (browser API) | | | |
| `pointerrawupdate` for the drawing pointer (fallback `pointermove`), each sample once | ✅ | ✅ dedup rule; harness (Chromium) | | ✅ | only with *Low-latency ink* (off by default); depends on the WebView exposing it (the overlay shows "raw") |
| Low-latency (`desynchronized`) wet canvas, setting *Low-latency ink*, **default off** | ✅ | ✅ context fallback; harness (desktop Chromium only) | | ✅ | may be composited as an opaque layer on some Android GPUs |
| Render and input guards: a failing stroke, element, background or wet-ink paint is skipped and logged once; the pen falls back to the live layer | ✅ | ✅ unit + harness fault injection | | | |
| Wet ink: new ink painted per input event, dirty rectangles, no per-frame redraw | ✅ | ✅ geometry, dirty rects, constant work per sample (canvas stand-in) | ✅ user report, 2026-10-29: Samsung tablet, S Pen, 0.4.1, low-latency off | | |
| No change at pen-up (same geometry while writing and after commit) | ✅ | ✅ causal geometry, committed path vs painted union | ✅ user report, 2026-10-29: Samsung tablet, S Pen, 0.4.1, low-latency off | | |
| Predicted ink (tip only, never saved; **default off**) | ✅ | ❌ | | ✅ | |
| Real pen pressure, decided at stroke start, simulated fallback for constant pressure | ✅ | ✅ | | | |
| Basic palm rejection (pen seen in the last N ms) | ✅ | ✅ | | | |
| "Draw with finger" setting | ✅ | ✅ | | | |
| Palm rejection by contact size (setting, off by default) | ✅ | ✅ routing logic only | | ✅ | depends on what the device reports for touch size |
| Pen: 9 colours, 5 widths | ✅ | ❌ | | | |
| Free colour picker (roadmap 7, wave 0.10): hue / saturation-value area, hue bar, hex field (3 or 6 digits), recent custom colours (last 12, plugin setting `recentColours`, not in the notebook file), reached from the colour row of the tool options, the radial colour ring and the command; edits the colour of the tool in use (pen, shape and text: pen; highlighter: its own; eraser filtering by colour: the filter colour; any other tool switches to the pen) | ✅ | ✅ `tests/colour.test.ts`: hex parsing, hex / rgb / hsv conversions (round trip), recent list (order, duplicates, limit, invalid input, settings read), which colour a tool edits; ✅ harness (Chromium): opens, hex, invalid hex, area drag, recent, follows the toolbar, close, from the options and the dial; ❌ on a device (steps 365-370, 377-378) | | ✅ | |
| Page eyedropper (roadmap 7, wave 0.10): the next contact on the page picks the colour under it, read from the rendered canvases composited over white at the canvas pixel (device pixels, so the device pixel ratio and zoom are taken into account), with a swatch above the contact while it is down; Escape, another tool or a contact on the toolbar ends it; nothing is drawn | ✅ | ✅ `canvasPixelAt` (dpr 1, 2, 2.625, CSS-scaled canvas, edges, empty box); ✅ harness: picks the colour of a red stroke, loupe, remembered, Escape, toolbar tap, draws nothing; ❌ on a device (steps 371-372) | | ✅ | picks what is drawn: a highlighter shows blended with the paper and night mode shows its dark rendering |
| Style eyedropper (roadmap 68, wave 0.10): a tap on a stroke makes its tool (pen or highlighter; a shape stroke gives the pen), colour and width the current pen; hit test on the vector points in page coordinates with a 10 px tolerance, topmost stroke under the tap first, then the closest; hidden ink only while shown | ✅ | ✅ `pickStrokeAt` (under / near / topmost / closest / dot / empty), `styleOfStroke`; ✅ harness: miss keeps waiting, highlighter and pen stroke taken, draws nothing; ❌ on a device (steps 373-376) | | ✅ | |
| Highlighter: 5 colours, 3 widths, constant width | ✅ | ✅ format round-trip | | | |
| Highlighter translucent with `multiply` blending, also while writing (CSS on the wet canvas) | ✅ | ❌ (canvas) | | ✅ | |
| Stabilization (0–10, default 2): adaptive 1€ filter | ✅ | ✅ jitter and lag vs the old stabilizer | | | tune levels on the device |
| Saves, journal and thumbnails wait while writing (and 350 ms after) | ✅ | ✅ session | | | |
| Format v5: per-stroke render version; old strokes unchanged | ✅ | ✅ migration, round-trip | | | |
| Whole-stroke eraser (toolbar) | ✅ | ✅ hit test | | | |
| Favourite pens: 6 slots (tool, colour, width) in the plugin settings, one tap to select, long press or menu to save the current pen | ✅ | ✅ slot logic, settings read; ❌ UI | | | |
| Eraser size (5 presets in the toolbar, persisted) for both eraser modes, and an eraser circle that follows the pen/mouse | ✅ | ✅ radius and presets; ❌ circle (harness only) | | ✅ | circle position under a real S Pen hover untested |
| "Pen only" toggle in the toolbar (the inverse of *Draw with finger*; fingers still pan and zoom) | ✅ | ✅ routing (existing); ❌ toggle | | | |
| Toolbar (ui redesign): row 1 pages panel + seven tools; row 2 undo/redo, current pen (opens the tool options), favourite pens, ranked quick slots, page indicator (opens the page sheet), save state, *All actions*; one row on a wide view, two otherwise; touch targets ≥ 40 px; a tap outside the options popover closes it without drawing, Escape closes it | ✅ | ✅ `tests/ui-layout.test.ts` (row plan and quick slots per width); ✅ harness at 360×740, 412×915, 740×360, 800×1280, 1280×800 (tablet landscape and desktop): no sideways overflow, 40 px targets, options popover, quick slots follow the width | | ✅ | the harness draws stand-in icons and uses synthetic events: real S Pen, finger and WebView layout untested |
| Commands for every tool and action, generated from the action registry with the ids of 0.5 (hotkeys keep working), `checkCallback`, no default hotkeys; side-by-side commands only while they apply | ✅ | ✅ `tests/tool-commands.test.ts`, `tests/ui-registry.test.ts` (every command registered in `src/` is in the registry; every view action has a runner, every global one a handler) | | | |
| Action registry (ui redesign, `src/ui/actions.ts`): every action with label, icon, group, surfaces, contexts, priority and command; every action reachable on a touch surface or the palette | ✅ | ✅ `tests/ui-registry.test.ts` | | | |
| Contextual bar (ui redesign): selection (copy, cut, duplicate, paste, white → transparent, save as stamp, delete, restyle rows), lasso (paste), PDF side pane open, class now, PDF page (search, hide annotations, dim, margins, open side by side), image page; collapsible per context (remembered on the device) | ✅ | ✅ `tests/ui-layout.test.ts` (context choice and ranking); ✅ harness: none with the pen → lasso → selection, duplicate works, collapse and expand; ✅ harness `pdf`: PDF bar | | ✅ | finger and S Pen taps on the floating bar over the page untested on a device |
| *All actions* sheet and page sheet (ui redesign): grouped sections (Recent, Insert, Page, PDF & reading, Side by side, Lecture, View & input, Export & share), search (accents ignored), paper and size chips, toggles with switches; popover on a tablet or desktop, bottom sheet on a phone; replaces the "more" menu and the page menu | ✅ | ✅ `tests/ui-layout.test.ts` (sections, Recent, search, page sheet); ✅ harness: opens inside the view, rows ≥ 40 px, toggle keeps it open, search, action closes it, paper chip + undo, Escape | | | |
| Ranking by use (ui redesign): use counts per device in Obsidian's local storage (half-life 14 days, at most +30 priority), quick slots and *Recent* follow them | ✅ | ✅ `tests/ui-layout.test.ts` (counts, decay, normalising stored data) | | | |
| Segment eraser (cuts strokes; works across pages in one gesture) | ✅ | ✅ cutting logic; ❌ across pages (view) | | | |
| Pen eraser button (`buttons & 32`) | ✅ | ✅ routing, kept unchanged by the new side-button action | | ✅ | S Pen button mapping unknown |
| Edge rejection zones (setting, **off by default**): touches that start within N px of the chosen edges are ignored; pen, mouse and touches that started inside are not | ✅ | ✅ zone maths, policy routing, controller with a fake element | | ✅ | depends on the device reporting touches near the bezel; tune the width on the tablet |
| Pen side button → radial dial at the nib (ui redesign): undo/redo, width bubble, colour bubble, the tool drawn as a pen; favourites · pen case · shapes; colour ring (12 swatches, custom colour, eyedropper), width arc slider, pen case with stroke previews and "+" (save a favourite), favourites ring, shapes and ruler; flick (release the button over an action) or tap; Escape or a tap outside closes; nothing is drawn | ✅ | ✅ `tests/ui-layout.test.ts` (palettes, width scales, arc geometry); ✅ input routing (unchanged); ✅ harness: opens, lifting keeps it open, colour ring sets the colour, slider drag sets the width, pen case chooses a tool, + opens save mode, shapes, tap outside closes, draws nothing | | ✅ | 0.5.1: how the S Pen button reaches the page is still unknown, see the step *Pen button test*; the eyedropper and the native colour picker are untested on Android |
| Setting *Pen side button* (0.5.2, extended in 0.6.0): radial menu on click + erase while held (default) / radial menu only / erase while held / lasso while held / previous tool while held / nothing; key `penSideButton` | ✅ | ✅ routing for each value, settings parsing and migration of the 0.5.x and wave-0.6 keys, held tool passed to the stroke start, previous-tool memory; ❌ settings tab, the S Pen's real button reporting | | ✅ | the tool is chosen when the pen touches down; pressing the button after the pen touched down does not switch (same as the eraser option) |
| 0.5.2 Samsung side button = `pointerdown` `button 0`, `buttons 1`, `pressure 0` while the pen hovers (also `buttons` 0→1 in a pen move): click → menu on release; button held then touch → erases (current eraser mode / size / filter), no menu; the pressure-0 phase never draws; only for a pointer seen hovering before; setting to turn it off; press-before-touch limit (pressed after the nib is down it cannot be detected) | ✅ | ✅ synthetic sequences (`tests/side-button.test.ts`): click, move-based press, release by move, contact, lift and re-touch, pointerdown with pressure, repeated clicks, no hover / other pointer id / setting off still draw, contextmenu around the click; ✅ harness: press opens nothing, release opens the menu, press + touch erases and opens no menu | | ✅ | S Pen side button: no event reaches Obsidian (user report, Samsung tablet, 2026-10-30); the same tablet's Chrome shows the pen-hover button press as `button 0`, `buttons 1`, `pressure 0` (user report, pen-tracker page). The plugin's handling of it is not verified on hardware |
| 0.5.2 side button pressed while the nib touches (chord): a dispatched pen move with `button 0` during contact finishes the stroke (kept) and the contact then acts as the button's tool until the next such event or the lift | ✅ | ✅ synthetic sequences incl. ordinary writing with button 0 in coalesced events, an all-button-0 device, rawupdate + move pair, early/first events, setting off (`tests/side-button.test.ts`) | | ✅ | **Hypothesis** from one observation (pressure 0.92, `button 0`, `buttons 1` after pressing during contact); unconfirmed on a device, may fire at other moments |
| 0.5.1 detection of the side button from every signal: pen `pointerdown` / `pointermove` / `pointerrawupdate` with `button 2` / `buttons & 2`, pen `contextmenu`, pen `auxclick`, mouse right button right after pen activity; one menu per press; never from touch or a bare pen long-press; eraser bits stay the eraser; a press just after the nib discards that stroke (no dot); a button brushed during writing is ignored | ✅ | ✅ synthetic event sequences for each signal shape (`tests/pen-button.test.ts`) | | ✅ | what the S Pen really sends |
| *Pen button test* (settings button and command): live log of the last 30 events on a test area (80 events, window level, since 0.11.1), with whether each counts as the side button; *Copy log* | ✅ | ✅ log formatting, folding, side-button verdict; ❌ modal (needs Obsidian) | | ✅ | |
| Setting *Open the radial menu by holding the pen still* (0.5.2): 0.7 s within 6 px of the first contact, discards the stroke (no dot, not in undo), opens the menu; automatic default = on until a side-button signal was ever seen (`penButtonSeen`), then off; an explicit choice wins | ✅ | ✅ timing, writing a dot, slow strokes, a pause after moving, going out and back, coalesced moves, hover, eraser end, setting turned off in between, default resolution, seen flag; ✅ harness: hold opens the menu with no stroke and nothing to undo, a pause after moving does not | | ✅ | |
| Setting *Open the radial menu with a finger long-press* (0.5.2, on by default): 0.5 s within 10 px, one finger, finger drawing off, no pen near; the ring opens beside the finger | ✅ | ✅ timing, drift, pan before the time, tap, second finger, pen near before/after, finger drawing on, setting off, palm and edge touches, controller bookkeeping afterwards, placement of the ring (`fingerMenuCenter`); ✅ harness: opens beside the finger and draws nothing | | ✅ | |
| *Pen button test* 0.5.2: event type and pointer id on every line; the pressure-0 press, the touch while held, the lift and the release labelled; `pointermove` with `button 0` during contact labelled *possible side button*; line *No side-button signal received yet on this device* | ✅ | ✅ log labels and folding (`tests/side-button.test.ts`), text decision; ❌ modal (needs Obsidian) | | ✅ | |
| *Pen button test* and side button at window level (0.11.1): the test logs every pointer, mouse, touch, contextmenu, auxclick, click, capture, selection and key event at window level in the capture phase, with target, timestamps, the last event's values (pen-tracker style) and counts per type; the notebook's side-button detector also listens at window level over the view (toolbar, bars, events stopped above the page), plus a mousedown with no pointer event while the pen hovers | ✅ | ✅ `tests/pen-button-window.test.ts` (the user's three pen-tracker readings as recorded sequences, mouse-only press and its compat / finger exclusions, window watch: handled once, stopped events, other parts of the view, outside the view, outside the page area, destroy; log types, target, folding, counts); ❌ modal (needs Obsidian) | | ✅ | whether the S Pen button reaches Obsidian's WebView at all is unknown (user report: the 0.10.1 test showed nothing); steps 404-406 |
| S Pen in Obsidian for Android (0.11.2): the side button clicked while the pen hovers arrives only as a bare `contextmenu` (Obsidian's container drops stylus hover): with no pointer down on the view and no text field focused it opens the radial menu (at the event's position, else the last pen position, else the centre of the page area); a finger long-press (contextmenu while a finger is down, or within 600 ms of a long contact) and a mouse right click keep their behaviour | ✅ | ✅ `tests/pen-hover.test.ts` (recorded sequences: the device's hover click, finger long-press while down / on lift, short tap, pen stroke then click, swallowed up, mouse right click, text focus, events fed twice; controller: position, long-press untouched, focused text field, no double menu, *Nothing*) | | | steps 420-421 |
| Button held with the nib touching (0.11.2): `buttons & 2` / `button` 2 with pressure above 0 on the landing, and `buttons & 2` / `button` 2, `buttons & 32` / `button` 5 appearing on a move of a written stroke, make that stroke (or the rest of it, the ink so far kept) the eraser or the button's tool; with pressure 0 the landing still opens the menu | ✅ | ✅ `tests/pen-hover.test.ts`, `tests/side-button.test.ts` | | | step 422 |
| Side button seen only as a bare `contextmenu` at or during a pen contact (0.11.2, device finding: the pen's pointer events keep `buttons` 1): one within 150 ms before or 350 ms after the pen's pointerdown (settings *Button before / after contact*) makes the whole contact the eraser (after the landing: the live ink is dropped, never committed, and the samples so far are replayed as the eraser; after a short flick whose `contextmenu` comes after the pen up: the committed stroke is undone, one step, and replayed as the eraser); later, the ink so far is committed and stays (the eraser that continues the contact never touches it, also for `buttons & 2` and the chord event) and the rest erases; the pen up ends it; a nib resting still (12 CSS px) for 350 ms is a long-press, not the button, even inside the window; the after-window is at most 400 ms (larger saved values read as 400); with a finger or palm on the page, or lifted less than 600 ms before, a `contextmenu` during a pen stroke changes nothing; a hover click waits for the before-window; always `preventDefault` | ✅ | ✅ `tests/pen-hover.test.ts` (recorded sequences: both orders of case 1, case 2, late contextmenu after the pen up, hover click, finger long-press, palm while writing, plain stroke, resting nib, *Nothing*, windows and their cap; the `continued` flag of every mid-stroke switch; Pen button test timing notes and verdict); ❌ the view's eraser sparing the kept ink and the one-step undo of a retracted stroke (no view-level test) | | | steps 428-430; tune the windows from the logged Δ |
| Setting *Button click: next stroke erases* (0.11.2, off by default): a hover click arms the eraser for the next pen stroke only (a small ring on the current-pen indicator); a second click, a tool change or Escape disarms it | ✅ | ✅ arm / consume / disarm, controller sequences; ❌ toolbar indicator and Escape (need Obsidian) | | | step 423 |
| Settings *Pen key* and *Pen key action* (0.11.2): F9 to F12 or a captured key acts as the button (radial menu or next stroke erases) in the active notebook view; repeats, text fields, modals and Ctrl / Alt / Meta are ignored; only that key is cancelled; a warning when an Obsidian hotkey uses the key (`app.hotkeyManager`, read defensively). For Key Mapper + Shizuku. Shown in the *Pen button test* until the settings tab has its *Pen & input* section | ✅ | ✅ key matching, capture, scene, hotkey conflicts, settings parsing; ❌ settings UI and capture (need Obsidian) | | | steps 424-426 |
| *Pen button test* 0.11.2: read-only Capacitor inventory line (platform, plugin headers and keys, bridge-like globals; nothing is called); key lines with `key` and `code` | ✅ | ✅ inventory with a fake bridge (no call), errors; ❌ modal | | | step 427 |
| Instant start: current page saved in the workspace layout and restored; command *Continue last notebook* | ✅ | ✅ location debounce, settings parsing, page parsing; ❌ Obsidian layout restore | | | how Obsidian mobile restores the layout after the app was killed is untested |
| Instant start: history snapshot parses after the first paint; stroke-line warm-up starts 400 ms after the load | ✅ | ✅ warm-up delay, save before warm-up; ✅ `npm run bench:open` (PC) | | | PC numbers only: 10,000 strokes first paint 414 ms → 233 ms; not measured on Android |
| One page at a time (#14): setting *Scrolling*, toggle in the "…" menu, command; pages side by side, each fitted to the width; finger or wheel swipe drags and turns, snaps with an animation; vertical drag scrolls inside the page; zoomed in, pan inside and push past the edge to turn; the pen never turns the page | ✅ | ✅ layout, fit, clamp, turn decision, direction lock, controller with a fake stage (drag, flick, spring back, ends, pinch, wheel, fling, pen); ✅ harness (synthetic touch and pen events, toolbar item) | | ✅ | thresholds (22 % of the width, 0.45 px/ms), animation feel, a real S Pen and finger on the tablet, and two-finger swipes in *Draw with finger* mode are untested; no on-screen page arrows |
| Reopen where you left off (O16): page, zoom and scroll position in the workspace state and, for *Continue last notebook*, in the plugin settings; nothing in the notebook file | ✅ | ✅ capture and restore maths across view sizes and both scroll modes, parsing of untrusted state and settings, location debounce; ✅ harness (reopen with the state: same page, zoom and position, fitted page stays fitted, a link keeps only the page, another pane size) | | | how Obsidian mobile restores the layout after the app was killed is untested |
| Progressive loading (#329): a notebook over ~2 MB shows the wanted page first (read-only) and reads the other pages in ~10 ms slices; editing and saving only after every page passed full validation; damaged page → unreadable file; journal entry or older format → loaded in full | ✅ | ✅ staged parse equals the full parse, order, budget, damaged / duplicate ids, session events, no save while loading, close mid-load, throwing callbacks, journal; ✅ harness (page shown and painted before the rest, read-only meanwhile, then complete, writing and saving keep every stroke); ✅ `npm run bench:open` (PC) | | ✅ | PC only: 10,000 strokes first paint 207 → 150 ms, 100,000 strokes 1771 → 1019 ms; time to editable about equal; not measured on Android |
| Lasso selection (≥ 50% of points inside) | ✅ | ✅ | | | |
| Words and lines found without OCR (`segmentText`: words, lines, baselines; highlighter/shape/oversized strokes ignored) | ✅ | ✅ synthetic handwriting: letter vs word gaps, slanted lines, mixed sizes, overlapping descenders, columns, order independence | | ✅ | thresholds tuned on synthetic writing only; real handwriting needs checking |
| Lasso: double tap selects the word, triple tap the line (becomes a normal selection) | ✅ | ✅ tap counting (`MultiTap`), word/line lookup; ❌ gesture in the view | | ✅ | timing (400 ms) and distance (30 px) of taps with a finger or S Pen |
| Word/line segmentation speed (`npm run bench`, `tests/words.perf.ts`) | ✅ | ✅ printed figures, loose bound | | | tablet figures unknown |
| Selection: move, resize (bottom-right handle), rotate (handle above), delete | ✅ (basic) | ✅ matrices, stroke transform; ❌ handles and gestures (view) | | | one page per selection |
| Undo/redo (command stack: add, erase, replace, add page, batch) | ✅ | ✅ | | | |
| Multiple pages stacked vertically (24 pt gap), page indicator `n / total` | ✅ | ✅ layout; ❌ rendering | | | |
| Add page (button and command), undoable, inserted after the page in view | ✅ | ✅ command; ❌ view | | | |
| Virtualization: only visible pages and strokes are drawn | ✅ | ✅ visible-page selection; ❌ rendering | | | |
| One-finger pan, two-finger pinch zoom (0.25–8×), wheel/Ctrl+wheel | ✅ | ✅ zoom/pan maths | | | |
| Fling inertia after one-finger pan | ✅ | ❌ | | ✅ | |
| CSS-transform fast path while panning/zooming a slow page (redraw 120 ms after the gesture pauses) | ✅ | ❌ | | ✅ | |
| Performance overlay (frame time, input→frame, redraw time, strokes and pages drawn) | ✅ | ❌ | | ✅ | software measure, not display latency |
| In-app benchmark and stress-test notebook (10,000 strokes / 10 pages) | ✅ | ✅ generator is deterministic and valid; ❌ in-app run | | | |
| `npm run bench` (pure logic) | ✅ | — | — | | |
| Autosave (1.5 s debounce, 10 s max wait) | ✅ | ✅ | | | |
| Flush on view close, file switch, plugin unload, `visibilitychange`, `pagehide` | ✅ | ✅ session logic; ❌ Obsidian events | | | |
| `unsaved` backup if writing keeps failing on close; deleted files never rewritten | ✅ | ✅ | | | |
| Stroke in progress kept when the app goes to background | ✅ | ❌ | | | |
| Re-validation before every write (full under 1 MB, incremental above) | ✅ | ✅ incremental result equals the full parse | | | |
| Unreadable files never overwritten + backup copy | ✅ | ✅ | | | |
| Newer format version opened read-only | ✅ | ✅ | | | |
| External change (Sync): reload, or keep local + back up the other version | ✅ | ✅ | | | |
| Format v2 (adds `highlighter`) + migrations v0→v1, v1→v2 | ✅ | ✅ | | | |
| Paper kinds: blank, ruled, grid, dotted, millimetre (per page) | ✅ | ✅ pattern geometry (`paperPattern`); ❌ canvas drawing | | | minor lines/dots hidden on screen below ~3 CSS px spacing |
| Page sizes A4, A5, Letter + landscape (per page) | ✅ | ✅ command logic; ❌ view | | | no custom sizes yet |
| Changing page size keeps strokes where they are (outside ones clipped, kept in the file) | ✅ | ✅ strokes untouched by `SetPageSize`; ❌ clipping on screen | | | |
| Page menu: duplicate, move up/down, delete, paper, size, orientation (all undoable) | ✅ | ✅ commands and undo/redo; ❌ menu (view) | | | |
| Add page copies size and paper of the page in view | ✅ | ❌ (view) | | | |
| New-notebook dialog with size, orientation and paper; last choice remembered | ✅ | ✅ settings parsing; ❌ dialog | | | |
| Default paper / size / orientation settings | ✅ | ✅ settings parsing; ❌ settings tab | | | |
| Export page / notebook as PDF, page as SVG (written next to the notebook) | ✅ | ✅ generators (structure, offsets, y-flip, highlighter, determinism); ❌ file writing (Obsidian) | | ✅ | PDF and SVG checked with pdf.js and resvg on the PC only; not opened on Android; PDF is uncompressed (large with a lot of ink) |
| Format v3 (paper kinds) + migration v2→v3 (identity) | ✅ | ✅ | | | |
| 0.2.x opens a 0.3 file read-only and keeps a backup | ✅ | ✅ future-version handling (same code path as v2 in 0.1); ❌ with a real 0.2 install | | | |
| Reopen shows identical strokes | ✅ | ✅ round-trip | | | |
| Format v4: notebook `meta`, `assets`, page backgrounds, text and image elements, infinite pages, `shape` tool; migration v3→v4 | ✅ | ✅ round-trip, validation, migration, asset references | | | |
| Files written by 0.4.0 open read-only in 0.3.x and older, with a backup | ✅ | ✅ future-version handling; ❌ with a real 0.3 install | | | |
| Format layer: container independent of the `.notebook` extension (`storage/format.ts`) | ✅ | ✅ | | | prepares the M4 move to Markdown |
| Library view: sidebar (all, favourites, recent, folders, tags), cards, sort, empty states | ✅ | ✅ index, queries, folders, drag target logic; ❌ view | | | |
| Library actions: new notebook / folder, rename, move (menu and drag and drop), duplicate (new document id), delete to trash, favourite, tags, cover colour | ✅ | ✅ host logic and library tests; ❌ Obsidian file operations and drag with touch | | ✅ | drag and drop on Android is untested |
| Covers and thumbnails (also of PDF and image pages), disposable `library-index.json` rebuilt lazily | ✅ | ✅ index staleness, rebuild; ❌ canvas thumbnails | | ✅ | |
| Library search over titles, tags and text-box text, with snippet and page jump | ✅ | ✅ matching, snippets, page numbers; ❌ view | | | no handwriting search (OCR is M5) |
| PDF engine: pdf.js page store, bounded bitmap cache, placeholder for a missing asset | ✅ | ✅ cache, scaling, limits (pdf.js stand-in); ❌ real pdf.js and rendering | | ✅ | speed on large PDFs unknown; depends on Obsidian's `loadPdfJs()` |
| Import a PDF as a new notebook; insert a PDF (whole or page range), a blank page or an image as a page | ✅ | ✅ page creation, range, asset helpers; ❌ file picking and the UI | | ✅ | |
| Content-addressed assets in `<notebooks folder>/_assets/` (same file stored once) | ✅ | ✅ hashing, names, paths; ❌ vault writes | | | |
| Scanner: camera or photo file, 4-corner crop with loupe, automatic page detection | ✅ | ✅ detection, geometry; ❌ camera, touch handling, loupe | | ✅ | |
| Scanner: perspective correction, filters Original / Document / Whiteboard, rotate, retake, several sheets | ✅ | ✅ warp and filters on synthetic images; ❌ real photos | | ✅ | quality on real photos is unknown |
| Scan into the notebook as pages, as an image, or as a new notebook | ✅ | ✅ page building; ❌ view and library commands | | | |
| Export: PDF backgrounds (200 dpi) and images embedded as JPEG in PDF and SVG | ✅ | ✅ writers with images; ❌ rasterising (canvas) | | ✅ | not opened on Android; large files |
| Page navigator: thumbnails, tap to jump, drag to reorder, bookmarks and filter | ✅ | ✅ reorder and bookmark logic; ❌ panel and touch drag | | ✅ | |
| Shape tool: line, arrow, rectangle, ellipse (`shape` strokes) | ✅ | ✅ geometry, constraints | | | |
| Shape recognition: hold the pen still 0.6 s to get a clean line, rectangle, ellipse or arrow | ✅ | ✅ recognition, hold check; ❌ in the view | | ✅ | thresholds need tuning on the device |
| Text boxes (place, edit, move, resize, rotate) | ✅ | ✅ layout, bounds, commands; ❌ editor | | ✅ | soft keyboard behaviour on Android unknown |
| Images as elements (insert from vault or device, move, scale, rotate) | ✅ | ✅ element commands; ❌ picker, drawing | | | |
| Lasso also selects and transforms text boxes and images | ✅ | ✅ element hit test and transform; ❌ gesture | | | |
| Selection bar (lasso): Copy, Cut, Duplicate, Paste, colour and width rows, Make white transparent; Paste alone when nothing is selected | ✅ | ✅ logic below; ✅ harness (headless Chrome, synthetic pen and paste events); ❌ touch on a device | | | |
| Restyle selection: colour and width of selected strokes, colour of text boxes, one undo step; highlighters keep highlighter colours and widths | ✅ | ✅ `planRestyle`, undo/redo, mixed selections | | | |
| Copy, cut, paste, duplicate of strokes and elements with their images, across pages and notebooks (plugin clipboard for the session; images re-stored in `_assets/`) | ✅ | ✅ capture, new ids, offsets, one undo step, valid file; ❌ images across notebooks (needs a vault) | | | |
| Paste from the system clipboard: picture to image element, plain text to text box; paste box where the WebView cannot read the clipboard | ✅ | ✅ decisions, text normalisation, sizing; ✅ synthetic paste events in the harness; ❌ real clipboard | | ✅ | Android WebViews may refuse `navigator.clipboard`: the paste box (press and hold, Paste) is the fallback |
| White to transparent for an image element (processed PNG copy stored as a new asset, no format change) | ✅ | ✅ pixel rule and commands; ✅ harness (pixels of the stored copy); ❌ large photos on a phone | | ✅ | fixed threshold; PDF/SVG exports draw images on white |
| Ruler (two-finger placement, the pen follows the edge) | ✅ | ✅ geometry, snapping; ❌ gesture | | ✅ | |
| Infinite page (grows by half a page near the bottom, up to 20 × the width) | ✅ | ✅ growth rule; ❌ view | | | |
| Insert or remove space (drag a line; content below moves, overflows onto the next page, pages created; removal limited to the empty gap; one undo step) | ✅ | ✅ planning, page creation, undo/redo, infinite pages, elements; ❌ gesture and preview (view) | | ✅ | live preview of the shifted content is drawn on the live layer (not Android-tested); content falling on a page that does not exist yet is hidden, not shown |
| Automatic next page (setting, on by default; last page only) | ✅ | ✅ trigger rule, setting; ❌ view | | | bottom tenth of the page; not for infinite or PDF/image pages |
| Selective eraser: all ink / highlighter only / pen only / one colour, for whole-stroke, segment and area erasing | ✅ | ✅ filter rules; ❌ toolbar and gestures (view) | | | |
| Erase area: outline erases everything inside, strokes are cut at the outline, one undo step; optional text and images (setting) | ✅ | ✅ cutting, selective filter, elements, undo; ❌ gesture (view) | | | |
| Instant save journal (≈200 ms), crash recovery on open, never applied if the file differs | ✅ | ✅ slots, torn writes, diff, per file and per session keys, recovery after broken→ok; ❌ Obsidian adapter | | | whether it saves the last stroke after a real kill is not known |
| Version history: automatic snapshots, restore command, backup before restore | ✅ | ✅ naming, retention, restore guards (aborts if the save fails or the notebook differs); ❌ Obsidian commands | | | |
| Repair of a damaged notebook into a new notebook (#140): tolerant reader, line scan after damage, per-item validation, journal / snapshots / backups as further sources, summary of recovered and lost items; the original is never written | ✅ | ✅ `tests/repair.test.ts`: truncation, garbage in the middle, bad strokes and fields, duplicate ids, older versions through the migrations, v0, fuzzed inputs (300 damaged variants), source ranking, journal rebuild; ❌ dialog and vault side (needs Obsidian) | | | unknown fields of a newer version are not carried into the repaired notebook (they stay in the original) |
| Merge of conflicted copies from Google Drive / OneDrive / Dropbox / Syncthing / Android sync apps (#122): detection by name **and** same document id, diff summary, one undo step, copy kept or moved to `_backup/conflicts/` only after a verified save | ✅ | ✅ `tests/merge.test.ts`: nothing lost, idempotent, commutative content, undo restores the exact file, fuzzed divergent edits, name patterns; ❌ dialog, notice and file move (needs Obsidian) | | | name patterns of the Android sync apps are from their documentation and reports, not observed here |
| Restore a single page from a previous version (#180): pick a snapshot or backup, see its pages, insert as new page or replace the current one (one undo step) | ✅ | ✅ `tests/merge.test.ts`: replace keeps the page id and the rest, insert uses new ids, missing assets added back, undo; ❌ dialog (needs Obsidian) | | | preview thumbnails do not draw PDF or image backgrounds |
| Safe mode (#346): per-device opening marker (vault local storage, never synced) set before the load and cleared 1 s after the first paint; the next open after a crash or freeze uses safe mode (no low-latency ink or prediction, no page thumbnails, no companion note, no PDF text prefetch, backgrounds after the ink, skipped if they were loading when the last safe open died); banner with *Open normally* and *Repair…*; two consecutive failures suggest the repair | ✅ | ✅ `tests/safe-mode.test.ts`: marker before load, crash → safe, two failures → repair, stays safe until *Open normally*, forced normal open that crashes again, media stage, abandoned opens, renames, broken storage, size limit; ❌ view banner, first-paint detection and the switches (need Obsidian) | | ✅ | a real crash or freeze while opening was never reproduced here; going to the background before the open settled is not counted |
| Storage full (#347): write errors classified (no space, read-only/permission, partial write, other), persistent *Not saved* banner with *Retry now*, retries with exponential backoff (5 s doubling to 60 s; timed saves wait for it), every write up to 2M characters read back (all while failing), a partial file is replaced by the previous content, a space probe in the plugin folder before the file is touched again after a full disk; the document stays in memory and in the journal | ✅ | ✅ `tests/write-guard.test.ts` with a fake vault that throws, truncates and fills up: classification, backoff timing, one warning per streak, journal still written, torn write undone, partial file recognised as ours (no conflict backup), silent partial write caught by the read-back, probe gating, permission errors, close with a full disk, a valid external write right after ours; ❌ `AdapterSpaceProbe` and the banner (need Obsidian) | | ✅ | the error text of a full disk on Android (Capacitor) is not known; matched by `ENOSPC`, "no space", "quota", "disk full" and similar. A file larger than 2M characters is read back and compared by length, start and end while saving works |
| Integrity check (#390): per-device ledger (vault local storage) of the last 5 versions this device wrote per notebook; on open and on reload the file is compared: an older version of ours put back (not explained by a version-history restore) or different pages under the same edit time are reported with *Restore the newer version* (merge, one undo step, only after a reload), *Restore a version…* and *Keep this version*; the version that was open is kept as an `integrity` backup when a reload replaces it with a suspicious or unreadable file; command *Check notebooks integrity* (parse, save check, ledger, asset files present and of the recorded size) with a report and actions | ✅ | ✅ `tests/integrity.test.ts`: normal edits from another device (also with a clock behind, deletions, metadata patches, another serializer layout) never flagged, rollback, restore explained, altered, unreadable, newer format, ledger limits/rename/throttling, check of a notebook (missing and damaged assets); ❌ banner, backups, report dialog (need Obsidian) | | ✅ | a rollback to a version this device never wrote, or one older than its last 5 writes, is not detected; a crash within 2 s of a save may lose the last ledger entry (never causes a false report) |
| Embeds: `notebook` code block and wikilink form, refresh on change, click opens the page | ✅ | ✅ parsing and building; ❌ rendering in Obsidian | | | not tried in reading view and live preview on Android |
| `obsidian://notebook?path=…&page=…` links; command to insert an embed | ✅ | ✅ parsing; ❌ protocol handler | | ✅ | whether Android hands the link to Obsidian is untested |
| Page jump when opening from search, links and embeds | ✅ | ✅ page parsing; ❌ view | | | |
| Page links `[[Physics.notebook#p3]]`: following one opens the notebook (focusing its tab) at that page, also when it is already open (`setEphemeralState` subpath) | ✅ | ✅ subpath and state parsing; ❌ view and Obsidian link handling | | | |
| Page suggestions while typing `[[Physics.notebook#` (page number + first text box, `p3` inserted) | ✅ | ✅ trigger detection, filtering, titles; ❌ `EditorSuggest` in Obsidian | | ✅ | Obsidian's own link suggester also reacts to `#`; which one wins is untested. Suggestions need the file extension (`[[Physics#` is left to Obsidian when a note of that name exists) |
| Native embed `![[Physics.notebook#p3]]`: page preview in reading view and live preview, click opens the page | ✅ | ✅ source building and extension detection; ❌ rendering in Obsidian | | ✅ | uses Obsidian's embed registry, which is not in the public typings (feature-detected); without it only reading view works (post-processor) and live preview keeps the plain embed — use the `notebook` code block there |
| File explorer menu: "New notebook here" on folders, "Annotate in Notebook" on PDFs (new notebook in the notebooks folder, the PDF as page backgrounds) | ✅ | ✅ menu rules; PDF import flow already covered; ❌ the menu and vault access | | | |
| Page menu: "Copy link to this page", "Insert link / page preview into the active note" (link style follows the user's Obsidian setting) | ✅ | ✅ link/embed text and insertion rules; ❌ menu, clipboard and editor | | | the note is the last Markdown note that had focus; reading view is refused with a message |
| Companion notes (O1, setting, **default off**): properties (link, id, pages, dates, meta fields, tags) and text boxes per page with page links | ✅ | ✅ generator, escaping, determinism; ❌ writing through the Vault API | | | Properties panel display of the UTC `created`/`modified` values not checked in Obsidian |
| Companion notes: user text and user properties kept; only the generated block and plugin-owned properties change; broken markers or YAML leave the note alone | ✅ | ✅ region and property merge, tags shared, idempotent; ❌ `processFrontMatter` in Obsidian | | | |
| Companion notes: debounced, wait while a pointer is down in a notebook view, no write when unchanged, no regeneration from `.md` changes | ✅ | ✅ no-change detection only; ❌ timing and events (Obsidian) | | | whether two synced devices never both write the note is untested |
| Companion notes: renamed/moved with the notebook, kept (with a notice) when it is deleted, fallback name when a note of the user's has the name | ✅ | ✅ paths and fallback; ❌ rename/delete events | | | |
| Companion notes: location (next to the notebook / folder mirroring subfolders), name template, *Update companion notes of all notebooks*, *Open companion note* | ✅ | ✅ paths, settings parsing; ❌ settings UI and commands | | | |
| Page links without `vault=` in companion notes (current vault) | ✅ | ✅ link building; ❌ protocol handler | | ✅ | whether Obsidian on Android opens a link without `vault=` is untested |
| Duplicate page ids rejected on read and on write; assets verified before use | ✅ | ✅ review-fixes tests | | | |
| Format v6: page margins, v5→v6 migration, newer file read-only | ✅ | ✅ migration, validation, round trip, future version | | | |
| Format v7: bookmark details, page tags, reading position, new paper kinds; v6→v7 migration (drops v7 keys found in a v6 file, rejects v7 papers in a pre-v7 file); newer file read-only | ✅ | ✅ migration, validation, deterministic round trip, future version, incremental save check | | | |
| v7 fields kept by duplicate page, page restore (tags united), conflicted-copy merge (union rules, coverage), repair (line scan and salvage), library metadata patch, companion note | ✅ | ✅ model-v7 tests | | | |
| A stroke or element with no colour is refused by the writer with a clear message, repaired in memory before a save, and the save then goes through | ✅ | ✅ save-missing-colour tests (writer, repair, session) | | | |
| Generated outline (#407, combines #15, #102, #46): bookmarks, PDF slide changes, large handwriting as headings (found by letter size, shown as a picture of the ink, no OCR) and markers in one nested list ordered by page and position, tap to jump, one switch per source in Settings → Pages → Outline, per-page cache, no format change | ✅ | ✅ `tests/outline-builder.test.ts` (heading detection, levels, nesting, ordering, sources, cache, settings); ✅ harness `outline-*` (rows by source, pictures, nesting, tap to jump, filter, switches; tablet and phone, dark and light); ❌ handwriting from a real S Pen (the thresholds are tuned on synthetic writing) | | ✅ | the 1.7× size threshold and the "starts a block" gap are heuristics: a title written right under the previous line, or only slightly larger, is not listed; a large single stroke is treated as a drawing (steps 600-613) |
| Notebook map (#408, extends #223): grid of page thumbnails for the whole notebook with a badge per state (open question, gap, homework with due date, key point, unfinished practice, nearly empty), filter chips with counts, tap to go to the page, lecture starts marked, per-page-revision cache, thumbnails from the page panel's cache; no format change | ✅ | ✅ `tests/notebook-map.test.ts` (states, resolved items, nearly empty, practice, counts, filter, lecture range, cache reuse, page moves); ✅ harness `nbmap-*` (cards, counts, filters, tap to go; tablet and phone, dark and light); ❌ on a real device | | ✅ | unfinished practice is a heuristic (a practice copy with nothing written), not the attempt timer (steps 770-780) |
| Outline (#15, #85): bookmarks with title, colour and category ("important", "to review", custom) in the page panel, category filter, tap to jump, add / edit / delete, one undo step each | ✅ | ✅ bookmark helpers, SetMeta undo; ✅ harness (outline, editor, undo/redo); ❌ unit (DOM only) | | | |
| Page tags (#119): page menu *Page tags…*, tag filter in the page panel, library search finds them and opens the page | ✅ | ✅ normalisation, SetPageTags undo, index and search; ✅ harness (editor, filter) | | | |
| Reading position shared across devices (#125): written only with a content save, start page chosen between link, layout restore and stored position | ✅ | ✅ session hook (no write of its own, journal/save consistency), start rules; ❌ view scrolling, two real devices | | | stored only when something is saved: a notebook only read on a device does not move the other device's start page |
| Papers (#73): Cornell, music staff, isometric, hexagonal, calligraphy, daily and weekly planner (canvas, thumbnails, PDF/SVG, dialog, page menu, settings) | ✅ | ✅ pattern geometry, culling, density, export; ✅ harness (drawn on screen) | | | |
| Expandable margins on PDF pages (#104): left/right/bottom, all pages of a PDF, undo; ink stays on the PDF; infinite PDF page grows below the PDF | ✅ | ✅ commands, background box, resize rule; ❌ dialog, drawing | | | |
| Margins in exports and thumbnails (PDF/SVG at full page size, PDF in its box) | ✅ | ✅ background box only; ❌ export glue | | | |
| Re-published slides (#235): content fingerprint (text, image hash for text-poor slides), new pages appended, updated slides switchable, summary, one undo step | ✅ | ✅ matching, family, insertion point, plan and undo; ❌ pdf.js text and rendering on real files, dialog | | ✅ | similarity thresholds need tuning on real lecture PDFs |
| Export PDF annotations to Markdown (#155): highlights with the PDF text under them, text boxes, a link per item, never overwrites | ✅ | ✅ text boxes from pdf.js items, text under a highlight, note text, unique names; ❌ pdf.js on real files, writing the note | | ✅ | text selection depends on the PDF's text layer |
| English UI + Italian translation | ✅ | ❌ | | | |
| No Node/Electron imports in `main.js` | ✅ | ✅ `scripts/check-bundle.mjs` in `npm run build` | | | |
| Instant board shot (toolbar camera button, command): in-app camera → automatic crop (whole photo if no outline) → whiteboard filter → image element under the last ink + time label, one undo step | ✅ | ✅ placement (below the ink, scaled down, infinite page grows, fallback over content), label, one undo step; ❌ camera, crop on real photos, view | | ✅ | quality of the automatic crop on real boards is unknown; HEIC from the camera app fallback shows the usual message |
| New lecture (command, page menu): modal for course/title (default: notebook name) and date, new page at the end with the header as a text element, one undo step | ✅ | ✅ header text, date parsing, page copy of size/paper, undo; ❌ modal, view | | | the document format has no page titles, so the header is ordinary text (searchable in the library) |
| Loose sheet (command, ribbon icon, library button): quick-notes notebook in a configurable location, created on first use, never replaced | ✅ | ✅ path resolution and sanitising, setting parsing; ❌ file creation and opening (Obsidian) | | | setting *Loose sheet location* |
| Move to notebook… (page menu, command): choose pages and a notebook; target saved first (open view: one undo step; closed file: validated, backup kept, read back), then the pages leave the source (one undo step); assets shared by id | ✅ | ✅ planning, asset records, source-removal rules (edited pages stay), never-empty source, undo; ❌ dialog, vault writes, open-view path | | ✅ | not tried with Obsidian Sync or with the target open on another device |
| Synchronised PDF ↔ notes view (#106): command and "…" menu entry *Open PDF side by side*; the PDF (a plain vault `.pdf`, or another notebook's pages) in a pane inside the notebook view, side by side on a wide landscape view and stacked otherwise, draggable divider | ✅ | ✅ side-by-side / stacked rule, divider limits; ❌ pane, pdf.js rendering, divider drag, Obsidian | | ✅ | the split is internal because Obsidian on phones and tablets has no split panes in the main area; untried on Android; one reference page at a time (no continuous scroll in the pane) |
| PDF ↔ notes links: sidecar `_meta/pdf-links.json` in the notebooks folder (moved over from the plugin folder) (notebook id + page id ↔ PDF content id / path + page number), written only by *Link*, *Unlink* and *Add notes page for this slide*, never on scroll; no notebook format change | ✅ | ✅ parse/serialise round trip, unknown entries kept, set/remove, queries, read-modify-write before each update, no write when unchanged, unreadable or newer file never overwritten (one copy kept), concurrent updates; ❌ adapter on a real vault, sync between devices | | | not tried with Obsidian Sync or another sync tool |
| Following: turning the PDF page shows the linked notes page (stays if already on one), scrolling the notes shows the linked PDF page, *Follow* toggle, no echo; strip *Show* when the notes are elsewhere | ✅ | ✅ decision rules (stay / go / none) and link states; ❌ view wiring, timing, the middle-of-screen page rule with short pages | | ✅ | |
| *Add notes page for this slide*: new page (size and paper of the page in view) in slide order, one undo step, linked; works with PDF backgrounds beside a separate notes notebook | ✅ | ✅ insertion index rule; one-step undo of adding a page is covered by the history tests; ❌ the strip and the link write | | | undo removes the page but leaves its link in the file (ignored while the page is missing, back after redo) |
| Lecture pack layout (#192): slide + notes area on the right or below, one slide per page scaled to a fixed size, chosen paper in the notes area, via v6 margins | ✅ | ✅ geometry, aspect ratio, page plan, format round-trip; ❌ rendering of the notes area | | | 2 or 3 slides per page are not implemented: they need a format change (several backgrounds per page) |
| Notes page after every slide (#193): blank page, same size, paper of choice | ✅ | ✅ plan order, size, paper; ❌ view | | | |
| New lecture from slides… (#191; command, library button, folder menu): PDF from the vault or the device, layout, header page / header text / none, course, date, notebook created in the folder and opened; PDF stored once | ✅ | ✅ flow with an injected host (cancel, empty PDF, failure, progress), header text and placement, notebook name, format round-trip; ❌ dialog, picker, vault writes | | | |
| Insert PDF with the lecture pack layout (page menu): same layout questions after the page range, one undo step; last layout remembered on the device | ✅ | ✅ pages built by the same function, stored options parsing; ❌ dialog, view | | | |
| Exercise page here (page menu, toolbar … menu, command): blank page with the exercise paper (default grid, remembered, changeable) right after the current page, full size of that page, scrolled to, one undo step | ✅ | ✅ page size/paper/no margins, infinite page, undo; ❌ menus, view | | | |
| Finger taps (setting *Finger taps*, **default two fingers undo / three redo**): all fingers land within 150 ms, move ≤ 12 px, lift within 150 ms, whole tap ≤ 350 ms; ignored with a pen near (palm rejection window), a palm / edge-zone contact or a pen contact in the series; the view is put back after the tap; swap and off | ✅ | ✅ detector (tap, pan, pinch, slow, late landing, late lift, cancel, pen, stale contact), mapping, stage glue with a fake element, no stroke ends from a finger tap; ❌ real touch hardware | | ✅ | thresholds are guesses until tried on the tablet |
| A finger that lands among fingers already panning / pinching never starts a stroke (also with *Draw with finger*) | ✅ | ✅ controller routing | | | |
| Scribble to erase (wave 0.6, setting, **default off**): fast back-and-forth over ink deletes the strokes crossed by ≥ 2 legs, scribble not kept, one undo step | ✅ | ✅ detector on synthetic paths (angles, jitter, leg counts; negatives "mmm", sharp-topped "mmm", sweeping zig-zag shading, separate hatching strokes, slow scratch, lines / circles / spirals), victims (graze, long ruling, empty paper), one undo step; ❌ real pen strokes, view glue | | ✅ | thresholds (leg ≥ 12 pt and a turn window of 8 pt, ≥ 4 reversals, ≤ 300 ms per leg, drift ≤ 0.8 of a leg) tuned on synthetic data only |
| Pen gestures (roadmap 139): recognisers for circle (select), "^" (space), one-stroke "#" (tags), one-stroke star (bookmark), "?" (search), line / arrow to a thumbnail (move selection), scribble (delete, existing detector); retrace-to-cancel; context rules (ink inside, ink under, page, selection + thumbnail) | ✅ | ✅ `tests/pen-gestures.test.ts` (positives at several sizes, tilt and tremor; negatives: letters, digits, H/N/+/E, zig-zag, wave, arch, V, n, A, 7, figure eight, spiral, half circle, lines and arrows without a selection, disabled gestures); ❌ real pen strokes | | ✅ | shapes and thresholds tuned on synthetic data only; "#", star and "?" must be drawn in one stroke |
| Gesture triggers: gesture mode, side button "Pen gestures while held", opt-in long press (rest 0.65 s within 5 px of the first contact); never during normal writing, never for a finger or the eraser | ✅ | ✅ pure policy (`gestureStarts`, `dwellMayStart`, `DwellTracker`), settings and routing in `tests/pen-gestures*.test.ts`; ❌ the view glue and the real side button | | ✅ | how the button reaches the page is unverified (see the pen button notes) |
| Preview label beside the nib, vibration on change, cancel by going back along the stroke, "Not recognised" | ✅ | ✅ recogniser, retrace and preview clock; ❌ the overlay | | | |
| Custom gestures: three samples, consistency and built-in checks, template matching (`ink/gestures/dollar.ts`), bind to an Obsidian command, settings storage and parsing | ✅ | ✅ `tests/pen-gestures-custom.test.ts`; ❌ the pad and the command picker in Obsidian | | ✅ | |
| Gesture effects in the undo history (delete, space, bookmark, move): ink first, effect after; move to another page plan | ✅ | ✅ move plan and undo (`tests/pen-gestures-view.test.ts`); ❌ the other effects in Obsidian | | | |
| Cheat sheet, per-gesture switches, settings section, commands | ✅ | ❌ (needs Obsidian) | | | |
| Auto-scroll after writing near the bottom (wave 0.6, setting, **default off**): stroke ends in the bottom 18 % → after 700 ms the view scrolls up 320 ms (ease-out) so the tip is at 40 %; never during a contact | ✅ | ✅ distance, easing, timing, cancel on contact, end of document; ❌ real view | | ✅ | the 700 ms pause and the 40 % target are guesses |
| Pen side button: *Lasso while held* and *Previous tool while held* (extend *Pen side button*; default stays *Radial menu*); the tool is chosen when the pen touches down | ✅ | ✅ routing, held tool passed to the stroke start, setting parsing, previous-tool memory; ❌ the S Pen's real button reporting | | ✅ | pressing the button after the pen touched down does not switch (same as the eraser option) |
| Scribble to erase (setting, **default off**): fast back-and-forth over ink deletes the strokes crossed by ≥ 2 legs, scribble not kept, one undo step | ✅ | ✅ detector on synthetic paths (angles, jitter, leg counts; negatives "mmm", sharp-topped "mmm", sweeping zig-zag shading, separate hatching strokes, slow scratch, lines / circles / spirals), victims (graze, long ruling, empty paper), one undo step; ❌ real pen strokes, view glue | | ✅ | thresholds (leg ≥ 12 pt and a turn window of 8 pt, ≥ 4 reversals, ≤ 300 ms per leg, drift ≤ 0.8 of a leg) tuned on synthetic data only |
| Auto-scroll after writing near the bottom (setting, **default off**): stroke ends in the bottom 18 % → after 700 ms the view scrolls up 320 ms (ease-out) so the tip is at 40 %; never during a contact | ✅ | ✅ distance, easing, timing, cancel on contact, end of document; ❌ real view | | ✅ | the 700 ms pause and the 40 % target are guesses |
| Library trash (#160): deleting a notebook or folder moves it to `_trash/` with its original path; restore to the original place or a free name; delete permanently and empty trash ask first; trash excluded from library, index, search, companion notes and conflicted-copy detection | ✅ | ✅ `tests/library-trash.test.ts`: layout, meta parsing, `isInTrash`, reserved folders, restore naming; ❌ vault moves, dialogs (need Obsidian) | | | permanent deletion follows Obsidian's *Deleted files* setting |
| Library trash auto-empty (setting *Empty the trash automatically*, **default off**) | ✅ | ✅ expiry rule, boundary, setting parsing; ❌ run at start-up | | | |
| Assets used only by trashed notebooks or deleted pages stay in `_assets/` | ✅ | ✅ `trashedAssetIds`; nothing deletes assets yet (#27) | | | a future clean-up must treat `_trash/` as references |
| Page trash (#26): *Delete page* keeps the page in its own file `_trash/pages/<notebook id>/<entry id>.json` (assets and bookmark kept), written before the page is deleted; *Deleted pages...* lists them with thumbnails; restore after the page that preceded it, one undo step; 50 pages / 30 days per notebook | ✅ | ✅ entry round trip through the file, caps and retention, position rules, ids, assets, bookmarks, undo; one file per entry never modified, conflicted copies read, old layout moved over without losing entries, unreadable files left alone, delete refused when the copy fails, entry discarded only after a saved restore (in-memory vault); ❌ dialog, real vault | | | not part of the notebook format |
| Notebook templates (#19, 0.15): *Save as notebook template…* (library card, More sheet, command) to a configurable folder (hidden from the library), *From a notebook template…* in the creation dialog (cards with cover art, Pages only / With content, `{{date}}` in title, description and text boxes), manage (rename, delete to trash with confirmation) in settings | ✅ | ✅ `tests/notebook-template.test.ts` (ids renewed, assets and slide links carried, pages only, placeholders, folder rules); ✅ harness `doc=templates` (picker, dialog, manager; targets, no overflow, create, delete) | | | steps 820-829 |
| Page templates (#74): *Save page as template...* (content, paper, size, background), *New page from template...*, template row in the *New notebook* dialog, gallery with thumbnails, built-in Cornell / meeting / to-do templates | ✅ | ✅ saved page, fresh ids on every use, built-ins valid and round-trip, new notebook from a template; ❌ gallery, dialogs | | | stored in the templates folder (setting), as ordinary notebook files |
| Ink attached to objects (#149), geometric, no format change: strokes with at least 60% of their points inside an image or text box move, scale and rotate with it through the lasso handles, in the same undo step; setting *Ink follows objects* (default on) | ✅ | ✅ ownership (image, rotated image, text, overlapping elements, topmost wins), exclusion of selected strokes, move / scale / rotate keep the ink on the object, one undo step, serialization; ❌ drag preview and handles (view) | | | the 60% threshold is a guess; a stroke written half on and half off an object stays behind |
| Deleting an object that has ink on it offers (notice with a button, 10 s) to delete that ink too, as its own undo step; ignoring the notice keeps the ink; the button does nothing if the object was restored by undo meanwhile | ✅ | ✅ ink found for the removed elements, delete command and undo; ❌ notice and button (view) | | | |
| Personal stamps (#142): *Stamps* in the "more" menu opens a palette; *Save selection as stamp* stores the lasso selection (strokes, text, images with their asset records) as `<notebooks>/_stamps/<name>.stamp`; tap places it in the middle of the page in view, drag places it where it is dropped; placed stamps get fresh ids and are selected; one undo step | ✅ | ✅ file round trip and validation (damaged, newer, empty, too large), unique names, placement (fresh ids, centre, inside the page, assets registered once, missing images skipped, undo), previews; ❌ palette, drag and drop, vault files (Obsidian) | | ✅ | drag from the palette with a finger relies on `touch-action: pan-y`, untested on a WebView |
| Stamps: rename, delete (to the trash, after a confirmation); a stamp file that cannot be read is shown as unreadable and never rewritten | ✅ | ✅ name cleaning; ❌ file operations and UI (Obsidian) | | | |
| Built-in stamps (checkmark, star, arrow) generated in code with the current pen colour and width | ✅ | ✅ geometry, colour, width, valid file | | | |
| Stamp files use the notebook document format (one page), so they follow the format's migrations and no format change was made | ✅ | ✅ valid document, parsed back with `parse` | | | Obsidian Sync syncs `.stamp` files only with *Sync all other types* on, like `.notebook` |
| Shared tags (O2): tag editor in the library menu and the command *Edit tags of this notebook* (suggestions from `metadataCache.getTags()`, chips, Obsidian-style normalisation incl. nested `a/b`, invalid tags reported) | ✅ | ✅ normalisation, suggestions, parsing; ❌ dialog and suggest popover (Obsidian) | | ✅ | `getTags()` is not in the public typings (feature-detected, with a fallback over all notes); suggest popover on Android untested |
| Shared tags: merge rule for the companion note's `tags` (notebook tags added; tags the person wrote never removed, also when the notebook had the same tag; only tags the plugin added are removed; deleted-by-hand notebook tags come back) | ✅ | ✅ rule and multi-update scenarios, region state | | | the state stored on the start marker now lists only the tags the plugin added; notes written by 0.5.0 count all their notebook tags as added |
| Shared tags: library filter by tag includes nested tags (`physics` finds `physics/optics`) and counts parents; tag editor hint with *Turn on companion notes* when they are off | ✅ | ✅ filter and counts; ❌ hint and setting change (Obsidian) | | | tags are copied notebook → note only: a tag added only in the note is not added to the notebook |
| Public API for other plugins (#168): `app.plugins.plugins["notebook"].api` with `version`, `createNotebook`, `addPages`, `insertImage`, `exportPdf`, `getNotebookInfo`, `openNotebook`, `listNotebooks`, typed `NotebookApiError`s, `docs/api.md` | ✅ | ✅ argument validation, generated documents, closed-notebook write plan (unreadable file never overwritten, validation, read-back check), per-notebook queue, doc covers every method and code; ❌ calls through the Vault and open views (Obsidian) | | ✅ | open notebooks are edited through their session (one undo step); closed ones by validated read-modify-write with a `before-api` backup; not yet run inside Obsidian |
| Zettel cards (Z1): *Make card from selection* / *from this page*, note with id, title, aliases, type, source, date, tags, notebook link and id (`zettel-notebook`, `zettel-notebook-id`), page-id, region; live embed; Transcription section | ✅ | ✅ note text, properties, legacy keys, id generation (timestamp with seconds and random suffix, Luhmann), file names (suffix for untitled Luhmann cards); ❌ dialog, `vault.create`, menu | | | the notebook tab's ⋯ menu entries rely on Obsidian passing that menu to `file-menu` (not checked) |
| Card subpath `#p3&id=<page id>&r=x,y,w,h` in links, native embeds and the `notebook` code block: page found by id, region cropped, deleted page reported | ✅ | ✅ parse/build, page lookup, clamping, region size; ❌ rendering in Obsidian | | | |
| Slip-box (Z2): *New slip-box* (A6 pages), *Make this notebook a slip-box*, a card note for each page made on this device in this session, after an own save (pages that came by sync never get one here) | ✅ | ✅ settings parsing, A6 size, which pages count as made here (`LocalPages`); ❌ triggers, creation, sync behaviour | | ✅ | slip-box list is in the plugin settings (per device unless settings sync) |
| Drawn links (Z3): shape-tool arrow from one card region to another → `links` in both notes; only arrows drawn since the notebook was opened; explicit command for older arrows | ✅ | ✅ arrow detection, card under a point, link merge; ❌ writing, graph display | | ✅ | hand-drawn (pen tool) arrows are not detected |
| Card title (Z11): typed title in the dialog or *Set card title* (title + aliases, note renamed from `<id>` to `<id> <title>`) | ✅ | ✅ title/alias changes; ❌ rename, prompt | | | |
| Card regions on the page (outline + id badge, `pointer-events: none`), setting and command to hide them | ✅ | ❌ (DOM over the canvas) | | | not checked that the overlay never disturbs S Pen input |
| Cards never deleted; `orphaned` set/cleared with the page; *Show orphaned cards*; card notes edited only in the frontmatter (only the lines of the changed keys: comments and quoting kept), body kept byte for byte, no write when unchanged; flags written only after this device's own saves, never for synced changes | ✅ | ✅ frontmatter line edit, orphan rule; ❌ triggers and `vault.process` | | | |
| Companion notes never claim a card note (cards have their own `zettel-notebook` keys; old cards with the companion keys are skipped by `zettel-id`) | ✅ | ❌ (needs the Vault) | | | |
| Search the PDF text of the open notebook (#44): command, PDF contextual bar and *All actions* sheet, results list with page and snippet, hits marked on the pages (transient overlay, never saved), next/previous, accent/case/ligature-insensitive, at least 2 characters | ✅ | ✅ `tests/pdf-reading.test.ts`: page text assembly, normalisation with offsets, matching, snippets, hit boxes, measured character widths, cache, chunked search (order, limit, cancel, yield, unreadable PDF, shared pages); ✅ harness scenario `pdf` (fake pdf.js: results, marks, next, accents, short query, close); ❌ real pdf.js text on real files | | ✅ | marks inside a long run depend on the font metrics the WebView measures (`measureText`); hits are cut at 500; speed on a PDF with hundreds of pages unmeasured |
| Highlighter that snaps to the PDF text lines (#43): option in the highlighter's options, one straight highlighter stroke per line crossed (whole words), one undo step, hand-drawn stroke kept when no text is under it | ✅ | ✅ `tests/pdf-reading.test.ts`: words, 40% coverage, lines, gap between lines, columns, taps, blank and vertical runs, stroke points; ✅ harness scenario `pdf` (strokes in the real view: width, one undo step, no text, option off); ❌ real PDFs | | ✅ | text geometry from pdf.js (baseline and font size); rotated text is not snapped; the text of a page must be read before pen-up |
| Show/hide all annotations on PDF pages (#188): view only, indicator banner with a button to show them again, editing and the toolbar disabled meanwhile, a finger still scrolls, nothing saved or changed | ✅ | ✅ harness scenario `pdf`: ink disappears from the static layer, no stroke can be added, tools disabled, finger pans, banner button restores; ❌ on a device | | | exports and thumbnails still contain the ink |
| Links in text boxes (O8): `[[Note]]`, `[[Note|alias]]`, `[[Note#Heading]]` drawn as links (colour, underline, dimmed and dashed when the note does not exist); finger tap or Ctrl/Cmd+click opens the note in a new tab; the text tool still edits; *Create note* for an unresolved link | ✅ | ✅ `tests/link-text.test.ts`: parsing (aliases, headings, embeds, odd input), wrapped layout and hit rectangles, hit testing, new-note path rules; ❌ drawing, opening and creating in Obsidian | | ✅ | the brackets stay visible; relative links (`[[../x]]`) resolve from the notebook's folder; a renamed note is not followed (Obsidian rewrites links in Markdown only) |
| `[[` suggester in the text editor (O8): list of notes/notebooks by name, headings after `#`, arrows/Enter/Tab/Escape/tap, result written as `[[note]]` | ✅ | ✅ trigger, completion and ranking (`tests/link-text.test.ts`); ❌ the popup and its keyboard/touch behaviour (Obsidian, Android keyboard) | | ✅ | a touch on the list must not close the editor (pointer events are stopped and focus kept): unverified on Android |
| Ink links (O8): lasso → *Link to a note…* (or the command) attaches `[[Note]]` as a text element above the ink, with a badge; tap on label or ink opens the note; the ink is unchanged; undo removes it | ✅ | ✅ placement, page bounds, covering box, no format change, round trip (`tests/link-text.test.ts`, `tests/pen-links-companion.test.ts`); ❌ chooser, tap and undo in the real view | | ✅ | a link is a text element: editing it in the text tool drops the empty lines that stretch its box, after which only the label is tappable |
| Handwritten `[[` (O8): two bracket strokes → *Link to a note…* chip, never automatic; not triggered by l1, ||, (( ), [], letters | ✅ | ✅ `tests/bracket-detect.test.ts`: synthetic strokes with jitter in both directions, ] and [ told apart, negatives (l, 1, |, parentheses, S, Z, wide letters, different sizes, other lines, far apart, highlighter/shape), candidate tracking while the name is written; ❌ real handwriting | | ✅ | thresholds are tuned on synthetic strokes only: real S Pen handwriting may need adjusting (hook size, spine tilt) |
| Links in the companion note (O8): text-box and ink links are copied with the text of the page, so graph and backlinks see them | ✅ | ✅ `tests/pen-links-companion.test.ts`: links, aliases and headings kept, ink link listed once, region markers cannot be closed from a link; ❌ Obsidian's graph | | | |
| Dim the background (#199): toggle and strength slider (10-80%) in the "more" menu, kept in the plugin settings; PDF and image backgrounds only; exports and thumbnails are not dimmed | ✅ | ✅ settings parsing and opacity; ✅ harness scenario `pdf`: background pixel lighter, slider changes it, off restores it; ❌ on a device | | | |
| Dim the background (#199): toggle in the PDF contextual bar and the *All actions* sheet, strength slider (10-80%) in the sheet, kept in the plugin settings; PDF and image backgrounds only; exports and thumbnails are not dimmed | ✅ | ✅ settings parsing and opacity; ✅ harness scenario `pdf`: background pixel lighter, slider changes it, off restores it; ❌ on a device | | | |
| Sync safety (#342–#345) pure logic: presence file names, records, freshness, device id and name; not-downloaded placeholders; waiting assets; sync check of folders, names, paths, case clashes and sizes | ✅ | ✅ `tests/sync-safety.test.ts` | | | |
| Not-downloaded session mode (#344): 0-byte / whitespace / NUL file never broken, backed up or written; loads when the content arrives; no conflict backup of a placeholder | ✅ | ✅ `tests/sync-safety.test.ts`, `tests/session.test.ts` | | | |
| Sync review fixes (wave 0.7): cut-off / NUL-tailed / just-changed files are "still arriving" (one backup per content, size-capped, polling goes on); evidence of damage (ledger, journal, own torn write) keeps an open document in memory with *Write it back* / *Recover…*; the open version is always backed up before an empty or cut-off reload; a dirty save waits for a file being downloaded; read-back repairs only our own partial write, backs up our text when another valid version replaced it; a newer version after a failing streak is offered for merge; large writes verified by length and edges; restores stamp a new `modifiedAt`; integrity check reports empty notebooks and arriving assets; presence heartbeat 5 min; undecodable images reload; quick switcher saves the library index | ✅ | ✅ `tests/sync-review.test.ts` (fake vault); ❌ banners, confirmations and repair dialog (need Obsidian) | | | |
| "Open on another device" (#342): presence file per notebook and device, heartbeat every 5 min only while visible (and on resume when that old), removed on close, own leftovers removed at startup; banner with *Open read-only* / *Open anyway*; device name setting (local storage) | ✅ | ❌ (needs Obsidian and two devices) | | ✅ | freshness window (15 min) to be tuned against real sync intervals |
| Assets waiting for sync (#343): placeholder card / label, page editable, asset reloaded on vault create/modify/rename | ✅ | ✅ availability rule; ❌ rendering and vault events in Obsidian | | | |
| Not downloaded yet (#344) in the view (message, status, 4 s re-read while visible), library card, embed and repair command | ✅ | ❌ (needs Obsidian) | | | |
| Check sync safety (#345): command, settings row, startup notice when the issues change, per-notebook warning on open, other devices seen | ✅ | ✅ issue detection; ❌ dialog and notices | | | |
| Format v8 (wave 0.8): marker and box elements, stroke `hidden` flag; v7 → v8 migration (a `hidden` key in a v7 file dropped, a pre-v8 marker or box rejected); deterministic lines; lenient read (an invalid marker, box or optional field dropped and counted in `dropped`, also in staged loading), strict write (full and incremental check); a newer version opens read-only | ✅ | ✅ `tests/model-v8.test.ts` | | | |
| v8 data kept by every copy path: duplicate page, page restore (replace, insert), page trash (with and without an id clash), *Move to notebook…*, clipboard copy/paste, templates (save, page, notebook), lecture and exercise pages, repair (damaged lines, damaged fields), conflicted-copy merge (`mergeCovers` checks hidden ink and resolved state) | ✅ | ✅ `tests/model-v8.test.ts` | | | |
| Markers (#201 gap with time and slide, #202 question with resolved state, #203 !, !!, ★, #209 homework with due date): registry actions (lecture contextual bar, sheets, radial Markers ring, commands) arm a one-shot placement; a tap places a point marker, a drag a marker about a region; badges drawn above the ink (canvas, SVG, PDF) | ✅ | ✅ creation, edit, tap rules, bounds, transform, exports; ❌ placement and dialogs in the view (Obsidian) | | ✅ | no pen gesture yet |
| Tap on a badge (pen, highlighter, text, shape tools): question and gap toggle resolved, importance cycles ! → !! → ★, homework and box labels open their dialog; the lasso selects, moves and deletes markers and boxes like other elements | ✅ | ✅ `tapMarker`, `markerAt`; ❌ in the view | | | a tap that starts on a badge never writes a dot there |
| Structured boxes (#204): drag a frame, choose Definition, Theorem, Example, Proof or Remark; label tab with kind and title; companion note callout `> [!theorem] Title` with `![[…#p3&id=…&r=…]]` | ✅ | ✅ serialization, companion text; ❌ drawing in the view, embed rendering in Obsidian | | | the box does not group or move the ink inside it unless *Ink follows objects* attaches it |
| Homework → Obsidian task in the companion note's generated region: `- [ ] what 📅 YYYY-MM-DD`, `- [x]` when done | ✅ | ✅ companion text | | | one way: a task ticked in the note is not read back into the notebook |
| End of lecture panel (#223): questions, gaps, homework, importance markers and boxes of this lecture (pages from the last lecture header) or of the whole notebook; tap to jump, checkbox to resolve, *Edit* | ✅ | ✅ `collectMarkers`, `groupMarkers`, `lectureRange`, `SetMarkerDone`; ❌ the modal | | | |
| Invisible ink (#100): pen mode whose strokes are stored with `hidden: true`; shown only while the mode is on or *Show solutions* (notebook or page, view-only, never saved); hidden ink is not erased, lassoed or exported (PDF, SVG) unless shown, and never in thumbnails or embeds | ✅ | ✅ visible strokes, area eraser skip, SVG/PDF with and without, thumbnails skip; ❌ toggles in the view | | | *Scribble to erase* can still remove hidden strokes it crosses (undo brings them back) |
| Redo this exercise… (#303; page sheet, command): choose what to hide (all ink, some colours or tools, the lasso selection) in a practice copy that keeps the PDF/image background, margins, text boxes and pictures; right after the page or in an *Exercises* notebook (created when missing, name and choice remembered on the device); one undo step in the notebook it goes to | ✅ | ✅ `tests/practice.test.ts`: hide rules (colour, tool, ids, combined, normalisation), the copy (new ids, background and margins kept, tags, original untouched, format round trip, one-step undo with `AddPage`); ❌ dialog, menu, writing into an open / closed / new Exercises notebook (the writing follows *Move to notebook…*) | | | steps 215-217, 221; variants with different numbers (#182, #241) not built |
| Practice link: page tags `practice` and `attempt/<n>` + sidecar `_meta/practice-<device>.json`, one per device, merged on read with the other devices' files and the old shared `_meta/practice.json` (practice page id ↔ original page id, notebook ids with a path hint, attempt number, date, what was hidden, seconds), written only by *Redo this exercise* and the timer's *Stop*; no notebook format change | ✅ | ✅ parse/serialise round trip and fixed line order, unknown entries kept, duplicate line, newer or foreign file refused, empty file refused, add / seconds / remove, queries and numbering, only this device's file written, other devices' files and the old shared file merged (seconds add up, removals stay removed, old file never written), no write when unchanged, unreadable or empty own file never overwritten (one copy kept), concurrent updates; ❌ adapter on a real vault, sync between devices | | | steps 218, 223, 224; not tried with Obsidian Sync or another sync tool |
| Practice strip over a practice page: attempt number, *Peek*, *Original*, *Attempts*, timer; commands *Go to the original exercise*, *Attempts of this exercise* (numbered, dated, with time), *Peek at the solution* (on / off), *Start or stop the practice timer* | ✅ | ✅ numbering, attempt list order, totals, durations and dates; ✅ harness scenario `practice`: strip shown on a copy only, peek draws the hidden ink and removes it on release; ❌ navigation across notebooks, timer, touch and pen | | ✅ | the hold uses pointer capture, which a WebView may not grant to every pointer; steps 218-222 |
| Peek at the solution: the original's hidden ink drawn over the practice page while *Peek* is held (live layer, view only), never saved or exported | ✅ | ✅ which strokes are shown; ✅ harness (see above) | | ✅ | step 219 |
| Timer per attempt: *Start* / *Stop* in the strip, time added to the attempt's record on *Stop* and when the view closes; runs while you look at other pages | ✅ | ✅ elapsed time, duration text, accumulation of seconds in the file; ❌ the strip | | | not saved if the plugin is unloaded while it runs; step 222 |
| Redo this exercise… (#303; page sheet, command): choose what to hide (all ink, some colours or tools, the lasso selection) in a practice copy that keeps the PDF/image background, margins, text boxes and pictures; right after the page or in an *Exercises* notebook (created when missing, name and choice remembered on the device); one undo step in the notebook it goes to | ✅ | ✅ `tests/practice.test.ts`: hide rules (colour, tool, ids, combined, normalisation), the copy (new ids, background and margins kept, tags, original untouched, format round trip, one-step undo with `AddPage`); ❌ dialog, menu, writing into an open / closed / new Exercises notebook (the writing follows *Move to notebook…*) | | | steps 215-217, 221; variants with different numbers (#182, #241) not built |
| Practice link: page tags `practice` and `attempt/<n>` + sidecar `_meta/practice.json` (practice page id ↔ original page id, notebook ids with a path hint, attempt number, date, what was hidden, seconds), written only by *Redo this exercise* and the timer's *Stop*; no notebook format change | ✅ | ✅ parse/serialise round trip and fixed line order, unknown entries kept, duplicate line, newer or foreign file refused, add / seconds / remove, queries and numbering, read-modify-write before each update (another device's entry kept), no write when unchanged, unreadable file never overwritten (one copy kept), concurrent updates; ❌ adapter on a real vault, sync between devices | | | steps 218, 223, 224; not tried with Obsidian Sync or another sync tool |
| Practice strip over a practice page: attempt number, *Peek*, *Original*, *Attempts*, timer; commands *Go to the original exercise*, *Attempts of this exercise* (numbered, dated, with time), *Peek at the solution* (on / off), *Start or stop the practice timer* | ✅ | ✅ numbering, attempt list order, totals, durations and dates; ✅ harness scenario `practice`: strip shown on a copy only, peek draws the hidden ink and removes it on release; ❌ navigation across notebooks, timer, touch and pen | | ✅ | the hold uses pointer capture, which a WebView may not grant to every pointer; steps 218-222 |
| Peek at the solution: the original's hidden ink drawn over the practice page while *Peek* is held (live layer, view only), never saved or exported | ✅ | ✅ which strokes are shown; ✅ harness (see above) | | ✅ | step 219 |
| Timer per attempt: *Start* / *Stop* in the strip, time added to the attempt's record on *Stop* and when the view closes; runs while you look at other pages | ✅ | ✅ elapsed time, duration text, accumulation of seconds in the file; ❌ the strip | | | not saved if the plugin is unloaded while it runs; step 222 |
| Format v9 (wave 0.9: math): `equation` and `graph` elements; v8 → v9 migration (a pre-v9 file with either type is rejected); lenient read (an invalid outline, flag, function, parameter or setting is dropped and counted, also in staged loading); strict write; a newer version opens read-only | ✅ | ✅ `tests/model-v9.test.ts` (migration, deterministic one-line serialization, every lenient drop counted, every strict-write refusal, the incremental save path, staged loading equal to the full parse, future version, deep freeze) | | | |
| v9 data kept by every copy path: duplicate page, page restore (replace, insert), page trash (with and without an id clash), *Move to notebook…*, clipboard copy/paste, templates (save, page, notebook), margins (left margin shift), repair (damaged lines; damaged fields keep the valid parts), conflicted-copy merge (graphs compared by their nested content; the same LaTeX with another cached outline is the same equation) | ✅ | ✅ `tests/model-v9.test.ts` | | | |
| Equations (#110): *Insert equation* (All actions → Insert, command), in-place editor with live MathJax preview, palette (fraction, roots, power, subscript, matrix, integral, sum, limit, system, lines aligned on =), display or inline, numbering "(n)" in reading order across the notebook, size and colour; size taken from the handwriting nearest to where it is placed (median letter height of `ink/words.ts`) | ✅ | ✅ size from handwriting, snippets, numbering order, bounds and transforms (outline scales with the box); ❌ the editor, MathJax in Obsidian | | ✅ | typesetting traces a raster of MathJax's output (Obsidian ships its HTML output, not SVG): the outline is exact to about 1/16 pt, not the font's own curves. Not run in Obsidian by the developer tooling (steps 233-237) |
| Equations drawn from a cached vector outline (canvas, PDF and SVG exports as filled vector paths, even-odd rule); without an outline the canvas shows the LaTeX source until it is typeset in the background, exports typeset first and fall back to the source as text | ✅ | ✅ outline grammar (format, parse, reject, scale), tracing a raster with a hole, SVG and PDF output; ❌ on screen in Obsidian | | ✅ | step 238 |
| *Convert to ink* (selected equations): the glyphs become constant-width strokes along their middle, as wide as the glyph strokes, in the equation's colour; one undo step | ✅ | ✅ `outlineToInk` (a bar becomes one stroke of its width along its middle; a ring becomes strokes on its centre line); ❌ in the view | | ✅ | serifs and very thin parts become short strokes; a glyph may split into several strokes at junctions (step 239) |
| Function graphs (#113): *Insert graph*; cartesian, parametric, polar, implicit and piecewise functions written as expressions; parameters with sliders; roots, maxima and minima, intersections (marked and labelled), tangent at x, shaded area with its value, table of values; axes, grid, labels, steps, degrees or radians; live preview while editing, one undo step for the whole panel session | ✅ | ✅ `tests/math-expr.test.ts` (grammar, precedence, implicit multiplication, degrees, conditions, errors with position, safety: no globals, no property access, depth and length limits), `tests/math-graph.test.ts` (adaptive sampling within tolerance, poles of tan and 1/x, jumps of floor, steep cube root, undefined ranges, parametric, polar, implicit circle, poles of implicit curves, clipping, roots incl. touching ones and not at poles, extrema, intersections, derivative, integrals, the scene); ❌ the panel in Obsidian | | ✅ | steps 240-245 |
| Pan and zoom inside a graph while its panel is open (drag, pinch, wheel; Shift x only, Alt y only; buttons in the panel); ink written on the graph keeps its graph coordinates (moved with the view, pen width kept); moving or scaling the frame with the lasso carries the ink as before | ✅ | ✅ `graphViewMatrix`, `panView`, `zoomView`, one undo step with the ink, undo restores both | | ✅ | ink pushed outside the frame by a zoom stays where it lands and no longer belongs to the graph (ownership is geometric, see *Ink follows objects*); step 243 |
| Layer order (#357): *To front*, *To back* in the contextual bar of a selection (ranked by priority: they fit the bar on a tablet), *Forward* and *Backward* in the All actions sheet; all four are commands. Strokes reorder among strokes, elements among elements of the same kind (images < boxes < text boxes, under the ink; markers above it); a mixed selection moves both groups in one undo step; forward and backward step past the nearest overlapping item; the selection is released afterwards so the new order is visible; no format change (the order is the array order) | ✅ | ✅ `tests/text-objects.test.ts`: front / back / forward / backward (groups keep their order, kinds, overlap rule, no-op is null), `ReorderLayer` undo / redo and a stale list, strokes + elements in one `Batch`, round trip through the file; ❌ the buttons, the visual result, pen and finger | | | steps 257-259; ink never goes above or below elements, and elements never change kind order, by design |
| Find and replace in text boxes (#361; All actions sheet, command): find, replace with, match case, whole word, results with page and snippet (tap to show the page, arrow to show it and close the panel), *Replace* for the chosen result, *Replace all*; handwriting, marker labels and box titles are not searched | ✅ | ✅ literal matching (no patterns, `$` kept), case, whole word with accents, results in reading order, cap of 500 listed results with the full count, replace all as one undo step (same objects back on undo), one match, next match after a replacement that contains the query, stale hit refused, empty text box kept; ❌ the panel, jumping to the page, touch | | | steps 260-262; no regular expressions |
| Page information (#379; page sheet, command *Page information*): size and preset, paper, background, ink (strokes by tool, points, invisible), objects, files (distinct files and their size), tags, bookmark with title and category, markers (open of total, by kind), notebook created / saved, and when this device last edited the page | ✅ | ✅ counts, files counted once and files the notebook does not list, bookmark details, empty page, dates, custom size and landscape preset; ❌ the panel and its text | | | step 263; a page has no dates of its own in the file, and the device log keeps 100 pages |
| Page offered in the middle of a notebook (#389; extends #95): writing in the bottom tenth of a page that is not the last, with *Add a page when writing at the bottom* on, shows a chip *Add a page after this one*; one tap inserts a page right after it (same size and paper, one undo step, scrolled to); never automatic; the chip hides when the pen goes down again, after 9 s, on a page change or undo, and is not offered again for that page | ✅ | ✅ `needsPageOffer` (the exact complement of the automatic append, setting, infinite and background pages), `OfferGate`; ❌ the chip, its position over the writing area, touch | | ✅ | step 264; check that the chip never gets in the way of writing |
| Export choices (roadmap 381, wave 0.9): *Export…* dialog (page sheet, All actions, notebook menu, command): PDF or SVG, this page or the whole notebook, ink and background / ink only / background only; a notebook as SVG is one file per page; file names carry the choice; existing files are never replaced; hidden ink follows the solutions rule | ✅ | ✅ `tests/export-view.test.ts`: layer flags and file names, the export plan, SVG and PDF with each choice (no sheet or paper for ink only, no ink for background only, `both` identical to the old output, images by layer, hidden ink); ❌ dialog, writing into a vault, large notebooks | | | steps 265-267 |
| Export as Markdown with page images (roadmap 382, wave 0.9): vault folder and 100 / 150 / 200 dpi; `page-001.png`… drawn on a canvas like the PDF export, then `notebook.md` (title, page images, text boxes as text in reading order, bookmarks as headings); unique names, never overwrites | ✅ | ✅ Markdown text (title, bookmarks with and without title, escaping of user text, link targets), file names (three digits, never an existing name, names already chosen in the same export), render size and caps; ❌ canvas drawing of pages, PNG encoding, writing through the vault, a Markdown viewer outside Obsidian | | ✅ | steps 268-270; PNG rendering of PDF and picture backgrounds depends on pdf.js and the WebView |
| Night mode (roadmap 367, wave 0.9): dark page with light ink at render time (paper, paper lines, ink, text boxes, live and wet ink, highlighter with a screen blend, backgrounds dimmed); a view setting and a toggle (All actions, command); stored colours, exports and thumbnails unchanged | ✅ | ✅ colour mapping (near-black becomes light, hue kept, contrast at least 4.5:1 for a palette of 12 inks, translucency kept, unknown colours untouched, highlighter band, dim paper lines), settings defaults; ❌ canvas drawing, wet-ink highlighter blend in CSS, legibility on a real screen | | ✅ | step 271; the look of the colours is a judgement that needs real screens |
| Crop PDF margins (roadmap 376, wave 0.9): content box of each PDF page from a ~100 px render, cached for the session; the view fits the box (widened by the ink) to the width in continuous and page-by-page mode; toggle on the PDF contextual bar, in All actions and as a command; view-only | ✅ | ✅ content-box detection on synthetic bitmaps (bounds, padding, speck and grey noise ignored, transparent pixels, blank page, minimum size), window of a page with margins and with ink in the margin, fit and pan clamp with a window, layout windows (union, dropped when useless), page-by-page fit; ❌ the measuring render with pdf.js, re-layout while pages are measured, use on a phone | | ✅ | steps 272-274; only side margins are cropped; continuous mode crops only when every page is a measured PDF page |
| Rectangle selection (#63): the lasso's second shape; toggle on the lasso bar, in the lasso's tool options and in the sheet, command; drag from corner to corner, selects what a lasso of that outline selects; a tap picks the object under it; invisible ink stays out unless the solutions are shown | ✅ | ✅ `rectanglePolygon` (any drag direction, flat box selects nothing, same strokes as a lasso of the outline, hidden ink withheld by the caller); the toggle and the bar in the browser harness; ❌ pen and finger on a device | | | steps 295-297; same 50 % rule as the lasso (a stroke is in when half its points are), not "touching the box" |
| Select by colour or tool (#64): *Select similar* (same colour, same tool, picker) on the selection bar; the picker of tools, colours and tool-colour pairs with counts on the lasso bar, the sheet and as a command; colour also takes text boxes, tool takes strokes only; the result replaces the selection | ✅ | ✅ `selectSimilar`, `selectByStyle`, `styleCatalog` (letter case of colours, several seeds, pairs, hidden ink withheld by the caller); the menu, the picker and the result in the browser harness; ❌ on a device | | | steps 298-300 |
| Align and distribute (#38): six aligns and two distributes, as a menu on the selection bar and as sheet entries and commands; items are elements and clusters of strokes (6 pt); rigid moves; ink on a selected picture goes with it; one undo step | ✅ | ✅ `clusterStrokes`, `alignItems`, `alignPlacement`, `distributePlacement` (edges and centres, equal gaps, ends kept, pictures and ink together, ink follows objects, aligned twice is a no-op, one undo step, checked writer); the menu in the browser harness; ❌ on a device | | | steps 301-304; the 6 pt grouping is a heuristic (`GROUP_GAP`): two words closer than that move together |
| Rotate 90°, mirror, exact size (#65): clockwise / anticlockwise, left-right / top-bottom, a size panel (W × H pt, keep proportions, top-left kept); applied to the points in page coordinates, pressure kept; pictures turn, mirrored pictures / text / equations / graphs are moved but not flipped; one undo step each | ✅ | ✅ `rotate90Matrix` (exact, four turns are the identity), `mirrorPlacement` (twice is the identity, ink on a picture translated with it), `sizeMatrix` (strokes, pictures and boxes reach the size, top-left kept, limits, bad input), `lockedSize`, `applyPlacement` (identity skipped, undo / redo, checked writer); the panel and the results in the browser harness; ❌ on a device | | ✅ | steps 305-308; the size includes the stroke thickness, text boxes and equations scale in proportion only; no flipped pictures (the format has no flip field, by design: no format change) |
| Quick date and time stamp (roadmap 356, wave 0.10): *Date and time stamp* (All actions sheet, command) inserts a text box with the date and time at the place the pen last touched a page (within the last 5 minutes; otherwise the middle of the page in view), sized to the text and kept inside the page; format set in the settings (tokens YYYY MM DD HH hh mm ss A MMMM dddd, literal text in [brackets], month and weekday names in Obsidian's language); one undo step; the box is selected afterwards | ✅ | ✅ `tests/date-stamp.test.ts` (format, tokens, 12 hour clock, language, fall back to the default, placement, one undo step, valid document); ❌ the action, the pen position and the settings field | | ✅ | steps 281-283 |
| Lasso selection across page boundaries (roadmap 359, wave 0.10): a lasso that reaches into another page selects the ink and the elements inside it on every page it touches; one frame (the first page with something selected) for the frame, handles and drag; move, scale, rotate, delete, restyle, copy, cut, duplicate, layer order and *Save as stamp* work on the whole selection; after a move every item belongs to the page under its centre (re-parented, ids kept; items outside every page stay on their own page), as one undo step; a lasso inside one page behaves as before | ✅ | ✅ `tests/cross-page.test.ts` (frames, pages touched, selection on both pages, bounds, move without and with re-parenting and one undo step, undo order of several removals, text boxes, copy in one frame); ❌ the lasso, the drag and the floating drawing over the gap between pages (renderer), restyle and duplicate on the view | | ✅ | steps 284-288 |
| Cross-device clipboard (roadmap 362, wave 0.10): *Copy to other devices* writes the selection (strokes, elements, picture records; the pictures themselves are already in `_assets`) to this device's `_meta/clipboard-<device>.json` (last 5 copies, 3 MB cap); *Paste from another device…* lists the other devices' copies newest first (what, how long ago, which device) and pastes the chosen one with new ids; written only by the copy action; this device's file is never overwritten when it is unreadable, empty or from a newer version (a copy is kept and the copy refused); other devices' files are only read | ✅ | ✅ `tests/shared-clip.test.ts` (entry round trip, new ids, file parse and unknown entries, entry and size limits, store: create, list, never overwrite unreadable / empty / future files, too large, skipped unreadable files); ❌ the actions, the list and pasting pictures (needs two devices and a synced vault) | | ✅ | steps 289-294 |
| Pinned notebooks, archive and manual order (roadmap 54, wave 0.10): *Pin to the top* (a *Pinned* group above the rest), *Archive* / *Restore from the archive* (hidden from every view, count, tag list and search; an *Archived* entry in the sidebar), sort *Manual order* with drag onto a card and *Move up* / *Move down*; kept per device in `_meta/library-<device>.json`, keyed by document id; no notebook file is moved, renamed or written | ✅ | ✅ `tests/library-state.test.ts` (file format round trip, refusals, merge per field with last writer wins and a tie to the larger device id, a later time than the one read so a slow clock still wins, no-op changes not written, rank order, move planning including a 400-move random series and no-room fallback, the store: only its own file, two devices, unreadable / empty / newer own file never overwritten, other devices' bad files skipped, vault root; index filter, archived scope, manual sort, ids; files that share a document id: the original keeps the id key, a sync conflict copy is keyed by id and path and is not hidden by the original's archive); ❌ the view (cards, menus, drag, sidebar), touch, two real devices syncing | | ✅ | steps 335-342; not verified with a real sync service; a notebook whose id could not be read is keyed by path |
| Library check (roadmap 27, wave 0.10): unreadable notebooks listed only, newer-version and not-downloaded notebooks apart, unused files in `_assets` with the space they take, files kept by backups / trash / templates / stamps / `_meta` reported apart. A file is offered only if an earlier check on this device, at least a day before, also found it unused (a per-device record in `_meta/library-check-<device>.json`, never the file's modification time) and nothing open uses it (open notebooks' documents, undo and redo history and pending media, and the instant-save journal; read again right before moving); nothing is offered while a notebook is unreadable or not downloaded, a backup is cut off or does not parse, or an open view or the journal cannot be inspected. After a confirmation the files are moved (a rename, never a delete) to `<notebooks folder>/_trash/assets/` | ✅ | ✅ `tests/library-check.test.ts`, `tests/library-check-live.test.ts` (asset file names, notebook classification with the sync-state detection, a notebook anywhere protects its assets, unreadable and cut-off notebooks make the answer unsure, online-only / empty / NUL notebooks never unreadable, empty and recent assets not judged, the first-seen record: first sighting not offered whatever the mtime says, a day later offered, used in between starts again, record unreadable or missing offers nothing and is never overwritten, open notebooks / journal / undo history / pending media protect, an inspection that fails makes it incomplete, holders must be whole JSON, the record's own file is no reference; move: only confirmed and still-unused files, the check repeated, open notebooks asked again right before moving, changed size, not downloaded, forged paths, name collisions, failures); ❌ the dialogs, the real rename, a real online-only vault, two real devices | | ✅ | steps 343-349; reading version history and backups on a very large library is slow (only when something is left to judge) |
| Read-only mode (roadmap 51, wave 0.10): per-view switch (All actions, command, the lock button in the toolbar); the pen, finger and mouse change nothing, no tool, undo or redo, no insert or page operation; pan, zoom, page panel, links and exports keep working; nothing is written or backed up; the mode ends with the notebook | ✅ | ✅ `tests/readonly-print.test.ts`: the locked history runs, undoes and redoes nothing, registry action, command, enabled and checked states; harness scenario `readonly` (pen, finger and mouse leave the page unchanged, undo and commands refused, no vault write, indicator, toolbar fit); ❌ real pen, palm, sync | | ✅ | steps 350-356 |
| Export pages as PNG images (roadmap 81, wave 0.10): *Export…* with PNG images, or *Export pages as PNG images…* (sheet, notebook menu, command): vault folder (created when missing), scale 1x to 4x, whole notebook, this page or typed pages (1-3, 5, 8-), ink and/or background (ink only is transparent); `page-003.png` keeps the real page number; never replaces a file | ✅ | ✅ `tests/readonly-print.test.ts`: page ranges, export plans, file names, scales and size caps; harness scenario `readonly` (dialog, refused range, written PNG files and sizes, ink-only transparency, no overwrite); ❌ phones with big notebooks | | ✅ | steps 357-359, 363 |
| Page range for PDF and SVG (roadmap 81, wave 0.10): *Some pages…* in the *Export…* dialog for every format; a PDF of a range is named `Name p2-4.pdf` | ✅ | ✅ `tests/readonly-print.test.ts` (plans and names) | | ✅ | step 359 |
| Print (roadmap 81, wave 0.10): desktop only; the chosen pages are drawn to images in a print-only container and the system print dialog opens (one page per sheet; a very long page flows over sheets); hidden on devices without a print dialog | ✅ | ✅ harness scenario `readonly` (container, decoded images, removed after, hidden on a phone and tablet, not listed there); `tests/readonly-print.test.ts` (registry); ❌ the real print dialog and printers | | ✅ | steps 360-362; the print rules no longer use `!important` (Scorecard): step 360 must show no app interface on the sheet |
| Format v10 (anchored excerpts, #105): `excerpt` element (target frame, source notebook path, document id, stable page id, source region, optional snapshot asset); v9 → v10 migration (v9 files read unchanged; a pre-v10 file with an excerpt is rejected); lenient read (an invalid excerpt is dropped and counted, an invalid snapshot reference only loses the snapshot; also in staged loading); strict write and history guard; a newer version opens read-only | ✅ | ✅ `tests/model-v10.test.ts` (migration, one-line serialization, every lenient drop counted, strict-write refusals, incremental save path, history guard accept/refuse, staged loading, future version, freeze) | | ✅ | |
| Excerpt data kept by every copy path (duplicate page, page restore, page trash, *Move to notebook…*, clipboard with the snapshot renamed when stored again, stamps, templates, merge with the snapshot not counted as content, repair keeping the anchor) and counted by page information and the heavy-page load | ✅ | ✅ `tests/model-v10.test.ts` | | ✅ | |
| *Excerpt to page…* and *Copy as excerpt* (selection bar, lasso bar with nothing selected, All actions → Insert, commands): region from the selection or from the next drag, PNG snapshot asset, go-to-page picker (this page, next page, a new page, number or bookmark), one undo step; paste in another notebook | ✅ | ✅ harness `doc=excerpt` (region drag, picker, new page, snapshot asset, check before writing, selection, undo); registry and layout tests; ❌ copy and paste across notebooks in Obsidian | | ✅ | steps 384-390, 396 |
| Excerpt drawing: live from a page of the same notebook (throttled while editing), snapshot otherwise and in exports, thumbnails and the Markdown page images; placeholder without either; badge on the top-right corner (grey when the source page is gone) | ✅ | ✅ harness (live picture, badge drawn); pure geometry in `tests/model-v10.test.ts` | | ✅ | steps 391-394, 400 |
| Jump back: a tap on the badge (any tool but lasso and eraser) or *Go to source*: same notebook scrolls to the page by id and outlines the region; another notebook opens at the page id with the region outlined; a missing page or notebook gives "Source not found" and changes nothing | ✅ | ✅ harness (tap jumps to the source page and writes no ink); `excerptSourceState` tests; ❌ opening another notebook (needs Obsidian) | | ✅ | steps 395, 397-399, 401-403 |
| Home (0.12, DESIGN.md §4): a view of its own (*Open Notebook home*, ribbon, rail) on the library's data; page header with search pill and inbox bell; *Subject folders* (one card per top-level folder under the notebooks folder: colour, glossy folder icon, generated art, notebooks count); *Recent notes* (this device's recently edited pages, else recently changed notebooks; subject and tag pills; kebab = the notebook menu); *Statistics* over 1 / 4 / 12 weeks (notebooks created with the change against the period before, pages edited on this device, PDF notebooks changed, tags used; sparkline); *Quick actions* (New notebook and New folder through the registry actions `new-notebook` / `new-folder`, Import PDF, Scan) | ✅ | ✅ `tests/dashboard.test.ts` (subjects, collections, statistics, times); ✅ harness `doc=library&surface=home` at 1448 × 1086, 800 and 412 px, dark and light: sections, 40 px targets, no sideways scroll, quick actions run the registry | | | Writing time is not counted (no counter exists): *Pages edited* stands in |
| Library rebuilt on the design system (0.12): navigation rail (Home, Notebooks, PDF when a PDF notebook exists, Tags, Settings, the folder tree with subject-coloured folders, Archive, Trash, Check library; icons only on a tablet in portrait, a sheet on a phone); header with search, tag filter, sort, grid / list and *New*; filter chips (All, Subjects, Recent, Favourites, With PDF, Archive); subject cards; smart collections (To study, Favourites, With PDF, Recent, Exams; empty ones hidden); frequent tags; recent and favourite notebooks (page thumbnails, star); the grid of all notebooks (60 at a time, *Show more*); search grouped as folders, tags and notebooks | ✅ | ✅ `tests/dashboard.test.ts`; ✅ harness `doc=library&surface=library` (sections, chips, collections, thumbnails, star writes the file, search groups, list mode, rail) | | | Pin, archive, manual order, drag and drop, move, rename, delete keep their 0.10 code paths; not re-verified in Obsidian |
| Inbox bell (0.12): bell in the Home and library headers with the number of Inbox items to process (badge hidden at 0); popover (sheet on a phone) with the first eight items (kind, first line, notebook, time), each with Open in notebook, Process in the inbox, Discard; *Open inbox* | ✅ | ✅ harness: badge count, popover rows, *Open inbox* | | | The count comes from the Inbox's scan, run once the library has been read and when the bell opens (at most every two minutes) |
| Zettelkasten surfaces on the design system (0.13 ds-zettel, DESIGN.md §3-§5): Inbox page (header with count and art band, source chips with counts, *Show processed* toggle, one panel per notebook in its subject colour, expandable item rows, phone layout, skeleton while scanning, empty and *All caught up* states with *Show processed* / *Show all sources* / look again); *Make card* dialog (type tiles, tag preview, Enter / Escape); card-list picker (id, title, where, orphans); slip-box confirmation | ✅ | ✅ harness `doc=zettel` (layout, 40 px targets, every control, both themes, tablet and phone) | | | Behaviour is unchanged from 0.8 / 0.6. Not seen on the tablet: the art band and the illustration depend on the WebView's canvas. |
| Design tokens (0.12, DESIGN.md §2): `--nb-*` palette for dark and light, *Follow Obsidian theme* on `body.notebook-style-obsidian`; components in `src/ui/components/` | ✅ | ✅ `tests/styles.test.ts` (well-formed CSS) | | | The *Appearance → Style* setting that adds the class is not part of this change |
| 0.13 home2: Home's revised structure (greeting with the "Your name" setting; Continue row: lecture in progress from the timetable with its linked notebook or course folder, a button to start a notebook when there is none, else the last notebook; Quick page card; low quick actions with tooltips; three-column folder grid ending in the dashed New folder card; recent notes grouped by notebook with page thumbnails, a ⋯ menu and a subject filter; statistics widgets: pages per day (7 / 14), streak, estimated writing time, PDF hint, subject split) | ✅ | ✅ unit tests (`tests/home-greeting.test.ts`, `tests/home-stats.test.ts`, `tests/home-pins.test.ts`) for the greeting, activity log, pages per day, streak, subject split, writing time, grouping, the Continue choice and Quick page logic; ✅ harness (`dev/harness/home2-check.ts`, `harness:check`) at tablet portrait / landscape and phone, dark and light, with the lecture, a class without notebook and no class, the empty and the hostile vault | | ✅ | Page thumbnails are drawn from the notebook file on demand; writing time is an estimate (minutes with an edit, this device only); not run on Android hardware |
| 0.14 sections (roadmap 415): dynamic sections **Now** (class in progress, notebooks open in a tab, notebooks edited on this device in the last 4 hours), **To complete** (open gap / question / homework markers, skipped pages, PDF slides without ink, practice copies not yet written) and **Changed on another device** (file newer than what this device has seen and not written here; per-device seen record in local storage, *Mark as seen*), as dashboard panels in the library, places with the usual grid, sidebar items with counts and shortcut chips on Home; each hides when empty | ✅ | ✅ `tests/dynamic-sections.test.ts` (rules, seen record, index field `emptyPages`); ✅ harness (`dev/harness/sections-check.ts`, `harness:check`) at tablet and phone, dark and light | | ✅ | The file time of a notebook is the one of the device that wrote it (kept by Google Drive and OneDrive); "written here" is judged from the recent pages log (30 s slack). Index entries read before 0.14 get `emptyPages` when their file next changes or the library check re-reads them; not run on Android hardware |
| 0.13 home2: sidebar Pinned section (notebooks and folders, pin from ⋯ menus and Recent notes) and pages next to the notebook count | ✅ | ✅ `tests/home-pins.test.ts` (folder `pinned` field: merge, rename, store) and the harness (pin from Recent notes and a folder menu, open on tap, unpin) | | ✅ | Pinned folders are a new field of the folder metadata sidecar (`folders-<device>.json`); an older plugin version ignores it |
| 0.15 daily (roadmap O12): *Today's page* command, Home quick action open the daily notebook (setting; made the first time after a confirmation) at the page whose header is today's date (`YYYY-MM-DD`, the lecture-header text), adding it when missing and never twice; optional *Link from the daily note* (off) appends a link to the page at the end of today's daily note once, through `vault.process`, reading the folder and format from Periodic Notes or the Daily notes core plugin (with a notice when neither is on); *Create the daily note if missing* (off) | ✅ | ✅ unit tests (`tests/daily.test.ts`: path, dated-page lookup, no duplicate page, link insertion idempotence, settings); ✅ harness (`dev/harness/daily-check.ts`, `harness:check`) against the stub vault: link once, rest of the note intact, missing note, Periodic Notes first, no plugin, the confirmation dialog | | ✅ | The daily-notes settings are read through Obsidian's internal plugin objects (not a public API); not run in Obsidian or on Android hardware |

## Automated checks

Numbers from the final run of 0.9.0 (development PC).

| Command | Result |
|---|---|
| `npm test` (unit project only; benchmarks are separate) | 7478 tests passed |
| `npm run lint` | eslint + `tsc --noEmit`: 0 errors; `eslint-plugin-obsidianmd` recommended rules: 0 errors |
| `npm run build` | ok; `check-bundle: ok (requires found: obsidian)` |
| `npm run bench` | ok; numbers below (PC only) |
| `npm run harness:check` | 31 scenarios ok (headless Chrome on Windows; see "Browser harness") |

Added in 0.5.0 (PDF): format v6 (`tests/model-v6.test.ts`: v5→v6 migration, `margins` validation and round trip, future version, `SetPageMargins` / `SetPageSize` with margins / `SetPageBackground` with exact undo, ink kept relative to the PDF), re-published slide matching and the update plan (`tests/republish.test.ts`), pdf.js text boxes, text under a highlight and the annotation note (`tests/annotations.test.ts`).

Added in 0.4.0: format v4 and v5 (round-trip, validation, migrations v3→v4→v5, asset references, duplicate ids), the writing engine (causal geometry equal while writing and after commit, constant work per sample, dirty rectangles, sample de-duplication, 1€ filter, pressure decided at stroke start, saves deferred while writing), shapes, recognition, text layout, elements, ruler and infinite-page geometry, the library (index, queries, folders, search with snippets, host logic, drag), the PDF store and assets (cache, limits, hashing, names), the scanner (detection, perspective, filters), the save journal (slots, torn writes, diffs, per-file and per-session keys, recovery), version history (naming, retention, restore guards), embeds and links (parsing, building, protocol parameters), export with images, and the fixes from the independent reviews (`review-fixes.test.ts`).

Added in M3a: migration v2→v3 (identity plus version, v0 and v1 files still reach v3), all five paper kinds in the round-trip, rejection of unknown kinds and bad spacing, `duplicatePage` (new ids, same content, unique ids in the document), `DeletePage` (order, undo/redo with the same page object, the last page is never deleted), `MovePage` (both directions, edges, clamping, exact undo), `SetPaper` and `SetPageSize` (exact undo, strokes untouched), paper pattern geometry for each kind (ruled first line and 25 mm margin, dots at intersections, millimetre major lines, culling, `includeMinor`), SVG output (size in mm with a pt viewBox, paper on/off, highlighter, escaping, determinism) and PDF output (header and trailer, one page object per page, `xref` offsets, `/Length`, MediaBox, y-flip, colours, ExtGState only with a highlighter, title escaping, two decimals).

Covered by tests: serialization round-trip and determinism, rejection of corrupt files (truncated, garbage, wrong format, bad points/colours/ids, future version), migrations v0→v1 and v1→v2, highlighter round-trip, `serializeChecked` (same output as `serialize`, frozen strokes, duplicate ids, NaN, incremental check equal to the full parse on a large document), undo/redo of adds, erases, `ReplaceStroke`, `AddPage` (never removes the last page) and `Batch`, eraser hit test (including fast movements and dots), segment cutting (including cuts between distant points and no single-point crumbs), lasso selection and selection bounds, affine transforms and stroke transform with width scaling, stabilizer, page layout and visible-page selection, screen↔page transform at 7 zoom levels, fit-width, zoom around a point, pan clamping, palm-rejection routing (time-based and contact size), pressure detection, the deterministic stress document, and the save session (debounce, max wait, no writes on broken/readonly files, conflict backups, echo detection, retry after a failed write, refusal to write a document that fails re-validation, backup-before-overwrite ordering when another writer races the save, no overwrite when the backup fails, external-change checks queued after flushes, close-time retries with an `unsaved` backup, deleted files never written, stale sessions silent).

Export checks outside the unit tests (development PC, not Android): a PDF generated by `pagesToPdf` was parsed with pdf.js (3 pages, Unicode title, fills, stroked paper lines, highlighter ExtGState) and an SVG from `pageToSvg` was rendered with resvg. Neither file was opened on an Android device or in Obsidian.

Independent review (M1): the data-safety code (session, Vault I/O, serializer, view lifecycle, undo) was reviewed by a separate agent that did not write it; its 7 findings (3 medium, 4 low, no corruption) were fixed and covered by the tests above.

Measured on the PC in M1 (not on Android): a 10,000-stroke notebook (268k points) is 6.8 MB; parse 156 ms, serialize 98 ms. In M2 the save check no longer re-parses documents over 1 MB each time. `npm run bench` on the dev PC (Windows, Node 24; 10,000 strokes, 10 pages, 6.69 MB): serialize 153 ms; open (parse + validate) 227 ms; open + first save with a cold cache 424 ms in total; next saves 16–19 ms; eraser hit test 0.04 ms per move (1,000 strokes, cached bounds); segment cut 0.005 ms; lasso over a quarter page 2.4 ms; stroke outline 0.04 ms. **These are PC numbers.** Android will be slower and must be measured with the in-app benchmark (step 21); record those numbers here once available.

Added in 0.4.1: `styles.test.ts` (styles.css has balanced braces, no accidentally nested rules, and keeps the declarations the page layout depends on: the 0.4.0 file failed this), `render-safety.test.ts` (errors logged once per scope, the *Low-latency ink* setting, the wet-canvas context fallback, the pointer controller keeps working after a handler throws and listens to `pointerrawupdate` only when asked), and the browser harness below.

Added in 0.5.0 (companion notes): `companion.test.ts` — the companion note generator (properties, meta pass-through, Obsidian tags, text in reading order, page links, determinism), escaping of text-box text, the generated region (append, replace, Windows line endings, broken markers, stored state), the property merge (owned vs user keys, shared tags, removal only of what the plugin owned, idempotence, timestamps read back as dates), locations and settings.

Not covered automatically: everything that needs Obsidian or a real browser (DOM, canvas, Pointer Events, Vault API, view lifecycle, the toolbar, the page menu and dialogs, the library view, the navigator panel, the scanner camera and crop UI, rendering PDFs with pdf.js, the text editor, writing the export files, selection handles and gestures, the fast path and fling, protocol and Markdown embeds). That is what the manual protocol is for.

Added in wave 0.7 (level of detail and heavy pages): `tests/lod.test.ts` (zoom → level for every pixel ratio from 1 to 3, the simplified shape stays within 0.5 device px of the exact one for perfect-freehand outlines and wet-ink nodes, ring simplification keeps corners, nothing simplified at normal zoom or for short strokes, saved points untouched, SVG paths for thumbnails) and `tests/heavy-page.test.ts` (thresholds are strict, asset bytes counted once per file, PDF background not counted, split plan: cut in the gap near the middle, load-balanced, text boxes and images, strokes crossing the cut, deterministic, no split for backgrounds or a single item, one undo step restores the serialized document exactly). `npm run bench:lod` (PC): frame time scrolling through the 10,000-stroke notebook at 49, 35 and 25 % with the level of detail off and on, and the pixel difference between the two on a page of 1,000 strokes; `-- --check-heavy` runs the banner check in the harness. Measured on the dev PC (desktop Chrome, 1280×800, canvas read back after each frame so rasterization counts; not Android): redraw with strokes cached, off → on, 1x screen: render 1 `52 → 23`, `64 → 27`, `81 → 29` ms at 49, 35, 25 %; render 2 `61 → 37`, `72 → 45`, `91 → 52` ms; 2x screen: render 1 `88 → 51`, `100 → 53`, `114 → 58` ms, render 2 `90 → 72`, `109 → 79`, `130 → 85` ms.

Added in 0.11.0 (format v10, anchored excerpts, #105): `tests/model-v10.test.ts` (v9 → v10 migration, rejection of a pre-v10 excerpt, one-line serialization, lenient drops counted, strict write, incremental save path, history guard, staged loading, future version, every copy path keeping the excerpt and its snapshot, merge, repair, region, placement, badge, source state); harness scenarios `excerpt-light-desktop` and `excerpt-dark-tablet` (`doc=excerpt`: region drag, picker, new page, live picture, badge, jump back, undo).

## Browser harness

A web page that runs the **real** notebook view (renderer, pointer controller, session, toolbar, navigator, `styles.css`) on a minimal stand-in for the `obsidian` module (`dev/harness/obsidian-stub.ts`: views, an in-memory vault, notices, menus, Obsidian's DOM helpers). It is built with esbuild into `dev/harness/dist/` (ignored by git) and never goes into `main.js`. It catches layout, CSS and exception bugs in a real Chromium without a device: the 0.4.0 "black page, nothing draws" bug (stage with zero height) fails it.

**Automatic: `npm run harness:check`.** Needs Chrome, Chromium or Edge (found in the usual install paths, or set `CHROME_PATH`); exits with code 2 if none is found. It builds the harness, serves it on a random local port, starts a headless browser and, over the DevTools protocol, runs these scenarios: an old notebook written by 0.3.0 (format v3, grid paper, pen and highlighter strokes, a second ruled page) and a new empty one, each in the light and dark theme, on a tablet (800×1280 CSS px, device pixel ratio 2, touch), a phone (412×915, DPR 2.625, touch) and a desktop (1280×800, DPR 1), a small phone (360×740, DPR 3) and a phone held sideways (740×360, new notebook only); the *Low-latency ink* setting on (tablet dark, phone light); and injected faults (wet ink throwing on every paint, with and without low latency; one stored stroke that cannot be drawn). The `doc=create` scenarios (tablet and phone, light and dark; wave 0.12) open the creation dialog and run `dev/harness/create-check.ts` instead: both tabs, focus, paper previews, sizes, touch targets, inline name errors, pen / finger / mouse taps, Enter, a notebook created with exactly the chosen settings, a folder created with its metadata, a rename; screenshots `create-<theme>-<device>.png` (Notebook tab) and `create-<theme>-<device>-folder.png` (Folder tab). Two more scenarios (`doc=pdf`, desktop light and narrow dark) open a notebook of three pages that show a fake PDF (`dev/harness/fake-pdf.ts`: a stand-in for pdf.js that draws text lines and reports the same runs) and run the PDF reading checks in `dev/harness/reading-check.ts` instead of the list below: the search finds, lists, marks and steps through matches (case, accents, short query, close), the snapping highlighter replaces strokes over text with one band per line in one undo step and leaves strokes over nothing alone, hiding the annotations removes the ink and blocks editing while a finger still scrolls, and dimming lightens the background without touching the notebook. For each of the other scenarios it checks: the stage fills the leaf; every canvas covers the stage with a backing store of CSS size × DPR; the live and wet canvases let input through; the pen's wet canvas is not translucent or blended; a point in the middle of the stage hits the stage; the paper is painted; a pen stroke (synthetic `pen` PointerEvents with pressure, `pointerrawupdate` before each `pointermove` as Chromium does) is stored and painted and the wet canvas is clear afterwards; a highlighter stroke is stored; the eraser removes a stroke; the page navigator opens and its first thumbnail loads; the toolbar fits the width without sideways overflow with touch targets of at least 40 px, the eraser options popover (mode, filter, colour swatch, size) and the pen options (colour, width) work and keep drawing out of the page (a pen over the popover and a tap outside it write nothing; Escape closes it), the current-pen indicator follows the pen; the *All actions* sheet opens inside the view (a bottom sheet under 600 px), is grouped and searchable, a toggle keeps it open and an action closes it; the page indicator opens the page sheet and a paper chip changes the page (one undo step); the quick slots follow the width; the contextual bar follows the context (none, lasso, selection) and its actions work; the radial dial opens on the side button and its colour, width, pen case, favourites and shapes states choose correctly without drawing; no unexpected console error (an injected fault must be logged once as `[notebook] render …`). Then it takes a screenshot (`dev/harness/dist/shots/<scenario>.png`) and checks the **composited** pixels: white paper where the page is, dark ink where the pen wrote.

**0.12, Home and the library:** `doc=library&surface=home|library` opens Home or the library on a seeded demo vault (four subjects, twelve notebooks, tags, favourites, a PDF notebook, recent page edits, three Inbox items) instead of a notebook; `await harness.checkLibrary()` runs the layout checks, `await harness.interactLibrary()` drives the bell, the rail, the quick actions, the chips, the star, search and list mode, and `harness.libraryState('bell'|'search'|'list'|'reset')` sets a state for a screenshot. `harness:check` runs both surfaces at the size of the reference images (1448 × 1086), tablet portrait and phone, dark and light, and writes `dist/shots/design/<surface>-<theme>-<device>[-bell|-search|-list].png` for comparison with `docs/design/reference/`.

**0.12.3, hostile WebView:** `doc=empty&hostile=1` (Home and the library) deletes built-ins newer than Chrome ~105 and risky canvas APIs (`roundRect`, `reset`, `letterSpacing`, `OffscreenCanvas`, `checkVisibility`, …) and makes the art engine's canvas and every `toDataURL` throw (`dev/harness/hostile.ts`). `harness.checkHostile()` checks that the header with *+ New*, the empty state, the quick actions or chips, the dashed tile, the *Tags* page and both tabs of the creation dialog are drawn without art and without an error card; screenshots `dist/shots/design/hostile-<surface>-<theme>-<device>[-dialog-notebook|-dialog-folder].png`. The stub's `Document.createEl` appends to the document as Obsidian's does (and throws).

**0.12.1, the whole plugin and Obsidian's own CSS:** `doc=plugin` runs the real `NotebookPlugin.onload` on the stub (`dev/harness/plugin-check.ts`). It checks that no step fails and that the settings tab, the three views, the commands and the ribbon icon are registered. It draws the registered settings tab through Obsidian 1.13+'s path (`update()` reads the definitions when the tab is added; `showDeclarative()` draws them) and through `display()`, and checks every section and row. It also injects a failing step, failing settings definitions and an unreadable data.json. `obsidian-base.css` carries Obsidian's real button and text-input rules (same selectors as app.css) and the harness sets `is-mobile` / `is-phone` / `is-tablet` on body for touch scenarios. The library and creation-dialog checks fail when the styled layout is missing (root flex row, rail flex column, grid, tokens) or a button shows Obsidian's default look.

**Repository images:** `harness:check` also renders `dev/harness/banner.html` (the README banner at 1280 × 400 and the social preview at 1280 × 640, dark and light, and the 1600 × 240 low-intensity art band of the roadmap page) into `dist/shots/banner/`, checking the size, the covers and that the text fits (`HARNESS_DOC=banner` runs only those). `npm run harness:media` then copies the banner images and downscales the curated screenshots of the README (Home, library, notebook with the radial dial and its colour and shapes rings, both tabs of the creation dialog, settings, art gallery) into `docs/media/` as PNG or WebP, failing when one is over 400 KB.

**Manual: `npm run harness`**, then open `http://localhost:8377/`. URL parameters: `doc=v3|new|pdf` (`pdf`: three pages of a fake PDF, `await harness.checkReading()` runs the reading checks), `theme=light|dark`, `w=…&h=…` (leaf size in CSS px), `lowLatency=1`, `fault=wet|stroke`, `check=1` (writes the JSON report at the bottom right). Use the browser's device toolbar for a tablet or phone viewport with touch. With `UI_SHOTS=<folder>` set, `npm run harness:check` also saves the main interface states (toolbar, tool options, sheets, selection bar, PDF bar, every radial state) at phone, tablet portrait and landscape and desktop size. From the console: `await harness.openMore()`, `harness.openPageSheet()`, `harness.selectFirstStroke()`, `harness.radialState("color")`, `harness.closeAll()`. Write with the mouse, or from the console: `await harness.penStroke([[0.3, 0.5], [0.7, 0.5]])` (fractions of the stage), `harness.setTool("highlighter")`, `await harness.check()`.

What it cannot show: how the Android WebView and its GPU compose the canvases (a `desynchronized` canvas can be promoted to a hardware overlay there, which desktop Chromium does not do), real S Pen events (timing, coalesced and predicted samples, the eraser button, palm contacts), Obsidian's own CSS, themes and snippets, and the Vault on a device. Those stay in the manual protocol.

## Manual test protocol — Android + S Pen

Setup: install as in [install.md](install.md), enable the plugin, keep the default settings. Optionally connect `chrome://inspect` to watch the console for `[notebook]` errors. Write down device model, Android version and Obsidian version.

For each step note **pass / fail / notes** in the table at the end.

1. **Create and write.** Ribbon → *Open notebooks* → *+ New notebook* → *Create*. Expected: a grid A4 page as wide as the screen, file in `Notebooks/`. Write a few lines of text.
2. **Perceived latency.** Write quickly and slowly, small handwriting and large loops. Expected: ink follows the pen tip without visible lag or gaps; no jagged segments on fast curves. Repeat with *Predicted ink* on (settings; default off) and compare: note whether the tip feels closer to the pen or overshoots at turns and at the end of a stroke.
3. **Pressure.** Draw lines pressing lightly then hard. Expected: visibly thinner/thicker lines. If width does not change, set *Pressure* to *Always simulated* and confirm speed changes the width instead; report which one your device needs.
4. **Hand resting on the screen.** Rest the palm on the screen *before* the pen touches, and while writing; also touch with the palm right after lifting the pen. Expected: no stray marks from the palm; the page may scroll slightly at most. Repeat with *Draw with finger* on: a palm touching before the pen may start a mark, which must disappear when the pen touches down.
5. **Pinch/zoom and scroll.** One finger: scroll the page. Two fingers: zoom in and out, then write while zoomed. Expected: no ink from fingers, strokes land under the pen at every zoom level, the page never gets lost off screen. *Fit to width* restores the view.
6. **Eraser and undo.** With *Eraser → Whole stroke*, erase a few strokes, swiping fast across several. Undo: they come back in place. Redo: they disappear again. If the S Pen button does anything, note what.
7. **Force close while writing.** Write a stroke, and while the pen is still on the screen (or within 1 s of lifting it) open the recent apps and swipe Obsidian away. Reopen Obsidian and the notebook. Expected: everything written before closing is there, including the stroke that was in progress. Repeat by pressing Home while writing, then closing from recents.
8. **Reopen.** Close the tab, reopen the notebook from *Open notebooks*. Restart Obsidian and reopen. Expected: exactly the same strokes, colours and widths.
9. **Screen rotation.** Rotate to landscape and back while a notebook is open, also right after writing. Expected: the page refits to the new width, the same part of the page stays at the top, nothing is lost, and the status shows *Saved* after a moment.
10. **Many strokes.** Run the command *Create stress-test notebook* (10,000 strokes on 10 pages, written to the notebooks folder) and let it open. Expected: it opens in a few seconds at most; scrolling and zooming stay usable; writing on top of it still feels immediate; saving does not freeze the UI noticeably. Note how it feels and how long opening takes. Alternative from the PC: `node scripts/make-stress-notebook.mjs 5000`, copy `stress.notebook` into the vault and open it (try 2000 / 5000 / 10000 strokes).
11. **Corrupt file.** On the PC create `Notebooks/broken.notebook` containing `{ not json`. Open it on the device. Expected: an error message, no toolbar editing, the file stays unchanged, and a `.bak` copy appears in `Notebooks/_backup/`.
12. **Sync (if used).** Edit the same notebook on two devices without letting them sync, then sync. Expected: one version is shown and the other one is in `Notebooks/_backup/` as a `conflict` backup; nothing is lost.
13. **Multiple pages.** In a new notebook press *Add page* (toolbar) twice, and once from the command palette while the first page is in view. Expected: pages stack vertically with a visible gap, the new page appears after the page in view and the view scrolls to it, the indicator reads `n / total` and follows scrolling. Write on each page, including near the page edges. Undo the *Add page* steps (after undoing the strokes written on them): the pages disappear in reverse order and the last page cannot be removed. Close and reopen: same pages and strokes.
14. **Highlighter.** Choose the highlighter, a colour and each width. Draw over pen text and over the grid. Expected: the text stays readable through the highlighter, the colour looks translucent and darkens the ink below it rather than covering it, the width does not change with pressure. Expected: the stroke looks the same while drawing and after lifting the pen (also where it crosses itself). Reopen the notebook: same look.
15. **Segment eraser.** Choose *Eraser → Segment*. Cut across a long stroke, across several strokes, and in one gesture from the end of one page into the next page. Expected: only the part under the eraser disappears, no stray dots remain, one undo restores everything erased in that gesture. Try a fast swipe and small circles. Switch back to *Whole stroke* and check it still removes entire strokes.
16. **Lasso.** Choose the lasso and draw a loop around some words, then: drag inside the frame to move them; drag the bottom-right handle to resize (uniform); drag the handle above the top edge to rotate; each time undo and redo. Then select again and delete with the toolbar button (on a keyboard also Delete/Backspace), undo. Escape or switching tool clears the selection. Expected: handles are easy to hit with the pen, the selection follows the pen without lag, a stroke is selected only when about half or more of it is inside the loop, and after reopening the transformed strokes are where you left them. Try a selection with 200+ strokes on the stress notebook and note how it feels.
17. **Stabilization.** Write a slow wavy line and a signature at levels 0, 2 (default), 5 and 10. Expected: higher levels smooth tremor when moving slowly; at writing speed the line stays close to the pen (at 10 it trails a little and rounds corners); the line always ends where the pen lifted. Report which level feels right.
18. **Palm contact size.** Settings → *Ignore large touches*: leave at off, then try 30, 50 and 70 px. Rest a palm, a fist edge and a single finger on the screen. Expected: with a suitable value the palm is ignored completely (it does not scroll either) while a finger still scrolls. Report what range works on your device, or that the device reports a constant size (then the setting cannot help).
19. **Fling scrolling.** With one finger, flick the page up and down at different speeds, then touch the screen during the glide. Expected: the page keeps moving after the finger lifts, slows down smoothly and stops at once when touched. Check that a slow drag followed by a pause does not fling.
20. **Performance overlay.** Turn on *Performance overlay* and open the stress-test notebook. Note the readings (frame time, input→frame, redraw ms, strokes and pages drawn) in these situations: idle; writing; one-finger scrolling; pinch zooming in and out; at fit width and at high zoom. While scrolling or zooming the page may look blurred or blank at the edges for a moment and then sharpen (the fast path): note whether that is visible and bothersome.
21. **In-app benchmark.** Command palette → *Run performance benchmark* with a notebook open (the benchmark uses the size of the view). Wait for it to finish and use *Copy results*, then paste the whole output into the notes table below. Run it twice, in portrait and landscape if you can, and once with other apps closed.
22. **Notebook written by 0.1.** Open a notebook created with 0.1.x. Expected: identical strokes. Add a stroke and reopen: it works. Afterwards the file is format v7 and a 0.1.x to 0.5.x plugin would open it read-only (this last point can be checked on the PC).

23. **Paper and page size at creation.** Create a notebook for each paper (*Blank*, *Ruled*, *Grid*, *Dotted*, *Millimetre*) and each size (*A4*, *A5*, *Letter*), with and without *Landscape* (a few combinations are enough: at least one of each paper, one of each size, one landscape). Expected: the page has the right proportions and fits the view width; ruled paper has a first line below a top margin and a red margin line on the left; dotted paper has a dot at each grid intersection; millimetre paper has a darker line every 10 mm and the fine lines fade out when zoomed out and come back when zoomed in; the dialog opens with your last choice, and the same defaults appear in *Settings → Default paper / page size / Landscape by default*. Write on each, including near the edges.
24. **Page menu and undo.** In a notebook with three pages and some ink on each, open the page menu (three-dot button next to *Add page*) and use, one by one: *Duplicate page*; *Move page up* and *down* (disabled at the ends); *Delete page* (disabled with a single page); a different *Paper*; a different *Size*; *Landscape* / *Portrait*. After each, undo and redo. Expected: every action takes effect on the page in view, is a single undo step, and undo restores the exact previous state (order, paper, size, strokes). The duplicate has the same ink and can be edited independently. After shrinking a page (for example A4 to A5) with ink near the bottom: the ink outside is not shown; undo, or enlarging again, brings it back. *Add page* gives a page with the size and paper of the page in view. Close and reopen: same pages, order, papers and sizes.
25. **Export.** From the page menu run *Export page as PDF*, *Export notebook as PDF* and *Export page as SVG* on a notebook with several pages, mixed papers and sizes, a highlighter stroke and some Unicode in the notebook name (for example an accent). Expected: a notice with the path; the files appear next to the notebook (`<name>.pdf`, `<name> p2.pdf`, `<name> p2.svg`); running the same export again creates `… 2` files instead of overwriting. Open the PDF on the device (from the file explorer, or share it to a PDF viewer or another app) and check: page count, page sizes and orientation, paper pattern, ink in the right place and colours, highlighter translucent over the ink, no missing strokes. Note the file size of a page with a lot of ink (the PDF is not compressed) and how long the export takes. Open the SVG in a browser or an image viewer.
26. **0.2 opens a 0.3 file.** Take a notebook saved by 0.3 (for example one with a ruled or dotted page) to a device or vault that still has Notebook 0.2.x, and open it. Expected: it opens read-only with a warning, nothing can be edited, the file is unchanged, and a `.bak` copy appears in `Notebooks/_backup/`. Then open it again with 0.3: normal editing.

27. **Writing engine (S Pen).** With the *Performance overlay* on, in a notebook with a few pages of ink and in the stress-test notebook:
    - Write normal handwriting for a minute, fast and slow. Expected: no lag of the line behind the tip, no "jumps" (the line never snaps to a new shape, at the start, in the middle or when the pen lifts), no hitch at the start of a stroke written right after another (saving waits until the pen rests). The overlay's second line shows an input→paint of a few ms; note the values. Then turn on *Settings → Low-latency ink (experimental)* and repeat: the second line should now show "raw" (pointerrawupdate in use). Note whether the page stays white with the ink visible while writing (the setting is off by default because a low-latency canvas may be composited as an opaque layer on some devices) and whether the latency feels different.
    - Lift the pen in the middle of a fast curve and look closely at the end: it must not change shape or move when the pen lifts.
    - Write a tiny dot (tap) and very short strokes: the dot appears at once.
    - First stroke after opening Obsidian, pressing lightly then hard: the width changes with pressure along the line, without a sudden change in the middle.
    - Highlighter over text, crossing itself: same look while writing and after lifting; no darker spots where it overlaps itself.
    - Pen and highlighter at high zoom and at fit width; pan with a finger while the pen is down if your hand allows it: the ink stays under the pen.
    - Hold still 0.6 s at the end of a rough circle/rectangle/line: it still becomes a clean shape. With the ruler: a stroke started on its edge stays on the edge.
    - Old notebooks (written before this version): strokes look exactly as before; new strokes look like the pen (same weight), and both export to PDF/SVG.
    - Run *Run performance benchmark* and copy the *Writing engine* section into the notes.

28. **Library.** Open the library from the ribbon. Create two folders and three notebooks, one in a folder. Check: sidebar entries (*All notebooks*, *Favourites*, *Recent*, folders, tags), cards with cover, name, page count and date; sort by *Last modified*, *Name* and *Date created*; favourite star; *Edit tags…* (the tag appears in the sidebar and filters); *Cover colour…*; *Rename…*; *Duplicate* (the copy is independent: ink drawn in one does not appear in the other); *Move to folder…* and drag a card onto a folder (with a finger and with the pen); *Delete* (goes to the Obsidian trash); delete an empty folder and try one that is not empty. Write something in a notebook and go back: its cover thumbnail updates. Delete `library-index.json` in the plugin folder, reopen the library: it shows *Indexing…* and rebuilds with the same content. Note how long the first indexing takes with 30+ notebooks.
29. **Library search.** Put text boxes with distinct words in a few pages of different notebooks (step 31). Search for a word in a title, a tag and a text box, with the scope *Everywhere*, *This folder* and *This view*. Expected: matches in all three places, a snippet for text hits, and a text hit opens the notebook at that page.
30. **PDF import and insertion.** *Import PDF as notebook* (library button and command) with a PDF of 10+ pages with text and images, and with one of 100+ pages. Expected: one page per PDF page with the right size and proportions, pages sharp at fit width and after zooming (a blurry image may show for a moment), scrolling stays usable, the cover shows the first page. Write on several PDF pages, close, reopen: ink in place. In a notebook use *Insert PDF after this page* (all, then a range such as 2–3) and *Insert blank page after*. Insert an image with *Insert image as page*. Import the same PDF twice: only one file appears in `Notebooks/_assets/`. Rename or move the PDF notebook: it still works. Delete the asset file from `_assets` (on a copy): the page shows a placeholder with the file name and the ink is kept. Export the notebook as PDF: PDF pages appear as backgrounds under the ink; note file size and time.
31. **Tools: shapes, text, images, ruler, infinite page.** (a) *Shape*: draw a line, an arrow, a rectangle and an ellipse; undo each. (b) With the pen, draw a rough rectangle, circle, line and arrow and hold still 0.6 s: each becomes a clean shape; a handwritten letter held still at the end should stay as written (note false positives and misses). (c) *Text*: place a text box, type with the soft keyboard (including accents), change the size, move it, rotate it with the lasso, undo; reopen: same text. (d) *Image*: insert from the vault and from the device; move, scale, rotate; undo. (e) Lasso a region with ink, a text box and an image together: all move. (f) *Ruler*: place it with two fingers, draw along its edge with the pen, start a stroke on the edge, rotate it; the stroke stays straight. (g) *Infinite page*: turn it on from the page menu, write down to the bottom: the page grows by half a page and writing continues; undo. Export the notebook as PDF and SVG: shapes, text and images are there.
32. **Page navigator.** Open the *Pages panel* in a notebook with 10+ pages (a PDF notebook is good). Expected: thumbnails (with PDF/image backgrounds and ink), tap jumps to the page, drag a thumbnail to reorder (a quick swipe scrolls the list instead), star a page, show only bookmarked pages, undo a reorder. Thumbnails do not refresh while you write. Close and reopen: bookmarks and order are kept.
33. **Scanner.** On the device: *Scan into this notebook* (command and page menu) with a sheet of paper on a table, then a whiteboard or a book page. Expected: the camera or photo picker opens, the corners are placed near the edges of the sheet (or can be dragged to them; the loupe shows the corner), *Original*, *Document* and *Whiteboard* previews differ and look sensible (readable text, no black blobs), *Rotate* and *Retake* work, a second sheet continues the session, *Done* adds the pages after the current one. Then *Insert scan as image* and *New notebook from scan* (command and library). Write on a scanned page, reorder it in the navigator, export the notebook as PDF. Note: quality of detection, time to process a 12 MP photo, any crash or out-of-memory with several sheets.
34. **Journal recovery (force close).** Open a notebook, write 5–10 strokes and, within one second after the last one, swipe Obsidian away from the recent apps (or force stop it in the system settings). Reopen Obsidian and the notebook. Expected: all strokes are there and a notice *Recovered unsaved changes from …* may appear. Repeat while the pen is still down on a stroke and right after *Add page*, a shape and a text box. Variants: do it in a large notebook (the stress test), and with two notebooks open. Then, on a copy, damage the situation: write, force close, edit the notebook file on the PC so it differs from the saved one, reopen: nothing from the journal is applied, a copy appears in `Notebooks/_backup/` and a notice names it. Note which cases lost data, if any.
35. **Version history.** Open and edit a notebook, then check the folder `Notebooks/_backup/history/<document id>/` with a file manager: a `.snapshot` file exists (the default interval is 24 h, so a new snapshot per day; to get several quickly, set *Version history interval* to 1 and move the date of the existing snapshot file's name back on the PC). Add pages and ink, then run the command *Restore a previous version*: the list shows dates and page counts; choose an older one and confirm. Expected: the notebook goes back to that version, the notice names the backup of the previous content (a `.bak` in `_backup`), and the open view refreshes. Try it with unsaved changes in the open notebook (they are saved first), and with a snapshot file of another notebook copied into the folder (it is refused). Set *Versions to keep* to 1 and check that older snapshots go to the trash. Set the interval to 0: no new snapshots.
36. **Embeds and links.** In a Markdown note run *Insert notebook embed* and choose a notebook: a `notebook` code block appears. Switch to reading view and live preview: the page preview is drawn (with PDF background and text boxes if the page has them), at the width of the note. Change `page:` to another page and to a page that does not exist (a clear message). Try `Notebooks/Name.notebook#3` and `[[Name#p3]]`. Write in the notebook and watch the embed refresh. Click the preview: the notebook opens at that page. Build a link `obsidian://notebook?path=Notebooks/Name.notebook&page=3` (add `vault=<name>` if you have several vaults), put it in a note or a QR code or an Android shortcut and open it from outside Obsidian: the notebook opens at page 3. Note which of these do not work on Android.
37. **Page links, native embeds, explorer menu (Obsidian integration).** (a) In a note type `[[Name.notebook#`: a list of the notebook's pages appears (number and first text box); choose one and the link becomes `[[Name.notebook#p3]]`; if the built-in suggester shows instead, note it. Open the link (tap in reading view, long-press or Ctrl-click in editing): the notebook opens at page 3, also when it was already open in another tab. (b) Write `![[Name.notebook#p3]]`: a preview of page 3 appears in reading view and in live preview; tap it and the notebook opens at that page; draw something, return to the note, and the preview refreshes. A `#p99` shows a clear message. (c) In the file explorer long-press a folder → *New notebook here* (dialog, notebook created in that folder); long-press a PDF → *Annotate in Notebook* (a notebook with one page per PDF page in the notebooks folder). (d) In a notebook open the page menu (… on a page) → *Copy link to this page* (paste it in a note: it opens that page), *Insert link into the active note* and *Insert page preview into the active note* (with a note open in another tab in editing mode; in reading view you get a message).
38. **Insert and remove space.** In a notebook with three or four pages of handwriting, choose the tool *Insert or remove space* (vertical arrows). (a) Touch between two lines of text in the middle of page 1 and drag down about 3 cm: a dashed band follows the pen; on lift, everything below the line moves down by that amount and the text above stays; the lines that no longer fit on page 1 appear at the top of page 2, whose own content moved down too. Undo: everything is back, in one step. (b) Do the same on the last page with ink near the bottom: a new page is created (same size and paper); undo removes it. (c) Touch in a gap and drag up: the content below moves up and stops when it reaches the ink above, however far you drag. (d) Touch below the last ink of the last page and drag: a notice says there is nothing to move, nothing changes. (e) Insert, then remove the same amount: positions return to what they were. (f) On an infinite page the page grows instead. (g) In an imported PDF notebook, insert space on a slide with notes near its bottom: the overflow goes to a new blank page after that slide, the next slide's notes do not move; removing space never pulls notes from the next slide. While dragging, the content below the line follows the pen (down to the amount that can really be removed). Text boxes and images below the line move with the ink. Try with a finger (setting *Draw with finger*) and with the S Pen. Note any stroke that crosses the line (it moves with the part where its centre is).
39. **Automatic next page.** In a new one-page notebook write along the bottom edge of the page (the last tenth). Expected: when the pen lifts, a new page of the same size and paper appears below; undo removes the stroke and the page together. Keep writing on the first page: no more pages are added (only the last page triggers it). Turn off *Add a page when writing at the bottom* in the settings: no page is added. On an infinite page and on an imported PDF page nothing is added.
40. **Selective eraser.** Write with pen in two colours, draw a few shapes and highlight over some text. With *Eraser*, choose *Highlighter only*: erase across text and highlights (whole stroke, then segment): only the highlighter goes. Then *Pen only*, then *One colour* (pick a swatch): only that ink goes. *All ink* brings back the old behaviour. Undo each gesture.
41. **Erase area.** Eraser → *Area*. Draw a loop around some words and some highlighter, lift: everything inside is gone in one undo step; a stroke crossing the loop is cut at the line. Combine with *Pen only* or *One colour*. With a text box and an image inside the loop: they stay; turn on *Erase area also removes text and images* in the settings: they go with the ink, one undo brings everything back. Draw a very small loop: nothing happens.
42. **Instant board shot.** In a notebook with some writing on the page in view, tap the camera button in the toolbar (also: command *Instant board shot*). Expected: the in-app camera opens (if the WebView refuses it, the camera app opens); after the shutter the photo appears with no further question, cropped to the board when an outline is found (otherwise whole, with a notice) and with the whiteboard filter, below your last line, with a small "Board HH:MM" label above it. One undo removes the photo and the label together. Repeat on an empty page, on a page written down to the bottom (the photo is scaled down; on an *infinite* page the page grows), and with the page zoomed in. Photograph a real whiteboard and a window or screen to see how the crop behaves. Note the time from the shutter to the photo on the page.
43. **New lecture.** Command *New lecture* (or page menu → *New lecture…*). Expected: a small dialog with the notebook name as course/title and today's date; *Add page* adds a page at the end with "Title — YYYY-MM-DD" at the top, same size and paper as the last page, and scrolls to it; one undo removes it. Cancel adds nothing. An invalid date is refused. The header is found by the library search.
44. **Loose sheet and Move to notebook.** Ribbon icon with the sticky note, command *Open loose sheet (quick notes)* and the library button: the first time a notebook *Quick notes* is created in the notebooks folder (or at the path set in *Loose sheet location*) and opened; afterwards the same one. Write on two pages. Page menu → *Move to notebook…*: tick pages, choose another notebook, *Move*. Expected: a notice; the pages are at the end of the other notebook (open it: all ink, text boxes, images and PDF/photo backgrounds are there); they are gone from the loose sheet (a blank page remains if all moved); undo in the target removes them there, undo in the source brings them back. Try with the target notebook open in another tab and closed; check that nothing is lost if you keep writing in the source while the dialog is open.
45. **Edge rejection.** Settings → *Edge rejection zones* on, width 24, left/right/bottom on. Rest the side of your palm on the left, right and bottom edge of the page area while writing with the S Pen: nothing is drawn and the page does not scroll. Then touch in the middle with one finger and drag: it still scrolls; start a two-finger pinch in the middle: it still zooms. Turn the top edge on and check that a touch at the very top of the page area is ignored. Raise the width to 80 and check the zone grows. Turn the setting off: touches near the edge scroll again. The pen must write right up to the edges in every case. Note whether the zone width in CSS px matches where your palm lands.
46. **Radial menu.** Settings → *Pen side button* = *Radial menu*. Hover the S Pen over the page and press the side button: a ring with pen, highlighter, eraser, lasso, undo and three colour dots appears around the nib (try near the screen corners: it stays fully visible). Move the pen over a sector (it lights up and its name shows in the middle) and lift/tap: the tool changes and the ring closes, with no stroke on the page. Also try: pressing the button while touching the screen (a ring opens, no stroke); releasing the button while the pen is over a sector; tapping outside the ring or pressing Escape (closes, nothing changes); the undo sector (greyed out when there is nothing to undo); picking a colour dot and writing in it; the order of the colours after using several. Set the action to *Erase while held*: holding the button and dragging erases. Set it to *Nothing*: the button does nothing (a stroke started with the button held draws as before). The eraser end of the pen must still erase in all three modes. Note exactly what the S Pen reports for its button (with the performance overlay or `chrome://inspect`: `button` and `buttons` on hover and on contact).
47. **Instant start.** Open a notebook, scroll to page 5, wait 2 s, force-stop Obsidian from Android settings, reopen it: the notebook opens on page 5 (note whether it does, and how long the page takes to appear on a notebook with several hundred strokes per page and on the stress-test notebook). Run *Continue last notebook* from another tab: it opens the notebook that was open last on its page. With a notebook that was deleted since: a clear notice. Open a big notebook for the first time in a session and write immediately: the first stroke must not stutter; check that a version-history snapshot still appears (step 35). Record the time from tapping the notebook to seeing ink on screen.
48. **Words and lines (lasso double / triple tap).** Write 6–8 lines of handwriting (normal size, then some smaller and a larger heading, a few slanted lines, words with descenders such as g, y, p on one line and tall letters such as l, b, d on the next, i-dots and full stops). Choose the lasso tool. Double-tap a word with the finger (and again with the S Pen): the word is framed and nothing else; move it, undo. Triple-tap: the whole line is selected; recolour or delete it, undo. Double-tap in the gap between two words and just beside a word (within a fingertip): the nearest word. Double-tap while another word is already selected (inside its frame): the new word is selected, nothing moves. Double-tap blank paper: nothing. Check that no dot or stroke is left in the notebook after any of this (undo history stays empty), and that panning with one finger and pinch-zooming with the lasso tool still work. Note: words split in the wrong place or merged, lines merged with a neighbour, taps that count as a single tap (too slow) or as a triple by mistake, any delay on a page with thousands of strokes (the stress-test notebook).
49. **Selection: restyle, copy, paste, white to transparent.** (a) Write a few words in two colours, lasso them: the bar over the bottom of the page appears. Tap a colour and a width: the strokes change as one step; undo and redo. Select a highlighter stroke together with pen strokes: the pen rows change only the pen strokes and the highlighter row only the highlighter. (b) *Duplicate*: a copy appears slightly down-right and is selected; drag it away, undo twice. (c) *Copy*, go to another page (or another notebook from the library), switch to the lasso and tap *Paste*: the copy lands in the middle of the view, selected; paste again: it lands a little further. Do it with a selection that contains an image and a text box, into another notebook: the image shows there and the notebook still opens after closing and reopening it. (d) *Cut*: the selection disappears; undo brings it back; paste it elsewhere. (e) Copy an image from the gallery or a screenshot, then *Paste*: if the device allows it the picture appears as an image; if a box opens, press and hold in it and choose Paste. Copy some text in another app and paste it: it becomes a text box. A HEIC photo gives the same message as *Insert image*. (f) Select a pasted screenshot or a picture on white and tap *Make white transparent*: the white disappears and the paper (and a PDF page under it) shows through; undo brings the white back. Note on a 12 MP+ photo how long it takes. With a keyboard: Ctrl+C, Ctrl+X, Ctrl+V.
50. **Companion notes.** Turn on *Companion notes* in the settings. Open a notebook that has text boxes on two pages, wait ~5 s: `Name.md` appears next to it with properties `notebook`, `notebook-id`, `pages`, `created`, `modified`, `favorite`, `cover` and the notebook's tags, and a block with `### p. 1`, a link and the text of each page. Tap a page link: the notebook opens at that page. Write with the pen for a while: the note is not rewritten while the pen is on the screen (watch its modified time in a file manager, or keep it open in a second pane). Add a line of your own below the block and a property of your own (e.g. `status: draft`) and a tag of your own; edit a text box in the notebook: your line, property and tag are still there and the block shows the new text. Remove a tag from the notebook in the library: after ~30 s it is gone from the note, your tag stays. Rename and move the notebook in the library: the note follows. Delete the notebook: the note stays and a notice says so. In the notebooks folder create a note `Other.md`, then a notebook `Other`: the companion becomes `Other (notebook).md` and your note is untouched. Search for a word of a text box with Obsidian's search, look at the graph and the Tags pane, and (if installed) list notebooks with Dataview or Bases. Switch the location to *In a folder* and run *Update companion notes of all notebooks*: new notebooks get their note in that folder, existing notes stay and are still updated. With sync between two devices, edit on one and check the other does not produce conflict copies of the note.
51. **PDF margins.** In a PDF notebook, write on a slide near its left and right edges, then page menu → *Page margins…*. Expected: the dialog suggests a right margin of about half the slide width; apply. The page becomes wider, the slide keeps its size, the ink is exactly where it was on the slide, and you can write in the new blank area. Set a left margin too: the slide and its ink move right together. Turn on *All pages of this PDF*: every slide of that PDF gets the margins in one step; undo restores all of them at once. Turn on *Infinite page* on a page with margins and write near the bottom: the page grows below the slide and the slide is not stretched. *Remove margins* brings back the original size. Export the page and the notebook as PDF and SVG: the margins and the ink in them are there, the slide is not stretched. Check the Pages panel thumbnails. Close and reopen: same margins. (On the PC, a 0.4.x plugin opens this notebook read-only.)
52. **Re-published slides.** Import a lecture PDF as a notebook and write on some slides. Then, from the page menu of one of its pages, *Update PDF from a new version…* with: (a) the same lecture re-published with extra pages at the end, and with the order of two slides swapped; (b) a version where one slide's text changed slightly; (c) a PDF that contains only the new slides; (d) the same file again. Expected: a summary with the right numbers of new, updated and unchanged pages (d: "nothing to update"); new pages appear after the last page of that PDF (after the blank pages you added behind it) with the same margins; your notes stay on their slides even when the order changed; an updated slide switched to the new version keeps its notes, one left off keeps the old slide; one undo removes the whole update. `_assets/` keeps the old PDF. Note slides recognised wrongly (false "updated" or duplicates), slides with only pictures, and how long the comparison takes on a 50+ page PDF.
53. **PDF annotations to Markdown.** On a PDF with selectable text, highlight a few sentences (one across two lines), add a text box comment, also highlight on a scanned PDF page without text. Page menu → *Export PDF annotations to Markdown* (also the command). Expected: a new note `<notebook> annotations.md` next to the notebook opens; one section per page, the highlighted text (close to what is under the highlight; note missing or extra words), the comment, and for each item an *Open page n* link that opens the notebook at that page. The scanned page lists its highlight without text. Export again: a `… annotations 2.md` note, the first one is untouched.
54. **Repair a damaged notebook.** Work on copies of notebooks you can lose. On the PC, copy a notebook with several pages, then damage the copy: (a) cut the file in the middle (delete everything after some stroke line), (b) replace a few stroke lines in the middle with garbage, (c) change one stroke's `"color"` to `"red"`. Open each damaged copy on the device: the view shows *This notebook cannot be opened* with a **Repair…** button. Tap it. Expected: a dialog lists the damaged file and, if they exist, version-history snapshots, backup copies and unsaved journal entries of this notebook, each with pages/strokes/text boxes recovered and lost; the first is marked *recommended*; for (a) a line says where the file is cut. Choose one and tap *Create repaired notebook*: a new notebook `<name> (repaired)` opens next to the original with the recovered content; the damaged file is unchanged (compare it on the PC) and a copy of it is in `_backup/`. Also run the command *Repair damaged notebook* on a notebook that opens normally: it says there is nothing to repair.
55. **Merge a conflicted copy.** Make the same notebook diverge on two devices synced with Google Drive or OneDrive (edit it on both while one is offline, then let both sync), or simulate it on the PC by duplicating the file as `Name (1).notebook` / `Name-DESKTOP-TEST.notebook` and editing each copy separately (add strokes on different pages, add a page in one, change a text box in both). Open the original: a notice *Possible conflicted copy…* with **Merge…** appears (also when the copy arrives while the notebook is open). The dialog lists each copy with what would be added. Tap *Merge*: the new strokes, pages and text boxes appear, a text box changed on both sides is there twice, nothing disappears; one *Undo* removes the whole merge. Merge again: *Nothing new*. With *Then move the copy to the backup folder* on, merge another copy: after the save the copy moves to `Notebooks/_backup/conflicts/`; if the notebook cannot be saved the copy stays. A notebook that only happens to be called `Other (1)` (a different notebook) is never offered. Note the exact names your sync app gives to conflicted copies.
56. **Restore one page.** In a notebook with at least one snapshot or backup (see step 35), change a page (erase strokes, add some). Open the page menu → *Restore page from a previous version…* (or the command *Restore this page from a previous version*), choose a version: its pages are shown, the matching page is preselected. *Replace current page*: that page goes back to the old content, every other page is unchanged; *Undo* brings the changed page back. *Insert as new page*: the old page appears after the current one and the current one is kept.
57. **Favourite pens.** In a notebook, tap each of the six favourite buttons in the second toolbar row (on a narrow screen the strip scrolls sideways): the tool, colour and width change and the button is outlined. Select the pen with a new colour and width, long-press a favourite for about half a second: a notice says it was saved and the button changes. Right-click (or the context menu) a favourite: *Save the current pen here* and *Reset this favourite*. Close and reopen Obsidian: the favourites are kept. Check the toolbar on the phone width.
58. **Eraser size.** Select the eraser and tap it again: the options popover opens with five size buttons. Pick the largest and drag the S Pen over strokes in *Whole strokes* and in *Parts of strokes* mode: a circle follows the pen (also while hovering) and what it touches is erased. Zoom in and out: the circle keeps its screen size and the erased area matches it. Pick the smallest. Close and reopen: the size is kept. Try the pen's eraser button/end.
59. **Pen only.** Open the *More actions* menu (the "…" at the end of the second row) and tap *Pen only*: with *Draw with finger* previously on, a finger now pans and zooms instead of drawing; the setting in Obsidian's options shows the same state. Tap again to let the finger write.
60. **Commands and hotkeys.** In Settings > Hotkeys search "Notebook", assign keys to *Tool: pen*, *Favourite pen 2*, *Next page* and *Toggle pen only*, and use them with a keyboard in a notebook; with a Markdown note active they do nothing.
61. **Compact toolbar.** On the Samsung tablet and on a phone (also sideways): the toolbar is two rows (one line only on a wide leaf), nothing wraps further or scrolls the page sideways, and every button is easy to hit with a finger and with the S Pen. Select the pen and tap the pen button again (or the coloured dot): a popover opens under the bar with the colours and widths; choose a colour and a width, the dot follows. With the popover open, write on the page: the first touch only closes the popover and leaves no ink; the next stroke writes. Try the same with the eraser (modes *Whole stroke / Segment / Area*, the sizes, the filter and its colour swatches), the highlighter, shapes and text. Escape (keyboard) closes the popover. Tap the "…" button: *Insert image*, *Board shot*, *Ruler*, *Pen only*, *Add page*, *Page options*, *Fit to width* all work and the menu closes; the page number is its first line. Scroll the favourite pens strip with a finger and tap a pen: the strip does not start a stroke. Check the save-state dot (green saved, orange unsaved, red error). Note any control that is hard to reach and whether the popover ever covers what you need.
62. **Pen button test (0.5.1).** Settings → *Pen button test* button (or the command *Pen button test*). A dashed test area and an empty log appear; nothing is drawn. Since 0.11.1 the log records every event anywhere in the window, not only on the area (see step 404). Try each of these in order, with the S Pen, and watch the log (and the line *Events treated as the side button*): (a) hover the pen over the area without touching and press the side button once, release; (b) touch the area with the nib, then press the button while touching, release, lift; (c) press the button first, then touch with the nib, then lift; (d) the eraser end or eraser button if the pen has one; (e) a finger long-press on the area. Do (a) to (c) twice: first with Samsung **Air command on** (Settings → Advanced features → S Pen; the exact name and place may differ by One UI version), then with it **off**. Tap *Copy log* after each variant (if copying fails the text is selected: long-press → Copy) and send the text. Note what changes: `button`, `buttons` (1, 2, 3?), `pointerType` (pen or mouse), whether `contextmenu` / `auxclick` appear, and whether the Air command menu opens. Then, in a notebook with *Pen side button = Radial menu*, press the button hovering and touching: the ring should open once per press and leave no dot. If it does not, also try *Open the radial menu by holding the pen still* (hold the nib still for about a second: the ring opens, no dot; writing slowly or dotting an i must not open it).
63. **Opening the radial menu without the side button, and the Samsung button (0.5.2).** Do these in a notebook, with the pen only mode on, and write down what happens. (a) *Pen hovering, click*: hold the pen just above the page, press and release the side button without touching: the ring should open when you release, at the pen, and nothing is drawn. (b) *Pen hovering, press, then touch*: press the button and keep it down, touch the page and drag over some ink: it erases (eraser mode and size as in the toolbar); release: no menu; the next stroke is ink again. Press the button *before* touching: pressed after the nib is down it is expected not to work. (c) *Pen held still*: with *Open the radial menu by holding the pen still* untouched (automatic: on while the device never delivered a button signal) put the nib down and do not move it: after about 0.7 s the ring opens and no dot or undo entry remains. Dot an i, write slowly and careful letters, stop for a few seconds in the middle of a letter: the ring must never open. After step (a) or (b) worked once, the automatic default turns the hold off: check the setting shows off; turn it on yourself and check it stays on. (d) *Finger long-press*: with finger drawing off and the pen away for a moment, rest a finger on the page for half a second: the ring opens beside the finger (not under it); slide to a sector and lift to choose. A two-finger tap, a pinch and a one-finger scroll must keep working, and a finger touch right after writing with the pen must not open it. (e) *Side button during writing (experimental)*: while writing, press the side button: the stroke so far stays, the pen then erases until you press again or lift. If ordinary writing is ever interrupted by itself, turn *Side button pressed while writing* off and report it with the Pen button test log (look for lines labelled *possible side button*). (f) In the Pen button test check that the pressure-0 press, the touch while held and the release are labelled, and that *No side-button signal received yet on this device* disappears after a press.

**Format v7.** Run these on a notebook saved by 0.6.0.

64. **Outline and coloured bookmarks.** In a notebook with 10+ pages open the *Pages panel* and tap the outline button (list icon): *No bookmarks yet*. Tap the bookmark-plus button: the editor for the page in view opens; give a title, pick a colour, choose *Important*, *Save*: a row with the colour dot, the title, *Important* and *p. n* appears. Add more bookmarks: one *To review* without a colour (it shows yellow), one with a custom category typed under *Custom…*, one with no title (it shows *Page n*). The category menu filters the rows. Tap a row: the notebook jumps to that page (on a phone the panel closes). Row menu (…) → *Edit bookmark…* (rename, recolour, change category) and *Delete bookmark*; undo and redo each change. Back in the page view: bookmarked thumbnails show the title and a star in the bookmark's colour; the page menu has *Edit bookmark…* on bookmarked pages. Close and reopen the notebook: everything is kept. Check that the header buttons fit in the panel on the phone and on the tablet (title still readable).
65. **Page tags.** Page menu → *Page tags…* on two pages: type `exam, chapter 2` on one, tap the suggested `exam` chip on the other, *Save*. The tags appear under the thumbnails. The tag button in the panel lists the tags with their page counts; choose one: only those pages are shown and a bar says *Pages tagged #…* with a button to clear it. Undo the tag change: the filter clears when no page has the tag any more. In the library search type `exam`: the notebook is found with a *Page n* row showing `#exam`; tap it: the notebook opens at that page. Duplicate a tagged page: the copy has the same tags.
66. **Last position across devices.** With sync between the tablet and the phone (Obsidian Sync with "other types", Syncthing or a cloud folder): on the tablet open a notebook, go to page 7, scroll halfway down the page and write a stroke; wait for *Saved* and for the sync. On the phone open the notebook from the library: it opens on page 7 at about the same height. Then on the phone only scroll to page 2 without writing and close it: check (file manager or sync log) that the notebook file was **not** written. On the tablet reopen the notebook from the library: still page 7 (the phone did not save). On the phone write on page 2, sync, and reopen the notebook on the tablet from the workspace tabs (restart Obsidian with the notebook tab open): it opens on page 2 because the phone was there later. A `[[Name.notebook#p4]]` link and a library search hit still open their page. *Continue last notebook* opens this device's last page.
67. **New papers.** Create a notebook for each new paper (*Cornell*, *Music staff*, *Isometric*, *Hexagonal*, *Calligraphy*, *Daily planner*, *Weekly planner*) and try a landscape page for the weekly planner (4 × 2 boxes instead of 2 × 4). Expected: Cornell has a title line, a red cue-column line and a summary line near the bottom; music has staves of five lines with the outer lines darker; isometric has vertical and ±30° lines; hexagonal a honeycomb; calligraphy groups of four guide lines (darker baseline) with slanted guides; the planners a header line and hour rows / day boxes. Zoom out: the fine lines fade out as on the older papers and the main lines stay. Change the paper of an existing page from the page menu (undo). Export a page of each as PDF and SVG and check the pattern; check the library cover and the panel thumbnails. Note any paper whose density or proportions feel wrong on the device.

**Gestures.** Run these with the default settings unless a step says otherwise.

68. **Two- and three-finger taps.** Write a few strokes. Lift the pen away and tap once with two fingers together: the last stroke disappears (undo); tap with three fingers: it comes back (redo). Expected: no ink, the page does not move or zoom. Then pan with two fingers and pinch to zoom, slowly and quickly: nothing is undone. Rest two fingers on the screen for about a second and lift: nothing. While the pen is near the screen (hover) or just after writing, tap with two fingers: nothing happens until the pen has been away for the palm-rejection time. Settings → *Finger taps*: try the swapped option and *Off*. Also try with *Draw with finger* on. Note any accidental undo from your palm while writing.
69. **Scribble to erase (setting on).** Settings → *Scribble to erase* on. Write a few words, then scratch back and forth quickly over one word with the pen: the strokes you crossed vanish when the pen lifts, the scribble itself leaves nothing, and one undo brings the word back. Then try things that must stay ink: write "mmm" and "wwww" large and fast over existing ink, shade an area with zig-zags (a few cm wide), hatch with separate lines, scratch slowly, scribble on empty paper, scribble beside a word without touching it, scribble across a ruled line (the line must stay). Note every false positive and every scribble that was not recognised, with its size and speed.
70. **Auto-scroll (setting on).** Settings → *Scroll up when writing near the bottom* on. Zoom so that a few lines fill the view, write along the bottom edge and lift the pen: after a short pause the page scrolls up smoothly so your last word sits about 40 % from the top. Touch the screen or put the pen down during the pause or the scroll: it stops. The page never moves while the pen is down. At the end of the last page it stops at the end (or the next page is appended first, with *Add a page when writing at the bottom*). Note whether the pause is too short (the page moves between words) or too long.
71. **Side button: lasso.** Settings → *Pen side button* = *Lasso while held*. Hold the button and drag a loop around some words: they are selected and the tool in the toolbar does not change. Release the button and write: the selection goes away and ink is written. Hold the button and touch inside the selection: it can be moved.
72. **Side button: previous tool.** Settings → *Pen side button* = *Previous tool while held*. Use the pen, then the highlighter (toolbar): holding the button, the pen strokes are pen strokes again; release and it highlights. Right after opening a notebook (no previous tool) holding the button keeps the current tool (it never erases). Note whether your S Pen reports the button at all (hold it during the stroke start, not after).
73. **Defaults.** After updating, with a clean settings file: *Finger taps* is two fingers undo / three redo, *Scribble to erase* and *Scroll up when writing near the bottom* are off, and *Pen side button* is *Radial menu on click, erase while held*.

**PDF reading.** Use a notebook made from a PDF with a text layer (a lecture slide deck or a paper; a scanned PDF has no text to search or snap to).

74. **Search.** Open the "…" menu and tap *Search PDF text* (or run the command). Type a word that occurs on several slides. Expected: after a moment the results appear with the page number and the words around each match, the first match is shown on the page with a yellow mark (the current one orange with an outline), the count reads *1 / n*. Tap another result: the page scrolls to it. Next and previous (and Enter / Shift+Enter on a keyboard) go round the list. Type one letter: a message asks for two. Try a word with an accent typed without it. Note whether the marks sit exactly on the words, also deep inside a long line.
75. **Search on a big PDF.** Import a PDF with 100 pages or more and search for a common word while scrolling and writing. Expected: the page stays responsive (typing, scrolling and the pen are not blocked), the message *Searching… x / y pages* advances, results appear as they are found; closing the search (×) removes the marks and nothing is saved. Note how long it takes to cover the whole PDF.
76. **Snapping highlighter.** Select the highlighter, tap it again and turn on *Snap to text lines*. Swipe loosely across a few words of a line, then across two lines in one stroke, then over a picture or an empty margin. Expected: each stroke over text becomes straight bands that cover whole words on each line (a second stroke across two lines gives two bands), as high as the line; over no text the stroke stays as you drew it. Undo reverts a whole swipe in one step. Turn the option off: strokes are no longer changed. Try a swipe made right after opening a page (the text may not be read yet: the stroke then stays as drawn).
77. **Hide annotations.** In a notebook page with ink on a PDF slide, open the "…" menu and tap *Hide annotations*. Expected: the ink and text boxes of the PDF pages disappear (pages without a PDF keep theirs), a banner says that editing is off, the tools are greyed out, the pen draws nothing, a finger scrolls and pinches. Tap *Show annotations* in the banner: everything is back, editing works, undo is as before. Close and reopen the notebook: nothing was changed.
78. **Dim background.** Tap *Dim backgrounds* in the "…" menu: the PDF becomes lighter and a slider appears; drag it and watch the strength change; leave the menu open while dragging. Write on the page: the ink stands out. Close and reopen Obsidian: the setting is kept. Export the notebook as PDF: the PDF background is **not** dimmed (a decision: exports show the notebook as it is, not one reader's screen setting).

**Navigation and huge notebooks.**

79. **One page at a time (#14).** Settings → *Scrolling* → *One page at a time*, or "…" menu → *One page at a time*, in a notebook with at least four pages. Expected: one page fills the width; swiping sideways with a finger drags the page and the next one comes in beside it; a long or quick swipe turns the page and it snaps into place, a short slow drag springs back; the page number in the toolbar follows. Swipe up and down: the page scrolls and never turns, even with a crooked finger. Pinch to zoom in, pan around (nothing turns), then push past the edge of the page: it turns and the next page opens at its near edge. Write with the S Pen right across the page with a sideways stroke: it draws and never turns the page. With *Draw with finger* on, check whether a two-finger sideways swipe turns the page. Rotate the tablet. Switch back to *Continuous*: same page, fitted. Note anything that feels slow, sticky or too easy to trigger.
80. **Reopen where you left off (O16).** In a notebook with five pages zoom in on page 3, scroll to a distinctive spot and wait 2 s. Close the tab and reopen the notebook: same page, zoom and spot. Restart Obsidian (and force-stop it from Android's recent apps, then start it): same. Use *Continue last notebook* after opening another notebook: it returns to that spot. Rotate the tablet and reopen: the same part of the page is at the top. Follow a `[[Notebook#p2]]` link: page 2 fitted, not the old zoom. Repeat in *One page at a time*.
81. **Large notebook (#329).** Use a notebook of several MB (the stress-test notebook is about 7 MB). Open it on a page far from the first: the page appears quickly and is read-only for a moment (status *Loading…*); pinch and scroll work meanwhile; then the toolbar enables and writing works. Note how long the page took to appear compared with 0.5.0, whether scrolling to a far page right after opening shows a blank page for a moment, and that closing the tab while it loads works. Write a stroke and reopen to check the file is intact.

**Library trash, page trash and templates.**

82. **Move to trash.** In the library, delete a notebook (card menu) and a non-empty folder. Expected: a confirmation that says it can be restored; both disappear from the library and from search; the notebook tab, if open, closes; in the file explorer they are under `Notebooks/_trash/items/<id>/` with a `meta.json`.
83. **Restore.** Library sidebar → *Trash*. Restore the notebook: it returns to its folder and opens with all pages and ink. Create a new notebook with the same name, trash the first one again and restore it: expected the name `<name> 2`. Restore the folder: its notebooks are back inside it.
84. **Delete permanently and empty.** In *Trash*, *Delete permanently* on one item: a confirmation first, then it is gone (or in the system trash, per Obsidian's *Deleted files* setting). *Empty trash*: confirmation, then everything goes. Cancel both once and check nothing was deleted.
85. **Auto-empty.** Setting *Empty the trash automatically* = 1 day, trash a notebook, set the device clock two days ahead (or change `deletedAt` in `meta.json` to an old time), restart Obsidian. Expected: the item is removed; with the setting at 0 nothing is ever removed.
86. **Trash is invisible.** With companion notes on, trash a notebook: no companion note is created inside `_trash`; the existing note stays. Trashed notebooks do not appear in *Open notebooks*, search, or *Move to notebook*. A copy named `Name (1)` made by Google Drive inside `_trash` produces no merge notice.
87. **Sync.** Trash a notebook on one device, let Google Drive / OneDrive sync, open the library on the other device. Expected: the notebook is gone from the library there and listed in *Trash*; restore on that device works.
88. **Deleted pages.** Delete a page from the page menu, fully close Obsidian and reopen the notebook. Page menu → *Deleted pages...*: the page is listed with a thumbnail. *Restore*: it comes back after the page that preceded it; *Undo* removes it again and it is listed again. Delete a page that has a PDF background or an image and restore it: the background shows.
89. **Save as template.** On a page with ink, text and a ruled A5 paper choose *Save page as template...*, name it. Expected: a notice, and a `.notebook` file in the templates folder (default `Notebooks/_templates/`).
90. **Page from template.** Page menu → *New page from template...*: the gallery shows the built-in templates and yours with thumbnails; *Use* adds a page after the current one with the same content, paper and size; one *Undo* removes it. Do it twice: both pages are independent.
91. **Notebook from template.** *New notebook* dialog → *Template* → *Choose...* → pick one → *Create*. Expected: the notebook opens with the template's pages. *Clear* goes back to the paper and size choices. Delete one of your templates from the gallery: it disappears and the file goes to the Obsidian trash.

**Lecture pack and exercise page.**

92. **Lecture from slides, slide + notes right.** Library → *New lecture from slides* (or the command). Choose a slides PDF from the vault, then from the device. In the dialog leave the course as proposed, set today, header *Header page before the slides*, layout *Slide with notes on the right*, notes paper *Ruled*. Expected: the notebook "<course> <date>" appears in the folder and opens; page 1 is the header page ("Course — date"); the next pages show one slide each in the left part with ruled lines to its right; the slide is not stretched; writing in the notes area and on the slide works and stays where it was written after reopening.
93. **Notes below.** Same with *Slide with notes below* and header *Header text on the first page*: the text sits below the first slide; no header page. Rotate the tablet: pages refit.
94. **On the slide.** Layout *On the slide*, header *No header*: the pages are the slides at their own size, as with *Import PDF*.
95. **Notes page after every slide.** Turn on *Notes page after every slide* with paper *Millimetre* (also combined with a notes layout): after each slide page there is a blank millimetre page of the same size. Count the pages: twice the slides (plus the header page).
96. **Insert PDF with layout.** In an existing notebook, page menu → *Insert PDF*, choose a PDF and a range: a layout dialog follows (the last choice is proposed; Enter confirms). Pick a layout with notes and notes pages: the pages are inserted after the current page; one undo removes all of them; the PDF is not copied again if it was already imported (check the assets folder).
97. **Cancel.** Cancel at each dialog (file choice, setup, range, layout): nothing is created or inserted, and cancelling the setup dialog of a new lecture leaves no PDF in the assets folder.
98. **Large deck on the tablet.** Import a deck of 60+ slides with notes on the right: the progress message appears and the notebook opens; scrolling and zoom stay smooth.
99. **Exercise page here.** On a slide page with a notes area, tap … in the toolbar → *Exercise page here* (also page menu and the command): a blank grid page as large as the whole slide page appears right after it and is shown; one undo removes it. *Exercise page paper…* (page menu) changes the paper to millimetre: the next exercise page uses it, also after restarting Obsidian.

**Timetable.**

100. **Timetable editor.** Add two classes (one on odd weeks, one with a term and a room, one linked to a course folder), save, reopen: values are kept; `Notebooks/_timetable.json` exists and is readable.
101. **Open Obsidian (or the library) during a class.** Notice with *Open lecture page*; tap it: the course's notebook opens with a new page headed "<course> — <date>" and tagged with the course (Pages panel tag filter); undo removes the page and its tag together; do it again: the existing page is shown, no second page.
102. **Turn on *Open it without asking*, restart during a class.** The notebook opens on the new lecture page by itself; turn it off and the notice returns (once per class and day)
103. **New lecture prefill.** During a class, *New lecture* in a linked notebook has the course filled in; in an unrelated linked notebook it shows the notebook name.
104. **Library shows *Now.** <course>* during a class (also a few minutes before, per the lead setting) and nothing outside classes; tapping it opens the lecture page.
105. **Hand-edited timetable file.** Edit `_timetable.json` by hand (also from another device through sync), including a deliberate mistake: a good edit is picked up; a bad file is reported in the editor and is not overwritten.

**PDF beside the notes.** Needs a lecture PDF in the vault and a notes notebook (and, for the notebook-with-PDF-backgrounds step, a notebook whose pages have PDF backgrounds).

106. **Open side by side (tablet sideways).** In a notes notebook run *Open PDF side by side* (command palette, or "…" menu → *Open PDF side by side*) and choose the lecture PDF. Expected: the PDF fills the left part, the notes the right part; the PDF page fits the width of its pane; the notes page refits to the narrower area. Drag the divider: both sides follow, limits about 20 % and 80 %. Write with the S Pen on the notes side: no change in feel; a finger on the PDF side scrolls it. Note how long the first page takes to appear.
107. **Phone and tablet upright.** Rotate the tablet to portrait and repeat on a phone: the panes stack (PDF on top). Rotate back while it is open: the layout switches without losing the page on either side.
108. **Add a notes page for a slide.** Turn the PDF to slide 1: the strip *No notes page for this slide* appears. Tap *Add notes page for this slide*: a page is inserted (same size and paper as the one you were on), the notes scroll to it and the strip disappears. Undo once: the page is gone; redo: it is back and the strip stays hidden on slide 1.
109. **Follow both ways.** Add notes pages for slides 2 and 3, then turn the PDF back and forth: the notes jump to the linked page each time. Scroll the notes by hand to another linked page: the PDF follows after a moment. Switch *Follow* off: neither side moves the other any more; the strip *Show* appears when the notes are elsewhere and works. Check with short pages (landscape slide pages in a tall view) that the PDF does not jump to the next slide by itself.
110. **Link and unlink.** On an existing notes page tap *Link* while the PDF shows slide 5: the notice names both pages and the button reads *Unlink*. Turn to another slide and back: the notes follow. *Unlink*: the notes stay where they are and the strip offers *Add notes page* for slide 5. "…" menu → *Show the slide of this page* moves the PDF to the linked slide.
111. **Links survive restarts and renames.** Close the pane, restart Obsidian, open the notebook and the same PDF side by side: it opens on the slide of the notes page in view and following works. Rename or move the PDF in the vault and open it again: the links still work. Check that scrolling and turning pages does not change the modified time of `Notebooks/_meta/pdf-links.json` (only the three link actions do).
112. **Notebook with PDF backgrounds as the PDF side.** Choose a notebook whose pages have PDF backgrounds (with your ink on them) instead of the PDF: pages show the slide with the ink, turning and adding notes pages work the same; a page without a PDF background shows a notice when you try to link it. Write in that notebook in another tab: the pane updates a moment after it is saved.
113. **Damaged links file.** Replace `pdf-links.json` with `{ not json`, reopen the pane: a notice says links are off, the file is unchanged and a `pdf-links.unreadable-…` copy exists; the PDF can still be read, *Link* is disabled. Restore the file and reopen the pane: links work again.

**Stamps and ink on objects.** Not verified on a device.

114. **Ink follows an image.** Insert an image, write a few words over it with the pen, switch to the lasso and tap the image (or lasso it). Drag it, then scale it with the bottom-right handle and rotate it with the top handle. Expected: the words move, scale and rotate with the picture and stay on it; one undo step puts everything back. Words written next to the image stay where they were.
115. **Ink follows a text box.** Same with a text box (text boxes move and scale but do not rotate). Expected: ink written over the text moves with it.
116. **Setting off.** Turn off *Ink follows objects* in the settings and move the image again. Expected: only the image moves; the ink stays.
117. **Delete an object with ink.** Select an image that has ink on it and delete it. Expected: a notice says how many strokes were written on it, with *Delete the ink too*. Ignore it: the ink stays. Repeat and tap the button: the ink goes, and one undo brings it back; a second undo brings the image back.
118. **Undo before taking the offer.** Delete an image with ink, press undo, then tap *Delete the ink too* in the notice. Expected: nothing happens (the image is back).
119. **Built-in stamps.** More menu → *Stamps*. Tap *Checkmark*: a checkmark appears in the middle of the page in the current pen colour and width and is selected; move it. Drag *Star* onto another place. Expected: it lands where the finger or pen was lifted. Undo removes it.
120. **Save a stamp.** Write a small signature, select it with the lasso, open *Stamps* and tap the save button, name it. Expected: it appears under *My stamps*; the file `Notebooks/_stamps/<name>.stamp` exists. Tap it on another page and in another notebook.
121. **Stamp with an image and text.** Select an image and a text box together, save as a stamp, delete the originals, place the stamp. Expected: both come back; the image uses the same file in `_assets/` (no copy).
122. **Rename and delete a stamp.** Use the pencil and trash buttons on a stamp. Expected: the name changes in the palette and the file; delete asks first and moves the file to the trash; notebooks that used the stamp are unchanged.
123. **Palette on a phone and with a finger.** Open the palette on a narrow screen. Expected: it fits, the list scrolls vertically, a sideways drag from a tile onto the page places the stamp. Report whether a vertical or diagonal drag scrolls the list instead of dragging.

**Zettelkasten.**

124. **Cards.** In a notebook, write two short ideas apart from each other. Select the first with the lasso, open the ⋯ menu of the notebook tab (or the command *Make card from selection*): the *New card* dialog shows the ink; type a title, choose a type, a source and two tags, *Create card*. Expected: a note `Zettelkasten/<id> <title>.md` with those properties, `zettel-notebook-id`, `page-id`, `region` and the ink shown below the properties. Write more in that region of the page: once the notebook is saved, the card's preview follows. Move the page with the Pages panel: the card still shows the same ink. Repeat with *Make card from this page*. Switch *Card ids* to Luhmann numbering and make two cards, the second with *Branch of card* = the first id (expected ids `1` and `1a`).
125. **Slip-box.** Run *New slip-box*: an A6 notebook opens and its first page already has a card (id badge at the top right of the page). Add two pages: a few seconds after they are saved, two more cards exist (one per page), none created twice. Turn an existing notebook with several pages into a slip-box from the ⋯ menu: a confirmation gives the number of notes first. Delete a page: its card gets `orphaned: true` and is listed by *Show orphaned cards*; undo: the flag goes away. If you use sync, open the slip-box on a second device and check that no card appears twice and that the second device does not rewrite the cards (no conflicted copies of card notes after deleting a page on the first device).
126. **Drawn links.** On a page with two region cards, choose the shape tool's arrow and draw from the first region to the second. A few seconds later both card notes have the other in `links`, and the graph shows the link. Remove the link from one note by hand: it does not come back. Run *Link cards joined by arrows on this page*: it does come back (explicit request).
127. **Title and transcription.** In a slip-box page without a title, run *Set card title*: the note gets `title` and `aliases` and is renamed from `<id>.md` (or `<id>-<suffix>.md` with Luhmann ids) to `<id> <title>.md`; a link to it in another note follows the rename. Type text under *Transcription* in the note and then write on the page: the text stays untouched.
128. **Regions and container.** Toggle *Show or hide card regions*: outlines and badges disappear and come back; with them shown, write, erase and lasso across an outline with the S Pen and with a finger: input is exactly as without them. Rename the notebook in the file explorer: cards keep working (their `notebook` link is updated by Obsidian). Turn on *Companion notes* and open the notebook: the companion note is a separate note, never one of the cards.

**Shared tags and public API.**

129. **Shared tags (O2).** Turn on *Companion notes*. In the library open a notebook's menu → *Edit tags…*. Expected: a dialog with the tags as chips (tap one to remove it) and a field; typing `ph` lists the tags your vault already has (the same ones as in the Tags pane, e.g. `physics`, `physics/optics`); tap a suggestion or press Enter to add; `#Exam`, `linear algebra` and `a//b` become `Exam`, `linear-algebra` and `a/b`; `2026` or `???` give a red message and are not added. Save: after a few seconds the companion note has the tags in its `tags` property and they appear in the Tags pane and in tag search. Also try the command *Edit tags of this notebook…* in an open notebook (undo reverts it). In the library, choose a parent tag (e.g. `physics`) in the sidebar: notebooks tagged `physics/optics` are listed too. Note how the suggestions behave on Android (keyboard covering the list, tapping a suggestion).
130. **Tags and the companion note you edit.** Open a companion note, add `mine` to its `tags` by hand, also add a tag the notebook gets later (e.g. type `exam` before adding `exam` to the notebook). Add and remove tags in the notebook: the note follows after ~30 s (2 s after using the tag editor), `mine` is never removed, `exam` stays even after you remove it from the notebook, and tags the notebook added are removed when you remove them. Delete a notebook tag from the note by hand: it comes back at the next update.
131. **Tag editor hint.** Turn off *Companion notes*, open the tag editor: a message says the Tags pane needs companion notes and offers *Turn on companion notes*. Tap it: the message changes, the setting is on, the notebook's note is created within seconds. The notebook's tags are saved either way.
132. **API: create, pages, info.** In the developer console (or a Templater/QuickAdd script): `const api = app.plugins.plugins["notebook"].api; api.version` → `"1.0.0"`. `await api.createNotebook("Notebooks/Api test", "Demo", { paper: "ruled", pages: 2, tags: ["api"], open: true })` opens a two-page ruled notebook. With it open: `await api.addPages("Notebooks/Api test/Demo.notebook", 2)` adds two pages at once and *Undo* in the notebook removes them in one step; with the notebook closed the same call adds them in the file and `Notebooks/_backup/` has a `before-api` copy. `await api.getNotebookInfo(file)` shows pages, tags and meta. `api.listNotebooks()` lists it. Write with the pen while calling `addPages` in a loop: the call waits or fails with `busy`, never loses ink.
133. **API: images and PDF.** `await api.insertImage(file, 1, "Attachments/photo.png", { width: 300 })` (a vault image) and with bytes (`new Uint8Array(await app.vault.adapter.readBinary(path))`): the image appears on page 1, centred; undo removes it when the notebook is open. A text file or an SVG throws `unsupported-image`; page 99 throws `invalid-argument`. `await api.exportPdf(file)` writes `Name.pdf` next to the notebook with every page (PDF/image backgrounds and images included); `{ strict: true }` throws `export-incomplete` when an asset was deleted.
134. **API: errors and safety.** Call `addPages(file, 0)`, `addPages(file, 1, 99)`, `addPages("Nope", 1)`, `createNotebook("../x", "y")` and `createNotebook("A", "B", { tag: [] })`: each throws a `NotebookApiError` with the documented code and nothing changes. Damage a closed notebook (cut its file in half) and call `addPages` on it: `unreadable`, the file is untouched. Call `openNotebook(file, 3)` on a closed and on an already open notebook: it opens at page 3.

### Resilience (wave 0.7: safe mode, storage full, integrity)

Not verified on a device. Fill in the result table below.

135. **Safe mode after a crash.** Open a big notebook and, while it is still opening (before the page shows), kill Obsidian from the recent apps (or force-stop it in the Android settings). Open the same notebook again. Expected: the *Safe mode* banner; the page panel has no thumbnails; writing works (without low-latency ink); PDF or image backgrounds appear a moment after the ink. No companion note is written while it is open.
136. **Open normally.** In the safe-mode banner tap *Open normally*. Expected: the notebook reopens without the banner, with thumbnails; close and reopen it: still normal.
137. **Two failures.** Repeat step 135 twice in a row (kill during the normal open, then kill during the safe open). Expected: the banner says it failed twice and *Repair…* is highlighted; *Repair…* opens the integrity report of this notebook with *Open* and *Restore a version…*.
138. **Not a failure.** Open a notebook and switch to another app at once, or close the tab right away; reopen it. Expected: no safe mode.
139. **Storage full.** Fill the device storage (large video or a big file copied until the system says the storage is full), then write a few strokes. Expected: within a few seconds the red *Not saved* banner says the storage is full; the strokes stay on the page; the next attempt time moves further out (5 s, 10 s, 20 s… up to a minute). Free some space and tap *Retry now* (or wait). Expected: the banner goes, a notice says saving works again; close and reopen: all strokes are there and the file opens normally (not damaged).
140. **Storage full while closing.** As step 139 but close the notebook tab while the banner is shown, free space, reopen. Report what was kept (the strokes may be in the journal or an `unsaved` backup) and whether any file in `Notebooks/` became unreadable.
141. **Rolled back by sync.** On device A write in a notebook, wait for the sync, close it. Write more on A, sync. With the sync app's version history (Google Drive / OneDrive web *Manage versions*), put the older version back; let it reach A and open the notebook there. Expected: the *Unexpected change on disk* banner with the two dates, *Restore a version…* and *Keep this version*. Repeat with the notebook open on A (not editing): the banner also offers *Restore the newer version*, which brings the newer strokes back as one undo step; a backup `… integrity ….bak` exists in `Notebooks/_backup/`.
142. **No false alarm.** Edit the notebook on device B (also with B's clock a few minutes behind), and change tags or the favourite from the library on B with the notebook closed. Open it on A. Expected: no banner, in every case. Restore a snapshot with *Restore a previous version* on A: no banner.
143. **Check notebooks integrity.** Run the command. Expected: a progress line, then a summary; a notebook made unreadable on purpose (truncate a copy of a `.notebook` file in a text editor) is listed with *Repair…*; deleting a PDF from `Notebooks/_assets/` lists *The file of … is missing* for the notebooks using it.

### Interface redesign (ui redesign)

Not verified on a device. Fill in the result table below.

144. **Toolbar on the tablet.** Open a notebook on the tablet in portrait, then landscape. Expected: portrait has two rows (tools; undo/redo, current pen, favourites, 4-5 quick actions, page "1 / n", save dot, ⊞); landscape has one row with up to six quick actions. Nothing is cut off; every button reacts to the S Pen and to a finger.
145. **Quick actions learn.** Use *Fit to width* from the ⊞ sheet five times. Expected: after a while it appears among the quick actions; *Recent* in the sheet lists the actions you use. Close and reopen Obsidian: the order is kept (local to the device).
146. **All actions sheet.** Tap ⊞. Expected: a sheet grouped in sections (Insert, Page, …) with a search field; typing "stamp" or "timbro" (Italian UI) finds *Stamps*; the keyboard does not pop up by itself. *Ruler* toggles with a switch and the sheet stays open; *Insert image* closes it. A tap on the page closes the sheet and draws nothing. On a phone it is a bottom sheet within thumb reach.
147. **Page sheet.** Tap the page indicator "2 / 5". Expected: the first section *Go to* (*Go to page number…*, *Recently edited pages*, *One page at a time*), then *Page 2* actions (duplicate, move, bookmark, tags, paper and size chips, turn, infinite, …, delete). Tap *Dotted*: the page changes at once and one undo restores it. Open the pages panel and use a thumbnail's menu: the same sheet opens for that page.
148. **Selection bar.** Select ink with the lasso. Expected: a pill at the bottom with *Selection*, copy, cut, duplicate, paste, save as stamp, delete, and the colour/width rows above it; with an image selected also *Make white transparent*. The chevron collapses it to one round button, which opens it again. With the lasso and nothing selected only *Paste* is offered.
149. **PDF page and side by side.** Scroll to a PDF page. Expected: the bar shows *PDF page* with search, hide annotations, dim, margins and *Open PDF side by side*; on a plain page it disappears. Open a PDF side by side: the bar shows link, add notes page, show slide and close.
150. **Class now.** With a class of the timetable on now, open a notebook. Expected: the bar shows *Class now* with new lecture, board shot and exercise page.
151. **Radial dial.** Press the S Pen button over the page. Expected: a dark dial at the nib with the pen drawn in the middle, undo/redo at the top, the width dot on the left and the colour on the right, and favourites · tool · shapes at the bottom. Releasing the button over undo undoes (flick); nothing is drawn while it is open; Escape or a tap outside closes it.
152. **Dial colours and width.** Tap the colour bubble: 12 colours around the ring; pick one (the dial goes back, the pen uses it). Tap the rainbow button: the system colour picker opens. Tap the pipette and then a coloured stroke on the page: the pen takes that colour and nothing is drawn. Tap the width bubble and drag along the arc: the number and the dots follow; the pen writes with the new width.
153. **Pen case and favourites.** Tap the pen in the middle: the tools drawn as pens with a stroke preview; tap the highlighter (the dial closes, the highlighter is active). Open it again, tap "+": the six favourites pulse; tap one to save the current pen there; the toolbar strip shows it.
154. **Themes and accessibility.** Switch Obsidian to the dark theme and to a community theme. Expected: bars, sheets and panels follow the theme colours; the dial stays dark and readable; a black pen dot stays visible on a dark bar. With *Reduce motion* on in Android, nothing animates.
155. **Go to and banners.** Tap the page indicator, then *Go to page number…*, type `p3`: page 3 opens. Toggle *One page at a time* from the same sheet: pages turn with a swipe and the toggle shows a switch. Open a very large page: the heavy-page banner offers *Split page*; dismiss it and the page sheet still offers *Split page*. *Check sync safety* and *Check notebooks integrity* are in the ⊞ sheet under *Notebooks*.

### Level of detail and heavy pages (wave 0.7)

Not verified on a device. Use **Create stress-test notebook** (10,000 strokes, 10 pages) for steps 156-158.

156. **Zoomed out looks the same.** Open the stress notebook, fit the width, then pinch out until the page is below half of its width on screen. Expected: the handwriting looks the same as before (no jagged or thinner strokes, no strokes missing); pinch back in: the strokes are as smooth as at the start.
157. **Scrolling and zooming out is smooth.** In the same notebook scroll quickly through all pages at about 30 % zoom, and pinch in and out. Expected: no stutter that was not there before; note it as faster, same or slower than 0.5.x if you remember.
158. **Thumbnails.** Open the page panel and the library. Expected: thumbnails of dense pages look right and appear at least as quickly as before.
159. **Warning appears.** Open the stress notebook and make a page heavy (the stress notebook has about 1,000 strokes per page: duplicate a page 3 times and paste its content into one page, or open a notebook with more than 3,000 strokes on one page). Expected: after a moment a bar at the bottom says the page is very large, with *Split page* and *Dismiss*; it does not appear while the pen is writing and does not cover the toolbar.
160. **Split page.** Press *Split page*. Expected: a notice, a new page right after this one with the lower half of the writing (same x positions, starting near the top of the page), the upper half still on this page; undo once puts everything back on one page.
161. **Dismiss.** Press *Dismiss*. Expected: the bar goes away and does not come back for that page until you close the notebook tab; other heavy pages still warn. On a page that shows a PDF the bar has only *Dismiss*.

### Quick navigation (wave 0.7)

Not verified on a device. Commands: *Go to page…*, *Recently edited pages*, *Go to page number…*.

162. **Page switcher: search.** Have two notebooks, one with a titled bookmark, one with a page tag and a text box. Run *Go to page…* and type: part of a notebook name; `name 3`; `p3`; the bookmark title; the tag; a word from the text box. Expected: each result opens the right notebook at the right page; a page number beyond the notebook is not offered.
163. **Page switcher: thumbnails.** With many notebooks (including a PDF one) type a common letter. Expected: the list appears at once, thumbnails fill in one after another without freezing typing; closing the dialog stops them.
164. **Recent pages: log.** Write on page 4 of a notebook, wait 5 seconds, then run *Recently edited pages*. Expected: that page is first, "Edited just now". Only scroll/open another notebook: nothing new is logged.
165. **Recent pages: library.** Open the library, tap *Recent pages* in the sidebar. Expected: the same list. Rename the notebook, reopen the list: the entry follows the new name; delete it: the entry disappears.
166. **Go to page number.** In an open notebook run *Go to page number…*, type `7`, then `p7`, then the start of a bookmark title. Expected: each scrolls to the page; `999` offers nothing.
167. **Page indicator tap.** Tap the "3 / 12" indicator in the toolbar. Expected: the same dialog opens.
168. **Recent pages after reordering.** Edit page 5, move it to position 2, open it from the list. Expected: the page that was edited opens (found by id).
169. **Not synced.** Check that no new file appeared in the vault or the plugin folder because of the recent pages (the log is in device-local storage only).

### Sync safety (wave 0.7)

Not verified in Obsidian or on a device. Needs two devices syncing the same vault through Google Drive or OneDrive (for example Autosync or FolderSync on Android) unless said otherwise.

170. **Open on another device.** Open a notebook on device A, wait for the sync app to upload `Notebooks/_meta/presence/`, sync device B and open the same notebook there. Expected: a banner above the page on B names device A and how long ago it was active, with *Open read-only* and *Open anyway*; the page can be used meanwhile. On A, nothing changes (or, if B's file arrives while A is open, the banner appears on A too).
171. **Read-only.** On B tap *Open read-only*. Expected: the toolbar is disabled, the pen does not write, nothing is saved (the file's modification time does not change); *Edit anyway* enables editing again. *Open anyway* instead only hides the banner.
172. **Heartbeat stops in the background and the file goes on close.** On A, put Obsidian in the background for 5 minutes, then check (file manager or the other device) that the presence file's time did not change; bring it back: it is refreshed at once. Close the notebook on A: the file disappears (and, after syncing, from B). Kill Obsidian on A with a notebook open, restart it: its own leftover file is removed at startup. No `(1)` or conflict copy of any file in `_meta` appears on either device.
173. **Device name.** *Settings, Device name*: change it on A, reopen the notebook on A. Expected on B (after syncing): the banner shows the new name. The name is not in the plugin's `data.json`.
174. **Asset waiting for sync.** On A, insert an image and import a PDF into a notebook; on B, let the sync app download the notebook but not `_assets` (pause it, or delete the asset file on B only). Open the notebook on B. Expected: a dashed "Waiting for sync…" card where the image is, "Waiting for sync: <name>" on the PDF page, no error notice, and the page can still be written on. Resume syncing: the image and PDF appear by themselves without reopening.
175. **Not downloaded yet.** Make a notebook file 0 bytes on B (an online-only file of the sync app, or create an empty `Test.notebook` with a file manager). Expected: the library card says *Not downloaded yet*; opening it shows *Not downloaded yet* (no *Repair…* button), the status says *Not downloaded*; the command *Repair damaged notebook* says it is not damaged; no `.bak` is created in `_backup`. Then put the real content in the file (let the sync app download it, or copy a notebook over it): it opens by itself within a few seconds, in the library too.
176. **Sync check.** Command *Check sync safety* (also in the settings). Create `Notebooks/What?.notebook` (on Windows, or with a file manager that allows it), a 15 MB PDF in a notebook, and two notebooks named `Notes` and `notes` (on a case-sensitive device). Expected: each is listed with a clear explanation; the dialog says whether other devices were seen in this folder and what cannot be checked. Restart Obsidian: a notice appears once; restart again with nothing changed: no notice.
177. **Folder excluded.** Set the notebooks folder to `.obsidian/Notebooks` (or a hidden folder) in the settings and run the check. Expected: the first line explains that this folder is often not synced. Set it back.

### Markers, boxes and invisible ink (wave 0.8, steps 178-187)

Not verified on a device. Fill in the result table at the end of this file.

178. **Place markers.** ⊞ *All actions* → Lecture → *Place marker: Question* (also on the lecture bar during a class, and on the radial dial: shapes ring → *Markers*), then tap on the page: a blue "?" badge appears, centred where you tapped. Do the same for *Important*, *Very important*, *Key point* and *To complete*, once with a tap and once dragging around some handwriting (a dashed frame shows the region). Use the commands from the command palette too. Undo removes each one, redo puts it back. Close and reopen: everything is there.
179. **Tap a badge.** With the pen: tap the "?" badge: it turns green with a check (resolved); tap again: back to "?". Tap "!": it becomes "!!", then "★", then "!". Tap next to a badge: ink is written as usual. With the lasso: tap a badge to select it, move it, delete it; undo.
180. **Gap with the slide.** Open a PDF side by side (*Open PDF side by side*), turn to slide 5, place *To complete*. *End of lecture* lists it with the time and "slide 5". On a page with a PDF background (no side pane) the slide is that page's PDF page.
181. **Homework.** Place *Homework*: a dialog asks what to do and the due date (date picker). Save: a purple square badge shows the day of the month. Tap it: the dialog opens again; mark it done and save. With companion notes on, open the companion note: the generated region has `- [x] <what> 📅 <date>`; text you wrote outside the region is unchanged.
182. **Structured boxes.** *Draw a structured box*, drag a frame around a formula, choose *Theorem*: a purple frame with a "Theorem" tab. Tap the tab: change the kind to *Definition* and add a title; save. The companion note gets `> [!definition] <title>` with a live embed of exactly that region (check it renders). A tap without dragging asks to drag.
183. **End of lecture panel.** In a notebook with two *New lecture* pages and markers on both, open *End of lecture panel* on the second lecture: only its markers are listed; the *Whole notebook* toggle shows all. Tap a row: the panel closes and the page scrolls there. Tick a question: it is resolved on the page (and in the undo history). *Edit* changes the label.
184. **Invisible ink.** *Toggle invisible ink*, write an answer: it shows while the mode is on. Turn the mode off: the answer disappears; the eraser and the lasso do not touch it. *Show solutions (notebook)*: it is back; *Show or hide the solutions of this page* works per page. Export the page as PDF and SVG with the solutions hidden (no answer) and shown (answer present). Library thumbnails and embeds never show it.
185. **Sync and conflicts.** On two devices synced through Google Drive or OneDrive: resolve a question on device A and add a marker on device B before syncing; merge the conflicted copy: the question is resolved once (no duplicate badge) and the new marker is there.
186. **Older plugin.** Open a notebook saved by this version with an older one (0.5.x / wave 0.6 build): it opens read-only (format v8) with a backup; nothing is rewritten.
187. **Phone.** On a phone: the dialogs, the panel rows (checkbox, label, *Edit*) and the date picker are usable with a finger; badges can be tapped at 100 % zoom.

### Pen gestures (wave 0.8, steps 188-199)

Not verified on a device. Fill in the result table at the end of this file.

188. **Nothing starts by itself.** With a clean settings file, write words, numbers, circles, arrows, a "#", a star and a "?" with the pen as normal ink. Expected: all of it stays ink; no label appears and nothing is selected, deleted or opened.
189. **Gesture mode.** *Gesture mode* toggle (All actions sheet, or the command). Expected: a *Gesture mode* badge at the top. Draw a circle around some words: while you draw, a label *Select* appears beside the pen once the loop closes; lift: the words are selected and no line is left. A finger still pans and zooms. Leave the mode with the badge's cross or the menu.
190. **Preview and cancel.** In the mode, draw a straight line outward and come back along it to the start, then lift. Expected: the label reads *Cancelled* and nothing changes. Draw a scribble over a word: the label says *Delete* before you lift; lift: the word is gone.
191. **Delete and undo.** Scribble over a word, lift, press Undo once. Expected: the word is back and the scribble you drew is on the page as ink; Undo again removes the scribble ink.
192. **Insert space.** Draw a "^" between two lines of writing. Expected: the lines below move down by the amount in the settings (default 48 pt); Undo restores them (and leaves the "^" as ink; Undo again removes it). On an empty part of the page: a notice says there is nothing to move.
193. **Tags, bookmark, search.** Draw a "#" in one stroke: the page tags editor opens. Draw a five-pointed star in one stroke: the page is bookmarked (a notice); again: the bookmark is removed. Draw a "?": the search bar opens.
194. **Move a selection.** Open the page panel, select some ink with the lasso (or the circle gesture), enter gesture mode and draw a line from the selection onto another page's thumbnail. Expected: the label says *Move to page N* before you lift; lifting moves the ink in place; Undo brings it back.
195. **Side button.** Settings → *Pen side button* → *Pen gestures while held*. Hold the button and draw a circle around ink, then a scribble. Expected: gestures work only while the button is held; without it the pen writes. Report what the Pen button test shows for your pen.
196. **Long press.** Settings → *Long press starts a gesture* on. Rest the pen on the page for about a second, then draw a circle. Expected: a short vibration, the dot disappears and the circle is a gesture. Write normally with pauses in the middle of words: nothing may turn into a gesture. Report false positives.
197. **Custom gesture.** Settings → *Custom gestures* → *New custom gesture*: name it, choose a command (for example *Open daily note* or *Toggle pen gesture mode*), draw a "Z" three times on the pad. Then in gesture mode draw the "Z" on the page. Expected: its name appears beside the pen and lifting runs the command. Try recording a circle (refused: looks like a built-in gesture) and three different shapes (refused: too different).
198. **Cheat sheet and switches.** Open the cheat sheet from the badge's question mark. Turn off *Insert space* and draw a "^": nothing happens, the label does not appear.
199. **Defaults and writing.** After updating, *Pen side button* is still *Radial menu on click, erase while held*, *Long press starts a gesture* is off, and writing, shapes by holding still, scribble erase and the radial menu behave exactly as before.

### Page operations, stable links, quiet while writing (wave 0.8, steps 200-206)

Not verified on a device. Fill in the result table at the end of this file.

200. **Select pages.** Open the page panel in a notebook with 10+ pages. Tap the select button (check-square). Tap three pages, then use *Select a range* and tap the last page of a run. Expected: ticks on the thumbnails, the count in the bar, *Select all pages shown* ticks the pages the filters show. On a touch screen: press and hold a thumbnail. Expected: it is selected and picked up like before; letting go without moving only selects it; with a selection active, press and hold another thumbnail adds the range. A quick swipe still scrolls the list. Escape or the X ends the selection.
201. **Move and duplicate.** Select 3 non-adjacent pages, *Actions*, *Move to the start*, then undo (one step brings every page back). *Move to position…* with 5, *Move to the end*, *Duplicate* (copies appear after the last selected page), *Move to notebook…* (the usual dialog opens with these pages ticked; each notebook gets one undo step).
202. **Paper, size, tags, bookmarks, export, delete.** On a selection: *Change paper…*, *Change size…* (each page keeps its orientation), *Add tags…*, *Remove tag #x*, *Bookmark* (and again to remove), *Export as PDF* (file name with `p3-5` or `selection`), *Delete…* (asks first; *Deleted pages…* shows the copies; undo restores the pages in place). Expected: one undo step each; selecting every page disables *Delete…*.
203. **Copy link, insert link, embed.** Page menu → *Copy link to this page*, paste into a note: the link ends in `#p3&id=…`. Reorder the pages in the notebook and follow the link from the note. Expected: it opens the same page, not page 3. Insert an embed and check the same.
204. **Other generated links.** Turn on companion notes: the *↗ Page* links of a companion note carry `&id=…` (the note is rewritten once). Export PDF annotations: the *Open page* links too. Type `[[Notebook.notebook#` in a note and pick a page: `p3&id=…` is written. Via the API: `await api.getPageLink("Notebooks/Physics", 3)`.
205. **Update links.** In a note write `[[Physics.notebook#p3]]` (old style), reorder the notebook, run *Update links to notebook pages…*. Expected: a list (nothing changed yet) with the link and *tied to the page that has this number now*; untick it and apply: the note is unchanged; run again and apply: the link gets `&id=…`. A link whose page moved gets its number fixed; a link to a deleted page is listed under *Left as they are*.
206. **Do not disturb.** Write with the pen continuously (the S Pen) and, meanwhile, trigger something that shows a notice (for example a PDF export from the page menu started just before, or *Copy link*). Expected: the notice does not appear while the pen is on the screen; it appears about 1.5 s after the last stroke. Page-panel thumbnails and the library cover thumbnails draw after you stop. Note anything that still interrupts (Obsidian's own notices cannot be held back).

### Zettelkasten inbox (wave 0.8, steps 207-211)

Not verified on a device. Fill in the result table at the end of this file.

207. **Inbox of loose notes.** On the quick-notes sheet write three separate jots a few centimetres apart, and type one line in a text box. Run *Open the inbox*. Expected: every separate jot (and the typed line) is its own item showing its ink or text; writing that is close together is one item, not split. The list is empty when nothing is left to process.
208. **Process.** Select an item and make a *permanent card*: the card dialog starts with a title taken from the text, the type and the typed text as the first content of the *Transcription* section. Create it: the item leaves the list and the next open item is selected. Repeat with *Link to a card* (search and pick one), *Discard* and *Skip*. Expected: nothing is deleted from the notebook; *Show processed* lists the processed items and one can be reopened. The command *Process the next inbox item* selects the first open item.
209. **New writing.** Process a jot, then write more in the same block on the quick-notes sheet. Expected: it comes back among the open items.
210. **PDF highlights.** In a notebook with PDF pages add a highlight and a comment on a page, then open the inbox. Expected: they are listed with the PDF and page as their source; making a *literature card* starts with the PDF source and the highlighted words as the first content of *Transcription*. A highlight on a PDF without a text layer has no text for the card.
211. **Two devices.** Process an item on device A, wait for the sync, open the inbox on B: the item is processed there too; process another one on B. Expected: `Notebooks/_meta/inbox-<device>.json` exists once per device and no conflicted copies appear. Cut one of the files in a text editor and process an item on that device: a notice says the file cannot be read, a copy is kept and the file is not overwritten.

### Textbook references (wave 0.8, steps 212-214)

Not verified on a device. Fill in the result table at the end of this file.

212. **Set up.** Command *Set textbook for this notebook…*: choose a PDF of the vault, the scope (this notebook, its folder, all notebooks), a page offset (for example 10) and a name. Expected: `Notebooks/_meta/textbooks-<device>.json` appears; *Remove a textbook…* takes it away again.
213. **Slides open.** In a text box type "p. 134", "pag. 134", "p134", "pp. 134-136" and "page 7". Expected: each is underlined; the text is unchanged. Tap one with a PDF pane open beside the notes: the textbook opens at that page (printed page plus the offset) in the pane. With the pane showing other slides, a tap opens Obsidian's PDF viewer instead; a long press or right click offers both and the other textbooks. While the text tool is active the underline is hidden.
214. **Insert and writing.** Run *Insert textbook reference* after writing with the pen: "p. N" is typed at the last pen position as one undo step. Run *Open textbook at a page…* and type a page. Write next to and over a reference with the S Pen: ink is written as usual (a stroke cannot start exactly on the reference), with no extra latency.

### Redo the exercise (practice copies, #303; wave 0.8, steps 215-224)

Redo the exercise (practice copies, roadmap #303; wave 0.9). Setup: a notebook with a PDF page (any exercise sheet) and a plain page, each with a few strokes in black pen, red pen and the highlighter, plus one text box.

215. **Redo, hide everything.** On the PDF page open the page sheet (tap the page indicator) > *Redo this exercise…* (or the command *Redo this exercise*). The dialog says "attempt 1" and, with *All my ink*, how many strokes will be hidden (all of them). *Right after this page* > *Create practice page*: a new page appears right after the original, scrolled to, with the same PDF background, margins and text box and none of the strokes; a notice says attempt 1. The original is untouched. *Undo* removes the new page in one step; *Redo* brings it back.
216. **Hide by colour and by tool.** Redo the same page again, choose *Only some colours or tools*, tick red: the summary counts only the red strokes; confirm. The copy keeps the black ink and the highlighter and loses the red. Another time tick *Highlighter* only, then red and *Pen* together (a stroke must match both). With nothing ticked the button is disabled.
217. **Hide the selection.** With the lasso select a few strokes (e.g. the working but not the statement notes), open *Redo this exercise…*: the choice *Only the selection (n strokes)* is there; confirm. Only those strokes are missing in the copy. Without a selection that choice is not offered.
218. **The strip and the tags.** On a copy a strip shows "Practice, attempt n" with *Peek*, *Original*, *Attempts* and *Start*. *Page tags…* of the copy lists `practice` and `attempt/n` next to the tags of the original; the Pages panel filter by tag `practice` shows the copies. The strip is not shown on the original or on other pages and is not part of exports.
219. **Peek at the solution.** Press and hold *Peek* with a finger and with the pen: the original's hidden ink appears over the practice page (also the highlighter); let go (also by sliding off the button) and it is gone at once. Close and reopen the notebook: nothing of the peek is saved; export the page to PDF: the hidden ink is not in it. The command *Peek at the solution* switches the overlay on and off.
220. **Original and attempts.** *Original* scrolls to the original page. Redo again from the copy: the new copy is attempt 2 and starts from the original sheet (not from your first attempt's ink). *Attempts* (also on the original and as the command) lists the original and the attempts, each numbered and dated; tapping one goes to it. A copy deleted meanwhile says the page cannot be found.
221. **Exercises notebook.** In the dialog choose *In the exercises notebook* and confirm: a notebook called *Exercises* is created in the notebooks folder with the copy as its only page, and it opens on it. Redo another page the same way with *Exercises* closed, then open: the page was added at the end (a `before-move` copy is in `_backup`). With *Exercises* open in another tab the page appears there as one undo step and the file is saved. Change the name in the dialog to use another notebook. *Original* from there opens the source notebook at the page.
222. **Timer.** On a copy tap *Start*: the button counts up in seconds. Switch to the original and back: it kept running. Tap *Stop*: a notice shows the time and the button shows the total; the *Attempts* list shows it next to the attempt. Start again and close the notebook tab: reopen, the time was added. Check that this device's `_meta/practice-<device>.json` changes only on redo and on stop (an old `_meta/practice.json` is never changed).
223. **Links survive renames, moves and sync.** Rename the notebook and move it to another folder inside the notebooks folder: *Original* and *Attempts* still work. With a synced vault, make an attempt on two devices before they sync: after syncing both attempts are in the list (the numbers may repeat). Move the copy to another notebook (*Move to notebook…*): it keeps its tags but loses the link (strip says "Not linked to an original").
224. **Damaged links file and read-only.** Cut this device's `_meta/practice-<device>.json` in half (or empty it): *Redo this exercise…* says the file cannot be read, makes no copy and does not touch the file (a `practice.unreadable-…` copy appears next to it). With a notebook that is read-only (a file from a newer version) the page sheet shows the entry disabled and the command says the notebook cannot be edited: no copy is made.

### Links written with the pen (O8; wave 0.8, steps 225-232)

Not verified on a device. Fill in the result table at the end of this file.

225. **Link in a text box.** With the text tool write `See [[` : a list of your notes opens under the box. Type a few letters: the list narrows (closest names first). Choose one with the arrow keys and Enter, then with a finger tap on another try. Expected: the text becomes `See [[Note]]`, the box keeps the focus, nothing was drawn on the page below. Finish typing and leave the box: `[[Note]]` is drawn in blue, underlined. Try `[[Note|label]]` and `[[Note#` (the headings of that note are listed). Escape closes the list without leaving the box.
226. **Open a link.** Switch to the pen and tap the link with a finger. Expected: the note opens in a new tab (the notebook stays open). With a mouse, Ctrl/Cmd+click does the same and leaves no dot. With the text tool a tap edits the box instead. A tap next to the link does nothing.
227. **Unresolved link.** Type `[[A note that does not exist]]`: it is drawn dimmed with a dashed underline. Tap it: a dialog offers *Create note*. Create it: the note is created where Obsidian puts new notes, opens, and after a moment the link in the notebook is drawn normally. Try a name with a folder (`[[Projects/New]]`) and a name with a colon (a notice says it cannot be used).
228. **Ink link from the lasso.** Write a word. With the lasso circle it: the selection bar has *Link to a note…*. Tap it, search a note, choose it. Expected: a small label `[[Note]]` with a round badge appears just above the word, faintly tinted over the word; the word is unchanged. Tap the label and then the word itself with a finger: the note opens each time. Undo: the label disappears. Run the command *Link selection to a note…* with nothing selected: a notice says to circle ink first.
229. **Ink link moves with its ink.** Lasso-select the label (or select ink and label together) and drag: the ink under the label moves with it when *Ink follows objects* is on. Delete the label: you are asked about the ink as for any object.
230. **Handwritten brackets.** Write `[[` as two brackets with the S Pen. Expected: a *Link to a note…* chip appears under the brackets. Write a note name next to them: the chip stays (and moves under the whole line). Tap it, choose a note: the label is attached to the brackets and the name. Now write `l1`, `||`, `(( ))`, `[ ]`, `a[i]` and a few lines of ordinary text: no chip may appear. Write `[[` and ignore the chip: it disappears after about 10 seconds, when you write on the next line, when you scroll or undo. Note anything that was missed or wrongly offered, with your handwriting style (size, speed).
231. **Companion note.** With *Companion notes* on, wait a few seconds after steps 225-228: the companion note shows `[[Note]]` under the page heading (once for an ink link, without a column of empty lines), and the linked note shows the companion note in Backlinks and the graph. Rename the linked note: check what happens to the link in the notebook (it is not updated; the link becomes dimmed).
232. **No interference.** With *Draw with finger* off, pan and pinch over a link: the tap opens only when the finger barely moves and lifts quickly. With *Draw with finger* on, tapping a link draws a dot and does not open it. While writing with the S Pen near a link nothing opens. Check that writing latency feels the same on a page full of links.

### Equations and graphs (wave 0.9: math, steps 233-248)

Not verified in Obsidian (the harness uses a stand-in for MathJax) or on a device. Fill in the result table at the end of this file.

233. **Insert an equation.** Write a line of handwriting, scroll so it is in the middle of the view, then ⊞ *All actions* → Insert → *Insert equation*. Expected: the editor opens next to the middle of the view with the size already close to your handwriting. Type `\frac{a}{b} = \sqrt{x^2+1}`: the preview updates while typing. *Done*: the equation is on the page, selected, as large as the handwriting next to it. Undo removes it, redo brings it back.
234. **Palette and styles.** Open it again (select it, *Edit* on the contextual bar). Use every palette button (fraction, roots, power, subscript, matrix, integral, sum, limit, system, aligned); each inserts its structure at the caret. Switch *Inline* on and off (fractions get smaller), turn *Numbered* on: "(1)" appears at its right. Add a second numbered equation above it: the numbers follow the reading order. Change size and colour.
235. **TeX error.** Type `\frac{a}{`: the preview shows MathJax's error and *Done* keeps the source, shown as LaTeX text on the page, with a notice.
236. **Aligned derivation.** Insert `\begin{aligned} (a+b)^2 &= (a+b)(a+b) \\ &= a^2+2ab+b^2 \end{aligned}`: the lines are aligned on "=". Large and multi-line equations stay sharp when you zoom to 400 %.
237. **Move and scale.** Select an equation with the lasso, move and scale it: it stays sharp, the number follows. Write next to it with the pen: the ink is not changed.
238. **Exports.** Export the page as PDF and SVG. Open both: equations and graphs are vectors (zoom in a viewer: no pixels), the graph is clipped to its frame, the shaded area is translucent, numbers and labels are there.
239. **Convert to ink.** Select an equation, *Convert to ink*: it is replaced by strokes in its colour that look like the equation; erase part of it with the segment eraser; undo twice brings the equation back.
240. **Insert a graph.** *Insert graph*: a graph of sin(x) appears and its panel opens. Change the expression to `x^2 - 2`: the curve updates while typing. Turn on *Roots* and *Max and min*: the points ±1.414 and (0, -2) are marked and labelled. Type something wrong (`sin(`): the curve disappears and the panel and the legend say why; fix it.
241. **Every kind.** Add a parametric (`cos(t)`, `sin(2t)`), a polar (`1 + cos(θ)`), an implicit (`x^2 + y^2 = 4`: a closed circle) and a piecewise function (`-x` when `x < 0`, otherwise `x^2`). Each has its own colour; hide and show one with the eye button. `tan(x)` and `1/x` have no vertical lines at their poles.
242. **Parameters.** *Add parameter* (a), write `a sin(x)`: drag the slider: the curve follows live. Change min, max and step. Add an intersection between two functions, a tangent at x = 1 (dashed, with its equation) and an area from 0 to 3.14 (shaded, with its value).
243. **Pan, zoom and ink.** Close the panel (*Done*), write a note with the pen next to a root on the graph. Open the panel again (*Edit*). Drag inside the graph with a finger: the plane moves and the note moves with it; pinch to zoom (with a mouse: the wheel; Shift zooms x only): the note stays next to the root. *Done*: one undo puts the graph and the note back. Move the graph with the lasso: the note follows (with *Ink follows objects* on).
244. **View and table.** In the panel: zoom buttons, *Reset view*, the four range fields, axes and grid on/off, labels, steps, *Degrees* (`sin(x)` then has a period of 360). Choose a function for the *Table of values*: a table appears in the top left of the graph.
245. **Leave without Done.** With the panel open, tap the page outside the graph, switch tools or close the tab: the changes are kept (one undo step). *Cancel* or Escape drops them.
246. **Older plugin and sync.** Open a notebook with equations and graphs with a build that reads up to v8: it opens read-only with a backup. Edit a graph's expression on device A and its parameter on device B, then merge the conflicted copy: both versions are kept.
247. **Phone.** On a phone: the editor and the panel (a bottom sheet) are usable with a finger, the palette buttons are easy to hit, the panel scrolls, the slider can be dragged.
248. **With the other wave 0.9 features.** *Export…* the page with *Ink only*: equations and graphs are there; with *Background only*: they are not. Turn on night mode: equations take light colours, a graph turns dark with light lines and curves; exports stay in day colours. Select two overlapping graphs and use *To front*/*To back*: their order changes (a graph never goes above a text box). *Export as Markdown with page images*: `notebook.md` has the equations as `$$…$$` blocks (the numbered one with `\tag{1}`), which Obsidian renders; the page images show the graphs. *Page information* lists the equations and graphs.

### Obsidian toolbar, bookmarks, page turner, toolbar size (wave 0.9, steps 249-256)

Not verified on a device. Fill in the result table at the end of this file.

249. **Mobile toolbar.** On the phone or tablet: Settings > Mobile > toolbar: add *Notebook: Next page*, *Previous page*, *Undo (notebook)*, *Add page* and *Add page to Obsidian bookmarks*. Open a notebook: the buttons show the plugin's icons and run the commands; on a note they are inactive or hidden.
250. **Bookmark a page.** Turn on the core *Bookmarks* plugin. In a notebook open the page sheet (page indicator) > *Add page to Obsidian bookmarks*: a notice confirms and the Bookmarks pane lists "<notebook>, p. N". Do it again: "Already in the Bookmarks pane". Add a bookmark from the All actions sheet and from the command palette (it bookmarks the page in view).
251. **Open a bookmark.** Insert a page before the bookmarked page, close the notebook, tap the bookmark: the notebook opens on the bookmarked page (not on the old number). With the notebook already open on another page, tap the bookmark: it scrolls to the page. Delete the page and tap the bookmark: a notice says the page was deleted. Turn the Bookmarks plugin off and run the command: a notice says it is not available.
252. **Keyboard.** With a keyboard attached (or on Windows): PageDown, ArrowRight, ArrowDown and space go to the next page, PageUp, ArrowLeft, ArrowUp and Shift+space to the previous one, in continuous and in one-page-at-a-time mode. Ctrl+PageDown does not turn the page. After tapping a toolbar button the arrows still turn pages.
253. **Clicker and no-go cases.** With a Bluetooth presentation clicker paired: the forward and back buttons turn pages. While editing a text box, typing in the search field or in a dialog, or with the radial menu open, the keys do not turn pages. Turn off *Turn pages with the keyboard*: the keys do nothing. Press the volume keys: they change the volume and never turn pages (documented, not a bug).
254. **Large toolbar on the phone.** Settings > *Toolbar size* > Large. On a phone in portrait: the toolbar tools wrap onto a second line, nothing is cut off or scrolls sideways, all buttons are easy to hit with a finger. Open the tool options, the All actions sheet, the page sheet and, after selecting ink with the lasso, the contextual bar: they all fit the screen.
255. **Large on the tablet, compact.** On the tablet in large: bigger buttons and icons in one or two rows, fewer quick actions. Hold the pen button: the radial menu is larger and still entirely on screen. Switch to Compact: smaller buttons and a smaller dial, more quick actions. Switch back to Normal: as before.
256. **Persistence.** Close and reopen Obsidian: the size and the keyboard setting are kept; another open notebook view follows a size change without reopening.

### Text and objects (wave 0.9, steps 257-264)

Not verified on a device. Setup: a notebook with at least three pages (plain paper), a text box with a few words, two overlapping images and a highlighter stroke over some pen ink.

257. **Bring to front, send to back.** With the lasso select the highlighter stroke that covers the pen ink. The contextual bar shows *To front* and *To back* (on a narrow phone use the ⊞ *All actions* sheet, they are there). Tap *To back*: the highlighter now sits behind the pen ink (the selection is released so you can see it). Select it again and tap *To front*: it covers the ink again. Undo, redo: each is one step. *To front* on something already in front says there is nothing to reorder.
258. **Forward and backward.** Select the lower of the two overlapping images, ⊞ *All actions* → *Move selection forward* (also from the command palette): it passes the other image. *Move selection backward* puts it back. A selection of an image and a stroke moves both in one undo step. A text box never goes under an image and ink never goes under a text box or an image (by design: elements are drawn under the ink).
259. **After saving.** Reorder, close and reopen the notebook: the order is kept. Reorder a selection that includes a marker: it stays above the ink.
260. **Find.** ⊞ *All actions* → *Find and replace in text boxes* (or the command). Type a word that appears in text boxes on several pages: the panel lists each match with its page and some context, and the count. *Match case* and *Whole word* change the list. Tap a result: the page behind the panel scrolls to it; the arrow button does the same and closes the panel. Handwriting is not found. Enter in the Find box goes to the next result, Shift+Enter to the previous one.
261. **Replace.** Fill *Replace with*, choose a result and tap *Replace*: that match changes, the next one is chosen, a notice says so. *Undo* brings back that one match. A replacement that contains the searched word does not loop. *Replace all*: every match changes in all text boxes; one *Undo* restores all of them. The text box keeps its place, size and colour. On a read-only notebook the replace buttons are disabled and the panel says why.
262. **Phone.** The panel fields, the checkboxes and the result rows are usable with a finger; the keyboard does not hide the results list; the arrow button is the way to see the page on a small screen.
263. **Page information.** Page sheet (tap the page indicator) → *Page information* (also from the command palette). Check size, paper, number of strokes and points, objects, files and their size, tags, bookmark, markers, and the dates: *Notebook created* and *Notebook last saved* are the notebook's; *Page last edited on this device* is filled after you edit that page and says *Not recorded on this device* for a page you never edited here.
264. **A page in the middle.** With *Add a page when writing at the bottom* on, write in the bottom tenth of a page that is not the last: after the stroke a chip *Add a page after this one* appears over the lower part of the view. Put the pen down again: it goes away. Write at the bottom again: it returns. Tap it: a page with the same size and paper appears right after, the view moves there, and one *Undo* removes it. Ignore the chip: it disappears after about 9 seconds and does not return for that page. Nothing is added by itself. On the last page the page is still appended automatically; with the setting off nothing is offered; on a PDF, scanned or infinite page nothing is offered.

### Export and view (wave 0.9, steps 265-274)

Export and view (roadmap 381, 382, 367, 376; wave 0.9). Not verified in Obsidian or on a device. Setup: a notebook with a PDF page (slides with wide white margins), a plain ruled page and a grid page, each with pen strokes, the highlighter and a text box; one bookmark with a title on the PDF page and one without a title on the grid page; one page with invisible ink.

265. **Export dialog.** Open the page sheet of the PDF page > *Export…*: the dialog starts on "This page". Choose SVG, *Ink only* > *Export*: a notice shows `<Notebook> p1 ink.svg` next to the notebook. Open it in a browser or Inkscape: the writing and the text box on a transparent background, no paper, no PDF. Choose *Background only* in the same way: `… p1 background.svg` shows the PDF page and the paper with no writing. *Ink and background* gives the same file as the old *Export page as SVG*. Export the same choice twice: the second file is named with " 2"; nothing is replaced.
266. **PDF choices.** Same dialog, PDF, whole notebook, *Ink only*: `<Notebook> ink.pdf` has one page per notebook page, with the writing and text and no PDF page or paper behind them (white in a viewer); it is much smaller when the notebook has PDF pages. *Background only*: the PDF pages and the paper, no writing. The old *Export notebook as PDF* is unchanged.
267. **Whole notebook as SVG, invisible ink.** SVG, whole notebook: one file per page, `Name p1.svg`…, and a notice with the count. The page with invisible ink: its hidden strokes are in the file only if *Show solutions* is on for that page (or the notebook); switch it on and export again to check.
268. **Markdown export.** *All actions > Export as Markdown with page images…* (or the command). Keep the suggested folder (`<Notebook> (Markdown)` next to the notebook) and 150 dpi > *Export*. Expected: the folder has `page-001.png`, `page-002.png`, `page-003.png` and `notebook.md`. Open `notebook.md` in any Markdown viewer (VS Code, GitHub, a browser extension) with the PNGs next to it: the title, then each page as an image, the text box of a page below its image, a heading with the bookmark's title above the PDF page and "Page 3" above the grid page. Open a PNG: the PDF page with its writing, in colour, not rotated, sharp when zoomed in.
269. **Never overwrite.** Run the export again into the same folder: new files `page-001 2.png`… and `notebook 2.md`, whose links point at the " 2" files (check that the images show). Nothing from the first export changed (compare file times). Try a path that is an existing file: the dialog says it is a file and does not start. Try a folder inside a folder that does not exist: it is created.
270. **Resolutions and a long page.** Export at 100 and 200 dpi: the PNG widths are about 827 and 1654 px for an A4 page. Make an infinite page very long (scroll far down and write) and export: its PNG is smaller than the other pages (capped at 8192 px a side) but complete. On a phone, check that the export of a 30-page notebook finishes without the app being closed by the system, and that the notice counts up.
271. **Night mode.** *All actions > Night mode*: the pages turn dark, black ink is light grey, red/blue/green/orange ink are lighter versions of the same colours, the grid lines are dim, a text box is readable, a PDF page is dimmed (not inverted). Write with the pen in black and in blue: while writing it already has the night colour (no flash of dark ink). Write with the highlighter in yellow: it glows over the PDF text and over your ink, also while the stroke is being written. Switch it off: every colour is back exactly as it was (the stored colours never changed). Export a page to PDF with it on: the PDF is the normal white page. The page panel thumbnails stay white. Close and reopen the notebook: the mode is remembered.
272. **Crop margins.** Open a notebook made only of PDF pages with wide white margins on a phone. On a PDF page use *Crop PDF margins* on the bar at the bottom (or *All actions*): within a second or two the page is shown larger, with the text filling the screen width; the white sides are off screen. Scroll through the notebook: all pages keep the same zoom. Switch it off: back to the whole page. Write on a page with it on and off: the ink lands in the same place (check it with the toggle off).
273. **Ink in the margin, mixed notebooks, page by page.** Switch the crop off, write a note in the left margin of a PDF page, switch it on: the margin note is inside the view (the box is wider on that page). In a notebook with a plain page between PDF pages the crop does nothing in continuous mode (the plain page needs the whole width); in *page by page* mode each PDF page is cropped and the plain page is not. Turn pages with swipes: each page fits its own box.
274. **Nothing changes in the file; large PDFs.** With the crop on, make a change, close and reopen: the notebook, its ink and its exports are as before (an exported PDF is identical with the crop on and off). Open a 200-page PDF notebook and switch the crop on: the app stays responsive while pages are measured (the zoom may adjust a few times in the first seconds), and a blank page or a scan with a dark border does not crash or zoom absurdly.

### Tabs and automatic line break (wave 0.10, steps 275-280)

Not verified on a device. Setup: two or three notebooks (one with ruled paper, one with grid paper), the pen in pen-only mode.

275. **Tab strip.** Open two notebooks in two Obsidian tabs. With *Tabs of open notebooks* off, no strip shows. Turn it on in the settings: a strip with both names appears above the toolbar in each notebook, the notebook in view marked. Tap the other name: that notebook comes to the front. Open a third one: it is added. Close one: it disappears; with one notebook left the strip hides. Two notebooks with the same name show their folders.
276. **Swipe on the toolbar.** With two or more notebooks open, put two fingers on the toolbar strip and swipe left: the next notebook comes to the front; swipe right: the previous one. At the last / first notebook nothing happens. A one-finger drag, a pinch and a swipe with three fingers do nothing. Two fingers swiping on the page pan or zoom as before and never switch notebooks.
277. **Commands.** In the command palette, *Go to the next open notebook* and *Go to the previous open notebook* appear only with two or more notebooks open and go round at the ends.
278. **Line break off by default.** Zoom in to about 200 % on ruled paper and write to the right edge of the screen: lift the pen. The view stays where it is.
279. **Line break on.** Turn on *Automatic line break*. Write along a line to the right edge of the screen and lift the pen: after a short pause the view slides left so that the left edge of the page is at the left of the screen and the next ruled line is one line height below where the pen was. It never moves while the pen touches the screen; touching the screen during the slide stops it. Repeat on grid paper. On blank and dotted paper, and with the whole page width visible (zoom out), nothing moves.
280. **Limits.** Write on the last line of the page near the right edge: the view does not jump to a line outside the page. In one-page-at-a-time mode the view stays on the same page (it never turns to the next one). Near the bottom of the screen the view also moves up, as the *Scroll up when writing near the bottom* option does.

### Date and time stamp, selection across pages, clipboard (wave 0.10, steps 281-294)

Not verified on a device. Setup: a notebook with at least three pages (plain paper) and some writing near the bottom of page 1 and the top of page 2; for steps 289 to 294 two devices (tablet and phone) with the same synced vault and a notebook open on each.

281. **Stamp at the pen.** Write a word with the pen, lift it, then ⊞ *All actions* → *Date and time stamp* (or the command from the palette). Expected: a text box with the date and time (`2026-10-29 14:05`) appears where the pen last touched, inside the page, and is selected; one *Undo* removes it. The text size and colour are the text tool's.

282. **Stamp without a pen position.** Open a notebook, scroll to another page without touching it with the pen and run the action: the stamp is in the middle of the page in view. Wait more than 5 minutes after the last pen touch and run it again: middle of the page again.

283. **Format.** Settings → *Date and time stamp format*: type `dddd D MMMM [at] HH:mm` and stamp: `Thursday 29 October at 14:05` (Italian names when Obsidian is in Italian). Clear the field: the default format returns. Try `hh:mm A`.

284. **Lasso over two pages.** Zoom out until the bottom of page 1 and the top of page 2 are on the screen. With the lasso draw a loop that starts on page 1 and ends on page 2, around writing on both. Expected: the writing on both pages is inside one dashed frame, with the handles at the corners of that frame (they may be over the gap between the pages).

285. **Move across.** Drag the selection down so that the writing from page 1 lies over page 2: while dragging it floats over the gap without being cut at the page edge. Lift: the writing that is over page 2 now belongs to page 2 (lasso it from page 2 alone to check; save and reopen), the writing that stayed over page 1 is on page 1. One *Undo* puts everything back where it was; *Redo* moves it again. Drag so that part ends outside every page: that part stays on its own page.

286. **Scale and delete.** Select across two pages again and drag the scale handle: all of it scales together. Select again and *Delete* (button or key): the writing on both pages goes; one *Undo* brings it back.

287. **Colour, copy, duplicate.** With a cross-page selection change the colour or width in the bar: the ink on both pages changes, one *Undo* restores both. *Copy*, go to page 3, *Paste*: the writing arrives as one piece. *Duplicate*: each page gets its copy next to its own original.

288. **Single page is unchanged.** Draw a lasso inside one page: it selects as before, with no frame over the gap, and moving it keeps it on its page. A lasso that touches a second page but encloses nothing there selects as before.

289. **Copy to other devices.** On the tablet lasso some writing and a picture, tap *Copy to other devices* in the selection bar (⊞ *All actions* on a narrow screen; also a command). Expected: a notice says it was copied. In the vault, `<notebooks folder>/_meta/clipboard-<device>.json` exists (the device id is 8 hex digits).

290. **Paste on the phone.** Wait until the vault has synced. On the phone open a notebook, choose the lasso tool and tap *Paste from another device…* (bar, ⊞ *All actions* or the command). Expected: a list with the copy from the tablet (strokes, pictures, text boxes, "2 min ago", "device xxxxxxxx"), newest first. Tap it: the writing and the picture appear in the middle of the page in view, selected, as one undo step. Paste it a second time: new copies (not the same objects).

291. **The phone's own clipboard is untouched.** On the phone copy something with the ordinary *Copy*, paste from the tablet, then *Paste*: the ordinary paste still pastes what you copied on the phone.

292. **Picture not synced yet.** Copy a picture on the tablet and, before the picture file reaches the phone (airplane mode or a paused sync), paste on the phone: the strokes arrive and a notice says a picture could not be found; paste again after the sync: the picture arrives.

293. **Damaged or empty file.** Cut this device's `clipboard-<device>.json` in half (or empty it) and tap *Copy to other devices*: a notice says the file cannot be read and nothing was written; the file is as you left it and one `clipboard.unreadable-….json` copy exists next to it (not for an empty file). Do the same to the other device's file: the paste list says some files cannot be read yet and still lists the others.

294. **Size limit and age.** Copy ten times: the file keeps the last five. Select an entire notebook's worth of ink (or paste a very large picture selection) and copy: a notice says the selection is too large (the cap is about 3 MB) and the file is not changed. Nothing is written to any clipboard file except by the copy action.

### Selection tools (wave 0.10, steps 295-314)

Selection tools (roadmap 63, 64, 38, 65; wave 0.10). Not verified on a device. Setup: a notebook with a page holding some pen words in black and red, a few highlighter strokes in two colours, a text box, a picture with a little ink written on it, and a page with invisible ink (*Show solutions* off).

295. **Rectangle mode.** Choose the lasso. The contextual bar shows *Paste*, *Rectangle selection* and *Select by colour or tool*. Tap *Rectangle selection*: it looks pressed. Tap the lasso button again: the tool options show *Lasso* | *Rectangle* with *Rectangle* chosen. Switch back with the options; the bar's button follows. The command *Rectangle selection (toggle)* does the same.
296. **Rectangle drag.** In rectangle mode drag with the S Pen from one corner of some writing to the opposite one: a dashed box follows the pen, and when you lift, the strokes and objects inside are selected with the usual handles. Drag in the other three directions (right to left, bottom to top). A tiny tap on a picture selects the picture. Try the pen's side-button lasso: it uses the same mode. Invisible ink inside the box is not selected until *Show solutions* is on.
297. **Move, scale, rotate after a rectangle.** The selection moves, scales and rotates with its handles as after a lasso, and the contextual bar offers the same actions; *Undo* undoes one move.
298. **Select similar, same colour.** Select one red word. On the second row of the bar tap *Select similar*, then *Same colour*: every red stroke on the page (and red text boxes) is selected, black ones are not. A notice says how many.
299. **Select similar, same tool.** Select one highlighter stroke, *Select similar* > *Same tool*: all highlighter strokes on the page, whatever their colour, and nothing else. With a picture only selected the *Select similar* button is not shown.
300. **The picker.** With nothing selected, lasso, *Select by colour or tool*: a panel lists *Tool* (Pen, Highlighter), *Colour* (each colour in hex with a dot) and, if the page mixes, *Tool and colour*, each with a count. Tap *Highlighter*: all highlighter strokes are selected. Open it again on a page without ink: it says there is none. Invisible ink does not appear in the counts until *Show solutions* is on.
301. **Align.** Select three separate words at different places. *Align and distribute* (second row) opens a menu: *Align left*, *centre*, *right*, *top*, *middle*, *bottom*, *Distribute horizontally*, *Distribute vertically*. Try each: the words line up on the edge or centre of the whole selection and each word stays whole (letters do not separate). Each choice is one undo step.
302. **Distribute.** Three or more words or drawings in a row with uneven gaps: *Distribute horizontally* makes the gaps equal and keeps the outer two where they are; *Distribute vertically* does the same in a column. With only two items the notice says at least three separate groups are needed.
303. **Pictures, text boxes and ink on a picture.** Select a picture, a text box and a word; *Align top* lines the three up. With *Ink follows objects* on, the ink written on the picture moves with it (select the picture only, align it with something else). With the setting off the ink stays where it is.
304. **Nothing to do.** Align left twice in a row: the second time a notice says nothing moved. One group only: the notice says at least two separate groups are needed. Strokes that touch (a letter and its dot) count as one group.
305. **Rotate.** Select a word written with a varying pressure and a picture; *Rotate, mirror, size* > *Rotate 90° clockwise*: both turn a quarter turn about the middle of the selection, the thickness of the writing varies as before, and the picture is turned (its rotation changes). *Anticlockwise* turns it back. Four turns bring everything back. Undo is one step.
306. **Mirror.** Select a word and a drawing; *Mirror left to right*: the writing is reversed like in a mirror and the positions swap sides within the selection; *Mirror top to bottom* flips it upside down. Do it twice: back to the original. With a picture or a text box in the selection a notice says they were moved to the mirrored place but not flipped.
307. **Exact size.** Select a drawing; *Rotate, mirror, size* > *Exact size…*: the panel shows the width and height in pt. With *Keep proportions* on, type a width: the height follows. Switch it off and type both. *Apply* (or Enter): the selection has that size (check with a ruler on the page or by reopening the panel: within a point, thickness included), the top-left corner stayed. A picture is exactly that size. Zero or letters: the panel says to enter a positive size and changes nothing. Undo restores the size in one step.
308. **After saving.** Do each of the above, close and reopen the notebook: results are kept. Open the notebook in 0.9.0 (or look at the version in the file): the format is unchanged.
309. **Phone.** At about 360 px wide the selection bar has two rows that fit the screen, every button is at least 40 px, the menus open next to the bar and can be used with a finger, and the panels (picker, size) fit with the keyboard open.
310. **Sheet and commands.** ⊞ *All actions* with a selection shows the *Selection* section with Align, Distribute, Rotate, Mirror, Exact size and *Same colour / tool*; the command palette has the same commands (*Align selection to the left*…, *Set the exact size of the selection…*) and they do nothing without a selection (the palette hides them). Bind a hotkey to *Rotate selection 90° clockwise* and try it.
311. **Italian.** In Italian the second row, the menus, the panels and the notices are translated (*Seleziona simili*, *Allinea e distribuisci*, *Dimensione esatta…*).
312. **Pen and palm.** In rectangle mode keep a palm on the screen while dragging with the pen: no stray selection; a finger drag pans as usual (pen-only mode).
313. **Many strokes.** On a page with a few hundred strokes select all with a big rectangle and *Rotate 90°*, *Mirror* and *Exact size*: each answers in about a second on the tablet, and undo is as fast.
314. **Read-only and other pages.** A notebook opened read-only (another device has it open): the selection tools are disabled. *Select by colour or tool* picks from the page you are on, not another one; with a selection it picks from the selection's page.

### Navigation: history, fast scrollbar, status bar (wave 0.10, steps 315-334)

Navigation features (roadmap 18, 50, O15; wave 0.10). Not verified in Obsidian or on a device. Setup: two notebooks, one with at least 20 pages (a PDF one is best), the other with 5. Steps 315-320 are Back and Forward, 321-327 the fast scrollbar, 328-332 the status bar, 333-334 settings and checks.

315. **Back and Forward appear.** Open the long notebook. The toolbar has no Back or Forward yet. Use *Go to page number…* to jump from page 1 to 12. Expected: with enough width (tablet, desktop) *Back* shows among the quick slots after the insert and add-page buttons; on a phone it is in the page sheet (tap the page indicator, section *Go to*). *Forward* is there too but dimmed.
316. **Back and Forward work.** Tap *Back*: page 1 comes back (the page you left, not a page you passed). *Forward* is now enabled: tap it, page 12 returns. Turn pages one by one with the page-turn keys or by scrolling a few pages: neither adds anything to the history.
317. **What counts as a jump.** From page 3 jump with: a tap on a thumbnail in the page panel; a bookmark in the outline; a result of *Find and replace in text boxes*; an entry of the end-of-lecture panel or a marker; a link to another page typed as `[[Notebook#p9]]` in a note. Each is one history entry: *Back* undoes them one at a time, in the reverse order.
318. **Across notebooks.** From page 6 of the long notebook open the short one with *Go to page…* or *Recently edited pages*. *Back* returns to page 6 of the long notebook (its tab is shown again); *Forward* goes to the short one. Rename the long notebook in the library and use *Back* again: the entry follows the new name; delete it and the entry is skipped.
319. **Deleted page, capped, session only.** Delete the page you jumped from, then *Back*: the entry is skipped (no message, the previous one is used). Make more than 50 jumps: the oldest are forgotten, the newest 50 are kept. Close and reopen Obsidian: the history is empty (it is not saved anywhere).
320. **Mouse buttons (desktop).** With the pointer over a notebook, the mouse's back button (button 4 on most mice) does *Back*, the forward button does *Forward*. When there is nothing to go back to, the button does what Obsidian does (its own tab history). Report if Obsidian's own navigation happens too: it means the plugin could not take the button.
321. **Scrollbar appears.** In the long notebook scroll with a finger. Expected: a thin thumb appears along the right edge and fades after about a second and a half; with a mouse it also appears when the pointer comes within about 28 px of the right edge and stays while the pointer is on it. Nothing appears while writing with the pen, and the thumb never starts a stroke or a pan when touched.
322. **Drag through the notebook.** Grab the thumb and drag it down and up. Expected: the page scrolls with it; a bubble beside the thumb shows "Page 7 of 20" and a small picture of that page. Dragging fast shows the page number at once and the picture a moment after you stop on a page; it never freezes or lags. Letting go leaves the page where it is, with no stroke drawn.
323. **Preview of a PDF page and of ink.** Drag over PDF pages and over pages with ink and images: the picture shows the PDF page and the writing like the page panel's thumbnail. Open the page panel first and scroll it: pictures that the panel has already drawn appear in the bubble at once.
324. **Long notebooks.** In a notebook with 100 or more pages the thumb keeps a usable size (at least 44 px) and one pixel of drag moves several pages; drag it slowly and the page number goes up one at a time.
325. **Zoom.** Zoom in (pinch) and drag the thumb: it still goes from the first page to the last. Zoom out until the whole notebook fits: the thumb disappears.
326. **One page at a time.** Switch to *One page at a time* (page sheet or quick slot): no scrollbar. Back to continuous: it returns on the next scroll.
327. **Back after a drag.** Drag the thumb from page 4 to page 18 and let go: *Back* goes to page 4, *Forward* to 18. A drag that ends on the page it started from adds nothing.
328. **Status bar (desktop).** With a notebook active, Obsidian's status bar shows "p. 3/12 · Saved" (page in view, and the save state). Scroll: the page number follows. Draw a stroke: the state changes to "Unsaved changes" or "Saving…" and back to "Saved". Make the file unwritable (or fill the disk) to see "Save failed" in red.
329. **Status bar: open the navigator.** Click the item (or Tab to it and press Enter or Space): the page panel opens. Click again with the panel open: it stays open.
330. **Status bar hides.** Switch to a Markdown note or the library: the item disappears. Back to the notebook: it returns. With two notebooks in split panes it follows the active one.
331. **Mobile.** On Android and iOS there is no status bar item (Obsidian mobile has none); the page number and save state stay in the toolbar as before. Nothing breaks and no item is created.
332. **Language.** With Obsidian in Italian the item, the bubble and the Back and Forward names are in Italian ("p. 3/12 · Salvato", "Pagina 7 di 20", *Indietro*, *Avanti*).
333. **Settings.** *Settings > Notebook > Fast scrollbar* off: the thumb never appears, even with the mouse at the edge. On: it returns without reopening the notebook.
334. **Nothing in the file.** Open and use all of the above, then close: the notebook file is unchanged (its modification time and size) if you did not write; no new file appears in the vault or in the plugin folder.

### Library: pinned, archived, manual order, library check (wave 0.10, steps 335-349)

Not verified in Obsidian or on a device. Setup: a notebooks folder with at least six notebooks in two folders (names A to F), one tagged `maths`, one favourite; PDF notebooks among them so that `_assets` has files.

335. **Pin and unpin.** Open the library, open the menu of notebook C (… button, right click, or long press on touch) > *Pin to the top*. C moves to a *Pinned* group at the top of the list, with a pin badge on its cover; the other notebooks are under *Other notebooks*. Pin D as well. Open a folder, a tag and *Favourites*: pinned notebooks are first there too (not in *Recent*). *Unpin* puts the notebook back. Close and reopen the library, then restart Obsidian: the pins are kept. In the file explorer the notebooks are where they were and none of them changed (check the modified time of a pinned notebook file).
336. **Archive and restore.** Menu of E > *Archive*: a notice says where it went and E disappears from the list, from the count next to *All notebooks*, from its folder, tag and *Favourites* views, from *Recent* and from the search (also *Everywhere*). An *Archived* entry with a count appears in the sidebar; open it: E is there, with a note that its file is not moved. Its menu has *Restore from the archive* and no pin or move entries. Restore it: it is back, in the same place as before. Archive the last notebook of a folder: the folder still exists with 0 notebooks. Archive every notebook: *All notebooks* says that everything is archived.
337. **The archive never touches files.** With E archived, look at the vault in the file explorer and in the Windows or Android file manager: E is in its original folder with its original name and modification time. Rename E from the file explorer while archived, restore it in the library: it is restored (the state follows the notebook, not its name).
338. **Manual order by dragging.** Sort by *Manual order*. A hint says how to reorder. Drag F onto B with the mouse (or the pen): F takes B's place and the others shift. Drag a pinned notebook onto an unpinned one: nothing happens (groups are separate). Drag onto a folder in the sidebar: the notebook still moves to that folder as before. Restart: the order is kept. Create a new notebook: it appears at the top of its group.
339. **Manual order on touch.** On the phone or tablet: long press a card until it lifts, drag it onto another card and release: it takes that place. Without dragging, the menu has *Move up* and *Move down* (the first notebook of a group has no *Move up*, the last no *Move down*): use them several times; each step moves the card by one. In another sort (for example *Name*) choose *Move down* on a notebook: the sort switches to *Manual order* with the list as it was shown, and that notebook is one place lower.
340. **Two devices.** With the vault synced between two devices (Google Drive or OneDrive folder sync): pin A and archive B on the phone, wait for the sync, open the library on the tablet: A is pinned and B is archived. On the tablet un-pin A and restore B, wait, check the phone: both changes arrived. Pin the same notebook on both devices before they sync: no conflicted copy of any `library-*.json` appears (each device has its own file in `<notebooks folder>/_meta/`: `library-<8 characters>.json`); after sync both show it pinned. Change the order on one device only: the other follows after sync.
341. **A damaged own file is never overwritten.** Close Obsidian, replace `_meta/library-<this device>.json` with some text that is not JSON (or empty it), open the library and pin a notebook: a notice says the settings of this device could not be saved and nothing changed; the file still holds your text and a `library.unreadable-<hash>.json` copy appears next to it. Put the file back (or delete it) and pin again: it works.
342. **Nothing else changed.** After steps 335-341 the notebooks open, edit and save as before; the folder tree, the search, the trash and the version history are unchanged; the library index still works after deleting `library-index.json` from the plugin folder (it is rebuilt; pinned, archived and the order are still there because they are not in the index).
343. **Check the library.** Library sidebar > *Check library* (also All actions > Notebooks and the command palette). A progress line counts notebooks, then a report: the number of notebooks and attachment files with their size, *Notebooks that cannot be read*, *Unused files* with a count and size, and a section with what is in use or kept. Run it again straight away: it is much faster.
344. **Unreadable notebooks are only listed.** Make a copy of a notebook, close Obsidian and damage the copy (delete the closing braces at the end, or type text into the middle). Check the library: the copy is under *Notebooks that cannot be read* with the reason; *Open* shows the notebook view with its repair banner. The file itself is not changed by the check (compare modified time and size). A notebook of a newer plugin version is listed apart as not damaged.
345. **Not downloaded is never damage.** With OneDrive Files On-Demand (Windows) or a sync app that shows placeholders: leave a notebook online-only, or create an empty file named `x.notebook` in the notebooks folder. Check the library: that file is under *Not downloaded yet*, not under unreadable, and the *Unused files* section says that unused files cannot be judged yet while files that could use them are missing (it shows how many). Make the file available (download it, or delete the empty one) and check again: the section is judged. An empty file in `_assets` is counted as still downloading and is not listed as unused.
346. **Unused files and the space they take.** Import a PDF as a notebook, then delete the notebook for good from the plugin trash (and empty the version history of that notebook, `_backup/history/<id>`, and the backups of it). Check the library: the file is counted as *look unused but are not offered yet*. Check again a day later (or move the clock of the device forward a day): now it is under *Unused files* with its size and the total. A file is offered only if an earlier check on this device, at least a day before, also found it unused, whatever its modification time says. The report counts files that backups or the trash still use as *kept* (not offered). A file you copy into `_assets` by hand with an asset-like name is judged like any other; a file with another name or in a subfolder is not looked at.
347. **Review and move aside.** Tap *Review and move aside…*: a list shows every file path with its size, a total, and says they are moved to `<notebooks folder>/_trash/assets/` inside the vault (not deleted) and how to put one back. Cancel: nothing happens. Open it again and confirm: a notice says how many files and how much space and where; the files are gone from `_assets` and are in `_trash/assets` (look in the file explorer: they are in the vault, not in the system trash or Obsidian's `.trash`). Move one back into `_assets` by hand: the library check lists it as new (not offered for a day). Set Obsidian's *Deleted files* to *Permanently delete* and repeat: the files are still only moved. With sync on two devices, the other device sees a move, and its notebooks and their pictures are intact.
348. **New and kept files are not offered.** Import a PDF as a notebook, then delete that notebook for good (library Trash > Delete) and check the library: the file is counted as not offered yet (first seen unused); so is a picture that arrived from another device before its notebook did. An asset used only by an old version-history snapshot, a notebook in the library trash, a template or a stamp is counted as kept and is not offered. A snapshot or backup that is only partly downloaded (cut off) makes the answer unsure: nothing is offered and the report says so. Once the trash is emptied, the snapshots have expired and an earlier check at least a day ago saw the file unused, it becomes an unused file.
349. **Safety when things change meanwhile.** Open the review list, then in another window save a notebook that uses one of the listed files (for example insert the file from another notebook through the page menu *Insert PDF*) and confirm: the notice says that file was left alone because it is in use again. With a notebook that is not downloaded appearing between the check and the confirmation, nothing is moved and a notice says why. Closing the dialog while it checks stops the check. **Open notebooks count:** insert a picture or PDF in a notebook and do not wait for it to be saved (or delete the page and keep the notebook open so that undo can bring it back): the check does not offer that file. A notebook that is damaged (listed under *cannot be read*) also makes the answer unsure: nothing is offered until it is repaired or removed.

### Read-only mode, PNG images and printing (wave 0.10, steps 350-364)

350. **Switch read-only mode on.** In a notebook with some writing: *All actions > Read-only mode* (or the command *Read-only mode*). Expected: a notice says what changed; in the toolbar a button with a lock replaces the pen indicator and the favourite pens (on a phone only the lock, in the accent colour); the tool buttons are greyed; the undo and redo buttons are greyed. In *All actions* the entry *Read-only mode* is shown as on.
351. **The pen changes nothing.** Select the eraser first, then switch the mode on. Rub the pen over the writing, write with the pen, press the S Pen side button: nothing is erased or written (the radial menu may open, but its tools do nothing). Try the highlighter, shape, text and lasso from the keyboard or the palette: the tool does not change.
352. **The finger reads.** With finger drawing on in the settings, drag one finger: the page scrolls (it does not write). Pinch to zoom. Tap a `[[link]]` written in a text box: it opens. Tap the page panel button and a thumbnail: you go to that page; the page panel cannot reorder or delete pages.
353. **No way to edit.** Try Ctrl+Z, Delete with a selection (select before switching on), paste, *Add page*, *Insert image*, a marker: none changes the notebook. Open the sheet: the editing actions are greyed, reading ones (fit to width, one page at a time, search, export) are not.
354. **Nothing is written.** Note the file modified time and whether the `_backup` folder has new files, then read for a minute in read-only mode and close the notebook. Expected: the modified time is the same (if you wrote something just before switching on, that is saved as usual first) and there are no new backups or versions.
355. **Switch it off.** Tap the lock button in the toolbar: a notice says you can write again, the pen indicator and favourites come back; write a stroke, undo it, redo it. The undo history from before the mode is still there.
356. **It ends with the notebook; per view.** Switch it on, open another notebook in the same tab: it opens editable. With the same notebook in two tabs, the mode is on in one only. With *Open read-only* from the other-device banner on, the mode and the banner work independently: switching the mode off keeps the banner read-only.
357. **PNG images.** *All actions > Export pages as PNG images…* (or *Export…* and PNG images). Keep the suggested folder `<Notebook> (PNG)`, scale 2x, the whole notebook > *Export*. Expected: one `page-001.png`, `page-002.png`… per page in that folder and a notice with the count. Open one: the page as in the PDF export, about twice the size of the page in points (an A4 page 1190 x 1684 px), sharp.
358. **Pages and layers.** In the dialog choose *Some pages…* and type `2-3, 5`: only `page-002.png`, `page-003.png`, `page-005.png` are written (real page numbers). Type `99` or `3-2` or `abc`: the dialog says what is wrong and does not start. Choose *Ink only*: the images are transparent where nothing is written. Export into the same folder again: new files `page-002 2.png`…; nothing is replaced. Try a folder path that is an existing file: refused.
359. **Ranges for PDF and SVG.** Export *Some pages…* `1-3` as PDF: `Name p1-3.pdf` with three pages; as SVG: three files `Name p1.svg`…; a range of one page gives `Name p4.pdf`.
360. **Print (desktop).** *Export…* > Print (or *All actions > Print…*), whole notebook. Expected: the system print dialog opens with one notebook page per sheet, without any of the app interface; the pages look like the PDF export. Save as PDF from the dialog and open it. Cancel the dialog: the app looks normal afterwards (no leftover blank area, no extra scrollbars). Print again right away.
361. **Print choices.** Print some pages (`2-3`), then with *Ink only* (the writing on white paper). A very long infinite page flows over several sheets instead of becoming tiny. Pages of different sizes (A4 and Letter, portrait and landscape) are each scaled to fit one sheet of the paper chosen in the dialog.
362. **No print on a phone or tablet.** On Android: *All actions*, the page sheet, the command palette and the *Export…* format list have no *Print…* entry. *Export pages as PNG images…* is there and works; share the folder images from the Files app.
363. **Big notebooks.** On the phone export a 30-page notebook (PDF pages included) as PNG at 3x: the notice counts up, the app is not closed by the system; a very large page is drawn smaller (at most 8192 px a side). Close Obsidian halfway: the images written so far stay, nothing is deleted.
364. **Exports in read-only mode.** With read-only mode on: *Export…* as PDF, SVG, PNG images and Print all work, and the notebook file is not changed (modified time).

### Colour picker and style eyedropper (wave 0.10: colours, steps 365-379)

Free colour picker with recent colours and an eyedropper (roadmap 7), style eyedropper (68). Not verified on a device. Setup: a notebook page with a few strokes: a red pen stroke, a thick green highlighter stroke, a thin blue pen stroke and a short line drawn with the shape tool, plus some typed text.

365. **Open the picker.** Tap the pen twice (or the current-pen indicator) to open the tool options. At the end of the colour row there are three new buttons: a rainbow circle (*Colour picker…*), a pipette (*Eyedropper*) and, for the pen, highlighter and shapes, a droplets icon (*Style eyedropper…*). Tap the rainbow circle: the options close and a panel opens at the top right of the page with a colour square, a hue bar, a hex field showing the colour in use, a pipette, an X and the recent colours (a hint while there are none). It stays inside the page area on a phone in portrait.
366. **Choose by area and hue.** Drag a finger or the pen in the square and on the hue bar: the pen colour in the current-pen indicator follows at once; write a few words and check they are in that colour. Lifting does not close the panel. Arrow keys (with a keyboard) on the square and on the hue bar also move the colour. Drag the hue bar to the far right and left: no jump, no error.
367. **Hex field.** Tap the hex field and type `#12ab34`, then Enter (or tap away): the pen takes that colour. Type `abc` (three digits, no hash) and Enter: the pen becomes `#aabbcc`. Type `#zzz`: the field turns red and the colour does not change. The on-screen keyboard does not hide the panel on the phone.
368. **Recent colours.** Every colour you finish choosing (lifting the finger, Enter in the hex field, a recent swatch, the eyedropper) appears first in the recent row; the same colour is not repeated; at most 12 are kept. Tap an older one: the pen takes it and it moves to the front. Close the notebook and Obsidian, open the notebook again, open the picker: the same recent colours are there (they are in the plugin settings, not in the notebook file).
369. **Which colour it changes.** With the highlighter selected, the picker edits the highlighter colour (the pen colour stays). With the eraser in *Colour* filter mode it edits the colour the eraser is limited to. With the lasso or *Space* tool selected it switches to the pen. Change the pen colour from a toolbar swatch or a favourite while the panel is open: the panel follows. The X, Escape (keyboard) and the *Colour picker…* command close it.
370. **From the dial.** Open the radial dial (S Pen button), tap the colour bubble, then the rainbow button on the ring: the dial closes and the same picker opens (no system colour dialog). Open the dial again, colour ring, tap the pipette: the dial closes and a notice says to tap the page.
371. **Eyedropper on the page.** Start the eyedropper (pipette in the options, on the dial, or the *Eyedropper* command). Put the pen (or a finger) down on the red stroke and keep it down: a small swatch with the hex colour shows above the contact and follows it as you move. Lift on the red stroke: the pen takes red (within a few shades, antialiasing) and the colour is in the recent list. Repeat with a finger on a high-density tablet and on a page zoomed in and zoomed out: the colour picked is the one under the contact (not a few millimetres away), also after zooming in to 300 %. Nothing is drawn and the undo stack does not change.
372. **Eyedropper limits.** Lift on empty paper: white (or the paper colour) is picked. The highlighter picks the colour as it looks on the paper (blended), not the original highlighter colour; a page in night mode picks what is shown. Escape (keyboard) ends the mode; so does a tap on the toolbar, the page panel or a button of the contextual bar (that tap then acts as usual); selecting another tool also ends it.
373. **Style eyedropper: pen.** Select the pen with a different colour and width. Start *Style eyedropper* (droplets in the options, or the command). Tap the thin blue stroke: the pen, its colour and its width become those of that stroke (a notice names them), the mode ends. Write a line: same colour and width as the blue one. Tap exactly on the stroke and a few millimetres beside it (about 1 cm with a finger is too far): the near tap works, the far one does not.
374. **Style eyedropper: highlighter and shape.** From the pen, start the style eyedropper and tap the green highlighter stroke: the tool becomes the highlighter with that colour and width. Tap the shape-tool line: you get the pen with the colour and width of that line (a shape's kind is not stored, so the shape tool is not selected).
375. **Style eyedropper misses and overlaps.** Tap empty paper or text: a notice says there is no stroke and the mode stays on; Escape or a tap on the toolbar ends it. Where a pen stroke crosses a highlighter stroke, a tap on the crossing takes the one drawn last (on top); a tap on the highlighter beside the crossing takes the highlighter.
376. **Hidden ink and read-only.** With invisible ink hidden (*Show solutions* off), tapping where hidden ink is takes nothing; turn *Show solutions* on and the hidden stroke can be tapped. On a read-only notebook (annotations hidden, or a notebook open on another device) the three actions are disabled.
377. **Commands and hotkeys.** The command palette lists *Colour picker…*, *Eyedropper: pick a colour from the page* and *Style eyedropper: take colour, width and tool from a stroke*; give one a hotkey and use it. In Italian the three names, the hints and the panel labels are in Italian.
378. **Phone.** On a phone in portrait the picker fits the width, the square and hue bar are easy to drag with a thumb, the buttons are at least 40 px, and the panel does not cover the toolbar. In large toolbar size and in the dark theme the panel and the loupe stay readable.
379. **Nothing else changes.** Write with the pen before and after using the picker and the eyedroppers: latency, smoothing and the look of the ink are the same. The notebook file is not changed by picking colours (no save is triggered by the picker or the eyedroppers alone), and a notebook written after using them opens in the previous version.

### UI language (steps 380-383)

380. **Language setting.** Settings, Notebook, *Language*: the choices are Automatic (follow Obsidian), English and Italiano. Pick Italiano: the settings tab is redrawn in Italian at once and a notice says that open notebooks update when reopened and command names after a restart. Pick English: back to English.
381. **Auto follows Obsidian.** With *Automatic*, set Obsidian to Italian (Settings, General, Language) and restart: the plugin is in Italian; with Obsidian in English, in English; with another Obsidian language, in English.
382. **Apply and reopen.** Choose a language different from Obsidian's, close and reopen a notebook and the library: toolbar, menus and notices use the chosen language. The choice survives a restart.
383. **Commands after restart.** After changing the language the command palette still shows the old names until Obsidian is restarted; after the restart they follow the new language.

### Anchored excerpts (format v10, roadmap 105, steps 384-403)

Not verified in Obsidian or on a device. Setup: notebook **A** with a PDF page (slides) and two plain pages, some handwriting on the PDF page; notebook **B** with one plain page. Keep a copy of both files.

384. **Excerpt a lassoed selection.** In A, lasso some handwriting on the PDF page. The contextual bar offers *Excerpt to page…* (on a narrow phone it may be in ⊞ *All actions* → Insert). Tap it: the go-to-page picker opens with *This page*, *Next page* and *A new page after page n*. Choose *Next page*: the view goes to that page, the excerpt (the handwriting and the PDF behind it) is in the middle, selected, with a small teal badge on its top-right corner; a notice says which page.
385. **Excerpt a bare PDF region.** Choose the lasso, with nothing selected the bar shows *Paste*, *Excerpt to page…*, *Copy as excerpt*. Tap *Excerpt to page…*: a notice asks to drag over the region. Drag a rectangle over a figure of the PDF (the dashed outline follows the pen). On lift the picker opens; type a page number and choose it. Expected: that page has the figure.
386. **Too small, cancel.** Arm *Excerpt to page…* and just tap: a notice says the region is too small and the next drag still outlines a region. Arm it again and close the picker without choosing: nothing is added (undo history unchanged).
387. **New page, undo.** Excerpt to *A new page after page n*: a page with the size and paper of that page is inserted with the excerpt. One undo removes both the excerpt and the new page; redo brings them back.
388. **Move, resize, never stretch.** Select the excerpt with the lasso, move it, scale it with a corner, try to rotate it: it moves and scales keeping its proportions and never rotates; the picture stays sharp after the scale. Write over it with the pen, then move the excerpt: the ink written on it moves with it (setting *Ink follows objects*).
389. **Copy, duplicate, delete.** Duplicate the excerpt, copy and paste it on another page of A, delete one: each copy keeps its badge and jumps to the same source. Undo restores the deleted one.
390. **Copy as excerpt to another notebook.** In A, lasso a region and tap *Copy as excerpt*: a notice says it was copied. Open B, choose the lasso, *Paste*: the excerpt appears in B with its picture.
391. **Live in the same notebook.** In A, keep the excerpt of step 384 and its source page both reachable. Write a new word on the source region, go back to the excerpt: the new word is in the excerpt (within about half a second). Erase it: it goes away in the excerpt too.
392. **Snapshot in another notebook.** In B, the pasted excerpt shows the region as it was when it was copied: write on the source region in A, reopen B: B's excerpt does not change (by design: snapshots of other notebooks are not refreshed).
393. **Exports and thumbnails.** Export the page of A holding the excerpt as PDF and SVG, and the notebook as Markdown with page images: the excerpt is in all three as a picture (no badge). The thumbnail in the pages panel shows it too.
394. **Hidden ink stays hidden.** Write invisible ink in a region, show the solutions, lasso it and excerpt it: the excerpt does not show the hidden ink (snapshot and live picture), and copy/paste of the excerpt does not reveal it.
395. **Jump back in the same notebook.** With the pen (not the lasso), tap the excerpt's badge in A: the view scrolls to the source page and a dashed outline marks the exact region for about two seconds. Nothing is written by the tap. Do it with a finger and with the mouse too. Start a stroke on the badge and draw away from it: the stroke is kept and nothing jumps.
396. **Go to source from the bar.** Lasso-select the excerpt: the bar shows *Go to source* first. Tap it: same jump as step 395. The command *Go to the source of the selected excerpt* in the palette does the same and is only offered with an excerpt selected.
397. **Jump to another notebook.** In B, tap the badge of the pasted excerpt: A opens (or its tab comes forward) at the source page with the region outlined, even after reordering A's pages (move the source page elsewhere first).
398. **Source page deleted.** In A, delete the source page of an excerpt (it goes to the page trash): the excerpt keeps its last picture (the snapshot), its badge turns grey; a tap on it says "Source not found" and nothing changes. Restore the page from the page trash: the badge is teal again and the excerpt is live again.
399. **Source notebook moved, renamed, deleted.** Move A to another folder (same name): the badge in B still opens it. Rename A: the badge in B still opens it (found by its document id) and the excerpt now stores the new path (one undo step in B). Create another notebook with A's old name: the badge still opens the real A, never the impostor. Delete A: the badge says the notebook is not found and nothing changes. Excerpts of A inside A keep working after the rename (same document id).
400. **A notebook made by this version in 0.10.x.** Copy A (with excerpts, saved by this version) to a vault with 0.10.x: it opens read-only with a warning and is not rewritten; a backup is kept. A v9 notebook opened by this version shows no change until the first edit, then it is written as v10.
401. **Damaged excerpt.** In a copy of A, edit the file in a text editor: set an excerpt's `asset` to `"nope"`, and remove the `source` of another. Open it: a notice reports details left out; the first excerpt keeps its anchor and jumps (live or placeholder), the second is gone; the backup of the original is kept. Saving writes a valid file.
402. **Sync both ways.** With a sync service, make an excerpt on device 1, sync, open on device 2: the excerpt shows (the snapshot file arrives with the vault's `_assets`; until it does, the excerpt is a placeholder or live). Tap the badge on device 2: the jump works.
403. **Pen gestures and markers around excerpts.** Arm a marker (lecture bar) and tap on an excerpt's badge: the marker is placed (an armed marker wins). With the eraser, touching the badge erases ink as usual and does not jump. With the lasso, a tap on the excerpt selects it. In read-only mode (wave 0.10), a finger or pen tap on the badge still jumps to the source and nothing is written; the PNG export and *Print* show the excerpt picture.

| Creation dialog (wave 0.12): one modal with the tabs *Notebook* and *Folder* (segmented control, close ×); Notebook: cover preview (generated art or an image, *Change cover*: pattern, colour, new variation, image from the vault or the device), name, description, folder list with icons, page template tiles drawn by the paper renderer (all 12 paper kinds), saved templates, page size A4 · A5 · B5 · Letter · Custom (mm), orientation; Folder: folder card preview (*Change colour*, *Change pattern*), name, description, location, icon row plus a Lucide icon search, eight subject colours plus the colour picker. Inline name errors (empty, invalid characters, taken ignoring case, a trailing dot or space, Windows device names, the plugin's own folders in the notebooks folder), Enter submits; a full-height sheet with the preview on top on a phone; decoration off with reduced motion. Registry actions `new-notebook`, `new-folder` (command *New notebook* keeps its id `create`) | ✅ | ✅ `tests/create-dialog.test.ts` (name rules, sizes and orientation, custom sides, folder list without reserved folders, start folder, the new document with exactly the chosen settings, registry); harness scenario `create` (tablet and phone, light and dark: both tabs, focus, every paper kind with a preview, sizes, 40 px targets, no sideways overflow, the inline errors, pen / finger / mouse taps, Enter creates with exactly the chosen paper, size, orientation, cover and description, arrow keys switch tabs, folder list, folder created with its metadata, a rename moves it); ❌ Obsidian's real modal, the soft keyboard, the device image picker, the icon search with Obsidian's icon list | | ✅ | steps 450-469; the library and home cards that show folder colours, icons and notebook covers are wired at merge (LIBHOME) |
| Notes ↔ slide link (#226, format v12): ink written while a PDF page is beside the notes names an entry of the document's `slides` table (one entry per slide, added in the same undo step); badge next to linked ink (tap: the slide in the pane, its file opened if needed); *Show slide* prefers the selected ink's slide; settings *Link notes to slides*, *Slide badges*; v11 → v12 migration, lenient read, strict write without unused entries or dangling ids, staged loading of large v11/v12 files, copies and conflicted-copy merge keep the link | ✅ | ✅ `tests/model-v12.test.ts`; harness scenario `slides`; ❌ a real S Pen, a real PDF in the pane | | 🧪 | steps 720-731 |
| Slide strip (#417): per slide its page, linked notes pages, exercise page after it, ink written beside it or in its margin, its questions; filter *With notes* / *All slides*; empty state with *Open PDF side by side* | ✅ | ✅ `tests/slide-strip.test.ts`; harness scenario `slides` (tablet and phone, light and dark) | | 🧪 | steps 732-739 |
| Pen sets per subject (0.15, roadmap 134): named lists of pens saved in the plugin settings (starter sets Maths, Languages, Science, all editable); a set is assigned to a folder or one notebook (document id), bounded and read leniently; opening a notebook puts notebook > nearest folder > favourite pens on the strip without touching the favourites; switcher chip in the pen options, *Save current pens as a set*, manager (rename, replace, delete, folders, restore starters); no document format change | ✅ | ✅ `tests/pen-sets.test.ts` (resolution order, settings parsing, editing); ✅ harness scenario `pensets` (folder set, notebook set beats folder, deleted set falls back, chip visible for the pen and hidden for the eraser; tablet and phone, light and dark); ❌ the menu and the manager in Obsidian | | 🧪 | steps 880-895 |
| Drawings with states (#241, format v13): `Page.states` (parts of strokes, named states, per-state shift / rotation / scale / visibility / colour, the state shown); v12 → v13 migration (a stray `states` key in a v12 file is dropped, large v12 files still stage), lenient read and strict write, pruning, repair, page copy / trash / move / restore, conflicted-copy merge; the transform is applied only when the page is drawn or exported (`liveStateView`) | ✅ | ✅ `tests/model-v13.test.ts`, `tests/states-fixes.test.ts` (margins moved pivots) | | 🧪 | steps 814-816, 818 |
| State strip and part editor: switch, step, play, add / rename / duplicate / delete states, make / dissolve parts, move a part in a state with the selection handles (one undo step), colour and hide per state, ink tools skip moved parts, export, thumbnails and read-only switching follow the state in view (Markdown export and live excerpts too); switching and playing write nothing, *Set as default state* saves `active` (one undo step); erasing keeps the pieces in their part (segment and area); no colour / width rows on the part editor's selection | ✅ | ✅ harness scenario `states` (tablet and phone, light and dark); the pure parts in `tests/model-v13.test.ts`, `tests/states-fixes.test.ts`, `tests/states-view.test.ts` | | 🧪 | steps 800-813, 817, 819 |
| Format v11: `meta.description` and `meta.coverArt` (generated `{ kind: "art", style, seed }` or `{ kind: "image", asset }`); v10 → v11 migration (v10 files read unchanged, v11 keys found in a v10 file dropped); staged loading of large v10 files; lenient read (invalid description or cover dropped and counted), strict write; kept by repair, by a conflicted-copy merge (the main notebook's wins) and counted as an asset reference; a newer version opens read-only. B5 page size preset | ✅ | ✅ `tests/model-v11.test.ts` | | | |
| Folder metadata (wave 0.12): colour, icon, description and art style per folder in `_meta/folders-<device>.json` (one file per device, merged on read, latest change wins per folder and field); follows renames and moves (the folder and the folders inside it); never overwrites an unreadable, empty or newer own file (a copy is kept, the write refused); read API `getFolderMeta` / `onFolderMetaChange` | ✅ | ✅ `tests/folder-meta.test.ts` (file round trip, refusals, unknown items, values, merge, null clears, later time than read, no-op skipped, rename planning, the store: only its own file, merge with another device, change notifications, renames, unreadable / empty own file never overwritten, other devices' bad files skipped); ❌ two real devices syncing, a real vault rename event | | ✅ | steps 466-469 |

### S Pen side button at window level (steps 404-406)

404. **Pen button test sees everything.** Settings → *Pen button test* (or the command). Without touching anything, move the pen over the modal, the area and outside it: the line *Events received* counts `pointermove`, `pointerover`, `mousemove` and so on, and *Last event* shows the type, `pointerType`, `button`, `buttons`, pressure, tilt and target (like the pen-tracker page). Then: (a) hover over the dashed area, press and release the side button without touching, three times; (b) the same over another part of the modal (title, log); (c) touch the area with the nib, press the button while touching, release, lift; (d) a finger long-press. After each, tap *Copy log* and send the text. Report exactly whether *Events received* changes when the button goes down and up in (a) and (b), and which new types appear (`pointerdown` with `pressure=0.00`, `mousedown`, `contextmenu`, `auxclick`, `click`, `selectstart`, a key). If nothing at all changes while the button is pressed, the button does not reach Obsidian on this device (with Air command on and off).
405. **Radial menu from the button, anywhere over the page.** In a notebook with *Pen side button* = *Radial menu on click, erase while held*: hover the pen over the page and click the side button: the ring opens on release at the pen, nothing is drawn. Repeat with the pen over a floating bar or the toolbar lying on the page (if your layout has one over the page): the ring opens at the pen too. With the pen above the toolbar strip outside the page, or over a modal (open the Pen button test over the notebook), the click opens nothing in the notebook. Hold the button, then touch and drag over ink: it erases; release: no menu. A long-press with the pen on the page and on the toolbar shows no system menu, text selection or magnifier, and the pen keeps writing afterwards (in the Pen button test, no `pointercancel` appears during a long-press on the area).
406. **Nothing else changes.** Write, dot an i, tap the toolbar with the pen and with a finger, scroll and pinch: no radial menu opens by itself, ink looks and feels the same, and the eraser end still erases.

### Settings tab by task (steps 407-413)

407. **Sections and order.** Open Settings → Notebook on the tablet, on a phone and on Windows. The sections appear in this order, each in its own panel with an icon and a title: *Writing*, *Pen & input*, *Pages & navigation*, *PDF & reading*, *Library & files*, *Sync & safety*, *Obsidian integration*, *Study*, *Appearance & language*, *Diagnostics* (*Export* has no setting yet and is not shown). Every name fits one line and every description at most one line on the tablet; on a phone the control may go under its name, but nothing is cut and the page never scrolls sideways.
408. **Every setting is still there.** Change one setting of each section (for example *Default paper*, *Palm rejection*, *Scrolling*, *Dim backgrounds*, *Notebooks folder*, *Companion notes*, *Offer the current class*, *Toolbar size*, *Performance overlay*), close and reopen Obsidian: the values are kept and work as before (a new notebook gets the paper, the overlay shows in a notebook, and so on).
409. **Dependent options.** Turn *Companion notes* on: *Note location*, *Note name* and *Update all companion notes* appear at once; set the location to *In a folder*: *Companion folder* appears. Turn companion notes off: all of them disappear. The same with *Dim backgrounds* → *Dimming strength*, *Scrolling* = one page at a time → *Fast scrollbar* hidden, *Version history* = 0 → *Versions to keep* hidden, *Draw with finger* on → the finger long-press option hidden, *Pen side button* = *Nothing* → the button options under *Advanced* hidden.
410. **Collapsed groups.** Each section ends with *Advanced* (closed, with its number of settings). Tap it with the pen, a finger and the mouse, and with the keyboard (Tab, Enter): it opens and closes, the chevron turns. *Pen gestures* is closed until the side button is set to a gesture choice or *Long press starts a gesture* is on; *Class timetable* opens once the timetable has a class; *Zettelkasten* once a slip box exists.
411. **Search.** Type *palm*: only *Pen & input* remains, with *Palm rejection* and *Ignore large touches* (even though the latter is under *Advanced*). Type *notte* (Italian) with the interface in English: *Night mode* is found; type *diagnostica*: the whole *Diagnostics* section. Type *edge width* with edge rejection off: *Edge rejection* shows; turn it on: *Edge width* appears. A query with no match says so. Escape or clearing the field brings every section back, and the field keeps the keyboard while typing on the tablet.
412. **Style.** *Appearance & language* → *Style* = *Follow Obsidian theme*: the tab takes the colours of your Obsidian theme (light and dark); back to *Notebook*: the dark navy panels (light panels in a light theme).
413. **Diagnostics and actions.** *Pen button test*, *Run performance benchmark*, *Gesture cheat sheet*, *Custom gestures*, *Check sync safety*, *Edit timetable…* and *Update all companion notes* each open or do what they did before. Obsidian's own settings search (top of the settings window) finds the plugin's settings by their English and Italian names.

### S Pen in Obsidian for Android: hover click, eraser, pen key (0.11.2, steps 414-424)

Obsidian's Android app does not pass stylus hover to the plugin, so the side button clicked while the pen hovers is seen only as one `contextmenu` event. These steps check the fallbacks built on that. Defaults: *Pen side button* = *Radial menu on click, erase while held*, *Button click: next stroke erases* off, *Pen key* off.

414. **Hover click opens the radial menu.** In a notebook, hold the pen about 1 cm above the page and click the side button (press and release without touching): the ring opens, nothing is drawn. Repeat three times in different places, after writing a word each time: the ring opens where the pen is, or where it last touched, or in the middle of the page (note which one). Tap an action with the nib: it is applied. Then hover over the toolbar and click: note whether the ring opens. In the *Pen button test*, the same click shows one `contextmenu` line: copy the log and send it with the result.
415. **Finger long-press and text fields unchanged.** With *Open the radial menu with a finger long-press* on, hold a finger still on the page: the ring opens beside the finger once, as before (not a second time when you lift). With it off, a finger long-press opens nothing. Double-tap a text box to edit it, then long-press inside the text with a finger: the system text menu (paste, select all) still appears. With the text box still being edited, click the pen button while hovering: no radial menu opens.
416. **Button held while touching erases.** Hold the side button, touch the page and drag over ink: it erases, and nothing is written. Release the button and write: ink. Write a long stroke, press the button in the middle of it without lifting and keep moving: the ink written so far stays, the rest of the movement erases; lift: the next stroke is ink. With the eraser end (if your pen has one), the same.
417. **Button click: next stroke erases.** Settings → *Pen & input* → *Button click: next stroke erases* on (under *Pen side button*). In a notebook, click the side button while hovering: no ring opens and a small ring appears at the corner of the current-pen indicator in the toolbar. Drag over ink: it erases, and the small ring disappears. The next stroke writes ink. Click twice: the small ring appears and disappears, the next stroke writes ink. Click once, then choose another tool (or press Escape on a keyboard): the small ring disappears. Switch the setting off: a click opens the ring again.
418. **Pen key: F9 to F12.** With a Bluetooth or USB keyboard (or a Windows PC), in Settings → *Pen & input*, set *Pen key* to F9 and *Pen key action* to *Next stroke erases* (the action appears only once a key is chosen). Close the test, open a notebook and press F9: the small ring appears on the current-pen indicator; the next stroke erases. Hold F9 down: it toggles once, not repeatedly. Edit a text box and press F9: nothing happens to the pen. Set the action to *Open the radial menu*: F9 opens the ring at the last pen position. Press F10: nothing. Set *Pen key* to *Off*: F9 does nothing.
419. **Pen key: custom key and hotkey warning.** In *Pen key*, choose *Other key…* and press a key (for example `F13`, or a letter): the dropdown shows *Key: …* and that key now acts as the pen key. *Other key…* then Escape: nothing changes. In Obsidian's *Hotkeys* settings, bind F11 (no modifiers) to any command, then choose F11 as the pen key: the description warns that the key is also an Obsidian hotkey and names the command.
420. **Key Mapper + Shizuku (optional).** Only with a Bluetooth S Pen (Air actions) and Key Mapper set up with Shizuku as in [features.md](features.md#s-pen-on-android): map the pen button to F9, set *Pen key* to F9. In a notebook, click the pen button: the action runs (note the delay you feel). Holding the button does nothing more than one click (no hold), and the key reaches Obsidian only while Key Mapper runs. Report the delay and whether it misses clicks.
421. **Pen button test: native bridge line.** Open the *Pen button test*: a line *Native bridge (read only, nothing is called)* shows `Capacitor: platform=android`, the plugin names and the globals found. Press a key on a keyboard: its log line shows `key=` and `code=`. *Copy log* includes the bridge line. Send it.
422. **Timing of the button around the contact (Pen button test).** In the *Pen button test*, on the dashed area: (a) hold the side button, then touch and draw a short line, release; (b) touch, draw, press the button in the middle while still drawing, lift; (c) hover and click the button; (d) a finger long-press. After each, read the line *Side button verdict* (expected: *button held at contact*, *button during stroke*, *button while hovering*, and no change for the finger) and the notes in the log: `contextmenu Δ=+42 ms after pen down`, `pen down Δ=+30 ms after contextmenu`, `first pointermove Δ=… after pen down`. Repeat (a) ten times and send the copied log: the Δ values set the windows (defaults 150 ms before, 350 ms after; the after-window can be set up to 400 ms, below Android's long-press). (e) Rest the nib still on the area for one second without the button: the verdict is *not the button* when a `contextmenu` appears (note its Δ).
423. **Button held, then touch: the whole stroke erases.** In a notebook, hold the side button, touch and drag over ink: it erases from the very first point, no ink appears (not even for a moment longer than the window), no menu or text selection opens. Release the button and lift: the next stroke writes ink with the pen tool as before. Repeat quickly ten times, also with very short strokes: note any stroke that wrote ink instead. With the button held, make a very short flick (under a third of a second) over ink: the flick leaves no ink and erases what it crossed (the event may come only after the lift); press Undo once: the erased ink comes back and no flick appears. Without the button, write short quick strokes (dots, dashes): they stay ink and no menu opens.
424. **Button pressed while writing: the rest erases.** Write a long line and, without lifting, press the side button and keep moving over other ink: the line written before the press stays whole (also with the eraser set to *Stroke* and to *Segment*: the press must not delete or cut it, even when the movement goes back over it), the ink under the rest of the movement is erased. Lift: the pen tool is back. Rest the nib still on the page for two seconds without the button, also with *Button after contact* at its maximum and with the nib wobbling slightly: nothing is erased and no menu opens. Write a long line with the palm resting on the page, then lift the palm and touch it down again while still writing: the whole line stays ink (a palm's long-press is never the button); about a second after the palm leaves, the button works again.

### Procedural subject art (wave 0.12, steps 425-429)

The gallery of every style in the eight subject colours, as cards, covers, empty states and folder icons, is screenshotted by `npm run harness:check` into `dev/harness/dist/shots/art/` (`HARNESS_DOC=art` runs only those pages; `ART_BENCH=1` adds per-style timings). Steps 425-429 are for the real app once a surface (library, home, creation dialog) uses it.

425. **Same picture every time.** Open the library: note the art of two subject cards and two notebook covers. Close and reopen Obsidian, then open the vault on a second device: each card and cover shows exactly the same drawing and colour. Rename a subject: its art (and its automatic colour) may change; renaming it back restores the original.
426. **Left side stays clean.** On the tablet in portrait and landscape, and on a phone: the folder icon, title and counts of every subject card sit on a clean area; the line art fades in from the right half and never makes the title hard to read, in dark and light theme.
427. **Fine lines, sharp.** Zoom into a card with the system magnifier or a screenshot: the lines are thin (about 1 device pixel or a little more), not blurry or blocky, on the tablet (dpr 2 or more) and on a desktop screen (dpr 1).
428. **Switch off.** Turn on the system setting *Remove animations* (Android) or *Reduce motion* (Windows/macOS), restart Obsidian: cards, header bands and empty states show no line art; covers keep their colour gradient; nothing is missing or broken. Turn it off again: the art is back.
429. **Fast on the tablet.** On the Android tablet, open a library with at least 12 subjects: the cards appear without a visible stall and scrolling stays smooth; scroll back up: cards show at once (cached). If you can, with remote DevTools on the WebView, report the time of the first library render and of a card's `artImage` call (target: under 30 ms per 600 × 200 card).

### Home and the library on the design system (steps 430-449)

Use a vault with a few subject folders under the notebooks folder (for example Anatomia, Fisiologia, Biomateriali, Matematica), notebooks with tags, two starred, one with PDF pages and one with an open question marker.

430. **Open Home.** Tap the ribbon icon (house) or run *Open Notebook home*: Home opens in a tab with the rail on the left (Home active), the title, the search pill and the bell. On a tablet in landscape the rail shows labels; in portrait only icons; on a phone it is hidden behind the menu button and opens as a sheet from the left (tap outside or ✕ to close).
431. **Subject cards.** *Subject folders* shows one card per top-level folder (at most four; *Show all* appears when there are more): coloured gradient, folder icon in the same colour, a line drawing on the right, the number of notebooks. A folder made in the creation dialog shows the colour, the symbol on the folder icon and the pattern chosen there (the same card as the dialog's preview); change them on another device and sync: the card follows. Tap a card: the library opens on that folder. Drag a notebook (long press) onto a card: it moves into that folder.
432. **Recent notes.** After writing in two notebooks, Home lists the pages you edited last on this device (bookmark title or notebook name, page number, time, subject and tag pills). Tap a row: the notebook opens on that page. The kebab shows the notebook menu (open, favourite, pin, archive, rename, move, duplicate, tags, cover, delete). *Show all* opens *Recently edited pages*.
433. **Statistics.** The four tiles show notebooks created, pages edited, PDF notebooks changed and tags used in the last four weeks, with bars. Change the period to *Last week* and *Last 12 weeks*: the numbers and bars change, and the choice is kept after closing and reopening the tab. The green or red change appears only on *Notebooks created*, and only when notebooks were created in the period before. Tap each tile: notebooks sorted by creation, recent pages, the *With PDF* collection, the tags page.
434. **Quick actions.** *New notebook* and *New folder* open the creation dialog (the registry actions); *Import PDF* starts the import; *Scan* starts the scanner (only where scanning is available).
435. **Search from Home.** Type a subject name in the search pill: results are grouped as *Folders*, *Tags* and *Notebooks* (with the matching page for text in text boxes). Escape clears the search and Home comes back. On desktop, Ctrl K (⌘ K) focuses the search.
436. **Library header and chips.** Tap *Notebooks* in the rail: *Notebook library* with the chips *All · Subjects · Recent · Favourites · With PDF · Archive*. Each chip filters and is highlighted; the rail item stays on Notebooks (PDF has its own rail item).
437. **Smart collections.** Under *Smart collections* only collections with notebooks are shown: *To study* (open question, gap or homework markers, or a tag such as *da studiare*), *Favourites* (starred or pinned), *With PDF*, *Recent* (changed in the last week), *Exams* (tag *esame* / *exam*). Each opens its list. Resolve the last open marker of a notebook: after it is saved it leaves *To study*.
438. **Frequent tags.** The most used tags with their counts; a tag that names a subject has the subject's colour. Tap one: the notebooks with that tag. *Show all* opens the tags page.
439. **Recent and favourite notebooks.** *Recent notebooks* lists the five changed last; *Favourite notebooks* shows a page thumbnail, the subject in its colour, the page count and the time. Tap the star: the notebook leaves the favourites (the file is written; it syncs like any metadata change).
440. **All notebooks, grid and list.** Below the sections, every notebook (pinned first). The grid / list button switches the view and is remembered. With more than 60 notebooks, *Show more* adds 60 at a time; scrolling stays smooth on the tablet.
441. **Existing library features.** Pin, unpin, archive and restore from the kebab; *Manual order* with move up / down and drag; drag a card onto a folder in the rail and onto a breadcrumb; rename, move, duplicate, tags, cover and delete (to the trash) still work as in 0.11.
442. **Rail.** The folder tree expands and collapses; folders have their subject colour; long press (or right click) a folder for its menu (new notebook here, new folder here, import PDF here, lecture from slides here, scan here, rename, delete). *Archive*, *Trash* and *Check library* at the bottom open what they did before. *Settings* opens the plugin settings. On a wide view the fold button turns the rail into icons and back.
443. **New and filter buttons.** The + button lists New notebook, New folder, Import PDF, Lecture from slides, Scan, Loose sheet; inside a folder the creation dialog opens with that folder as the place (the same for the folder menu's *New notebook here* / *New folder here*); no plain name prompt appears any more. A notebook created with a pattern or image cover shows that cover in *All notebooks*. The filter button lists the tags; the sort button the four orders (the current one checked).
444. **Inbox bell.** With items in the Inbox (loose sheet blocks, PDF highlights), the bell shows their number after a few seconds (no badge at 0). Tap it: a popover (a sheet on a phone) titled *Incoming* lists them; tap a row to open its page; the kebab offers *Open in notebook*, *Process in the inbox*, *Discard* (the badge goes down by one). *Open inbox* opens the Inbox view. Writing in the loose sheet and reopening the bell after two minutes updates the count.
445. **Light and dark.** Switch Obsidian between light and dark: both surfaces stay readable (titles, muted text, pills), subject colours stay the same.
446. **Reduced motion.** With the system's *Remove animations* / reduced motion on, the line drawings, the header band and the section glows disappear and nothing animates; every control still works.
447. **Pen, finger and mouse.** Every card, row, chip, tile and button responds to a pen tap, a finger tap and a mouse click; nothing needs hover. Targets are at least 40 px (44 px on a phone).
448. **Rotation.** Rotate the tablet with Home and with the library open: the rail switches between labels and icons, the subject cards between four and two per row, and nothing scrolls sideways.
449. **Nothing else changes.** Open a notebook from Home, write, go back: the library index is not rebuilt each time (opening is quick), thumbnails appear, and no notebook file changes unless you starred, pinned, archived, moved or renamed it.

### Creation dialog, cover and folder metadata (format v11, wave 0.12, steps 450-469)

450. **Open it.** Command *New notebook*, the library's *New notebook* button and a folder's *New notebook here*: the dialog opens on the *Notebook* tab with the name field focused (the soft keyboard opens on a tablet). The folder list shows the folder you started from (from the command: the folder you used last on this device, or the notebooks folder). Command *New folder*: the same dialog on the *Folder* tab.
451. **Shape.** Tabs *Notebook* | *Folder* at the top left (the active one filled in the accent colour), × at the top right; on the left a portrait cover with a small badge (its pattern name) and *Change cover*; on the right Name, Description (optional), Folder, Page template, Page size, Orientation; *Cancel* and *Create notebook* at the bottom right. In dark and light theme the panel, borders and text read well. On a phone the dialog fills the screen, the cover is on top, and the buttons at the bottom are not hidden by the navigation bar.
452. **Name errors.** Tap *Create notebook* with an empty name: "Enter a name." under the field, nothing is created. Type `a/b` or `x?`: the error names the forbidden characters. Type the name of a notebook that already exists in the chosen folder: "A notebook named … is already in this folder." Type the same name in other capitals (`anatomy` for `Anatomy`): the same error, and nothing is written over. Type `CON`, `nul.txt` or `Notes.`: an error says the name cannot be used. In the notebooks folder itself, a folder named `_assets` or `_Meta` is refused. Correct it: the error goes away as you type.
453. **Enter submits.** Type a valid name and press Enter on the keyboard (physical or soft): the notebook is created and opens. In the description, Shift+Enter makes a new line.
454. **Paper tiles.** The *Page template* tiles show real paper (blank, ruled, grid, dotted, millimetre, Cornell, music, isometric, hexagonal, calligraphy, daily and weekly planner); tap one with the pen and one with a finger: the selected tile gets an accent border. Create the notebook: its first page has that paper, identical to the tile.
455. **Sizes.** Choose A4, A5, B5, Letter in turn and create a notebook each time: the page has that size (page info). Choose *Custom*: width and height fields in mm appear; 30 or 2000 gives an error under them and *Create* does not create; 150 × 150 creates a square page. Type 300 × 200 with *Portrait* selected: *Landscape* becomes selected and the page is 300 mm wide and 200 mm tall; tap *Portrait*: the fields swap to 200 × 300.
456. **Orientation.** *Landscape* then create: the page is wider than tall; the paper tiles turn sideways while it is selected.
457. **Saved template.** *Use a saved template…* opens the template gallery; choose one: the paper, size and orientation sections are replaced by "Template: …" with a × to remove it. Create: the notebook has the template's pages and the cover and description you chose.
458. **Cover.** Tap the cover: the next pattern (badge changes). The shuffle button next to *Change cover* draws a new variation of the same pattern. *Change cover* opens patterns, colours and *Image…*: each changes the preview at once. *Image…* → from the vault or the device: the cover shows the picture, the badge says *Image*; *Remove image* goes back to the pattern.
459. **Cover saved.** Create a notebook with a pattern cover and one with an image cover. Close and reopen Obsidian: the library still shows them (once LIBHOME's cards draw covers); the image is a file in `_assets/` and *Check library* does not offer it as unused.
460. **Description saved.** Create a notebook with a description; in a text editor the file's `meta` holds `"description"` and `"coverArt"`, and `"version": 11`.
461. **Old notebooks.** Open a notebook made by 0.11 (format v10): it opens normally; after an edit it is saved as v11. On a device still running 0.11, a v11 notebook opens read-only with the usual "newer version" message, and nothing is overwritten.
462. **Folder tab.** Switch with the tabs (or the arrow keys on the tab): the name typed so far is kept. The preview is the same subject card the library shows for a folder (glossy folder icon with the chosen symbol, name, description, line art on the right), wide, above the form; *Change colour* steps through the eight colours, the shuffle button changes the pattern; tap the icons (folder, graduation cap, heart, flask, sigma, brain, atom): the preview shows the icon; *More icons…* opens a search of every icon (type "book"), the chosen icon joins the row.
463. **Colours.** Tap each of the eight swatches, then the + swatch: the colour picker opens under the row (no eyedropper); drag in it and lift: the colour is taken and the preview follows.
464. **Create a folder.** Choose a *Location*, type a name, *Create folder*: the folder exists in the vault (file explorer) at that place, the dialog closes. A name that is already there gives an inline error and creates nothing.
465. **Keyboard only.** Tab through the dialog: every control has a visible focus ring; arrow keys move within tiles and swatches; the folder list opens with Enter, arrows move, Enter picks, Escape closes it. Escape closes the dialog without creating anything.
466. **Folder look is stored.** After 464, `<notebooks folder>/_meta/folders-<8 hex>.json` exists and holds the folder's path with its colour, icon, art and description.
467. **Rename follows.** Rename that folder (and separately move it into another folder) in the file explorer: the `folders-…json` file now holds the new path; the old path's fields are cleared (`"v":null`).
468. **Two devices.** With a sync service: create a folder on device 1, sync, open the dialog on device 2: the folder list shows it with its icon and colour; change nothing. Each device writes only its own `folders-<device>.json`; no conflicted copies appear.
469. **Unreadable file is kept.** Replace this device's `folders-…json` with `{ broken` and create a folder: the folder is created, a notice says its colour and icon could not be saved, the broken file is unchanged and a `folders.unreadable-<hash>.json` copy sits next to it.

### 0.12.1 re-check: Home styled, settings tab back (steps 470-477)

Update to 0.12.1 (community browser or BRAT), then **fully close Obsidian** (swipe it away from recent apps) and reopen it, so the new `styles.css` and `main.js` are read.

470. **No start-up notice.** While Obsidian opens, no notice "Notebook: some features could not start (…)" appears. If one appears, write down the names in brackets and, if you can, the console lines starting with `[notebook]` (desktop: Ctrl+Shift+I; Android: connect the tablet to a computer with USB debugging on and open `chrome://inspect` in Chrome, or open the same vault in Obsidian on a desktop).
471. **Settings tab is back.** Settings → Community plugins: *Notebook* is listed with its gear; tap it: the tab opens with the search pill and the sections *Writing* … *Diagnostics*. Type "palm": only *Pen & input* remains; clear it.
472. **A setting saves.** Toggle *Companion notes* (Obsidian integration) on, close settings, fully close and reopen Obsidian: it is still on. Toggle it back.
473. **Home is styled (dark).** Open *Notebook home* (ribbon home icon). Expected, as in `dev/harness/dist/shots/design/home-dark-tablet.png`: a navy background; on a tablet in portrait an icon rail on the left (icons stacked vertically, not a row of grey pills); the title *Notebooks* (*Quaderni*) with the subtitle; a rounded search pill with the bell; panels with soft borders. No notice "its styles (styles.css) are not loaded".
474. **No grey buttons.** On Home and in the library, the rail items, *Show all*, the statistics period ("Last 4 weeks") and the ⋮ buttons of the rows have no grey fill and no drop shadow when not pressed; a tap shows only a faint tint.
475. **Library and rail.** Tap *Notebooks* in the rail: the library opens in place with the filter chips and the sections; rotate the tablet to landscape: the rail shows labels and counts at the right ("Notebooks · 12", the count not glued to the label).
476. **Light theme and phone width.** Switch Obsidian to the light theme: Home stays styled. On a phone (or split screen narrower than 600 px) the rail is hidden behind the ☰ button and opens as a sheet.
477. **Creation dialog.** *New notebook* from Home's quick actions: the dialog has the tabs, the cover preview and the paper tiles as in `create-dark-tablet.png`; *Cancel* and *Create notebook* are styled buttons, not grey pills.

### 0.12.2: settings tab, creation always reachable (steps 478-484)

Update to 0.12.2 and fully close and reopen Obsidian. Steps 479-483 need a vault with **no notebooks** (a new test vault, or a notebooks folder set to an empty folder in *Library & files*). Reference screenshots: `dev/harness/dist/shots/design/empty-*.png` after `npm run harness:check`.

478. **Settings tab opens.** Settings → Community plugins → *Notebook*: the tab opens with its sections, with no "Impossibile mostrare le impostazioni: this.name is not a function".
479. **Empty Home teaches the first step.** Open *Notebook home*: under the header a panel with an illustration (an icon with reduced motion), *Inizia il tuo primo quaderno* (*Start your first notebook*), one line, and the buttons *Crea un quaderno* (accent), *Crea una cartella*, *Importa un PDF*. Below: *Cartelle per materia* with a dashed *Crea una cartella* tile, then the four *Azioni rapide*. No statistics panel.
480. **+ Nuovo in the header.** At the right of the search pill and the bell, an accent pill *+ Nuovo*. Tap it with the S Pen: a menu with *Nuovo quaderno*, *Nuova cartella*, *Importa PDF* (and *Nuovo quaderno da scansione*). *Nuovo quaderno* opens the creation dialog on the *Quaderno* tab; Cancel. Repeat with a finger choosing *Nuova cartella*: the dialog opens on the *Cartella* tab.
481. **Every way in opens the dialog.** With pen and finger: *Crea un quaderno* → Quaderno tab; *Crea una cartella* and the dashed tile → Cartella tab; *Importa un PDF* → the file picker; the quick actions *Nuovo quaderno* / *Nuova cartella* → their tabs. Cancel each time.
482. **Rail +.** (Removed in 0.12.3: see step 488.) On the tablet in portrait, a round **+** under the brand icon in the rail opens the same menu. On a phone (or a split screen under 600 px): ☰ opens the rail sheet with the **+** next to the brand; choosing an item closes the sheet and opens the dialog.
483. **Empty library.** Tap *Quaderni* in the rail: the library shows the chips, the same empty state and the dashed *Crea una cartella* tile, and *+ Nuovo* at the end of the header buttons. Light theme: the same, readable.
484. **First notebook.** Create a notebook from the empty state: the empty state disappears, the notebook is listed, the statistics come back on Home. Create a subject folder: its card replaces the dashed tile.

### 0.12.3: a picture that failed emptied Home and the dialog (steps 485-492)

Update to 0.12.3 and fully close and reopen Obsidian. Use the same vault with **no notebooks** as for 0.12.2. Reference screenshots after `npm run harness:check`: `dev/harness/dist/shots/design/empty-*.png`, `hostile-*.png` (the same screens with every picture failing on purpose) and `settings-*.png`.

485. **Device info.** Settings → *Notebook* → *Diagnostica* → *Informazioni sul dispositivo*: lines *WebView: Chrome …*, *Obsidian API: …*, *Platform: …*, *Screen: …*, *Art engine: …* and the user agent. Tap *Copia* and paste the lines into the results table below (Notes). If *Art engine* is not "ok", copy its message too.
486. **Settings look native.** The sections sit on Obsidian's own grey settings surface with a thin border, no navy panels; the search pill at the top has no navy band behind it. Headers, rows and toggles are as before. Light theme: the same.
487. **Home is complete.** Open *Notebook home*: the header shows the title, the subtitle, the search pill, the bell and the accent **+ Nuovo** on the same row; below it the empty state (*Inizia il tuo primo quaderno* with three buttons), *Cartelle per materia* with the dashed *Crea una cartella* tile, and the four *Azioni rapide*. If any part shows a red-bordered card *Impossibile mostrare …*, take a screenshot of it: it names the error.
488. **No + in the rail.** The rail shows the brand (*Quaderni / per Obsidian*), Home, Quaderni, Tag, Impostazioni and the VAULT tree; nothing sits on the brand and there is no round + in the rail.
489. **+ Nuovo.** Tap *+ Nuovo* with the S Pen: the menu (*Nuovo quaderno*, *Nuova cartella*, *Importa PDF*, …) opens; *Nuovo quaderno* opens the creation dialog.
490. **Creation dialog, both tabs.** The dialog shows the tabs *Quaderno* / *Cartella*, the cover preview with *Cambia copertina*, name, description, folder, the page templates, page size and orientation, *Annulla* and *Crea quaderno*. Tap *Cartella*: the folder card, name, description, location, icons and colours, *Crea cartella*. Also open it from *Nuova cartella* (header menu), from the quick actions and from the dashed tile. If it shows a red-bordered card instead, take a screenshot.
491. **Tag page.** Tap *Tag* in the rail: the header *Tag* with its subtitle and *+ Nuovo*, and below it the line saying tags appear here once notebooks have them (no blank page).
492. **First notebook and folder.** Create a notebook and a subject folder from the dialog: the notebook opens; back on Home the empty state is gone and the folder card (glossy folder icon, generated art) replaces the dashed tile.
### 0.12.4: the S Pen side button, tap and drag (steps 493-499)

Update to 0.12.4 and fully close and reopen Obsidian. Samsung tablet, S Pen, Obsidian for Android. Setting *Pen side button* = *Radial menu on click, erase while held* (the default) unless a step says otherwise. On this device pressing the button with the pen in the air shows nothing to the app: the button counts only while the nib touches the page. Nothing here is filled in as verified; write what you see in the results table.

493. **Tap with the button.** Hold the side button, touch the page quickly with the nib and lift without moving. The radial menu opens where the nib landed, after the lift (not before), and no dot of ink is left. Repeat three times, also twice in quick succession (less than a second apart): the menu opens each time.
494. **Drag with the button.** Hold the side button, touch and drag across some ink and lift. The ink along the whole path is erased, from the first point where the nib landed (not from a little later); nothing new is written and no menu opens, during or after the drag. One undo brings the erased ink back in one step.
495. **Without the button.** A tap leaves a dot and a drag writes a line, as always; no menu, no eraser.
496. **Button in the middle of a stroke.** Write a long stroke (about a second) and press the button while writing. The stroke keeps writing ink to its end and nothing is erased; no menu opens.
497. **Other settings.** *Radial menu on click*: a tap still opens the menu and a drag still erases. *Erase while held*: a tap erases what is under the nib and no menu opens, a drag erases. *Nothing*: the button does nothing, the contact is ink.
498. **Pen button test.** Settings → *Notebook* → *Pen button test*. With the button held, tap the test area, then drag, then repeat without the button. The lines *Signal seen* and *Decision* show, for the tap, a signal such as `contextmenu Δ=+40 ms` or `pointerdown buttons=3` and `menu (tap)`; for the drag `eraser (drag)`; for a press far into a stroke `ignored: pressed in the middle of a stroke`. Tap *Copy log* and paste it into the Notes column below: the signal that this tablet really sends is what decides whether the button is fully covered.
499. **The button in the air.** Hover the pen over the page and press and release the button without touching: nothing opens and nothing is armed (this is the Android limit, not a bug). Then touch with the button held again: step 493 still works.

### 0.13 — ds-zettel (steps 500-509)

Update to 0.13 and fully close and reopen Obsidian. Use a vault with a few notebooks, one with a PDF, and the quick-notes sheet. Reference screenshots after `npm run harness:check`: `dev/harness/dist/shots/design/zettel-*.png` (inbox, open, empty, caught-up, scanning, card, card-luhmann, list, confirm, overlay; tablet and phone, light and dark). Not verified on a device.

500. **Inbox page.** Run *Open the inbox*. The header shows *Inbox*, the count (*N to process*), *Start processing* and a refresh button; below them filter chips with counts (when there is more than one source), the *Show processed* toggle, the hint line and one panel per notebook with the notebook name, its source and a count pill. No panel is the plain Obsidian grey.
501. **Rows.** Each row has an icon for its kind (writing, highlight, comment), the first line of text, and the page (and the PDF page for a highlight). A changed item shows a *Changed* pill. Tap a row: it expands in place with the ink on its paper, the text and the actions; tap it again to close it.
502. **Filters.** Tap a source chip: only its items stay and the chip is highlighted; *All* brings everything back. *Show processed* adds the processed rows (ticked, with their state) and the toggle looks pressed.
503. **Actions.** In an open panel: the accent action makes a card (the dialog opens), *Link to a card…* opens the card list, *Discard* and *Skip* select the next open item, *Open in notebook* goes to the page. A row already covered by a card offers *Open card* and *Mark as covered*.
504. **Card dialog.** From *Permanent card…*: the dialog shows the icon, title and one line, the ink, *Title*, three type tiles (Permanent, Literature, Fleeting), *Source*, *Tags* (typing `study, memory` previews #study #memory) and, with Luhmann numbering on, *Parent card*. Tap a tile: only that one is marked. Enter creates the card, Escape or *Cancel* closes it without creating.
505. **Card list.** *Link to a card…* shows the card id, its title and where it is; a card whose notebook is missing is shown in the warning colour. Search by typing; choosing a row links the item.
506. **Slip-box confirmation.** Creating the cards of a whole slip-box notebook asks first, in the same dialog style: *Cancel* does nothing, the confirm button creates the notes.
507. **Empty and done.** With nothing in the inbox the page shows *Your inbox is empty*, what arrives here and a *Look again* button (the filters are hidden). After processing everything it shows *All caught up* with *Show processed* (and *Show all sources* if a source filter is on).
508. **Phone width.** With the inbox in a narrow pane (or on a phone) the actions wrap under the preview, nothing scrolls sideways and every button is at least 40 px high.
509. **Both looks.** Light theme, dark theme and *Appearance → Style → Follow Obsidian theme*: the inbox and the dialogs stay legible and keep their accent. The card regions over a page (dashed outline with the id badge) are unchanged and never block writing.

### 0.13 — ds-notebook: the editing chrome on the design system (steps 520-529)

Update and fully close and reopen Obsidian. Samsung tablet (and a phone, if you have one), S Pen and finger, Obsidian for Android; then Windows. Nothing here changes what a control does, only how it looks and how big it is.

520. **Toolbar.** Open a notebook. The tools (pen, highlighter, eraser, lasso, shapes, text, move) sit in one capsule, undo/redo in another; the active tool is tinted with an accent dot. Every button is easy to hit with the S Pen and a finger (44 px at the normal size); the page indicator and the green save dot are readable. Dark and light, and with *Follow Obsidian theme*.
521. **Narrow phone.** On a phone about 360 px wide the tools stay on one line (40 px buttons) with nothing cut off at the right edge. *Settings → Toolbar size → Large* wraps the tools to a second line instead.
522. **Tool options.** Tap the active tool again: the options panel is a rounded glass panel under the bar, colour and width choices are easy to hit, it closes when you tap outside.
523. **All actions and page sheets.** Open *All actions* (grid button) and the page sheet (page indicator): rows have an icon square, switches show on/off, a long label wraps instead of pushing its icon out, the close button is 44 px; a destructive row is red. Search still filters.
524. **Selection bar.** Lasso a few strokes: the contextual bar floats at the bottom as a glass pill with the *Selection* label (not a button), its buttons are easy to hit; copy, cut, delete and the colour/width rows still act on the selection.
525. **Radial dial.** Open the dial with the S Pen side button (steps 493-499): a navy disc with a thin ring and a soft accent halo, the same dark in light and dark themes; colour, width, tools and favourites still work. No change to when it opens.
526. **Banners.** On a very heavy page the warning card shows an icon square, the text and *Split page* / *Dismiss* (both 44 px). On a practice copy the practice strip shows an icon square and its buttons are 44 px on touch.
527. **Tabs and status bar.** With *Notebook tabs* on and two notebooks open, the tabs are pills and the open one is tinted; on Windows the status bar item matches the theme.
528. **Page operations menu.** In the pages panel select pages and open the operations menu (Windows / desktop): it has rounded corners, a hairline and a soft shadow.
529. **Reduced motion.** With the system setting *Remove animations* (Android) or *Reduce motion* (Windows) on, the panels have no blur and nothing animates.

### 0.13 — ds-modals: dialogs, prompts and cards on the design system (steps 540-559)

Reference screenshots after `npm run harness:check`: `dev/harness/dist/shots/design/modals-<name>-<theme>-<device>.png`. Check each in the light and the dark Obsidian theme and, once, with *Appearance → Style → Follow Obsidian theme*.

540. **Header and footer.** Open any dialog (e.g. a page's *Export*): a header with an icon square, the title and a close ×, with a faint line-art band behind it; the footer has *Cancel* (quiet) and the accent primary button. The × and *Cancel* close it; Esc closes it.
541. **Resize / Style.** Open the object's *Resize* and *Style* dialogs: the fields and buttons work as before and the values apply.
542. **Export.** Export a page as PDF, as PNG and as Markdown: options, the progress and the file written are unchanged.
543. **Arrange pages.** Move, duplicate, change paper and page size from the page panel: the lists are tappable rows, the chosen one applies.
544. **Go to page.** Open *Go to page*: a slim header above the input; type a number, Enter jumps.
545. **Page finder.** Open the quick page switcher: the same header, results as before; Enter opens the hit.
546. **Paste.** Paste an image or text into a notebook: the paste dialog offers its choices and each one works.
547. **PDF page range.** Import a PDF: the page-range dialog accepts "1-3, 5", shows an inline error for bad input and imports the pages.
548. **Practice.** Open *Practice*: start a session, answer, open *Attempts*: both dialogs are styled and work.
549. **Lecture pack.** Open the lecture pack, exercise paper and layout dialogs: every button works.
550. **Pen test.** Settings → pen test (or the command): the dialog is styled, *Clear* empties the log, *Copy* copies it; the signal and decision lines still update while you move the pen.
551. **Shared clips.** Open the shared clips dialog: its list and actions work.
552. **Find and replace.** Open find and replace in a notebook: find, next, replace, replace all work; the dialog stays out of the way of the page.
553. **Colour picker.** Open the colour picker from the pen toolbar: the card is a rounded design-system card; recent colours (32 px swatches) and the eyedropper and close buttons (40 px) work with the pen.
554. **Equation editor.** Insert an equation: the card, the input and its buttons work.
555. **Stamp palette.** Open the stamp palette: tapping a stamp chooses it.
556. **Confirmations.** Delete a page (or empty the trash): the confirmation uses the shell, the destructive button is red, *Cancel* leaves everything untouched.
557. **Phone width.** On the phone (or a narrow window) each dialog is a full-width sheet, the footer buttons stay reachable and nothing overflows horizontally.
558. **Obsidian theme.** With *Follow Obsidian theme* the dialogs use Obsidian's surface and accent colours.
559. **Reduced motion.** With reduced motion on, the header art band is not drawn and nothing animates.

### 0.13 — art2: generative art engine (steps 560-568)

Reference images after `HARNESS_DOC=art npm run harness:check`: `dev/harness/dist/shots/art/art-{dark,light}-{contours,cells,waves,branches,flow,orbits,grid,veins,growth,icons}-desktopHiDpi.png` and the `mix` page (families, covers, empty states, keyword motifs). The engine is shared, so look at Home, the library and the creation dialog.

560. **Cards.** Home → *Cartelle per materia*: the subject cards show line art fading in from the right, glowing softly; lines are crisp (no blur) and the colour matches the folder colour. Light theme: the same with deeper lines.
561. **Motifs by name.** Create folders named *Matematica*, *Biologia*, *Fisica*, *Storia*, *Chimica*, *Informatica*: matematica gets waves or a grid, biologia cells or branches, fisica orbits or flow, storia contours or flow. A name with no keyword gets some family (stable between sessions).
562. **Veins (harness only).** The `veins` family is not reachable from the app yet: folders and notebooks store one of seven styles, and `veins` is the eighth. Look at it in the harness screenshots (`art-*-veins-*.png`, `art-*-growth-*.png`); biology names get cells or branches on the device.
563. **Covers.** The notebook covers show the art faintly over the gradient, and the gradient looks smooth (no grey or muddy corner).
564. **Speed.** Scroll Home and the library quickly: the cards and covers appear without the scrolling stuttering. Note the time Home takes to show its art on the first open, and again after closing and reopening Obsidian (the second should not be slower).
565. **Reopen.** Close Obsidian completely and reopen it: the art on Home is there at once or after a moment. If it never appears, note it (IndexedDB may be blocked in the WebView; the art must still be drawn).
566. **Reduce motion.** Turn the system's *reduce animations* on: no art is drawn and the cards stay plain, with no errors.
567. **Device info.** Settings → *Notebook* → *Diagnostica* → *Informazioni sul dispositivo*: the *Art engine* line shows no failures. Paste it in Notes.
568. **Existing notebooks.** Notebooks and folders you already had keep the art they had (names without a keyword), and nothing is cut off or overlapped.

### 0.13 — hints (steps 580-589)

Tips are off the notebook format: they are stored in the plugin settings. Reference screenshots after `npm run harness:check`: `dev/harness/dist/shots/hints-*.png`.

580. **Tips setting.** Settings → *Appearance & language*: *Tips* is on, and *Show tips again* sits right below it with a *Reset* button.
581. **First notebook.** (Press *Show tips again* first.) Open a notebook: after a moment a card *Your notebook is ready* appears at the bottom centre. It stays about 12 s or until you tap the ×.
582. **Pen tip.** Touch the page with the S Pen: *Pen detected* appears (if not within the 4 minute gap of another tip, it waits for the next pen contact after the gap).
583. **Radial tip.** With *Pen side button* on a radial option, hover the S Pen over the page: *Radial menu* appears. Click the side button while hovering: the radial menu opens.
584. **Lasso tip.** Select with the lasso: *Selection* appears once, never again.
585. **PDF tip.** Import a PDF: the notebook opens and *PDF imported* appears.
586. **Palm tip.** Turn on *Draw with finger*, write with the pen and touch with a finger right after: *Palm ignored* appears once.
587. **Inbox tip.** With a loose-sheet item or PDF highlight in the Inbox, open the library: *Inbox* appears once.
588. **Never while writing.** Trigger a tip (reset first) while writing continuously: nothing appears until you pause for 1.5 s.
589. **Turn off.** Tap *Turn off tips* on a tip: it closes, *Tips* in Settings is off, and no tip appears again. *Show tips again* turns them back on.

### 0.13 — outline (steps 600-619)

Generated outline (roadmap 407). Reference screenshots after `npm run harness:check`: `dev/harness/dist/shots/outline-*.png`. Open a notebook made from a PDF (lecture pack), write a few lines of normal handwriting, then a title two to three times larger above a block, and add a bookmark and a question marker.

600. **Panel.** Open the page panel (grid button) and tap the outline button (list icon): the header says *Outline* (*Indice*). The list shows the PDF file name, then *Slide N* rows nested under it.
601. **Large handwriting.** Write a line of letters clearly bigger than the rest, with some empty space above it and starting near the left margin. After about half a second the outline shows a row with a picture of that ink and its page number. Tap it: the notebook goes to that page.
602. **Not a heading.** Write a second line of the same size as the body, a single large circle and a large word in the middle of a sentence: none of them appears in the outline.
603. **Two sizes.** Write a title two and a half times the body and, on another block, a title about twice the body: the smaller one is indented under the larger one.
604. **Bookmarks.** A bookmarked page shows its title (or *Page N*), colour dot and category; the "…" menu edits or deletes it, and Undo restores it. The category dropdown shows only the bookmarks of that category.
605. **Markers.** A question, homework, very important or key-point marker is listed with its label (or its kind); a gap marker is not.
606. **Slides.** Page turns inside the same PDF page add no row; a page with another PDF page, or another PDF file, adds a *Slide* (and *PDF*) row.
607. **Order.** Rows follow the pages top to bottom; on one page: PDF, slide, headings and markers by their height on the page.
608. **Where you are.** One row is highlighted: the last entry at or before the page in view. Scroll to another page and it follows.
609. **Touch.** Rows are easy to hit with a finger and the S Pen (44 px tall); scrolling the list with a finger does not jump to a page.
610. **Settings.** Settings → *Pages* → *Outline*: turn off *Large handwriting as headings*; the outline loses the pictures at once. Turn off each other switch in turn; with all four off the outline says where to turn one on.
611. **Dark and light, Obsidian theme.** Check the outline in the dark and light theme and with *Appearance → Style → Follow Obsidian theme*; the white picture of a heading stays readable.
612. **Cost.** In a notebook of 100+ pages, open the outline for the first time (note how long it takes), then close and reopen it: the second time is immediate. Writing with the outline open does not stutter.
613. **No change to the file.** Open a notebook, view the outline, close it without editing: the file is not rewritten (no new snapshot, no sync conflict).

### 0.20 — refwindow: floating reference window (steps 1800-1819)

Floating reference window (roadmap #107). Use a notebook with several pages and, in the vault, a second notebook, a PDF, a picture and a Markdown note. Nothing about this feature is stored in the notebook file (no format change); the place of the window is kept on the device.

1800. **Open from a page.** In the page sheet (page indicator, or the long-press menu of a page thumbnail) *Show in reference window* opens a small window at the bottom right of the page area showing that page; the title is the notebook name and the stepper says the page (`3 / 12`).
1801. **Open from the palette.** *Open a reference window…* in the command palette (and in All actions) lists notebooks, PDFs, pictures and Markdown notes, the most recently changed first; the choice opens in the window. *Close reference window* is in the palette only while a window is open.
1802. **Another notebook and a PDF.** A page of another notebook (with ink, a PDF background, a picture) is drawn as the reader would see it; a PDF shows its page. The stepper moves page by page and stops at the first and last page.
1803. **A note and a picture.** A Markdown note is shown rendered and scrolls with a finger; a picture is shown fitted, and pans and zooms. A note has no stepper and no *Fit* button.
1804. **From a link.** Select a text box that holds a `[[link]]` (to a note, a notebook page, a PDF or a picture): *Open as reference* in the selection bar opens that target in the window (a notebook link opens at its page). A link that does not exist says so.
1805. **From the hover card.** Hover (or long-press) a `[[Notebook.notebook#p3]]` link in a note: the preview card has a picture-in-picture button; it opens that page in the window of the notebook in view. With no notebook open a notice says to open one first. *Open as reference* is also in the file menu of notes, PDFs, pictures and notebooks.
1806. **Pen outside.** With the window open write next to it with the S Pen: ink appears normally right up to the window's edge, and the window does not catch strokes that start outside it.
1807. **Pen inside.** Put the S Pen on the window's picture and drag: no ink is written on the page behind it, the reference does not move and nothing is drawn on the reference. (Fingers still pan it.)
1808. **Fingers.** One finger pans, two fingers pinch-zoom the reference (up to 6x); the picture stays sharp after you let go (it is drawn again at the new zoom a moment later) and *Fit* returns to the whole page. Double tap or double click zooms in and back out.
1809. **Move.** Drag the header: the window follows the finger or pen and cannot leave the page area; dropped near an edge it settles against it (with *Reference window snaps to the edges* on, Settings, Reading).
1810. **Resize.** Drag the corner grip: the window grows and shrinks, never beyond the page area and never below a small minimum. The picture is drawn again once you let go, not while you drag.
1811. **Opacity.** The slider fades the window from fully solid to about a third; the ink under it shows through. Close and reopen: the opacity is the same.
1812. **Minimise.** The minus button turns the window into a small chip with the title at the same corner; tap the chip to bring the window back where it was; the chip can be dragged too.
1813. **Close.** The x button removes the window; opening the page action again opens it where it was left.
1814. **Remembered.** Move and resize the window, close the notebook (or restart Obsidian), open a notebook and open a reference: it is in the same place and size. Rotate the tablet: the window is inside the page area in both orientations and each orientation remembers its own place.
1815. **Small views.** On a phone-width view the window never covers more than the page area and still reaches the minimise, close and corner controls with a finger.
1816. **Same notebook.** A page of the notebook being written in shows its current ink when the window is opened, the stepper, zoom or resize is used (not live while writing).
1817. **Changing files.** Editing the referenced Markdown note or saving the referenced notebook elsewhere updates the window within a second or so; deleting the file closes the window; closing the notebook that the window shows (its own pages) closes the window.
1818. **Android cost.** With a large PDF or a page with a lot of ink the app stays responsive while the window is open and while writing; panning the reference is smooth; memory does not grow when you zoom in and out many times.
1819. **Look.** Light, dark, *Follow Obsidian theme*, phone and tablet width, Italian; every control has a label and works.

| Feature | Implemented | Automated test | Verified on hardware | Experimental | To do |
|---|---|---|---|---|---|
| Floating reference window (#107): a movable, resizable, see-through window over the page showing a notebook page, a PDF page, a picture or a Markdown note, read only; open from the page sheet, the palette, a link in a text box, the hover card and the file menu; minimise to a chip; place and opacity remembered per device and per orientation | yes | yes (`tests/ref-window.test.ts`: clamping, resizing, snapping, chip, remembered place per orientation, corrupt storage, pan and zoom limits, redraw rule, reference kinds, page choice; harness `refwindow` scenario: pen inside and outside, wheel zoom, move, resize, opacity, chip, note, picture, close) | | | PDF is not covered in the harness (no pdf.js there); the pen test uses synthetic events |

### 0.19 — gallery: Figures gallery (steps 1600-1619)

Figures gallery (roadmap #228). Use a notebook with two or three lectures (pages with a "Name — 2026-11-03" header), several photos (camera, board photo, pasted or imported pictures) and at least one anchored crop (*Anchored excerpt*), plus one photo placed twice.

1600. **Open.** *Figures…* in All actions, in the notebook menu and in the command palette opens a *Figures* dialog; the subtitle says how many figures on how many pages.
1601. **Section.** *This section* is selected and shows only the photos and crops of the lecture of the page in view. Going to another lecture and reopening shows that lecture's. In a notebook without lecture headers the choice is not offered and the whole notebook is shown.
1602. **Scope.** *Whole notebook* shows every figure in page order, top to bottom within a page. *Some pages* shows a field: type `2-3, 5`; the cards follow; a wrong text (`9-2`, a page that does not exist) says what is wrong and keeps the last good list.
1603. **Kinds.** The chips *All / Photos / Crops* show counts; a tap filters and a second tap clears; a kind with nothing in it is not offered.
1604. **Page badge.** Every card shows its page number (`p. 3`) and a small photo or crop mark.
1605. **Tap.** Tap a card: the dialog closes, the view scrolls to the figure and outlines it for about a second. Back returns to where you were.
1606. **Long press.** Long-press a card with the finger or the S Pen (or tap its ... button, or right-click with a mouse): a menu with *Go to page*, *Copy image*, *Insert into note…* and *Open original*.
1607. **Copy image.** *Copy image* then paste into a note or another app: the full picture arrives. If the device does not allow it a notice says so.
1608. **Insert into note.** *Insert into note…* adds the picture of that place on the page (as drawn, with any ink over it) and a link back to the note you were last in (or one you choose), like selection-into-note.
1609. **Open original.** *Open original* opens the stored picture file in a new tab.
1610. **Lazy.** In a notebook with dozens of photos the dialog opens at once; thumbnails appear for the cards in view first and the rest as you scroll; memory does not grow without bound while scrolling the whole list (the app stays responsive).
1611. **Missing file.** With a picture file removed from `_assets` (or not yet synced) its card shows "File missing or syncing"; the other cards are fine; a tap still goes to the figure.
1612. **Same picture twice.** Two cards of the same picture show the same thumbnail and each goes to its own place.
1613. **Read only.** Opening the gallery, jumping and copying do not change the notebook (modified time and *Unsaved* state); it also works in a read-only notebook.
1614. **Pen.** While writing with the pen no thumbnail is made until you pause.
1615. **Android.** Cards and the ... button are easy to hit; the long press does not also jump.
1616. **Look.** Light, dark, *Follow Obsidian theme*, phone width (two columns), Italian.

| Feature | Implemented | Automated test | Verified on hardware | Experimental | To do |
|---|---|---|---|---|---|
| Figures gallery (#228): grid of the photos and anchored crops of the section / notebook / typed pages, kind filter with counts, page badge, tap to go and outline, long press: copy image, insert into note, open original | yes | yes (`tests/figures.test.ts`: collection and reading order, rotation, scopes and sections, counts, thumbnail cache and queue); harness `doc=figures` | | Copying an image to the clipboard needs `ClipboardItem` (not in every Android WebView); decoding very large photos at a small size depends on the WebView | Run on the tablet with a real photo set |

### 0.19 — lecturelog: lecture log in the daily note (steps 1560-1579)

Lecture log (roadmap #221). Needs Daily notes (or Periodic Notes) on, and a timetable class running now that belongs to a notebook (set the class a few minutes around the current time).

1560. **Off by default.** Settings, Integrations: *Lecture log in the daily note* is off; *Lecture log heading* appears only when it is on. With it off, ending a lecture writes nothing to the daily note.
1561. **First line.** Turn it on, enter lecture mode in the class's notebook, write a few lines, leave lecture mode (End). Today's daily note ends with `## Lectures` and one line: time slot, bold course, the page count and (only if there are any) the open questions, then the link `pp. a–b`.
1562. **Link.** Tap the link in the daily note (reading view): the notebook opens at the first lecture page. Reorder pages: the link still opens the same page (it carries the page id).
1563. **Open questions.** Add two question markers on the lecture pages, resolve one, end the lecture again: the same line (not a second one) now says "1 open question".
1564. **Session goes on.** Re-enter lecture mode within the same class, add a page, end: still one line, now with the new range and count. The rest of the note (text before and after, other headings) is unchanged.
1565. **Closing the notebook.** Write during the class without lecture mode on, close the notebook before the class ends: the line is written or updated.
1566. **Custom heading.** Change the heading to `Classes`: the next line goes under a `## Classes` heading (created at the end if missing); an existing heading of that text collects the line at the end of its section, before the next heading of the same level.
1567. **Edited line.** Move the line elsewhere in the note, or edit its text but keep `^nb-lec-…`: the next update rewrites it where it stands.
1568. **Note missing, create off.** Delete today's daily note and turn *Create the daily note if missing* off: ending a lecture creates nothing. Create the note (or open today's note with the Daily notes command): within a moment the line appears in it. Restart Obsidian before creating the note: the line is still written afterwards.
1569. **Note missing, create on.** With *Create the daily note if missing* on, a missing note is made (with your Daily notes template) and holds the line.
1570. **Nothing written without writing.** Enter lecture mode and end it without writing anything: no line. A class you did not write in leaves no line.
1571. **Two classes.** Two classes in the same notebook on one day each get their own line.
1572. **Android.** All of the above on the tablet; no notice or delay while closing the notebook.
1573. **Look.** The two settings in light, dark, *Follow Obsidian theme*, phone width, Italian.
1574. **Your edits to the line survive.** After the first line is written, put it in a callout (`> `), turn it into a task (`- [ ]`) and type a few words after the link. Write more in the class and end the lecture again: the line is updated (new range and counts) and the callout mark, the task box and your words are still there. A copy of the line inside a code block is not touched. Rewrite the line completely by hand (keeping `^nb-lec-…`): the next end changes nothing and adds no second line.
1575. **Templater on a new daily note.** With *Create the daily note if missing* on and Templater filling new daily notes (folder template or "trigger on new file creation"), end a lecture on a day without a note: after a few seconds the note holds the template text and the lecture line. Delete the line afterwards: it does not come back.
1576. **Ten minutes after the class.** Write on the lecture page up to ten minutes after the class's time slot has ended: the line and (if on) the snapshot are updated with it. Write eleven minutes after: nothing changes.
1577. **Rename the notebook.** End a lecture, rename or move the notebook, write again in the same class and end it: still one line (with the new link), not two.
1578. **Switching apps.** Switch to another app and back several times during a class: no line is written and no snapshot is taken until the lecture ends.

| Feature | Implemented | Automated test | Verified on hardware | Experimental | To do |
|---|---|---|---|---|---|
| Lecture log: one line per lecture in the daily note under a configurable heading, rewritten in place by its block id, pending on this device while the note is missing and may not be made | yes | yes (`tests/lecture-log.test.ts`: snapshot, line, merge, pending list, writer on an in-memory vault) | | Never run against the real Daily notes / Periodic Notes plugins; the leave-on-close path depends on Obsidian's view unload order | Run on a real vault and on Android |

### 0.18 — mentions: notes that link to a page (steps 1400-1419)

Mentions (roadmap O7). Make a note with `[[Physics.notebook#p3]]` (use *Copy link to page* so the link carries the page id), another with `![[Physics.notebook#p3]]`, one with a plain `[[Physics.notebook]]`.

1400. **Badge.** Open the notebook and go to page 3: a small pill with a link icon and the count appears at the top left of the page area. On a page nobody links to there is no pill.
1401. **Count.** Two links to page 3 (one by id, one `#p3`, one embed) show 3.
1402. **Sheet.** Tap the pill, or *Mentions* in the page sheet, in the notebook menu or the command palette: the sheet lists, under *Linking to page 3*, one row per link with the note name, its folder and a line of context around the link.
1403. **Notebook group.** The plain `[[Physics.notebook]]` link, and a link to a page that was deleted, are under *Linking to the notebook*.
1404. **Open.** Tap a row: the note opens in a new tab at the line of the link; the notebook stays open.
1405. **Reorder.** Move page 3 before page 1: the link by id still counts for that page; the plain `#p3` link follows the number.
1406. **Refresh.** Add a link in a note: within about a second the badge and (when reopened) the sheet show it. Delete the link: it goes.
1407. **Read only.** The sheet writes nothing (check the modified time of the notes and of the notebook); it also works in a read-only notebook.
1408. **Big vault.** In a vault with many notes the sheet opens at once; the context lines fill in a moment later. A note over 1 MB shows no context line.
1409. **Android.** The pill and the rows are easy to hit with a finger; the pen does not draw when it touches the pill.
1410. **Look.** Light, dark, *Follow Obsidian theme*, phone width (the pill stays at the corner), Italian.

| Feature | Implemented | Automated test | Verified on hardware | Experimental | To do |
|---|---|---|---|---|---|
| Mentions: notes that link to the page in view (O7), count badge, sheet with context and open at the line | yes | yes (`tests/mentions-logic.test.ts`: link resolution by id / number, grouping, snippets); harness `doc=mentions` with a stand-in link index | | The link index of the harness is a stand-in; not run against Obsidian's real `metadataCache` | Run on a real vault |

### 0.17 — hover: hover preview of page links (steps 1180-1199)

Hover preview (roadmap O5). In a Markdown note write `[[Physics.notebook#p3]]` and one made by the plugin (*Copy link to page*). Page preview must be on in *Settings > Core plugins*.

1180. **Source.** *Settings > Page preview* lists a *Notebook* source; its Ctrl/Cmd switch starts on.
1181. **Hover.** Hold Ctrl (Cmd on Mac) and hover the link in reading view and in Live Preview: after a moment a card shows the page thumbnail, the notebook name and *Page 3 of 12*. Without the key nothing shows (with the switch on).
1182. **Setting.** Switch *Notebook* in Page preview off for the key: hovering alone shows the card. Turn the Page preview core plugin off: no card.
1183. **Page.** A `#p3&id=...` link shows that page even after pages were reordered; a plain `[[Physics.notebook]]` shows page 1; a link whose page was deleted says the page no longer exists.
1184. **Open.** Click the card: the notebook opens at that page (an already open tab is reused).
1185. **Pen.** Write with the pen in another notebook and hover a link: the thumbnail waits for the pen to be quiet, writing is not slowed.
1186. **Read only.** The notebook file is not modified by hovering (check the modified time).
1187. **Android.** Long press on a link: Obsidian's own behaviour is unchanged; if its preview appears, the card shows too.
1188. **Look.** Light, dark, *Follow Obsidian theme*.
1189. **Other previews.** Check that Obsidian's own popover for the notebook file does not appear beside ours (two popovers).

| Feature | Implemented | Automated test | Verified on hardware | Experimental | To do |
|---|---|---|---|---|---|
| Hover preview of notebook page links (O5) | yes | partly (`tests/hover-preview.test.ts`: logic only) |  | The `hover-link` event and the core plugin's `overrides` are not in Obsidian's typings; the popover has not been run in Obsidian | Harness screenshots |
### 0.17 — collections: saved collections (steps 1220-1239)

Saved collections (roadmap #120). Reference screenshots after `npm run harness:check`: `dev/harness/dist/shots/design/collections-*.png`. Use a library with tagged notebooks in several folders, a few favourites, one with a PDF, and a notebook not changed for over a month.

1220. **Rail.** Library sidebar: a *Collections* section above *Vault*. With none saved it says how to make one; the *New collection* row opens the editor.
1221. **Make one.** Name it, add tags separated by commas (the field suggests your tags), pick *Any of them* or *All of them*, a folder, a period and favourites; the line under the rules says how many notebooks match and changes as you type. *Save* stays off until there is a name. Saving opens the collection.
1222. **Filter.** The grid shows exactly the notebooks that meet every rule; the rail count is the same number; the header names the collection and its subtitle lists the rules. Archived notebooks are never in it.
1223. **Tags.** A rule tag `math` also finds a notebook tagged `math/algebra`; case does not matter; a tag only on one page counts.
1224. **Folder.** A folder rule includes its subfolders; a sibling folder with the same prefix is not included.
1225. **Period.** *Last 7 days*, *Last 30 days* and a date range on *Modified* or *Created*; a range with only *From* or only *To* works; a range with no date cannot be saved.
1226. **Favourites and PDF.** *Only favourites* includes starred and pinned notebooks; *Not favourites* the rest; *Has a PDF* / *Has no PDF* split the library by PDF pages.
1227. **Edit.** The pencil on a rail row (always visible on a touch screen) or in the header opens the editor with the rules filled in; saving updates the grid at once. A long press on the row offers *Edit collection*.
1228. **Search.** With a collection open, searching with *this view* only finds notebooks inside it.
1229. **Delete.** *Delete collection* in the editor asks first; cancelling changes nothing; confirming removes the row and returns to the library; your notebooks are untouched.
1230. **Two devices.** Make a collection on the tablet; after sync it appears on the phone (open the library again if it does not show at once). Change it on the phone and the tablet shows the change. Delete on one device: it disappears on the other. Look in `Notebooks/_meta/`: each device only writes its own `collections-<device>.json`.
1231. **Damaged file.** Make `collections-<your device>.json` unreadable (not valid JSON): saving or deleting a collection says the file cannot be read and leaves it as it is (a copy named `collections.unreadable-….json` is kept next to it); the collections from other devices still show.
1232. **Limits.** A name over 40 characters is cut; more than 50 collections is refused with a message.
1233. **Look.** Light, dark, *Follow Obsidian theme*, tablet and phone width; the editor's controls are at least 36 px tall; no sideways scroll.

| Feature | Implemented | Automated test | Verified on hardware | Experimental | To do |
|---|---|---|---|---|---|
| Saved collections: rules, live count, rail section, editor, per-device sidecar (#120) | yes | yes (`tests/collections.test.ts`, harness `doc=library`) |  | the date inputs use the platform's date picker | Notebook type / template rule |

### 0.16 — bulk: bulk import (steps 1010-1029)

Bulk import (roadmap #80). Reference screenshots after `npm run harness:check`: `dev/harness/dist/shots/design/bulk-*.png`. Use a folder with 3 PDFs (one big, 100+ pages), 5 photos (one HEIC), a text file and an existing notebook with the name of one PDF.

1010. **Menu.** Library *+ New* → *Import files…* and a folder's menu → *Import files here…* open the system picker; choosing several PDFs and images opens the dialog.
1011. **Drop.** Drag the same files from the system file manager (Windows) onto the library: a dashed frame and *Drop PDFs or images to import them* show; over a folder row or card the label names the folder and the row is highlighted; dropping opens the dialog with that folder chosen. Dragging a note from Obsidian's own explorer does nothing here.
1012. **Board.** Drop files on a Board column: after the import the new notebooks are in that column.
1013. **List.** One row per notebook with its name editable; a name that exists shows *Will be saved as “… 2”*; unsupported, empty, damaged, HEIC and duplicate files are under *Left out* with a reason; × leaves a file out.
1014. **Grouping.** With two or more images *All images into one notebook* appears: one row, pages in file-name order (scan 2 before scan 10), each page the shape of its photo. PDFs stay separate.
1015. **Look.** Paper and cover chosen once apply to every notebook made.
1016. **Run.** *Import n notebooks* shows progress with the current file; a 100+ page PDF does not freeze the window (scroll the dialog while it works). Existing notebooks are never changed.
1017. **Stop.** *Stop after this file* ends the run after the file in progress; the summary says *Import stopped* and how many were not started. Closing the dialog during the run does the same and shows a notice.
1018. **Summary.** Counts, the reasons for each file left out, *Open* opens the first notebook made.
1019. **Android.** The picker allows several files; the dialog fits a phone (buttons at least 40 px, no sideways scroll); a photo from the gallery is accepted.
1020. **Look.** Light, dark, *Follow Obsidian theme*, tablet and phone width.

| Feature | Implemented | Automated test | Verified on hardware | Experimental | To do |
|---|---|---|---|---|---|
| Bulk import dialog, runner, drop and picker (#80) | yes | yes (`tests/bulk-import.test.ts`, harness `doc=bulk`) |  | PDF page measuring is pdf.js's; yielding is between files and steps | Drop of a vault file from Obsidian's explorer |

### 0.15 — storage: Storage manager (steps 860-879)

Storage manager (roadmap 128). Reference screenshots after `npm run harness:check`: `dev/harness/dist/shots/design/storage-*.png`. Use a library with a few notebooks, one with a big photo (several MB) also used by a second notebook, a copy of a notebook made by sync, and some days of backups.

860. **Open.** Library sidebar → *Storage* (also the command *Storage: size of notebooks…* and *Settings → Library → Storage manager*): the dialog shows a progress line with *Stop* while it reads, then the total, a coloured bar with a legend and the notebooks.
861. **Stop.** Open it on a big library and tap *Stop* (or ×) while it reads: it closes and nothing in the vault changed.
862. **Sizes.** Each notebook row says where its size comes from (notebook, files, backups, journal); sort by size, name, files, backups; the rows add up to the total. Tap a row: the notebook opens.
863. **Unused files.** Right after the first scan none is offered (the library check's note says they are not offered yet); a day later the same scan lists them. Insert a picture in a notebook and delete the page: its picture is not listed (the deleted page can still be restored). Delete a notebook to the library trash: its pictures are not listed.
864. **Move unused.** Untick one, tap *Move n to the trash folder*: the dialog lists the files; Cancel changes nothing; the button moves them to `Notebooks/_trash/assets/` (look in the file explorer; move one back to `_assets/` and the notebook shows it again).
865. **Duplicates.** Put the same image in `_assets/` under another extension: *Merge…* lists what stays and what moves; the notebooks still show the picture.
866. **Heavy pictures.** The photo shows under *Heavy pictures* with the number of notebooks; change the threshold chip (1 / 2 / 5 / 10 MB). *Downscale…* lists the notebooks; confirm: a smaller copy appears in `_assets/`, the notebooks show the same picture, the original is still there. With one of those notebooks open, undo brings the big photo back in one step.
867. **Busy notebook.** With a notebook open and a pen stroke in progress (or read-only), downscale: that notebook is skipped and the notice says so; nothing is written to it.
868. **Old backups.** The list shows backups older than 90 days (not the newest of a notebook), old version-history copies and conflicted copies identical to their notebook; recovery backups and a copy that may be your own are not ticked. Confirm: they go to the trash according to Obsidian's *Deleted files* setting (a copy goes to the library Trash and can be restored).
869. **Different copy.** A copy made by sync that differs from its notebook is shown with *Open* and no tick.
870. **Look.** Light, dark, *Follow Obsidian theme*, phone and tablet width: no sideways scroll, every button and chip at least 40 px, no Obsidian grey buttons.

### 0.14 — nbmap: notebook map (steps 770-789)

Notebook map (roadmap 408). Reference screenshots after `npm run harness:check`: `dev/harness/dist/shots/nbmap-*.png`. Use a notebook of 20+ pages with a few question, gap and homework markers, an empty page and a practice copy.

770. **Open.** Open the page panel and tap the grid button (*Notebook map* / *Mappa del quaderno*): a dialog shows every page as a thumbnail; the subtitle says how many items are open.
771. **Badges.** A page with an open question, a gap, homework or a key point shows one badge per state (a number when there are several); a nearly empty page is badged *Empty*; a practice copy with nothing written is badged *Practice*.
772. **Resolved items.** Tap a question marker on the page to resolve it, reopen the map: that badge is gone (key points never go away).
773. **Filters.** The chips list only states that exist, with the number of pages. Tap one: only those pages stay; tap it again, or *All pages*, to see everything.
774. **Tap to go.** Tap a card: the dialog closes and the page opens. The page you were on is outlined when you reopen the map.
775. **Lectures.** The first page of each lecture (the one with the lecture header) has an accent edge on its card.
776. **Homework.** A homework card shows the earliest due date of its open homework.
777. **Cost.** In a notebook of 100+ pages the dialog opens at once, thumbnails fill in while you scroll, and writing is not interrupted. Reopening it is immediate.
778. **Touch.** Cards and chips are easy to hit with a finger and the S Pen; scrolling with a finger does not open a page.
779. **Dark, light, Obsidian theme, phone width.** Check the dialog in both themes, with *Follow Obsidian theme*, and on a phone (the grid narrows).
780. **No change to the file.** Open the map and close it without editing: the file is not rewritten.

### 0.13 — home2: Home, revised structure (steps 620-659)

Use a vault with a few subject folders and notebooks, the timetable with a class running now (or one that starts in a few minutes) linked to a course folder (*Timetable* → class → *Notebook or folder*), and Italian as the language for the second pass. Reference screenshots after `npm run harness:check`: `dev/harness/dist/shots/design/home-*-full.png`.

620. **Greeting.** Home's subtitle reads "Buonasera, <name> · N pagine scritte oggi" (the part of the day follows the clock: before 12 morning, 12-18 afternoon, 18-22 evening, otherwise night). With nothing written today it ends "Pronto quando vuoi". Write a page and come back: the count rises.
621. **Your name.** Settings → *Appearance* → *Your name*: type a name, reopen Home: the greeting uses it; clear it: the greeting has no name.
622. **Continue: lecture in progress.** With the class running, the first card shows *In class now · <room>*, the course, its notebook and a large page thumbnail (the page you edited last, else the first). Tap the card or *Open the lecture*: the notebook opens at today's lecture page (no second page for the same lecture).
623. **Continue: course folder.** With the class linked to a folder (not a notebook), the card opens that folder's latest notebook, or the one named like the course.
624. **Continue: no notebook yet.** Link the class to an empty folder: the thumbnail is a dashed blank and the button says *Crea un quaderno per <course>*: it creates the notebook in that folder and opens it.
625. **Continue: no class.** Outside class hours the card says *Riprendi da dove eri rimasto* with the notebook you were reading (tap: it opens at that page).
626. **Continue: empty vault.** With no notebooks the Continue slot shows the empty state that teaches the first step (*Create a notebook · Create a folder · Import a PDF*); the Quick page card is still there.
627. **Quick page.** Tap *Pagina veloce*: Quick notes opens (made the first time) at a new blank page of the same size and paper as the last one. Tap it again without writing: the blank page is shown, no second blank page is added. Undo removes an added page.
628. **Quick actions.** Four low tiles (about 70 px) with icon and title only; press and hold or hover one: its description appears as a tooltip. Each still runs its action.
629. **Folder grid.** Subject folders are three columns on a wide view, two on a tablet in portrait, one on a phone; the last cell is the dashed *Crea una cartella* card, filling the rest of the row (no gap); tapping it opens the creation dialog on the Folder tab.
630. **Recent notes.** Grouped by notebook (header with subject pill, then its pages with a page thumbnail on the left and ⋯ on the right). Thumbnails appear as the rows scroll into view. Tap a page: it opens on that page; tap a header: the notebook.
631. **Page menu.** ⋯ on a page: *Open page*, *Open in a new tab*, *Show in the library* (the folder opens and the notebook's card is flashed), *Pin to the top*, *Favourite*; each does what it says.
632. **Subject filter.** The chips under *Recent notes* (with two or more subjects): choosing one keeps only that subject's notebooks; *All* brings the rest back.
633. **Pages chart.** *Pages written* shows a bar per day for the last 7 days (today in solid accent); *14 days* switches (the choice is remembered). With nothing written the chart says so and *Write now* opens the notebook to continue.
634. **Streak and time.** After writing on consecutive days, *Days in a row* counts them (a day without a page yet does not break it until the day ends); *Writing time (estimated)* shows hours and minutes in which something was written. Both are hidden when zero.
635. **PDF hint.** With no PDF notebook, the PDF tile reads *Importa il tuo primo PDF →* and starts the import; with PDFs changed in the period it shows their number.
636. **Subject split.** *Materia più attiva* names the subject with most pages written and shows a bar split in the subjects' colours with a legend.
637. **Sidebar pages.** In the VAULT tree each folder shows its notebook count and its page count ("3  13 pag."); press and hold a row: the tooltip says both in words.
638. **Pinned notebook.** ⋯ → *Pin to the top* on a recent note (or a notebook menu): it appears under *Fissati* above *Vault*; tap it: it opens.
639. **Pinned folder.** Press and hold (or right click) a subject card or a folder in the tree → *Fissa nella barra laterale*: the folder appears under *Fissati*; tap it: the folder opens. Pin on one device, wait for sync: the other device shows it too.
640. **Unpin.** Press and hold a pinned row → *Unpin*: it leaves the section; with nothing pinned the section says how to pin.
641. **Rotation and phone.** Rotate the tablet: the grids change columns and nothing scrolls sideways. On a phone the Continue card, Quick page, quick actions (two per row) and folders stack.
642. **Light, dark, Obsidian theme.** All of the above is readable in light and dark and with *Follow Obsidian theme*.
643. **Pen, finger, mouse.** Every card, row, chip, switch and menu responds to a pen tap, a finger tap and a click; targets are at least 40 px.
644. **Nothing else changes.** Notebook files are unchanged by looking at Home; an error in one section shows an error card and the rest of Home is still drawn.

### 0.14 — layout (steps 790-799)

Implemented, not verified on hardware.

790. **Rotate a notebook.** Open a notebook on the tablet, turn it sideways and back. Expected: no flicker of the toolbar or panels at the turn; the page keeps its place.
791. **Short landscape.** Phone sideways: the toolbar and the context bar are tighter, and the page gets more of the height.
792. **PDF split.** Notebook with a PDF reference pane: tablet sideways shows page and PDF side by side; upright, stacked. Drag the view's width around 700 px (split Obsidian panes on a desktop): the split does not flip back and forth.
793. **Home sideways.** Home on a phone sideways: compact header, three folder columns; tablet sideways: four quick actions in a row.
794. **Dialogs sideways.** Phone sideways, open *New*: the dialog fits the screen, its body scrolls, the footer buttons stay reachable.
795. **Keyboard.** Tablet sideways with the on-screen keyboard (rename a notebook): the layout settles in short landscape and returns when the keyboard closes.

### 0.16 — pdftext: copy text from a PDF, PDF outline and links (steps 970-989)

Use a real PDF with text and an outline (a textbook or lecture slides with a table of contents and clickable links), imported into a notebook; once with all pages, once with a range of pages (*Insert PDF pages* from–to) and some pages moved or deleted. Reference screenshots after `npm run harness:check`: `dev/harness/dist/shots/design/pdftext-*.png`.

970. **Mode.** On a PDF page open the contextual bar (or the sheet): *Select text*. A bar *Drag over the PDF text…* with *Done* appears at the bottom; the action shows as on. Write with the pen: nothing is drawn, whatever the tool (pen, highlighter, eraser selected before). Choose a tool: the mode ends.
971. **Pen.** Drag the S Pen over a line: the text under it is highlighted exactly (start and end inside words), and a bubble with *Copy*, *Copy as quote* and × appears. Drag from one line down to another and across a paragraph: the text between is highlighted line by line.
972. **Finger.** With *Write with finger* off, drag a finger over text: it selects (it does not scroll). Pinch to zoom and two-finger pan still work; the highlight follows.
973. **Word.** Tap a word with the pen and with a finger: the word is selected. Tap empty paper: the selection goes. A drag that starts on the bubble is only the bubble (use the × or tap elsewhere first).
974. **Copy.** Tap *Copy*, then paste into an Obsidian note: the plain text, with a word broken by a hyphen at a line end joined. Tap *Copy as quote* and paste: a block quote, then `— <PDF name>, p. <page of the PDF> · <link to the notebook page>`; the link opens that page when followed from the note. With a keyboard: Ctrl+C copies the selection.
975. **Scan or no text.** A page of a scanned PDF (no text) and a page without a PDF (a blank page): a notice says there is no text there; nothing is drawn and no error appears.
976. **Margins and zoom.** Widen the page margins (*PDF page margins*) and crop margins on: the highlight stays on the words. Zoom in and out and scroll: the highlight and the bubble follow the text.
977. **Leave.** *Done* (or Escape on a keyboard): the bar, the highlight and the bubble go and the pen writes again. Undo and redo are unaffected by selections. Switch to another notebook tab and back: the mode belongs to its view.
978. **Read-only.** Turn read-only mode on (or hide annotations): *Select text* still works with the pen and the finger.
979. **Heavy PDF.** On a PDF of hundreds of pages: entering the mode and dragging is as fast as on a small one; the first drag on a page may take a moment (its text is read then) and then selects.
980. **Outline.** Open the page panel, Outline. The PDF's outline entries appear under the PDF's row, nested like the PDF's own, each with its notebook page number. Tap one: the notebook goes to the page that shows that PDF page. With a range or moved pages: entries for pages that are not in the notebook are not listed (or sit on the next page that is, with a note under them).
981. **Setting.** *Settings › Pages › Outline › PDF outline*: *Its own section* puts the entries under a *PDF outline* heading above the rest; *Not listed* removes them; *Mixed into the outline* is the default. The other sources (bookmarks, slides, headings, markers) are unaffected.
982. **Cached.** Close the notebook and open it again with the panel on Outline: the entries appear at once. A PDF without an outline lists nothing and is not parsed again.
983. **Internal link.** On a page with a link to another page (a table of contents), tap it with a finger: the notebook goes to the page that shows the target; *Back* (history) returns. With the page not in the notebook: a notice says so.
984. **Pen and links.** Tap a link with the S Pen in the normal mode: a dot is written (links are followed by a finger, a Ctrl-click, in the *Select text* mode, or when read-only). In the *Select text* mode a pen tap on a link follows it (links are outlined with a dashed line in that mode).
985. **Web link.** Tap a link to a web address: a dialog shows the address; *Cancel* does nothing; *Open link* opens it in the browser. A `javascript:` or `file:` link is refused with a notice.
986. **Setting off.** *Settings › Reading › Follow links in PDF pages* off: a finger tap on a link does nothing.
987. **Look.** Light, dark and *Follow Obsidian theme*, phone and tablet width: the bar, the bubble and the outline section use the design tokens, no sideways scroll, buttons at least 40 px.
988. **Android.** The clipboard write works from the bubble's buttons on the tablet (if it does not, the notice says so and nothing else breaks).
989. **Windows.** Mouse drag selects; Ctrl+click follows a link; Ctrl+C copies.

### 0.14 — smartplus (steps 740-749)

Implemented, not verified on hardware.

740. **The strip.** Open a notebook, tap + (add page). Expected: a strip of two or three chips and *More...* appears above the bottom edge; no page is added yet. Tap + again: it closes.
741. **One tap.** Tap the first chip (same paper). Expected: one page with this page's paper is added right after the current one and shown; Undo removes it.
742. **Exercise.** On a PDF page, tap + : *Exercise page* is among the first chips; tapping it adds a page with the exercise paper and the size of the page.
743. **Slide.** Open a PDF beside the notes (side by side), tap + : *Notes for this slide* is first and adds the linked notes page for the slide in view.
744. **Learning.** In a notebook with some Cornell pages, tap + on a ruled page: *Cornell page* is offered. Take *Blank page* a few times: it climbs. Another notebook is not influenced.
745. **More.** Tap *More...*: the page sheet opens with every way to add a page (blank, template, PDF, image, scan).
746. **Steps aside.** Open the strip, put the pen down on the page: the strip disappears and the stroke is drawn. Also gone after ten seconds and when you scroll to another page.
747. **Phone and tablet.** The chips are at least 44 px tall, do not overflow the screen (stacked on a phone), and are readable in light and dark.
748. **Read-only.** In read-only mode + shows nothing and adds nothing.
749. **Commands.** Command palette: *Add page* adds a page right away (same size and paper as the page in view, one undo step; a hotkey bound to it behaves the same). *Add page: suggestions* opens the strip, like tapping +. In read-only mode neither does anything.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Smart "+" (#410): ranked one-tap chips for the likeliest new pages, *More...* to the page sheet | yes | ranker, history, bounds; harness strip check | | | |

### 0.15 — views: Board and Calendar (steps 900-929)

Implemented, not verified on hardware. Needs the tablet with the S Pen; steps 912-915 need two devices on the same synced vault. Reference screenshots after `npm run harness:check`: `dev/harness/dist/shots/design/*-views-board.png`, `-views-calendar.png`, `-views-board-editor.png`.

900. **Open the Board.** In the library tap the Views button in the header (the board icon) and choose *Bacheca* (Board): four columns *Da fare*, *In corso*, *Fatto*, *Da stampare*; every notebook of the place is in *Da fare* at first. The count of each column is right. Choose *Schede* (Cards) to go back; the grid or list you had comes back.
901. **Scope.** Open a subject folder, then Board: only its notebooks (and those of its subfolders). The Board is not offered on *Subjects*, *Tags* and the archive; archived notebooks are not on it.
902. **Move with the menu.** Tap ⋯ on a card: *Sposta in…* lists the columns with the current one checked. Choose *Fatto*: the card is in that column and a notice says so. Do the same from a card's long-press / right-click menu (*Sposta in…*).
903. **Drag with the S Pen.** Put the pen on a card and drag it to another column: the card follows as a ghost, the column under the pen is highlighted, the card moves on lifting the pen. Dragging to the same column does nothing. Dragging near the left or right edge scrolls the board.
904. **Drag with a finger.** Press and hold a card for about half a second (it lifts, a short vibration), then drag to a column. A finger that moves before the hold scrolls the page instead. Lifting without moving opens the card's menu.
905. **Drag with the mouse (Windows).** Click and drag a card to another column; a plain click opens the notebook.
906. **Phone.** One column at a time under a strip of column tabs with counts. Tap a tab to switch column. Press and hold a card, drag it onto another tab: it moves there. ⋯ › *Sposta in…* works too.
907. **Drop on a folder.** With the sidebar visible, drag a card onto a folder in it: the notebook moves to that folder (as in the grid). On a phone this is not offered while a column is shown.
908. **Keyboard.** Tab reaches each card and its ⋯ button; Enter opens the notebook; the menu is reachable from the keyboard.
909. **Edit the columns.** Tap the sliders icon at the top right of the Board (or *Settings › Library › Board columns › Open*): rename a column, pick another colour, move one up or down, add one (up to 8), remove one. Each change is saved at once and the Board behind redraws. Removing a column that has notebooks: they show in the first column; *Ripristina i predefiniti* brings the four default columns back and the notebooks return to theirs. A column with an empty name shows the translated default.
910. **Statuses are kept.** Close the Board, restart Obsidian, open it again: the statuses are as you left them. Rename or move a notebook in the library: its status follows (it is stored under the notebook's id). No notebook file was modified (look at the file's modified time).
911. **File.** In the vault, `<Notebooks>/_meta/board-<device>.json` exists with one line per notebook you moved. Put unreadable text in it (close the library first), open the Board and move a card: nothing is overwritten, a notice says the file cannot be read, and a copy `board.unreadable-*.json` appears next to it.
912. **Two devices.** On the phone move a notebook to *Fatto*; wait for the sync; open the Board on the tablet (or reopen it): the notebook is in *Fatto*.
913. **Last writer wins.** Move the same notebook to different columns on both devices, one after the other, then sync both: both show the later one.
914. **Different notebooks.** Move notebook A on the phone and notebook B on the tablet without syncing in between: after syncing both moves are there.
915. **Dark, light, phone, Obsidian theme.** The Board is readable in dark and light, with *Follow Obsidian theme*, on a phone, on the tablet in both orientations; the page does not scroll sideways (the columns do, inside the board).
916. **Open the Calendar.** Views button › *Calendario*: a month with today marked; days you wrote on this device have dots in the colours of your notebooks and a darker tint when busier.
917. **A day.** Tap a marked day: the notebooks written that day with "N pagine scritte" and, for pages this device remembers, *Pagina N* chips. A notebook that only changed (on another device) says *Modificato*; one made that day says *Creato*.
918. **Open at the page.** Tap a *Pagina N* chip: the notebook opens on that page. Tap the notebook row: it opens on the first page written that day (for a page this device no longer remembers, the notebook is read once to find it).
919. **Months.** The arrows change month; *Oggi* returns to today; days of the neighbour months are greyed but tappable. The week starts on Monday (Sunday in the US locale).
920. **Phone.** A strip of seven days and an agenda of the week: each day with writing is listed with its notebooks; tapping a strip day highlights its section. The arrows change week.
921. **Another device.** Write in a notebook on the other device, sync, open the Calendar here: that day shows the notebook as *Modificato* (no page detail).
922. **Scope and nothing opened.** The Calendar of a subject folder shows only its notebooks. Opening the Calendar does not open or modify any notebook (file modified times are unchanged); it is quick with many notebooks.
923. **Nothing else changes.** The grid, the list, Home and the other places are as before; the `[aria-pressed]` grid / list button still toggles; an error in the Board or the Calendar shows an error card and the rest of the library is drawn.

### 0.14 — sections: dynamic sections (steps 750-769)

Implemented, not verified on hardware. Use two devices on the same synced vault when you can (a phone and the tablet); steps 750-757 work with one device. Reference screenshots after `npm run harness:check`: `dev/harness/dist/shots/design/*-sections.png`.

750. **Now with a class running.** With a class in progress (timetable linked to a notebook), open the library: the dashboard starts with *Adesso* and its first row is the class's notebook ("Lezione in corso"). Tap the row: the notebook opens.
751. **Now: open and recent.** Open a notebook in a tab and write a few strokes, come back to the library: the notebook is in *Adesso* ("Aperto ora" or "Modificato ..."). A notebook you last wrote in more than four hours ago and that is not open is not there. With nothing in progress the section is not shown at all.
752. **To complete: markers.** Add a question, a gap and a homework marker to a notebook (one marked done): *Da completare* lists the notebook with "2 segnaposto aperti". Mark them done or resolve them: the notebook leaves the section after the library re-reads it.
753. **To complete: pages to fill.** In a notebook with writing on page 3, leave page 2 blank: it is listed with "1 pagina da riempire". Import a PDF and write on its first page only: the unannotated slides after it count too. A brand new notebook with one blank page is not listed. A practice copy (*Redo this exercise*) with no ink yet is listed too.
754. **Sidebar counts.** The sidebar shows *Adesso*, *Da completare* and *Modificati altrove* under Notebooks, each with its count, only when they have something. Tap one: the library shows those notebooks as the usual grid (or list), with a title and a hint; the count matches.
755. **Home shortcuts.** On Home a row of chips (the same names and counts) sits under the Continue row; tapping one opens the section. With nothing in any section the row is not shown.
756. **Section panels.** The library's *All* dashboard shows the panels above the folders: at most five rows each, *Show all* opens the section as a place. Each row opens its notebook; its menu is the notebook menu.
757. **Dark, light, phone.** The panels, chips and sidebar rows are readable in light and dark and with *Follow Obsidian theme*; on a phone the panels stack and nothing scrolls sideways.
758. **Changed elsewhere: first run.** On a device that never had this feature the section is empty the first time (notebooks already there are not "changed").
759. **Changed elsewhere: another device.** Write in a notebook on the phone, wait for the sync, open the library on the tablet: the notebook is in *Modificati altrove* ("Cambiato ..."). Writing in it on the tablet itself does not put it there.
760. **Seen by opening.** Open that notebook from the library: it leaves the section (and the sidebar count drops). Open the library again later: still gone until the other device changes it again.
761. **Mark as seen.** With several notebooks in the section, *Segna come visti* (on the panel, or the check icon in the header of the place) clears them all and shows a notice; the sidebar item and the Home chip disappear.
762. **Own edits are not news.** Write in a notebook on the tablet, wait for the save, open the library: it is not in *Modificati altrove*.
763. **Nothing else changes.** Notebook files are unchanged by looking at the sections; the seen record lives in the device's local storage (it is not in the vault and does not sync); an error in one panel shows an error card and the rest of the library is drawn.

### 0.13 — polish (steps 670-679)

Implemented, not verified on hardware.

670. **Art arrives without a stall.** Open Home on the tablet after a restart. Expected: the page is usable at once; folder cards may show their art a moment later with a short fade; scrolling and the pen are not blocked.
671. **No flicker.** Switch Home to the library and back: cards that were shown keep their art without fading again.
672. **Reduced motion.** With the system's reduced motion on, no art is drawn (as before); with it off, the fade is short.
673. **Veins in the creation dialog.** New, Notebook, *Change cover*: the style picker has *Veins*; pick it, the cover preview changes. Create the notebook: its card in the library shows the veins cover.
674. **Veins by keyword.** New folder named "Biologia" (or "Anatomy"): the card starts on veins; pick another style, then edit the name: your choice stays.
675. **Veins folder.** Create a folder on veins: its card (Home, library) shows veins after a restart.
676. **Older plugin.** Optional: open a veins notebook on a device with 0.12.x: it opens and shows a branches cover.
677. **Toolbar at 740 px.** Phone sideways (about 740 px wide): the toolbar shows Back among its quick buttons (at least three). On a tablet in portrait the buttons are 44 px.
678. **Quick page twice.** Tap Home's *Quick page* and the ribbon item at once on a vault without Quick notes: one *Quick notes* is made.
679. **Open in new tab.** Recent notes, the menu, *Open in new tab* on a notebook that is open: the open tab is shown, no second tab appears.

### 0.14 — toolbar: the generative interface (steps 680-699)

Implemented, not verified on hardware. Settings > Appearance has three switches (all on) and *Reset the adaptive toolbar*.

680. **Grid paper.** Open a notebook page with grid or dotted paper. Expected: the shape tool has a small dot under its icon (it does not move or change order); on a tablet the ruler button is the first of the quick actions.
681. **Ruled paper.** Go to a ruled page. Expected: pen and text have the dot; the shape tool does not. On a plain (blank) page no tool has a dot.
682. **Slide.** Open a landscape PDF page (a slide). Expected: the bar at the bottom is called *Slide* and starts with the snapping highlighter, search and margins; the highlighter tool has the dot. A portrait PDF page is *PDF page*: search and the snapping highlighter, no *Slide*.
683. **Snap button.** On a PDF page tap the snapping highlighter in the bar: it lights up, and the highlighter's own option (select the highlighter, tap it again) shows the same state; highlighting a line of text now follows the text. Tap it again: back to free highlighting. The command palette has *Toggle highlighter snap to text lines*.
684. **Page-type switch.** Settings, *Toolbar follows the page* off: no tool has a dot, the ruler is no longer first on grid paper, the PDF bar is *PDF page* again with the designed order. On again: it returns.
685. **Pin with the pen.** Press and hold (about half a second) a quick action with the pen or a finger. Expected: a menu *Pin to the toolbar*; choose it: the action gets a small dot in its corner and is the first quick slot. Turn pages, change pen, use other actions a lot: it stays first. Press and hold again: *Unpin from the toolbar*. A normal tap on the same button still runs the action and does not open the menu.
686. **Pin from All actions.** Open All actions, press and hold a row that has a quick-action version (Fit width, Add page, Insert image...): same menu; the row shows a pin and the action is in the toolbar. A fourth pin shows "You can pin up to 3 quick actions".
687. **A pin that does not apply.** Pin *Back*: with no page history it is not shown; after following a page link it appears first.
688. **Learning per notebook.** Use an action in one notebook (for example Fit width, ten times) and another (for example One page at a time) in a second notebook. Expected: each notebook moves its own favourite up among the quick slots after a few uses; a notebook keeps the device order until it has about eight uses. Switch *Toolbar learns from each notebook* off: the order is the designed one in both.
689. **Reset.** Settings, *Reset the adaptive toolbar*: pins are gone and the quick slots return to the designed order; the three switches keep their state.
690. **Ink selection.** With the lasso select some handwriting. Expected: the bar says *Ink selection* and shows Copy, Cut, Save as stamp first; the second row has Select similar; the colour and width rows are there.
691. **Picture selection.** Select an image. Expected: *Picture selection* with White to transparent and the layer order (front, back) in the first places; no colour row is shown.
692. **Text selection.** Select a text box. Expected: *Text selection*; Link comes right after the clipboard actions; the colour row only (no widths).
693. **Mixed selection.** Select ink and an image together. Expected: *Mixed selection*; the second row starts with Align; layer order is on the first row.
694. **Selection switch.** Settings, *Selection bar follows what is selected* off: the bar is called *Selection* with the designed order for every kind of selection.
695. **Targets and fit.** On the phone and the tablet, in the dark and light themes: all buttons of the bar are easy to hit, nothing is cut off or scrolls sideways, also in the large toolbar size.

### 0.14 — lecture (steps 700-719)

Implemented, not verified on hardware. Needs a timetable (Settings → Study → Class timetable → Edit timetable…) with a class that is on now.

700. **Setting.** Settings → Study → Class timetable: *Lecture mode* is a dropdown (Off, Ask me, Automatic), *Ask me* by default; it is in Italian when the language is.
701. **Ask.** Add a class that is on now (or starts within the *Start early* minutes), linked to a notebook (or named like the course). Open that notebook. Expected: a banner at the bottom, "<course> is in progress (<room>). Start lecture mode?", with *Start* and *Not now*; nothing else changes yet.
702. **Start.** Tap *Start*. Expected: the banner goes, a small chip appears at the top left ("<course> · until HH:MM", *End*), the contextual bar shows the lecture tools (board shot, markers…), and a new last page has the header "<course> — <date>" and, under it, the time slot, room and lecturer.
703. **Not now.** Open another notebook of the same class (or close and reopen this one without the page), tap *Not now*. Expected: the banner goes and does not come back for that class today (it comes back for the next occurrence).
704. **End by hand.** Tap *End* on the chip. Expected: the chip and the lecture bar go; it is not offered again for this class today.
705. **Automatic.** Set *Automatic*, open the class's notebook. Expected: no banner; the chip appears and a notice "Lecture mode: <course>"; no page is added yet (the notebook is not changed by opening it). Write the first stroke with the S Pen: the lecture page is added at the end, once (the view stays where you are writing; undo removes the page in one step, then the stroke). A notice "Lecture page added" with a *Go* button appears at the next pause in writing; *Go* scrolls to the new page. Later strokes add nothing.
706. **Not while writing.** In *Automatic*, start writing with the S Pen as you open the notebook during a class. Expected: nothing changes until you pause for about two seconds.
707. **The class ends.** Stay in lecture mode past the class's end. Expected: the chip and the lecture bar go, and a notice "<course> is over. Lecture mode is off."; if you are writing at that moment it waits for the pause. Your pages are untouched.
708. **Wrong notebook.** Open a notebook that is not the class's. Expected: no banner, no chip.
709. **Off.** Set *Off*. Expected: nothing is offered; the *Lecture mode* command (All actions sheet, Lecture) still switches it on, without a class (chip says "Lecture mode") and off again.
710. **Back to back.** Two classes of the same notebook one after the other. Expected: when the first ends, the second is offered (or started in automatic) at the next check (within 30 seconds).
711. **Continue card.** On Home, tap the lecture in progress on the Continue card. Expected: the notebook opens and the banner (or automatic start) follows.
712. **Lecturer field.** In the timetable editor each class has *Lecturer (optional)*; save, reopen: it is kept; `_timetable.json` has a `lecturer` for it only when filled.
713. **New lecture by hand.** In a class's notebook during the class, command *New lecture*. Expected: the dialog says "The page will also say: <slot · room · lecturer>"; the added page has them. Change the date or the title: the line (and the page) lose the class details.
714. **Slide reference.** Open a PDF beside the notes at a slide (side by side), then *New lecture*. Expected: the page has "Slides: [[<file>.pdf#page=N]]"; tap the link: the PDF opens at that page.
715. **Read-only.** In read-only mode (the user's, or sync safety's *Open read-only*), lecture mode can still be switched on, but *Start* and the command add no page, say so in a notice ("This notebook is read-only: the lecture page was not added.") and nothing is saved.
716. **Phone.** On a phone the banner stacks its buttons under the text, the chip fits the width and no control is under 44 px.
717. **Resume.** In *Automatic* with the class's notebook open and no stroke written yet, send Obsidian to the background for a minute and come back (and wait 30 s with the app in front). Expected: the chip stays, no page is added and the notebook shows no unsaved change; if sync brought a newer copy meanwhile it is simply opened, nothing goes to a backup.
718. **Reopen.** In *Automatic* after the page was added, delete that page, close the notebook and open it again during the same class. Expected: the chip returns, no page is added again (also after a restart of Obsidian); the next day's class is handled afresh. Likewise *Not now* and *End* stay remembered for that class after reopening the notebook.

### 0.15 — states: drawings with states (steps 800-819)

Drawings with states (#241, format v13). Reference screenshots after `npm run harness:check`: `dev/harness/dist/shots/states-*.png`. Open a notebook page and draw a small physics figure: a block on a line, an arrow beside it and a spring.

800. **Make a part.** Open *Drawing states* (All actions, or the page sheet): the strip shows *As drawn*, an empty *Parts* row and a plus button. Lasso-select the block (and only it): *Make part* appears in the strip (it is also in All actions, Selection). Tap it: *Part 1* is in the *Parts* row.
801. **Add a state.** Tap the plus: *State 1* is created and shown. Add a second part (the arrow) the same way, then a second state: it starts from the first one.
802. **Move a part in a state.** In *State 1* tap *Part 1*: its handles appear and the editor row opens. Drag the part, turn it with the round handle, scale it with the corner: the figure changes in *State 1* only; *As drawn* still shows the original. The strokes of the part are not rewritten (check by switching to *As drawn*).
803. **One undo step.** Undo after a drag: the part goes back where it was in that state, in one step; redo brings it back. Make part, add state and every pose edit each undo in one step.
804. **Colour and visibility.** In the editor row tap a swatch: the part is drawn in that colour in this state only. Tap the eye: the part is hidden in this state only; tap again to show it. *Original colour* and the round arrow (put back where it was drawn) work.
805. **Switch and step.** Tap each chip; use the previous/next buttons (they wrap through *As drawn*). The page shows the chosen state at once. Switching does **not** save anything: close and reopen the notebook and it opens with the saved default state again (step 819), and the file is not rewritten by switching.
806. **Play.** Tap play: each state shows for about a second and a half, ending on the last one; tap Stop in the middle: it stops where it is. Playing does not write the notebook.
807. **Ink tools leave a moved part alone.** In a state that moves the block, erase or lasso over the place where the block was *drawn*: nothing is erased or selected. Switch to *As drawn* and erase it there: it goes (and, in every state, the part keeps its other strokes).
808. **Ordinary ink.** Write a label while a state is shown: it stays where it is in every state (it is not part of any part). Make it part of a part with the lasso and *Make part*: the strokes leave the part they were in.
809. **Rename, duplicate, delete.** Tap the name in the editor row (rename the part); the three dots of a state: rename, duplicate, delete. Deleting the shown state shows *As drawn*. *Dissolve the part* turns it back into ordinary ink (the ink stays).
810. **Export.** With *State 1* shown, export the page as PDF, SVG and as Markdown with page images, and look at the page thumbnail in the page panel (and an excerpt of the page, if the notebook has one): all show *State 1*. With *As drawn* shown they show the drawing.
811. **Copy a page.** Duplicate the page and open the copy: the strip, the parts and the states are there. Move the page to another notebook (page menu *Move to notebook*) and delete a page and restore it from *Deleted pages*: states come back.
812. **Read-only.** Switch the notebook to read-only mode: the strip still switches and plays states, the plus button, the options menu, the part editor and *Make part* are disabled, and nothing is saved.
813. **Phone and tablet, dark and light.** The strip fits a phone (rows wrap, no sideways scroll, every control is at least 40 px) and a tablet; check both themes and *Follow Obsidian theme*.
814. **Old versions.** Copy a notebook with states to a device with 0.14: it opens read-only with the "newer version" message and is not rewritten. A notebook made by 0.14 opens normally here and is saved as v13 after an edit.
815. **Sync conflict.** Make states on device 1 and edit the same notebook on device 2 so a conflicted copy is made; merge the conflicted copy: the page keeps the states of the notebook it is merged into (or takes the copy's when it had none).
816. **Large notebook.** Open a notebook of some thousand strokes with a page with states: it opens in stages like any large notebook and the states appear with their page.
817. **Erasing a part.** Make a part of a long line (the spring) and add a state that turns it. With the segment eraser cut the line in the middle, in *As drawn* and in the state: both pieces move and turn with the part (nothing stays behind). Undo: the whole line is back in the part, in one step; redo cuts it again. Repeat with the eraser in *Area* mode, and with a second cut across one of the pieces; close and reopen the notebook: the pieces are still in the part.
818. **Margins.** On a PDF page that has a part turned or scaled in a state, widen the left margin (page sheet): the figure and the page move together and the part still turns about its own centre, not about a point beside it. Undo and redo.
819. **Default state.** Tap a state chip and close and reopen the notebook: it opens with the saved default (a dot marks its chip). Open the strip's options (three dots) and choose *Set as default state*: the dot moves and the notebook is saved once; undo takes it back. Do the same on a second device that only looks at the notebook: it writes nothing. Check *As drawn* can be made the default too.

### 0.14 — slides (steps 720-739)

Notes ↔ slide link (#226) and slide strip (#417). Reference screenshots after `npm run harness:check`: `dev/harness/dist/shots/slides-*.png`. You need a lecture PDF in the vault and a notebook for notes.

720. **Link while writing.** Open the notes notebook, *Open PDF side by side*, pick the PDF, go to slide 3. Write a line with the S Pen: a small badge with "3" appears to the right of the line. Turn to slide 5 and write lower on the page: a second badge "5".
721. **One badge per block.** Write three lines close together beside the same slide: one badge for the block, not one per line.
722. **Tap shows the slide.** Turn the pane to slide 1, then tap badge "3" with the pen, then with a finger: the pane shows slide 3 and the badge is highlighted; nothing is drawn by the tap. Writing that starts right next to a badge is kept as ink.
723. **Pane closed.** Close the pane, tap badge "5": the pane opens on the same PDF at slide 5.
724. **Undo.** Write a line beside slide 7, then Undo: line and badge go; Redo: both come back. Undo every stroke written beside slide 7 and save: the file no longer mentions slide 7.
725. **Show slide.** Lasso-select the lines of slide 3; in the side-pane bar tap *Show slide*: slide 3. With nothing selected on an unlinked page, it shows the slide most of the page's ink was written beside.
726. **Copies.** Duplicate the page, and copy-paste a linked line within the notebook: the copies keep their badge. Paste it into another notebook: the ink arrives without a badge.
727. **Settings.** Settings → *PDF & reading*: turn off *Slide badges*: the badges disappear at once (the links stay). Turn off *Link notes to slides*: new ink beside a slide gets no badge.
728. **Notebook as reference.** Open another notebook with PDF pages side by side instead of a PDF and write: the badge works the same, and opens that notebook again from a closed pane.
729. **Invisible ink.** Write invisible ink beside a slide: no badge until the solutions are shown.
730. **Old versions.** Copy a notebook with linked ink to a device with 0.13: it opens read-only with the "newer version" message and is not rewritten. A notebook made by 0.13 opens normally here and is saved as v12 only after an edit.
731. **Sync.** Write linked ink on device 1, sync, open on device 2: the badges are there and open the slide (when the PDF is in the vault there too).
732. **Strip from the pane.** With the pane open, tap the strip button in its header (*Slide strip*): one row per slide with notes; the slide in the pane is highlighted.
733. **What a row shows.** For a lecture notebook made from a PDF with an exercise page after slide 2 and notes in the margin of slide 1: slide 1 shows *Slide · p. 1* and *Margin note*, slide 2 shows *Exercise · p. 3*. A notes page linked with *Link* shows *Notes · p. N*; ink written beside a slide shows *Written beside it · p. N* with the number of strokes.
734. **Questions.** Put a question marker with a label next to linked ink, and one on the exercise page: each appears under its slide; a resolved one shows with a check, after the open ones.
735. **Go there.** Tap each chip: the dialog closes and the notebook shows that page. Tap a slide tile: the pane shows that slide (or the notebook its page).
736. **Filter.** In a PDF notebook where some slides have nothing: *With notes* (default) hides them, *All slides* shows them dimmed with "Nothing written for this slide yet".
737. **Empty.** In a notebook without PDFs, run *Open the slide strip* from the palette: an empty state explains it and *Open PDF side by side* starts side by side.
738. **Phone and tablet, dark and light.** The dialog fits a phone (rows wrap, no sideways scroll) and a tablet; check both themes and *Follow Obsidian theme*; every chip is at least 40 px tall.
739. **No change to the file.** Open the strip and close it: the notebook is not rewritten.

### 0.15 — pensets: pen sets per subject (steps 880-899)

Roadmap 134. Named lists of pens (tool, colour, width; highlighters included) saved in the plugin settings, with three starter sets (Maths, Languages, Science) the user can edit. A set is assigned to a folder or to one notebook; opening a notebook puts its set on the pen strip (notebook, then the nearest folder, then your favourite pens). Where things are kept: the sets and the assignments live in the plugin settings (`penSets`, `penSetFolders`: folder path to set id, `penSetNotebooks`: document id to set id, bounded to 200 entries each); nothing is written to the notebook or to `_meta/`, so the document format is unchanged. Reference screenshots after `npm run harness:check`: `dev/harness/dist/shots/pensets-*.png`.

880. **Starter sets.** Settings → *Writing* → *Pen sets* → Open: Maths, Languages and Science are listed with their pen dots (in Italian: Matematica, Lingue, Scienze).
881. **Switcher.** In a notebook tap the pen, then tap it again to open its options: a *Pen set* chip is the first row ("My favourite pens"). It is not there for the eraser, lasso or text. Tap it: the menu lists your favourites, the sets, *Save current pens as a set...*, *Manage pen sets...*.
882. **Pick a set.** Choose Languages: the six pens of the strip change (second pen red). Open another notebook: it does not keep the choice unless it has an assignment. Your own favourite pens (choose *My favourite pens*) are exactly as before.
883. **Use for this notebook.** With a set chosen, the menu offers *Always use "Languages" for this notebook*. Pick it, close and reopen the notebook: it opens with Languages on the strip and its first pen selected (when a pen or highlighter was in use).
884. **Use for this folder.** Same menu, *Use ... for notebooks in <folder>*. Open another notebook in that folder (or a subfolder): same set. A notebook with its own set keeps its own.
885. **Order.** Notebook set beats folder set beats favourites. Remove the notebook's set (the menu item is a toggle, it also shows a check mark): the notebook falls back to its folder.
886. **Save as a set.** Long press a slot to change a pen, then *Save current pens as a set...*, name it "Chemistry": it appears in the menu and is chosen at once. A name that is empty does nothing.
887. **Editing while a set is on.** With a set chosen, long press a slot and save a pen: the pen goes into that set (the next time the set is chosen it has it); your favourites are not changed.
888. **Manager.** *Manage pen sets...* (or Settings): rename, replace the pens of a set with the current strip, delete (asks first). Deleting a set that is assigned makes those notebooks and folders use the next level.
889. **Folders.** In the manager: *Give a folder a pen set...* picks a folder and a set; the assignment is listed with a remove button. *Clear* removes every notebook assignment after a confirmation.
890. **Restore.** Delete Science, then *Restore starter sets*: it comes back; edited starter sets are not overwritten.
891. **Sync and reload.** Restart Obsidian: sets and assignments are still there. A hand-damaged `data.json` (a set with a bad colour, an assignment to a missing set) does not break opening a notebook.
892. **Read-only and lecture.** In read-only mode the chip is disabled and the strip is unchanged.
893. **Phone and tablet, dark and light.** The chip and the manager fit a phone (no sideways scroll), every row and button is at least 40 px, check both themes and *Follow Obsidian theme*.
894. **Italian.** Switch the interface to Italian: all texts of the chip, the menu and the manager are translated.
895. **No change to the file.** Opening a notebook with a set and changing sets does not rewrite the notebook (the save indicator stays saved).

### 0.12.5: pen gestures and rests (steps 660-665)

Update to 0.12.5 and fully close and reopen Obsidian. Samsung tablet, S Pen, Obsidian for Android. Settings → *Pen gestures* → *Long press starts a gesture* on, *Pen side button* = *Radial menu on click, erase while held* (the default) unless a step says otherwise.

660. **Rest, then draw a gesture.** Rest the nib on the page for about a second, then draw a circle around some ink without lifting. Expected: a short vibration after about 0.65 s, the dot disappears, the circle is a gesture (its label appears beside the nib) and nothing is written or erased. Repeat five times, also with a star and a question mark. Report any time the sign is written as ink or erases.
661. **Rest, then draw, right after another stroke.** Write a word, lift, and within half a second rest the nib and draw a circle. Expected: as step 660 (a stray `contextmenu` from the earlier contact must not turn the gesture into the eraser).
662. **Hold-still radial menu.** Turn *Long press starts a gesture* off, *Hold the pen still for the radial menu* on. Rest the nib for 0.7 s. Expected: the radial menu opens, no dot is left. Then write normally with pauses in the middle of a word: no menu.
663. **Button tap and drag are unchanged.** Hold the side button: a quick tap opens the radial menu after the lift (no dot), a drag erases from where the nib landed. Without the button a tap leaves a dot and a drag writes. A button press in the middle of a stroke keeps writing ink.
664. **Side button with the gesture action.** *Pen side button* = *Pen gestures while held*: hold the button, touch and draw a circle. Expected: a gesture, as before.
665. **Pen button test log.** Settings → *Pen button test*. With the button held, drag across the test area; then do a tap. Press *Copy log* and paste the whole text in your report. Expected: the first line gives the settings; every event line shows `dDown` / `dUp`; the lift line says `still (a tap)` or `moved (a drag)`; *Signal seen* / *Decision* lines are in the log next to the event that changed them. If a menu opens on a drag, the log must show either `menu (tap)` or `menu (hover click ...)`: that tells which path opened it.

Results table for steps 1 to 665. Fill it in as you go.

| Step | Device / Obsidian version | Result | Notes |
|---|---|---|---|
| 1 Create and write | | | |
| 2 Latency | | | |
| 3 Pressure | | | |
| 4 Resting hand | | | |
| 5 Pinch/zoom | | | |
| 6 Eraser/undo | | | |
| 7 Force close | | | |
| 8 Reopen | | | |
| 9 Rotation | | | |
| 10 Many strokes | | | |
| 11 Corrupt file | | | |
| 12 Sync | | | |
| 13 Multiple pages | | | |
| 14 Highlighter | | | |
| 15 Segment eraser | | | |
| 16 Lasso | | | |
| 17 Stabilization | | | |
| 18 Palm contact size | | | |
| 19 Fling | | | |
| 20 Performance overlay | | | |
| 21 In-app benchmark | | | |
| 22 Notebook from 0.1 | | | |
| 23 Paper and size at creation | | | |
| 24 Page menu and undo | | | |
| 25 Export PDF/SVG | | | |
| 26 0.2 opens a 0.3 file | | | |
| 27 Writing engine | ✅ | user: "works very well" (Samsung tablet, 0.4.1, low-latency off) | benchmark numbers not reported yet |
| 28 Library | | | |
| 29 Library search | | | |
| 30 PDF import and insertion | | | |
| 31 Shapes, text, images, ruler, infinite page | | | |
| 32 Page navigator | | | |
| 33 Scanner | | | |
| 34 Journal recovery | | | |
| 35 Version history | | | |
| 36 Embeds and links | | | |
| 37 Page links, native embeds, explorer menu (Obsidian integration) | | | |
| 38 Insert and remove space | | | |
| 39 Automatic next page | | | |
| 40 Selective eraser | | | |
| 41 Erase area | | | |
| 42 Instant board shot | | | |
| 43 New lecture | | | |
| 44 Loose sheet and Move to notebook | | | |
| 45 Edge rejection | | | |
| 46 Radial menu | | | |
| 47 Instant start | | | |
| 48 Words and lines (lasso double / triple tap) | | | |
| 49 Selection: restyle, copy, paste, white to transparent | | | |
| 50 Companion notes | | | |
| 51 PDF margins | | | |
| 52 Re-published slides | | | |
| 53 PDF annotations to Markdown | | | |
| 54 Repair a damaged notebook | | | |
| 55 Merge a conflicted copy | | | |
| 56 Restore one page | | | |
| 57 Favourite pens | | | |
| 58 Eraser size | | | |
| 59 Pen only | | | |
| 60 Commands and hotkeys | | | |
| 61 Compact toolbar | | | |
| 62 Pen button test (0.5.1) | | | |
| 63 Radial menu without the side button, Samsung button (0.5.2) | | | |
| 64 Outline and coloured bookmarks | | | |
| 65 Page tags | | | |
| 66 Last position across devices | | | |
| 67 New papers | | | |
| 68 Finger taps | | | |
| 69 Scribble to erase | | | |
| 70 Auto-scroll | | | |
| 71 Side button: lasso | | | |
| 72 Side button: previous tool | | | |
| 73 Defaults | | | |
| 74 Search the PDF text | | | |
| 75 Search on a big PDF | | | |
| 76 Snapping highlighter | | | |
| 77 Hide annotations | | | |
| 78 Dim background | | | |
| 79 One page at a time | | | |
| 80 Reopen where you left off | | | |
| 81 Large notebook (progressive loading) | | | |
| 82 Library trash: move to trash | | | |
| 83 Library trash: restore (original place, free name) | | | |
| 84 Delete permanently and empty trash | | | |
| 85 Trash auto-empty | | | |
| 86 Trash is invisible to library, search, companion notes, conflicts | | | |
| 87 Trash through sync | | | |
| 88 Deleted pages: list and restore | | | |
| 89 Save page as template | | | |
| 90 New page from template | | | |
| 91 New notebook from template | | | |
| 92 Slide + notes right | | | |
| 93 Notes below, header text | | | |
| 94 On the slide | | | |
| 95 Notes page after every slide | | | |
| 96 Insert PDF with layout | | | |
| 97 Cancel | | | |
| 98 Large deck | | | |
| 99 Exercise page here | | | |
| 100 Timetable editor | | | |
| 101 Open the current class | | | |
| 102 Open without asking | | | |
| 103 New lecture prefill | | | |
| 104 Library "Now" shortcut | | | |
| 105 Hand-edited timetable file | | | |
| 106 Open side by side (tablet sideways) | | | |
| 107 Phone and tablet upright | | | |
| 108 Add a notes page for a slide | | | |
| 109 Follow both ways | | | |
| 110 Link and unlink | | | |
| 111 Links survive restarts and renames | | | |
| 112 Notebook with PDF backgrounds as the PDF side | | | |
| 113 Damaged links file | | | |
| 114 Ink follows an image | | | |
| 115 Ink follows a text box | | | |
| 116 Setting off | | | |
| 117 Delete an object with ink | | | |
| 118 Undo before taking the offer | | | |
| 119 Built-in stamps | | | |
| 120 Save a stamp | | | |
| 121 Stamp with image and text | | | |
| 122 Rename and delete a stamp | | | |
| 123 Palette on a phone and with a finger | | | |
| 124 Cards | | | |
| 125 Slip-box | | | |
| 126 Drawn links | | | |
| 127 Title and transcription | | | |
| 128 Regions and container | | | |
| 129 Shared tags | | | |
| 130 Tags and the companion note you edit | | | |
| 131 Tag editor hint | | | |
| 132 API: create, pages, info | | | |
| 133 API: images and PDF | | | |
| 134 API: errors and safety | | | |
| 135 Safe mode after a crash | | | |
| 136 Open normally | | | |
| 137 Two failures | | | |
| 138 Not a failure | | | |
| 139 Storage full | | | |
| 140 Storage full while closing | | | |
| 141 Rolled back by sync | | | |
| 142 No false alarm | | | |
| 143 Check notebooks integrity | | | |
| 144 Toolbar on the tablet | | | |
| 145 Quick actions learn | | | |
| 146 All actions sheet | | | |
| 147 Page sheet | | | |
| 148 Selection bar | | | |
| 149 PDF page and side by side | | | |
| 150 Class now | | | |
| 151 Radial dial | | | |
| 152 Dial colours and width | | | |
| 153 Pen case and favourites | | | |
| 154 Themes and accessibility | | | |
| 155 Go to and banners | | | |
| 156 Zoomed out looks the same | | | |
| 157 Scrolling and zooming out | | | |
| 158 Thumbnails | | | |
| 159 Warning appears | | | |
| 160 Split page | | | |
| 161 Dismiss | | | |
| 162 Page switcher: search | | | |
| 163 Page switcher: thumbnails | | | |
| 164 Recent pages: log | | | |
| 165 Recent pages: library | | | |
| 166 Go to page number | | | |
| 167 Page indicator tap | | | |
| 168 Recent pages after reordering | | | |
| 169 Not synced | | | |
| 170 Open on another device | | | |
| 171 Read-only | | | |
| 172 Heartbeat, close, leftovers | | | |
| 173 Device name | | | |
| 174 Asset waiting for sync | | | |
| 175 Not downloaded yet | | | |
| 176 Sync check | | | |
| 177 Folder excluded | | | |
| 178 Place markers | | | |
| 179 Tap a badge | | | |
| 180 Gap with the slide | | | |
| 181 Homework | | | |
| 182 Structured boxes | | | |
| 183 End of lecture panel | | | |
| 184 Invisible ink | | | |
| 185 Sync and conflicts | | | |
| 186 Older plugin | | | |
| 187 Phone | | | |
| 188 Nothing starts by itself | | | |
| 189 Gesture mode | | | |
| 190 Preview and cancel | | | |
| 191 Delete and undo | | | |
| 192 Insert space | | | |
| 193 Tags, bookmark, search | | | |
| 194 Move a selection | | | |
| 195 Side button | | | |
| 196 Long press | | | |
| 197 Custom gesture | | | |
| 198 Cheat sheet and switches | | | |
| 199 Defaults and writing | | | |
| 200 Select pages | | | |
| 201 Move and duplicate | | | |
| 202 Paper, size, tags, bookmarks, export, delete | | | |
| 203 Copy link, insert link, embed | | | |
| 204 Other generated links | | | |
| 205 Update links | | | |
| 206 Do not disturb | | | |
| 207 Inbox of loose notes | | | |
| 208 Process | | | |
| 209 New writing | | | |
| 210 PDF highlights | | | |
| 211 Two devices | | | |
| 212 Set up | | | |
| 213 Slides open | | | |
| 214 Insert and writing | | | |
| 215 Redo, hide everything | | | |
| 216 Hide by colour and by tool | | | |
| 217 Hide the selection | | | |
| 218 The strip and the tags | | | |
| 219 Peek at the solution | | | |
| 220 Original and attempts | | | |
| 221 Exercises notebook | | | |
| 222 Timer | | | |
| 223 Links survive renames, moves and sync | | | |
| 224 Damaged links file and read-only | | | |
| 225 Link in a text box | | | |
| 226 Open a link | | | |
| 227 Unresolved link | | | |
| 228 Ink link from the lasso | | | |
| 229 Ink link moves with its ink | | | |
| 230 Handwritten brackets | | | |
| 231 Companion note | | | |
| 232 No interference | | | |
| 233 Insert an equation | | | |
| 234 Palette and styles | | | |
| 235 TeX error | | | |
| 236 Aligned derivation | | | |
| 237 Move and scale | | | |
| 238 Exports | | | |
| 239 Convert to ink | | | |
| 240 Insert a graph | | | |
| 241 Every kind | | | |
| 242 Parameters | | | |
| 243 Pan, zoom and ink | | | |
| 244 View and table | | | |
| 245 Leave without Done | | | |
| 246 Older plugin and sync | | | |
| 247 Phone | | | |
| 248 With the other wave 0.9 features | | | |
| 249 Mobile toolbar | | | |
| 250 Bookmark a page | | | |
| 251 Open a bookmark | | | |
| 252 Keyboard | | | |
| 253 Clicker and no-go cases | | | |
| 254 Large toolbar on the phone | | | |
| 255 Large on the tablet, compact | | | |
| 256 Persistence | | | |
| 257 Bring to front, send to back | | | |
| 258 Forward and backward | | | |
| 259 After saving | | | |
| 260 Find | | | |
| 261 Replace | | | |
| 262 Phone | | | |
| 263 Page information | | | |
| 264 A page in the middle | | | |
| 265 Export dialog | | | |
| 266 PDF choices | | | |
| 267 Whole notebook as SVG, invisible ink | | | |
| 268 Markdown export | | | |
| 269 Never overwrite | | | |
| 270 Resolutions and a long page | | | |
| 271 Night mode | | | |
| 272 Crop margins | | | |
| 273 Ink in the margin, mixed notebooks, page by page | | | |
| 274 Nothing changes in the file; large PDFs | | | |
| 275 Tab strip | | | |
| 276 Swipe on the toolbar | | | |
| 277 Commands | | | |
| 278 Line break off by default | | | |
| 279 Line break on | | | |
| 280 Limits | | | |
| 281 Stamp at the pen | | | |
| 282 Stamp without a pen position | | | |
| 283 Format | | | |
| 284 Lasso over two pages | | | |
| 285 Move across | | | |
| 286 Scale and delete | | | |
| 287 Colour, copy, duplicate | | | |
| 288 Single page is unchanged | | | |
| 289 Copy to other devices | | | |
| 290 Paste on the phone | | | |
| 291 The phone's own clipboard is untouched | | | |
| 292 Picture not synced yet | | | |
| 293 Damaged or empty file | | | |
| 294 Size limit and age | | | |
| 295 Rectangle mode | | | |
| 296 Rectangle drag | | | |
| 297 Move, scale, rotate after a rectangle | | | |
| 298 Select similar, same colour | | | |
| 299 Select similar, same tool | | | |
| 300 The picker | | | |
| 301 Align | | | |
| 302 Distribute | | | |
| 303 Pictures, text boxes and ink on a picture | | | |
| 304 Nothing to do | | | |
| 305 Rotate | | | |
| 306 Mirror | | | |
| 307 Exact size | | | |
| 308 After saving (selection tools) | | | |
| 309 Phone (selection tools) | | | |
| 310 Sheet and commands | | | |
| 311 Italian | | | |
| 312 Pen and palm | | | |
| 313 Many strokes | | | |
| 314 Read-only and other pages | | | |
| 315 Back and Forward appear | | | |
| 316 Back and Forward work | | | |
| 317 What counts as a jump | | | |
| 318 Across notebooks | | | |
| 319 Deleted page, capped, session only | | | |
| 320 Mouse buttons (desktop) | | | |
| 321 Scrollbar appears | | | |
| 322 Drag through the notebook | | | |
| 323 Preview of a PDF page and of ink | | | |
| 324 Long notebooks | | | |
| 325 Zoom | | | |
| 326 One page at a time | | | |
| 327 Back after a drag | | | |
| 328 Status bar (desktop) | | | |
| 329 Status bar: open the navigator | | | |
| 330 Status bar hides | | | |
| 331 Mobile | | | |
| 332 Language | | | |
| 333 Settings | | | |
| 334 Nothing in the file | | | |
| 335 Pin and unpin | | | |
| 336 Archive and restore | | | |
| 337 The archive never touches files | | | |
| 338 Manual order by dragging | | | |
| 339 Manual order on touch | | | |
| 340 Two devices | | | |
| 341 A damaged own file is never overwritten | | | |
| 342 Nothing else changed | | | |
| 343 Check the library | | | |
| 344 Unreadable notebooks are only listed | | | |
| 345 Not downloaded is never damage | | | |
| 346 Unused files and the space they take | | | |
| 347 Review and move to the trash | | | |
| 348 Recent and kept files are not offered | | | |
| 349 Safety when things change meanwhile | | | |
| 350 Read-only mode on | | | |
| 351 The pen changes nothing | | | |
| 352 The finger reads | | | |
| 353 No way to edit | | | |
| 354 Nothing is written | | | |
| 355 Switch it off | | | |
| 356 It ends with the notebook; per view | | | |
| 357 PNG images | | | |
| 358 Pages and layers | | | |
| 359 Ranges for PDF and SVG | | | |
| 360 Print (desktop) | | | |
| 361 Print choices | | | |
| 362 No print on a phone or tablet | | | |
| 363 Big notebooks | | | |
| 364 Exports in read-only mode | | | |
| 365 Open the picker | | | |
| 366 Choose by area and hue | | | |
| 367 Hex field | | | |
| 368 Recent colours | | | |
| 369 Which colour it changes | | | |
| 370 From the dial | | | |
| 371 Eyedropper on the page | | | |
| 372 Eyedropper limits | | | |
| 373 Style eyedropper: pen | | | |
| 374 Style eyedropper: highlighter and shape | | | |
| 375 Style eyedropper misses and overlaps | | | |
| 376 Hidden ink and read-only | | | |
| 377 Commands and hotkeys | | | |
| 378 Phone | | | |
| 379 Nothing else changes | | | |
| 380 Language setting | | | |
| 381 Auto follows Obsidian | | | |
| 382 Apply and reopen | | | |
| 383 Commands after restart | | | |
| 384 Excerpt a lassoed selection | | | |
| 385 Excerpt a bare PDF region | | | |
| 386 Too small, cancel | | | |
| 387 New page, undo | | | |
| 388 Move, resize, never stretch | | | |
| 389 Copy, duplicate, delete | | | |
| 390 Copy as excerpt to another notebook | | | |
| 391 Live in the same notebook | | | |
| 392 Snapshot in another notebook | | | |
| 393 Exports and thumbnails | | | |
| 394 Hidden ink stays hidden | | | |
| 395 Jump back in the same notebook | | | |
| 396 Go to source from the bar | | | |
| 397 Jump to another notebook | | | |
| 398 Source page deleted | | | |
| 399 Source notebook moved, renamed, deleted | | | |
| 400 A notebook made by this version in 0.10.x | | | |
| 401 Damaged excerpt | | | |
| 402 Sync both ways | | | |
| 403 Pen gestures and markers around excerpts | | | |
| 404 Pen button test sees everything | | | |
| 405 Radial menu from the button, anywhere over the page | | | |
| 406 Nothing else changes (side button at window level) | | | |
| 407 Settings sections and order | | | |
| 408 Every setting is still there | | | |
| 409 Dependent options | | | |
| 410 Collapsed groups | | | |
| 411 Settings search | | | |
| 412 Style | | | |
| 413 Diagnostics and actions | | | |
| 414 Hover click opens the radial menu | | | |
| 415 Finger long-press and text fields unchanged | | | |
| 416 Button held while touching erases | | | |
| 417 Button click: next stroke erases | | | |
| 418 Pen key: F9 to F12 | | | |
| 419 Pen key: custom key and hotkey warning | | | |
| 420 Key Mapper + Shizuku | | | |
| 421 Pen button test: native bridge line | | | |
| 422 Timing of the button around the contact | | | |
| 423 Button held, then touch: the whole stroke erases | | | |
| 424 Button pressed while writing: the rest erases | | | |
| 425 Same picture every time (subject art) | | | |
| 426 Left side stays clean | | | |
| 427 Fine lines, sharp | | | |
| 428 Switch off (reduced motion) | | | |
| 429 Fast on the tablet | | | |
| 430 Open Home | | | |
| 431 Subject cards | | | |
| 432 Recent notes | | | |
| 433 Statistics | | | |
| 434 Quick actions | | | |
| 435 Search from Home | | | |
| 436 Library header and chips | | | |
| 437 Smart collections | | | |
| 438 Frequent tags | | | |
| 439 Recent and favourite notebooks | | | |
| 440 All notebooks, grid and list | | | |
| 441 Existing library features | | | |
| 442 Rail | | | |
| 443 New and filter buttons | | | |
| 444 Inbox bell | | | |
| 445 Light and dark | | | |
| 446 Reduced motion | | | |
| 447 Pen, finger and mouse | | | |
| 448 Rotation | | | |
| 449 Nothing else changes (Home and library) | | | |
| 450 Open it | | | |
| 451 Shape | | | |
| 452 Name errors | | | |
| 453 Enter submits | | | |
| 454 Paper tiles | | | |
| 455 Sizes | | | |
| 456 Orientation | | | |
| 457 Saved template | | | |
| 458 Cover | | | |
| 459 Cover saved | | | |
| 460 Description saved | | | |
| 461 Old notebooks | | | |
| 462 Folder tab | | | |
| 463 Colours | | | |
| 464 Create a folder | | | |
| 465 Keyboard only | | | |
| 466 Folder look is stored | | | |
| 467 Rename follows | | | |
| 468 Two devices | | | |
| 469 Unreadable file is kept | | | |
| 470 No start-up notice | | | |
| 471 Settings tab is back | | | |
| 472 A setting saves | | | |
| 473 Home is styled | | | |
| 474 No grey buttons | | | |
| 475 Library and rail | | | |
| 476 Light theme and phone width | | | |
| 477 Creation dialog | | | |
| 478 Settings tab opens | | | |
| 479 Empty Home teaches the first step | | | |
| 480 + Nuovo in the header | | | |
| 481 Every way in opens the dialog | | | |
| 482 Rail + | | | |
| 483 Empty library | | | |
| 484 First notebook | | | |
| 485 Device info | | | |
| 486 Settings look native | | | |
| 487 Home is complete | | | |
| 488 No + in the rail | | | |
| 489 + Nuovo | | | |
| 490 Creation dialog, both tabs | | | |
| 491 Tag page | | | |
| 492 First notebook and folder | | | |
| 493 Tap with the button | | | |
| 494 Drag with the button | | | |
| 495 Without the button | | | |
| 496 Button in the middle of a stroke | | | |
| 497 Other settings | | | |
| 498 Pen button test | | | |
| 499 The button in the air | | | |
| 660 Rest, then draw a gesture | | | |
| 661 Rest, then draw, right after another stroke | | | |
| 662 Hold-still radial menu | | | |
| 663 Button tap and drag are unchanged | | | |
| 664 Side button with the gesture action | | | |
| 665 Pen button test log | | | |

Benchmark output (step 21): paste it here.

```
(paste results)
```

### 0.15 — daily (Today's page)

930. **Command and Home.** Run *Today's page* from the command palette, and tap *Pagina di oggi* / *Today's page* in Home's quick actions: both do the same.
931. **First use.** With no daily notebook, a dialog asks to create `Daily.notebook` (or the path set in *Settings > Obsidian integration > Daily notebook*). Cancel: nothing is created. Create: the notebook opens on one page headed with today's date.
932. **Second run, same day.** Run it again (also from the other entry point): the same page is shown, no second page appears. Check the page count.
933. **Next day / no page yet.** Change the date (or open it the next day): a new page of the same size and paper as the last one is added at the end, headed with that day's date, and shown. Undo removes it.
934. **Header lookup.** Reorder the pages, or move today's page to the middle: *Today's page* still finds it (it looks for the dated header, not the last page). A page that only mentions today's date in its text is not taken for it.
935. **Link off by default.** With *Link from the daily note* off, the daily note is never touched.
936. **Link on.** Turn on *Daily notes* (core plugin) with its folder and date format, create today's daily note with some text, turn on *Link from the daily note* and run *Today's page*: a link line ("Handwritten page <date>") is added at the end of the note. Tapping it opens that page. The rest of the note is unchanged.
937. **Idempotent.** Run it again: the note is not written again (no second line, modification time unchanged). Delete the line and run it: it comes back once.
938. **No daily note yet.** Delete today's daily note and run it with *Create the daily note if missing* off: the page opens, a notice says the note does not exist, nothing is created. Turn the option on: the note is created in the Daily notes folder with only the link.
939. **Periodic Notes.** With Periodic Notes' daily notes on (a different folder or format), the link goes into that plugin's note, not the core plugin's.
940. **Neither plugin.** Turn both off with linking on: the page opens and a notice says which plugin to turn on; no file is created.
941. **Sync.** With the daily note open in the editor, run it: the link appears in the open note without losing text typed a moment earlier.
942. **Phone and tablet.** The quick action, the confirmation dialog and the three settings rows fit at phone and tablet widths, light and dark, with the rows' targets at least 40 px.

### 0.16 — lock (locked pages, format v14; steps 950-969)

Implemented, not verified on hardware. Reference screenshots after `npm run harness:check`: `dev/harness/dist/shots/lock-*.png`. A page is locked from the page sheet (tap the page number), the multi-selection menu of the pages panel, the notebook map or the command *Lock or unlock the page in view*. Notebooks saved with a locked page are format v14: 0.15 and older open them read-only.

950. **Lock from the page sheet.** Tap the page number, choose *Lock page*. Expected: a lock appears beside the page number and a *Locked* badge at the top right of the page; the sheet now offers *Unlock page* instead; nothing on the page moves.
951. **The pen is refused.** With the pen (S Pen), write on the locked page. Expected: no ink at all (not even a flash of wet ink), and one notice *Page locked · Unlock*; writing again within 5 s shows no second notice. The notice's *Unlock* button unlocks the page and the next stroke is written.
952. **Every writing tool.** On a locked page try the highlighter, the eraser (stroke and area), shapes, the text tool (tap on empty paper and on an existing text box), *Insert space* and a pen gesture. Expected: nothing changes; no text editor opens; the notice appears.
953. **Selection.** With the lasso select some ink and a text box. Expected: the selection is made and *Copy* works (paste it on another page); dragging, scaling or turning the selection, *Delete*, restyle (colour, width), align and layer order do nothing and show the notice.
954. **Paste, insert, scan.** On a locked page paste, insert an image or a photo, place a marker or a box, an equation or a graph. Expected: nothing is added to the locked page (the notice appears); the same actions work on the next page.
955. **Page settings.** On a locked page the paper, size, orientation, *Infinite page*, PDF margins, *Update PDF*, *Split* and *Delete page* rows of the page sheet are disabled. In the pages panel, select the page with others and choose *Paper*, *Size* or *Delete*: refused with a notice (delete says to unlock first); the other pages are not changed either. *Move to notebook…* refuses the locked page and nothing is copied.
956. **Undo.** Write on page 1, lock it, then undo. Expected: the first undo unlocks (one step); the second removes the stroke; redo locks again. Lock a page, then (on another page) write and undo: the other page's writing is undone, the locked page is untouched.
957. **Marks.** With the page panel open the locked page has a lock in its footer (tap: it unlocks). In the notebook map (the grid button of the pages panel) a locked page has a lock badge and every card has a lock button (*Lock page 3* / *Unlock page 3*) that works without leaving the map. The badge over the page is a button: tap = unlock.
958. **Command and hotkey.** Run *Lock or unlock the page in view* from the command palette (and bind a hotkey): it toggles the page in view. Undo takes it back.
959. **Several pages.** In the pages panel select three pages, choose *Lock page* from the menu: all three lock in one step (one undo). Select the same three: the menu now says *Unlock page*.
960. **Reading still works.** On a locked page scroll, zoom, turn pages, search (the text boxes are found), export the page as PNG / PDF / SVG, print, open the page info, copy a selection out, jump from a link. A locked PDF or slide page can be navigated, the slide pane followed and the highlighter-free reading tools used; tags and bookmarks can still be changed.
961. **Drawings with states.** Lock a page with a figure that has states. Switching and playing the states works; moving a part in a state, making or dissolving parts and *Set as default state* are refused with the notice.
962. **Find and replace.** Replace all where some matches are on a locked page: the others are replaced, the notice says how many text boxes on locked pages were left as they are; *Replace* on one such result says that page is locked.
963. **Deleting.** *Delete page* on a locked page is disabled; the keyboard or the command route says to unlock first; no copy appears in *Deleted pages*. After unlocking it deletes normally.
964. **Version restore.** *Restore a version of this page* with *Replace* on a locked page: refused (unlock first); *Insert* next to it works.
965. **Conflicted copy.** Make a conflicted copy of a notebook in which a page was locked on one device and not on the other, and merge: the page is locked in the result, nothing the copy had is lost (also ink added to a page that is locked on this device).
966. **Older plugin.** Copy a notebook that has a locked page to a device with 0.15: it opens read-only with the "newer version" message and is not rewritten.
967. **Saving.** Lock a page, close and reopen the notebook (and let it sync to another device): the page is still locked, the file has `"locked": true` on that page only.
968. **Phone and tablet.** At phone width the badge shows only the lock (no text), does not cover the toolbar or the page number and is at least 32 px tall; the notebook map lock buttons are at least 28 px, in dark and light, in Italian too.
969. **Read-only mode.** In *Read-only mode* the badge is shown disabled and the lock rows and buttons do nothing but say the notebook cannot be edited.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Locked pages (#124, format v14): `Page.locked`; v13 → v14 migration (a stray key is dropped, large v13 files still stage), lenient read and strict write, repair, merge (locked on either side stays locked, the copy's ink still reaches a locked page), copy / template / clash restore start unlocked | yes | `tests/model-v14.test.ts` | | | |
| One guard in the history: every command (and undo / redo) that changes the content of a locked page is reverted and not recorded; tags, bookmarks, page order and inserted pages are allowed; lock and unlock are one undo step | yes | `tests/page-lock.test.ts` (each kind of edit) | | | |
| Lock UI: page sheet, multi-selection menu, command, lock beside the page number, badge over the page, pages panel lock, notebook map lock button, *Page locked · Unlock* notice; gestures stopped before they start (pen, eraser, text, shapes, space, selection drag); delete, move to notebook, restore and find and replace check first | yes | harness scenario `lock` (tablet and phone, light and dark), `tests/ui-registry.test.ts`; model parts in `tests/model-v14.test.ts` | | | |

### 0.17 — sticky (sticky notes, format v15; steps 1100-1119)

Implemented, not verified on hardware. Reference screenshots after `npm run harness:check`: `dev/harness/dist/shots/sticky-*.png`. Notebooks saved with a sticky note are format v15: 0.16 and older open them read-only.

1100. **Insert.** More sheet or the quick slot > *Sticky note*. Expected: a yellow square note appears at the centre of the view, selected (the bar shows *Edit note*, *Collapse note* and the usual selection actions). One undo removes it.
1101. **Edit.** With the note selected tap *Edit note*. Type two lines, pick another colour, make the text larger, tap *Done*. Expected: the note shows the text and the new colour in one undo step; *Cancel* leaves it as it was. In Italian the dialog reads *Nota adesiva*.
1102. **Write on it.** With the S Pen write on the note. Expected: the ink is black vector ink over the note; erasing it works like any ink.
1103. **Move.** With the lasso tap the note, then drag it. Expected: the note and the handwriting on it move together; one undo puts both back.
1104. **Resize.** Drag a corner handle of the selected note. Expected: the note, its text and the handwriting scale together; the note never becomes smaller than a thumb nail or larger than the page allows.
1105. **Collapse.** Select the note, tap *Collapse note*. Expected: a small icon with the note's colour remains at its top-left corner; the handwriting disappears with it; nothing is deleted. Write on the empty place where the note was: that ink stays visible. Drag the icon: the hidden ink goes with it. Tap *Open note*: the note and its ink are back.
1106. **Delete.** Delete an open note: the note goes; the notice offers to delete the ink written on it (the setting "Ink follows objects"). Delete a collapsed note: its hidden ink is deleted with it and one undo brings both back.
1107. **Copy and paste.** Copy a note with its ink to another page and to another notebook. Expected: the copy has the text, colour and ink; a collapsed note pastes collapsed.
1108. **Locked page.** Lock the page: *Sticky note* is disabled, *Edit*, *Collapse* and moving a note do nothing and show the *Page locked* notice.
1109. **Export.** Export the page as PNG, PDF and SVG: the note, its text and the handwriting are there; a collapsed note is its icon without the ink. The Markdown export has the typed text as a quote.
1110. **Saving and older plugin.** Close and reopen: notes, text, colour and collapsed state are kept. Copy the notebook to a device with 0.16: it opens read-only with the "newer version" message and is not rewritten.
1111. **Night mode and Obsidian theme.** In night mode and in the dark theme the note keeps a readable paper and text.
1112. **Phone and tablet.** At phone width the dialog fits, its swatches are at least 36 px and the bar shows the note actions; in dark and light.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Sticky notes (#20, format v15): element `sticky`; v14 → v15 migration (a note in a v14 file is refused, large v14 files still stage), lenient read and strict write, repair, merge (hidden-ink ids remapped), copy | yes | `tests/model-v15.test.ts` | | | |
| Ink belongs to the note (geometric ownership), moves and scales with it; collapsed note hides and carries exactly its own list of strokes; eraser and lasso skip hidden ink; delete takes it along | yes | `tests/model-v15.test.ts` | | | |
| Drawing and export: canvas, thumbnails, PNG, PDF, SVG, Markdown | yes | `tests/model-v15.test.ts` | | | |
| Sticky UI: insert (quick slot, sheet, command), edit dialog, collapse / open, selection bar; one undo step each, refused on a locked page | yes | harness scenario `sticky` (tablet and phone, light and dark), `tests/ui-registry.test.ts` | | | |

### 0.18 — lasso2md: selection as a picture in a note (steps 1340-1359)

1340. **Insert at the cursor.** Open a note in a split next to a notebook, put the cursor in the middle of a line, select handwriting with the lasso and choose *Insert into note*. Expected: a picture embed `![[… p3-hhmmss.png|400]]` and `[[Notebook#p3&id=…|↩]]` appear on their own line at the cursor; the picture file sits where Obsidian keeps attachments. Undo in the note removes the text.
1341. **Link back.** Tap the arrow in the note (reading mode): the notebook opens at that page.
1342. **Settings.** Integration > turn off *Link back to the page*, set the width to 250 and the background to *Paper*, insert again. Expected: only the embed, 250 px wide, with the page paper behind the ink; the first setting (transparent) gives ink with no white.
1343. **No note open.** Close all notes and insert. Expected: a note picker; the block is appended at the end of the chosen note after a blank line; cancelling the picker writes nothing.
1344. **SVG.** *Insert into note as SVG* (All actions): an `.svg` of the region is stored and shows in the note.
1345. **Collapsed sticky note.** Select ink next to a collapsed note: the picture does not show the hidden ink.
1346. **Phone and Italian.** The actions read *Inserisci nella nota*; the new settings fit at phone width.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Selection into a Markdown note as PNG or SVG with optional link back; cursor insert through the editor, note picker and append fallback; width, background, link-back settings (#59) | yes | `tests/note-insert.test.ts` | | | |

### 0.19 — checklists (handwritten checklists, format v17; steps 1500-1519)

Implemented, not verified on hardware. Reference screenshots after `npm run harness:check` (`HARNESS_DOC=checklists`): `dev/harness/dist/shots/checklists-*.png` (tablet and phone, light and dark). Notebooks saved with a checkbox are format v17: 0.18 and older open them read-only.

1500. **Insert.** Insert sheet (More) > *Checkbox*. Expected: an unticked rounded square appears at the centre of the view, selected (handles); the selection bar has *Tick / untick*, *Select with text*, *Label…*, *Send to tasks…*. One undo removes it.
1501. **Tick with the S Pen.** With the pen tool, tap the box with the S Pen tip. Expected: a tick appears, no dot of ink is left, one undo unticks it. A stroke that starts on the box and moves is ordinary ink and ticks nothing. Tap again: it unticks. The pen target is the box and about 3 pt around it: dot an "i" or write a colon right next to the box (where the label starts) and the dot stays as ink and the box does not tick.
1502. **Tick with a finger.** With *write with finger* off, tap the box with a finger: it ticks (a tap that moves or lingers pans the page instead). With *write with finger* on, the same tap ticks it too and leaves no dot. While the pen is down or was used a moment ago (the palm rejection time), a finger or palm touching the box ticks nothing.
1503. **A drawn square.** With the pen draw a small square (about 1 cm) in one stroke. Expected: after the pen lifts a *Make checkbox* chip appears below it; tap it: the square becomes a checkbox of the same size and place in the colour of the pen; one undo gives the square back as ink. Writing on, scrolling or waiting about 9 seconds takes the chip away.
1504. **Not a square.** Draw a rectangle, a circle, a very small or very large square, a square with the Shape tool, a highlighter square and a hand-written *O*: none is offered a chip. A square turned about 45° is not offered either.
1505. **The setting.** Settings > Writing > *Squares drawn as checkboxes*. *Make it a checkbox*: a drawn square becomes a checkbox by itself about half a second after the pen lifts (not if you draw a tick across it: the square waits while the tick is drawn and is checked again after it; writing a label beside it does make it one). *Leave it as ink*: nothing is offered. A checkbox from the Insert sheet works in every mode. Ignore the chip three times in a row: it stops appearing until you make a checkbox or reopen the notebook.
1506. **The line.** Draw a box and write a few words on its line to the right, a second line below it with its own box. Select the first box (lasso) and tap *Select with text*: the box and its words are selected, not the line below or a box further right on the same line. Move the selection: they move together.
1507. **Label.** With one checkbox selected tap *Label…*, type a name, *Save*. One undo step. The notebook map tooltip and the Markdown export use it.
1508. **Send to tasks.** Select a checkbox that has handwriting beside it, *Send to tasks…*. Expected: the Make task dialog (title *Send to tasks*, the text may stay empty), the daily note as default target. *Send task*: the note ends with a line `- [ ] … ![[… task p… .png|200]] [[page link]] ^nb-…`; the selection bar now offers *Unlink task* instead of *Send to tasks…*.
1509. **The tick follows.** Tick the linked checkbox on the page: within a second the line in the note shows `- [x]` and no other line or byte of the note changed. Untick: `- [ ]`. Undo and redo of a tick do the same. Ticking goes from the notebook to the note only: ticking the task in the note does not tick the checkbox (the dialog says so). Tick and at once switch to another app or close the notebook: the line is still updated. Make the write fail (read-only note, or the note not yet synced): the link stays and the tick is retried a few times.
1510. **The line is gone.** Delete that line in the note (this edits the note), then tick the checkbox: nothing happens at first; when the app reads the note again a minute or more later (tick again, or wait for the retry) a notice says the line is no longer in the note and the checkbox is no longer linked (*Unlink task* is gone). The note is not touched. Undo right after the tick un-ticks it (the unlink is not an undo step). A note that was not edited since the link was made and lacks the line (an older copy that has not synced yet) keeps the link, as does a note with a code fence that never closes above the line. Delete the note instead, or move it out of the vault: the checkbox stays linked (a missing note is not a deleted line) and the tick is retried; rename or move the note inside the vault, or rename its folder: the link follows (not an undo step) and the next tick reaches it. Close the notebook, rename the note, open the notebook and tick: the link has followed (the rename is remembered on this device for 30 days; a rename done on another device is not known here). Rename the note to a path of more than 500 characters: the old link stays and one notice says so. On a locked page nothing is unlinked and no notice appears. Copy the line twice into the note: a notice says more than one line carries the id and nothing is changed. A copy of the line inside a code block or the frontmatter is ignored; a task inside a callout is ticked.
1511. **Unlink.** *Unlink task* on a linked checkbox: the notice says the task stays in the note; ticking the checkbox no longer touches it.
1512. **Locked page and read-only.** On a locked page a tap on a box shows the *Page locked* notice and changes nothing; *Insert checkbox* is refused. In a read-only notebook a tap changes nothing.
1513. **Copies.** Duplicate a page, copy-paste a ticked, linked checkbox to another page, and *Duplicate* the whole notebook in the Library: the copies keep the tick but are not linked; ticking the copy does not touch the original's task line. *Move* pages with linked boxes to another notebook (or split a notebook): the moved boxes keep their links, and ticking them still reaches the note; *Copy* them instead: the copies are not linked.
1514. **Templates.** Save a notebook or a page with ticked boxes as a template and make a new notebook or page from it: every box is unticked and unlinked.
1515. **Two devices.** On two devices tick and untick the same box at different times, sync so a conflicted copy appears, *Merge conflicted copies*: the checkbox is there once and shows the state of the later toggle; the summary counts it. Unlink the task on one device, merge an older copy that still has the link: it stays unlinked. A tick and an untick at the same moment: the tick wins.
1516. **Open items.** Notebook map > *Open items* (only offered when a page has an unticked box): the pages with open boxes, the number of open boxes on the badge, the label of the first as tooltip; tap goes to the page. Tick the last open box on a page: it leaves the filter.
1517. **Exports.** Export a page with boxes as PDF, PNG and SVG: boxes and ticks are drawn above the ink, in the colour they were drawn in. A page thumbnail shows them. The Markdown export lists labelled boxes as `- [ ] label` / `- [x] label`.
1518. **An older plugin.** Copy a notebook with a checkbox to a device with 0.18: it opens read-only with the "newer version" message and is not rewritten.
1519. **Italian, dark, phone.** The chip, the label dialog, the task dialog, the notices and the setting read in Italian; the chip and the dialogs are readable in light, dark and with *Follow Obsidian theme*; on a phone the tap target is still comfortable and the chip stays inside the view.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Handwritten checklists (#103, format v17): element `checkbox`; v16 to v17 migration (a checkbox in a v16 file is refused, large v16 files still stage), lenient read and strict write (a label cut at the limit is trimmed again; optional `taskAt`), repair, copies (tick kept, link dropped; a Library duplicate unlinks; a move or a trash restore keeps links), templates (unticked), merge (later toggle wins, a tie keeps the tick, the later link decision wins), lock guard, history | yes | `tests/model-v17.test.ts`, `tests/checklist-review-fixes.test.ts` | | | |
| Checklist geometry: the drawn square detector, the label ink on a line, tap targets, exports of the box and tick (canvas, SVG, PDF), Markdown list | yes | `tests/model-v17.test.ts` | | | |
| Task link: *Send to tasks* with a block id, ticks follow into the one line of the note (only that line, line endings kept; code blocks and frontmatter skipped, callouts accepted, a duplicated id refused), pending ticks kept across close, hide and reload and retried, a missing note keeps the link, a renamed note is followed (not an undo step; also while the notebook was closed, through a bounded device-local record of renames; a path too long to store is not followed), unlink only when the line is really gone (the note edited since the link, no unclosed code fence, seen twice a minute apart; the unlink is not an undo step); undo and redo of a move, a move to another page or a margin change after such upkeep keep one checkbox with the upkeep's link, and an undo or redo the writer would refuse is taken back | yes | `setTaskLineChecked` (`tests/model-v17.test.ts`), the bookkeeping `ChecklistSync` (`tests/checklist-review-fixes.test.ts`), the second review `tests/checklist-round2.test.ts` (sync, view with a fake vault, rename record, `History.applyQuietly`), the third review `tests/checklist-round3.test.ts` (upkeep and the undo stacks, the undo/redo backstop, the link time after a rename, one notice per checkbox); harness scenario `checklists` | | | |
| Checklists UI: insert, tap to tick (pen, mouse, finger), *Make checkbox* chip and the setting, label dialog, *Select with text*, *Open items* filter of the map | yes | harness scenario `checklists` (tablet and phone, light and dark) | | | tap and offer with the S Pen on hardware |

### 0.19 — cleanexport

Clean copy (#239). Implemented, not verified on hardware. Reference screenshots after `npm run harness:check` (`HARNESS_DOC=cleanexport`): `dev/harness/dist/shots/` (the export dialog with the switch on, tablet and phone, dark and light).

1620. **The switch.** Open *Export…* on a notebook: *Clean copy* is off. Turn it on: *Also leave out open sticky notes* appears under it. Close and open the dialog again in the same session: the choices are remembered.
1621. **Markers.** On a page with a placeholder (gap), a question, an importance badge and a homework marker, export a PDF with *Clean copy* on: the PDF has none of the badges or outlined regions; the same page exported with it off still shows them.
1622. **Other formats.** Repeat with SVG, PNG images and Print: the markers are missing in each when *Clean copy* is on.
1623. **Comments.** With *Include comments in exports* on in the settings and a page that has margin comments, a clean PDF has no notes strip; a normal PDF still has it.
1624. **Collapsed sticky notes.** Collapse a sticky note that has ink written on it: the clean PDF shows neither the icon nor that ink; strokes written elsewhere are there. Expand the note again in the notebook: the ink is back (the notebook was not changed).
1625. **Open sticky notes.** An open note is in the clean PDF. With *Also leave out open sticky notes* on it is not; the ink written over it stays.
1626. **What stays.** Boxes (definition, theorem…), text, pictures, equations, graphs, excerpts, the page header and the paper are in the clean PDF. Invisible ink follows *Show solutions* as in every export.
1627. **Scope and layers.** Clean copy works with *This page*, *Whole notebook* and *Some pages*, and with *Ink only* / *Background only*.
1628. **Nothing changes in the notebook.** After a clean export the markers, comments and sticky notes are all still in the notebook; undo history is untouched.
1629. **Plain export.** With *Clean copy* off the exported file is the same as in 0.18.
1630. **Italian.** In Italian: *Copia pulita*, *Escludi anche le note adesive aperte*.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Clean copy (#239): export dialog switch that leaves out markers (gaps, questions, importance, homework), margin comments and collapsed sticky notes with their hidden ink, optionally open notes; PDF, SVG, PNG, Print | yes | `tests/clean-export.test.ts` (filter, no mutation, byte-identical plain output); dialog: harness (`doc=cleanexport`) | | | |
| Clean copy: "this lecture" page range by lecture date | no | | | | to do (the pages carry no creation time; use *Some pages* meanwhile) |

## Quick check — Windows

Mouse: draw, erase (both modes), undo/redo with Ctrl+Z / Ctrl+Shift+Z, wheel scroll, Ctrl+wheel zoom, resize the window (the page refits), add a page, use every page menu action with undo, create notebooks with each paper and size, export PDF and SVG and open them, lasso select/move/resize/rotate/delete, close and reopen the notebook. Also: open the library and use every action, import a PDF and write on it, insert a PDF range and an image page, use the shape, text, image and ruler tools, scan from a photo file, use the Pages panel, run *Restore a previous version*, insert an embed in a note and open an `obsidian://notebook` link. With a pen tablet or Surface pen: pressure and eraser end (`buttons & 32`).

### 0.15 — templates (steps 820-839)

820. Open a notebook with a few pages of ink and a text box saying `Week of {{date}}`. More sheet > *Save as notebook template…*, name it *Planner*. A notice confirms. The notebook itself is unchanged.
821. In the library, the card menu of another notebook shows *Save as notebook template…*; use it. Neither template appears in the library grid, search or statistics.
822. Files: `<notebooks folder>/_templates/notebooks/Planner.notebook` exists. *Save page as template* templates are not listed among the notebook templates and the reverse.
823. New notebook > *From a notebook template…*: cards show the cover art and page count. Tap one, choose *Pages only*, *Use template*: the dialog shows its name, description and cover. Create: the notebook has the same paper and sizes and no ink.
824. Repeat with *With content*: ink and text come along, `{{date}}` in the text box is today’s date. Type `Lab {{date}}` as the name: the title has today’s date.
825. Edit the new notebook: the template notebook is not changed. Open both: slide links and PDF/image pages still show.
826. Settings > Library > Advanced > *Notebook templates* > Manage: Rename works; Delete asks, then the file goes to Obsidian’s trash.
827. Change *Notebook templates folder* to another folder: new templates are saved there and are still not in the library.
828. Phone and tablet: picker and manager targets are easy to hit; light and dark.

### 0.16 — inbox: shared files (steps 1070-1089)

Implemented, not verified on hardware. Needs an Android device with another app to share from (Files, Gallery, a browser). Reference screenshots after `npm run harness:check`: `dev/harness/dist/shots/inbox-*`.

1070. **Where shared files land.** In Settings → Library check *Shared files* is on and *Shared files folder* is empty. In Obsidian's *Files and links* note the attachments folder. From another app, share a PDF to Obsidian ("Save to vault" or the app's own share flow). Expected: the file is saved in that folder; within a moment Home shows a *Shared files* card with the file, its kind, size and age, and the library rail shows *Shared files* with a count.
1071. **Images.** Share a photo or screenshot (PNG or JPEG). Expected: it is listed as *Image*. A HEIC/HEIF photo is not listed.
1072. **Not listed.** Files that were already in the folder when you first opened the plugin with the feature on, subfolders, a `.txt` or Word file, notebooks' `_assets`, and the PDF exported next to a notebook are not listed.
1073. **Attachments next to the note.** In *Files and links* choose *Same folder as current file*, clear the setting and open Home. Expected: no card; opening the full list (if any file is waiting) or the settings explains that a folder must be chosen. Choose a folder in the setting: it works.
1074. **New notebook from a PDF.** Tap the file → *New notebook from it*. Expected: the usual PDF import (progress for a large file), the notebook opens with one page per PDF page; then a dialog offers to move the original to the trash. Cancel: the original stays in its folder and disappears from the list.
1075. **New notebook from an image.** Same with an image. Expected: a notebook named like the file with one page, the image as its background (landscape or portrait by the image).
1076. **Add a PDF to a notebook.** *Add to notebook...* → search and choose a notebook (closed). Expected: the PDF's pages are added at the end as PDF pages, a notice says how many, the notebook opens with them. Repeat with the notebook open in a tab: one undo step removes them again.
1077. **Add an image.** *Add to notebook...* → choose a notebook → *As a new page*: a last page with the image. Again with *On a page*: the image is placed in the middle of the page in view (the last page when the notebook is closed) as an element you can move and resize.
1078. **Move the original.** After 1074-1077 the confirmation says the file is now stored with the notebooks. *Move to trash*: the file leaves the folder (Obsidian's or the system trash, per your *Deleted files* setting) and the list. Check the notebook still shows the PDF or image.
1079. **Dismiss.** *Dismiss* on a file: it disappears from the card, the count and the rail, the file stays in the vault. Restart Obsidian: still hidden. Delete the file and share a new one with the same name: the new one is listed.
1080. **Move to trash without using it.** *Move to trash* asks first and names the file; Cancel leaves it; confirming trashes it.
1081. **Full list.** With more than three files, *Show all* opens the full list with the same actions. The list follows new shares while it is open.
1082. **Phone.** On a phone the card and the list fit the width, rows are at least 44 px, the menu is reachable with the finger and the pen.
1083. **Setting off.** Turn *Shared files* off: card, rail item and the folder setting's row disappear (the folder row is hidden while off). Turn it back on: files that arrived meanwhile are not listed (only files that arrive while it is on).
1084. **Sync.** With two devices on Sync, share on the phone: the file appears on the tablet's Home after it syncs (a file that arrives by sync counts as new there). Dismissing on one device does not hide it on the other.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Shared files inbox (#177): watch the attachments folder, Home card, rail badge, new notebook from it, add to notebook (PDF pages, image page / element), dismiss, move to trash | yes | folder resolution, filter, dismissals, queue, edits on closed notebooks, settings (`tests/shared-inbox.test.ts`); browser harness `doc=inbox` (real Home, real vault events, every action) | | edits of an open notebook (same code as the Move pages path) not run in the harness | |

## Known limitations (v0.4)

- Nothing has been verified on Android hardware yet.
- 0.4.0 showed an empty (black in the dark theme) page area on which nothing could be written, because `styles.css` was damaged; fixed in 0.4.1. The low-latency wet canvas and `pointerrawupdate` are now behind *Low-latency ink (experimental)*, off by default, until they are verified on devices.
- Experimental, depending on the device or WebView: the writing engine (raw input, wet ink), predicted ink, the highlighter preview, palm contact size, fling, the CSS fast path, the performance overlay, shape recognition thresholds, the ruler gesture, the text editor with the soft keyboard, the scanner (camera, detection, filters), PDF rendering speed on large files, drag and drop in the library and the navigator, `obsidian://` links from other apps.
- While the fast path moves the old bitmap during a pan or zoom, uncovered areas are blank and detail is not re-rendered until 120 ms after the gesture pauses.
- Page size presets are A4, A5, B5 and Letter (portrait or landscape) plus the size of imported PDFs and images; a custom size (50-1000 mm a side) can be chosen only when a notebook is created (wave 0.12). Changing a page size does not move or scale its strokes: strokes outside a smaller page are kept in the file but clipped on screen and in exports. An infinite page grows only downwards and up to 20 times its width.
- Exports: PDF and SVG always include the paper pattern, there is no option to leave it out. The PDF is not compressed, so a page with a lot of ink gives a large file (roughly 100-200 bytes per stroke point) and PDF page backgrounds and images are embedded as JPEG (PDF pages at 200 dpi). A page range can be exported since wave 0.10 (steps 483-484); there is no export of a selection. The PDF and SVG were checked with pdf.js and resvg on the PC, not on Android.
- Library: search covers titles, tags, page tags and text-box text only (no handwriting recognition). Folders are deleted to the trash (see steps 82-91). The library index is a cache and is rebuilt after it is deleted or when it is out of date. Duplicating a notebook that uses a PDF shares the same asset file.
- PDFs and images live in `_assets/` and are referenced by content hash; deleting or renaming those files breaks the pages that use them (a placeholder is shown and the ink is kept). *Check library* (wave 0.10, steps 498-504) finds unused files and moves them to the trash after a confirmation; it cannot see a notebook that is open with unsaved changes (files younger than an hour are never judged) and it is slow on a very large library with a long version history. A notebook moved to another vault needs its `_assets` files too.
- Scans: the corners are detected on a downscaled image and may need correcting by hand; the photo comes from the system camera or a file picker, there is no live camera view inside the plugin.
- A lasso selection normally belongs to one page; a lasso that reaches into another page selects on both (wave 0.10, steps 284-288) and moving it re-parents the items to the page under them. Cross-page selections do not carry ink that follows objects, and *Make white transparent* only acts on the images of the first page. Resize is uniform only (one handle). Strokes moved partly outside their page are clipped when drawn.
- Cross-device clipboard (wave 0.10): not verified with two devices. It needs a synced vault; it keeps the last five copies of each device (3 MB cap) and lists devices by an 8 digit id, not by name; a picture that has not synced yet is skipped with a notice. Nothing is removed from another device's file; old files are not cleaned up.
- Stabilization is applied while writing and the filtered points are what is saved; it cannot be changed after the fact. New strokes use the new ink geometry (render 2); old strokes keep their look (render 1).
- The segment eraser removes whole point runs: very short leftover pieces (a single point) are dropped.
- Every save serializes the whole document. The re-validation is full under 1 MB and incremental above it, so very large notebooks save faster than in 0.1, but a short freeze is still possible on slow tablets (to be measured with the in-app benchmark). Saves, journal entries and thumbnails wait while the pen writes.
- The undo history is in memory only (500 commands) and is lost when the notebook is closed.
- Files written by 0.4.0 (format v5) open read-only in older versions of the plugin (0.3.x and earlier); files saved by 0.5.0 with page margins (format v6) open read-only in 0.4.x; files saved by the next version (format v7: bookmark details, page tags, reading position, new papers) open read-only in 0.5.x; files saved with format v8 (markers, boxes, invisible ink) open read-only in versions that read up to v7. The reading position is stored only when something is saved, so a notebook that was only read on a device does not change where the other devices start.
- If Android kills Obsidian, at most the changes of the last ~200 ms plus those never journaled are lost: the journal covers notebooks up to 8 MB (above that only the regular save, ~1.5 s, up to 10 s while writing continuously, protects the changes). The journal is plugin-private and does not travel with sync.
- Version history keeps one snapshot per interval (24 h by default), so very recent work is protected by the journal and the regular save, not by the history.
- Repair: fields unknown to this version are not carried into the repaired notebook (they remain in the untouched original); a stroke cut off by the damage keeps only its points before the cut; text after a damaged region is recovered only where whole lines survive in the layout the plugin writes (a reformatted file is read only up to the damage). Merge: a conflicted copy is recognised only by its name plus the same notebook id, page settings of the copy are not merged (counted in the summary), and a stroke deleted on one device comes back if the other device still has it. Page restore previews do not draw PDF or image backgrounds.
- When another writer changes the file in the instant between our read and our write, the attempt is aborted by writing back the same content; this may bump the file's modification time (no data change).
- The S Pen side button (setting *Pen side button*, default radial menu on click + erase while held) is handled from the signals users reported on a Samsung tablet (a primary press with zero pressure while the pen hovers; nothing at all in the Pen button test with Air command off), not from hardware tests by the author; how the pen reports it has not been checked on a device (0.5.0: nothing happened; Samsung Air command takes the button while hovering; 0.5.1 accepts more signals and adds the *Pen button test*); the standard `buttons & 32` eraser keeps working as before. Since 0.12.4 the button is decided per pen contact (tap = radial menu, drag = eraser, a press in the middle of a stroke = ink) and every plausible form of its signal is accepted; which form the Samsung tablet really sends is still not known (steps 493-499: the *Pen button test* lines *Signal seen* / *Decision*), and on Obsidian for Android a press with the pen in the air is invisible to the app.
- Notebooks are invisible to Obsidian search, tags, backlinks and graph unless *Companion notes* is on (off by default); the companion note carries the text boxes, not the handwriting (no OCR yet).
- Companion notes: a note the user moved is found by its `notebook-id`, but deleting that property makes the plugin create a new note; changing the location or name setting does not move existing notes; a companion folder inside the notebooks folder shows in the library sidebar.
- Library trash, page trash and templates are not verified in Obsidian or on Android (steps 82-91). Trashed items move with `vault.rename`, so notes that linked to a trashed notebook show a broken link until it is restored. Permanent deletion follows Obsidian's *Deleted files* setting. The page trash keeps the 50 most recent pages per notebook for 30 days (fixed limits); it is not synced into the notebook, only through one vault file per deleted page under `_trash/pages/<notebook id>/`, so two devices deleting pages at the same time keep both. Page trash and template thumbnails do not draw PDF or image backgrounds. A folder named `_trash`, `_templates` or `_meta` directly under the notebooks folder is hidden from the library. A trashed folder that holds files other than notebooks is never emptied automatically.
- Level of detail and heavy pages (wave 0.7) are not verified in Obsidian or on Android (steps 156-161). The level of detail applies to committed strokes only (not to the stroke being written or to a floating selection) and switches when a redraw runs after the zoom settles, so a pinch shows the old bitmap scaled until then, as before. The heavy page limits (3,000 strokes, 120,000 points, 20 MB of images) are fixed; the split moves whole strokes, so a stroke that crosses the cut goes to the side of its middle.
- PDF reading tools: the search and the snapping highlighter need the PDF's text layer (scanned PDFs have none), positions inside a long line of text are estimated from the font's character widths and can be a few points off, rotated and vertical text is not snapped, and the search lists at most 500 matches. Dimming and hiding annotations are view settings: exports, thumbnails and embeds are not affected.
- Processing flow (wave 0.8): the inbox lists blocks of writing on the quick-notes sheet (split at gaps of about 1.3 cm; typed text and ink alike) and highlights and comments on PDF pages; question, placeholder and importance markers are not listed until the marker elements exist (the interface is ready). Scanning the PDF notebooks reads every notebook that has PDF pages each time the inbox is opened or refreshed (no cache). A highlight on a PDF without a text layer has no text for the card. *Link to a card* only records the link in the inbox file; the card note is not changed. The inbox state is per device (merged on reading), so two devices never write the same file; it is not verified with a real sync service.
- Textbook references (wave 0.8): the tappable area is a DOM element over the typed text, so the pen cannot start a stroke exactly on the reference (and it is hidden while the text tool is active); references are found only in typed text boxes, not in handwriting; the position of a reference inside a long wrapped text box comes from the same layout as the drawing but is not verified on every font; a book whose printed numbers restart (roman front matter) needs its offset set for the main part.

### 0.15 — header: automatic page header or footer (steps 840-859)

Implemented, not verified on hardware. Settings → Pages → *Page header* (closed until the feature is in use). Reference screenshots after `npm run harness:check`: `dev/harness/dist/shots/header-*.png`.

840. **Off by default.** A new install shows no header or footer; Settings → Pages has a *Page header* group whose only visible row is *Header or footer* (Off). Expected: nothing is drawn on any page.
841. **Header.** Set *Header (top)*. Expected: every page shows a small grey "1 / N", "2 / N"… centred at the top; the numbers follow adding, deleting and moving pages (after the next redraw); it is not selectable, not erasable and does not appear in the page's ink or in undo.
842. **Footer.** Set *Footer (bottom)*. Expected: the line is at the bottom of each page; on an infinite page it is not drawn (the page grows), or goes to the top instead if the top is free.
843. **Fields.** Turn on *Date* and *Notebook title*. Expected: "Title · 3 Jun 2026 · 2 / 12" (the date is the day the notebook was created, month in the interface language); turning *Show the total* off gives "2". With every field off nothing is drawn.
844. **Position.** Left / Centre / Right move the line; it keeps a 28 pt margin and a long title is squeezed, never cut off the page.
845. **Lecture page.** In lecture mode add a lecture page (*New lecture*). Expected: the header line sits above the lecture's own header text without touching it. Move the lecture header up to the very top of the page: the line moves to the bottom (or disappears when the bottom is also taken).
846. **PDF and picture pages.** On a page that shows a PDF slide or a picture the line is not drawn (it would cover the slide) unless the page has margins around the background.
847. **Night mode and Obsidian theme.** In night mode the line is a light grey on the dark paper; in light and dark Obsidian themes it stays quiet and readable but never louder than the writing.
848. **Zoom and scroll.** Pinch-zoom and scroll through a long notebook: the line stays crisp at any zoom and scrolling is as smooth as without it (it is painted with the page, not per frame).
849. **Export.** With *Include in exports* on, export a page as PNG, the notebook as PDF, a page as SVG and print: the line is on each page at the same place and number. With *Ink only* it is left out; with it off in the settings no export shows it.
850. **Phone.** On a phone the group's rows fit the width, no control is under 44 px, and the dropdowns work in Italian.
851. **Nothing stored.** Save and reopen a notebook with the header on, then off: the file has no new field and the notebook opens as before.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Automatic page header / footer (#75): page number, creation date, title; left / centre / right; PNG / PDF / SVG / print | yes | layout, text, skip and shift rules, SVG and PDF output, settings (`tests/page-header.test.ts`); harness check of the painted line (`header-*`) | | | |

### 0.16 — movesel: move a selection to another page (steps 990-1009)

Roadmap 78. Select ink or objects with the lasso; the selection bar (overflow) and *All actions* have *Move to page…* and *Copy to page…*. No change to the notebook format. Reference screenshots after `npm run harness:check`: `dev/harness/dist/shots/movesel-*.png`.

990. **Offered.** Lasso a few strokes: *Move to page…* and *Copy to page…* are in the selection bar overflow and in *All actions* (search "move"). With nothing selected they are not offered; in read-only mode they are disabled.
991. **Picker.** Tap *Move to page…*: a grid of page thumbnails (not the page you are on), a dashed *New page after N* card first, a *Keep exact position* chip. On a phone the grid fits without sideways scroll, every card is at least 40 px.
992. **Move.** Tap page 4: the ink leaves page 1 and is on page 4 at the same place; a toast says how many items moved and has *Go to page*. The toast button scrolls to page 4.
993. **One undo.** Undo once: everything is back on page 1, exactly where it was. Redo moves it again.
994. **New page.** Pick *New page after N*: a blank page (same size and paper) appears after the current one holding the selection. One undo removes the page and brings the ink back.
995. **Smaller page.** Move a wide selection to a smaller page (e.g. A5): it is pulled inside the page. With *Keep exact position* on, it keeps its coordinates and may fall outside.
996. **Objects.** Select a text box, a picture and a graph with its ink: all move; the picture still shows; the ink written on the graph stays on it.
997. **Ink bound to a graph.** Select only the ink written on a graph: a message asks you to select the graph too, nothing moves.
998. **Slide links.** Select ink written beside a slide and move it: the slide badge is still there on the new page and opens the same slide.
999. **Drawings with states.** Move a stroke that belongs to a part of a drawing with states: the toast adds that it left the part; the rest of the part is unchanged. Undo restores the part.
1000. **Copy.** *Copy to page…*: the original stays, the copy is on the chosen page; one undo removes the copy. Copies of a graph keep their ink.
1001. **Several pages.** A lasso that spans two pages, then *Move to page…*: a message says it cannot, nothing moves.
1002. **S Pen.** Using the pen to tap the cards works; palm touches do not choose a page.
1003. **Italian, dark and light.** All texts translated; both themes and *Follow Obsidian theme*.

| Feature | Implemented | Automated test | Verified on hardware | Experimental | To do |
|---|---|---|---|---|---|
| Move a selection to another page (#78) | yes | `tests/selection-move.test.ts`, harness `movesel` | | | |
| Copy a selection to another page | yes | same | | | |
| New page in the same undo step | yes | harness `movesel` | | | |

### 0.16 — present: presentation mode (steps 1030-1049)

Presentation mode (#87, no format change). Reference screenshots after `npm run harness:check`: `dev/harness/dist/shots/present-*.png`. Use a notebook with a few pages, one of them a drawing with states (a block moving in two states), and if you can a lecture PDF and a Bluetooth presenter remote.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Presentation overlay: black surround, one page fitted, counter and controls that hide by themselves | yes | harness `present-check.ts` | | | |
| Next / previous: keys, presenter remote keys, tap zones, swipe | yes | `tests/present-logic.test.ts`, harness | | | |
| Steps through the states of a drawing before the next page (setting) | yes | `tests/present-logic.test.ts`, harness | | | |
| Laser pointer with the pen and the mouse (fading trail) | yes | `tests/present-logic.test.ts` (trail), harness | | | |
| Write while presenting | yes | harness | | yes | |
| Real full screen (Fullscreen API) on Android and Windows | yes | | | yes | |
| Command, More sheet, notebook map button | yes | action registry tests, harness | | | |

1030. **Start.** From *All actions* (More) tap *Presentation*, from the command palette run *Present the notebook (full screen)*, and from the notebook map tap *Presentation*: the page in view fills the screen on black, centred and not cropped, a page counter ("3 / 12") shows for a moment and fades. On Windows the window goes full screen; on Android check whether the status bar and navigation bar go away (if not, the overlay still covers the notebook).
1031. **Keys and remote.** Arrow right/down, Page Down, Space, Enter go on; arrow left/up, Page Up, Backspace, Shift+Space go back; Home and End jump to the first and last page; *B* or *.* blanks the screen and any move brings it back. A Bluetooth presenter remote (it sends Page Up / Page Down or arrows) turns the pages the same way, also when the notebook's own *Page turner keys* setting is off.
1032. **Touch.** Tap the left third: back. Tap the rest: forward. Tap the top strip: only the controls appear. Swipe left: forward, swipe right: back. A long press or a slow drag does nothing.
1033. **Pen is the laser.** Hover the S Pen over the page: a red dot follows it; touch the screen with the pen and move: the dot leaves a trail that fades in under a second. Nothing is written (close the presentation and check the page, and that the notebook was not rewritten). Pen taps do not turn the page. The pen side button has no special action while presenting.
1034. **Laser off.** Settings, *PDF & reading*, *Pen is a laser pointer while presenting* off (or the laser button in the controls): the pen then turns pages with taps like a finger.
1035. **States first.** On the page with a drawing with states, Next shows *as drawn*, then each state one after the other (the counter shows "2 / 5 · 2/3"), then the next page. Previous goes back through them and lands on the last state of a page it comes back to. With *Present drawings with states step by step* off, Next turns the page at once and the page shows the state the notebook opens with. After closing the presentation the notebook shows the same default state as before: nothing is saved.
1036. **PDF and picture pages.** Present a lecture PDF notebook: the slide is sharp at the screen size (not blurred), with the ink and text boxes on it.
1037. **Write while presenting.** Tap the pen button in the controls: the black surround goes away and the notebook shows the same page; write or draw with the pen as usual; the arrow keys and the remote still turn pages and the notebook follows. Switch it off: the black returns on the page the notebook is on. The ink you wrote stays and is saved normally. The S Pen button actions (radial menu, eraser drag) belong to the notebook and work as always while writing.
1038. **Controls.** The three round buttons (laser, write, exit) appear on any tap or pointer move and hide after about three seconds; each is at least 44 px. Exit closes the presentation; Esc does too (on a keyboard); in real full screen the browser's own Esc leaves full screen and ends the presentation.
1039. **Where you land.** After exiting, the notebook shows the page the presentation ended on.
1040. **Read-only and lecture.** Present a read-only notebook and one in lecture mode: both work; nothing is written.
1041. **Rotation and resize.** Rotate the tablet or resize the window while presenting: the page is fitted again without losing the place.
1042. **Large pages.** Present an infinite page: its top part is shown, fitted (as in thumbnails).
1043. **Phone and tablet, dark and light.** The controls and the counter fit a phone; check both themes (the surround is always black).
1044. **Closing.** Close the notebook tab, or switch to another file in the tab, during a presentation: it ends without errors.

### 0.16 — digest: Highlights digest (steps 1050-1069)

Implemented, not verified on hardware. Reference screenshots after `npm run harness:check` (`HARNESS_DOC=digest`): `dev/harness/dist/shots/digest-{dark,light}-{tablet,phone}.png`.

1050. **Open it.** Highlight a few passages (some on PDF pages, some on handwriting, two colours). Notebook More menu (or the command palette) > *Highlights digest…*: a dialog says how many highlights and pages, with *Group by* and *Picture quality*. A notebook without highlights only shows a notice.
1051. **First run.** *Create the digest*: a note *<Notebook> — Highlights* appears next to the notebook with a picture of every highlighted region (ink, PDF page and highlighter together) and, on PDF pages, the PDF text under the highlight quoted. Lines of one paragraph are one region; far apart or different colours are separate ones.
1052. **Links.** Each page heading (or each highlight, when grouped by colour) links back to the notebook page; tapping it opens that page.
1053. **Pictures.** They are in the folder Obsidian uses for attachments of that note (Settings > Files and links), named *<Notebook> highlight pN-K.png*.
1054. **Your text is safe.** Write above and below the digest section and run it again after adding a highlight: only the part between `<!-- notebook-digest:start -->` and `end` changes; your text stays. Run it twice without changes: the note is identical and no new picture files appear.
1055. **Group by colour.** Choose *By colour* (or set it in Settings > Reading > Highlights digest grouping): sections per colour, each highlight with its page link.
1056. **Unpaired marker.** Delete only the end marker and run: a notice says the note was left untouched, and it is.
1057. **States and read-only.** On a page with drawing states the picture shows the state in view. The digest also works in read-only mode (it writes the other note, never the notebook).
1058. **Phone.** The dialog fits a phone; on a long notebook the progress notice counts the highlights.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Highlights digest (#90): regions, crops, PDF text, marked section, group by page or colour | yes | clustering, text under bands, section replacement and idempotence (`tests/highlight-digest.test.ts`); harness `dev/harness/digest-check.ts` | | | |

### 0.17 — snap: magnetic snap and alignment guides (steps 1120-1139)

Implemented, not verified on hardware. Reference screenshots after `npm run harness:check` (`HARNESS_DOC=snap`): `dev/harness/dist/shots/snap-*.png`. Settings > Writing > *Snap and guides* and *Snap strength*. No change to the notebook format.

1120. **Defaults.** Settings > Writing shows *Snap and guides: Grid and guides* and *Snap strength: 8 px*. Switch the first to *Off*: the strength row disappears.
1121. **Grid.** On a grid page, write a word, lasso it and drag it slowly with the S Pen. Expected: it jumps onto the nearest grid line by its left, right, top or bottom edge when within a few millimetres, and a faint blue line shows which one. Lift: it stays exactly there. Repeat on dotted and millimetre paper (every 5 mm) and on ruled paper (only up and down; the margin line is a guide).
1122. **Blank paper.** On blank paper, *Paper grid* alone does nothing; *Guides* still works.
1123. **Alignment with another item.** Put a picture and a text box on a page; drag the text box so that its left edge nears the picture's left edge. Expected: it is pulled onto it and a pink line runs from one to the other. Do the same with the centres and with the top and bottom edges.
1124. **Written words are items.** Write two words apart and drag one beside the other: it aligns with the whole word (not with a single stroke of it); the selection itself, and the ink that floats with a selected picture, are never targets.
1125. **Page centre and margins.** Drag a picture towards the middle of the page: a teal line shows the page centre; on a PDF page with margins the margin edges, and on ruled paper the margin line, are teal lines too.
1126. **Scaling.** Drag the scale handle of a picture so that its right or bottom edge nears another item or a grid line: the size is pulled so that the edge lands on it (the proportions are kept) and the guide shows.
1127. **Rotation.** The rotate handle never snaps.
1128. **Strength.** At 3 px the pull is barely noticeable, at 20 px it grabs from far; changing it applies to the next drag. Zoomed in, the pull is the same number of screen pixels.
1129. **Second finger.** Hold one finger on the screen (not the palm) and drag a selection with the S Pen: it moves freely, no guides; lift the finger mid-drag and the snap resumes. With a finger drag, a second finger does the same. A resting palm must not switch the snap off.
1130. **Snap button.** With a selection, the bar has *Snap* (a magnet): tap it to turn the snap off for this notebook view (a notice says so), tap again to turn it on. It is not shown when the setting is *Off*.
1131. **Keyboard.** With a mouse, hold Alt while dragging: free.
1132. **Guides only while dragging.** The guides appear during the drag and are gone when you lift; nothing is saved; undo takes the whole move back in one step.
1133. **Many items.** On a page with a lot of ink, dragging stays smooth (the targets are made when the drag starts); on a page with more than 3000 strokes only pictures, text boxes and the page lines are targets.
1134. **Locked page.** On a locked page a selection cannot be dragged (the lock notice), so nothing snaps.
1135. **Across pages.** A selection that spans several pages moves freely.
1136. **Drawing with states.** A part in a state moves with the snap too (its handles are the same).
1137. **Phone.** The Snap button fits the bar (it is the first to go on a narrow bar and is always in the All actions sheet, Selection).
1138. **Dark and Italian.** Guides are visible on the dark paper; the settings and the button read *Aggancio e guide*, *Forza dell'aggancio*, *Aggancio*.
1139. **Older notebooks.** A notebook saved before this version opens and saves as usual; nothing in the file mentions the snap.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Snap and alignment guides (#71): paper grid, item/page/margin lines, move and scale, guides on the live layer, finger/Alt and button bypass, settings | yes | `tests/snap.test.ts`, `tests/snap-glue.test.ts`, harness `doc=snap` | | held-finger detection (palm size) | |

### 0.17 — pagesplit: merge, split, extract pages (steps 1140-1159)

Merge notebooks, split a notebook, extract pages into a new notebook (roadmap #77). Reference screenshots after `npm run harness:check`: `dev/harness/dist/shots/design/xfer-*.png`. Use a physics notebook of about 8 pages (one locked, one with a PDF or photo background, one written beside a slide, one with a bookmark), a smaller chemistry notebook, and a note of yours that links to a physics page (`[[Physics.notebook#p3&id=…]]`). Keep a copy of the vault first: these steps remove pages from notebooks (the app keeps a backup of each file it rewrites in `_backup/`).

1140. **Menu.** In the library, the ⋯ menu of a notebook has *Merge another notebook into this one…*, *Split at a page…* and *Extract pages to a new notebook…*.
1141. **Extract, copy.** *Extract pages…*: tick two pages, *Keep them here*, give a name, *Copy to new notebook*. A new notebook appears beside the first with those pages, their ink, backgrounds and bookmarks; the original is unchanged (open it: nothing missing; its file date does not change).
1142. **Extract, move.** The same with *Remove them from here*: the button turns red and says *Move*; the pages are in the new notebook and gone from the original. Undo in the original (if it was open) brings them back; the new notebook keeps its copy.
1143. **Locked page.** Tick a locked page in *Move* mode: the button stays off until you tick *Yes, locked pages may be removed*. In *Copy* mode no confirmation is asked, and the copy is locked too. If a move runs without that tick (a page locked while the dialog was open), the locked page stays in the original and the notice says so.
1144. **Split.** *Split at a page…* on a notebook: choose the page the new notebook starts at (the first page is not offered); the sentence says what stays and what goes; the new notebook is called *“name” (part 2)* and sits next to the first. Open both: together they hold every page, in order.
1145. **Merge, copy.** *Merge another notebook…* on physics: search and choose chemistry (its page count shows), choose *After page 2*: the chemistry pages are inserted there, as one undo step if physics is open. Chemistry is unchanged.
1146. **Merge, trash.** The same with *Move the merged notebook to the trash afterwards*: the button turns red (*Merge and move to trash*); chemistry is in the library Trash only after physics has its pages; restoring it from Trash works and it still has all its pages.
1147. **Open notebooks.** Do 1141 to 1146 while the source or the destination is open in a tab: it is edited through the open tab (undo works) and never saved twice. While you are writing with the pen the operation says it cannot edit right now; nothing is changed.
1148. **Map.** In a notebook, open the notebook map and tap *Select pages*: cards toggle on tap; the bar shows the count, *Extract…* and *Split before this page…* (only for one page that is not the first). *Extract…* opens the dialog with those pages ticked; *Split…* with that page chosen.
1149. **Pictures and slides.** Extract a page with a PDF or photo background and a page with ink written beside a slide: the new notebook shows the background (no second copy of the file in `_assets`) and, tapping the ink, the slide link.
1150. **Links.** After a move or a split, if a note of yours links to a page that moved, the app offers *Review links*; nothing is rewritten until you accept in the list. A text box in a notebook that links to a moved page is counted in the notice (it is not rewritten).
1151. **Failure.** Make the destination fail (a full disk, or turn the vault read-only) while moving: the notice says why, the pages are still in the original.
1152. **Sync.** On a vault synced between two devices, change the source on the other device while the dialog is open, then confirm: a page that changed stays in the original (the notice says how many) and is in both notebooks.
1153. **Look.** Light, dark, *Follow Obsidian theme*, tablet and phone width: the dialog fits, targets are at least 40 px, no sideways scroll.

| Feature | Implemented | Automated test | Verified on hardware | Experimental | To do |
|---|---|---|---|---|---|
| Merge notebooks, split a notebook, extract pages into a new notebook (roadmap #77, 0.17 pagesplit): library menu items and the map's selection mode; copy keeps the originals (new page ids), move keeps the ids; the destination is written and read back first, the source loses only pages still as they were copied; locked pages need a confirmation to leave; a merged notebook goes to the library trash only when all its pages are in the destination and unchanged; assets, slide links, bookmarks and drawing states travel; no format change | yes | yes (`tests/notebook-transfer.test.ts` planning, ids, assets, slides, locks, removal; `tests/page-transfer-run.test.ts` the runner on an in-memory vault, open and closed notebooks; `tests/transfer-logic.test.ts`; harness `doc=xfer`) |  | the order of writes with a sync client; the Review links offer scans the notes once | not tried with the real tablet or a synced vault (steps 1140-1153); text links written inside notebooks are counted, not rewritten |
### 0.17 — minimap: overview of the page in view (steps 1160-1179)

Implemented, not verified on hardware. Reference screenshots after `npm run harness:check`: `dev/harness/dist/shots/minimap-*.png`. A small floating map of the page in view with the rectangle the view shows (roadmap #173). It needs no document format change: the picture is the page rendered once through the library's thumbnail renderer and cached; the corner and the collapsed state are kept per device in local storage.

1160. **Automatic on an infinite page.** Make a page infinite (page sheet, *Infinite page*) and write until it is taller than the screen. Expected: a small map appears in the bottom right corner (above the fast scrollbar) with a title bar, the page picture and a coloured rectangle where you are. On a normal A4 page at fit width it does not appear.
1161. **Automatic at high zoom.** On a normal page pinch-zoom in about twice. Expected: the map appears; pinch back to fit and it goes away. With the whole page in view it never shows in automatic mode.
1162. **Tap to pan.** Tap a spot on the map. Expected: the view centres on it at the same zoom and the rectangle moves there.
1163. **Drag to pan.** Drag a finger or the S Pen on the map. Expected: the rectangle and the page follow smoothly; nothing is written on the page and no stroke is created (check undo).
1164. **Keyboard.** With a keyboard, focus the map (Tab) and press the arrow keys. Expected: the view moves by a tenth of the screen.
1165. **Follows the page.** Scroll and zoom the page normally. Expected: the rectangle follows. Write a few strokes, lift the pen, wait about a second. Expected: the picture of the map shows the new ink; nothing redraws while the pen is writing.
1166. **Move to another corner.** Drag the handle (the move icon on the title bar) towards another corner and release. Expected: the map settles in the nearest corner, avoiding the top right badge and the scrollbar; close and reopen the notebook: it is still there.
1167. **Collapse.** Tap the collapse button. Expected: only a round map button remains; tapping it brings the map back. The choice is remembered after reopening.
1168. **Setting.** Settings, *Pages*, *Page overview (minimap)*: *Never* hides it everywhere; *Always* shows it on every page; *Automatic* is the default.
1169. **Palm and pen.** Rest the palm near the map while writing. Expected: the S Pen still writes on the page; the map never reacts to the pen while it draws elsewhere. The side-button gestures are unchanged.
1170. **Look.** Light and dark, and with *Follow Obsidian theme*: the map matches the other floating panels; on a phone the title text is hidden and the map stays inside the page area; the controls are at least 32 px.
1171. **Page panel and presentation.** Open the page panel and the presentation mode. Expected: the map does not cover the panel's controls; in presentation mode (a full-screen layer above it) it is covered.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Minimap (#173): floating overview of the page in view (cached low-resolution render, redrawn at most once every 1.2 s and never while the pen writes), view rectangle, tap / drag / arrow keys to pan, collapse, four corners, setting automatic / always / never; no format change | yes | `tests/minimap-geometry.test.ts` (geometry, show rules, corner, throttle, stored prefs); harness `dev/harness/minimap-check.ts` (`doc=minimap`, tablet and phone, light and dark) | | | Presentation mode covers it with its own layer (step 1171) |
### 0.17 — pdfcopy: optional PDF copy next to each notebook (steps 1200-1219)

Implemented, not verified on hardware. Reference screenshots after `npm run harness:check` (`HARNESS_DOC=pdfcopy`): `dev/harness/dist/shots/` (the settings rows at tablet and phone widths, dark and light).

1200. **Off by default.** Fresh install: Settings > Obsidian integration > *Keep a PDF copy of each notebook* is off. Write in a notebook for a minute: no `.pdf` appears next to it. The tab's More options menu has *Keep a PDF copy* unchecked and the line *PDF copy is off*.
1201. **Turn it on for one notebook.** Menu > *Keep a PDF copy*: a PDF named like the notebook appears next to it within a few seconds and the menu line reads *PDF copy updated hh:mm*. Open the PDF in another app: all pages, ink, paper and PDF backgrounds are there.
1202. **Idle update (desktop).** Write something, then stop and wait about 30 seconds (do not touch the pen): the PDF changes (its time in the file manager) and the status time moves. While the pen is on the screen nothing is rebuilt.
1203. **Unchanged is skipped.** Open and close the notebook without writing: the PDF file's modified time does not change.
1204. **On close.** Write a stroke and close the notebook tab at once (before 30 s): shortly after, the PDF contains the stroke.
1205. **Phone or tablet is cheap.** On Android with *Update the PDF copy* = *Automatic*: while writing nothing is rebuilt; closing the notebook, or switching to another app, updates the copy. With *After a quiet moment* it also updates while the notebook stays open.
1206. **No stutter.** A notebook with many pages and PDF backgrounds: closing it never freezes the screen; the copy appears a little later.
1207. **Your own file is never replaced.** Put a PDF of yours named *<notebook name>.pdf* next to a notebook first, then turn the copy on: your file is untouched, the copy is *<name> (copy 2).pdf* and a notice says why.
1208. **A copy you edited is yours.** Annotate or replace the plugin's copy with another app (or overwrite it with any other file), then write in the notebook: the next update goes to *(copy 2)*, the edited file stays as it is.
1209. **Global switch.** Turn *Keep a PDF copy of each notebook* on in Settings: every notebook you open and save gets a copy. Turn *Keep a PDF copy* off in one notebook's menu: that one stops (its old PDF stays); other notebooks keep theirs.
1210. **Folder.** Set *PDF copy folder* to e.g. *Shared/PDF*: the copies go there (the folder is created). Two notebooks with the same name never replace each other's copy (the second one is *(copy 2)*).
1211. **Rename.** Rename a notebook: its copy is renamed with it (same folder, or the new folder when it is next to the notebook); move the notebook to another folder: the copy follows. A copy you had edited is left where it is.
1212. **Delete.** Move a notebook to the trash (library or Obsidian): the PDF stays, nothing is updated any more. Restore the notebook and write: the copy resumes.
1213. **Italian.** Switch the plugin language to Italian: the settings rows and the menu read *Mantieni una copia PDF*, *Copia PDF aggiornata alle hh:mm*.
1214. **Sync.** With two devices on one vault: both can keep the copy; neither duplicates it (no *(copy 2)* for a copy the other device wrote), and `_meta` holds one `pdfcopy-<device>.json` per device.
1215. **Failure.** Make the folder unwritable or full (or name a file where the folder should be): the menu line says *PDF copy failed: …*, one notice appears, the notebook itself is unaffected.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Optional PDF copy next to the notebook (#23): global and per-notebook switch, idle / on close / background update, fingerprint skip, page-by-page build | yes | settings, targets, record store, fingerprint, timers and the service on an in-memory vault (`tests/pdf-copy-logic.test.ts`, `tests/pdf-copy-service.test.ts`); harness `dev/harness/pdfcopy-check.ts` | | | |
| PDF copy data safety: only a file the plugin wrote (path + size + SHA-256) is replaced; renames follow, deletes stop | yes | same tests | | | |


### 0.17 — task

1240. **Make a task.** Select a handwritten line with the lasso, then *Make task…* (selection bar overflow or All actions). A dialog asks for the task text, an optional due date and the target. Add it to today's daily note: the last line of the note is `- [ ] text ![[… task pN-hhmmss.png|200]] [[Notebook, page N]] 📅 date`.
1241. **Picture.** The picture is a crop of the page around the selection (with PDF page, pictures and ink), in the folder Obsidian uses for attachments, and it does not show up in the shared-files inbox.
1242. **Link.** Tapping the page link in the daily note opens that page of the notebook.
1243. **Daily note rules.** With *Create the daily note if missing* off and no note for today, a notice names the note and nothing is written; with it on the note is created (from your Daily notes template). A second task goes below the first; the rest of the note stays as it was.
1244. **Other targets.** Set a Tasks note in Settings > Integration: it appears in the dialog (only if the note exists). *Another note…* needs a note chosen before *Add task* is enabled.
1245. **Tasks plugin.** With the Tasks plugin installed the line shows as a task with its due date; turn *Tasks plugin date for due dates* off and the date is written as `[due:: date]`.
1246. **Guards.** Add task is disabled until there is a text; the selection of a drawing's part (states) and a read-only notebook do not offer the action.
1247. **Phone.** The dialog fits a phone and the date field opens the system date picker.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Task from a selection (#57): crop, link, due date, daily/tasks/chosen note | yes | line building, crop, append (`tests/selection-task.test.ts`); harness `dev/harness/task-check.ts` | | | page badge on the task's region |

### 0.18 — comments (margin comments, format v16; steps 1300-1319)

Implemented, not verified on hardware. Reference screenshots after `npm run harness:check`: `dev/harness/dist/shots/comments-*.png`. Notebooks saved with a comment are format v16: 0.17 and older open them read-only.

1300. **Comment on a selection.** Select some ink with the lasso, tap *Comment* on the bar. Expected: a dialog with a text box and a sketch pad; *Add comment* stays off until there is text or a stroke. Type a line, draw a small sketch with the S Pen, tap *Add comment*. A numbered marker 1 appears in the right margin of the page, joined by a thin line to an outline of the selection's box; the comment's card opens beside it. One undo removes the comment.
1301. **Marker and card.** Tap the marker: the card closes; tap it again: it opens and the region is highlighted. The card shows the device name, the time, your text and the sketch. On a phone the card is docked at the bottom.
1302. **Reply and resolve.** Type in the reply box and tap send: the reply appears indented; one undo removes it. Tap *Resolve*: the marker turns grey with a check and the line and outline disappear unless the card is open; *Reopen* brings it back.
1303. **Edit and delete.** Edit the comment (pencil): the dialog has the text and sketch; *Save* marks it *edited*. Delete (bin) removes the comment with its replies; one undo brings the whole thread back.
1304. **Comment on a region.** More sheet > *Comment on a region* (or the add button of the panel). Drag a rectangle on an empty part of the page with the S Pen: the dialog opens; Add. Cancel and Escape end the drawing without a comment. A tap that is not a drag keeps the drawing armed.
1305. **Comments panel.** *Comments panel* in the sheet or palette. Expected: every comment with its page, text, device and reply count; *Open*, *Resolved* and *All* filter the list; a row jumps to the region and opens its card (on a phone the panel steps aside).
1306. **Many comments.** Add five comments close together: the markers are pushed apart in the margin (never on top of each other) and still numbered top to bottom.
1307. **Zoom and scroll.** Zoom and pan: markers, lines and outlines follow the page; pages out of view draw nothing.
1308. **Locked page.** Lock the page: markers and cards can still be opened and read; *Comment* is refused with the *Page locked* notice; the card offers no reply, edit, delete or resolve.
1309. **Read-only and settings.** In read-only mode the panel and cards open but nothing can be changed. *Show comment markers* off hides the markers (the open comment still shows).
1310. **Saving and an older plugin.** Close and reopen: comments, replies, sketches, resolved state and times are kept. Copy the notebook to a device with 0.17: it opens read-only with the "newer version" message and is not rewritten.
1311. **Two devices.** On two devices add a different comment and a different reply to the same comment, then sync so a conflicted copy appears; *Merge conflicted copies*: the summary says comments were added and both devices' comments and replies are there. Edit the same comment on both: the later edit wins.
1312. **Pages.** Duplicate a page, copy a page to another notebook, move one: the comments go with it. Copy a selection that has a comment on it to another page: the comment does not.
1313. **PDF export.** Turn on *Comments in the PDF export*, export: pages with comments are wider, with the region outlined and the note (author, time, text, replies, sketch) in the strip beside it. With the setting off the PDF is unchanged.
1314. **Markdown export.** The notebook.md lists each page's comments under its text (numbered like the markers, with replies).
1315. **Italian, dark and Obsidian theme.** The dialog, card, panel and notices read in Italian; markers, card and panel are readable in light, dark and with *Follow Obsidian theme*.
1316. **Phone and tablet.** At phone width the card and panel are bottom sheets, markers are at least 24 px (the touch target is larger), the sketch pad takes finger and pen.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Margin comments (#86, format v16): `Page.comments`; v15 to v16 migration (a stray key is dropped, large v15 files still stage), lenient read and strict write, repair (orphan replies, regions outside the page), merge of two devices (both keep theirs, later edit wins), copies, moves, restore, templates, margins shift, lock guard | yes | `tests/model-v16.test.ts` | | | |
| Comments UI: selection and rectangle entry points, margin markers with lines and outlines, card with flat thread, editor with sketch pad, side panel with filter, settings; one undo step each | yes | harness scenario `comments` (tablet and phone, light and dark), `tests/ui-registry.test.ts` | | | |
| Exports: PDF margin notes (optional) and Markdown list | yes | `tests/comments-export.test.ts` | | | |
### 0.18 — a4split: split an infinite page into sheets (steps 1320-1339)

1320. **Offered only when it applies.** Open a notebook with an infinite page, Export. With a PDF or PNG export that includes the infinite page, *Split into sheets* is there; choose *This page* on a normal page, or SVG or Print: it is not.
1321. **Preview.** Turn it on. The preview shows the page with dashed sheets numbered 1, 2, 3 in reading order; the summary says how many sheets and at what percentage. Change paper, orientation, size, margin, overlap: the preview follows.
1322. **PDF.** Export. The PDF has one page per sheet at the paper size, in reading order, numbered "1/N" at the bottom; print it on paper and check margins and that nothing is cut off.
1323. **Cuts between lines.** On a page with many lines of handwriting and a text box, with *Cut between lines* on, no sheet edge goes through a line of writing or the text box; with it off, some do.
1324. **Overlap.** With an overlap, the bottom strip of a sheet is repeated at the top of the next.
1325. **100%.** With *100%*, a wide page makes several columns; sheets read left to right, then the next row.
1326. **Page numbers.** Off: no numbers. PNG: no page-number choice, and one image per sheet (`page-001-part-01.png`…) in the folder; existing files are not replaced.
1327. **Other pages.** Exporting the whole notebook: ordinary pages are one PDF page each, as before.
1328. **Empty sheets.** A page with writing at the top and the bottom and nothing between: the empty sheets in between are left out (and counted in the summary); with the switch off they are kept.
1329. **Tablet.** The dialog scrolls, the preview fits the width, and the choices are easy to reach with the pen.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Split an infinite page into sheets (#178): paper, orientation, scale, margin, overlap, smart cuts, numbers, preview | yes | `tests/export-tiles.test.ts`; harness `a4split-check.ts` | | | split for Print and SVG |
### 0.18 — linkback: copy a page to another notebook with a link back (steps 1360-1379)

Roadmap #186. Reference screenshots after `npm run harness:check`: `dev/harness/dist/shots/design/linkback-*.png`. Use a physics notebook of about 6 pages (one locked) and a smaller revision notebook; keep a copy of the vault first.

1360. **Menu.** In an open notebook the page menu (and the palette) has *Copy to notebook…*; the notebook map's *Select pages* bar has the same button (disabled until a page is ticked). In a read-only notebook it does nothing.
1361. **Dialog.** The page in view is ticked; tick more pages. Search and pick the revision notebook: its page count shows and *Where the copies go* lists *At the start*, *After page N*… and *At the end* (the end is chosen). *Copy* stays off until a page and a notebook are chosen.
1362. **Copy.** Copy two pages after page 1: they appear there in their original order, with their ink, backgrounds and bookmarks; the originals are unchanged. Each copy has a small grey link in the top margin: *Copied from Physics p.N*. Tap it (finger, or Ctrl/Cmd+click): the original page opens.
1363. **Destination open.** Do 1362 with the revision notebook open in another tab: the pages arrive as one undo step there. While you are writing with the pen the operation says it cannot edit right now and nothing changes.
1364. **Link back (setting).** Tick *Also add “Copied to …” to the original pages* (or turn on *Link on the original when copying a page* in Settings > Integration, which only sets the starting tick): the originals get *Copied to Revision p.N*; tap it and the copy opens. One undo in the physics notebook removes all of them.
1365. **Locked.** A locked original is not changed: the notice says how many were skipped. Its copy still gets *Copied from…*, and is locked too.
1366. **Several pages.** From the map, tick four pages: the chips on the copies and the originals show the right numbers (the copies' numbers start where they were inserted).
1367. **Reordering.** Move a copied page in the revision notebook, then tap *Copied to…* on the original: it still opens the copy (the link carries the page id; the number in the label is the one at copy time).
1368. **Copying a copy.** Copy a page that already has a chip: the new copy keeps the old chip and gets a second one under it.
1369. **Failure.** Make the destination unreadable or the vault read-only: the notice says why; the source is unchanged.
1370. **Look.** Light, dark, *Follow Obsidian theme*, tablet and phone: the dialog fits, targets are at least 40 px, the chip is readable but small and does not cover the paper's first line.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Copy to notebook with a link back (#186): dialog (pages, notebook, place), copy through the 0.17 transfer (`copyPagesInto`), a "Copied from" link chip on each copy written in the same write, an optional "Copied to" chip on the unlocked originals as one undoable edit, page menu, command, map selection bar, setting for the starting tick; no format change | yes | chip text, placement and stacking, pairs, locked skipping (`tests/copy-with-link.test.ts`); harness `doc=linkback` (dialog, run on files, undo) | | the chips are ordinary text boxes: a copy of a page keeps them | not tried on the tablet (steps 1360-1370); no "new notebook" destination (use *Extract pages*); chips are not removed when a copy is deleted |

### 0.18 — qr

1380. **Show the code.** Page menu (page thumbnail or page sheet) > *Show QR code*. A dialog shows a large black-on-white code and *Copy link* / *Done*; the code is square and sharp on the tablet and on a phone, in light and dark.
1381. **Scan it.** On a phone or second tablet with the same vault, scan the code with the camera: Obsidian opens, the notebook opens at that page (not another).
1382. **Reorder.** Move the page elsewhere in the notebook, show the code again and scan the old one: it still opens the same page (the link carries the page id).
1383. **Copy link.** *Copy link* shows "Link copied." and pasting gives an `obsidian://notebook?vault=…` link; opening it on this device focuses the notebook tab at the page.
1384. **Long path.** A notebook with a very long path (over about 150 characters) shows a message instead of a code; *Copy link* still works.
1385. **Different vault name.** Scanning on a device where the vault has another name opens nothing wrong: Obsidian says the vault is not found.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Page QR code (#190): dialog, copy link, own encoder (byte mode, level M, v1-10) | yes | encoder, format/version bits and a round trip through a separate decoder (`tests/qr.test.ts`); harness `dev/harness/qr-check.ts` | | | insert the code into the page as a picture |
### 0.18 — pdfannot

1420. **Header action.** Open a PDF in Obsidian's own viewer: a pen icon (*Annotate in Notebook*) is in the view header. Tap it: a new notebook is made from the PDF and opens.
1421. **Existing notebook.** Close the notebook, go back to the PDF and tap the icon again: a dialog offers *Open existing (page N)* (with the notebook name) and *New notebook*. *Open existing* focuses that notebook; *New notebook* makes a second one; Cancel does nothing.
1422. **Viewer page.** Scroll the PDF to page 5 first, then use the action: the notebook (new or existing) opens at page 5 when the viewer's page can be read, otherwise at page 1 (the viewer's internals are not public API).
1423. **Menus.** Right-click a PDF in the file explorer, and use a PDF tab's *More options* menu: both have *Annotate in Notebook* and behave as above.
1424. **Command.** With a PDF tab active, the command *Annotate current PDF in Notebook* is available; with any other tab active it is not.
1425. **Source untouched.** The PDF file's size and modified time do not change; the notebook uses the stored copy in the assets folder.
1426. **Same file elsewhere.** Copy the PDF to another folder: the dialog still finds the notebook (same content). Edit the PDF in another app (different content): it is a new document and no notebook is offered.
1427. **Italian and phone.** Switch to Italian: *Annota in Notebook*, *Apri esistente (pagina N)*, *Nuovo quaderno*. On a phone the dialog fits the screen.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Annotate in Notebook from the PDF viewer (O10): header action, menus, command, open existing vs new, viewer page | yes | search and page choice (`tests/annotate-pdf.test.ts`); harness `dev/harness/annotate-check.ts` | | viewer page and header action rely on Obsidian's PDF view internals, best effort | |
### 0.18 — quicktabs: quick tabs, pages pinned one tap away (steps 1440-1459)

Implemented, not verified on hardware. Reference screenshots after `npm run harness:check` (`HARNESS_DOC=quicktabs`): `dev/harness/dist/shots/` (the strip with four tabs and Back, tablet and phone, dark and light).

1440. **Nothing pinned.** A notebook that has no quick tabs shows no strip. Open the page sheet (tap the page number) and *All actions*: *Pin as quick tab* is there, unchecked.
1441. **Pin.** Tap *Pin as quick tab* on page 2: a slim strip appears under the toolbar with a tab *p. 2*, highlighted because you are on that page. Pin pages 4 and 5 the same way: the tabs are in the order you pinned them.
1442. **Long press on the page number.** Long press (finger or S Pen) the page number in the toolbar: a one-item menu says *Pin as quick tab* (or *Unpin quick tab* on a pinned page). The sheet does not open after the long press. With a mouse, right click does the same.
1443. **Jump and Back.** On page 1 tap the tab *p. 4*: the page shows. A *Back* button appears at the left of the strip; tap it: you are on page 1 again and *Back* is gone. Jump with a tab, then scroll by hand back to the page you left: *Back* disappears by itself.
1444. **Bookmark title.** Give page 3 a bookmark with a title, then pin it: the tab says the title (24 characters at most).
1445. **Reorder by dragging.** Mouse: press a tab and drag it past another one, release: the order changes and stays after closing and opening the notebook. Finger or S Pen: press and hold a tab until it lifts, drag, release. A finger that moves at once scrolls the strip instead (add 12 tabs to try). Drag never opens the tab.
1446. **Menu on a tab.** Right click (mouse) or hold and release without moving (finger, pen) on a tab: *Move earlier*, *Move later*, *Unpin quick tab*. Each works; the first tab cannot move earlier.
1447. **Unpin.** *Unpin quick tab* removes the tab; with no tabs left the strip disappears. The same action on the pinned page (sheet, or long press on the page number) unpins too.
1448. **Another notebook.** In the lecture notebook run *Pin a page from another notebook…*: choose the formula-sheet notebook, then a page number (a wrong number says the valid range). A tab with a book icon and the label *<notebook> p. N* appears. Tap it: the formula-sheet notebook opens at that page; *Back* is in its strip: tap it to return to the lecture page.
1449. **A page that is gone.** Pin page 6, then delete page 6 (or pin a page of another notebook and delete that page there). The tab is drawn dashed; tapping it says the page is no longer in the notebook and shows the nearest page by its old number. Unpin it from its menu.
1450. **Reordered pages.** Pin page 3, then move it to the end with *Move page down* or the page panel: the tab still opens that same page, and a tab without a title now says its new number.
1451. **Rename.** Rename the formula-sheet notebook in the library: the tab that points at it still opens it.
1452. **Collapse.** Tap the pin button at the left of the strip: only a small button with the number of tabs (and *Back* if there is one) remains; tap again to expand. Close and reopen the notebook: the strip is as you left it on this device.
1453. **Phone.** On a phone the strip is tighter and tabs are shorter, long labels end with an ellipsis; nothing overflows the view; the tabs scroll sideways when there are many.
1454. **Short landscape.** Hold the phone sideways (or open the on-screen keyboard on a tablet in landscape): the strip becomes a narrow column beside the page and the page keeps its height. Back to portrait: the strip returns above the page.
1455. **Writing is not disturbed.** With the S Pen write across the page with tabs showing: nothing in the strip reacts; the side-button rules (tap: radial menu, drag: eraser) work as before; a stroke that starts beside the strip is ink.
1456. **Two devices.** On two devices with one vault: pin a page on one; after sync the other shows the tab in the same notebook. Unpin on the second: it disappears on the first. `_meta` holds one `quicktabs-<device>.json` per device and the notebook file was not rewritten by any of it.
1457. **Read-only and locked.** In a read-only notebook, or on a locked page, *Pin as quick tab* still works (pins are not part of the notebook).
1458. **Limit.** Pin 12 pages: the 13th says a notebook has at most 12 quick tabs and nothing is added.
1459. **Italian.** In Italian: *Fissa come scheda rapida*, *Indietro*, *Sposta prima / dopo*, *Rimuovi scheda rapida*, tab *p. N*.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Quick tabs (#227): pin the page in view (page sheet, command, long press on the page number), strip with tabs, tap to jump, Back, collapse, side column on a short view | yes | pure logic (merge, order, resolve) and store: yes; strip: harness (`doc=quicktabs`) | | | |
| Quick tabs: drag to reorder (mouse at once, touch / pen after a long press), Move earlier / later, Unpin | yes | order logic; harness drives the same store calls | | | drag by finger and S Pen on hardware |
| Quick tabs to pages of other notebooks (picker, opens the notebook, follows a rename) | yes | store retarget; harness with a recorded opener | | | |
| Quick tabs storage: per-device `_meta/quicktabs-<device>.json`, latest change wins, tombstones, unknown fields kept, unreadable never overwritten | yes | `tests/quicktabs.test.ts`, `tests/library-check.test.ts` | | | |

### 0.19 — lookup: Look up later list (steps 1540-1559)

Implemented, not verified on hardware. Reference screenshots after `npm run harness:check` (`HARNESS_DOC=lookup`): `dev/harness/dist/shots/` (the word dialog and the sheet with three entries, tablet and phone, dark and light).

1540. **Circle a word.** Lasso a handwritten word on a page. In the selection menu choose *Look up later…*: a small dialog asks for the word (optional). Leave it empty and tap *Add to list*: a notice says it was added to *Look up later*.
1541. **The note.** Open *<notebooks folder>/Look up later.md* (made now if it did not exist): one line `- [ ] ![[… lookup p3-….png|150]] — [[<Notebook>#p3&id=…|<Notebook> p. 3]] (today's date)`, and the picture shows the circled word. Its file is next to your other attachments.
1542. **A typed word.** Do it again on another word and type it: the line has the word between the picture and the dash. Type `*x* [[y]] %% <b>` : it appears as plain text in the note, nothing is bold, linked or hidden.
1543. **Only appended.** Edit the note by hand (a heading, other tasks), then add another entry: the lines you wrote are unchanged and the new line is at the end.
1544. **The sheet.** In the notebook open the page sheet or notebook menu, *Look up later list…*: a row for each entry of this notebook only, with its picture, the word, *p. N*, the date, and a count at the top (*N to look up · M in this notebook*). Entries of other notebooks in the same note are not listed.
1545. **Jump.** Tap a row: the sheet closes and the notebook scrolls to that page. Move pages around first: it still goes to the same page (the link names the page by id). Delete the page: the row says the page is no longer in the notebook.
1546. **Tick off.** In the note change `- [ ]` to `- [x]`; reopen the sheet: that row is dimmed with *done* and the count drops.
1547. **Open the note.** *Open the note* in the sheet opens the list in a new tab; it is disabled while the note does not exist.
1548. **Settings.** In Settings, Integration: *Look up later note* set to `Words/To check` : the next entry goes to `Words/To check.md` (folder and note made). *Look up later picture width* 300: the next picture embed ends `|300]]`.
1549. **Not twice, not lost.** Add two entries in the same second on the same page: both are in the note. A read-only notebook and a page that has a collapsed sticky note: the picture shows only what is visible.
1550. **Sync.** On two devices with one vault: add an entry on each; after sync the note has both lines and each sheet lists them.
1551. **Italian.** In Italian: *Cerca dopo…*, *Elenco Cerca dopo…*, *Parola (facoltativa)*, *Aggiungi all'elenco*.
1552. **Shared-files inbox.** The pictures are not offered by the shared-files inbox.
1553. **A busy shared list.** Add several hundred lines for other notebooks to the list note (for example by copy and paste of a line with a link to another notebook), then add one more entry from this notebook: the sheet still shows the new entry (this notebook's entries are picked across the whole note, the newest 500 are kept).

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Look up later (#213): selection action, crop picture, optional typed word, one appended line in a configurable note (made if missing) | yes | line building, escaping, append and parsing: `tests/look-up.test.ts`; vault write: harness (`doc=lookup`) | | | |
| Look up later list sheet: this notebook's entries read from the note, count, jump to page by id | yes | parsing and filtering: yes; sheet: harness | | | |
| Look up later as a quick pen gesture | no | | | | not added: needs the gesture/input files |

### 0.19 — search: typed text in global search through the companion note (steps 1520-1539)

Needs *Companion notes* on. Not verified on hardware.

1520. Settings › Integration › Companion notes: *Include typed text in search* is listed under the companion settings, off by default; it disappears when Companion notes is off.
1521. In a notebook put a sticky note with text "zebra crossing", a margin comment "check the zebra", an equation `x^2` and a question marker "why zebra". Run *Update all companion notes* with the setting OFF: the companion note has no "zebra" lines.
1522. Turn the setting ON and run *Update all companion notes* again: under `### p. N` there is a link `p. N` and lines starting `sticky:`, `comment:`, `equation:` and `question:`; nothing outside the generated block changed (write text above and below it first, then check it is intact).
1523. Obsidian's global search for "zebra" finds the companion note; clicking the result's link `p. N` opens the notebook at that page.
1524. Type `#tag [[Link]] %% $x$` in a sticky note: after the update the companion shows it as plain text (no tag, no link, no comment, no maths), and the rest of the note below the block still renders.
1525. Put a very long text (more than 4000 characters in total) on one page: the page lists text up to the limit and ends with "(more text on this page is not listed)".
1526. Update again without changing anything: the companion file is not modified (check the modified time); editing a sticky note and waiting a few seconds updates it once.
1527. Switch the setting off and update: the extra lines and wikilinks go back to the previous form; user text outside the block is untouched.
1528. Give a checkbox a label (*Label…*), tick another labelled one, update the companion note with the setting on: the page lists `checkbox: ☐ label` and `checkbox: ☑ label`; a box without a typed label adds nothing.
1529. Type `https://example.com` and `www.example.org` in a sticky note: after the update the companion note shows them as plain text with backslashes in the source, not as clickable links. On a notebook of several hundred pages with long sticky notes on each, the companion note stays at a reasonable size and ends the listing with "(the search text of the following pages is not listed)".

### 0.19 — templates: notebooks from note templates (steps 1640-1659)

Roadmap O13. Needs Templater and the core Templates plugin, and a notebook template named `Lecture` (use *Save as notebook template* on a notebook with two pages and a text box holding `{{date}}`). See `docs/templates.md`. Reference screenshots after `npm run harness:check`: `dev/harness/dist/shots/tplnote-*.png`.

1640. **Button, core Templates.** A template file containing a `notebook-new` block with `name="{{title}} notes"` and `template="Lecture"`. Insert it in a new note called `Optics`: the note shows a card "Optics notes, From the template “Lecture”" with a *Create notebook* button. No notebook exists yet in the library.
1641. **Press it.** Tap *Create notebook*: a notice says it was created, the card is replaced by an embed of `Optics notes.notebook`, and the rest of the note is unchanged (check the Markdown source). The notebook has the template's pages and cover, and the `{{date}}` text is filled in.
1642. **Pages only.** With `content=false` the notebook has the template's empty pages only.
1643. **Templater.** The same block written with `<% tp.file.title %>` expands and behaves the same. A block whose name still shows `{{title}}` or `<% … %>` shows an explanation instead of a button.
1644. **Bad input.** A block with an unknown key, no name, or `open=maybe` shows a message, no button. A `template` that does not exist: the button fails with a notice and creates nothing; the block stays.
1645. **Two identical blocks.** Two identical blocks in one note: pressing the second replaces the second only. Edit the note in another pane so the block is gone before pressing: a notice, nothing created.
1646. **Never automatic.** Opening, reloading, switching between reading view and Live Preview, and printing the note never create anything.
1647. **Templater script.** The `new-notebook.js` user script of `docs/templates.md` inserts `![[….notebook]]`, and the notebook exists, opens, and keeps the template's cover. With a wrong template name the note gets the error text, not a crash.
1648. **Phone.** On Android the card fits the width, the button is a comfortable target, and creating works.
1649. **Look.** Light, dark and *Follow Obsidian theme*: the card reads well beside the note text.
1650. **In the template itself.** Open the template file (the one in the Templates or Templater folder) in reading view: the block shows the card with a note that the button appears in the notes made from the template, and no button. The template file is never changed.
1651. **No second notebook.** Press the button, then make the note read-only or remove it from the vault while it is working (hard to time; or make the notebook open fail): the button does not come back, and if the block could not be replaced a notice shows the `![[….notebook]]` link to paste. Pressing again is not possible.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| `api.newNotebook` (API 1.2) and `template` / `templateContent` options of `createNotebook`: a notebook from a stored notebook template, returning ready `link` and `embed` markup; no format change | yes | option parsing, template picking, link markup (`tests/new-block.test.ts`) | | | the template reading is only covered through the existing template code |
| `notebook-new` code block for core Templates and Templater: parsing, card with a *Create notebook* button (never on render), replacement of exactly that block through `vault.process` | yes | parsing, exact replacement, duplicates, fences (`tests/new-block.test.ts`); harness `doc=tplnote` (card, error card) | | | not tried inside Obsidian (steps 1640-1649) |

### 0.19 — snapshot: automatic snapshot at the end of a lecture (steps 1580-1599)

Implemented, not verified on hardware. Reference screenshots after `npm run harness:check` (`HARNESS_DOC=snapshot`): `dev/harness/dist/shots/` (the history list with the filter chip, tablet and phone, dark and light). Needs a timetable class linked to a notebook (Timetable dialog).

1580. **Lecture ends by the clock.** With lecture mode on during a class, write a few strokes, then wait until the class ends (or use *End lecture* on the chip). Within a moment: *Restore a previous version* lists "Lecture <course> <date> <hh:mm>" with a graduation-cap mark. The file `Notebooks/_backup/history/<id>/<stamp>-lecture.snapshot` exists.
1581. **Nothing written, nothing taken.** Open the notebook during a class, start lecture mode and end it without writing: no new lecture snapshot.
1582. **Closed after writing.** Write during a class, close the notebook tab: a lecture snapshot appears. With lecture mode off in settings (*Automatic lecture mode*), the same happens (the class comes from the timetable).
1583. **Backgrounded.** Write during a class and switch to another app (S Pen tablet): nothing is snapshotted (a switch only saves; it does not end the lecture), and earlier lecture snapshots are not pruned by switching. Leave lecture mode, or close the notebook, or let the class end: now the list has the snapshot, and the daily-note log line is written once (with the lecture log on). Reopen the notebook in the same class, write more and close it again: the log line is updated and a snapshot is added only because the content changed.
1584. **Unchanged is skipped.** Immediately after 1580, write nothing, close and reopen, close again: still one snapshot. Erase a stroke then redo it so the notebook is identical to the snapshot: no new one.
1585. **Filter.** In *Restore a previous version* the chip *Lecture snapshots* appears only when the notebook has one; tap it: only lecture snapshots remain, tap again: all. Ordinary snapshots show just the date.
1586. **Retention.** Set *Lecture snapshots to keep* to 2 and end three lectures with changes between them (move the file-name dates back on a PC to get several): the oldest lecture snapshot goes to the trash; ordinary snapshots stay, whatever *Versions to keep* says.
1587. **Does not touch others.** Put your own `….snapshot` (no `-lecture`) in the folder, and lower the lecture count: it is not trashed. Lowering *Versions to keep* does not trash lecture snapshots.
1588. **Setting off.** Turn off *Snapshot at the end of a lecture*: none is taken; the count setting is hidden.
1589. **Restore.** Restore a lecture snapshot: the usual confirmation, a backup of the current content, the notebook goes back.
1590. **Italian.** In Italian: *Istantanea a fine lezione*, *Istantanee di lezione*, the row reads "Lezione <corso> <data> <ora>".
1591. **Unreadable label file.** Make `lectures.json` invalid on a PC: new lecture snapshots still work (the row shows "Lecture <date> <hh:mm>" without the course) and the file is left as it is.
1592. **Storage cleanup spares the ordinary snapshots.** With more than *Versions to keep* lecture snapshots and a few old ordinary ones in a notebook's history, open *Storage* → backups: the old ordinary snapshots beyond the newest few are offered; the lecture snapshots are never listed (they only follow *Lecture snapshots to keep*).
1593. **Large notebook, version list.** On a notebook with many pages and a dozen or more versions, *Restore a previous version* opens at once; rows show the date and size (no page count). Choosing a copy that is damaged says it cannot be read instead of restoring it.
1594. **Interval snapshot running.** Open a notebook at the end of a class right after the interval snapshot is due: both the ordinary and the lecture snapshot are taken (the lecture one a moment later).

| Feature | Implemented | Automated test | Verified on hardware | Experimental | To do |
|---|---|---|---|---|---|
| Automatic snapshot at the end of a lecture (#222): lecture mode left, class over or notebook closed after writing in a class (one shared end with the lecture log; the app going to the background does not end it); from the saved file after the flush; only if changed | yes | pure decision, names, retention, fingerprint, label file: yes; vault and view wiring: no (needs a real vault and timetable) | | | |
| Lecture snapshots: own retention count, label, "Lecture snapshots" filter in version history | yes | pure logic: yes; list pieces: harness (`doc=snapshot`) | | | |

### 0.20 — groups (groups and locked elements, format v18; steps 1700-1719)

Implemented, not verified on hardware. Reference screenshots after `npm run harness:check` (`HARNESS_DOC=groups`): `dev/harness/dist/shots/groups-*.png` (tablet and phone, light and dark). Notebooks saved with a group or a lock are format v18: 0.19 and older open them read-only.

1700. **Group.** With the lasso select two strokes and a picture (or any element) and tap *Group* in the selection bar. Expected: the selection stays; the bar now offers *Ungroup* instead of *Group*; one undo takes the group away and one redo makes it again.
1701. **A tap picks the group.** Deselect, then tap one grouped picture with the lasso (finger or S Pen): the whole group is selected. Tap one grouped stroke: also the whole group. Tap loose ink: nothing is selected (a tap never selects ink that is not grouped). A lasso that touches only one member selects all of them.
1702. **Move, resize, copy.** Drag, scale and rotate the group: all members move together, one undo step each. Copy and paste, Duplicate and Cut act on all of them; the copies are a new group (select one copy: only the copies are selected, not the originals).
1703. **Ungroup.** With a group selected tap *Ungroup*: each member can be selected alone again; one undo makes the group again.
1704. **Erase a member.** Erase one stroke of a group with the eraser, save, close and reopen the notebook: the other members are still selected together; erase all but one member: the last one is a normal item again (no group, no error, the notebook saves).
1705. **Lock.** Select a picture and tap *Lock*. Expected: a notice says it is locked, the selection is dropped. A lasso over the picture, a tap on it and the area eraser (set to erase pictures and text as well) do not pick, move or erase it. Ink written over it still works and can be erased. One undo unlocks it.
1706. **The chip.** With the lasso tap the locked picture: nothing is selected and a small *Locked · Unlock* chip appears next to the finger for about five seconds. Tap *Unlock*: the picture is unlocked (one undo step) and can be selected again. With the text tool a tap on a locked text box does not edit it and shows the same chip.
1707. **Locked elements….** Lock two elements, open the page menu (tap the page number) > *Locked elements…*: a list with the kind and text of each. Tap a name: the page scrolls to it and the list closes. *Unlock* on a row unlocks that one and the list redraws; *Unlock all* unlocks the rest. The entry is not there when nothing is locked.
1708. **A lock inside a group.** Group a picture with some ink, then lock the picture. A lasso over the group selects the ink only (the locked picture is left out and stays where it is when the ink is moved).
1709. **Page lock on top.** Lock the page (page menu > *Lock page*): *Group*, *Ungroup* and *Lock* are refused with the *Page locked* notice; selecting still works for copying.
1710. **Copies and templates.** Duplicate a page that has a group and a locked picture: the copy has a group of its own (select a member: only the copy is selected) and the picture is locked too. Save the notebook as a template and make a notebook from it: groups and locks are there.
1711. **Move to another page.** Select a group and use *Move to page…*: the whole group arrives and is still a group (a locked picture is not part of the selection, so it stays on its page).
1712. **Two devices.** Lock a picture on one device and, without syncing, group two strokes on the other; sync so a conflicted copy appears and *Merge conflicted copies*: the picture is there once and locked, the strokes are grouped, the summary counts them. Unlock on one device (later) and merge an older copy that still has the lock: it stays unlocked.
1713. **An older plugin.** Copy a notebook with a group or a lock to a device with 0.19: it opens read-only with the "newer version" message and is not rewritten.
1714. **Undo across the steps.** Group, lock, ungroup and unlock in turn, then undo all of it and redo all of it: the page ends where it was each time, with no duplicated element.
1715. **A large notebook.** Open a notebook of several thousand strokes with a few groups and locks: it opens page by page as before and the groups and locks are there.
1716. **Italian, dark, phone.** The bar, the chip, the list and the notices read in Italian; the chip and the list are readable in light, dark and with *Follow Obsidian theme*; on a phone the chip stays inside the view and its *Unlock* button is a comfortable target.
1717. **A group across the seam.** With two pages in view lasso a group that is on one page and drag part of it over the other. Expected: the members that arrive on the other page together are a group there (a tap selects just them), a member that arrives alone is a normal stroke, and the members left behind are still a group while two or more remain. One undo puts everything back.
1718. **Split page.** On a heavy page with a group that crosses the middle and a locked picture in the lower half, tap *Split page*. Expected: the group is whole on one page (not half and half), the locked picture stays on the original page, and when only locked elements are below the cut the notice says the page cannot be split.
1719. **Locked marker, box, equation.** Lock a marker (homework), a structured box and an equation, then tap the marker, tap the box label and double-tap the equation: no editor opens (so no Delete either) and a notice says the element is locked; unlock it and the editor opens again.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Groups and locked elements (#39, format v18): `group` on strokes and elements, `locked` and `lockAt` on elements; v17 to v18 migration (the keys are dropped from a v17 file, large v17 files still stage), lenient read (a lone member is released and counted) and strict write (a group of fewer than two is not written), repair, copies and templates (fresh group ids, locks kept), merge (groups united by id, later lock decision wins, a tie keeps the lock), page-lock guard, history (`UpdateItems`, one undo step, `remap`) | yes | `tests/model-v18.test.ts` | | | |
| Selection: picking a member picks the group (strokes and elements, ink in view only), the lasso, a tap and the area eraser skip a locked element, a locked element is never selected | yes | `tests/model-v18.test.ts` (pure parts); harness scenario `groups` (view) | | | tap and lasso with the S Pen on hardware |
| Groups across pages and in *Split page*, locked marker/box/equation editors, merge batches and lone joins, tool selections completed to groups, pieces of cut ink (review fixes) | yes | `tests/groups-review-fixes.test.ts` | | | cross-page drag and Split page with the S Pen on hardware |
| Groups UI: *Group*, *Ungroup*, *Lock* on the selection bar, the *Locked · Unlock* chip, *Locked elements…* in the page menu | yes | harness scenario `groups` (tablet and phone, light and dark); `tests/ui-registry.test.ts` | | | |

### 0.20 — vdiff: visual version diff (steps 1840-1859)

Implemented, not verified on hardware. Reference screenshots after `npm run harness:check` (`doc=vdiff`): `dev/harness/dist/shots/` (the dialog on the modified page in the overlay view, tablet and phone, dark and light). Needs a notebook with at least one version in its history (*Version history interval* set to 1 and a day of editing, or a `.snapshot` copied into `Notebooks/_backup/history/<id>/`).

1840. **Compare with the current notebook.** Open a notebook that has a previous version, run *Compare this notebook with a previous version* (or *Compare with a previous version…* in the page sheet), choose a version. The dialog opens on the page in view when it differs, else on the first changed page. The summary counts pages (added, removed, modified, unchanged) and ink and elements (added, removed, changed, moved).
1841. **Colours.** On a page where you added a stroke, erased one, moved a text box and recoloured a stroke: *Overlay* shows the new ink tinted green, the erased ink ghosted in red, and the moved or recoloured items outlined in amber (a moved item also has a dashed outline where it was). *Before* shows the old page with the removed ink in red; *After* shows the current page with the added ink in green. The legend under the page title names the three colours.
1842. **Page list.** The list shows the changed pages by default (*Changed · n*), each with a dot (green added, red removed, amber modified), its status and counts (+added −removed ~changed). A page deleted since the version reads "Was page n". *All pages* lists every page; the selected page keeps its place when the filter changes. A page that only changed place is marked *Moved*.
1843. **Navigation.** The arrows beside the page title jump to the previous or next changed page and are disabled at the ends. Tapping a row selects it. On a phone the list sits above the page.
1844. **Two versions.** Run *Compare two previous versions*, choose two versions in either order: the earlier one is *Before*, the later one *After*. Neither the notebook nor the files change.
1845. **Restore this page.** On a modified page choose *Restore this page from <date>* and confirm: the page is replaced by the old one (same page id, so bookmarks and links keep working) as one undo step; undo brings back the current page. On a page that was deleted since, the button inserts it again after the page before it. On a page that did not exist in the version, the button is disabled.
1846. **Locked page.** Lock a page and try to restore it from the dialog: the notice says to unlock it first and nothing changes.
1847. **Two-version restore.** With two old versions open, the button names the version on show: *Before* and *Overlay* use the earlier one, *After* the later one.
1848. **Read-only.** Open the dialog and close it without pressing restore, with the notebook open and edited: no new undo step, nothing is saved, no file changes.
1849. **Large notebook.** On a notebook with hundreds of pages, the dialog opens at once; if the notebook is very large the summary says some pages were not compared and those rows read *Not compared*. Switching pages draws one page at a time.
1850. **Other differences.** Change a page's paper, add a tag or a margin comment and compare: the page is listed as modified with "Also differs: paper, tags, comments".
1851. **Preview limits.** A page with a PDF background or a picture: the preview draws the ink, boxes and text without the PDF or picture (the note under the dialog says so); a changed picture is outlined.
1852. **Italian.** In Italian the dialog reads *Confronta versioni*, *Prima* / *Sovrapposto* / *Dopo*, *Ripristina questa pagina del <data>*.
1853. **Unreadable or other notebook's version.** Choose a damaged copy or a snapshot of another notebook: a notice says so and no dialog opens.

| Feature | Implemented | Automated test | Verified on hardware | Experimental | To do |
|---|---|---|---|---|---|
| Visual version diff (#121): compare the open notebook with a snapshot or backup, or two versions; read-only dialog with a page list (added / removed / modified / moved pages, counts), before / overlay / after views, green / red / amber marks, restore this page through the page-restore path (History, lock respected, confirmation) | yes | pure diff by ids (pages, strokes, elements, moved vs changed, reorder, cap), marks per view, restore planning and undo (`tests/version-diff.test.ts`, `tests/diff-render.test.ts`, `tests/diff-restore.test.ts`); dialog: harness (`doc=vdiff`) | | | PDF and picture backgrounds are not drawn in the preview |

### 0.20 — headings: headings from the size of the handwriting (steps 1780-1799)

Implemented, not verified on hardware. The thresholds are tuned on synthetic writing; real handwriting is what these steps check. Reference screenshots after `npm run harness:check` (`doc=headings`): `dev/harness/dist/shots/` (the notebook map with the Titles filter and the title strips, tablet and phone, dark and light).

1780. **Large title.** On a page of ordinary notes (three or four lines) write a title about twice to three times as tall as the text, on its own line at the left. Open the outline (page panel). Expected: a row with a picture of the title and the page number; a title about three times the size is the top level, one about twice the size is nested under it.
1781. **Jump to the line.** On a long page with the heading far down, tap its row in the outline. Expected: the notebook scrolls to the heading itself (a little above it), not only to the top of the page.
1782. **Underlined line.** Write a line only slightly larger than the text (about 1.3 times) and draw a straight line under it with the pen. Expected: it appears as a heading (second level). The same line without the underline does not, and an underlined line of ordinary size does not either.
1783. **Tilted writing.** Write a heading on a slant (about 10 degrees) with a slanted underline. Expected: it is found; a slanted line of ordinary text is not.
1784. **Drawings are not titles.** Draw a large circle, a framed box and a big arrow among the notes. Expected: none appears as a heading. A highlighter stroke never does.
1785. **Notebook map.** Open the notebook map. Expected: a *Titles* chip with the number of pages that have headings; cards of those pages show the picture of up to two headings under the thumbnail. Tap the chip: only those pages remain; tap it again: all.
1786. **Tap a strip.** Tap a heading picture on a card of the map. Expected: the map closes and the notebook shows that heading. Tap the card elsewhere: it goes to the page as before. In the map's selection mode a strip does nothing.
1787. **Switch.** Settings, Pages, Outline, *Large handwriting as headings* off: no heading rows in the outline and no Titles chip or strips in the map.
1788. **Speed while writing.** On a notebook of dozens of full pages, write quickly with the S Pen. Expected: no stutter and no lag in the stroke; the analysis runs after a pause of a few seconds (it waits while the pen is on the screen). Open the outline after writing: the headings are there at once.
1789. **Edits follow.** Rewrite the title larger or smaller, or erase it: the outline and the map follow within a moment of reopening them. Undo and redo bring the heading back; the picture is redrawn only when the ink changed.
1790. **Companion pictures (off by default).** With *Companion notes* on, open the companion note: no pictures. Turn on *Headings as pictures* (Settings, Integration, under Companion notes). Expected, after the next update (*Update all companion notes* or a moment after writing): in the note, under the `### p. N` heading of each page that has headings, lines `- heading: ![[…]]` showing the picture of the heading at about 220 px; the pictures are in the folder `<Notebook> (Headings)` beside the notebook, named `p3-h1.png`.
1791. **Companion stays stable.** Run the update again without writing: the note is not rewritten and the pictures are not rewritten. Change a heading: only that picture changes.
1792. **Companion respects the pen.** With the pen down, the companion does not draw pictures (it waits for a pause).
1793. **Companion off again.** Turn the setting off: the `- heading:` lines go from the note at the next update; the picture files stay in their folder (the plugin never deletes them).
1794. **Italian.** In Italian: *Titoli* chip in the map, *Titoli come immagini* in the settings, *Vai al titolo a pagina N* as the strip's label.
1795. **Heavy page.** A page with a very large number of strokes (thousands) is not searched for headings and the outline stays quick.

| Feature | Implemented | Automated test | Verified on hardware | Experimental | To do |
|---|---|---|---|---|---|
| Headings from the size of the handwriting (roadmap #102, 0.20 headings): lines written clearly larger than the page's usual letters (1.7x level 2, 2.4x level 1), or only 1.25x when underlined by a straight stroke under them (slanted lines too), listed in the outline and in the notebook map (Titles filter and picture strips, jump to the line); no OCR, no format change | yes | pure analysis: yes (`tests/headings-w20.test.ts`, `tests/outline-builder.test.ts`: sizes, levels, underlines, tilted writing, drawings, highlighter, invisible ink); view: harness (`doc=headings`) | | yes (thresholds tuned on synthetic writing) | colour is not used |
| Heading analysis cache and idle work: per page, keyed by a fingerprint of the page's content (rebuilt strokes with the same content are not analysed again), analysed in 8 ms slices at idle moments and not while the pen is down | yes | yes (`tests/headings-w20.test.ts`: fingerprint, caching, slices, heavy pages) | | | |
| Headings as pictures in the companion note (#102, setting *Headings as pictures*, off by default): `- heading: ![[…]]` under the page heading, pictures in `<Notebook> (Headings)` named by page and position, marked with the ink they show (a PNG text chunk: same mark left alone, another mark redrawn, no mark = the user's file, never overwritten, next free name), never deleted; up to 4 per page and 60 per notebook | yes | text: yes (`tests/headings-companion-w20.test.ts`); marks, name choice, per-notebook cache: `tests/review-w20-data.test.ts`; a picture the user edited (marks kept, pixels changed) is not rewritten: `tests/review-w20-round2.test.ts`; vault writes: not tested (need Obsidian) | | | |

### 0.20 — planner: planner generator (steps 1820-1839)

Roadmap #118. Implemented, not verified on hardware. Reference screenshots after `npm run harness:check` (`HARNESS_DOC=planner`): `dev/harness/dist/shots/design/planner-{dialog,large,pages}-{light,dark}-{tablet,phone}.png` (the Planner tab, the tab with daily pages on and the large-notebook warning, and the year, month, week and day pages as drawn by the thumbnail renderer).

1820. **The tab.** Open the creation dialog (*New notebook*) and tap *Planner*. The name is already "Planner" and the current year, the form has year, calendar or academic year, a start month, language, week start, page size, orientation and five section chips. Left and right arrows on the tab row move through Notebook, Planner and Folder.
1821. **Page count.** With the defaults (year, months, weeks, notes) the dialog says 72 pages. Switch on *Daily pages*: it says 437 pages (366 in a leap year) and a note says it is a large notebook. Switch every section off: it asks you to pick one, and *Create planner* does nothing but move to the chips.
1822. **Year field.** Type 1800 or 12: an inline error, and *Create planner* focuses the field. Change the year: the suggested name follows; type a name of your own first and it stays.
1823. **Academic year.** Tap *Academic year*: the start month becomes September and the name becomes "Planner 2026-2027". Create it: the first month page is September, the last is August of the next year, and the year page title reads 2026–2027.
1824. **Create and open.** Create a calendar-year planner. It opens on the year page: twelve mini calendars with the weekday letters, weekends in grey, and a month link under each month name. The outline (bookmarks) lists the year, each month and Notes.
1825. **Links down.** Tap a month link on the year page: the month calendar opens (grid paper, one cell per day, the day numbers typed in the cells). Its *Weeks* list links to the weeks. Tap a week: the weekly planner page with a box per day, each day label a link. Tap a day: the daily planner page with the date as the title and hours down the left.
1826. **Links up.** On the day page tap *‹ Week*, then *‹ Month*, then *‹ Year*: each goes back one level. A page link shows its text (the brackets and the notebook name); that is how links written in text boxes look.
1827. **Links survive moves.** Insert a blank page in the middle of the planner and tap links again: they still open the right pages (the links name pages by id).
1828. **Week start.** Make a planner with *Sunday*: month columns start on Sunday, week pages start on Sunday and week numbers follow the January 1st rule; with *Monday* they are ISO weeks. In *Settings > Writing > Planner week starts on* choose Sunday, close and reopen the dialog: Sunday is selected.
1829. **Italian.** Choose *Italiano*: month names, weekdays and the titles ("Settimana 11", "Giovedì 12 marzo 2026", "Note") are Italian, and the interface language does not change.
1830. **Sizes.** Make planners in A5 portrait, A4 landscape and a custom size: nothing is cut off at the page edge and the month grid still has seven columns across the page. In landscape the links of a month sit to the right of the grid.
1831. **Writing on it.** Write with the pen on a month cell, a week box and the day schedule: ink goes where you write, the pen never selects a date, and the rules do not move.
1832. **Big one.** Make a planner with daily pages (about 437 pages): the dialog stays responsive, the notebook is created and opens, scrolling the pages panel is smooth, and closing and reopening it loses nothing.
1833. **Name taken.** Name a planner like an existing notebook: the usual inline error. If another file of the vault has the same name in another folder, the links use the full path and still open the right notebook.
1834. **Phone.** On a phone the three tabs fit the header, the section chips wrap, and the form scrolls under the preview.
1835. **Look.** Light, dark and *Follow Obsidian theme*: the Planner tab reads well; the generated pages are always light paper.
1836. **Rename.** Rename the planner notebook in the library: the links inside it still need the new name (use *Update links* from the notebook menu if it offers it); note which happens.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Calendar math: leap years, month lengths, day numbers, weekday, ISO week and Sunday-start week numbers, week lists, month rows, calendar and academic ranges, week start from the locale | yes | `tests/calendar.test.ts` (checked against `Date` over a leap year and sampled over 1900-2200) | | | |
| Planner generator: year, month, week, day and notes pages on existing papers and text boxes, page links by id up and down, outline bookmarks, English and Italian, Monday or Sunday weeks, page counts, bounds on every size and orientation, document write and read back | yes | `tests/planner.test.ts`; link labels on the page and in exports: `tests/review-w20-data.test.ts` | | | links show only their label (alias or short name), as links; not tried inside Obsidian (steps 1820-1836) |
| Planner tab of the creation dialog (year, span, start month, language, week start, size, section chips, page count and large warning) and the setting *Planner week starts on* | yes | harness `doc=planner` (tab, chips, counts, creating and reading back) | | | not tried on a phone (step 1834) |

### 0.20 — dropfiles

Manual steps (hardware / real Obsidian; nothing here is verified on Android).

1740. **Picture from the desktop.** On Windows, drag a PNG from File Explorer onto a page of an open notebook: a dashed frame and a chip "Drop to add to page N" show while dragging, with a ring under the pointer; dropping places the picture centred on the pointer, selected. One undo removes it (and its place in the page).
1741. **Several files.** Drop three pictures at once: they land in a cascade (each a step down and to the right), all selected; one undo removes all three.
1742. **Wrong files.** Drop a `.zip` and a PNG together: the PNG is placed and one notice names the zip ("Not added: 1 of an unsupported type…"). Drop only a zip: only the notice.
1743. **Too large / HEIC.** Drop a picture over 50 MB, and a `.heic` photo: each is named in the notice, nothing is stored for them.
1744. **Locked page, read-only.** On a locked page the frame is grey with the lock and the drop adds nothing ("Page N is locked"). In a read-only notebook (newer format, hidden annotations) the frame says it is read-only.
1745. **PDF choices.** Drop a PDF: the dialog offers *Insert pages after this one*, *Insert as images on this page* and *Annotate in a new notebook*. Pages: the usual range and layout questions, then the pages appear after the page you dropped on. Images: the first pages (at most 8) are placed as pictures in a cascade, one undo step. Annotate: the import dialog (file from the desktop) opens.
1746. **Explorer drag.** Drag a PNG and a PDF from Obsidian's file explorer onto a page (side by side layout): the picture is placed; the PDF asks as above. The vault file is unchanged.
1747. **Note as link.** Drag a Markdown note from the explorer onto a page: a text box showing the note's name as a link appears at the drop point (the raw `[[Note]]` shows only while editing the box); tapping it opens the note. Also: drop a PDF, choose *Insert as images*, cancel the page range: the assets folder has no new file (a PDF is never stored by this choice).
1748. **Between pages and zoom.** Zoom in, pan, drop between two pages and on the second page: the picture lands on the nearest/the right page at the pointer, not offset by the zoom.
1749. **Pen unaffected.** Writing and S Pen button gestures behave exactly as before; a drag of text (from a browser) over the page shows no frame.
1750. **Italian.** In Italian: "Rilascia per aggiungere alla pagina N", the PDF dialog and the notice are translated.

| Feature | Implemented | Automated test | Verified on hardware | Experimental | To do |
|---|---|---|---|---|---|
| Drag files onto a page (#79): pictures at the drop point (cascade), PDF choice (pages / images / annotate), explorer files, note links, frame, one notice for what is left out | yes | type routing, caps, cascade, page-coordinate mapping: yes; write-after-commit and rollback of created files: `tests/review-w20-data.test.ts`; selecting after the commit can never trash the files: `tests/review-w20-round2.test.ts`; view wiring: harness (`doc=dropfiles`) with synthetic DragEvents; explorer drag (`app.dragManager`, not public API) and Android: no | | yes (explorer drag relies on an internal Obsidian field) | |

### 0.20 — share: Share page… (steps 1720-1739)

Quick share of a page as PNG or PDF (#30). Implemented, **the system share sheet needs hardware verification** (it only exists in the Android WebView / Chrome; the harness replaces `navigator.share` with a recorder). Reference screenshots after `npm run harness:check` (`HARNESS_DOC=share`): `dev/harness/dist/shots/` (the dialog on *Some pages*, tablet and phone, dark and light).

1720. **From the page menu.** Open the page sheet of a page and choose *Share page…* (also in the command palette): a dialog with *What to share* (Page N, Some pages…), *Format* (PNG image, PDF), *Clean copy*, and a button *Share* on a tablet that can share files.
1721. **PNG through the share sheet.** Choose PNG and tap *Share*: the Android share sheet opens with one image named "<notebook> p3.png". Send it to an app (Gmail, Drive, Messages): the picture is the page as in *Export…* (paper, ink, pictures, equations, header). Nothing new appears in the vault.
1722. **PDF through the share sheet.** Choose PDF and share: one "<notebook> p3.pdf" opens in the receiving app with the page.
1723. **Closing the share sheet.** Open the share sheet and dismiss it (back, or tap outside): no notice, no file in the vault.
1724. **Some pages.** *Some pages…* with "1-3, 5" and PDF: one PDF named "<notebook> p1-3+5.pdf" with those pages. With PNG: one image per page ("p1.png"…), all offered in the same share sheet. More than 10 pages as PNG are refused with a sentence that suggests PDF; an empty or wrong range is refused with the usual range sentence.
1725. **Selection.** Select something with the lasso: the selection menu has *Share selection…*; the dialog opens on *The selection (page N)*, the format is not asked, and the shared PNG is the region around the selection (with a little margin), named "<notebook> p3 selection.png". From the page menu of the same page the dialog also offers the selection; from another page it does not.
1726. **Clean copy.** With *Clean copy* on, markers, margin comments and collapsed sticky notes are missing from the shared image or PDF (as in step 1621); with it off they are there. Nothing changes in the notebook.
1727. **Slow draw.** Share a PDF of many pages with a PDF background (drawing takes a few seconds): if Android refuses the share because the tap is too old, a notice "Ready to share." with a *Share* button appears; tapping it opens the share sheet with the same file. No second drawing.
1728. **Large file.** Share a PDF bigger than 25 MB (many pages with large pictures): a notice warns about the size; the share still goes ahead.
1729. **No file sharing (desktop).** On Windows (or in a browser without file sharing) the button reads *Save a copy*; it saves "Maths (PNG)/page-003.png" (images) or "<notebook> p3.pdf" next to the notebook, with the export naming (" 2" if taken), and a notice with *Open* (opens the file in Obsidian) and, for one image, *Copy image* (the image is on the clipboard: paste it into a chat or a document). A name that exists is never overwritten.
1730. **Share sheet refuses.** If the share sheet fails with an error other than closing it, a copy is saved as in 1729 and the notice says the share sheet failed.
1731. **Remembered.** Choose PDF with *Clean copy* on, share, open the dialog again: the same format and switch are set (per device; another device keeps its own). A remembered "selection" with nothing selected opens on the page.
1732. **Read-only mode and locked pages.** In read-only mode and on a locked page *Share page…* works (it only reads).
1733. **Italian.** In Italian: *Condividi pagina…*, *Condividi selezione…*, *Salva una copia*, *Copia immagine*.
1734. **Notebook unchanged.** After any of the above the notebook file and the undo history are unchanged.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Share page… / Share selection… (#30): PNG or PDF of the page, the selection or some pages, drawn by the export pipeline (clean copy supported), handed to `navigator.share({ files })` | yes | choice/plan/names/canShare decision/size/error reading/local storage: `tests/share-page.test.ts`; dialog and both branches with a stubbed `navigator.share`: harness (`doc=share`) | | | the real Android share sheet (and its tap-too-old rule, step 1727) is untested |
| Share fallback: copy saved in the vault with the export names, notice with Open and Copy image (PNG) | yes | harness (`doc=share`, saved path and notice) | | | "Open folder" is "Open" (the file): Obsidian has no public API to reveal a folder on Android |

### 0.20 — ghostlines: ghost guide lines on blank paper (steps 1760-1779)

Ghost guide lines (roadmap #94). Settings, Writing: *Ghost guide lines* (off / while writing / always on blank paper) and *Guide spacing* (auto, or 6-10 mm). Use a notebook with a blank page. Implemented, not verified on hardware.

1760. **Off by default.** Write a line of text on a blank page: no guides appear. The *Guide spacing* row is hidden while the setting is off.
1761. **While writing.** Choose *While writing*. Write a first line of at least four or five letters/words: after the stroke ends, two faint dashed lines appear, the baseline of what you wrote and the next one below it (the next one a little stronger). A single stroke or a drawing does not show them.
1762. **Fade.** Stop writing: after about a second and a half the guides fade out over a moment. Start another stroke before that: they stay and the wait starts again.
1763. **Next line.** Write a second line: the guides follow your last complete line; the spacing between them matches the distance between your two lines (auto).
1764. **Tilt.** Write a line that slopes slightly upward: the guides slope with it. A line sloping more than about 12 degrees is treated as flat.
1765. **Drawing.** Draw a big shape (a circle, a diagram) among the text: it does not move the guides.
1766. **Fixed spacing.** Set *Guide spacing* to 8 mm: the distance between the two guides is 8 mm whatever your writing size.
1767. **Always.** Choose *Always on blank paper*: the guides stay after a pause (they update with each stroke). They are not there before you have written a first line.
1768. **Other paper.** On ruled, grid or dotted paper no guides are drawn. Switching a page to blank paper and writing shows them.
1769. **Overlay only.** Undo/redo removes the guides; they are not in the saved notebook, a PDF/PNG/SVG export or Print, and the file is unchanged by them.
1770. **Night and zoom.** In night mode they are light grey; zoomed in or out they stay one pixel wide; writing stays smooth (no extra lag).

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Ghost guide lines on blank paper (#94): baseline and next line inferred from the newest strokes, faint dashed overlay on the live layer, off / while writing / always, auto or fixed spacing, never saved or exported | yes | inference (baseline, line height, tilt tolerance, descenders, drawings as outliers, fallback to the last complete line, fixed spacing), segments, fade, settings: `tests/ghost-lines.test.ts`; harness `doc=ghostlines` | | | not tried with a real hand on a tablet; the thresholds (tilt 12 degrees, spacing from stroke height) are a guess |

### 0.21 — pagetime (start and end time of a page, format v19; steps 2000-2019)

Implemented, not verified on hardware. Reference screenshots after `npm run harness:check` (`HARNESS_DOC=pagetime`): `dev/harness/dist/shots/pagetime-*.png` (tablet and phone, light and dark). Notebooks saved by this version are format v19: 0.20 and older open them read-only.

2000. **A fresh page has no times.** Open a notebook made with an older version (or a new blank page), tap the page number > *Page information*: *Page started* says *Not recorded yet*.
2001. **The first stroke starts the page.** Write one word. Open *Page information*: *Page started* and *Page last written* show the time you wrote it (the same minute).
2002. **Later writing moves only the end.** Wait a few minutes, write another word, add a text box or a picture: *Page started* is unchanged, *Page last written* moves to now.
2003. **Undo leaves the times.** Undo the last stroke twice: the ink goes (two steps, no extra step for the times) and the times in the information are unchanged. Redo: still unchanged.
2004. **Erasing does not stamp.** Erase a word, move an object on the page, change the paper: *Page last written* does not move.
2005. **The header line.** Settings > Pages > Header: choose *Header*. Pages that have times show them after the page number (`3 / 12 · 3 Jun 14:05 – 15:20`); a page without times shows only the number. Turn *Show when a page was written* off: the times go from the line.
2006. **The notebook map.** Open the notebook map: a card of a written page shows the times under its thumbnail; a long press or hover shows them in the tooltip (with the question or homework line if any). With the setting off the card shows nothing extra. A page without times has no line.
2007. **Duplicate and template.** Duplicate a written page: the copy has no times (*Not recorded yet*) until you write on it. Save the notebook as a template and make a notebook from it: no page has times.
2008. **Move keeps them.** Move a written page to another notebook (*Move pages*): in the other notebook its information shows the same times. *Copy* instead of move: the copy has none. Delete a page, restore it from the page trash: the times are back.
2009. **Restore a version.** Restore an older version of a written page over it: the times still cover the whole span (earliest start, latest end).
2010. **Two devices.** On two devices write on the same page without syncing, then *Merge conflicted copies*: the page's start is the earlier of the two and its end the later; the merge does not stamp the time of the merge. Undo the merge: the times are back to what they were.
2011. **An older plugin.** Copy a notebook written with this version to a device with 0.20: it opens read-only with the "newer version" message and is not rewritten.
2012. **An older notebook.** Open a notebook written with 0.20 (format v18): it opens, nothing is reported as repaired, no page has times; write on one page and only that page gets times.
2013. **A large notebook.** Open a notebook of several thousand strokes: it opens page by page as before; the times of written pages are there.
2014. **Read-only and locked pages.** In read-only mode nothing is stamped. On a locked page nothing can be added, so the times do not move; the information still shows them.
2015. **Italian, dark, phone.** The labels (*Pagina iniziata*, *Ultima scrittura della pagina*, *Scritta …*) read in Italian; the line on the map card is readable in light and dark and does not overflow a narrow card.
2016. **API.** Add an element to a page of a closed notebook through the API (`docs/api.md`): that page gets times from the time of the call.
2017. **Recovery.** Damage a notebook file (cut it) and run *Repair*: the times of the salvaged pages are kept.
2018. **Text edits and moved ink (review fix P4).** On a written page wait a minute, then type more text into an existing text box: *Page last written* moves to now. Move or recolour that box: it does not move. Select ink on page 2 (which has times) and move it to page 3: page 3's times do not change (page 2 keeps its own). Copy the selection to page 3 instead: page 3 is stamped, it is new ink.
2019. **Merge then write then undo (review fix P1).** Merge a conflicted copy that widens a page's span, write a stroke, then Undo twice and Redo twice: the stroke is back and *Page last written* is still at or after the time you wrote it. A copy that differs only by a page's span shows *Merge* with the line *1 page times widened to the copy's* (not "nothing to merge").

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Page start and end time (#217, format v19): `startAt` / `endAt` on pages, stamped by the history after an added stroke or element or a text edit (no undo step, errors logged; clock window 2015-2100; ink moved in from another page or made from an equation does not stamp; the merge's times undo only while unchanged and redo widens; a times-only difference is a mergeable change; review fixes P1-P6), v18 to v19 migration, lenient read and strict write, staged loading, repair, copies (duplicate and template clear, move and trash keep), merge (earliest start, latest end), closed-notebook edit | yes | `tests/model-v19.test.ts`; harness `doc=pagetime` | | | not tried on a tablet; audio (M5) does not use the times yet |
| Showing the times: header line, notebook map card (tooltip, label, line), page information, setting *Show when a page was written* | yes | `tests/model-v19.test.ts` (text, header, info); harness `doc=pagetime` (tablet and phone, light and dark) | | | |

### 0.21 — carry: 0.20 review carry-over fixes (steps 2020-2039)

Manual steps (real Obsidian; nothing here is verified on Android).

2020. **Drop survives a late failure.** Drop a picture onto a page: the picture is placed, selected and one undo removes it; the file stays in `_assets` after save (nothing is trashed).
2021. **Edited heading picture.** With *Headings as pictures* on, open a heading picture of the `(Headings)` folder in an image editor and change only its gamma or colour profile, save, then change that heading's ink and update the companion note: the edited file is left as it is and the new picture takes the next free name (`p3-h1 2.png`).
2022. **Picture from 0.20.** A `(Headings)` picture written by 0.20 and not edited is rewritten in place when its heading changes (no extra numbered copy).
2023. **Names run out.** Put 24 edited copies (`p3-h1.png`, `p3-h1 2.png`, ...) in the folder, change the heading and update: the companion note keeps linking to the previous picture and one notice explains why (once per session).
2024. **Reference window keeps its page.** Open a reference window on page 6 of notebook B, then open notebook C in the pane that lent B: the window stays on page 6 of B (page 1 only if B has fewer pages), also after resizing it.
2025. **File replaced under a rewrite.** (Hard to time by hand.) Sync or replace a heading picture just as the companion note updates: the replaced file is not overwritten.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Drop: steps after the recorded History step cannot fail the edit (R1) | yes | `executeThenSettle` with a throwing step: yes (`tests/carry-review-w20.test.ts`) | | | |
| Heading picture checksum over every chunk but text/time, 0.20 pictures still recognised (R2) | yes | yes | | | |
| Heading picture names: 24, then the previous picture stays linked with one notice (R3) | yes | plan logic: yes; notice: no | | | |
| Reference window keeps its page when the lending pane changes notebook (R4) | yes | index rule: yes; window: no | | | |
| Heading picture rewrite re-checks size and time right before the write (R5) | yes | fake vault: yes | | | |

### 0.21 — schema: documented format with a JSON Schema (steps 1860-1879)

Documented format (roadmap #167). There is no new screen: `docs/schema/notebook-v22.schema.json` and `docs/format.md` describe the `.notebook` file for other tools. Implemented, not verified on hardware.

1860. **Schema agrees with a real notebook.** Copy a notebook written on the tablet (with ink, a picture, a text box and a comment) to a PC and validate it with any draft 2020-12 validator (see the end of `docs/format.md`): no errors.
1861. **Old file.** Open a notebook that was last saved by an older plugin version and edit it once, then validate it: it validates after that save (the file is rewritten as version 19 on the first edit).
1862. **Guide.** Read `docs/format.md`: the file layout, the units, the list of elements and the folders `_assets` and `_meta` match what you see in the vault.
1863. **Example.** Save the minimal example of `docs/format.md` as `Example.notebook` in the notebooks folder and open it: it opens, shows the text box and one pen stroke, and does not report a problem.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| JSON Schema of the document format v19 (#167) and the guide `docs/format.md` for third-party tools | yes | serializer output (new notebook, generated ink, a document with all nine element types and every optional field, a read and write round trip) validates against the schema; about 90 invalid documents (one broken rule each) are refused; the example of the guide validates and is read by the plugin: `tests/format-schema.test.ts` | | | rules a schema cannot express (unique ids, references, groups of two) are only described in the guide; the schema must be updated by hand when the format changes (the test fails until it is) |

### 0.21 — htmlexport: Interactive HTML export (steps 1880-1899)

Interactive HTML export (roadmap #164). *Export…*, format *Interactive HTML*. One self-contained `.html` file that opens in any browser without Obsidian. Implemented, not verified on hardware. Reference screenshots after `npm run harness:check` (`HARNESS_DOC=htmlexport`): `dev/harness/dist/shots/` (the export dialog on Interactive HTML, tablet and phone, dark and light).

1880. **The format.** Open *Export…* on a notebook of several pages: *Interactive HTML* is in the *Format* list; choosing it hides the PNG folder and shows a note that one file is written next to the notebook and nothing is loaded from the internet.
1881. **Whole notebook.** Export it: one `<notebook>.html` appears next to the notebook (a notice gives the path). Open it in a desktop browser (double click, no Obsidian running): the first page is shown fitted to the width, with a page strip on the left (hidden on a phone-width window) and the title on top.
1882. **Same drawing.** Compare a page with the SVG export of the same page: strokes, text boxes, images, boxes, markers and the paper pattern look the same; a wikilink on a text box shows its label.
1883. **Zoom and pan.** Ctrl + wheel zooms around the cursor; the +/- buttons zoom; *Fit width* (or key 0) restores the fit; dragging with the mouse (or one finger on a tablet) pans; pinching with two fingers zooms. Strokes stay sharp at 8x.
1884. **Pages and keys.** Next/Previous, the arrow keys, PageUp/PageDown, Home/End and a tap on a thumbnail change page; the address gets `#p3` and opening it later goes straight to that page; the browser Back button follows.
1885. **Dark and light.** Switch the system theme: the bar and the strip follow; the paper of the pages stays white (as in every other export).
1886. **Scope.** Export *This page* (file named `… p3.html`, one page) and *Some pages* `1, 4-5` (`… p1+4-5.html`, three pages). *Ink only* and *Background only* work; *Clean copy* leaves out the markers like the other formats.
1887. **Links.** A text box with `[[<notebook name>#p3]]` is a link in the file that jumps to page 3 (if page 3 is in the file); a `[[https://example.com|site]]` link opens the address in a new tab; any other note link is plain text.
1888. **Pictures.** A notebook with pictures and a PDF background: they appear in the file (as JPEG data inside it). A notebook whose pictures exceed about 32 MB shows a notice that some images were left out.
1889. **No overwrite, no network.** Export again: a second file `… 2.html` is written, the first is untouched. Open the browser developer tools, Network tab: reloading the file makes no request.
1890. **Big notebook.** Export a notebook of 100+ pages: Obsidian stays responsive while the notice counts the pages. Open the file: it opens at once; the thumbnails in the strip fill in as you scroll it (empty white boxes of the right shape until then).
1891. **Print.** Printing the file from the browser (Ctrl+P) prints every page, one per sheet and fitted to the width, without the bar and strip; the page on screen is not duplicated and is still shown after the print dialog closes.
1892. **Hostile text.** A notebook titled `<img src=x onerror=alert(1)>` and a text box with `<script>alert(1)</script>`: the exported file shows both as text and runs nothing.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Interactive HTML export (#164): one self-contained file with the inline SVG of each page, a vanilla-JS viewer (page strip, wheel/pinch zoom, pan, keyboard, fit width, light/dark), page links inside the file, web links, image size cap, no network (CSP), chunked build, never overwrites | yes | builder (escaping, clip ids, links, URL whitelist, image budget, valid script): `tests/export-html.test.ts`; harness `doc=htmlexport` drives the real viewer in an iframe | | | not opened on Android/Safari; the strip clones every page SVG when the file opens (slow to open for 500+ pages) |

### 0.21 — bookindex: back-of-book index (steps 1900-1919)

Back-of-book index (roadmap #187). Select a word or region with the lasso, choose *Add to index…* (selection bar or sheet), type a term. Internally this is an ordinary star marker whose label is `#idx <term>` (Settings, Reading: *Index term prefix*; no format change). *Back-of-book index…* (page sheet, notebook menu, command palette) lists the terms A-Z with a page chip each. Implemented, not verified on hardware.

1900. **Add a term.** Circle a word with the lasso, choose *Add to index…*, type `Photosynthesis`, press Enter. A star marker appears over the selection; its label reads `#idx Photosynthesis`. Undo removes it in one step.
1901. **Suggestions.** Select another word and open *Add to index…*: the terms already in use are listed; typing narrows them; a tap fills the field.
1902. **Open the index.** *Back-of-book index…*: letters A-Z with the terms under them, `#` first for numbers and symbols, accents and case ignored when sorting (Élan sits with E). One chip per page.
1903. **Sub-terms.** Add `Cell`, `Cell / Nucleus` and `Cell / Membrane`: Nucleus and Membrane are indented under Cell. A term used on several pages shows one chip per page; the same term typed with different case or accent is one line.
1904. **Jump.** Tap a page chip: the dialog closes and the notebook shows that page, near the marked spot.
1905. **Filter.** Type part of a word in the filter: only matching terms (with their parents) remain; clearing it shows everything.
1906. **Write to note.** *Write to note*: the note `<Notebook> — Index.md` appears next to the notebook with the list and page links. Tap a link in Obsidian: the page opens.
1907. **Only the region is rewritten.** Add text above and below the generated region in that note, add a term in the notebook, write again: the new term appears, your text is unchanged.
1908. **Never touch a foreign note.** Replace the note with text of your own without the markers, write again: a notice says the note was left untouched.
1909. **Custom prefix.** Change *Index term prefix* to `ix`: markers labelled `ix Foo` become terms; existing `#idx` markers stop being listed (nothing is deleted).
1910. **Editing.** Tap an index marker, change its label: the index follows. Delete the marker: the term disappears.
1911. **Locked page.** On a locked page *Add to index…* is refused like any other edit.
1912. **Phone width.** The dialog fits the screen, chips are easy to hit with a finger.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Back-of-book index (#187): *Add to index…* creates a labelled star marker (no format change); dialog with A-Z sections, sub-terms, page chips that jump, filter | yes | prefix and label parsing, sorting with locale and accents, merging, sub-terms, filter: `tests/book-index.test.ts`; dialog: harness `doc=bookindex` | | | |
| Back-of-book index, review W21 (D8): the generated region records its notebook (`<!-- notebook-index:start for=<path> -->`); a note that records another notebook is never rewritten, the index goes to `… — Index (2).md` | yes | marker round trip (paths with `--`, `>`, accents), replace refuses another notebook's region, choice of the numbered name: `tests/book-index.test.ts`; the vault side (`resolveIndexNotePath`) is not run in Obsidian | | | a notebook moved without its index note gets a `(2)` note; notes written before this change have a plain marker and are still replaced |
| Review W21 round 2 (N1-N6): the index note's marker records the notebook's document id next to its path, so a rename or move keeps the note (a path-only marker whose path no longer exists is taken back; another id never is); an old backup over the device cap is not read or trashed; `_meta` sidecars are read with the changed-while-read check; the backup folder is validated and saved on change, a refused value is never persisted; retention text; a `full` heading picture is not cached under the current ink | ✅ | ✅ `tests/book-index.test.ts`, `tests/backup-run.test.ts`, `tests/backup-logic.test.ts`, `tests/review-w21-data.test.ts`; ❌ settings field behaviour (needs Obsidian) | | | |
| Heading pictures and edit saving, review W21 (D6, D7, D9): new heading pictures carry the 0.20 and the 0.21 checksum; the full case keeps the previous link and is not re-read; the save is scheduled before the layout refresh after a change | yes | `tests/review-w21-data.test.ts` (both keys written and agreeing, edited picture detected, previous link kept in the full case); ❌ the view order in `afterHistoryChange` (needs Obsidian) | | | the previous link is remembered for the session only, not read back from the companion note |
| Index written to `<Notebook> — Index.md`: only the generated region rewritten, foreign or unpaired notes untouched | yes | section building, escaping and replacement: `tests/book-index.test.ts`; vault write: harness | | | |
| Index as a page at the end of the notebook | no | | | | not done: would need text boxes with page links in one undoable step; the note covers the use case |

### 0.21 — signstamp: reusable signature and date stamp (steps 1920-1939)

Implemented, not verified on hardware. Reference screenshots after `npm run harness:check` (`doc=signstamp`): `dev/harness/shots/design/signstamp-*`. No format change: the signature is an ordinary personal stamp called "My signature" (`<notebooks folder>/_stamps`).

1920. **Open.** In the page sheet (Insert) choose *Sign and date* (also in the command palette). A dialog shows your signature, or says there is none yet.
1921. **Draw.** *Draw signature* opens the pad. Sign on the line with the S Pen, a finger and a mouse: ink follows with no visible lag, *Undo* removes the last stroke, *Clear* all of them; *Save signature* is disabled until something is drawn.
1922. **Saved as a stamp.** After saving, the dialog shows the signature and the stamp palette lists "My signature". Redrawing and saving again keeps the old file and uses the newest one.
1923. **Place with the date.** With *Add today's date* on, *Place* puts the signature and the date text under it where the pen last touched (or the middle of the page in view). It is selected, so drag it: signature and date move together (one group).
1924. **Place without the date.** Turn the date off: only the ink is placed. Turn the signature off by never drawing one: only the date text is placed.
1925. **One undo step.** Undo removes signature and date together; redo puts them back. Placing twice gives two independent groups.
1926. **Date format.** Settings, Writing, Advanced: *Signature date format* (your language, ISO, custom) and *Custom signature date pattern*. Check the date in the dialog follows them and the Italian UI writes Italian month names.
1927. **Locked page.** On a locked page *Place* is refused with the "Page locked" notice and nothing is added.
1928. **PDF notebook.** On a page that annotates a PDF, sign on the signature line and export to PDF: the ink and the date appear where they were placed.
1929. **Look.** Light, dark, *Follow Obsidian theme*, phone and tablet width: the pad is light paper in every theme, every control has a label and works.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Signature pad and "My signature" stamp (#154): draw on a pad, saved as a personal stamp (vector strokes, no format change) | yes | pure logic: yes (`tests/signature.test.ts`); dialogs: harness (`doc=signstamp`) | | yes | |
| Sign and date (#154): signature plus date text placed as one undo step with a fresh group; date format locale / ISO / custom (settings) | yes | `tests/signature.test.ts` (date text, fresh ids, group, undo, lock, page edge); view: harness | | yes | placing is at the last pen position or page centre, not by a tap target |

### 0.21 — slideback: back to the current slide (steps 1940-1959)

"Back to the current slide" (roadmap #225). Settings, Study, Timetable: *Back to the current slide* (on by default). Use a notebook with several pages and either a running lecture (lecture mode on) or a PDF shown beside the notes. Implemented, not verified on hardware.

1940. **Nothing before you write.** Switch lecture mode on (the chip appears) and scroll around a notebook with no new ink: no button appears.
1941. **Leaving the page.** Write a few words on a page, then scroll three or four pages down with a finger. A small pill at the top centre of the view reads *Back to current page* (or *Back to slide N* on a PDF page or beside a linked slide), with an up or down arrow towards the place you wrote. It appears when the scroll has stopped, not while you drag.
1942. **Small scrolls.** Scroll less than half a screen away from where you wrote: no pill.
1943. **Going back.** Tap the pill: the view returns to the place you wrote (the written line near the middle of the view) and the pill disappears. *Back* in the navigation history returns to where you were.
1944. **Closing it.** Scroll away again and tap the *x*: the pill goes and stays away while you look elsewhere. Return to the written place and leave again: it comes back.
1945. **Pen.** With the pen, write right below the pill's place: the pill never takes the pen and never blocks the writing area; drawing a stroke under it works.
1946. **New place.** Write on another page: the pill now leads to that page.
1947. **Slide beside notes.** Show a PDF beside the notes, write beside slide 5, scroll away: *Back to slide 5*.
1948. **Command.** Command palette, *Back to the current slide or page*: it goes back (assign a hotkey in Obsidian's hotkey settings; there is no default). It is not offered before anything was written.
1949. **Setting.** Turn *Back to the current slide* off: no pill, and the command is not offered.
1950. **Lecture over.** Leaving lecture mode keeps the last place until you write elsewhere; ink written outside a lecture and not beside a slide does not move it.
1951. **Light, dark, phone.** The pill reads in light and dark and fits a phone's width.

| Feature | Implemented | Automated test | Verified on hardware | Experimental | To do |
|---|---|---|---|---|---|
| Back to the current slide (#225): the place last written during a lecture or beside a linked slide; a pill (and a command) appears when the view is half a screen or more away after the scroll settles, returns there like the notebook map's jump, can be closed, setting to turn it off; nothing is written to the notebook | yes | when to show (threshold, hysteresis, dismissal), return position, which ink counts, slide number from the link or the PDF page: `tests/slide-back.test.ts`; harness `doc=slideback` | | | not tried with a real hand on a tablet; the half-screen threshold is a guess |

### 0.21 — symbols: recent symbols (steps 1960-1979)

Recent symbols (roadmap #212). Settings, Writing: *Recent symbols* (on/off) and *Symbols shown* (3-12). A symbol is a small personal stamp (same `_stamps` store and format, no format change) or a typographic character; use counts are kept on this device only. Implemented, not yet verified on hardware.

1960. **The strip.** Open a notebook: a pill with six buttons (∀ ∃ ∫ → ⇒ ≠) sits at the top centre of the page area. It is hidden in a read-only view and when *Recent symbols* is off.
1961. **Insert a character.** Tap ≠, then tap the page with the S Pen: a text box with ≠ appears where you tapped, selected, in the current text size and pen colour. The button looks pressed (and says "Tap the page") until you tap the page, tap the button again or press Escape.
1962. **One undo step.** Undo removes the character; redo brings it back.
1963. **Ranking.** After using ≠ twice and π once, ≠ is the first button, then π; unused ones keep their order. After about two weeks without using one, newer habits overtake it.
1964. **Save a symbol.** Draw a small sign (for example a hand-drawn ∑), select it with the lasso, choose *Save selection as symbol* (selection bar "…" or the All actions sheet), name it: it joins the strip as a small drawing. A selection larger than about 200 pt is refused with a message.
1965. **Place it.** Tap the symbol, tap the page: it is drawn at about one text line high, in the current pen colour and width, selected as ONE group when it has several strokes; one undo removes all of it.
1966. **Fresh copies.** Place it twice: moving one never moves the other; undo/redo twice leaves the notebook valid and saved.
1967. **Stamps.** The same file appears in *Stamps*; renaming or deleting it there updates the strip the next time the strip refreshes (on opening the notebook or saving a symbol).
1968. **Settings.** *Symbols shown* = 3 leaves three buttons; turning *Recent symbols* off removes the strip and any pending placement.
1969. **Phone.** On a narrow screen the strip scrolls sideways rather than overflowing the page.
1970. **Palm and pen.** While a symbol is armed, taps with the pen or a finger place it; the page does not scroll or zoom until you place it or cancel.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Recent symbols strip (#212): ranked by decayed use, device-local counts, typographic characters as text boxes | yes | yes (ranking, decay, bounds, scaling, placement ids/group/undo; harness) | | | |
| Save selection as symbol, pen-sized placement of saved symbols (stamp store, one group, one undo step) | yes | yes | | | |
| Settings: strip on/off, number of buttons | yes | yes (harness) | | | |

### 0.21 — backups: scheduled zip backups (steps 1980-1999)

Scheduled backups (roadmap #127). Settings, Sync & safety: *Scheduled backups* (off / every day / every week), *Backup folder* and *Backups to keep* (shown while a schedule is on), and the *Back up now* row, whose line shows the time and result of the last backup. Command palette: *Back up the notebooks now*. Implemented, not verified on hardware. Needs a vault with a few notebooks that have PDF or picture pages.

1980. **Off by default.** A fresh install makes no backup and no folder. *Back up now* is there; *Backup folder* and *Backups to keep* appear only after you choose a schedule. The row says *No backup made on this device yet.*
1981. **Back up now.** Tap *Back up now*: a notice shows progress ("N of M files"), the button reads *Backing up...* and is disabled, the notebook stays usable (write a few strokes while it runs). It ends with a notice naming `Notebook backup YYYYMMDD-HHmmss.zip`, the file count and the size. The file is in the backup folder, and the settings line shows the time, file count and size.
1982. **The zip opens.** Copy the zip out of the vault (or open it with a file manager on the tablet): it unzips with any tool, with no password or error. It holds the `.notebook` files (with their folders), `_assets`, `_meta` and the templates, and not the trash, the `_backup` copies or the older zips. A notebook unzipped back into a new folder opens and looks the same.
1983. **Unsaved changes.** Open a notebook, write a stroke and tap *Back up now* at once: the stroke is in the backup (open the unzipped copy).
1984. **One at a time.** Tap *Back up now* twice quickly, or run the command while one is running: the second says *A backup is already running.* and nothing starts.
1985. **Schedule.** Choose *Every day*. With no backup yet one is made a minute or two after the settings are saved or Obsidian is reopened (not while the pen is on the screen). Reopen Obsidian within the day: none is made. Change the device clock a day ahead (or wait a day): one is made. *Every week* waits seven days.
1986. **Keep N.** Set *Backups to keep* to 2 and run *Back up now* four times (a minute apart): only the two newest zips remain; the older ones are in Obsidian's trash (or deleted, per your *Deleted files* setting).
1987. **Only its own files.** Put a file of yours in the backup folder (`holiday.zip`, `notes.md`, a zip named `Notebook backup 2020.zip`, a subfolder): after more backups they are all still there.
1988. **Folder.** Set *Backup folder* to another folder (typed or picked): the next backup goes there; the old folder is left as it is. Pointing it at a folder that your sync tool copies elsewhere is the way to get the zips off the device.
1989. **Failure.** Fill the disk or make the folder read-only (desktop), then *Back up now*: a red notice and the settings line say it failed; older backups are all still there; a retry waits an hour on the schedule.
1990. **Partial.** With a notebook that a sync client has not finished downloading (empty file), *Back up now* saves the rest and says how many files could not be read; the zip is named `... partial.zip`. The last complete backup is never trashed to make room for partial ones.
1991. **Not in the library.** Unzip a backup into the backup folder: its notebooks are not listed in the library or Home, and no PDF placed there shows in the shared files inbox.
1992. **Languages.** Switch the plugin to Italian: the rows, notices and the status line are translated.
1993. **Large vault (Android).** On a vault of a few hundred MB: the backup finishes without freezing the pen or the toolbar. Above about 64 MB on a phone or tablet it stops with *too large* and writes nothing: that limit is for memory, say so if you hit it.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Scheduled zip backups (#127): off / daily / weekly into a vault folder, *Back up now*, keep the last N, last time and result in settings | yes | due-time (daily, weekly, other device's backup, clock in the future, failure retry), names, retention never trashing foreign files or the last complete backup, run order (flush, temp name, size check, rename, then trim), partial and failed runs leave old backups alone: `tests/backup-logic.test.ts`, `tests/backup-run.test.ts`, `tests/backup-wiring.test.ts` | | | memory limit of 64 MB on phones and tablets (the zip is built in memory); no Drive and no folder outside the vault (no Node/Electron); not tried on Android |
| Scheduled backups, review W21 (D1-D5): the zip just written is always kept (names dated more than a day ahead rank oldest); a backup folder that is, holds, or is inside the notebooks folder, overlaps a templates folder or holds notebooks is refused (settings keep the previous folder; a run with one fails; `readSettings` falls back to the default); an old backup is trashed only after its zip comment is read; a notebook that changes during the read is read again once, then skipped and the backup is partial; mobile cap 64 MB | yes | `tests/backup-logic.test.ts` (retention with future-dated names and keep = 1, overlap rules, settings fallback), `tests/backup-run.test.ts` (new backup survives, overlap fails with nothing written or trashed, foreign file with a backup's name left alone, unreadable file never trashed, stale temp needs the record or the mark, racing read re-read once or skipped) | | | the notice in the settings and the check against real vault files are not run inside Obsidian; a backup over 512 MB is never trashed (it is not read to check the mark); an interrupted temporary file from another device stays |
| Zip writer and reader (STORE, CRC-32, UTF-8 names, strict reader): `src/model/zip.ts` | yes | round trip, CRC, truncated and corrupt archives, name rules, entry limit; checked once against Windows `tar`: `tests/zip.test.ts` | | | no ZIP64 (at most 65 534 files and 4 GB) |

### 0.22 — pens: fountain pen, brush and marker (steps 2040-2059)

New pens (roadmap #35, document format 20). The pen options have a *Pen type* row (Pen, Fountain pen, Brush, Marker) and, for the fountain pen and the marker, a *Nib angle* slider. *Settings > Writing* has *Pen type* and *Nib angle* (the pen a new view starts with).

2040. **Pen type.** Select the pen, tap it again: the options show four tiles. Choosing one changes the current-pen indicator (a leaf, a drop, a small slab) and the next stroke. The nib angle appears only for the fountain pen and the marker.
2041. **Fountain pen.** Write loops and a cursive line with the S Pen: lines that run along the nib (up to the right at 45) are thin, lines across it thick; pressure thickens the line a little; the ends are crisp. Change the angle with the slider: new strokes follow it, strokes already written do not change.
2042. **No lag.** The fountain pen, the brush and the marker feel as quick as the pen: no extra delay while writing, and the line does not jump or change shape when the pen lifts (the brush's last tip closes a little, that is expected).
2043. **Brush.** Light pressure draws a fine line, heavy pressure a full one; a quick flick is thinner than a slow stroke; a stroke starts from a point and ends in a point.
2044. **Marker.** A flat tip: pressure changes nothing; lines are a little thinner along the nib than across it. Write over a line of pen ink: the line shows through (85% opaque). Cross two marker strokes: the overlap is darker; within one stroke it is not. It is not like the highlighter (paler, and it never covers the ink).
2045. **Same look everywhere.** Close and reopen the notebook; zoom out far (thumbnails in the library and the page panel); export a page as PNG, SVG, PDF and interactive HTML: the lines look like on the page (the marker 85% opaque in each).
2046. **Erase and select.** The whole-stroke eraser takes a brush stroke where it is thick; the partial eraser cuts it and the pieces keep their look; the lasso selects them. Rotate a selection with a fountain pen line in it: the thick and thin parts turn with it (the nib turns).
2047. **Colour, width and style.** Change colour and width of a selection (the kind stays). The style eyedropper on a fountain pen stroke selects the fountain pen with that nib angle.
2048. **Favourites and pen sets.** Hold a favourite slot to save the fountain pen: the slot dot is a leaf. Pick another pen, tap the slot: the fountain pen and its angle come back. Save a pen set with a brush and a marker and use it from another notebook.
2049. **Hold to straighten.** Draw a line with a new pen and hold still: it becomes a plain shape (like the pen's).
2050. **Settings.** Set *Pen type* to Fountain pen: a new notebook view starts with it; *Nib angle* shows only for the fountain pen and the marker.
2051. **Italian.** Switch the plugin to Italian: Stilografica, Pennello, Pennarello, Angolo della punta.
2052. **Older plugin.** Open a notebook that has new pen strokes with 0.21 (if you have it): it opens read-only as a newer format and is not overwritten. Open a 0.21 notebook with this version: it opens and saves normally.
2053. **Merge.** Write a fountain pen stroke on two devices (a sync conflict): the merge keeps both and the nib angle.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| New pens (#35): fountain pen (width follows the direction against the nib angle, pressure modulates, crisp ends), brush (pressure and speed, soft ends), marker (flat chisel, 85% opaque, in stroke order) | yes | geometry (direction, pressure, speed, ends, wet = committed, reach of boxes and hit tests, nib after a move, same paths in SVG / PDF / thumbnails, allocation and time per point), golden hashes of the pen, highlighter and shape: `tests/pens-engine.test.ts`, `tests/pens-golden.test.ts` | | | |
| Document format v20: tools `fountain`, `brush`, `marker` and `Stroke.nib`: migration v19 -> v20 (refuses new tools, drops a stray nib), lenient read and strict write, staged parse, repair, merge key, copies, schema | yes | `tests/model-v20.test.ts`, `tests/format-schema.test.ts` | | | |
| Pen type row and nib angle in the pen options; favourites, pen sets, style eyedropper and settings defaults keep the kind | yes | `tests/pens-ui.test.ts`; harness `pens` (options, specimen, exports) | | | |

### 0.22 — synccore: cloud sync engine and settings (steps 2060-2079)

Cloud sync with Google Drive or OneDrive (roadmap #126, part 1: the engine, the settings and the status). Settings, Sync & safety, group *Cloud sync*: *Cloud service* (off by default), *Client ID* (and, for Google, *Client secret*), *Account*, *Sync now*, *What to sync* (with *Folders*, or *Include* / *Exclude* / *File types*), *Sync on open*, *Sync on close*, *Sync every*, *Wi-Fi only*, *Large files* and *Size limit*, *Activity*. Command palette: *Cloud sync now*; desktop status bar item. The sign-in comes from part 2 (`src/sync/providers/`, `src/sync/auth/`), joined to the engine by `src/sync/auth-adapter.ts` (unit-tested with fakes in `tests/sync-auth-adapter.test.ts`); the steps below that talk to the cloud need your own OAuth client and a real account. You need your own OAuth client (Google: a *TVs and limited input devices* client with its secret; Microsoft: an app registration), the same client ID on every device. Implemented, not verified on hardware. Use a test vault you have a copy of.

2060. **Off by default.** A fresh install shows *Cloud sync* closed with *Cloud service: Off*; nothing is sent anywhere, no status bar item, the command says cloud sync is off.
2061. **Client and sign-in.** Choose *Google Drive*: *Client ID*, *Client secret*, *Account*, *Sync now* and the other rows appear. Tap *Sign in* with the fields empty: a notice says what is missing and nothing opens. Fill them in, tap *Sign in*, complete the sign-in: the *Account* row names the account and the cloud folder, and a first sync starts. The secret is not in `.obsidian/plugins/notebook/data.json`.
2062. **First sync is a union.** Before signing in, put a different note in the cloud folder from another device or the web. After the first sync both sides have every file; nothing was deleted anywhere; a file present on both sides with different content is kept twice (one is a conflicted copy, step 2066).
2063. **Edits both ways.** Write in a notebook on the tablet, *Sync now*; on a second device *Sync now*: the notebook shows the new ink (an open notebook reloads by itself). Edit on the second device, sync both: the tablet shows it.
2064. **Open notebook saved first.** Write a stroke and at once tap *Sync now* (or switch to another app with *Sync on close*): the stroke reaches the cloud. A notebook with unsaved ink is never replaced by the cloud's version during a sync.
2065. **Deletions.** Delete a note on one device and sync both: it goes to the trash on the other device (Obsidian's trash setting) and to the cloud's trash; nothing is deleted permanently. Delete a file on one device while editing it on the other: the edit wins and the file comes back.
2066. **Conflict keeps both.** Edit the same notebook on two devices without syncing, then sync both: both versions exist, the cloud's as `Name (conflict YYYY-MM-DD HH.MM Device).notebook`; a notice says both were kept, and with the notebook open the merge offer (#122) appears.
2067. **Many deletions stop.** Delete a folder with more than 20 files (or most of a small vault) and sync: the sync stops and asks, listing the files. *Keep them* copies them back from the cloud; *Delete them* sends them to the trash on the other side. Closing the dialog does neither; *Review* in the settings asks again.
2068. **Scope.** Set *What to sync* to *Selected folders* with one folder: only that folder is sent; files outside it are never deleted on either side. *Rules* with `*.pdf` in *Exclude*: PDFs are left alone. `.obsidian`, `.trash`, temporary files and the backup folder are never synced, whatever the rules.
2069. **Large files.** Set *Size limit* to 10 MB, add a 20 MB PDF and sync with *Large files: Ask first*: the other files sync, then a dialog asks about the PDF (*Sync them* / *Skip for now*). With *Skip*, it is listed as skipped in *Activity*.
2070. **Wi-Fi only (Android).** On mobile data with *Wi-Fi only* on: no automatic sync; *Sync now* says it is waiting for Wi-Fi. On Wi-Fi it runs. Where the network type is unknown (desktop, some WebViews) it runs and the status line says so.
2071. **Triggers.** *Sync on open*: a sync about 20 s after Obsidian starts (not while the pen is on the screen). *Sync every 15 min*: one every 15 minutes while open. *Sync on close*: one when the app goes to the background (best effort, at most once a minute).
2072. **Status.** The *Sync now* row shows the last sync time and counts; *Stop* while one runs. *Activity* lists the last 50 events. On desktop the status bar item shows the state and starts a sync when clicked.
2073. **Offline and errors.** Turn on airplane mode and *Sync now*: one notice says the cloud cannot be reached, no repeated notices on automatic runs; the next sync after reconnecting works. Revoke the app's access from the account page: the next sync says to sign in again.
2074. **Disconnect.** Tap *Disconnect*: the account row offers *Sign in* again; no file is touched on either side. Signing in again starts with a safe first sync (a union, nothing deleted). If the access could not be revoked, a notice gives the page to remove it by hand.
2075. **Damaged state.** Quit Obsidian, corrupt `.obsidian/plugins/notebook/cloud-sync/state-*.json` (type a few letters into it), reopen and sync: it lists everything again and deletes nothing; a copy of the bad file is kept as `.bad.json`.
2076. **Languages.** Switch the plugin to Italian: the rows, dialogs, notices, status line and activity log are translated.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Cloud sync engine (#126 part 1): three-way planner (per-path remote index + base with hash), first sync = union, deletions only from a synced unchanged state and to the trash, mass-deletion guard (> 20, or ≥ 3 and > 30 %), keep-both conflicts named for the #122 merge offer, conditional uploads with re-plan, retries (Transient with retry-after, Auth stops), scope rules, large-file rule, device-local state (damaged → full rescan, no deletions) | yes | `tests/sync-planner.test.ts`, `tests/sync-rules.test.ts`, `tests/sync-state.test.ts`, `tests/sync-engine.test.ts` (end to end with a fake provider and a fake vault: union, edits, deletions, guard, empty listing, full listing each run, missing root, corrupt state, conflicts during upload, retries, open notebooks, large files, cursor and scope change) | | | not run against real Google Drive / OneDrive nor on Android; the adapter joining it to the providers (`tests/sync-auth-adapter.test.ts`, fakes only) is the one piece no scenario exercises end to end |
| Cloud sync settings, status and dialogs: *Cloud sync* group (service, client ID, Google client secret kept on the device, account, *Sync now* / *Stop* / *Review*, scope, triggers, Wi-Fi only, large files, activity log), *Cloud sync now* command, desktop status bar item, deletion and large-file dialogs | yes | browser harness `doc=synccore` (in-memory cloud, `dev/harness/synccore-check.ts`): off by default, rows per scope, no sign-in button without the providers, client fields, sign-in and first sync, conflict copy, deletion dialog and *Keep them*, status and log | | | the sign-in itself is the providers' (part 2); Wi-Fi detection depends on the WebView's Network Information API |

### 0.22 — syncprov: Google Drive and OneDrive providers and sign-in (steps 2080-2099)

Cloud connector, part 2 (roadmap #126): the two providers and the device-code sign-in. The *Cloud sync* settings section and the engine are part 1 (synccore); these steps need both. Implemented, not verified on hardware or against the live services. Needs your own OAuth app for each provider (`docs/cloud-sync.md`), a network connection, and a second device or a browser.

2080. **Google app.** Follow `docs/cloud-sync.md` for Google: project, Drive API, consent screen published, client of type *TVs and Limited Input devices*. Note the client ID and secret.
2081. **Google sign-in (Android).** In *Cloud sync* choose Google Drive, paste ID and secret, *Connect*. The dialog shows *Asking for a sign-in code…*, then a large code, `https://www.google.com/device`, three steps, *Copy code*, *Cancel*, *Open sign-in page* and a countdown that ticks down each second.
2082. **Open and allow.** *Open sign-in page* opens the system browser at the address. *Copy code* puts the code on the clipboard (paste it on the page). Sign in, allow. Within about 5 s the dialog shows *Signed in. Setting up the sync folder…* and closes; settings show your Google address. In Drive, My Drive has a folder `Notebook sync`.
2083. **Second device.** Sign in on a second device with the same client ID: it finds the same `Notebook sync` folder (no second folder is made).
2084. **Deny.** Start again and choose *Cancel* on Google's page: the dialog says *Access was not allowed* with *Try again*; *Try again* shows a new code.
2085. **Cancel.** Start and tap *Cancel* in the dialog: it closes, settings stay signed out; opening Google's page afterwards and entering the old code does not sign the plugin in.
2086. **Wrong client.** Paste a wrong client ID (or secret): *The provider refused the client ID or secret* with the hint line.
2087. **Expiry.** Start and leave the code unused until the countdown ends (30 min for Google, 15 for Microsoft): *The code expired…* with *Try again*.
2088. **Microsoft app.** Follow `docs/cloud-sync.md` for OneDrive: app registration for any organisational directory and personal accounts, *Allow public client flows* on. Connect with the ID (no secret): code, `https://microsoft.com/devicelogin`, accept; settings show your address; OneDrive has `Notebook sync`.
2089. **Public client switch off.** Turn *Allow public client flows* off and connect: a client error is shown, not a hang.
2090. **Desktop.** Repeat 2081-2082 and 2088 on Windows: same dialog, the link opens the default browser.
2091. **Tokens stay on the device.** After signing in, search the vault folder and `.obsidian/plugins/notebook/data.json` for the access or refresh token (copy it from nowhere: just check that no file mentions `refresh` or the client secret): none. Restart Obsidian: still signed in.
2092. **Token refresh.** Leave Obsidian open (or the device asleep) for more than an hour, then sync: it works without signing in again.
2093. **Revoked access.** Remove the app's access at <https://myaccount.google.com/connections> (or <https://account.live.com/consent/Manage>), then sync: the settings ask you to sign in again (no endless retries).
2094. **Disconnect.** *Disconnect* on Google: the app disappears from <https://myaccount.google.com/connections> within a minute or two; on OneDrive the settings link the consent page. Files in `Notebook sync` are untouched.
2095. **Large file.** Sync a notebook or PDF above 5 MB on both providers: it arrives whole (sizes match on the web), also on mobile data.
2096. **Remove goes to the trash.** Delete a synced notebook (so sync removes it remotely): it is in the Google Drive trash / OneDrive recycle bin, not gone.
2097. **Folder moved on the web.** Rename a subfolder of `Notebook sync` on the provider's website, then sync: the files appear under the new name and nothing is lost. Move one file out of `Notebook sync` on the web: the next sync treats it as deleted remotely.
2098. **Sync folder trashed.** Move `Notebook sync` to the trash on the web, then sync: the settings report the missing folder; no local notebook is deleted. Restore it: sync continues.
2099. **Languages and themes.** Italian: every line of the dialog is translated. Light and dark, phone and tablet: the code is large and the dialog fits.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Device-code sign-in (RFC 8628) for Google and Microsoft: code and address, Copy code, Open sign-in page, countdown, `interval` and `slow_down`, denied / expired / refused client / network, Cancel; then the sync folder `Notebook sync` found or created and the account label | yes | `tests/sync-device-flow.test.ts`; harness `doc=syncprov` (dialog, refused sign-in, Cancel) | | | not run against the live endpoints; Google needs the client secret of a limited-input client |
| Tokens: device-local store (`app.saveLocalStorage`), refresh before expiry and after 401, rotation reported via `onAuthChange`, `invalid_grant` → sign in again, Disconnect (Google revokes; Microsoft local only) | yes | `tests/sync-tokens.test.ts` | | | the settings section must store the state on every `onAuthChange` (part 1) |
| Google Drive provider (`drive.file`): full listing, changes feed with parent walk, moves in/out of the root, multipart and resumable upload (256 KiB chunks, 308), `ifRev` by metadata read, trash, retries | yes | `tests/sync-gdrive.test.ts` | | | `ifRev` race window of one request (Drive has no If-Match); `308` through `requestUrl` not tried on a device; first non-empty delta after a restart is a full listing |
| OneDrive provider (`Files.ReadWrite`): folder delta with nextLink/deltaLink, deletions, moves out, 410 resync, Business root-delta fallback, simple and session upload (320 KiB fragments, no bearer on fragments), If-Match / conflictBehavior, recycle bin, download URL | yes | `tests/sync-onedrive.test.ts` | | | Business fallback and `deltaExcludeParent` on consumer OneDrive not tried live; moves out of the folder may not appear in a folder delta on consumer OneDrive (then the file stays listed until the next full listing). Superseded by the review W22 rows below (app folder scope, children walk, hash revision) |

### 0.22 — review W22: cloud sync fixes (steps 2240-2259)

Fixes of the wave 0.22 cloud sync review (S1–S16 and the provider switch). Implemented and unit-tested with fakes (no network); not verified on hardware or against the live services. Needs the set-up of the synccore and syncprov steps.

2240. **Loading.** Start Obsidian and tap *Sync now* at once (before the vault has finished loading on a large vault): a notice says cloud sync starts once the vault has loaded; the status says so; a few seconds later *Sync now* works.
2241. **Never permanent.** With *Files & links > Deleted files* set to *Permanently delete*, delete a synced note on device A and sync both: on device B the note is in the vault's `.trash` folder.
2242. **Start-up does not delete.** Delete a note on device A, sync A. On B, close and reopen Obsidian (sync on open): the note is still there and the status says one deletion waits; *Sync now* then moves it to `.trash`.
2243. **Automatic limit.** Delete 12 synced notes on A and sync A; on B wait for the periodic run: it stops and asks (*Delete 12 files?*).
2244. **Same name twice (Google).** On the Drive website upload a second file with the name of a synced note but other content into `Notebook sync`; sync: the vault has the note and a conflicted copy with the other content; Drive's trash has the extra file.
2245. **Simultaneous write (Google).** Edit one notebook on two devices offline, then bring both online and sync them within seconds of each other: both versions survive (one as a conflicted copy) on both devices.
2246. **Rename on OneDrive's website.** Rename a synced file on the OneDrive website (no content change), then edit it in Obsidian and sync: no conflicted copy is made.
2247. **Names.** Create `bad?.md` on the Drive website: sync shows one notice naming it; it never appears locally and nothing is deleted. Rename a synced file on the web to `CON.md`: the local file stays and goes up again under its old name.
2248. **Case rename.** Rename `Note.md` to `note.md` in Obsidian (Windows) and sync: the cloud shows `note.md` only; on the other device the file follows.
2249. **OneDrive app folder.** Sign in to OneDrive again: the consent screen asks only for the app's own folder; the files go to `Apps/<app name>` in OneDrive; the settings say Notebook sees only that folder.
2250. **OneDrive work account.** Sign in with a work or school account: note whether the sign-in is allowed and whether delta or the children walk is used (slower runs on a large folder).
2251. **Disconnect.** *Disconnect* during a run: a dialog asks first (Google: with *Also forget the client secret*); after confirming, the run stops and the settings show signed out; signing in again makes a union (nothing deleted).
2252. **Switch service.** Signed in to Google, choose OneDrive and sign in: Google is disconnected first (gone from <https://myaccount.google.com/connections>).
2253. **Phone, unknown network.** On a phone whose WebView does not report the network type, with *Wi-Fi only* on: automatic runs wait (status says so); *Sync now* runs with a note.
2254. **Phone size cap.** On a phone, with *Size cap on phones* at 5 MB, add a 10 MB PDF on the desktop and sync both: the phone skips it with one notice, even after approving large files.
2255. **Languages and themes.** Italian: the new notices, status lines, skip reasons and the Disconnect dialog are translated; the dialog fits a phone in light and dark.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| S1 ready gate: no trigger (manual included) before layout ready and the metadata cache's first `resolved` (30 s fallback); the start-up run waits for it | yes | `tests/sync-service-w22.test.ts`; harness `doc=synccore` (loading notice, gate) | | | |
| S2 local sync deletions to Obsidian's `.trash` (`vault.trash(file, false)`), never permanent | yes | `tests/sync-service-w22.test.ts` | | | lint warns `prefer-file-manager-trash-file` (intended; the rule cannot be disabled) |
| S3 Drive: revisions displaced by our write kept as conflicted copies; a racing trash undone | yes | `tests/sync-gdrive.test.ts`, `tests/sync-review-w22.test.ts` | | | `revisions.list` may be incomplete (then one copy too many) |
| S4 two cloud files with one name: smallest id followed, others kept as copies then trashed; idempotent creates with `files.generateIds` (409 → read) | yes | `tests/sync-gdrive.test.ts`, `tests/sync-review-w22.test.ts`, `tests/sync-engine.test.ts` | | | |
| S5 Disconnect cancels and awaits the run before removing the state; controller made before any wait | yes | `tests/sync-service-w22.test.ts` | | | |
| S6 OneDrive revision = content hash; If-Match with the eTag read just before; same content as the base is not a conflict | yes | `tests/sync-onedrive.test.ts`, `tests/sync-review-w22.test.ts` | | | state files of earlier builds hold eTag revisions: the first run after the update re-reads changed-looking files (no copies, the hash check adopts them) |
| S7 start-up/leaving runs defer deletions (count in the status); automatic guard limit 10 | yes | `tests/sync-review-w22.test.ts`, `tests/sync-service-w22.test.ts` | | | |
| S8 conflicted copy outside the scope stays local | yes | `tests/sync-review-w22.test.ts` | | | |
| S9/S10 names: one rule both sides, skipped with one notice, never a deletion; NFC/case clashes never both written; case-only renames followed | yes | `tests/sync-review-w22.test.ts` | | | |
| S11 state saved at most every 10 s during a run | yes | `tests/sync-review-w22.test.ts` | | | |
| S12 Drive web folders invisible to `drive.file` | documented (`docs/cloud-sync.md`) | | | | a move into such a folder reads as a deletion (to `.trash`, recoverable) |
| S13/S14 OneDrive `Files.ReadWrite.AppFolder`, root = app folder; children walk when the folder delta is refused | yes | `tests/sync-onedrive.test.ts`, `tests/sync-device-flow.test.ts` | | | work or school accounts: docs disagree; not tried live |
| S15 Drive upload session only on `www.googleapis.com`; addresses stripped from error texts | yes | `tests/sync-gdrive.test.ts`, `tests/sync-review-w22.test.ts` | | | |
| S16 mobile: unknown network holds automatic runs; *Size cap on phones* (5–500 MB, default 50) | yes | `tests/sync-service-w22.test.ts`, `tests/sync-review-w22.test.ts` | | | |
| Provider switch disconnects the previous account; Disconnect dialog can forget Google's secret | yes | `tests/sync-service-w22.test.ts`; harness `doc=synccore` (dialog, Cancel) | | | |
| Round 2: kept files that cannot be copied back (size cap, large-file rule) lose their base, never trashed later | yes | `tests/sync-review-w22.test.ts` | | | |
| Round 2: newest twin followed; twin above the cap skipped; local rename to an unsyncable name not a cloud deletion | yes | `tests/sync-review-w22.test.ts` | | | |
| Round 2: Drive displaced versions unchecked or above the cap reported; replace across twin folders by id | yes | `tests/sync-gdrive.test.ts`, `tests/sync-review-w22.test.ts` | | | |
| Round 2: OneDrive walk with an off-Graph next link or an unfinished listing fails the run | yes | `tests/sync-onedrive.test.ts` | | | |

### 0.22 — colormeaning: colours with meaning (steps 2120-2139)

Roadmap #101. Say what each ink colour means (red = definition, blue = example) in *Settings > Reading & PDF > Colour meanings* (a dialog) or, for one notebook, in its menu *Colour meanings…*; *Filter by meaning…* draws the ink of the other meanings faint (view only, nothing is saved or changed in the notebook), and *Digest by colour…* writes a note `<Notebook> — Colours.md` with one section per meaning and a picture of each place. The document format is not touched.

2120. **Define.** Settings, Reading: *Colour meanings* > *Open*. With no meanings it offers *Add the usual meanings* (red Definition, blue Example, green Important). Rename one, change its colour (a swatch, or the round "other colour" picker), move one up or down, remove one, add one. Every change is saved at once (close and reopen Settings: it is all there).
2121. **Too close.** Give two meanings colours that look nearly the same: a red message says which two are too close. Pick colours that differ more and the message goes.
2122. **Match.** Write with the red pen, then with a slightly different red from the colour picker: *Filter by meaning* > Definition keeps both in full colour. With *Colour matching* set to *Strict* only the exact red stays; with *Loose* a duller red also counts.
2123. **Filter.** In a notebook with red, blue, green and black ink: menu (More) > *Filter by meaning…* lists the meanings with the number of strokes of each. Choose *Definition*: red ink stays, everything else (also black and PDF-less pen ink of no meaning, and highlighter) is faint; a pill at the bottom left says *Showing only: Definition*. Zoom and scroll: the page still moves smoothly and the faint ink does not flicker.
2124. **Clear.** Tap the × on the pill, or *Filter by meaning…* > *Show everything*: all the ink is back at once. Switch to another notebook and back: the filter was not kept.
2125. **Not saved.** With the filter on, write a new stroke in another colour, undo, redo, then clear the filter: every stroke is exactly as before; the notebook does not appear as "changed by the filter" (nothing was saved because of it).
2126. **Own legend.** In a notebook's *Colour meanings…* switch on *Use a legend for this notebook only*: it starts as a copy of the global legend; rename the first meaning to "Theorem". The filter chooser of this notebook says Theorem; another notebook (and Settings) still says Definition. Switch the option off: this notebook uses the global legend again.
2127. **Sync.** With a vault synced between two devices, the notebook's own legend shows up on the other device after the sync (the file is `<notebooks folder>/_meta/meanings-<device>.json`). It is not listed as a notebook and does not make *Check the library* report anything.
2128. **Digest.** *Digest by colour…* says how many places on how many pages, and offers the picture quality. *Create the digest*: the note appears next to the notebook with a section per meaning in legend order, a picture of each place, the PDF text under it (on PDF pages) and a link to the page; a meaning with no ink says so.
2129. **Run it again.** Write around the section (a line before and after), run the digest again: your text is kept, no new picture files appear, and running it a third time changes nothing. Add a stroke and run it: the new place is listed.
2130. **A note of yours.** Put a plain note with the digest's name in the folder: the digest asks before adding to it, and nothing else in that note changes. Damage one marker comment: the digest refuses and says so.
2131. **States.** On a drawing with states, filter and digest follow the state shown on the page.
2132. **Hidden ink.** Ink written with the invisible pen is neither dimmed differently nor listed in the digest.
2133. **Android.** On the tablet with the S Pen: choose a meaning in the filter while the pen is hovering and while writing; the filter dialog and the legend editor are comfortable to use with a finger; the pill does not cover the minimap or the page scrollbar.
2134. **Dark and Italian.** In the dark theme and with the plugin in Italian, the dialogs, the pill and the note's headings read correctly.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Colours with meaning (#101): global legend in settings (label per colour, matched with a tolerance: strict / normal / loose), legend editor dialog, near-duplicate warning | yes | colour distance, matching (exact, shade, tolerance, nearest, tie), near duplicates, free colour, legend parsing (lenient, limits): `tests/colour-meaning.test.ts` | | | |
| Per-notebook legend in `_meta/meanings-<device>.json` (one file per device, latest wins, tombstone, unknown fields kept, never overwrites an unreadable file) | yes | round trip, merge, store (own file only, damaged and empty files, other device's bad file): `tests/colour-meaning.test.ts` | | | |
| View filter "Filter by meaning": other ink drawn faint through the renderer (static layer redrawn once, no per-frame work), pill to clear it | yes | dimmer, counts: `tests/colour-meaning.test.ts`; pixels and pill in the harness (`colours`) | | | text boxes, equations and pictures are not dimmed (ink only) |
| Digest by colour: `<Notebook> — Colours.md`, a section per meaning, pictures, PDF text, marker-bounded rewrite | yes | regions, grouping, Markdown, marker replacement: `tests/colour-meaning.test.ts`; the note and pictures in the harness (`colours`) | | | |

### 0.22 — covers (custom covers, roadmap #53; steps 2160-2179)
2160. **Open.** Library card menu > *Change cover…* (also the notebook tab's "more options" menu): a dialog with Pattern, Image, Page, Template. Cancel writes nothing.
2161. **Pattern.** Pick another family and colour, *Use this cover*: the card changes; no file appears in `_assets`.
2162. **Image.** Image > choose from the vault, then from the device (a camera photo): the picture fills the frame; drag it with the S Pen and with a finger, pinch with two fingers, use the slider and the reset button. *Use this cover*: the card shows exactly what the frame showed.
2163. **Large photo (Android).** Choose a 12 MP photo: the dialog stays responsive, says it was reduced, and the saved cover file is small (under about 150 KB).
2164. **Page.** Page > step to another page; the frame shows it; crop to the heading; apply.
2165. **Template.** Try the five templates and colours; apply; the title is the notebook name.
2166. **Open notebook.** With the notebook open, change the cover; undo in the notebook restores the previous cover.
2167. **Failure.** Make the notebook read-only (open, locked) and apply an image: a notice says it failed and no new file stays in `_assets`.
2168. **Themes and phone.** Light, dark, "Follow Obsidian theme", phone and tablet: nothing overflows, targets are easy to hit.
2169. **Italian.** Switch the plugin language: the dialog and the menu item are translated.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Change cover: pattern, image (crop), page, template; stored as an image asset + `meta.coverArt` (no format change) | yes | crop maths, template wrapping and colours, `patchNotebookCover`: `tests/cover-crop.test.ts`, `tests/cover-template.test.ts`; dialog flow in the harness (`doc=covers`) | | | not tried on Android; the creation dialog keeps its own image option; a cover is not redrawn when the notebook is renamed |

### 0.22 — pagerefs: two-way page references (steps 2100-2119)

Roadmap #179. Settings, Pages, Outline: *Show pages that link here* (on by default). Use a notebook with several pages and text boxes that hold page links (*Copy link to page*, pasted into a text box). Implemented, not verified on hardware. Links to pages of other notebooks are not listed (only the open notebook is read).

2100. **Chip.** Page 3 has a text box with a link to page 7. Scroll to page 7 and stop: a small chip *Referenced on p. 3* appears at the top right after a moment; it never shows on a page nobody links to.
2101. **List.** Tap the chip: a short list of the referencing pages opens; a page that links twice says *2 links*.
2102. **Jump.** Tap a row: the view goes to that page and the list closes. Back (the notebook's back button) returns.
2103. **Close.** Tap outside the list or press Escape: it closes without jumping.
2104. **Reorder.** Move page 3 after page 7 in the page panel: page 7 still shows the chip, now with the new page number.
2105. **Deleted page.** Delete the page a link points to: no other page shows a chip because of it.
2106. **Self link.** A link on a page to itself adds nothing.
2107. **Edit.** Delete the link text on page 3: page 7's chip goes away; type a new link: it appears.
2108. **Sticky note.** A link inside a sticky note counts too.
2109. **Setting.** Turn the setting off: no chip.
2110. **Pen.** The chip and list never take pen input: writing under them still works around them.
2111. **Light, dark, phone.** Readable in light and dark and inside a phone's width; below the recent-symbols strip when it is shown.

| Feature | Implemented | Automated test | Verified on hardware | Experimental | To do |
|---|---|---|---|---|---|
| Two-way page references (#179): a chip "Referenced on p. 3, p. 12" on a page that other pages of the notebook link to (text boxes and sticky notes; by page id, so reordering keeps them), a list with a jump to each, setting to hide it; derived, nothing stored | yes | index by id, reorder, deleted pages, self links, many links, slices: `tests/page-refs.test.ts`; harness `doc=pagerefs` | | | links from other notebooks are not listed; no "Referenced" filter in the notebook map; not tried on a tablet |

### 0.22 — axes: instant axes (steps 2140-2159)

Implemented, not verified on hardware. No format change. Reference screenshots after `HARNESS_DOC=axes npm run harness:check`: `dev/harness/dist/shots/axes-*.png` (tablet and phone, light and dark).

2140. **L.** With the pen, draw an L about 4 cm tall and 5 cm wide (up, then right). A *Make axes* chip appears under the corner for nine seconds; tap it: the L is replaced by two arrows with ticks following the page grid and small numbers beside every second tick.
2141. **Undo.** One undo gives your L back, with no axes left; one redo makes the axes again.
2142. **Group.** Lasso the axes: they select together (one group); move them and the numbers follow.
2143. **+.** Draw a horizontal line, then a vertical one crossing it near the middle of both: the chip appears after the second line; taking it gives four-quadrant axes with negative numbers left and below.
2144. **Not axes.** A handwritten letter L or t, a T-shaped pair of lines, a curve and a short + give no chip.
2145. **Settings.** *Settings > Writing > L or + drawn as axes*: *Make axes* turns the gesture into axes by itself after a moment; *Leave it as ink* does nothing. *Ticks on axes* off gives plain arrows; *Numbers on axes* off keeps the ticks only.
2146. **Insert.** In the insert sheet choose *Axes*: four-quadrant axes appear where the pen last wrote on the page (the centre of the view if nothing was written), selected; one undo removes them.
2147. **Pen button.** Neither the side-button tap (radial menu) nor the drag (eraser) is affected; hold-to-snap lines still snap.
2148. **Languages.** In Italian the chip, setting and insert entry are translated.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Instant axes (#206): an L or a + (two lines) offered as axes, ticks from the page spacing, number labels, one group, one undo step; insert from the sheet; settings | yes | `tests/axes.test.ts` (L / + classification, tick placement, labels, group ids); harness scenario `axes` | | | offer after a real S Pen stroke on hardware |

### 0.22 — review fixes: data and interface (D1-D10, floating pills)

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Lecture header (Automatic) only on a page created by a forward edit: Undo / Redo never adds one, the redo stack stays | yes | service with a fake host, add / undo / redo / delete / undo: `tests/lecture-header-service.test.ts`; harness `doc=lecthead` | | | |
| An unknown tool name is read as a pen and counted; the strict write and check still refuse it | yes | `tests/serialize.test.ts`, `tests/model-v20.test.ts` | | | the original name is rewritten as `pen` on the next save (a backup is made first) |
| Style eyedropper: a ballpoint or shape stroke selects the ballpoint and the default nib | yes | `tests/colour.test.ts`, `tests/pens-ui.test.ts` | | | |
| Marker wet canvas allocated at the first marker stroke, released after 4 s idle, never kept for other pens | yes | lifecycle and allocation counts: `tests/lazy-wet.test.ts`; golden hashes of the old pens unchanged: `tests/pens-golden.test.ts` | | | first marker stroke after a release allocates one canvas (about 16-20 MB on a 2560 x 1600 tablet): latency not measured on a tablet |
| Colour-meaning dimming multiplies into the marker's alpha | yes | `tests/lazy-wet.test.ts` (setInk) | | | |
| Axes (Automatic): the 450 ms wait is dropped by the next contact, a scroll, a page change; never converts under the pen | yes | `tests/axes-tools-auto.test.ts` | | | |
| Digest by colour: the write re-reads the note and asks before appending to a note whose markers vanished | yes | `tests/colour-meaning.test.ts` (`replaceMeaningSectionChecked`) | | | the modal itself is shown by the real view only |
| Meanings sidecar keeps unknown legend fields and unreadable entries on rewrite until the legend is edited | yes | `tests/colour-meaning.test.ts` | | | |
| Cover: applies run one at a time; a picture in use is never trashed by a failed apply | yes | `tests/cover-assets.test.ts` | | | other closed notebooks that use the same picture are not scanned (only the notebooks read this session and the open ones) |
| Floating pills never overlap (tablet, phone): lecture chip shifts the top pieces, contextual bar lifts the bottom-left ones, a minimap parked bottom left pushes the pill and chip right | yes | `tests/dock-metrics.test.ts`; harness `doc=pillstack` (all pieces at once, bounds, pairwise overlap, list opened) | | | not tried on Android; a selection with several restyle rows makes the bar taller (it is measured, not assumed) |

### 0.22 — lecthead (automatic lecture header, #210; steps 2180-2199)

Manual steps (real Obsidian; nothing here is verified on Android). You need a class in the timetable for today that is on now and linked to the notebook (or unlinked, with a notebook named like the course), with a lecturer and a room.

2180. **Ask.** *Settings > Study > Timetable > Lecture header* = Ask. In the notebook, add a page: a small chip *Add lecture header* appears at the top left, under the lecture chip. Nothing is written until you tap it. Tap it: the course, and under it lecturer, room, date and start time, appear at the top of the page. One undo removes both boxes.
2181. **Close.** Add another page and close the chip with the cross: it goes away and does not come back for that page.
2182. **Automatic.** Set *Automatic* and add a page: the header is written at once and a short notice says so. Undo removes it in one step.
2183. **Never over your writing.** On a page with ink or a picture at the very top, run *Insert lecture header*: it sits just below them, clear of everything. With the top of the page full there is no free spot: a notice says so (the chip stays in Ask/Automatic) and nothing is written.
2184. **Fields.** Turn off *Room* and *Lecturer*: the next header has only the date and time. Turn all four off: only the course is written (one box).
2185. **Command.** In the command palette, *Insert lecture header* with a class in progress writes its header on the page in view. Outside class hours it uses the closest class of today; with no class today a notice says so. Running it twice does not add a second header.
2186. **Locked page.** Lock the page and run the command: a notice says the page is locked and nothing changes.
2187. **Lecture mode.** Start lecture mode from the banner on a notebook that already has a lecture page for today: no second header. Start it by hand (command) on a page that is not a lecture page: with Ask the chip appears.
2188. **Pen.** While the pen is on the screen (or just was), nothing is added or offered; the chip appears at the first pause.
2189. **Languages.** Switch the plugin to Italian: the setting, the chip, the notices and the date (*lunedì 26 ottobre 2026*) and the *Aula* label are in Italian. Switch back to English: *Room*, and the date in English.
2190. **Off.** With the setting Off nothing happens on a new page; the command still works.
2191. **Style.** Light and dark theme, phone and tablet width: the chip is a quiet pill that does not cover the page's top margin; the header text is small and grey under a slightly larger course line.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Automatic lecture header (#210): course, lecturer, room, date and start time as two grouped text boxes at the top, one undo step | yes | slot choice (in progress, lead time, overlap, linked to another notebook, no class, nearest), fields in English and Italian, free-area search, plan, History step and locked page: `tests/lecture-header.test.ts`; view and chip: harness `doc=lecthead` | | | not tried on Android; time zones are covered by the rule that class times are local wall-clock times, not by running under other zones |
| Setting Off / Ask / Automatic and the four fields; command *Insert lecture header* | yes | settings read: `tests/lecture-header.test.ts`; command and chip: harness `doc=lecthead` | | | |

### 0.23 — savedviews: saved views, document format 21 (roadmap #264; steps 2400-2419)

Implemented, not verified on hardware. **Format change: v20 → v21** (the optional notebook-level `views` list; a v20 notebook opens as before and is written as v21 the first time it is saved; a v21 notebook opens read-only in 0.22). Reference screenshots after `HARNESS_DOC=savedviews npm run harness:check`: `dev/harness/dist/shots/savedviews-*.png` (tablet and phone, light and dark).

2400. **Save.** Zoom in on a part of a page. Open the palette (or the *More* sheet) and run *Save current view…*: a dialog opens with the name field focused and a free name (*View 1*) ready. Type a name, press Enter or *Save*: the dialog closes and a notice says the view was saved.
2401. **Recall.** Scroll to another page and zoom out, run *Go to saved view…* and tap the view: the dialog closes and the same part of the page is on screen at the same zoom.
2402. **Another screen.** Rotate the tablet (or open the notebook on the phone) and recall the view: the same part of the page is centred, at the same zoom relative to the page width.
2403. **Save from the list.** In *Go to saved view…* type a name and tap *Save*: the list stays open and the new row is highlighted for a moment; the field offers the next free name.
2404. **Rename.** Menu `...` of a row > *Rename*: the name becomes a field; Enter keeps it (extra spaces are removed), Escape leaves the old name.
2405. **Reorder.** *Move up* / *Move down* change the order; the first row has no *Move up* and the last no *Move down*. The order is the same after closing and reopening the notebook.
2406. **Update.** Go somewhere else, open the list, menu > *Update to the current view*: the row now shows the new page and zoom; its name and place in the list stay.
2407. **Remove and Undo.** Menu > *Remove* takes the view out; close the dialog and Undo brings it back where it was. Rename, move, update and save are each one undo step too.
2408. **Deleted page.** Delete a page that has a view: the view stays in the list as *Page missing* (dashed row). A tap on it says the page is gone and nothing moves; its menu has no *Go to*; *Remove* takes it out. Undo the page deletion: the view works again.
2409. **Read-only.** Turn on read-only mode: the list still opens and a tap goes to a view; the field and *Save* are disabled and the menu only offers *Go to*. *Save current view…* refuses with a notice.
2410. **Locked page.** Lock the page a view is on: saving, renaming and removing views still work (a view is not page content).
2411. **Copies.** Duplicate a page that has a view, or copy / move pages to another notebook: no view is created for the copy and the views stay with the notebook they were saved in; pages moved out leave their views behind as *Page missing*.
2412. **Merge.** With a conflicted copy of the notebook that has views the main one lacks, *Merge conflicted copy* lists *N saved views added*; one Undo takes them away with the rest of the merge. If the copy renamed a view the notebook also has, the summary says *N saved views differ in the copy* (this notebook's are kept; the copy's versions stay in the copy). If the notebook already has 100 views, it says *N saved views of the copy were not added* and the copy stays where it is.
2413. **The file.** Close and reopen the notebook (and on another device with the same vault): the views, their order and their places are the same. On a notebook with more than 100 views a notice says to remove one before saving another.
2414. **Languages.** In Italian the commands, the dialog, the row lines and the notices are translated.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Saved views (#264): save the page, region and zoom under a name; recall; rename, update, reorder, remove, each one undo step; missing views; read-only recall | yes | model, commands, history, merge and geometry: `tests/model-v21.test.ts`; dialog and commands: harness `doc=savedviews` | | | not tried on Android |
| Format v21: optional `views` list, migration v20 → v21 (identity plus version), lenient read, strict write, staged loading of large v20 files, repair (also from the view lines when the array itself is damaged) | yes | `tests/model-v21.test.ts`, `tests/review-w23-data.test.ts` (review V3-V6: unique names, page-id limit, merge report, line-scan repair), `tests/format-schema.test.ts` (schema `docs/schema/notebook-v21.schema.json`) | | | |
### 0.23 — exportarea (written area and selection as transparent PNG or SVG, #280; steps 2300-2319)

Manual steps (real Obsidian; nothing here is verified on Android). Use a notebook page with several pen types, a text box with a `[[link|label]]`, and a collapsed sticky note with ink.

2300. **Page menu.** Open the all-actions sheet (Export & share): *Export written area…* opens the dialog. The same entry is in the notebook menu and the command palette.
2301. **Crop.** Choose *PNG*, 2x, *Save*: a file `<notebook> p<N> area.png` appears next to the notebook. Open it: transparent background (no white, no paper), cropped to your writing with a small margin.
2302. **Scales.** Export again at 1x and 3x: the pixel size scales; the notice names the path. A second export never overwrites the first (` 2`).
2303. **SVG.** Choose *SVG*: the Scale row hides. The saved `.svg` opens in a browser on a transparent background, strokes are vector; the highlighter stays see-through over the pen.
2304. **Pens.** Page with fountain pen, brush and marker strokes: each looks like on the page in the PNG and the SVG.
2305. **Selection.** Lasso some items: the bar has *Export selection as picture* (also in the sheet). The dialog offers *The selection* and exports only those items, cropped to them.
2306. **Collapsed note.** Select a collapsed sticky note and export: its hidden ink comes with it. On the whole page, a collapsed note does not widen the area with its hidden ink.
2307. **Labels.** The text box with `[[Note|label]]` shows the label, not the link source.
2308. **Empty.** On a page with nothing written, run the export: a notice says there is nothing to export and no file is written. Same for a selection of nothing drawable.
2309. **Locked page.** Lock the page: the export still works (read-only).
2310. **Copy.** Press *Copy*, paste into another app: the PNG arrives with a transparent background (SVG copies its source text). Where the device cannot copy pictures, a notice says to save instead.
2311. **Library inbox.** The saved picture is not offered by the shared-files inbox as an unknown file.
2312. **Style.** Light and dark, phone and tablet: the dialog is a normal Notebook dialog, the three buttons fit in one row.
2313. **Italian.** Switch to Italian: all texts are translated.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Export of the written area of a page (bounding box of visible ink and elements plus margin) as transparent PNG 1x/2x/3x or SVG, saved next to the notebook, optional copy to the clipboard | yes | bounds, margin, hidden ink, collapsed notes: `tests/export-area.test.ts`; harness `doc=exportarea` (real dialog, transparent PNG corner, SVG without sheet, empty refusal) | | | clipboard image copy depends on the WebView (`ClipboardItem`) |
| Export of the selection as transparent PNG or SVG (selected items and pinned note ink only; groups expanded by the selection; locked items fine) | yes | selection cut: `tests/export-area.test.ts` (SVG of each pen type, highlighter and marker alpha, wikilink label) | | | |
### 0.23 — dimcheck (dimensional analysis of formulas, #293; steps 2320-2339)

Manual steps (real Obsidian; nothing here is verified on Android). The hint lives in the equation editor (*Insert > Equation*, or *Edit* on an equation); it never changes the formula and never blocks *Done*. Units are written in the formula with `\mathrm`, `\text` or `\SI`.

2320. **A sum that cannot be.** Insert an equation and type `5\,\mathrm{m} + 3\,\mathrm{s}`. After a moment a quiet dashed line under the preview, with a ruler icon and the word *Units*, says that 5 m (length) and 3 s (time) cannot be added. The preview and *Done* work as always.
2321. **Equation sides.** Type `1\,\mathrm{N} = 1\,\mathrm{kg\,m/s}`: the hint says the two sides differ (force against momentum). Fix it to `1\,\mathrm{N} = 1\,\mathrm{kg\,m/s^2}`: the line turns into a green tick and *Units are consistent.*
2322. **Declared symbols.** Type three lines: `m = 2\,\mathrm{kg}`, `a = 3\,\mathrm{m/s^2}`, `F = m a = 6\,\mathrm{J}` (use `\` between them for a multi-line equation, or just new lines). The hint says force and energy differ. Change `J` to `N`: the tick. Declaring with `[v] = m/s` on its own line works too.
2323. **Quiet by default.** Type `\frac{a}{b} = \sqrt{x}` or `E = m c^2` (no units anywhere): no hint at all. A symbol the editor knows nothing about never causes a warning.
2324. **Functions and exponents.** `\sin(5\,\mathrm{m})` and `2^{3\,\mathrm{s}}`: the hint says the argument or the exponent must be dimensionless. `\sin(30^\circ)` and `\ln\frac{2\,\mathrm{m}}{4\,\mathrm{m}}` give no warning.
2325. **Prefixes and derived units.** `3\,\mathrm{m} + 2\,\mathrm{km} + 5\,\mathrm{cm}` is fine; `1\,\mathrm{J} = 1\,\mathrm{N\,m}`, `1\,\mathrm{V} = 1\,\mathrm{W/A}`, `1\,\mathrm{\Omega} = 1\,\mathrm{V/A}` are fine; `1\,\mathrm{J} = 1\,\mathrm{W}` is flagged.
2326. **Derivatives and integrals.** With `[x] = m`, `[t] = s` on their own lines, `v = \frac{dx}{dt} + 1\,\mathrm{m}` is flagged (velocity against length); `W = \int F\,dx` with `[F] = N` followed by `W = 3\,\mathrm{J}` is fine.
2327. **Many problems.** Five wrong lines: two sentences and *+3 more*; nothing else grows.
2328. **Setting.** *Settings > Writing > Check units in equations*: switched off, the hint never appears in a newly opened editor; on again, it returns.
2329. **Languages.** Italian: the label *Unità*, the sentences and the quantity names (*lunghezza*, *tempo*, *forza*, *energia*) are in Italian.
2330. **Layout.** Phone and tablet width, light and dark, with the on-screen keyboard open: the hint wraps inside the card, stays under the preview and above Size/Colour, and is easy to ignore; it is not a button.
2331. **Nothing stored.** Open an existing equation, type something with a unit mistake, press *Done*: the equation is saved exactly as typed; reopen it and the hint shows again. The file format is unchanged.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Dimensional analysis (#293): SI units and prefixes, derived units, propagation through + − × ÷ ^, roots, functions, fractions, derivatives, integrals and sums, `=` and comparisons, declared symbols | yes | `tests/dimensions.test.ts` (units, sums, products, powers, functions, equations, symbols, LaTeX forms, textbook formulas, plain text, hostile input) | | | |
| Quiet units hint in the equation editor, English and Italian, with a tick when units agree | yes | words, quantity names, cut list: `tests/dimension-hint.test.ts`; editor: harness `doc=dimcheck` | | | |
| Setting *Check units in equations* (Writing), default on | yes | `tests/dimension-hint.test.ts` | | | |
### 0.23 — chembal: balancing of typed chemical reactions (#294; steps 2340-2359)

Implemented, not verified on hardware. No format change. Reference screenshots after `HARNESS_DOC=chembal npm run harness:check`: `dev/harness/dist/shots/chembal-*.png` (tablet and phone, light and dark).

2340. **Text box.** Write the text box `CH4 + O2 -> CO2 + H2O` (type it) and select it with the lasso: the selection bar shows *Balance reaction*. Tap it: a preview shows the line before and after (`CH4 + 2 O2 -> CO2 + 2 H2O`). *Balance* replaces the text; *Cancel* changes nothing.
2341. **Undo.** One undo gives the original text back; one redo balances it again (a single step, also for several boxes at once).
2342. **Charges.** `MnO4^- + Fe^2+ + H^+ -> Mn^2+ + Fe^3+ + H2O` gives `MnO4^- + 5 Fe^2+ + 8 H^+ -> Mn^2+ + 5 Fe^3+ + 4 H2O`. Subscript and superscript letters (H₂O, Fe³⁺) work too and keep their look.
2343. **Hydrate.** `CuSO4·5H2O -> CuSO4 + H2O` gives `CuSO4·5H2O -> CuSO4 + 5 H2O`.
2344. **Several lines.** A box with a title line, two reactions and a note: only the reaction lines change; a line that cannot be balanced is listed in the preview with the reason and stays as it is.
2345. **Impossible.** `NaCl -> Na` says Cl appears on one side only; `H2 + O2 + H2O2 -> H2O` says more than one balance is possible; a typo such as `H2 + Xx -> H2O` names the unknown element. *Balance* is off when nothing would change.
2346. **Equation.** Insert an equation with the source `\ce{H2 + O2 -> H2O}` (or `H_2 + O_2 \rightarrow H_2O`), select it, *Balance reaction*: it becomes `\ce{2 H2 + O2 -> 2 H2O}` and is typeset again. With other maths on another line (`\ce{H2 + O2 -> H2O} \\ T_{max} = 300\,\text{K}`) only the reaction line changes: the preview also shows the whole resulting source, and the other line is kept exactly as written.
2347. **Locked.** Lock the text box: the action says the element is locked and nothing changes. Lock the page: a notice says the page is locked.
2348. **Not offered.** Select an ordinary text box, a picture or ink: no *Balance reaction* in the bar. The same command is in the command palette while a reaction is selected.
2349. **Languages.** In Italian the action, preview, reasons and notices are translated.
2350. **Style.** Light and dark theme, phone and tablet width: the preview is a narrow dialog with quiet rows; errors in the danger colour; nothing overflows.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Balancing of typed chemical reactions (#294): formulas with groups and hydrates, charges, electrons, arrows `->` `→` `⇌` `=`; exact rational nullspace, smallest whole coefficients; unbalanceable, one-sided, unused-species and ambiguous reactions are explained | yes | `tests/chem-balance.test.ts` (parsing, combustion, redox with charges, hydrates, impossible and ambiguous cases, text boxes, LaTeX, review V1: only the reaction lines of an equation are rewritten; review R4: a row of an aligned environment keeps its &) | | | |
| "Balance reaction" in the selection bar and the palette: preview, one undo step, refuses locked elements and locked pages; text boxes and equations (`\ce{}`) | yes | `tests/chem-tools.test.ts` (review V1 and V8: mixed equation kept, whole result previewed, refusal notice names the real reason); harness `doc=chembal` | | | not tried on the tablet |
### 0.23 — formulasheet: automatic formula sheet (#249; steps 2360-2379)

Formula sheet (roadmap #249). *Formula sheet…* (page sheet, notebook menu, command *Build formula sheet*) lists every equation of the notebook in reading order (LaTeX source and a page chip that jumps) and writes them into `<Notebook> — Formulas.md` next to the notebook: a heading with a link per page and a `$$…$$` block per formula (`\tag{n}` for a numbered one). Only the region between the `notebook-formulas` markers is rewritten; the notebook file is never written and the document format does not change. Implemented, not verified on hardware.

2360. In a notebook with equations on three pages (one numbered, two on the same row), open *Formula sheet…*. Expect: the formulas in reading order (rows top to bottom, then left to right), a chip per page with formulas; a chip closes the dialog and goes to that page.
2361. Tap *Build formula sheet*. Expect: a notice with the path and count; `<Notebook> — Formulas.md` next to the notebook, rendering each formula as maths in Obsidian, with a working link to each page.
2362. Add text above and below the generated region in that note, add an equation in the notebook, build again. Expect: the new formula appears; your text above and below is unchanged.
2363. Delete one of the two `notebook-formulas` marker lines in the note and build again. Expect: that note is not changed; the sheet is written to `<Notebook> — Formulas (2).md`.
2364. Create a note with the same name and no markers (or with only one marker line), then build. Expect: your note is unchanged and the sheet is written to `<Notebook> — Formulas (2).md` (a notice with that path); building again updates the `(2)` note.
2365. Open the notebook with no equations. Expect: the dialog says there are none and no note is created.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Formula sheet (#249): equations collected in reading order into `<Notebook> — Formulas.md` (`$$` blocks, link to each page, `\tag{n}` for numbered ones); owner marker with path and document id, only the region is rewritten inside `vault.process`, a note without markers, with an unpaired marker or recording another notebook is never rewritten, recorded in plugin-written | yes | collection order, escaping of `$` (also after a double-backslash line break, review V9), `-->` and blank lines, section, marker safety and note-name choice (a same-name note of the user's goes to `Formulas (2)`, review V10): `tests/formula-sheet.test.ts`; dialog and vault side: harness `doc=formulasheet` | | | one notebook at a time (no course/folder-wide sheet yet); formulas are written as LaTeX, typeset by Obsidian |
### 0.23 — welcomeback: welcome-back card (roadmap #420; steps 2380-2399)

Settings, Study, Timetable: *Welcome back card* (on by default) and *Offer it after* (hours, default 8). Implemented, not verified on hardware. Use a notebook with several pages, some question and gap markers (not resolved) and, for the slide case, an annotated PDF.

2380. **First time.** Open a notebook you never opened on this device: no card.
2381. **Quick return.** Close it and reopen it within the threshold: no card.
2382. **After a while.** With *Offer it after* at 1 hour, wait an hour (or set the clock) and reopen: a quiet card at the top centre says *Welcome back* and how long ago the notebook was last open.
2383. **Way back.** The first row reads *Continue on page N* (or *Continue at slide N* on a page that shows a PDF page). Tap it: the view goes to the page where you stopped; the card goes.
2384. **Questions and gaps.** Rows *Question, p. N* and *Gap, p. N* list the first two open ones of each, with their label when they have one; resolved ones are not listed; *and N more* is text, not a button. Tap one: the view goes to that marker.
2385. **Nothing to offer.** A notebook stopped on its first page with no open marker shows no card.
2386. **Pen.** Write the first stroke while the card is showing: the card goes and the stroke is drawn normally; the card never takes pen input.
2387. **Close.** The cross closes it; it does not return until the next opening after the threshold.
2388. **Stacking.** With the symbols strip on, a *Back to slide* pill showing and a *Referenced on* chip, the card sits below all of them, without covering any. Open the *Referenced on* list: the card steps aside.
2389. **Settings.** Turn the card off: nothing appears. Raise *Offer it after* above the time away: nothing appears.
2390. **Nothing written.** The notebook file is not modified by the card (no new revision, no sync traffic from it).
2391. **Italian, light, dark, phone.** The texts are in Italian with the plugin in Italian; the card reads in light and dark and fits a phone's width.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Welcome-back card (#420): after a configurable absence (per device, local storage, bounded), the way back to the stored position (slide N for a PDF page) and the first open questions and gaps as links; once per opening; hides on the first stroke | yes | threshold, first time, nothing to offer, resume and slide, open markers in reading order, shortening, bounded and corrupt store, away text: `tests/welcome-back.test.ts`; view, rows, stroke, close, settings, stacking: harness `doc=welcomeback` and `doc=pillstack` | | | not tried on Android; the look-up list and unchecked checkboxes are not part of the card yet |
| Settings *Welcome back card* and *Offer it after* | yes | settings read and range: `tests/welcome-back.test.ts` (hours) | | | |
### 0.23 — termorder (notebooks ordered by the active term, #416; steps 2420-2439)

Manual steps (real Obsidian; nothing here is verified on Android). You need a timetable with classes linked to notebooks or course folders, at least one with *From* and *To* dates around today.

2420. **Default.** With a class whose dates include today and no sort ever chosen, open the Library: the sort menu shows *Active term* checked, and the notebooks of the courses of the term come first, the course whose next class is soonest at the top.
2421. **Order.** Then come the notebooks of classes whose term is over (or not started), then the notebooks linked to no course. Inside each group the most recently changed first.
2422. **Your choice wins.** Pick *Last modified*, close and reopen the Library: it stays on *Last modified*. Pick *Active term* again: the term order returns.
2423. **No timetable.** Delete the timetable (or empty it): the sort menu has no *Active term* entry and the Library is by last change. A saved *Active term* choice falls back to last change.
2424. **Undated classes.** With only classes without dates, the default stays *Last modified*; *Active term* is in the menu and puts the linked notebooks first.
2425. **Manual order.** From the term order, drag a notebook: the order switches to *Manual order* as shown, nothing else changes.
2426. **Search and Italian.** A search is ordered the same way; in Italian the entry reads *Semestre in corso*.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Library sort *Active term* (courses of the term by next class, other courses, the rest); hidden without a timetable; default only with a dated term and no chosen sort | yes | pure ordering: `tests/term-order.test.ts`; order, menu and fallback: harness `doc=termorder` | | | |
### 0.23 — hookclean: clean-up of hooks and stray dots (#314; steps 2440-2459)

Manual steps (real Obsidian; nothing here is verified on Android or with a real S Pen). The synthetic strokes of the automated tests are perfect; the point of these steps is to see how real pen noise behaves.

2440. **Hooks.** With the pen, write a few lines and words quickly, lifting the pen as you normally do, until some of them end (or start) with a tiny tick. Lasso them and tap *Clean up strokes* in the bar: the ticks disappear, the lines are otherwise as written, and a notice counts hooks and dots. One *Undo* brings every tick back.
2441. **Real corners stay.** Write an L, a check mark, an arrow drawn in one stroke, a Z, a W, a circle and a cursive word, select them and run *Clean up strokes*: nothing changes and the notice says there was nothing to clean up. If a deliberate flick of yours is cut, note which pen and width it was (the rules are in `src/ink/hook-clean.ts`, `HOOK_RULES`).
2442. **Stray dots.** Tap the pen on the paper right after lifting it from the end of a line, so that a dot touches the end of the line. Select both and clean up: the dot goes. Write an *i* with its dot and a sentence with a full stop: they stay.
2443. **Other pens.** Repeat with the fountain pen (the nib angle is kept) and the brush; the highlighter and the marker are not touched.
2444. **Groups and locks.** Group a hooked line with another item and select only the line: the whole group is cleaned. Lock the page, select the ink and run the action: the lock notice appears and nothing changes. Unlock and run it again.
2445. **Hidden ink.** Collapse a sticky note that holds ink with a hook, select the note and clean up: the ink the note hides is never changed (review fix); open the note and the hook is still there.
2446. **Several pages.** Lasso across a page break and clean up: both pages are cleaned and one *Undo* undoes both.
2447. **Command and sheet.** *Clean up the selected strokes* in the command palette and *Clean up strokes* in the All actions sheet (Selection) do the same; without ink selected they are not offered.
2448. **Trim as you write.** Turn on *Settings > Writing > Trim hooks as you write*. Write many words: the little ticks at the end of the lines (a near reversal of a few points) are gone a moment after the pen lifts, the text still looks like your writing, and the pen feels no different (no extra lag). The exit tails of printed a, d and u stay. Press *Undo* once: the stroke you wrote comes back untrimmed and a notice says "Hook put back. Undo again to remove the stroke."; a second *Undo* removes it. Turn the setting off again: the ticks stay on new strokes. Strokes already written are never changed by the setting.
2449. **Languages and looks.** Switch the plugin to Italian: the action, the notice and the setting are translated. Light and dark theme, phone and tablet width: the action sits in the bar like the other selection actions.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Hook detection at the start and end of a stroke (sharp turn, short, straight run before it); real corners, arrows, circles, curves untouched | yes | `tests/hook-clean.test.ts` (synthetic strokes) | | | thresholds (`HOOK_RULES`) are tuned on synthetic strokes only |
| Stray-dot detection (single tiny mark, same style as the neighbour stroke, touching its end); i/j dots and full stops kept | yes | `tests/hook-clean.test.ts` | | | |
| Clean up strokes: one undo step, keeps ids, order, groups, nib; refuses a locked page; selection follows | yes | `tests/hook-clean.test.ts` (History: execute, undo, redo, locked page); harness `doc=hookclean` | | | |
| Selection action, palette command and sheet entry (`selection-cleanup`) | yes | registry tests (`tests/ui-registry.test.ts`); harness `doc=hookclean` | | | |
| Setting *Trim hooks as you write* (off by default): the stroke is committed as written and the trim is its own undo step (Undo gives the written stroke back, a second Undo removes it); stricter limits than the manual clean-up (near reversal, very short hook), so letter tails stay; live input and rendering untouched | yes | `tests/hook-clean.test.ts` (review V2: raw stroke kept in the history, page times, locked page, limits), `tests/commit-trim.test.ts` (the pen-up wiring the view calls: trim step after the commit, locked page, late side-button take-back of both steps, partial take-back), the first-Undo notice and the real pen path: harness `doc=hookclean`; settings read: `tests/hook-clean-settings.test.ts`; golden hashes unchanged: `tests/pens-golden.test.ts`; harness `doc=hookclean` | | yes | needs real pen data to judge |

### 0.24 — shapefill: filled shapes and dashed or dotted lines, document format 22 (roadmap #37; steps 2600-2619)

Manual steps (real Obsidian; nothing here is verified on Android or with a real S Pen).

2600. **Options.** Pick the Shape tool and tap it again: the options show *Fill* (No fill, Solid, Tint) and *Line* (Solid, Dashed, Dotted) under the shape kinds. With *Line* or *Arrow* the fill is not offered, only the line style. Choose Tint: the fill colours appear (the first, a ring, is "same as the line").
2601. **Draw.** Draw a rectangle and an ellipse with Tint and a colour: the inside is a light wash of the colour, the outline stays solid, and the paper pattern shows through. Solid covers the paper. Draw with Dashed and Dotted: the dashes follow the corners and the curve of the ellipse; a thicker line has longer dashes.
2602. **Live preview.** While dragging, the fill and the dashes show in the preview as they will be saved.
2603. **Restyle.** Lasso a few shapes and a handwritten word. The bar shows Fill and Line; change them: only the shapes change (the word never does), the selection stays, and one *Undo* puts the previous look back (*Redo* again). Lasso only lines and arrows: only *Line* is offered.
2604. **Recognised shapes.** Draw a rough rectangle, triangle or circle with the pen and hold the pen still until it snaps: it is a plain shape; select it and give it a fill and a dashed line from the bar.
2605. **Pick by the inside.** With the colour eyedropper in its style mode, tap the inside of a filled shape: the shape is taken (a plain shape is taken only by its outline).
2606. **Cut a shape.** With the segment eraser, erase part of a filled dashed rectangle: the pieces that remain are dashed lines without the fill.
2607. **Moving and scaling.** Move, rotate and scale a filled dashed shape with the selection handles: the fill follows, the dashes keep the length proportional to the (scaled) line width.
2608. **Groups, locks, locked page.** A filled shape in a group is restyled with its group. On a locked page the bar's change is refused with the lock notice.
2609. **Exports.** Export the page as PNG, SVG, PDF and as interactive HTML, and the written area or the selection as a transparent picture: fills (translucent tints too) and dashes are there, under the line, in the same places as on screen. Night mode only changes the colours on screen.
2610. **Thumbnails.** The Library card and the page navigator show the filled and dashed shapes.
2611. **Old files and other devices.** Open a notebook written by 0.23: it looks exactly the same and is saved as format 22. A copy of the plugin older than this version opens a notebook saved by this one read-only (it never rewrites it).
2612. **Languages and looks.** Italian (*Riempimento*, *Linea*, *Tratteggiata*, *Punteggiata*), light and dark theme, phone and tablet width: the rows fit, nothing is clipped.
2613. **Redo and background changes (review).** Restyle a shape (fill or dash), Undo, then Redo while a slide or margin refresh runs: the shape ends with the new fill and is not reverted. A filled shape whose ends are very close (a recognised rectangle) keeps its fill after being scaled up with the lasso. In *Compare with an earlier version*, a shape that only got a fill or a dash is listed as changed.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Format v22: optional `fill`, `fillTint`, `dash` of a shape stroke, migration v21 → v22 (identity plus version, stray keys dropped), lenient read (bad value dropped and counted), strict write, staged loading of large v21 files, repair, copies, merge, cut shapes | yes | `tests/model-v22.test.ts`, `tests/format-schema.test.ts` (schema `docs/schema/notebook-v22.schema.json`) | | | |
| Dash geometry (pattern scaled by the width, runs along corners), closed-shape test, fill polygon, picking a filled shape by its inside | yes | `tests/shape-style.test.ts` | | | |
| Fill and dashes drawn in the static layer, the live preview, PNG, SVG (also HTML and the area export), PDF and thumbnails; golden hashes of old strokes unchanged | yes | `tests/shape-style.test.ts`, `tests/pens-golden.test.ts`; harness `doc=shapefill` | | | the canvas and the PDF were not compared pixel by pixel on a device |
| Shape tool options (fill none / solid / tint with colours, line solid / dashed / dotted) | yes | harness `doc=shapefill` | | | recognised shapes (hold the pen) are drawn plain and styled afterwards from the bar |
| Selection restyle of fill and line: one undo step through `UpdateItems`, freehand ink untouched, refuses a locked page | yes | `tests/model-v22.test.ts` (History); harness `doc=shapefill` | | | |

### 0.24 — strokejoin: join broken strokes (#313; steps 2460-2479)

Manual steps (real Obsidian; nothing here is verified on Android or with a real S Pen). The synthetic strokes of the automated tests are perfect; the point of these steps is to see how a real pen dropout looks and whether the rules in `src/ink/stroke-join.ts` (`JOIN_RULES`) match it.

2460. **A real dropout.** Write long lines and words quickly until a line shows a tiny break (the pen skipped). Lasso the area and tap *Join broken strokes* in the second row of the bar: the break is closed, the notice says how many joints were made, the line is otherwise as written. One *Undo* brings the two strokes back.
2461. **Nothing else joins.** Write two words close together, an L and a V in two strokes, a dashed line, an *i* with its dot, a full stop after a word, and a letter written in two strokes (a *t* with its bar, an *x*): select everything and run the action. None of them is joined, and the notice says there was nothing to join (if one is joined, note the pen, the width and the gap).
2462. **A chain.** Press harder and faster to get a line cut in three or more pieces: they become one stroke in one step.
2463. **Pens.** Repeat with the fountain pen (the nib angle is kept) and the brush; strokes of different colours, widths or nibs are never joined; the highlighter and the marker are not touched.
2464. **Order and layers.** Draw a line, draw something else over it, then draw the continuation of the line: the pieces are not neighbours, so they are not joined. Bring the continuation next to the first piece with *Send to back* / *Bring to front* and they are.
2465. **Groups and locks.** Group a broken line with another item and select only the line: the whole group is considered and the group stays. Lock the page and run the action: the lock notice appears and nothing changes. Unlock and run it again.
2466. **Hidden ink.** Collapse a sticky note that holds a broken line, select the note and run the action: the ink the note hides is not changed.
2467. **Several pages.** Lasso across a page break and run the action: both pages are handled and one *Undo* undoes both.
2468. **Command, sheet and one stroke.** *Join broken strokes in the selection* in the command palette and *Join broken strokes* in the All actions sheet (Selection) do the same; with fewer than two strokes selected they are not offered.
2469. **Together with Clean up.** Run *Clean up strokes* and then *Join broken strokes* on the same selection: two separate undo steps. A hook cut by the first never makes the second join something it would not have joined.
2470. **Languages and looks.** Switch the plugin to Italian: the action, the command and the notices are translated. Light and dark theme, phone and tablet width: the action sits in the second row of the bar with the others and nothing is cut off.
2471. **Graph ink (review).** Pan a graph so that a line is cut at its frame edge in two strokes, one of them moved with the graph; select both and run *Join broken strokes*: they are not joined (a stroke bound to a graph is never joined with one that is not).

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Dropout detection between neighbouring strokes: same style and group, small gap relative to pen width, point spacing and piece length, continuous direction, no pressure jump; dots, words, corners, dashes untouched | yes | `tests/stroke-join.test.ts` (synthetic strokes, jittery wavy lines, negatives) | | yes | thresholds (`JOIN_RULES`) are tuned on synthetic strokes only |
| Join broken strokes: one undo step, keeps the first id, style, group, nib and position; chains; refuses a locked page; page times unmoved; hidden sticky ink and locked groups skipped | yes | `tests/stroke-join.test.ts` (History: execute, undo, redo, locked page, page times); harness `doc=strokejoin` | | | |
| Selection action, command and sheet entry (`selection-join`, from two strokes on) | yes | `tests/selection-arrange.test.ts`; harness `doc=strokejoin` | | | |

### 0.24 — palettectx: actions ordered by context (roadmap #424; steps 2480-2499)

Implemented, not verified on hardware. Obsidian's own command palette keeps its order (a plugin cannot change it); the plugin's *All actions* sheet (the grid button at the end of the toolbar) is what is ordered.

2480. **Plain page.** Open a notebook on a plain page with the pen: the sheet opens with *Recent* (if any) and the groups; there is no *For this page* section.
2481. **Eraser.** Pick the lasso and open the sheet: it starts with *For this page*, listing selection actions such as *Select by style* and *Select same tool*.
2482. **Selection.** Select some ink with the lasso: the section lists selection actions (those already in the selection bar are not repeated).
2483. **PDF.** On a PDF page the section offers reading actions (select text, dimming, crop); on an ordinary page it does not.
2484. **Lecture and side pane.** During a lecture the lecture actions come first; with the PDF side pane open the side-by-side actions do.
2485. **Presentation.** While presenting, navigation actions and *Present* come first.
2486. **Search.** Type a word that matches several actions: the ones that fit the current context come first, then recently used ones; the same word on another page type orders differently.
2487. **Rows work.** Every row in *For this page* runs its action; a toggle that is already on, a disabled action and a locked-page action are not listed.
2488. **Obsidian palette.** With no notebook open, the notebook commands (draw tools, page actions) are absent from Obsidian's command palette; with one open they appear.
2489. **Italian, light, dark, phone.** The section reads *Per questa pagina* in Italian and fits a phone's bottom sheet.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Context ordering of the *All actions* sheet (#424): *For this page* section and context-aware search ranking (selection, PDF page, tool in hand, lecture, side pane, presentation) on top of priority and recent use | yes | boosts per context, section content, search order, no repeats, disabled/visible left out, labels: `tests/context-rank.test.ts`; sheet at tablet and phone widths: harness `doc=palettectx` | | | Obsidian's own palette order cannot be changed by a plugin |

### 0.24 — iconhelp: explanation on long press of an icon (roadmap #429; steps 2500-2519)

Implemented, not verified on hardware. No format change. Manual steps (real Obsidian on an Android tablet or phone, finger):

2500. **Toolbar.** Hold a finger on the Eraser button for about half a second without moving: a small bubble appears under it with the name, one line on what it does and "Tap it again for its options". The eraser is not selected. Lift: the bubble stays a moment and goes.
2501. **Tap elsewhere.** Hold again, and with the bubble showing tap the page: the bubble goes at once and the tap does what it normally does.
2502. **Quick tap.** A normal tap on a tool still selects it; no bubble.
2503. **Swipe.** Put a finger on a button and slide away before half a second: no bubble, nothing pressed.
2504. **Undo, redo, pages panel, pen chip.** Each shows a bubble with its own sentence. Undo does not undo.
2505. **Quick actions.** A long press on a pinnable quick action still opens the pin menu (no bubble); same for the page indicator when quick tabs are on.
2506. **Selection bar.** Select some ink with the lasso; hold a finger on Copy, Group, Align: each explains itself and is not pressed. The bubble does not cover the icon and stays on screen on a phone.
2507. **Home.** On Home and in the library, hold the menu, filter, sort, view and bell icons: a bubble each.
2508. **Pen and mouse.** With the S Pen held on a toolbar button: no bubble, and the pen button rules (tap with the button held: radial menu; drag with the button held: eraser) behave as before. With a mouse: only the hover tooltip.
2509. **Setting.** *Settings > Appearance > Explain icons on long press* off: no bubble anywhere. On again: it works. Switch to Italian: bubbles are in Italian.
2510. **Looks.** Light and dark, tablet and phone: a quiet card with a small arrow, readable, never off screen.
2511. **Long hold on a button (review).** Hold a finger on Delete (selection bar) or on Undo for two seconds, then lift: the bubble shows and the button is NOT pressed, however long you held. Right after, a quick tap on the same button works at once.
2512. **New controls.** Hold a finger on: the Bookmarks chip on Home, *Bookmark in the global list* and *Global bookmarks* (page sheet), *Hand in…*, *Join broken strokes*, the layout button in the page panel header, and each Fill / Line button and fill colour swatch in the shape options and in the selection bar: each shows a bubble with its own sentence (Italian too).

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Long-press explanation bubble on toolbar, selection/contextual bar and Home icons (finger only; mouse hover and pen untouched), setting to turn it off | yes | timing, slop, who may start it, placement, texts in en + it, setting: `tests/long-press-help.test.ts`; real view with synthetic touch/pen/mouse events: harness `doc=iconhelp` | | yes | the real long press on a WebView is not simulated; the system context menu on some devices is suppressed while the bubble shows |

### 0.25 — toolfade: toolbar fades while writing (roadmap #399; steps 2720-2739)

Implemented, not verified on hardware. No format change. Manual steps (real Obsidian on an Android tablet or phone, S Pen):

2720. **Off by default.** Fresh install: write for a long time; the bars never dim. *Settings > Appearance > Toolbar while writing*: *Always shown* / *Fade while writing*; the delay and *First touch* rows only show when it is on.
2721. **Fade.** Choose *Fade while writing*, delay 2 s. Write continuously with the S Pen: after about 2 s the toolbar, the contextual bar and any floating pill (recent symbols, back-to-page, referenced-on, welcome-back, lecture header) dim to a faint ghost. Nothing moves or resizes; the page does not jump.
2722. **Return after writing.** Lift the pen and wait: about 2 s after the last stroke the bars come back smoothly. Pause shorter than that between words: they stay dim.
2723. **Short notes.** One quick word (under 2 s): the bars never dim.
2724. **Pen over a bar.** While dimmed, bring the pen near the toolbar without touching: the bars return.
2725. **First touch.** While dimmed, tap a tool with a finger: the bars return and the tool is NOT selected; tap again: it is. With *First touch only brings the bars back* off, the first tap presses at once.
2726. **Finger outside the page.** While dimmed, touch the page panel, the scrollbar area or any empty area outside the sheet: the bars return. A finger on the sheet (pan or zoom) or a resting palm does not bring them back.
2727. **Long press.** While dimmed, hold a finger on a toolbar icon: the bars return and, after half a second, the icon help shows; the button is not pressed.
2728. **Selection and dialogs.** Make a lasso selection or open any dialog: the bars stay fully shown even if you keep writing; closing the dialog lets them fade on the next long stroke.
2729. **Floating pills.** With the symbols strip, back-to-page pill and referenced-on chip on screen, all dim together and keep their stacking; none overlaps another when they return.
2730. **Pen button.** The S Pen side button rules (tap with the button held: radial menu; drag: eraser; mid-stroke press: ink) behave as before while the bars are dim.
2731. **Reduced motion.** With the Android *Remove animations* option on: the bars change state without a fade.
2732. **Looks.** Light and dark, tablet and phone: the dimmed bars are a quiet ghost, the restored bars are exactly as before. Italian texts in settings.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Toolbar, contextual bar and floating pills fade while the pen writes (delay setting) and return on a touch outside the page, a pen hover or a press on a bar; first touch only restores (setting); never fades during a selection or dialog; reduced motion | yes | state machine and restore rules: `tests/tool-fade.test.ts`; real view with synthetic pen/touch events: harness `doc=toolfade` | | yes | the real S Pen hover and palm behaviour on a WebView is not simulated |

### 0.24 — tagsuggest (tags suggested from context, #411; steps 2520-2539)

Manual steps (real Obsidian; nothing here is verified on Android). You need a timetable with a class linked to a notebook or its folder, and a folder with a few notebooks that have tags.

2520. **Notebook tags.** Open *Edit tags* (library notebook menu, or the command inside a notebook): under the tag chips a row *Suggested* shows up to six dashed chips, the course of the linked class first.
2521. **Sibling notebooks.** Tags that other notebooks in the same folder use appear as chips; a tag the notebook already has is not offered.
2522. **Content.** In a notebook with typed text that repeats a word (or a titled bookmark), that word shows as a chip; common words in English and Italian (*the*, *della*...) never do.
2523. **Markers.** With a question marker or a definition box in the notebook, *questions* / *definitions* are offered.
2524. **One tap.** Tapping a chip adds the tag to the list and removes the chip; *Save* writes it. Inside a notebook, *Undo* takes the tags back (same history as before).
2525. **Page tags.** Page panel, page menu, *Tags*: chips from the course, the notebook tags, that page's text and markers; a tap writes the tag into the field, *Save* is one undo step.
2526. **Spelling.** A course such as *Fisica 2* is offered as `Fisica-2` for notebook tags and as `Fisica 2` for page tags.
2527. **Off.** Settings, *Integration*, *Suggest tags* off: no chips in either editor. Italian reads *Suggerisci i tag* / *Suggeriti*.
2528. **One tap, one tag (review).** Link a class whose course has a comma or semicolon in its name (for example *Analysis I, Part 2*). In the page tag editor tap its chip: exactly one tag *Analysis I Part 2* is added.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Suggested tags in the notebook and page tag editors (course, sibling notebooks, frequent words, marker kinds); setting to turn off; no format change | yes | ranking, stop-words, normalisation, context: `tests/tag-suggest.test.ts`; editors: harness `doc=tagsuggest` | | | |

### 0.24 — navadapt: adaptive page navigator (roadmap #414; steps 2540-2559)

Manual steps (real Obsidian; nothing here is verified on Android).

2540. **Written notebook.** Open a notebook of handwritten pages and open the page panel: it is a compact list (number, title, time, small thumbnail). A page with typed text shows its first line; a bookmarked page shows the bookmark title; a page with neither shows "Page N".
2541. **PDF notebook.** Open an annotated PDF or slides: the panel is wider and the thumbnails are large and sharp.
2542. **Mixed notebook.** A notebook with some PDF pages and some written ones keeps the usual thumbnails.
2543. **Override.** Tap the layout button in the panel header: *Thumbnails*, then *List*, then *Auto* again. Close and reopen the notebook, and restart Obsidian: the choice is still there; another notebook is not affected.
2544. **Long notebook.** In a notebook of 500 or more pages open the panel in list mode: it opens at once, scrolls smoothly, and the current page is in view.
2545. **Everything still works in the list.** Tap a row to go to the page; drag a row to reorder (long press on touch); the star, the page menu, the lock mark, the select mode (check button, long press, Ctrl+click), the bookmark filter and the tag filter.
2546. **Looks.** Light and dark theme, phone width (the panel is a drawer) and tablet width, Italian.
2547. **Memory (review).** Scroll a 500-page notebook in the page panel from top to bottom and back, switch between List and Thumbnails a few times, and close the notebook: the app stays smooth and the memory does not keep growing; the thumbnails are drawn again on demand.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Classification of a notebook (PDF/picture share: large, written: list, mixed: usual) and the Auto / Thumbnails / List modes | yes | `tests/nav-adapt.test.ts`; harness `doc=navadapt` | | | |
| Per-notebook choice in bounded device-local storage (corrupt storage falls back to Auto) | yes | `tests/nav-adapt.test.ts`; harness `doc=navadapt` | | | |
| Compact list rows (number, title, time, small thumbnail), chunked build and offscreen rows skipped | yes | `tests/nav-adapt.test.ts` (title and time); harness `doc=navadapt` (520 pages) | | | the title is typed text or a bookmark title only, there is no handwriting recognition |
| Large thumbnails layout (wider panel, 240 px thumbnails, cached per page and width) | yes | harness `doc=navadapt` | | | |

### 0.24 — bookmarks: global bookmarks, pages from different notebooks in one list (roadmap #265; steps 2560-2579)

Implemented, not verified on hardware. No format change: the list is the sidecar `_meta/bookmarks-<device>.json`, never part of a notebook file.

2560. **Add.** Open a page, tap the page number to open the page sheet and *All actions*: *Bookmark in the global list* is there, unchecked. Run it: a notice says the page was added and the action is now checked. Run it again: the page is removed and the action is unchecked. The command palette has the same toggle.
2561. **Other notebooks.** Bookmark a page in each of three notebooks. Run *Global bookmarks* (palette, page sheet): one dialog lists the three, in the order they were added, each with its notebook name and page number.
2562. **Open.** Tap a row from another notebook: the dialog closes and that notebook opens at that page (in its existing tab if it is open). Tap a row of the notebook you are in: it goes to the page.
2563. **Home.** Close all notebooks and open Home: a *Bookmarks* chip with the count is in the chip row under the Continue card. Tap it: the same dialog opens. With no bookmarks the chip is not shown.
2564. **Rename and reorder.** Pencil on a row: type a name, *Rename*: the row shows it. The arrows move a row up or down (the first cannot go up, the last cannot go down); close and reopen the dialog: the order and names are kept.
2565. **Remove.** The bin on a row takes it off the list; the page and the notebook are untouched. Closing and reopening the app keeps the list.
2566. **Page deleted.** Delete a bookmarked page in its notebook, then open the dialog: the row is dashed with a *Missing* badge and says the page is gone. Tapping it opens the notebook at the nearest page; the bin removes it.
2567. **Notebook renamed, moved, deleted.** Rename a bookmarked notebook in the library, and move another into a folder (or rename a folder): the rows keep working and open the notebooks at their new places. Trash a notebook: its row is dashed, *Missing*, tapping it says the notebook was not found, and the bin removes it.
2568. **Two devices.** With the vault synced between two devices: a bookmark added on one appears on the other after the sync; one removed on one device does not come back from the other.
2569. **A file that cannot be read.** Damage `_meta/bookmarks-<device>.json` of this device (not valid JSON): adding a bookmark says the file could not be read and nothing was changed; the file is not overwritten (a copy named `bookmarks.unreadable-…` is kept next to it).
2570. **Read-only and locked pages.** On a locked page and in a read-only view the toggle still works (it does not edit the notebook).
2571. **Languages and looks.** In Italian the action, the dialog, the Missing badge and the notices are translated. Light and dark theme, phone and tablet width: the rows wrap, the four small buttons of a row stay 44 px targets that do not overlap the title.
2572. **Copy of a notebook (review).** Copy a bookmarked notebook in the file manager (same notebook id). Open the copy: its pages are not shown as bookmarked and bookmarking one adds a new row; the original keeps its own. Remove one of them: the other stays.
2573. **Notebook not synced yet (review).** On a second device, open the bookmarks list before the notebook has synced: the row says Missing and is not moved to another file; once the notebook arrives the row works again. Tapping a row whose notebook was moved without a rename event opens it and the bookmark follows it (only when exactly one notebook has that id).
2574. **Same page on two devices (review).** Bookmark the same page on two devices before they sync: after the sync it is one row, and removing it (from either device) removes it for good.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Global bookmarks (#265): toggle the page in view (page sheet, command), list of pages of all notebooks, tap opens the notebook at the page, rename, reorder, remove | yes | store and merge: `tests/bookmarks.test.ts`; dialog: harness (`doc=bookmarks`) | | | |
| Sidecar `_meta/bookmarks-<device>.json`: per-device file, latest wins, tombstones (90 days) and adoption, unknown fields and entries kept, unreadable or empty file never overwritten, listed in the library check's non-holders | yes | `tests/bookmarks.test.ts` | | | |
| Follows renamed and moved notebooks (rename events, one write per burst; found again by the notebook's id); a deleted page or a missing notebook shows as Missing and can be removed | yes | `tests/bookmarks.test.ts` (retarget, resolve); harness `doc=bookmarks` | | | |
| Home chip (count, opens the list) | yes | harness `doc=bookmarks` (rendered through `renderHome`) | | | not checked inside the real library view |

### 0.24 — handin: assignment hand-in (roadmap #334; steps 2580-2599)

Manual steps (real Obsidian; nothing here is verified on Android). Use a notebook with a few written pages, one blank page, a page with a gap marker, a page with an unticked checkbox and a page with a text box that says TODO.

2580. **Open.** Notebook menu or the all-actions sheet (Export & share): *Hand in…* opens the dialog. The same entry is in the command palette.
2581. **Pages.** The grid shows a picture of every page; only the page in view is ticked. *All* and *None* work; tapping a cell ticks or unticks it and the count follows.
2582. **Cover fields.** Your name is empty the first time; type it, export, reopen: it is remembered on this device (not in the notebook). The course is prefilled when the notebook is linked to a timetable class in progress. Assignment starts as the notebook name; the date as today.
2583. **Pre-flight.** Tick all pages: blank pages, open gaps, open questions, undone homework, unticked checkboxes, TODO notes and empty template boxes are listed with their page. Resolve one on the page (tick the box, fill the gap): after reopening, it is gone from the list.
2584. **Fix links.** Tap a row: the dialog closes and the notebook shows that page.
2585. **Leave out.** *Leave out the blank pages* unticks them and the blank rows disappear; the other rows stay.
2586. **Export anyway.** While anything is open the main button reads *Export anyway*; with nothing open it reads *Export PDF*. Both write the file.
2587. **The file.** `<notebook> hand-in.pdf` appears next to the notebook; the first page is the cover (name, course, assignment, date, page count, small rule), then the chosen pages in order. A second export is ` hand-in 2.pdf`, never over the first.
2588. **Share.** On a device with a share sheet the toggle *Open the share sheet afterwards* shows and opens it; elsewhere it is not shown.
2589. **Library.** The saved PDF is not offered by the shared-files inbox as an unknown file.
2590. **Empty choice.** Untick every page: the check says to choose a page and the export button is disabled.
2591. **Style.** Light and dark, phone and tablet: the dialog is a normal Notebook dialog; the grid scrolls, the buttons fit in one row.
2592. **Italian.** Switch to Italian: all texts are translated.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Hand in…: page grid with checkboxes, cover fields (name remembered per device, course from the timetable, title, date) | yes | page choice, cover layout and its PDF: `tests/hand-in.test.ts`; harness `doc=handin` (real dialog, remembered name, grid) | | | the page panel's own multi-selection is not read yet: the dialog starts on the page in view |
| Pre-flight: blank pages, open gaps/questions/homework, unticked checkboxes, TODO notes, empty template boxes, with links to fix and "export anyway" | yes | `tests/hand-in.test.ts`; harness `doc=handin` (rows, leave out, link) | | | |
| PDF with generated cover first, saved next to the notebook under a free name, recorded as plugin-written, optional share sheet | yes | harness `doc=handin` (written through a stand-in vault, second export `hand-in 2.pdf`, cover plus chosen pages) | | | share sheet depends on the WebView |

### 0.25 — areahl: area highlighter, document format 23 (roadmap #99; steps 2620-2639)

Manual steps (real Obsidian; nothing here is verified on Android or with a real S Pen). Use a notebook with a PDF page or a scanned picture page, and some handwriting on it.

2620. **Options.** Pick the Highlighter and tap it again: the options show *Stroke | Area* above the colours. Choose *Area*: the width row (and the snap-to-text row on a PDF page) goes. The all-actions sheet has *Area highlighter* (a check shows when it is on); with the highlighter in hand, or on a PDF page, it is near the top.
2621. **Draw.** On a scanned page drag from one corner of a block of text to the opposite corner: a translucent rectangle in the colour chosen appears, the text under it stays readable (it looks like highlighter ink, not a solid patch), and the rectangle follows your finger or pen live. Dragging up-left instead of down-right gives the same rectangle. A tap or a drag under about 2 pt adds nothing.
2622. **Below the ink.** Write over the rectangle with the pen and add a typed text box over it: the writing and the text are above the colour, never covered by it. Draw a second area that overlaps the first: the newer one is on top.
2623. **Colours.** Change the highlighter colour and draw again: the new area takes it. Select an area (lasso, or tap it with the Lasso tool): the bar shows the highlighter colours only; tap one: the area is recoloured, one *Undo* gives the old colour back (*Redo* again). A selection of an area and a pen stroke recolours only the area from the highlighter row.
2624. **Move, resize, turn.** Move an area; drag the corner handle of the selection frame: it grows or shrinks in proportion (very small or very large sizes stop at the limits). A quarter turn from the transform menu turns it 90 degrees (a rectangle again); the free rotation handle keeps it upright and the same size and only moves it round (ink turns, the highlight does not). Copy, paste and duplicate it; the copy sits on the other page or place.
2625. **Group and lock.** Group an area with a text box or some ink: selecting one picks all. Lock the area (selection bar): it can no longer be selected by a tap, moved, recoloured or erased, the *Locked items* list of the page shows it as *Highlighter area*, and unlocking it makes it editable again.
2626. **Eraser.** With the whole-stroke eraser (and the segment eraser) rub over an empty part of an area: the whole rectangle goes; *Undo* brings it back where it was. Write a letter inside an area and rub out the letter in one stroke of the pen: the letter goes and the area stays (an area taken at the start of that stroke comes back as soon as the pen reaches ink). With the eraser limited to *Pen* ink an area is spared; limited to *Highlighter* it goes even when you also rub out ink, limited to its colour it goes like the rule above. The area eraser removes the areas whose middle is inside its outline. A locked area is never erased.
2627. **Page lock and time.** On a locked page a drag in Area mode is refused with the lock notice. Drawing an area on a page updates the page's start and end time (the time shown by *Page info*).
2628. **Colour meaning.** Open a notebook with colour meanings and show only one meaning: areas of other colours are dimmed like highlighter ink.
2629. **Exports.** Export the page as PNG, SVG, PDF, as interactive HTML and the written area or the selection as a transparent picture, and make a hand-in PDF: the areas are there, in the same places and with the same translucency, under the ink; in the PDF and SVG the page text below stays readable. Night mode only changes the colours on screen.
2630. **Thumbnails.** The Library card and the page navigator show the areas; after drawing or erasing one the thumbnail follows.
2631. **Sheets.** Export a long page split into sheets (A4 split): a cut may pass through an area.
2632. **Hide annotations.** On a PDF page hide the annotations (*Reading*): the areas disappear with the ink and come back.
2633. **Save and reopen.** Close and reopen the notebook: the areas are where they were. Open a notebook written by 0.24: it looks the same and is saved as format 23. A copy of the plugin older than this version opens a notebook saved by this one read-only (it never rewrites it).
2634. **Merge and sync.** Draw an area on one device and open the notebook on another that also has changes: after the merge both devices have the area once.
2635. **Languages and looks.** Italian (*Evidenziatore ad area*, *Tratto | Area*), light and dark theme, phone and tablet width: the row fits, nothing is clipped. Hold a finger on *Stroke* or *Area* for the explanation.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Format v23: element `area` (x, y, width, height, color; sides 2 to 20000 pt), migration v22 → v23 (identity plus version), lenient read (bad area dropped and counted), strict write, staged loading of large v22 files, repair, merge, schema `docs/schema/notebook-v23.schema.json` | yes | `tests/model-v23.test.ts`, `tests/format-schema.test.ts` | | | |
| Drawing an area with the highlighter's *Area* mode (drag corner to corner, clamped to the page, live preview, one undo step, a too small drag adds nothing) | yes | geometry and history: `tests/model-v23.test.ts`; harness `doc=areahl` | | | the live drag was not tried with a real S Pen |
| Select, move, resize each side, quarter turn, recolour (highlighter colours), group, lock, copy, delete, undo | yes | `tests/model-v23.test.ts`; harness `doc=areahl` | | | |
| Eraser removes the whole area when the same gesture erased no ink (stroke and segment modes; selective filter; area eraser by centre; locked spared) | yes | `tests/model-v23.test.ts`; harness `doc=areahl` | | | |
| Order and look: above the background and the sticky notes, under equations, typed text and all ink; the highlighter's translucency and multiply; night look; dimmed by the colour-meaning filter | yes | render order in SVG, PDF and raster: `tests/model-v23.test.ts`; canvas and night look by harness `doc=areahl` screenshots | | | the canvas, the PDF and the night look were not compared pixel by pixel on a device |
| Every export and view of the page: PNG, SVG, PDF, HTML, area export, hand-in, thumbnails, navigator, sheets | yes | `tests/model-v23.test.ts` (SVG, PDF, raster, thumbnail signature, sheet obstacles) | | | |
| Page lock refuses it; page time stamped by adding one | yes | `tests/model-v23.test.ts` | | | |
| Action *Area highlighter* (all-actions sheet, context rank with the highlighter and on PDF pages, long-press explanations) | yes | `tests/context-rank.test.ts`, `tests/long-press-help.test.ts`, harness `doc=areahl` | | | |
### 0.25 — histpanel: action history panel (roadmap #84, panel only; steps 2640-2659)

Manual steps (real Obsidian; nothing here is verified on Android). Use a notebook with three pages. Persistent undo ("undo that survives reopening") is **not** part of 0.25: closing the notebook still empties the history.

2640. **Open.** The all-actions sheet (History) or the notebook menu: *Action history…* opens the panel. The command palette has *Action history: jump back to a point…*. Long-press the entry in the sheet: a bubble explains it.
2641. **The list.** Write two strokes on page 1, add a text box on page 2, move a selection, erase a stroke. The panel lists the steps newest first ("Stroke written", "Added: text box", "Selection moved or transformed", "Erased"), each with its page (*p. 2*) and when (*just now*, *5 min ago*, then the time of day). The newest step is highlighted and marked *Now*; the last row is *Start of the history*.
2642. **Go back.** Tap an older step: the notebook goes to the point just after it (the later steps are undone one by one), a notice says how many steps, the panel stays open and the undone steps are listed dimmed above the highlighted one.
2643. **Go forward.** Tap one of the dimmed steps: everything up to and including it is redone. Tap the top one: everything is back.
2644. **Start.** Tap *Start of the history*: every step the history holds is undone (the page you were on may disappear if you added it in this session; Redo/tap the top step brings it back). On a large notebook with hundreds of steps the jump goes on in short slices: the panel shows *Going to that step: N of M* and takes no tap until it ends, the page stays responsive, and the notice at the end is the same as for a short jump. Closing the notebook meanwhile stops it where it got to.
2645. **Refusal.** (Needs a lock that arrives from outside the history, e.g. synced from another device while this one is open; locking from this device is itself a step, and going back past it unlocks the page first.) With a lock on page 3 that was set after you wrote on it, tap an older step: the jump stops at the first step on the locked page, a notice says *Stopped after N of M steps*, the page lock notice shows, and nothing on the locked page changed. Unlock the page, open the panel again, tap the same step: the jump completes.
2646. **Same as Undo.** Keyboard Undo/Redo, the toolbar buttons and the panel all walk the same list: after a few Undos the panel shows them as dimmed rows.
2647. **Drawing.** With the pen down (or while a text box is being typed) a tap on a row first closes the text box; during a stroke it says *Finish what you are drawing first* and does nothing.
2648. **Read-only.** In read-only mode the panel lists the steps, says it is read-only and no row can be tapped.
2649. **Style.** Light and dark, phone and tablet: a normal Notebook dialog; rows are at least 44 px, the list scrolls, nothing sideways.
2650. **Italian.** Switch to Italian: all texts, including the step titles, are translated.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Action history panel: the undo and redo stacks as readable steps (title per command type, page, time, item count), current point highlighted, tap goes back or forward step by step through ordinary Undo/Redo, stops and says so when a step is refused; a long jump goes on in slices with a progress line | yes | titles of every command class and of every label in the source, jump back/forward/start, the same result in slices as in one go, locked page and guard refusals mid-way, read-only, rows: `tests/history-panel.test.ts`; a 500-step jump on 2,000 to 40,000 strokes: `tests/history-jump.perf.ts` (`npm run bench`); harness `doc=histpanel` (real view and dialog, notices, refusal, read-only) | | | no preview of the state at a step; the list shows the last 500 steps (the history limit) |
| Persistent undo (survives closing the notebook) | no | | | | not built: commands hold element objects by identity and private apply state, so they cannot be saved and re-attached to a freshly read notebook without a per-class serialiser plus a verified dry run; the history would also have to be saved at idle saves because Android can end the app without a close event. See the roadmap note |
### 0.25 — baseline: align to baseline (roadmap #93; steps 2660-2679)

Manual steps (real Obsidian; nothing here is verified on Android). Use a page of your own handwriting: two or three lines of words, written a little crooked on purpose (some words higher, some lower, some with g, p or y, an i with its dot, a comma and a full stop), plus an underline under one word and a small drawing.

2660. **Select and open.** Select the handwriting with the lasso. On a tablet-width window the second row of the selection bar shows *Align to baseline*; on a phone-width window it is in the All actions sheet (Selection) and in the command palette (*Align the words of the selection to a common baseline*). With a single stroke selected it is not offered.
2661. **Align.** Tap it: the words of each line move straight up or down until they sit on one baseline; nothing moves sideways; the letters keep their shape. A notice says how many words were aligned. The selection stays on the moved ink.
2662. **Descenders.** A g, p, y or q keeps its tail below the line (the word is not lifted by its tail); the bar of a T or an f does not make the word sit too high.
2663. **Punctuation.** The dot of an i, a comma and a full stop move together with their word and stay where they were relative to it.
2664. **Left alone.** The underline and the drawing are not moved. A word far from any line (more than a couple of letter heights) is not pulled onto it.
2665. **Two lines.** Two lines close together each get their own baseline; no word jumps to the other line.
2666. **Undo and redo.** One undo puts every word back exactly; one redo aligns again.
2667. **Twice.** Select the aligned lines and run it again: the notice says there is nothing to align and nothing moves.
2668. **Sloped line.** Write a line clearly uphill (about 5 degrees) with a little wobble: after aligning it is still uphill but straight; a line that is only wobbly becomes level.
2669. **Ruled paper.** Change the page to ruled paper, write words slightly off the lines, select and align: the words sit on the ruled lines (the notice says so). On blank or grid paper they go to the common baseline of their line instead.
2670. **Groups and locks.** Group two words and align: they move together, by the same amount. Group a word with a locked box and align: that word stays where it is.
2671. **Sticky note.** Collapse a sticky note that holds ink: its hidden ink is not moved.
2672. **Locked page.** Lock the page and try again: it refuses and says so.
2673. **Page time.** The page's time in the navigator does not change after aligning (the ink was moved, not written).
2674. **Help.** Long-press the button: the explanation appears and nothing is aligned until you tap again. Italian: all texts are translated.
2675. **Looks.** Light and dark, phone and tablet: the button sits in the second row like its neighbours and the icon is readable.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Align to baseline (#93): words found from stroke gaps, lines from baselines, descender-aware baseline, one straight baseline per line (level, or a clear slope kept), ruled paper snaps to the ruled line, rigid y-only moves in one undo step | yes | `tests/baseline.test.ts` (synthetic words with descenders, punctuation, two lines, slopes, ruled paper, groups, locks, pinned ink, undo, page times, jitter, a 20-line page); harness `doc=baseline` | | | rotation of a slanted line (translation only for now); not tried on real handwriting |
| Selection bar and sheet entry, command, long-press help, context ranking (higher on ruled paper), Italian | yes | `tests/selection-arrange.test.ts`, `tests/long-press-help.test.ts`, `tests/context-rank.test.ts` | | | |
### 0.25 — profiles: Lecture and Study writing profiles (roadmap #219; steps 2680-2699)
2680. **Chip.** Pen tool, tap it again for the options: next to the pen set chip there is a "Profile" chip (lightning icon), "No profile" at first. Long-press it: a help bubble explains it.
2681. **Lecture.** Chip, Lecture: the strip shows thin ballpoint pens, the chip says Lecture and is highlighted. Settings > Writing: Stabilization is 1; Default paper is Ruled. Create a new notebook: it starts on ruled paper.
2682. **Study.** Chip, Study: fountain pens on the strip, Stabilization 6, Default paper Grid. Write: lines are visibly smoother than with Lecture.
2683. **Nothing else changes.** Switch profiles on a notebook with writing: strokes, paper of existing pages and the page count do not change; undo history is unaffected. It also works on a read-only notebook.
2684. **Own profile.** Set pens, stabilization and paper as you like, chip > "Save current setup as a profile...", name it. Switch to Lecture, then back to your profile: everything returns. Chip > Update (with it active) and Delete work; Lecture and Study have no Update or Delete. Delete a profile, then save a new one right away: the new one shows the pens you saved, never the deleted profile's (ids are never reused). Deleting a profile also deletes the pen set it made; if a notebook, a folder or another profile still uses that set it stays and the notice says so. With all pen sets in use (24), switching to a profile that needs a new set says the pens did not change (the smoothing and the paper did).
2685. **Drift.** Move the Stabilization slider after switching: the chip goes back to "No profile".
2686. **Commands.** Command palette and All actions: "Writing profile: Lecture", "...: Study", "...: next" (cycles Lecture, Study, your own). During a class "Lecture" is at the top of "For this page".
2687. **Lecture mode.** Settings > Writing, "Lecture profile in lecture mode" on: start a lecture (manual or automatic): the profile becomes Lecture. Off: nothing switches.
2688. **Reopen.** Close and reopen the notebook and restart Obsidian: the active profile and your own profiles are still there.
2689. **Italian.** Switch to Italian: chip, menu, commands, help and setting are translated.
2690. **Phone and tablet, light and dark.** The chip wraps next to the pen set chip without overflow.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Built-in Lecture and Study profiles, own profiles saved from the current setup (pens, stabilization, paper), apply, update, delete (the pen set it made goes with it unless in use; ids never reused; a full pen set list is reported) | yes | `tests/writing-profiles.test.ts` (apply, save, limits, lenient reader, cycling, ids, set cleanup, notices); harness `doc=profiles` | | | optional toolbar density per profile |
| Chip on the pen options, commands, long-press help, context rank | yes | `tests/writing-profiles.test.ts` (actions, help, rank); harness `doc=profiles` (chip, switching, document untouched) | | | |
| Lecture mode switches to the Lecture profile (setting, off by default) | yes | `tests/writing-profiles.test.ts` (`switchOnLecture`); harness `doc=profiles` | | | |
### 0.25 — clipimage

Roadmap #277: Copy as image. Needs a real device; the harness (`doc=clipimage`) only stands in for the clipboard and the share sheet.

2700. **Selection bar.** Select some ink with the lasso on a tablet. The second row ends with *Copy as image*. Tap it: a notice says the picture was copied. Paste into a chat or mail app: the selection appears on a white background.
2701. **Page menu.** From the notebook menu or the All actions sheet choose *Copy written area as image* with nothing selected: the written area of the page (with a small margin, no paper) is on the clipboard. Paste it.
2702. **Setting.** Settings, Integration, *Background of copied pictures*: set it to Transparent and copy again; paste into an app that shows transparency (e.g. a note app with a dark page): the ink has no white box. Back to White: it has.
2703. **No image clipboard.** On a device or WebView that cannot copy pictures, the same action opens the system share sheet with the PNG, after a notice. Close the sheet without sharing: a notice says nothing was copied and no file is written. If the share sheet refuses because the tap is too old, one notice asks you to tap Copy as image again and no PNG is saved; the second tap shares.
2704. **No clipboard and no share sheet.** A PNG is saved next to the notebook and the notice gives its path.
2705. **Large area.** Select a very large area (several A4 pages tall on an infinite page): the picture is still copied, drawn a little smaller, and the notice says so.
2706. **Empty.** On an empty page the action says there is nothing written, and copies nothing.
2707. **Phone.** On a phone-width bar the button is not on the bar but is in the All actions sheet (long press on the bar's icons shows its explanation on tablets).
2708. **Italian.** Switch to Italian: all texts are translated.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Copy as image: written area / selection to the system clipboard as a PNG (2x, size capped), white or transparent background (setting, default white) | yes | size cap, routes and fallback order, action registry: `tests/clip-image.test.ts`, `tests/selection-arrange.test.ts`; harness `doc=clipimage` (stand-in clipboard: opaque and transparent corner) | | | image clipboard depends on the WebView (`ClipboardItem`) |
| Fallback when the device has no image clipboard: share sheet with the PNG, then a saved PNG, always with exactly one notice (a share that needs a new tap asks for one instead of saving) | yes | route order and the notice per outcome: `tests/clip-image.test.ts`; harness `doc=clipimage` (share, refused clipboard, saved copy, closed share sheet) | | | share sheet depends on the WebView |
### 0.25 — papersuggest: suggested paper for a new page (roadmap #409; steps 2740-2759)

Manual steps (real Obsidian; nothing here is verified on Android). Use a notebook you can freely add pages to, and for the course steps a timetable with a class in progress linked to that notebook.

2740. **A run.** Open a notebook whose last pages all use the same paper (for example grid) and tap **+**. The strip shows that paper first, highlighted, with the reason *Like the last 5 pages*. Nothing is added until you tap a chip.
2741. **A pattern.** In a notebook that alternates two papers (ruled, grid, ruled, grid), tap **+** on a grid page: the highlighted chip is the ruled page, reason *Alternating, like the last pages*. Tap it: a ruled page is added after the current one; one undo takes it away.
2742. **Most of the last pages.** With five ruled pages and one grid page among the last six, the ruled chip is highlighted with *Like most of the last 6 pages*.
2743. **Mixed notebook.** With three different papers in a row and no course, the strip is the usual one: no highlight, no reason.
2744. **Course.** With a class in progress linked to the notebook, add several pages of one paper (for example millimetre) while it is on. On a page of another paper, **+** now highlights millimetre with *Usual for <course>*. The habit is kept on this device only.
2745. **Setting.** Settings, *Pages*, *Suggest a paper for new pages* off: **+** shows the plain strip, nothing highlighted. On again: the highlight comes back.
2746. **Never forced.** Tap a different chip than the highlighted one, or *More…*: that is what happens; the suggestion only changes which chip is marked.
2747. **Slide strip.** Beside a PDF, the *Notes for this slide* chip stays first; the suggested paper is highlighted after it.
2748. **Looks.** Light and dark theme, phone width (chips stack, the reason stays on the chip) and tablet width, Italian (*Come le ultime 5 pagine*, *Di solito per <corso>*).

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Suggested paper highlighted in the "+" strip with a short reason (run, alternation, most of the last pages, course habit, whole notebook); setting to turn off; ranking returns candidates with scores and reasons so a profile paper can outrank history; no format change, notebooks are only read | yes | ranking, pattern, course store and strip merge: `tests/paper-suggest.test.ts`; harness `doc=papersuggest` (real view and strip) | | | the profile paper is not wired yet (the ranker accepts it as an extra candidate) |
### 0.25 — markedview: marked pages only in the page navigator (roadmap #419; steps 2760-2779)

Manual steps (real Obsidian; nothing here is verified on Android).

2760. **Button.** Open the page panel: a flag button sits in its header. Long-press it: the explanation appears (English and Italian).
2761. **Marked only.** Tap the flag, choose *Marked pages only*: the panel lists only pages that have a bookmark, a global bookmark, a marker (gap, question, homework, importance), ink in a colour with a meaning, an open checkbox or a page tag. Each page keeps its real number and shows a badge for why it is marked. A line under the header says *Marked pages only* and has a close button.
2762. **Kinds.** In the same menu pick kinds (each shows how many pages it marks): only those count. Picking none (or all) means every kind.
2763. **Layouts.** Switch the layout button between Thumbnails and List: badges show as icons under a thumbnail and with words in the compact list; both work with large PDF thumbnails too.
2764. **Go to page.** Tap a page: it opens that page (on a phone the drawer closes). Star, page menu, select mode and drag-to-reorder still work.
2765. **Empty.** Turn all marks off in a notebook: the panel says "Nothing marked here yet." quietly.
2766. **Follows changes.** Add a bookmark, a marker, tick the last open checkbox, add a global bookmark: the list updates (reopen the panel if a change is not shown at once).
2767. **Remembered.** Close and reopen the notebook, restart Obsidian: the choice is still there for that notebook; another notebook still shows all pages. The close button of the line shows all pages again.
2768. **Looks.** Light and dark theme, phone and tablet width, Italian.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Pure marked-page logic (kinds, reasons, counts) | yes | `tests/nav-marked.test.ts` | | | markers resolved (done) still count as marked |
| Per-notebook choice in bounded device-local storage (corrupt falls back to all pages) | yes | `tests/nav-marked.test.ts`; harness `doc=markedview` | | | |
| Marked-only list with badges, sub-filters by kind, empty message, long-press help | yes | harness `doc=markedview` | | | |

### 0.28 — linehandle: drag whole handwritten lines to reorder them (roadmap #256; steps 3240-3259)

Manual steps (real Obsidian; nothing here is verified on Android or with a real hand). Use a page with five or six lines of your own handwriting (different heights: some with tall and descending letters, some low), then: a line with a highlighter area behind it, a line with a text box or checkbox at its right end, a line with a locked element on it, a collapsed sticky note with ink beside a line, a grouped line, and a page with a drawing next to the lines.

3240. **Turn it on.** Page menu (page indicator, or a thumbnail's menu) or *All actions* > *Reorder lines*. A small handle (a grip) appears at the left of every handwritten line of the page in view; a bar at the bottom centre says *Drag a handle to move a line* with Up, Down and *Done*. Long-press the entry, a handle and each bar button: the explanation appears (English and Italian). The entry shows as switched on; the command palette entry toggles it.
3241. **Handles follow the page.** Scroll and zoom: the handles stay level with their lines. Write a new line with the pen: after you lift, its handle appears. Undo/redo and page changes keep them right. Scroll to another page: the handles are those of the page in view only (in two pages side by side, the page the page actions use).
3242. **Drag.** Drag the first handle down past two lines. While you drag, the line's outline follows your finger or pen, the lines it passes shift in their outlines to show where they go, and a dashed outline marks where it lands. Lift: the whole line (all its words, dots and accents) is at the new place, the lines in between moved up by the height of the moved line and the spacing between lines is as before. Nothing else on the page moved.
3243. **One undo.** Undo once: everything is back exactly. Redo does it again. The history panel shows one step, *Line moved*. The pages' times (the page info) do not change.
3244. **Up and down.** Tap a handle: the line is outlined and the Up and Down buttons switch on. Down moves the line one place; Up moves it back. Both are one undo step each; the chosen line stays chosen at its new place. Tap the handle again to unchoose it. With a keyboard: Tab to a handle, Arrow up/Arrow down move it.
3245. **Uneven heights.** Drag a tall line (ascenders and descenders) below a low line and the other way: the lines never touch or overlap, and each line keeps the gap that followed it.
3246. **Things that move with a line.** A highlighter *area* behind the line, a text box, a checkbox or a picture that sits wholly inside the line's strip, and a collapsed sticky note with its hidden ink, move with it, rigidly (same shape, size, pressure, colour). Ink hidden with *invisible ink* inside the line moves too.
3247. **Refused: locked element.** A line with a locked element on it has a dimmed handle; tapping it says that a locked element is on the line. Dragging another line onto it, or Up/Down onto it, is refused with the same message and nothing moves.
3248. **Refused: group.** A group wholly inside one line moves whole. A group that reaches into another line (or to an element elsewhere) makes the line refuse, with a message.
3249. **Refused: in the way.** A line with a drawing, a shape or a highlighter *stroke* across it is refused (*Something other than handwriting is on that line*). A line that would land on a drawing that stays put is refused (*would land on something that stays where it is*).
3250. **Locked page and read-only.** Lock the page: the handles are dimmed, a drag or the buttons say *This page is locked* and nothing moves. A read-only notebook does not start the mode (*This notebook is read-only*).
3251. **Leaving.** *Done*, the Escape key and the entry in *All actions* all leave the mode: no handles, no bar. Nothing is written by turning the mode on or off.
3252. **Writing alongside.** With the mode on, write with the pen between the handles: ink works as usual; the handles only take touches on themselves. The S Pen button rules (tap with the button held: radial menu; drag with the button held: eraser) are not affected.
3253. **Looks.** Light and dark theme, phone and tablet width, Italian (*Riordina le righe*, *Fatto*), the bar clear of the minimap, the contextual bar and the other pills.
3254. **Margin comments.** Add a margin comment on a line (a region around its words). Move that line: the comment region and its marker move with it and still point at the same words; one undo puts the line and the comment back. A comment whose region covers parts of two lines makes both lines refuse (*Something other than handwriting is on that line*).
3255. **Notes and hidden ink.** A collapsed sticky note beside a line, with ink that lies far below it: moving the line so that this ink would leave the page is refused (*would end up outside the page*); moving it elsewhere takes the note and its ink along. A highlighter stroke drawn across a text box or picture on a line makes that line refuse.
3256. **PDF and picture pages.** On a PDF or picture page the handles are dimmed and say that writing there stays on what it annotates; nothing moves.
3257. **The page changes under the drag.** Hold a handle, then (with another finger, or a keyboard on desktop) undo or write a stroke: letting go cancels the move with a notice and adds no history step.
3258. **Closing.** Turn the mode on, then open another notebook in the same tab: the handles and the bar are gone.
3259. **Long pages.** On a page with a hundred lines or so, scrolling with the mode on stays smooth and a drag follows the pen without lag.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Line planner: lines from the baseline analysis (pieces joined, same-row columns one line), bands, what moves with a line (line-pen ink, invisible line-pen ink, underline-like strokes, elements wholly in the band, a sticky note with its hidden ink, graph-bound ink), group/locked/busy/conflict refusals, locked page, crowding and page edge, pitch layout (spacing kept, uneven heights), rigid moves in one `UpdateItems` step, no page-time change, no format change; reach and extent checks, comments move with their line, states parts, PDF/picture pages and in-range overlaps refused | yes | `tests/line-reorder.test.ts`, `tests/line-reorder-review.test.ts` | | yes | |
| Handles layer (DOM over the canvas): handle per line, outlines and a landing slot while dragging, tap to choose, Up/Down buttons, keyboard, refusal messages, Escape/Done, bar, long-press help, registry action (page sheet and All actions), command, context ranking, history title | yes | `tests/line-reorder.test.ts` (registry, texts, ranking, history title); harness `doc=linehandle` | | yes | no auto-scroll while dragging near the page edge; not tried on Android; ruled paper is not snapped to the rules (pitches already are multiples when the lines sit on them) |

### 0.27 — macros: a sequence of actions on one button (roadmap #170; steps 3060-3079)

Manual steps (real Obsidian; nothing here is verified on Android or with a real hand). Use a notebook with two or three pages, one of them on plain paper.

3060. **Open the manager.** In *All actions* find the *Macros* section (after *View & input*) and tap *Macros…*; the same dialog opens from *Settings → Appearance → Macros* (*Open*) and from the command *Manage macros*. With no macro it says so and offers *New macro*.
3061. **Make a macro.** Tap *New macro*, type a name ("Maths page"), pick an icon, switch on *Show on the toolbar*. Tap *Add a step* and search: *pen*, then *Paper* (a choice appears: set *Dotted*), then *Bookmark*, then *Add page*. The list offers only safe actions: search for *delete*, *export*, *sync*, *trash*: nothing comes up. *Save* with no step says so.
3062. **Order.** Move a step up and down with the arrows (the first cannot go up, the last cannot go down); remove a step with the cross. Save: the list shows the name, the number of steps and *On the toolbar*.
3063. **The button.** The toolbar shows the macro's button (icon, name as its label) in the pinned places, also on a phone width. Press and hold it: the pin menu offers to unpin it. With three buttons already pinned the editor's switch is off and explains why.
3064. **Run it.** Tap the button: the pen is in hand, the page paper changes, the page is bookmarked, a page is added; one notice says *"Maths page: 4 steps done. One Undo takes them all back."*
3065. **One undo.** Undo once: the paper, the bookmark and the new page are all gone. Redo: all back. The history panel shows one step, *Macro run*.
3066. **Locked page.** Lock the current page and tap the button: it stops at the paper step with ONE notice ("Maths page stopped at step 2 (Paper: Dotted) … The 1 earlier steps are done"), the page is unchanged and no page was added. A locked element on the page also refuses a step that would move or change it.
3067. **Nothing selected.** Make a macro whose first step is *Duplicate selection* (Arranging the selection). With nothing selected, tap it: it stops at step 1 and says nothing was changed. Select some ink first and it works; in *All actions* it qualifies for *For this page* while ink is selected (shown when it is among the five best fits) and steps back when nothing is selected.
3068. **Run from the sheet and as a command.** *All actions → Macros* lists it (and finds it by name in the search); the command palette has *Macro: Maths page*, which you can give a hotkey. Rename the macro: the command and the button follow at once. Delete it (the question asks first): the button, the sheet row and the command disappear, and the pin is gone.
3069. **Read-only.** In read-only mode the macro buttons are not offered and the sheet row is disabled.
3070. **A macro from a newer version.** (Developer check) Add a step with an unknown action id to a macro in `data.json`: the editor shows it struck through with *Unavailable*, keeps it when you save, and a run skips it and says how many were skipped.
3071. **Limits.** Twelve macros, twenty steps each: the buttons that would exceed them are disabled with a line saying so.
3072. **Looks.** Light and dark, phone and tablet width, Italian (*Macro*, *Nuova macro*, *Aggiungi un passaggio*); long-press the editor's small buttons for their explanation.
3073. **Page steps follow each other (review fix).** In page-by-page mode make a macro *Next page, Next page, Paper: Grid, Bookmark*. Run it: the view lands two pages further (no turn animation during the run) and the paper and the bookmark are on the page you arrive at, not the one you started on.
3074. **Typing stays yours (review fix).** Type in a text box (or an equation) and, without closing it, run a macro that adds a page by hotkey or from the command palette. Undo once: the macro's page is gone, the text you typed is still there; Undo again takes the text back.
3075. **Honest report, not under the pen (review fix).** Run a macro whose only step is *Paper: Grid* on a page that already has that paper: the notice says that step changed nothing. With the pen on the page (hold it down) press the macro's hotkey: it does not start and asks to lift the pen first.
3076. **Nothing lost across versions (developer check).** Put 25 steps in one macro and 14 macros in `data.json`, unknown fields on a step and a macro, a step without a valid action id, then open and save the settings: the extra steps (`extraSteps`) and macros (`macrosExtra`) and the unknown fields are still in the file, the editor says how many steps are kept but not run. A macro with an invalid or doubled id gets the same new id at every start (hotkey and toolbar pin stay put) and its stored file is rewritten once; a toolbar pin of a macro that no longer exists is gone.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Macro data in the plugin settings: lenient reader (unknown action ids kept, bad entries dropped), bounds (12 macros, 20 steps, 32-character names), unique ids | yes | `tests/macros.test.ts` | | | |
| Explicit allow-list of safe actions (tools, pens, arranging a selection, page paper / size, pages); nothing that deletes, exports, shares, syncs or opens a dialog; unknown / blocked / value-less steps skipped | yes | `tests/macros.test.ts` (list pinned against the registry and the runners) | | | |
| Runner: steps in order through the tap entry point, context re-read per step, stop at a step that cannot run / is refused / throws with the earlier steps kept, one notice | yes | `tests/macros.test.ts`, `tests/history-group.test.ts` | | | |
| One undo step per run (`History.group` → `Batch` "Run macro"; guards of every step kept; refused step not part of it; a full undo stack gives up one entry for the group) | yes | `tests/history-group.test.ts`, `tests/macros.test.ts` (real History, locked page) | | | |
| Review fixes: open typing committed before the group, immediate page turns during a run, steps that changed nothing reported, no start under the pen, exceptions caught, unknown fields / extra steps / extra macros kept, stable repaired ids, orphan pins removed | yes | `tests/macros.test.ts`, `tests/page-mode.test.ts`, `tests/history-group.test.ts` | | | |
| Registry: macros in the sheet's own section, pinnable toolbar button (never ranked in by itself; kept on a phone), context rule, history title, long-press help | yes | `tests/macros.test.ts`, `tests/long-press-help.test.ts` | | | |
| Manager and editor on the modal shell (list, new / edit / delete with confirmation, icon, steps with values and order, toolbar switch, picker), settings row, command per macro | yes | harness `doc=macros` | | | commands in a real Obsidian not run here |

### 0.26 — opacity: opacity of ink, pictures and areas, document format 24 (roadmap #358; steps 2780-2799)

Manual steps (real Obsidian; nothing here is verified on Android or with a real S Pen). Use a notebook with a PDF or scanned page, a picture, and some handwriting.

2780. **Pen slider.** Pick the pen and tap it again: the options have an *Opacity* row (a small drop button, the slider, the value) at 100 %. Move the slider to about 40 % and lift: the value shows 40 %. Write a line: it is a lighter grey of the same colour (the page shows through); a line written before is unchanged. Each pen (ballpoint, fountain pen, brush, marker) and each shape does the same; the number is remembered while you change colour or width. Long-press the little button: the explanation appears (English and Italian); tapping it puts the pen back to 100 %.
2781. **While writing.** Write a long stroke that crosses itself with the opacity at 40 %: while the pen is down and after you lift, the stroke has the same strength (a crossing does not darken itself twice, and nothing flashes darker for a moment when the stroke settles). With the marker the 85 % look is kept, scaled.
2782. **Highlighter.** Pick the highlighter: its slider is its own (100 % is the usual translucent yellow). Lower it to 50 % and highlight a printed line: lighter than before, text still readable; two strokes overlapping each other darken as highlighter always did. In the night look the highlighter is fainter in the same proportion.
2783. **Area highlighter.** With the highlighter in *Area* mode drag a rectangle with the slider at 50 %: the area is lighter than one drawn at 100 %; the live rectangle while you drag already has the final look.
2784. **Selection.** Select some ink (lasso): the selection bar has the *Opacity* row. Move it: every selected stroke changes, one *Undo* puts them all back, *Redo* again. Different values in the selection show a dash instead of a number until you move the slider. The button puts the selection back to 100 %. Select a picture alone: the bar appears with the slider (a picture had no bar before). Select a text box together with ink: the text box is not changed.
2785. **Pictures.** Insert a picture, select it and lower its opacity to 30 %: it fades over the page (or over a PDF below it, or over another picture). A rotated picture fades the same. Copy and paste it, move it to another page, duplicate: the copy has the same opacity.
2786. **Areas.** Select an area highlighter and change its opacity; recolour it afterwards: the opacity stays.
2787. **Groups and locks.** Select one member of a group: the whole group changes. A locked area or picture is not changed by the slider (unlock it first). On a locked page the slider is refused with the lock notice.
2788. **Pen sets and favourites.** Save the pen at 40 % as a favourite (long press a slot, or the radial menu) and in a pen set: choosing it later brings back the colour, width and the 40 %. The star of the favourite shows as active only while the opacity matches. The style eyedropper on a faint stroke takes its opacity too.
2789. **Action.** All-actions sheet: *Opacity* is near the top with the highlighter in hand, or with ink, a picture or an area selected; choosing it opens the slider (the selection bar's when something is selected, else the pen's options) with the focus on it.
2790. **Exports.** Export a page with faint ink, a faint picture and a faint area as PNG, SVG, PDF, interactive HTML, the written area or selection as a transparent picture, copy as image, and a hand-in PDF: they show the same strengths as on screen; the highlighter stays multiplied (page text below still readable) in SVG and PDF.
2791. **Thumbnails.** The Library card and the page navigator show faint ink as faint; after changing an opacity the thumbnail follows.
2792. **Other tools.** Join broken strokes does not join two strokes of different opacity; the history panel names the step *Opacity changed* (*Opacità cambiata*); the version diff shows a stroke whose opacity changed as changed.
2793. **Save and reopen.** Close and reopen the notebook: all opacities are as they were. A notebook that never used the slider is saved without any opacity (open the file in a text editor and search for "opacity"). Open a notebook written by 0.25: it looks identical and is saved as format 24. A copy of the plugin older than this version opens a notebook saved by this one read-only (it never rewrites it).
2794. **Merge and sync.** Change the opacity of a stroke on one device and open the notebook on another that also has changes: after the merge the notebook has the stroke with its opacity once (a stroke whose opacity differs from the other copy's is kept as a different stroke).
2795. **Looks.** Italian (*Opacità*), light and dark theme, phone and tablet width: the row fits in the pen options and in the selection bar, nothing is clipped, the slider is easy to drag with a finger.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Format v24: optional `opacity` (0.05 to 1) on strokes of any pen, images and areas; migration v23 → v24 (identity plus version; a stray key is dropped), lenient read (out of range clamped, not a number dropped, each counted), strict write, staged loading of large v23 files, repair, merge key, copies, schema `docs/schema/notebook-v24.schema.json` | yes | `tests/model-v24.test.ts`, `tests/format-schema.test.ts` | | | |
| Opacity slider in the pen options (pen and its kinds, shapes) and the highlighter options (strokes and areas), separate values; new strokes and areas store it only below 100 % | yes | state, favourites, area creation: `tests/model-v24.test.ts`; harness `doc=opacity` | | | the slider was not dragged with a finger on a device |
| Opacity in favourite pens and pen sets (like the width), the radial menu's active mark, the style eyedropper | yes | `tests/model-v24.test.ts` | | | |
| Selection restyle: opacity of the selected ink, pictures and areas as ONE undo step (groups whole, locked elements and text skipped, locked page refused, titled in the history panel in both languages) | yes | `tests/model-v24.test.ts`; harness `doc=opacity` | | | |
| The look is the product with the pen's own translucency in every path: static canvas, live stroke, wet ink (inline opacity on the wet canvas, hidden when the static layer has the stroke), night look, PNG raster, area export, copy as image, hand-in, SVG, PDF (one graphics state per alpha, multiplied for the highlighter), HTML, thumbnails | yes | alphas, SVG, PDF and raster: `tests/model-v24.test.ts`; canvas, wet ink and night look: harness `doc=opacity` screenshots | | | the wet canvas of a translucent stroke and the canvas, PDF and night look were not compared pixel by pixel on a device |
| Golden render hashes unchanged (an absent opacity draws exactly as before) | yes | `tests/pens-golden.test.ts` | | | |
| Action *Opacity* (all-actions sheet, context rank with a selection of ink, pictures or areas and with the highlighter or a shape in hand, long-press explanations in English and Italian) | yes | `tests/model-v24.test.ts`, `tests/long-press-help.test.ts`; harness `doc=opacity` | | | |

### 0.26 — tidy: one-step page tidy-up (roadmap #238; steps 2820-2839)

Manual steps (real Obsidian; nothing here is verified on Android or with a real hand). Use a notebook page with several lines of your own handwriting written a little crooked, with different left margins and a few big gaps; then a ruled page. Keep a page with a picture, a text box and an underlined heading for the "leaves alone" steps.

2820. **From the page menu.** Open the page menu (page indicator or a thumbnail's menu) and choose *Tidy up page*. A small sheet opens: three rows with a checkbox each, a count on the right of each, *Keep paragraph breaks* under the last, and a *What will change* tile. Long-press the entry: the explanation appears (English and Italian).
2821. **Preview, then cancel.** Switch the rows on and off: the counts and the tile follow. Tap *Cancel* (or the close button): the page is exactly as before and nothing is in the history panel.
2822. **Tidy up.** Tap *Tidy up*: crooked words in a line sit on one baseline, the starts of the lines share one margin (an indent stays an indent), and a large hole between two paragraphs shrinks to about one blank line. A notice says how many words, line starts and gaps changed. The strokes only moved: same shape, size and pressure.
2823. **One undo.** Undo once: everything is back. Redo does it all again. The history panel shows one step, *Page tidied up*.
2824. **Second run.** Run *Tidy up page* again: the tile says *Nothing to tidy up with these choices* and the button is disabled.
2825. **On a selection.** Select a few lines with the lasso: the second row of the bar (tablet width) has *Tidy up*; on a phone it is in the All actions sheet. The sheet says how many strokes are selected; only they move, and they stay selected afterwards.
2826. **Keep paragraph breaks.** With it on, a gap of one blank line is kept and a bigger gap shrinks to one blank line. Off: every gap closes to the usual line spacing. Lines never touch or overlap.
2827. **Ruled paper.** On ruled paper the words go onto the rules, lines move by whole rules only, and the margin is the paper's margin line when your writing was next to it.
2828. **Leaves alone.** On a page with a picture, a text box, a shape, a highlighter stroke, a locked element, an underline under a line of text and a collapsed sticky note with ink: none of those move. A line that has an underline, a drawing or an object in its way stays where it is; the lines around it still tidy.
2829. **Locked page.** Lock the page: the sheet says *This page is locked* and *Tidy up* is disabled.
2830. **Remembered.** Switch a row off, close the sheet, open it again (and after restarting Obsidian): the choice is still there on this device.
2831. **Nothing selected.** With nothing selected, the command *Tidy up the selection or the page* (palette) opens the sheet for the page in view; with a selection it opens it for the selection.
2832. **Looks.** Light and dark theme, phone and tablet width, Italian (*Riordina*, *Riordina la pagina*).

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Tidy-up engine: words onto a baseline (existing engine), line starts onto a common margin (paper margin on ruled paper), oversized gaps closed with paragraph breaks kept, whole rules on ruled paper, rigid moves only, one undo step, no page-time change, no format change | yes | `tests/tidy.test.ts`: two paragraphs, crooked lines, big gaps, ruled paper, a locked box in the way, groups, hidden ink, areas, second run, one undo, page times, locked page | | yes | thresholds tuned on synthetic writing only |
| Sheet with the three steps, counts, summary, remembered choices, cancellable; selection bar (second row from tablet width) and sheet entry, page menu entry, command, long-press help, context ranking, history title | yes | `tests/tidy.test.ts` (registry, texts, ranking), `tests/selection-arrange.test.ts`; harness `doc=tidy` | | yes | not tried on Android; a line cut in two by the line finder is joined back by position only |

### 0.26 — smooth: smooth and straighten selected strokes (roadmap #66; steps 2800-2819)

Manual steps (real Obsidian; nothing here is verified on Android). Use your own shaky handwriting: a few words, a wobbly underline drawn freehand, an L or a check mark, a loop, and a highlighter stroke.

2800. **Where.** Select the handwriting with the lasso, open the All actions sheet (Selection): *Smooth strokes* and *Straighten strokes* are there (and in the command palette: *Smooth the handwriting of the selection*, *Straighten the almost-straight lines of the selection*). With only text, pictures or an area highlight selected they are not offered.
2801. **Smooth.** Run *Smooth strokes*: the tremor of the lines is gone, but the letters keep their shape, no line moves visibly away from where it was, the two ends of every stroke stay put, and a notice counts the strokes. The selection stays on the smoothed strokes.
2802. **Corners.** The foot of an L, the tip of a check mark and the corner of a printed letter stay sharp (they are not rounded off).
2803. **Pressure.** Strokes written with a pen that reports pressure keep their thick and thin parts exactly where they were.
2804. **Twice.** Run Smooth again on the same strokes: it changes them only a little more, never the shape; when nothing is left to smooth the notice says so.
2805. **Straighten.** Select a wobbly underline and a hand-drawn ruler line and run *Straighten strokes*: each becomes a clean straight line between its two ends. A curve, a loop, a zig-zag, a letter and a very short mark are left exactly as they were. The notice counts the straightened strokes.
2806. **Twice (straighten).** Run it again: nothing changes and the notice says so.
2807. **Left alone.** The highlighter, shapes (line, rectangle, ellipse), the marker, invisible ink, text boxes, pictures and area highlights are never changed, even when selected together with handwriting.
2808. **Groups and locks.** Group two strokes and select only one: nothing happens to them. Select the whole group: both are reshaped. A group that holds a locked element is left alone.
2809. **Sticky note.** Collapse a sticky note that holds ink: its hidden ink is not reshaped.
2810. **Undo and redo.** One undo puts every stroke back exactly (the history panel names the step *Strokes smoothed* or *Strokes straightened*); one redo does it again.
2811. **Several pages.** Select strokes on two pages (a lasso across a page boundary) and run it: both pages are reshaped, in one undo step.
2812. **Locked page.** Lock the page and try again: it refuses and says so.
2813. **Page time.** The page time in the navigator does not change after reshaping (the ink was edited, not written).
2814. **Saving.** Close and reopen the notebook: the reshaped strokes are as they were left.
2815. **Help.** Long-press each action in the sheet: the explanation appears and nothing happens until you tap again. Italian: all texts, the notice and the history title are translated.
2816. **Ranking.** With strokes selected the two actions come near the top of the sheet's *For this page*; on grid or plain paper Straighten is a little higher.
2817. **Looks.** Light and dark theme, phone and tablet width, Italian: the sheet rows look like their neighbours.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Smooth strokes (#66): Taubin smoothing of line-pen strokes, ends, point count and pressure kept, sharp corners held, bounded move per point, one undo step | yes | `tests/smooth.test.ts` (shape kept, ends fixed, corners, bounded re-runs, tools skipped); harness `doc=smooth` | | | the strength is fixed (no slider); tuned on synthetic jitter only, not on a real S Pen |
| Straighten strokes (#66): almost-straight strokes (bend under 7% of the chord, length under 1.12x the chord, no doubling back) become a line between their ends; idempotent | yes | `tests/smooth.test.ts`; harness `doc=smooth` | | | the thresholds are a guess; a very gentle curve may count as a line |
| Selection rules: whole groups only, locked elements, pinned sticky ink, hidden ink, graph-bound ink, shapes, highlighter and marker skipped; locked page refuses; page times untouched | yes | `tests/smooth.test.ts`; harness `doc=smooth` | | | |
| Sheet and command entries, long-press help, context ranking, history title (English and Italian) | yes | `tests/selection-arrange.test.ts` | | | the selection bar rows are full, so both actions are in the sheet and the command palette only |

### 0.26 — redact: redaction before export (roadmap #285; steps 2840-2859 and 2980-2988)

Manual steps (real Obsidian; nothing here is verified on Android or with a stylus). Use a notebook with a typed name and an account number on a page, handwriting over them, a sticky note, an equation and a picture; and one page on a scanned or PDF background with printed text. For the files, open them in another app (PDF reader, browser) and also search their text for the covered words.

2840. **Open.** Notebook menu, *Export…*: a row *Cover parts of the page* with a *Redact…* button. Long-press the button: the explanation appears (English and Italian). The *Apply the boxes* switch is not there while there are no boxes.
2841. **Draw.** Tap *Redact…*: a picture of the current page. Drag with the pen (or the mouse) over the typed name: a dashed outline, then the picture is drawn again and the name is gone under a black box. Drag over the handwriting too.
2842. **Finger.** With *Draw with finger* on, a finger draws a box; switch it off (long-press shows what it does): a finger scrolls the page and draws nothing. On a tall (infinite) page it starts off.
2843. **Edit.** The cross on a box removes it (the covered content comes back in the picture); *Undo last box*, *Clear page* and *Clear all* work; the arrows move between pages and the counts follow. A tap draws nothing.
2844. **Back in the dialog.** *Done*: the row says how many boxes on how many pages and the switch *Apply the boxes* is on, with a note about what happens to content and backgrounds.
2845. **PDF.** Export a PDF. Open it: black boxes where you drew; nothing of the covered words can be selected, searched or found by copying all the text; ink is cut at the box edges; the note, equation and picture under a box are gone, not just hidden. Delete the black box in an editor if you can: there is nothing under it.
2846. **Scanned or PDF page.** Export a page that has a PDF or scanned background: the page is one flat picture with the box burned in. The text of that page can no longer be selected (the trade-off); outside the boxes the page looks as before.
2847. **Other formats.** SVG (open it in a text editor and search for the covered words), interactive HTML, PNG images, *Background only* (the box is in the picture although no ink is drawn), *Ink only* (a transparent picture with the box), a page range, a clean copy, *Split into sheets* on an infinite page: none shows or contains what was covered. Print preview shows the boxes.
2848. **Switch off.** Turn *Apply the boxes* off and export: everything is there, and the boxes are still kept for next time. Turn it on again.
2849. **Other exports.** With the switch on: *Hand in…*, *Share page…*, *Export as Markdown* (the text of covered text boxes and the bookmark title of a covered page are not in the note), *Export written area / selection*, *Copy as image* and a quick page export from the page menu each cover the boxes and say so in a notice. Inserting a selection into a note or making a task from one shows the covered page too.
2850. **Selection.** Select a handwritten word that is partly under a box and *Copy as image*: only the part outside the box is in the picture; a box elsewhere on the page does not widen the picture.
2851. **Per device.** Close and reopen the notebook, restart Obsidian: the boxes and the switch are still there on this device; open the same notebook on another device: no boxes there. Open another notebook: none.
2852. **The notebook.** Nothing in the notebook changes: no undo step, no change in the file, the page looks the same on screen; the boxes appear only in the Redact preview and in exports.
2853. **Comments and header.** A margin comment anchored on a box is not in the PDF notes strip; a comment away from the box is. With a page header turned on for exports, a box over the header leaves the header out of that page.
2854. **Limits.** Draw more than 60 boxes on one page: a notice says so. A very large set does not slow the export dialog.
2855. **Not covered.** With boxes on, the dialog shows a line listing what is not covered (PDF annotations digest, Extract pages, the automatic PDF copy, backups, the companion note, Zettel cards, page embeds, PDF text you copy yourself, excerpts of other notebooks, the file title). *Export PDF annotations* and *Extract pages* ignore the boxes: this is by design and documented.
2856. **Long press.** In the Redact dialog long-press each of the arrows, the four buttons and a box's cross: each shows a bubble in the language of the interface.
2857. **Looks.** Light and dark theme, phone and tablet width: the dialog fits, the page fits the screen without sideways scrolling, the buttons wrap.
2858. **Italian.** Switch to Italian: all texts are translated.
2859. **Pen button.** While the Redact dialog is open the S Pen side button does nothing special on the preview (the dialog is not a notebook page).
2980. **Review fixes: wide text.** Type a line of capitals, then one of CJK or emoji, in a text box and put a box over its start only: the whole text box is gone from the PDF and the SVG.
2981. **Review fixes: excerpt.** Make an excerpt of a region of page 1 onto page 3, then cover that region on page 1 only: page 3 exported alone (SVG, written area) has no excerpt picture; the Redact preview of page 3 shows it gone too.
2982. **Review fixes: unreadable boxes.** In the developer console, `app.saveLocalStorage("notebook-redactions", "garbage")`, then reopen Obsidian and export: every path (Export… PDF, quick exports, Copy as image, Insert into note, book index, formula sheet, digests) refuses with a notice and writes nothing, and one notice per session says the stored boxes could not be read; another notebook is refused too. The dialog says the boxes cannot be restored; Escape leaves the notebook refused; drawing a box and *Done* saves exactly that box and exports work for that notebook only (also after a restart). *Reset redaction storage* asks for a confirmation, then every notebook exports without boxes. Also try `app.saveLocalStorage("notebook-redactions", {version: 2, notebooks: {}})`: the same refusal.
2983. **Review fixes: switched off.** With boxes kept but the switch off, a quick page export says once that the boxes are off; an export from the dialog does not.
2984. **Review fixes: digests and indexes.** With a box over a highlighted PDF word (an IBAN), the Highlights digest and the colour-meaning digest do not quote that word; the book index and the formula sheet leave out what is covered; the figures list's *Copy image* refuses a covered figure, a picture just beside a box, and an excerpt (also an excerpt of an excerpt) of a covered region of another page. A long capitals or CJK page header with a box over its end only is left out of the exported page.
2985. **Review fixes: API.** From the console, `app.plugins.plugins["notebook"].api.exportPdf(path)` with the switch on writes a PDF with the boxes; with damaged storage it fails with `export-failed`.
2986. **Review fixes: excerpts of this notebook.** Make an excerpt of a region of page 1 onto page 3, then move the ink of that region elsewhere on page 1 and box it there (the box does not touch the excerpt's region): every export of page 3 (PDF, SVG, PNG, written area) leaves the excerpt out, and the figures list's *Copy* refuses it. Remove every box: the excerpt is exported again. The switch's note in the export dialog says excerpts of this notebook are left out while it has a box; the not-covered list names *Copy as excerpt* into another notebook.
2987. **Review fixes: selection picture.** Type a long line of capitals or CJK in a narrow text box, box only its last line, select the text box with the lasso and use *Export written area* › *Selection*: the text is not in the picture.
2988. **Review fixes: storage.** With `app.saveLocalStorage("notebook-redactions", {"<id>": {on: true, at: 1, boxes: {"<page id>": [{x: 1}]}}})` (a box this version cannot read) that notebook's exports are refused and one notice says a copy was kept; `app.loadLocalStorage("notebook-redactions-unreadable").copies` lists it. In the Redact dialog of an unreadable notebook draw a box, undo it and press Escape: exports stay refused (nothing saved). With a readable notebook, draw a box, undo, Escape: the stored boxes are as before.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Boxes per page (draw, undo, remove, clear), lenient bounded model, per-notebook device-local storage (fails closed: damaged reads as unreadable and refuses exports, session copy in memory, read-back check, switched-on never evicted, hashed odd ids; an unreadable or foreign store is kept aside, never overwritten silently, refuses every notebook until Done or Reset), switch to apply | yes | `tests/redact.test.ts`, `tests/redact-store.test.ts`, `tests/redact-review.test.ts`; harness `doc=redact` (the real dialog and its row) | | | the reset button and its confirmation only through manual step 2982 |
| Ink cut at a box with the pen's reach; whole elements dropped (text, picture, equation, graph, box, note, marker, checkbox, excerpt); area highlighter cut round the box; comments, header, tags and states; ink bound to a dropped graph; hidden note ink | yes | `tests/redact.test.ts` (every rule, idempotence, original untouched) | | | text of a half-covered text box goes whole (documented) |
| A SECRET marker must not be in any byte of the PDF (text, note, equation, box title, comment, scanned background), SVG, interactive HTML, hand-in PDF, area picture and Markdown | yes | `tests/redact-export.test.ts` (each with a control that does contain the marker without redaction) | | | |
| PDF / picture background burned in (PDF, SVG, HTML, PNG, print, Markdown, share, area), also in a background-only export; the cached page is not changed | yes | burn plan and fake media in `tests/redact-export.test.ts`; pixels (PNG renderer, JPEG, area PNG) in harness `doc=redact` | | | pages with a PDF background lose their text layer (trade-off) |
| Where it applies: export dialog (switch decides), hand-in, share, Markdown, area / copy as image, quick page exports, pictures put into notes, highlights and colour-meaning digests (no PDF word a box touches), book index, formula sheet, figures' Copy image, API `exportPdf` | yes | `tests/redact-export.test.ts`, `tests/redact-review.test.ts` (each fix with a SECRET marker and its own control); harness `doc=redact` | | | not covered: PDF annotation digest, extract pages, auto PDF copy, backups, companion note, Zettel cards, page embeds, hand-copied PDF text, file title |
| Review fixes: pessimistic text measure (capitals, CJK, emoji; every character bounded, unknown ones widest), covered-source excerpts at any depth, state views and clean copy keep the boxes, pen reach by real nib width, checkbox label, header measured like text, redacted header for note pictures, figures' Copy only for kept elements, off hint | yes | `tests/redact.test.ts` (review fixes block), `tests/redact-review.test.ts`, `tests/redact-review2.test.ts` | | | view wiring (notices, refusals per path) only through harness and manual steps 2980-2985 |
| Review fixes, round 3: excerpts of this notebook left out while it has any box (also in Figures › Copy), selection picture boxes by redaction bounds, wider per-character bounds (DejaVu Sans symbols), Redact dialog never saves a net-unchanged set on Escape (nothing while unreadable), store: a set that loses boxes is unreadable, one bounded copy per distinct unreadable value, a failed first save does not refuse every notebook | yes | `tests/redact-review3.test.ts`, `tests/redact-store.test.ts` (T5, T6, T9 blocks) | | | manual steps 2986-2988; over-redaction of same-notebook excerpts is the documented trade-off |
| Long-press help (English and Italian) on every new control; Italian texts | yes | harness `doc=redact`; i18n parity tests | | | |

### 0.26 — zoomwidth: pen width follows zoom (roadmap #350; steps 2920-2939)

Implemented, not verified on hardware. No format change: strokes keep plain page-unit widths. Manual steps (real Obsidian on an Android tablet, S Pen):

2920. **Default.** *Settings > Writing > Pen width follows zoom* is off on a fresh install. Zoom in a lot and write: the line looks thicker than at fit width (as before).
2921. **On.** Turn it on, zoom in about 4x and write with the pen at width 3: the line looks like a width 3 line at fit width (about 3 px on screen); zoom out to fit and the same stroke is now much thinner on the page. Write again at the new zoom: it looks the same as before.
2922. **Live equals saved.** While writing, the live ink is as thick as the finished stroke: nothing jumps when the pen lifts.
2923. **Hint.** Open the pen options with it on: next to the widths a line reads "N px on screen · M on page × zoom"; pinch to zoom and the numbers follow. With it off the line is hidden.
2924. **Extremes.** At the lowest zoom the line does not become a blob; at the highest zoom it does not vanish (stored width is clamped to 0.1 to 48 page units).
2925. **Pens.** Fountain pen, brush and marker follow the same rule; the nib angle and pressure response are unchanged.
2926. **Shapes and highlighter.** Line, arrow and shapes, and the stroke highlighter, follow the rule. The area highlighter (a rectangle) and the eraser sizes are unchanged.
2927. **Old ink.** Turning the option on or off never changes strokes already written; undo, redo, export and another device show them as saved.
2928. **Looks.** Light and dark, tablet and phone: the hint fits in the pen options without moving the width buttons. Italian texts.
2929. **Content that takes the pen's style.** Stamps, graphs and axes drawn from the pen, ink of objects (boxes, markers, equations) and the text style use the plain chosen width, not the zoomed one: with the option on and the view zoomed in 4x, insert a stamp or a graph and its lines are the chosen width on the page (as with the option off). Only strokes written with the pen, the shapes and the highlighter follow the zoom.
2930. **With opacity.** The *Opacity* row of the pen options (0.26, #358) stays next to the width row and the hint; a stroke written with both stores the width divided by the zoom and the chosen opacity.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Pen width follows zoom (setting, off by default; stored width = chosen / zoom, clamped) | yes | `tests/zoom-width.test.ts`; harness `doc=zoomwidth` | | | |
| Pen options hint (on-screen width, "× zoom") | yes | harness `doc=zoomwidth` | | | |
| Content inserted from the pen style (stamps, graphs, object ink, text style) keeps the plain chosen width | yes | by construction (`penStyle` / `style` read `penWidth`); step 2929 | | | |
| Opacity row and the zoom hint together in the pen options | yes | harness `doc=zoomwidth` | | | |
| Cross-feature rules of the wave (opacity kept by smooth, tidy, join, redaction; palette ignores it) | yes | `tests/wave026-integration.test.ts` | | | |

### 0.26 — ctxpalette: context palette in the colour picker (roadmap #394; steps 2900-2919)

Manual steps (real Obsidian; nothing here is verified on Android).

2900. **Page row.** On a written page with ink in several colours, open the colour picker (colour row, last button). Under *Recent colours* an *On this page* row shows the colours used here, the most used first.
2901. **Elements count.** Add a text box, a marker and an area highlight in new colours and reopen the picker: they appear in the row; a sticky note's paper colour does not.
2902. **No repeats.** Pick a custom colour so it is in the recent colours: it is no longer in *On this page*. Two slightly different reds on the page show as one.
2903. **Slide row.** On a PDF page with colour in it, *From the slide* shows its main colours (not the paper white). Move to another page and reopen: its own colours show. Reopening on the same page is instant.
2904. **Written page.** On a page with no PDF or picture, there is no *From the slide* row; a page with no ink has no *On this page* row.
2905. **Tap.** Tap a swatch: the pen (or the highlighter, as for the toolbar swatches) takes that colour; the recent colours do not change.
2906. **Meanings.** With a colour meaning defined (Settings, colours with meaning), the swatch of that colour is a pill showing its label.
2907. **Help.** Long-press a swatch with a finger: an explanation of its row appears (English and Italian).
2908. **Not in the way.** Writing with the pen while the picker is open stays smooth; a large PDF page does not stall when the picker opens.
2909. **Looks.** Light and dark theme, phone and tablet width, Italian (*In questa pagina*, *Dalla slide*).

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Pure usage ranking, ΔE dedupe, dominant colours (median cut + k-means), cache | yes | `tests/context-palette.test.ts` | | | |
| *On this page* and *From the slide* rows in the colour picker, meaning labels, long-press help, no format change | yes | harness `doc=ctxpalette` (PDF page) and `doc=ctxpalettew` (written page) | | | the rows follow the page the picker was opened on (not a page turned to later) |

### 0.26 — gallery: dynamic gallery block in notes (roadmap #421; steps 2860-2879)
2860. **Insert.** In a Markdown note run "Insert gallery block": pick a page tag, a course (only offered when the timetable has classes), a marker, bookmarked, how many and the order. The preview shows the block; Insert puts it at the cursor on its own lines.
2861. **Reading view.** The block shows a grid of page thumbnails, each with the notebook name and page number. On a tablet several columns, on a phone two.
2862. **Live Preview.** Move the cursor out of the block: the same grid; move it into the block: the plain lines, editable.
2863. **Tap.** Tap a thumbnail: the notebook opens at that page (a page picked by bookmark or marker still opens the right page after pages moved).
2864. **Conditions.** Try `tag: #x`, `bookmarked` (notebook bookmarks and global bookmarks), `course: <name>` (a course of the timetable), `notebook: <path or name or folder>` (one notebook: its pages in order), `marked: question|homework` (any marker of those kinds, also resolved ones), `limit: 6`, `sort: title`. Several conditions must all hold.
2865. **Refresh.** With the note open, add a tag to a page in a notebook: within about a second after you stop writing the grid shows it.
2866. **Empty and errors.** A query with no match shows a quiet "No pages match" card; a misspelled key or value shows one readable red line naming it.
2867. **Writes nothing.** Reading view and Live Preview never change the note or any notebook file.
2868. **Looks.** Light and dark theme, phone and tablet width, Italian.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Query parsing, page selection, marker conditions (pure) | yes | `tests/gallery-query.test.ts` | | | |
| Gallery block grid, tap to open, empty and error states, refresh | yes | harness `doc=gallery` | | | |
| Thumbnails through the shared page thumbnail cache | yes | harness `doc=gallery` | | | |
| Command "Insert gallery block" with builder | yes | harness `doc=gallery` | | | |

### 0.26 — related: related handwritten pages panel (roadmap #422; steps 2880-2899)

Manual steps (real Obsidian; nothing here is verified on Android).

2880. **Open.** Run the command *Related handwritten pages* (command palette or All actions): a panel opens in the right sidebar. With no Markdown note open it says "No note open".
2881. **Links.** In a notebook text box write `[[Some note]]` (a note that exists), save, then open that note: the page appears first with the chip *Links here*.
2882. **Title, alias, tag, heading.** Write the note's title, one of its aliases (frontmatter `aliases`) or one of its headings in a text box; give a page a tag that the note has (or a parent or child of it). Each page appears with the chip *Title*, *Alias*, *Tag* or *Heading* and the matched text beside it; a page with several reasons shows `+n` and ranks higher.
2883. **Course.** In the timetable link a course to a folder of notebooks and put the note in that folder (or give it the course name as a tag, title or alias): the first page of those notebooks appears last with *Same course* (turn it off in Settings, Integration, *Related pages: same course*).
2884. **Open.** Tap a row: the notebook opens on that page. Open a second note: the panel updates by itself a moment later.
2885. **Link and embed.** Tap the link button of a row: the link of that page is copied (paste it in the note). Drag a row into the note: the page's embed is inserted at the drop point.
2886. **Thumbnails.** Every row shows the page; scrolling a long list stays smooth on the tablet (thumbnails are drawn one at a time).
2887. **Empty and refresh.** A note nothing relates to shows "Nothing related yet". The refresh button reads the notebooks again; long-press it and the link button: the explanations appear (English and Italian).
2888. **Read-only.** Nothing in the vault changes while the panel is open (no file is written; the library index may be refreshed as the page switcher does).
2889. **Looks.** Light and dark theme, phone and tablet width, Italian; the panel in the left sidebar and as a tab.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Pure ranking (links, title, alias, tag, heading, course; caps; ties) | yes | `tests/related-pages.test.ts` | | | |
| Side panel (thumbnail, notebook, page, reason, open, copy link, empty states, debounced update) | yes | harness `doc=related` | | | |
| Drag a row into the note (embed text) | yes | harness `doc=related` (drag data only) | | | drop into the editor not tested in a real Obsidian |
| Setting *Related pages: same course* | yes | `tests/settings-schema.test.ts` | | | |
| The panel's read-only refresh writes nothing; what it read is saved by the next page-switcher refresh, one entry per path, never over a newer index entry nor for a notebook deleted since | yes | `tests/page-directory-save.test.ts` | | | |

### 0.27 — taper: stroke taper at the start and the end of a line, document format 25 (roadmap #351; steps 3000-3019)

Manual steps (real Obsidian; nothing here is verified on Android or with a real S Pen). Use a notebook with some handwriting and a pen you like.

3000. **Options.** Pick the pen and tap it again: under the colours, the width and the *Opacity* row there is a *Taper* row: a round button, the name, a small picture of a stroke, and two sliders, *Start* and *End*, both *Off*. Long-press the round button: the explanation appears (English and Italian). Pick the fountain pen and the brush: the row is there. Pick the marker, the highlighter (stroke and area) or a shape: no *Taper* row.
3001. **Picture.** Move *Start* and *End*: the little picture changes at once (a pointed start, a pointed end), before you lift your finger; lifting applies the value (*Off* or a percent).
3002. **Write.** Set *Start* to about 50 % and *End* to about 100 % and write a long line, then a short word: the line begins thin and swells to its normal width and ends in a long point; the word tapers at both ends and is still readable. While the pen is down the start is already thin, from the first sample, and the dot at the pen tip is thin too; at the lift the end settles into its point in one step, with no fat tail or notch left behind (a small change at the very end is expected; in a stroke shorter than about twice the start taper the start also grows a little at the lift, because the start taper is then shortened to half the stroke). A dot (tap the pen) is still a dot.
3003. **Width.** Write the same line with a fine and a broad pen at the same taper: the point looks the same, longer on the broad pen (the taper is a length in line widths). Write with the pen at the largest taper on a short stroke (about a finger long): it becomes a leaf shape, thin at both ends and full in the middle.
3004. **Each pen.** Try the ballpoint, the fountain pen (the nib angle still makes the line thinner along the nib) and the brush (its soft ends and the taper add up). A line written before the change is unchanged.
3005. **Reset.** The round button puts both ends back to *Off*. A stroke written afterwards has full width to the end. Open the file in a text editor and search for "taper": only the strokes you tapered have the two keys.
3006. **Favourites and pen sets.** Save the pen with its taper as a favourite (long press a slot, or the radial menu) and in a pen set; pick another pen, then the favourite: the taper comes back. The favourite shows as active only while the taper matches. The style eyedropper on a tapered stroke takes its taper too; on a marker or highlighter stroke it clears the taper.
3007. **Eraser.** With the segment eraser cut a tapered stroke in the middle: the piece with the start keeps the pointed start, the piece with the end keeps the pointed end, the pieces next to the cut have flat ends. Erase a whole tapered stroke and undo: it comes back tapered.
3008. **Selection.** Select tapered strokes, move them, scale them up and down, rotate, copy and paste, duplicate the page, move a page to another notebook: the taper is the same (it scales with the line). Smooth strokes and Straighten strokes keep it.
3009. **Join and shapes.** Two strokes split by a pen dropout are joined by *Join broken strokes*: the result starts as the first started and ends as the second ended. Hold the pen still at the end of a stroke written with a taper so it turns into a shape: the shape has constant width.
3010. **Exports.** Export a page with tapered strokes as PNG, SVG, PDF, interactive HTML, copy as image, the written area as a transparent picture and a hand-in PDF: the points look the same as on screen. Zoom the page far out: the points stay (no blobs at the ends).
3011. **Thumbnails.** The Library card and the page navigator show the tapered strokes; after a page changes they follow.
3012. **Redaction.** Cover a part of a tapered stroke when exporting: the visible parts keep their points at the real ends of the stroke only; the cut ends are flat and nothing of the covered part is left.
3013. **Night look.** The tapered strokes are drawn the same in the night look and with a coloured paper.
3014. **Save and reopen.** Close and reopen the notebook: the tapers are as they were. A notebook that never used the *Taper* row is saved without any taper key. Open a notebook written by 0.26: it looks identical and is saved as format 25. A copy of the plugin older than this version opens a notebook saved by this one read-only (it never rewrites it and keeps a backup).
3015. **Merge and sync.** Write a tapered stroke on one device and open the notebook on another that also has changes: after the merge the stroke is there once with its taper.
3016. **Looks.** Italian (*Rastremazione*, *Inizio*, *Fine*), light and dark theme, phone and tablet width: the row fits in the pen options, the sliders are easy to drag with a finger and nothing is clipped; the buttons are at least 40 px (44 px on touch).
3017. **Version history and diff.** A snapshot with a tapered stroke restores tapered; the visual version diff shows a stroke whose taper changed as changed.
3018. **Large notebook.** Open a large notebook (hundreds of pages) written by 0.26: it opens as fast as before (staged loading) and a page with many tapered strokes scrolls and zooms smoothly on the tablet.
3019. **Writing feel.** Write quickly with a taper of 100 % on both ends for a few minutes: the ink follows the pen with no extra delay compared with *Off*.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Format v25: optional `taperStart` and `taperEnd` (0.05 to 1) on pen, fountain pen and brush strokes of render 2; migration v24 → v25 (identity plus version; a stray key is dropped), lenient read (out of range, not a number or on a stroke that cannot taper: dropped and counted, the stroke stays), strict write, staged loading of large v24 files, repair, merge key, copies, version diff, schema `docs/schema/notebook-v25.schema.json` | yes | `tests/model-v25.test.ts`, `tests/format-schema.test.ts` | | | |
| Engine: the start taper in the radius of each point as it is added (causal, so the wet ink thins from the first sample), the end taper at the lift, short strokes shorten it, a dot is a dot; a taper is a length of `value * 12` line widths | yes | `tests/model-v25.test.ts` | | | the end settling at the lift was not seen with the real pen |
| The same shape in every path: static canvas, live fallback, level of detail (zoomed out and thumbnails), PNG raster, SVG, PDF, HTML | yes | `tests/model-v25.test.ts`; harness `doc=taper` | | | |
| Golden render hashes unchanged (an absent taper draws exactly as before) | yes | `tests/pens-golden.test.ts` | | | |
| Taper row in the pen options (two sliders and a picture drawn by the engine) for the pen, the fountain pen and the brush; new strokes store it only when set | yes | state, favourites, strings: `tests/model-v25.test.ts`; harness `doc=taper` | | | the sliders were not dragged with a finger on a device |
| Favourite pens, pen sets, the radial menu's active mark and the style eyedropper keep the taper | yes | `tests/model-v25.test.ts` | | | |
| Cuts keep a taper only at a real end of the stroke (eraser pieces, redaction pieces); joining keeps the first start and the last end; a recognised shape loses it | yes | `tests/model-v25.test.ts` | | | |
| Editing the taper of strokes already written (from the selection bar) | | | | | not part of this item: the taper is a property of new ink |

### 0.27 — inputlayout: layout by input device (roadmap #431; steps 3080-3099)

Implemented, not verified on hardware. No format change. Manual steps (real Obsidian on an Android tablet with S Pen; step 3086 on Windows):

3080. **Setting.** *Settings > Appearance > Adapt layout to input* offers Automatic (default), Pen, Finger, Mouse and keyboard; search finds it by "finger" or "dito".
3081. **Pen (default).** Open a notebook and write with the S Pen: the toolbar is the compact one you know; nothing moves while you write.
3082. **Finger.** Touch the toolbar or the page with a finger three times (tap tools, pan): the toolbar buttons grow one size and gain spacing; the page does not jump and a stroke in progress is never interrupted.
3083. **Back to the pen.** Hover the S Pen over the page for a moment: the compact toolbar returns.
3084. **Palm.** Write with the pen while resting the palm on the screen: the toolbar never switches to the finger layout.
3085. **Pinned.** Choose Finger: the large layout stays whatever you use; same with Pen and Mouse.
3086. **Mouse and keyboard (Windows or a USB mouse).** Move the mouse over the toolbar: hover shows a clear outline; assign a hotkey to *Undo* in Obsidian (Settings > Hotkeys) and hover the Undo button: the tooltip reads "Undo (Ctrl+...)". A button without a hotkey shows its plain name.
3087. **Leaving the mouse.** Touch with the pen or finger a few times: the hints go away (the tooltip shows the plain name).
3088. **Phone.** Repeat 3081-3085 on a phone: in the finger layout the row of tools may wrap to a second line (as with the Large toolbar size) and nothing goes past the screen edge; the bars stay usable in landscape.
3089. **Short landscape.** Finger layout with the keyboard up: the bars stay tight (no extra row spacing).
3090. **Light, dark, Italian.** The setting and its options read correctly in both themes and in Italian.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Device detection (three consistent events, never mid-stroke, palm window, pinned override) | yes | `tests/input-layout.test.ts` | | | |
| Classes `nb-input-*` on the view root; finger layout has larger targets | yes | harness `doc=inputlayout` (synthetic pointer events) | | | real S Pen / finger mix not simulated |
| Shortcut hints in tooltips (mouse layout, from Obsidian's hotkeys) | yes | formatting: `tests/input-layout.test.ts`; hotkey lookup guarded, not tested in a real Obsidian | | yes | the hotkey registry is not public API |
| Setting *Adapt layout to input* | yes | `tests/settings-schema.test.ts`, `tests/input-layout.test.ts` | | | |

### 0.27 — spread: two pages side by side (roadmap #49; steps 3140-3159)

Manual steps (real Obsidian; nothing here is verified on Android hardware). Use a notebook of at least six pages on a landscape tablet (a view at least 720 px wide and not taller than wide).

3140. **Turn it on.** Page sheet (tap the page indicator) > *Two pages side by side* (or Settings > Pages > Scrolling > *Two pages side by side*): the pages sit in pairs like an open book. Page 1 is alone on the right; the pairs are 2-3, 4-5... The button shows as on.
3141. **Both pages at once.** At fit zoom both pages of a pair are fully in view, top aligned, with a narrow gap between them; scrolling goes pair by pair (the fast scrollbar works as in continuous scrolling).
3142. **Write on both pages.** With the S Pen write on the left page, then on the right one: each stroke belongs to the page it started on. Start a stroke on the left page and finish it over the right one: the right page gets nothing from it (the ink is clipped at the left page's edge).
3143. **Book layout.** Settings > Pages > *First page alone, like a book* off: the pairs become 1-2, 3-4... An odd last page sits alone on the left of its row. Notebooks with one page just show that page.
3144. **Mixed sizes.** In a notebook with a portrait and a landscape page (or PDF pages of different sizes) next to each other, the pages line up by their top edge with a gap; the binding stays on the same vertical line in every row.
3145. **Next and previous.** *Next page* / *Previous page* (page-turner keys, the commands) move by pair. *Go to page* on either page of a pair shows that pair; zoomed in on the left page, going to the right page brings it to the middle of the view.
3146. **Page panel.** Open the page panel: both pages of the pair in view are highlighted; tapping a thumbnail goes to its pair.
3147. **Zoom and minimap.** Pinch in on the right page: the minimap (when set to *Automatic* or *Always*) shows the right page and its rectangle; tapping the minimap pans inside that page.
3148. **Saved view.** Save a view zoomed on the right page, scroll away, recall it: the same part of the right page comes back, centred, at the same zoom. The same after turning the tablet and back.
3149. **Last position.** Close and reopen the notebook in the spread: it opens on the same pair at the same zoom and scroll position.
3150. **Presentation and reference.** *Write while presenting* switches to one page at a time for the slide and goes back to the spread when you stop. A reference window keeps showing single pages.
3151. **Automatic.** Settings > Pages > Scrolling = *Continuous* > *Two pages on a landscape tablet* on: the spread appears by itself in landscape and goes away in portrait, staying on the page you were on. Off (default): nothing changes by itself.
3152. **Phone.** On a phone (or a portrait tablet) the setting *Two pages side by side* shows one column of pages as in continuous scrolling, and the page sheet does not offer the button. Rotating a tablet to landscape brings the spread back.
3153. **Turning it off.** The button again (or the setting): back to one column on the same page. With the automatic setting on, the button also switches the automatic setting off.
3154. **Other tools on a spread.** Lasso, shapes, text boxes, the eraser, the ruler and image drops work on whichever page is under the pen; a lasso that reaches the other page of the pair selects across the two pages exactly as it does across two pages in continuous scrolling. Dropping a file in the gap between the pages goes to the page nearer to it.
3155. **Looks.** Light and dark theme, English and Italian, the new rows in the Pages section of the settings, the long-press explanation of the button.
3156. **Nothing written by the mode.** Switching the mode, rotating and scrolling never change the notebook file (no save indicator, no modified time change).
3157. **Page actions mean the page you touched (review fix).** At fit zoom, write (or tap with a finger in finger-writing mode) on the RIGHT page, then open the page sheet: its title names that page ("Page 5") and Delete page, Paper, Size, Lock act on it, however the view is scrolled by a pixel. Write on the left page: the sheet names the left page. Zoomed in on one page, that page is the one. Delete page in a spread says which page went ("Page 5 deleted") and Undo brings it back.
3158. **Eraser by the binding (review fix).** With a large eraser, rub out ink on both pages within reach of the binding in one stroke: ink on the right page and on the left page near the gap both go (one undo step).
3159. **Resize during a stroke (review fix).** Hold the pen on the page, writing, while the pane is resized (or the tablet turned): the stroke keeps its shape; the pairs change when the pen is lifted. Saved views and the last position saved in a spread come back at the same page size in a single column (and the reverse); a fitted spread comes back fitted.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Spread layout: pairs, first page alone or not, odd last page, mixed sizes aligned by top, same binding line (pure) | yes | `tests/spread.test.ts` | | | |
| Which page a point is on, the page of a row nearer sideways, a stroke keeps the page it started on (pure) | yes | `tests/spread.test.ts` | | | |
| Scroll to page / next page by pair, position and saved-view restore, minimap, scrollbar bubble and drops on a spread (pure) | yes | `tests/spread.test.ts` | | | |
| Fallback to one column on a phone or a portrait view; automatic spread in landscape | yes | `tests/spread.test.ts`, harness `doc=spread` | | | |
| Page sheet button, command, settings (*Two pages side by side*, *First page alone*, *Two pages on a landscape tablet*) | yes | `tests/spread.test.ts`, `tests/settings-schema.test.ts`, `tests/ui-registry.test.ts` | | | |
| Writing with the pen on both pages of a pair | yes | harness `doc=spread` (synthetic pen events) | | | the S Pen on a real tablet |
| Page panel highlights both pages of the pair | yes | harness `doc=spread` | | | |
| Review fixes: the page the page actions mean in a spread (last touched, decisive only near the binding); eraser reaches both pages by the binding; resize waits for the stroke; positions and saved views measured against the page-wide fit in every mode (pure) | yes | `tests/spread.test.ts` | | | |

### 0.27 — semzoom: semantic zoom, headings and titles shown large when zoomed out (roadmap #130; steps 3040-3059)

Manual steps (real Obsidian; nothing here is verified on Android). Use a notebook with handwritten headings (lines written much larger than the rest), a titled bookmark and a PDF background; Settings, *Pages & navigation*, *Headings when zoomed out* is on by default.

3040. **Off at normal zoom.** At the fit-to-width zoom, and zoomed in, nothing extra is drawn over the pages.
3041. **Fade in.** Pinch out slowly: from about 60 % of the fit zoom a faint veil and the labels fade in, and they are complete near the smallest zoom. Pinching back fades them out; the pages and the ink under them look exactly as before.
3042. **Headings.** Each large handwritten heading appears as a big picture of its own ink (no text is recognised), anchored at its place on the page; level 1 headings have a thicker accent edge than level 2.
3043. **Names.** A titled bookmark, the PDF's name and the top levels of the PDF's outline appear as text labels at the top of their page. Large pictures and excerpts are named after their file / source notebook in a quieter style.
3044. **Legible and tidy.** Labels are readable on the tablet (at least about 13 px text, 20 px tall), stay inside the page, never overlap and never cover more than a few per page.
3045. **Tap to go there.** A finger tap (when a finger pans, not draws) or a mouse click on a label zooms to the page's fit-to-width zoom with that line near the top of the view; the Back-jump history knows the jump. A drag or a pinch that starts on a label does not jump. A pen tap on a label draws as usual (it does not jump).
3046. **Writing.** With the pen on the screen at overview zoom the labels step aside and come back about half a second after the pen lifts.
3047. **Setting.** Turn *Headings when zoomed out* off: the overlay never appears; on again: it returns without reopening the notebook. The Italian strings read correctly.
3048. **Not in the output.** Export a PDF / PNG / SVG, start the presentation and make a hand-in PDF from the zoomed-out view: none of them contains a label or the veil. Page-by-page mode never shows it.
3049. **Edits follow.** Write a new big heading, wait a few seconds and zoom out: it is labelled. Delete the heading (or undo): its label disappears. The notebook file is not modified by looking at the overview (check the file's modified time).
3050. **Speed.** A notebook of 100+ pages: pinching and panning in the overview stay smooth on the tablet (labels move with the pages; headings are analysed a little at a time in the background).
3051. **Looks.** Light and dark, "Follow Obsidian theme", phone and tablet width.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Pure layout: fade range, zoom bands, label sizes, placement inside the page, collision avoidance, per-page cap, cache, visible-label scan, hit test, jump viewport | yes | `tests/semantic-zoom.test.ts` | | | |
| Label sources from the outline (headings, titled bookmarks, PDF names and sections, excerpts, pictures) | yes | `tests/semantic-sources.test.ts` | | | |
| Overlay is a view-only layer (not imported by exports, presentation, hand-in; no commands; setting on by default) | yes | `tests/semantic-zoom-isolation.test.ts` | | | |
| Overlay layer (fade, pooled labels, heading pictures, tap or click to jump, steps aside while writing) | yes | harness `doc=semzoom` | | | pen tap on a label does not jump (pen draws); not measured on the tablet |
| Setting *Headings when zoomed out* (Pages & navigation) | yes | `tests/settings-schema.test.ts`, `tests/semantic-zoom-isolation.test.ts` | | | |

### 0.27 — workspaces: workspace presets (roadmap #375; steps 3100-3119)

Manual steps (real Obsidian; nothing here is verified on Android).

3100. **Open.** Run the command *Workspaces: pick a panel layout…* (command palette, All actions or the notebook menu): a dialog lists Lecture, Study and Focus. The one that matches the panels open now carries the pill *Now*.
3101. **Focus.** Open the page panel and the minimap, then pick *Focus*: both close; the notebook is untouched. A short notice names the workspace.
3102. **Lecture.** Pick *Lecture*: the page panel opens as the outline, and the slides picker opens (choose a PDF or a notebook): the slides pane sits next to the notebook. Run the command again: nothing flickers and no second picker opens.
3103. **One command.** Run *Workspace: Lecture (slides, notebook, outline)* from the All actions sheet: the same arrangement without the dialog. During a class (lecture mode on) it is ranked first.
3104. **Study.** Pick *Study*: the reference window picker opens (choose a file) and the Related pages panel opens in the right sidebar. Pick *Focus* again: the reference window and the Related panel close; no other Obsidian tab or pane moves.
3105. **Save.** Open a layout by hand (for instance outline and minimap), open the dialog and press *Save current arrangement*, name it: it appears as a tile with the panels it opens. Pick *Focus*, then your tile: the layout returns.
3106. **Writing profile.** With the Lecture writing profile in use, save a preset: applying it later switches to that profile too.
3107. **Rename, replace, delete.** On your own tile: the pencil renames it, the refresh button replaces its panels with what is open now, the bin deletes it. Lecture, Study and Focus have none of these buttons.
3108. **Limit.** After 12 saved presets the save button is disabled and says so.
3109. **Phone width.** On a phone: *Lecture* keeps the slides split and skips the page drawer; *Study* leaves out the reference window and the Related pages with one notice naming them. Saved presets behave the same.
3110. **Lecture start.** Settings, Study, *Lecture workspace when a class starts* on: starting lecture mode applies Lecture (off by default).
3111. **Nothing is edited.** Apply every preset on a notebook and compare the file (modified time and content): unchanged. A read-only notebook can apply presets too.
3112. **Settings survive.** Restart Obsidian: saved presets are still there; hand-edit `data.json` with a broken entry: it is ignored, the others stay.
3113. **Help and Italian.** Long-press the *Workspaces…* action: an explanation appears. Switch to Italian: dialog, notices and help are translated.
3114. **Looks.** Light and dark theme, tablet and phone width; the dialog has the same look as the history panel.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Pure model (built-in presets, lenient read, bounded list, plan: close/open/skip, narrow degrade, one picker at a time, save/update/rename/delete) | yes | `tests/workspace-presets.test.ts` | | | |
| Apply a preset (page panel and outline, minimap fold, slides pane, reference window, Related pages panel) through each panel's own open/close | yes | harness `doc=workspaces` (page panel, outline, minimap, saved preset; slides and reference need a file and are not driven) | | | slides/reference pickers and the Related panel in a real Obsidian |
| Picker dialog (tiles, current marker, save, rename, replace, delete) | yes | harness `doc=workspaces` | | | |
| All actions entries, command, context rank, long-press help | yes | `tests/actions-registry.test.ts`, `tests/context-rank.test.ts` | | | |
| Setting *Lecture workspace when a class starts* | yes | `tests/settings-schema.test.ts` | | | |
| Phone degrade (reference window, minimap, related skipped with one notice) | yes | `tests/workspace-presets.test.ts`, harness `doc=workspaces` (phone) | | | |

### 0.27 — pdfsuggest (PDF search with suggested terms, roadmap #418; steps 3020-3039)

Manual steps (real Obsidian; nothing here is verified on Android). You need a notebook with PDF pages whose PDF has an outline (bookmarks), a few typed text boxes that repeat a word, and a box with a title.

3020. **Open.** On a PDF page open *Search PDF text*: under the box a single row of chips appears (outline entries first, then titles, then frequent words). The row scrolls sideways with a finger; the panel never grows wider.
3021. **Tap.** Tap a chip: its text goes into the box, the keyboard closes and the search runs at once; the results list and the marks on the pages are the usual ones.
3022. **Typing.** Type *ent*: only the chips that fit stay (starting with it first, then words inside, then one-typo matches such as *carnt* for *Carnot*). Accents and capitals do not matter. A chip equal to what you typed is not offered.
3023. **Nothing fits.** Type something that matches no chip: the row disappears (no empty bar); clearing the box brings it back.
3024. **Own text.** The words are the ones you typed in this notebook (text boxes, sticky notes, checklist labels) at least twice; *the*, *and*, *della*, *che*... never show. Handwriting is not read, so it is not a source.
3025. **Other notebooks.** Words and titles of other notebooks never appear (open two notebooks with different words).
3026. **No outline.** A PDF without an outline gives chips from titles and words only; a notebook with no PDF page shows the usual message and no chips. Settings, *PDF outline: off*, leaves the outline entries out.
3027. **Changes.** Add a text box with a new repeated word, close and reopen the search: the word is offered. Opening the search a second time without changes costs nothing visible.
3028. **Phone.** Narrow view: at most eight chips, one line; tablet: up to fourteen.
3029. **Help.** Long-press a chip with a finger: a bubble says where the term comes from (outline, title or word). English and Italian.
3030. **Writing.** While the pen writes, opening the search does not stutter (the chips are prepared when the device is idle).
3031. **Read-only.** Nothing is written to the vault or the notebook by suggestions.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Pure ranking and filtering of suggested terms (outline, titles, frequent typed words; en + it stop-words; prefix, word, substring and one-typo matching; bounds; per-document cache) | yes | `tests/pdf-search-suggest.test.ts` | | | |
| Chips row in the PDF search panel (tap searches, typing filters, long-press help, phone and tablet) | yes | harness `doc=pdfsuggest` | | | |
| Sources read from the open notebook only, in idle time; no format change, no writes | yes | `tests/pdf-search-suggest.test.ts` (gather) | | | words from handwriting are not available (no recognition) |

### 0.27 — plannertasks: tasks due on planner pages (roadmap #266; steps 3120-3139)

Settings, Writing: *Tasks on planner pages* (on by default). Implemented, not verified on hardware. Needs a planner notebook (create one from the planner generator) and a few notes with tasks. The overlay is derived and per device: nothing is stored in the notebook (no format change), it is **not included in any export** in this wave, and it is read only (the task lines of ordinary notes carry no block id the safe checklist writer could find them by, so nothing is ticked from the chip).

3120. **Chip.** In a vault note write `- [ ] Pay rent 📅 2026-03-12`, in another `- [ ] Book room [due:: 2026-03-12]`, and in a note named `2026-03-12.md` a plain `- [ ] Call the bank`. Open the daily page of 12 March 2026 of a planner: a quiet chip *Tasks due: 3* appears at the top right (a moment after the page settles). It is collapsed: it never covers the page.
3121. **List.** Tap the chip: a list opens under it, open tasks first (by day, note, line), done ones struck through and last, each with its note name. The round marks are statuses, not buttons.
3122. **Open the note.** Tap a row: the note opens in a new tab with the cursor on the task's line; the notebook stays where it was.
3123. **Collapse.** Tap outside, press Escape, change page or write a stroke with the S Pen: the list folds, the chip stays.
3124. **Weekly page.** On a weekly planner page the chip counts the tasks of the seven days; rows show their weekday.
3125. **Other pages.** The year, month, notes and ordinary pages have no chip; a day with nothing due has none either.
3126. **Live.** With the page open, edit a task in a note (change its date to that day): within a second or two the count follows. Delete or rename the note: it follows too. Typing in a note does not slow the notebook.
3127. **Big vault.** In a vault with thousands of notes the first planner page you open stays smooth (notes are read a few at a time); a task found in a fenced code block, in frontmatter or marked cancelled `[-]` is not listed.
3128. **Setting.** Turn *Tasks on planner pages* off: the chip goes; on: it returns.
3129. **Stacking.** With the recent-symbols strip, the *Back to slide* pill and the *Referenced on* chip on, the tasks chip sits below them, none overlaps, and on a phone it steps aside while the welcome-back card is shown.
3130. **Not in exports and not in the file.** Export the page as PDF/PNG: no task text appears. Reopen the notebook file's JSON: nothing of the tasks is in it.
3131. **Italian, light, dark, phone.** The texts are in Italian with the plugin in Italian; the chip and list read in light and dark and fit a phone.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Page days from a planner title (day, week, across month and year, en and it; planner paper only) | yes | `tests/planner-tasks.test.ts` | | | |
| Task due dates (Tasks `📅`, Dataview `[due::]`, daily note name), skipping frontmatter, code, cancelled; bounded index | yes | `tests/planner-tasks.test.ts` | | | |
| Chip, list, open at line, incremental updates, setting, stacking | yes | harness `doc=plannertasks` and `doc=pillstack` | | | |
| Tick a task from the chip | no | | | | read only by design (no safe block-id writer for ordinary notes) |
| Overlay in exports | no | | | | left out in this wave |

### 0.28 — pdfrotate: rotate and crop imported PDF pages, document format 26 (roadmap #76; steps 3160-3179)

Manual steps (real Obsidian; nothing here is verified on Android). You need a notebook with several pages of one PDF (a slide deck), some ink and a text box on the first one, and a second notebook with a locked PDF page. **New data format v26:** a page's PDF background may carry `rotate` and `crop`; a notebook that uses them is not readable by 0.27 and older (it opens read-only there). Keep a copy of the notebook you try this on.

3160. **Rotate right.** On a PDF page open the page sheet (or *All actions*): *Rotate PDF page right*. The PDF turns a quarter turn clockwise, the page becomes landscape, and your ink, highlights and boxes stay on the same words (the ink turns with the page; a text box keeps its orientation and only its centre moves).
3161. **Rotate left, undo, redo.** *Rotate PDF page left* from the turned page brings it back upright exactly. *Undo* after a turn puts back the same page; *Redo* turns it again. The history panel names the step *PDF page rotated* (*Pagina PDF ruotata*).
3162. **Four turns.** Four turns right in a row end where they began (ink, highlights, page size).
3163. **Crop dialog.** *Crop PDF page…* opens a dialog with the whole page and a frame. Drag a corner, an edge, or inside the frame (finger, S Pen, mouse); the frame cannot leave the page or get thinner than a few millimetres. Tap *Whole page* to reset. The size kept is shown in millimetres.
3164. **Apply a crop.** *Apply*: the page shrinks to the frame, the PDF shows only that part, and your ink stays on the same words. *Undo* brings the whole page and every stroke back; the history panel says *PDF page cropped*.
3165. **Rotate inside the dialog.** In the dialog the two turn buttons turn the preview and the frame together; *Apply* does both in one undo step.
3166. **All pages of this PDF.** With several pages of the same PDF the dialog offers *All N pages of this PDF*: the same crop is applied to every page (each keeps its own turn plus the one you added), as ONE undo step. A locked page, a page with redaction boxes, or a page whose change would put ink above it is skipped, and one notice lists how many and why; the rest change. Excerpts of the page on other pages of this notebook and saved views of it follow the change in the same undo step.
3167. **Ink outside the crop.** Write in the margin of the PDF, then crop that margin away: the page still shows your ink (the page margins grow to hold it, next to the PDF) and a notice says so. Nothing is deleted.
3168. **Ink above the crop.** Write above the top edge area and crop below it, or turn a page that has notes in a side margin the wrong way: a notice says some pages were left as they are (ink or notes would end above the page). Move the notes and try again.
3169. **Margins.** On a page with margins (notes beside a slide) rotate: the PDF and its notes turn together and the margins stay on the same sides of the page.
3170. **Locked page.** A locked PDF page refuses both actions (the actions are greyed in the page sheet).
3171. **Text.** After a turn or a crop, *Search PDF text* highlights the right words, selecting text and following a link work on the turned page, and the highlighter that follows text lines snaps to the lines. After a crop that removes a header with a web link: search does not find the header words, a drag from the top of the cropped page does not select hidden text, and a tap in the margin beside the page does not open the hidden link.
3172. **Exports and redaction.** Export the turned and cropped page as PDF, PNG, SVG and interactive HTML, print it, hand it in and present it: each shows the same turned, cropped page with the ink in the same places. **Redaction (fail closed):** draw a redaction box (Export… › Redact…) over a line of a PDF page, then try *Rotate PDF page right* and *Crop PDF page…* on it: both refuse with *Remove or redo the redaction boxes on this page first* (with *All N pages* the page is skipped and the notice says why). Turn a page first, then draw the box on it: exports cover it. Undo the turn: every export now refuses (*A page was turned or cropped after its redaction boxes were drawn…*) until you delete and redraw that page's boxes; the secret is never written.
3173. **Thumbnails and zoomed out.** The page navigator, the page grid, the zoomed-out view and the hover preview show the turned, cropped page.
3174. **Crop PDF margins (view only).** The existing *Crop PDF margins* display option still works on a cropped page: it fits the white margins that are left inside the stored crop and writes nothing.
3175. **Re-published slides.** *Update PDF from a new version* on a deck whose pages were turned keeps each page's turn and crop.
3176. **Old versions.** Open the notebook in 0.27 (or tell the app to ignore the new keys): it opens read-only, and the turned pages are untouched.
3177. **Phone and tablet.** The dialog fits a phone (the frame handles are finger-sized) and a tablet, in light and dark, and the help bubbles of the three actions (long-press) read in English and Italian.
3178. **Big PDF.** Turning a page of a 300-page PDF is instant and does not slow scrolling (only the bitmap of the turned page is made again).
3179. **Nothing fake.** Every control in the dialog works; the shaded area and the frame outline are decoration around the real handles.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Format v26: optional `rotate` and `crop` on a PDF page background; migration v25 to v26; lenient read (dropped and counted), strict write; schema v26 | yes | `tests/model-v26.test.ts`, `tests/format-schema.test.ts` | | | |
| View geometry and plan (turn, crop, size, rigid matrix, margins that grow, ink that would end above the page is refused) | yes | `tests/model-v26.test.ts` | | | |
| `SetPdfView`: ink, elements, areas, comments, states carried in one undo step; locks, groups, hidden ink, page times | yes | `tests/model-v26.test.ts`, `tests/history-panel.test.ts` | | | |
| PDF store renders a view (whole rotation, offset), cached apart; every render path asks for the page's view | yes | `tests/model-v26.test.ts` | | | pdf.js `getViewport` rotation/offset on a real device |
| Text boxes, links, selection and search highlights mapped through the view | yes | `tests/model-v26.test.ts` | | | |
| Export parity (PDF re-embeds the turned, cropped picture; PNG, SVG, HTML, hand-in, presentation, redaction burn use the same page) | yes | `tests/model-v26.test.ts` (SVG and PDF sizes), harness `doc=pdfrotate` | | | |
| Page sheet actions *Rotate PDF page right / left*, *Crop PDF page…* (dialog with handles, reset, this page or all pages), en + it, help, context rule, history titles | yes | `tests/ui-registry.test.ts`, `tests/model-v26.test.ts`, harness `doc=pdfrotate` | | | |
| Rotating text selection by character on a turned page | partly | | | | selecting by dragging works through the turn; the caret inside a vertical run follows its box |

### 0.28 — pageundo: per-page undo (roadmap #98; steps 3180-3199)

Manual steps (real Obsidian; nothing here is verified on Android hardware). Use a notebook of at least three pages. No document format change.

3180. **Off by default.** Settings > Pages > *Undo on this page only* is off. Write on pages 1, 2 and 3, then tap Undo: the newest step of the notebook goes back, whatever its page (as before). The undo button reads *Undo*.
3181. **Turn it on.** Switch the setting on: the undo and redo buttons now read *Undo on this page* / *Redo on this page* (hover tooltip with a mouse; hold a finger on the icon for the explanation bubble, which says the last change on this page is taken back and the other pages keep theirs).
3182. **Interleaved pages.** Write a stroke on page 1, one on page 2, one on page 3, another on page 1, another on page 2. Go to page 1 and tap Undo: only page 1's newest stroke goes. Go to page 2 and Undo: page 2's newest goes. Page 3 and the older strokes are untouched.
3183. **Button state follows the page.** Go to a page you never wrote on: Undo is disabled. Go to one you did: it is enabled. Redo likewise after an undo on that page.
3184. **Redo on a page.** On page 1 undo twice, then Redo once: the older of the two strokes comes back first (the order is the page's own). Redo again: the newer one.
3185. **Other pages do not clear it.** Undo a stroke on page 1, write on page 3, go back to page 1: Redo is still available and brings the stroke back. Undo it again, write on page 1 itself: Redo on page 1 is now disabled (a new edit on a page drops that page's redo steps).
3186. **A step on two pages.** Select ink on page 1 and move it to page 2 (*Move selection to page*). On page 1 tap Undo: nothing is undone and one notice says that the last change also touched other pages and points to the history panel. The same on page 2. Older steps of those pages are NOT undone behind its back.
3187. **Past the global step.** Open *Action history* and tap the step just before the move: everything after it is undone in order (the panel stays global). Per-page Undo works again afterwards.
3188. **Page structure.** Add a page and write on it: Undo twice on the new page takes back the stroke, then says the page change is global (the page is not removed by a per-page Undo). Deleting or reordering pages behaves the same; Undo on a page that the deleted page was not is unaffected.
3189. **Pictures and slide links (review fix).** Insert a picture on page 1, then write on page 2. On page 1 Undo: a notice says the step added a picture file (or slide link) the whole notebook shares, so it is only undone in order, and nothing is undone; the history panel goes back past it. Undo on page 2 first, then page 1 works. A picture pasted on page 2 from the one on page 1 (no new file) is undone on page 2 at any time. After the global Undo of the page-1 picture from the panel, Redo on page 2's paste is refused with a notice until the picture is redone first (in order). The notebook never shows a missing-picture error and the save indicator never sticks on unsaved.
3190. **Macros.** Run a macro whose steps write on one page: one Undo on that page takes the whole run back. A macro that writes on two pages is one global step (notice).
3191. **Locked pages.** Lock page 2 after writing on it (or let a synced lock arrive): Undo on page 2 does nothing and says the page is locked; page 1 still undoes. Unlock page 2: its Undo works again.
3192. **Read-only.** In read-only mode neither button does anything and the history is intact afterwards.
3193. **Two pages side by side.** In a spread, write on the left then the right page and tap Undo: it acts on the page you touched last; touch the other page and Undo acts on that one.
3194. **History panel.** With the setting on the panel opens with a note about per-page undo; steps of the page in view show an accent edge and *this page*; steps that touch several pages or the notebook show *whole notebook* in a muted title. The order and the *Now* tile are the global ones; with the setting off nothing is marked.
3195. **Panel after a page undo.** Undo on page 1 although page 2 was written later: in the panel the undone step of page 1 sits in the *Undone steps* group at the top while page 2's step is still the current point. Tapping the undone step brings it back.
3196. **Switch it off again.** Switch the setting off: the buttons read *Undo* / *Redo* again, Undo takes back the newest step of the notebook, and a new edit clears the whole redo list as it always did.
3197. **Text boxes and settings.** Edit a text box on page 1, write on page 2, Undo on page 1: the text edit goes back, page 2 is untouched. Edit a page property (paper, margins) on page 3: it is a step of page 3 and is undone there.
3198. **Looks.** Light and dark, English and Italian (the setting, the buttons' names, the notices, the panel note and marks); the setting sits in Pages and its description is one line.
3199. **S Pen button after a page undo (known limit).** Undo on page 1, then write on page 2 and replay a contact with the side button held late: the replay as an eraser may not happen while a step undone on another page waits for redo (the stroke stays as ink and one Undo on page 2 takes it back).

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Which pages a step touches (batches, groups, lock-exempt wrapper), local versus global, every command class classified (pure) | yes | `tests/page-undo.test.ts` | | | |
| Undo / Redo on one page: newest step of the page, own inverse, interleaved pages, out-of-order redo, order inside a page | yes | `tests/page-undo.test.ts`, harness `doc=pageundo` | | | |
| Dependency refusal: a step that touched several pages, page structure, notebook-wide and unknown steps are never undone out of order | yes | `tests/page-undo.test.ts` | | | |
| A step that added a file or slide entry is only undone in order; no redo past an undone global or registering step; removing a file blocks every page; the content check validates file, cover and background references on every call (review P1, P2) | yes | `tests/page-undo-review.test.ts` | | | |
| A step the guard refuses out of order stays in the history; a refused redo clears no other page's redo steps; macro groups filtered as one step; the redo list is bounded by the limit (review P3-P6) | yes | `tests/page-undo-review.test.ts` | | | |
| Redo list kept for other pages, dropped by an edit on the same page or a global one; unchanged with the setting off | yes | `tests/page-undo.test.ts` | | | |
| Groups, locked pages, remap after an upkeep swap, the document guard, read-only | yes | `tests/page-undo.test.ts` | | | |
| History panel marks (this page, whole notebook), global list and jumps unchanged | yes | `tests/page-undo-panel.test.ts`, harness `doc=pageundo` | | | |
| Every command the other 0.28 features add is classified for per-page undo (PDF rotate / crop, Move line, Insert / Edit table, Fill area, bookmark, selection highlight); table edits keep opacity, line moves keep taper and opacity | yes | `tests/page-undo-wave28.test.ts` | | | |
| Setting *Undo on this page only* (default off), button names and help in en and it | yes | `tests/page-undo-panel.test.ts`, `tests/settings-schema.test.ts`, harness `doc=pageundo` | | | |
| Undo on the page last touched in a two-page spread | yes | uses `currentPageIndex` (not run in the harness) | | | |
| S Pen side-button replay while a page-undone step waits for redo | no | | | | `retractStroke` still needs an empty redo list |

### 0.28 — tables: hand-drawn tables (roadmap #41; steps 3200-3219)

*Table* in the insert sheet, and *Add row*, *Add column*, *Remove last row*, *Remove last column* and *Even out cells* in the All actions sheet while a table is selected (on a phone they are in the sheet, not on the selection bar). Implemented, not verified on hardware. A table is plain vector ink: straight shape lines of one group (no new element kind, no format change). Needs a notebook page and the S Pen.

3200. **Insert.** Insert sheet > *Table*: a dialog with Rows, Columns, Cell size, Line width, Line style, Line colour and *Thicker line under the first row*, and a small picture of the grid that follows every choice. Choose 4 rows, 3 columns, Medium, Insert: the grid appears at the centre of the view, selected, as one group (one tap on a line selects all of it).
3201. **One step.** Undo once: the whole table goes. Redo: it is back. Open the history panel: one entry, *Table inserted*.
3202. **Look.** Insert one dashed, thick and red, with the header line on: every line is dashed and red, the line under the first row is clearly thicker. With the header off all lines are alike. On a narrow page with 12 columns the cells shrink to fit the page; the dialog never makes a table wider than the page.
3203. **Write in it.** With the pen write a word in each cell: it is ordinary ink (it does not select the table, it is not part of its group). Move the table with the lasso: the table moves, the writing stays (select both to move both).
3204. **Add row.** Select the table (tap a line), All actions > *Add row*: a row as tall as its neighbour appears under the row at the centre of the view (at the bottom when the centre is not over the table). Writing below the new line moves down with the table lines; writing above it and writing outside the table do not move. One undo puts everything back, including the writing.
3205. **Add column.** The same with *Add column*: writing to the right of the new line moves right.
3206. **Remove.** *Remove last row* and *Remove last column* take the last line away; writing is left where it is (even if it now lies outside the table). A one-row or one-column table says it keeps at least one.
3207. **Even out.** Scale the table with the lasso handles so that the cells are no longer even (or add a row, which is as tall as its neighbour, to a table whose rows differ), then *Even out cells*: every row is as tall and every column as wide as the others, the outer frame is unchanged. On an already even table it says so and changes nothing.
3208. **Limits.** Keep adding rows until a notice says the table cannot have more rows (30); the same for columns (16).
3209. **Not offered.** Select a table together with other ink, or only some of its lines: the table actions are not in the sheet. With nothing selected they are not either.
3210. **Locks.** On a locked page *Table* and the table actions do nothing (the page's lock notice). A table inside a sticky note that is collapsed: ink the note hides is not moved.
3211. **Snap.** With snap on (Settings > Writing), drag a text box or a drawing near the table: the dragged box snaps to the row and column lines of the table, not only to the table's outline.
3212. **Exports.** Export the page as PDF, PNG, SVG and interactive HTML: the table is drawn like any shape (dashes included); the line width is the same everywhere.
3213. **Copy and move.** Copy the table to another page and to another notebook: it arrives as one group of its own (fresh ids) and is still a table (the actions are offered when it is selected).
3214. **Dark, light, phone, Italian.** The dialog reads in both themes with 44 px targets, fits a phone, and is in Italian with the plugin in Italian; the long-press help of *Table* and each table action says what it does.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Table geometry, build / detect / edit grid, ink shift on row and column insert | yes | `tests/table.test.ts` | | | |
| Insert and edit commands (one undo step, locked page refuses) | yes | `tests/table.test.ts` | | | |
| Insert dialog, table actions in the sheet, context rule, help, history titles | yes | harness `doc=tables` | | | |
| Snap to cell lines | yes | `tests/table.test.ts` | | | |
| Dragging a single line to resize a row or column | no | | | | use the lasso handles then *Even out cells* |
| Writing moves with the cells on resize (merged cells, per-cell text) | no | | | | left out in this wave |

### 0.28 — bucket: paint bucket, fill a closed area (roadmap #184; steps 3220-3239)

*Paint bucket* is the last button of the colour row of the pen, highlighter and shape options (also in the command palette and the All actions sheet). Settings, Writing: *Paint bucket fills as a tint* (on by default). Implemented, not verified on hardware. Needs a page with a few closed outlines drawn by hand (a box, a circle, a map outline) and one with a gap. No format change: the fill is an ordinary filled shape stroke (format 22) with a hairline.

3220. **Fill a box.** Draw a closed box with the pen, pick a colour, open the pen options and tap *Paint bucket*; a notice says to tap inside an area. Tap inside the box: it fills with a light tint of the colour in use, behind your lines (the lines stay crisp on top). The button is one-shot: the mode ends with the fill.
3221. **One step.** Undo once: the fill goes and nothing else; redo brings it back. The history panel calls the step *Area filled*.
3222. **Gap.** Draw a box and leave a small gap (about the width of the pen) in one side. Fill it: the fill stays inside the box. Open a gap of a finger's width: the tap says the area is not closed (or too large) and adds nothing; the mode stays on so you can close the gap and tap again; Escape (or any other tool or button) ends it.
3223. **On a line.** Tap exactly on a line: a notice tells you to tap inside the area. Tap a very small pocket (a couple of millimetres wide): "too small".
3224. **Round and nested.** Fill a hand-drawn circle: the fill follows it (a few dozen points, no staircase). Draw a box with a smaller box inside it: tapping between them fills the outer area, tapping inside the inner one fills that with its own colour on top.
3225. **Holes (known limit).** A shape inside the area that is itself closed (a ring, an island) gets coloured inside too: the fill is one polygon and a filled shape has no holes. Tap the ring's inside afterwards to give it its own colour. Text and strokes inside the area are drawn over the fill, as usual.
3226. **Solid or tint.** Turn *Paint bucket fills as a tint* off: new fills are the solid colour (still behind the ink). Turn the pen *Opacity* down before filling: the fill is lighter.
3227. **Behind everything.** Fill an area, then write across it: the new ink is on top. Select the fill with the lasso (tap inside it) and move or recolour it like any filled shape; the stroke eraser removes the fill (tap inside) without touching your lines.
3228. **Large page, heavy page.** On an infinite page or a page with a lot of ink the fill still answers within about a second; if the page has too much ink it says so and adds nothing. Nothing freezes the pen.
3229. **Page edge.** On a page with an outline that touches the page edge, tapping outside it says "not closed". A frame around the whole page says the area is as large as the page.
3230. **Exports and reopening.** Export the page as PDF, PNG and SVG: the fill is there, under the lines. Close and reopen the notebook: the fills are still there and look the same.
3231. **Locked page and read-only.** On a locked page, in read-only mode: the button is disabled or the step is refused with the usual notice.
3232. **Long press and Italian.** A finger held on the button explains it; with the plugin in Italian the button, the notices, the setting and the history title are in Italian.
3233. **Light, dark, phone.** The button sits in the colour row and fits on a phone; a fill reads on light and dark paper.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Paint bucket: low-resolution mask of the page ink (2 to 4 cells per pt, capped at 2 million cells; a window around the tap on a huge page), gap tolerance 1.5 pt, scanline flood with time budget, outline traced to a simplified polygon (at most 400 corners, resampled every 3 pt like any shape) in page coordinates | yes | `tests/paint-bucket.test.ts`, timing `tests/paint-bucket.perf.ts` | | | |
| Stored as a filled shape stroke (tool `shape`, `fill`, optional `fillTint` and `opacity`), hairline, inserted after the earlier fills and before all ink; one History step "Fill area" | yes | `tests/paint-bucket.test.ts`, harness `doc=bucket` | | | |
| Refusals: not closed / too large, on a line, too small, as large as the page, too much ink; one notice, nothing added | yes | `tests/paint-bucket.test.ts`, harness `doc=bucket` | | | |
| Action, colour-row button, command, long-press help, context rule, setting (tint or solid), en + it | yes | `tests/long-press-help.test.ts`, `tests/ui-registry.test.ts`, `tests/i18n.test.ts` | | | |
| Holes: an inner closed shape is not left unfilled | no | | | | a shape fill is one nonzero polygon (no holes); documented limit |
| Stay armed for several fills | no | | | | one-shot like the eyedroppers |

### 0.28 — livelecture (live lecture bar, #132, steps 3260-3279)

3260. **Appears with the lecture.** Start a lecture (Start on the banner, the command, or an automatic lecture): a small bar appears at the bottom left, above the contextual bar, with a running timer (mm:ss, h:mm:ss after an hour) and two buttons, *New page* and *Important moment*.
3261. **Timer.** With a class that began 20 minutes ago the timer starts near 20:00 and counts up each second; with no class (manual start) it starts at 00:00. Put the app in the background and return: the time is right.
3262. **New page.** Tap *New page*: a page with the same paper is added right after the page you are on and the view goes to it; Undo removes it (one step).
3263. **Important moment.** Tap *Important moment*: a notice "Marked ★ 12:34 on page N"; the page now has a bookmark (page panel, outline, bookmarks list) titled "★ 12:34", in the "important" category.
3264. **Two marks on a page.** Tap it again on the same page a few seconds later: the title becomes "★ 12:34 · ★ 12:41". A bookmark you titled yourself keeps its text in front of the stamps.
3265. **Undo.** Undo takes the last mark back as one step.
3266. **Spread.** In the two-page spread, the mark and the new page use the page you last wrote on (the current page), not the left page of the pair.
3267. **End of lecture list.** Open the end-of-lecture panel: an *Important moments* section lists every stamp with its page, in page then time order; tapping one closes the panel and goes to that page. The list is still there after closing and reopening the notebook.
3268. **Fold.** Tap the chevron: only the timer stays; tap it again: the buttons return.
3269. **Fades with the toolbar.** With *Toolbar fades while writing* on, the bar fades while the pen writes and returns when you lift it. The bar never sits over the writing area you use (bottom left, above the contextual bar) and the pen never starts a stroke on it.
3270. **Setting.** *Settings > Study > Live lecture bar* off: the bar is gone during a lecture; on: it returns. Default on.
3271. **Read-only.** In a read-only notebook the buttons do nothing but say the notebook is read-only.
3272. **Stacking.** With the symbols strip, the *Back to slide* pill and the *Referenced on* chip on, nothing overlaps the bar, on a tablet and on a phone.
3273. **Long press.** Hold a finger on each of the three buttons: a bubble explains it. A pen does not trigger the bubble.
3274. **Italian, light, dark, phone.** The strings are in Italian with the plugin in Italian; the bar reads in light and dark and fits a phone; touch targets are at least 44 px.
3275. **No format change.** Marks are only the title of the page bookmark; the notebook still opens in older 0.27 builds.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Elapsed timer formatting, mark stamps, joining stamps, reading them back by page | yes | `tests/live-lecture.test.ts` | | | |
| Live bar: timer, New page, Important moment (stamped bookmark), fold, setting, stacking | yes | harness `doc=livelecture` and `doc=pillstack` | | | |
| Moments list in the end-of-lecture panel, tap to jump | yes | `collectLiveMarks` in `tests/live-lecture.test.ts`; harness `doc=livelecture` | | | |
| Timer after a restart of a manual lecture | no | | | | a manual lecture without a class restarts at 00:00 when the notebook is reopened; a class lecture keeps the class start |
| Marks in the lecture log (daily note) | no | | | | left out: the log line is unchanged |

### 0.28 — boxnum: numbered boxes and an index of definitions and theorems (roadmap #205; steps 3280-3299)

Settings, Pages: *Number definitions and theorems* (on), *Chapter prefix* (on), *One counter for all kinds* (off). Implemented, not verified on hardware. The numbers are worked out from the document each time and are never stored (no format change). All actions, Share group (or the command palette): *Definitions and theorems…*.

3280. **Label.** Place a Definition box, then a second one lower on the page: their tabs read "Def. 1" and "Def. 2" (Italian: "Def."; Theorem "Thm." / "Teor.", Example "Ex." / "Es.", Remark "Rem." / "Oss."). A box with a title reads "Def. 2 · Title". Proof boxes keep the plain name "Proof".
3281. **Order.** Drag the lower definition above the upper one: the numbers swap straight away. Delete the first definition: the second becomes "Def. 1". Undo: they come back. Numbers follow page order, then position on the page.
3282. **Chapters.** Write two large underlined or oversized titles on different pages with boxes below each: the boxes under the second title read "Def. 2.1", "Def. 2.2"; those above the first title have no prefix. (Chapters are the large level-1 headings the outline already finds.)
3283. **Settings.** Turn *Chapter prefix* off: plain numbers. Turn *One counter for all kinds* on: definitions, theorems, examples and remarks share one sequence. Turn *Number definitions and theorems* off: tabs go back to "Definition", "Theorem"… and the other two settings disappear.
3284. **Exports.** Export a page with boxes as PDF, PNG and SVG, and print it: every box tab carries the same number as on screen. With redaction on, the numbers are still those of the whole notebook.
3285. **Index.** Open *Definitions and theorems…*: every numbered box in reading order, each row with a colour bar, number, title and page chip. Tap a row: the dialog closes and the page scrolls to the box. Rows are at least 44 px tall.
3286. **Index note.** Tap *Write index note*: "<Notebook> — Definitions.md" appears next to the notebook with one bullet per box and a link to its page. Write your own text above and below the generated part, change a box, write again: only the part between the markers changes.
3287. **Safe note.** Rename a note of yours to the same name (no markers): the index goes to "… — Definitions (2).md" and your note is untouched.
3288. **Redaction.** Put a redaction box over a titled definition: it is not listed or written in the index.
3289. **Big notebook.** In a notebook with 100+ pages and many boxes scrolling stays smooth; chapter prefixes appear a moment after opening (headings are analysed in short slices).
3290. **Phone, light, dark.** The dialog and the tabs read in light and dark and fit a phone; texts are in Italian with the plugin in Italian.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Derived numbers: per kind or shared counter, chapter prefix, proofs unnumbered, order across pages and by position, renumbering on move/delete | yes | `tests/box-numbering.test.ts` | | | |
| Labels on the page and in every export that draws box labels (screen, PDF, SVG, PNG, print, share) | yes | `tests/box-numbering.test.ts` (labels), harness `doc=boxnum` | | | |
| Index dialog with jump-to; plugin-owned index note (owner markers, only the region rewritten, note of the user's never touched, recorded in plugin-written) | yes | `tests/box-numbering.test.ts`, harness `doc=boxnum` | | | |
| Settings (on/off, chapter prefix, shared counter) en + it | yes | `tests/settings-schema.test.ts` | | | |
| Thumbnail of each box in the index | no | | | | the box title (when typed) is shown instead |
| Numbers in the companion note's callouts and in the markers panel | no | | | | left out in this wave |

### 0.28 — geosuggest: actions suggested by the selection's shape (roadmap #403; steps 3300-3319)

Rules only, no AI. Chips appear in a row above the selection bar; they run existing actions.

3300. **Row of words.** Write a line of a few words and lasso it: two chips appear above the bar, *Highlight* and *Insert into note*. The rows of the bar below do not move (compare with the setting off).
3301. **Highlight.** Tap *Highlight*: a translucent rectangle in the highlighter colour sits behind the words, under the ink; the selection stays. One undo removes it; redo brings it back. On a locked page nothing is added.
3302. **Insert into note.** Tap that chip: the same flow as *Insert into note* in the bar (note picker, picture and link).
3303. **Paragraph.** Write three lines and lasso them: no chips. A single long stroke, an underline alone: no chips.
3304. **Arrow between two groups.** Write two words far apart, draw an arrow from one to the other (the arrow tool or by hand), lasso everything: chips *Link to a note…* and *Group*. Each does what its bar button does.
3305. **Loop.** Write two lines and draw a closed loop around them; select all: chip *Group*. Tap it: the items become one group, one undo step.
3306. **Mixed.** Select a row of words together with a picture or a text box: no chips.
3307. **Setting.** Settings, Appearance, *Suggest actions from the selection*: off, the chips go at once; on, they return on the next selection.
3308. **Phone.** On a phone-width view the chips sit above the bar in their own row, the five slots of each row of the bar are where they were, and the pieces above (pills) move up rather than overlap.
3309. **Long-press help.** Hold a finger on a chip: the bubble shows its name and one line, in English and Italian.
3310. **All actions.** *Highlight* is in the All actions sheet and the command palette; with a row of words selected it comes first under *For this page*.
3311. **Italian, light, dark.** Texts read in Italian; chips read in light and dark and with *Follow Obsidian theme*.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Geometry rules: row of words, arrow between two clusters, loop around ink (pure) | yes | `tests/selection-geo-suggest.test.ts` | | | |
| Chips above the selection bar (no slot moves), setting, help, ranking | yes | `tests/selection-geo-suggest.test.ts`, harness `doc=geosuggest` | | | |
| *Highlight* action (area behind the selection, one undo step) | yes | harness `doc=geosuggest` | | | |
| Flashcards / a "Make card" action | no | | | | none exists in the plugin: the row offers *Insert into note* instead |
| Region-to-region link | no | | | | the plugin has links from a selection to a note only: the arrow offers *Link to a note…* |

### 0.29 — charts: bar, line and pie charts from the numbers of a hand-drawn table (roadmap #244; steps 3340-3359)

A chart is ordinary shape strokes and text boxes of one group; "Update chart" re-reads the table the chart was made from. The plugin does not read handwriting: the numbers are typed in text boxes placed in the cells (Text tool, tap in a cell).

3340. **Table with numbers.** Insert a table (4 rows, 3 columns) and type in text boxes: row 1 "Month", "Sales", "Cost"; rows 2 to 4 a month name and two numbers each (use a decimal comma in one of them, e.g. 12,5). Select the table (tap it). *All actions* shows *Chart from table* (and *For this page* offers it first). With nothing selected, or a chart selected, it is not there.
3341. **Dialog.** Tap it: the dialog shows the type (Bars, Line, Pie), a title field, eight colour dots, the size, a small picture of the chart and "Numbers found: 6 (rows: 3, columns: 2)". Every control works; the picture follows each choice; the picture is not a control. Delete the numbers of a second table and open the dialog: it says no numbers were found and *Insert chart* is disabled.
3342. **Insert.** Choose Bars, type a title, a colour, Medium, *Insert chart*. The chart appears below the table (to the right when there is no room below) with a frame, the title, a value axis with round ticks and light grid lines, one label per month, two bars per month in two colours, value labels on the bars and a legend (Sales, Cost). The chart is selected. One undo removes it whole; redo brings it back.
3343. **Line and pie.** Repeat with *Line* (a line per series with a dot per number; an empty cell leaves a gap) and *Pie* (one wedge per row of the first column of numbers, clockwise from the top; a legend with the share of each). A zero or negative value has no wedge.
3344. **Move and restyle.** Drag the chart, resize it, change its colour with the selection bar: it behaves as any group (the title and labels are text boxes, the bars are shapes).
3345. **Update.** Change a number in the table (edit the text box). Select the chart: *All actions* shows *Update chart* (and no *Chart from table*). Tap it: the chart is redrawn in the same place and size, with the same type and colours, and a notice says so. One undo brings the previous chart back exactly. Tap *Update chart* again without changing anything: "The chart already shows the numbers in its table."
3346. **Edited title.** Edit the title text box of the chart, change a number, update: the new title is kept.
3347. **Table changes.** Add a row to the table (*Add row*), type a new month, update: the chart has one more category. Change a cell to text: it is left out and the chart still draws. Empty every number and update: refused with "The table holds no numbers…", the chart is untouched.
3348. **Table gone / copy.** Delete the table and update the chart: "The table this chart was made from is no longer in the notebook." Copy the chart and paste it: the copy has no table to read (*Update chart* says so); the original still updates. Chart and table on different pages: update still works.
3349. **Locked.** Lock the page: *Chart from table* and *Update chart* are disabled and nothing changes. Lock a text box of the chart (Lock): *Update chart* is refused with a reason.
3350. **Exports.** Export the page as PDF, PNG and SVG and print or share it: the chart is drawn with its bars, wedges, lines and text. With redaction on, a box over the chart hides it in the exports.
3351. **History panel.** The steps read "Chart inserted" and "Chart updated" (in Italian "Grafico inserito", "Grafico aggiornato"). With *Undo on this page only* on, undo of a chart step acts on that page only.
3352. **Phone, light, dark, Italian.** The dialog fits a phone, reads in light and dark and with *Follow Obsidian theme* (its picture sits on a light paper), and all texts are in Italian with the plugin in Italian. Long-press *Chart from table* / *Update chart* in the sheet: the help bubble explains each.
3353. **Many numbers.** A table of 12 rows and 4 series: labels thin out (every other one, clipped) rather than overlap; a pie of 15 rows shows 11 slices and "Other".
3354. **Real device.** On the tablet with the S Pen: the colour dots and segments are easy to hit, the picture is crisp, inserting is instant, and the text of the chart is a similar size to the table's.

| Feature | implemented | automated test | verified on hardware | experimental | to do |
|---|---|---|---|---|---|
| Number parsing (decimal comma, thousands, percent, currency, minus), data from cells (labels, series, header row, gaps, limits) | yes | `tests/chart-layout.test.ts` | | | |
| Axis ticks, scales, pie angles, bar / line / pie layout (empty, negative, non-numeric, tiny boxes) | yes | `tests/chart-layout.test.ts` | | | |
| Text of the cells of a table (text boxes and number equations) | yes | `tests/chart.test.ts` | | | |
| Chart as shape strokes + text boxes of one group, valid document, one undo step to insert | yes | `tests/chart.test.ts`, harness `doc=charts` | | | |
| Update chart: re-reads the table, same place / type / colour / title, one undo step, "same", refusals (gone, no link, no source, no data, locked, states) | yes | `tests/chart.test.ts`, harness `doc=charts` | | | |
| Dialog (type, title, colour, size, live picture, what was read), actions, help, ranking, commands, en + it | yes | `tests/chart-actions.test.ts`, `tests/ui-registry.test.ts`, harness `doc=charts` | | | |
| Reading the numbers from handwriting | no | | | | the plugin has no handwriting recognition: numbers are typed in text boxes |
| Updating by itself when a number changes | no | | | | explicit *Update chart* only (a chart is plain content; nothing watches the table) |
| Axis titles, stacked or horizontal bars, a secondary axis | no | | | | not in this wave |
