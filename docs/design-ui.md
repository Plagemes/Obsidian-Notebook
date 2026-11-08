# Design — interface (ui redesign)

Goal: a calm, premium, coherent interface for writing with a stylus (Samsung tablet + S Pen first, phone second,
desktop third), where every function sits where it is useful instead of in one long "…" menu. The interface is
**built from one action registry** and **assembled at run time from the context** (what is selected, what kind of
page is in view, whether a class is on, how wide the view is, what this person uses most). It is deterministic: no
AI, no network, nothing leaves the device.

## 1. Principles

1. **The page first.** Chrome is light, grouped and quiet; the page keeps the space. Panels float over the page only
   while they are needed.
2. **One place per job.** Writing tools are always in the same spot; what you do *to* something appears next to it
   (selection → contextual bar, page → page sheet, PDF page → PDF bar); rare actions live in a searchable sheet.
3. **Self-building, predictable.** The layout engine (`src/ui/layout.ts`) decides what fits and what is relevant; it
   never moves the fixed tools, and the "All actions" sheet keeps a stable, grouped order so muscle memory works.
   Only the quick slots and the "Recent" section adapt to use.
4. **Every visible control works** (CLAUDE.md rule 8). Controls that cannot work in the current context are hidden
   (not relevant) or disabled with the reason being obvious (read-only document).
5. **Pen, finger and mouse are all first-class.** Targets of at least 40 px, no hover-only affordances, nothing that
   needs a right click.
6. **Obsidian-native.** Colours, fonts and radii come from Obsidian's CSS variables, so light, dark and community
   themes apply. Icons are Obsidian's Lucide set via `setIcon`.

## 2. Surfaces

| Surface | What it is | When it shows |
|---|---|---|
| **Primary toolbar** | Top bar. Row 1: pages panel + the seven tools. Row 2: undo/redo · current pen (opens tool options) · favourite pens · *quick slots* · page indicator (opens the page sheet) · save state · **All actions** | Always. One row when the view is wide enough (`toolbarPlan`), two rows on tablets in portrait and phones |
| **Fade while writing** (0.25, off by default) | Toolbar, contextual bar and the floating pills dim to 15% (one class `is-tools-faded` on the view root, opacity transition only) while the pen writes; back on a touch outside the page, a pen hover or a press on a bar (the first finger touch only restores). Never during a selection or dialog | *Settings > Appearance > Toolbar while writing* |
| **Quick slots** | 0–6 ranked actions (insert image, stamps, add page, ruler, pen only, fit, board shot) | As many as fit the width: 0 on a phone, 4–5 on a tablet, 6 on desktop. Ranked by priority + recent use on this device |
| **Tool options popover** | Colour, width, eraser mode/filter/size, shape kind, text size, snap-to-text | Tap the active tool again, or the current-pen indicator |
| **Contextual bar** | Floating pill at the bottom of the page with a context label and its actions; can be collapsed to a single chip | Selection (copy, cut, duplicate, paste, white → transparent, save as stamp, delete, restyle rows; a **second row** under the main row with Select similar, Align and distribute, Rotate / mirror / size, wave 0.10) › lasso (paste, rectangle selection, select by colour or tool) › PDF side pane open (link, add notes page, show slide, close) › class now (board shot, new lecture, exercise page) › PDF page (search, hide annotations, dim, margins, open side by side) › image page (dim, margins) |
| **All actions sheet** | Grouped, searchable sheet (popover on tablet/desktop, bottom sheet on phone). Sections: **For this page** (0.24: up to five actions that fit the view in front of you, such as a selection, a PDF page, the lasso in hand, a lecture, the side pane or a presentation; hidden when there are none), Recent, Insert, Page, PDF & reading, Side by side, Lecture, View & input, Export & share | The ⊞ button at the end of the toolbar |
| **Page sheet** | The same component scoped to one page. First section **Go to**: *Go to page number…* (page number, `p12` or a bookmark), *Recently edited pages*, *One page at a time*. Then the page: arrange, bookmark, tags, **lock / unlock (0.16)**, paper and size as chips, orientation, infinite, split (heavy page), delete (the paper, size, orientation, infinite and delete rows are disabled on a locked page); insert after; PDF page actions; share/export | Tap the page indicator, or a thumbnail's menu in the pages panel |
| **Status banners** | Safe mode (*Open normally*, *Repair…*, *Show images and PDFs*), storage full (*Retry now*), integrity (*Restore the newer version*, *Restore a version…*, *Keep this version*), open on another device (*Open read-only*, *Open anyway*, *Edit anyway*), heavy page (*Split page*, *Dismiss*) | Only while the situation lasts; the banner owns its recovery buttons (they are listed in the registry with the `banner` surface) |
| **Radial menu** | Dark dial at the pen tip: undo/redo, width bubble, colour bubble, tool illustration, favourites · pen case · shapes | S Pen side button (or long press, per settings) |
| **Notebook menu** | Obsidian's "More options" of the notebook tab | Notebook-wide actions: open library, export notebook, zettel entries |
| **Home** | The library view on its Home surface (0.12, §11) | Greeting, Continue row (lecture in progress or last notebook, Quick page), quick actions, subject folders, recent notes by notebook, statistics, inbox bell |
| **Library** | The library view (0.12, §11): rail, filter chips, dashboard, notebook grid or list | Create, import PDF, lecture from slides, scan, loose sheet, library check, timetable |
| **Settings** | Plugin settings tab, generated from `view/settings-schema.ts` (§10): eleven sections by task, a search, collapsed *Advanced* and feature groups. 0.21: *Sync & safety* has the scheduled zip backups (schedule, folder, count) and a *Back up now* row (`view/backup-settings.ts`) whose description is the live status line | Diagnostics (pen button test, benchmark) are also commands |
| **Bulk import dialog** (0.16, `library/bulk-import-dialog.ts`) | Modal shell (wide): folder select, mode, paper and cover choices, one row per notebook (editable name, file line, "will be saved as" hint, × to leave out), a *Left out* group with reasons, then progress with *Stop after this file* and a summary with *Open*. A dashed frame with a label over the library while files are dragged in | Library *New > Import files…*, folder menu, drop of files on the library, a folder or a Board column |
| **Creation dialog** (wave 0.12) | One modal, three tabs as a segmented control (Planner added in 0.20): **Notebook** (cover preview with *Change cover* (pattern, colour, image) and a shuffle button for a new variation; name, description, folder list with icons, page template tiles drawn by the paper renderer, page size A4 · A5 · B5 · Letter · Custom in mm, orientation tiles), **Planner** (the same cover preview, name, description and folder; then year, calendar or academic year with a start month, language, week start, page size and orientation, and five section chips (year overview, monthly calendars, weekly spreads, daily pages, notes pages) with a page count and, above 200 pages, a plain warning; `create.planner.*`) and **Folder** (the library's own subject card as the preview, `ui/components/subject-card.ts`, above the form, with *Change colour* and *Change pattern*; name, description, location, icon row plus Lucide search, eight subject colours plus the colour picker). Inline name errors, Enter submits. A full-height sheet with the preview on top under 600 px. Decoration (header art band, glow behind the preview, faint art on the selected template tile) never acts as a control and is off with reduced motion | Registry actions `new-notebook` (Notebook tab) and `new-folder` (Folder tab), the command *New notebook* (`create`), *New folder*, the library's buttons and menus (through `host.createNotebook(folder)` / `host.createFolder(parent)`) |
| **Other dialogs, prompts and cards** (wave 0.13) | Everything that is not the creation dialog shares one shell (`ui/components/modal-shell.ts`): header (icon square, title, optional line, close ×, faint art band), scrolling body, footer with *Cancel* (secondary) and the primary action (accent; red for destructive). Prompts (go to page, page finder) get a slim header above Obsidian's input; floating cards (colour picker, equation editor, stamp palette) get the card look. Full-width sheets on phone. 0.23: the equation editor card has a quiet units hint under the preview (muted text in a dashed tile, ruler icon; a green tick line when the units agree), never a control | Same buttons and fields as before; this wave changes only the look |
| **Command palette** | Every command, hotkeys | All actions with `command` (ids unchanged since 0.5) |

## 3. Information architecture

Every action is an entry of `ACTIONS` in `src/ui/actions.ts` (id, label, icon, group, surfaces, contexts, priority,
command). The table below is the human version; `tests/ui-registry.test.ts` checks that every command registered
anywhere in `src/` is in the registry and that every action is placed somewhere.

| Action (id) | Lives in | Why |
|---|---|---|
| Pen, highlighter, eraser, lasso, shape, text, space (`tool-*`) | Toolbar row 1, radial pen case, commands | Used constantly; fixed position |
| Shape kind (`shape-*`), eraser mode (`eraser-*`), eraser size ± | Tool options popover, radial shapes ring (shapes), commands | Settings *of* a tool belong to the tool |
| Colour, width, text size, eraser filter, snap to text | Tool options popover; colour and width also on the radial | Same |
| Colour picker, eyedropper, style eyedropper (`colour-picker`, `colour-eyedropper`, `style-eyedropper`; wave 0.10) | Last buttons of the colour row of the tool options (the style eyedropper only for ink tools); picker and eyedropper also on the radial colour ring; commands | A free colour belongs with the other colours; they act on the pen in use. The picker is a floating panel over the page, the eyedroppers take the next contact on the page |
| Favourite pens 1–6 (`favourite-*`) | Toolbar strip, radial favourites ring, commands | One tap to a saved pen; long press / radial "+" saves |
| Pen sets (0.15, `view/pen-set-controls.ts`, manager `view/pen-sets-modal.ts`) | *Pen set* chip, first row of the pen and highlighter options; menu from the chip; manager dialog; Settings → Writing → Pen sets | A set replaces the six favourite slots for the notebook it is assigned to; the chip says which set is on; the user's own favourites are never overwritten by a set |
| Undo, redo | Toolbar, radial, two/three-finger taps, commands | Always needed |
| Pages panel (`toggle-pages-panel`) | Toolbar row 1 (first button) | Navigation is primary |
| Copy, cut, duplicate, paste, white → transparent, save as stamp, delete selection | Contextual bar (selection / lasso) | Act on what is selected, next to it |
| Restyle selection (colour, width) | Contextual bar, second row | Same |
| Insert image, stamps, add page, board shot, **sticky note (0.17)** | Quick slots (ranked) + Insert section | Frequent inserts one tap away when there is room |
| Sticky note actions: *Edit note* (dialog on the modal shell: text, the eight palette colours, text size), *Collapse note* / *Open note* | Selection bar when a note is selected | A note is a page element: move, resize, copy and delete are the ordinary selection tools; the note paper keeps its own colours (it is page content, like ink) in light, dark and night |
| Insert *Checkbox* (0.19) | Insert section of the sheet | Not a quick slot: most checkboxes come from drawing a square |
| Checkbox actions: *Tick / untick*, *Select with text*, *Label…* (small dialog on the modal shell), *Send to tasks…* (the task dialog of *Make task*), *Unlink task* (0.19) | Selection bar when a checkbox is selected | A checkbox is a page element drawn in the colour of the pen that drew it; a tap ticks it (no selection needed). A square drawn by hand gets the *Make checkbox* chip (`nb-chk-offer`: a floating chip on the shared chip component, 9 s, below the square, never over the line to its right) |
| Open items filter (0.19) | Notebook map chips | A page state like the others (icon `square-check`, count of unticked boxes on the badge, the label of the first as tooltip) |
| When a page was written (0.21, #217) | Notebook map cards, page header line | A quiet one-line caption under the card's thumbnail (`nb-map-when`, muted label size, tabular digits, one line with an ellipsis, also in the tooltip and the label) and the same short text after the page number in the header; both follow the setting *Show when a page was written*. Information only, never a control |
| *Group* (`group`), *Ungroup* (`ungroup`), *Lock* (`lock`) (0.20, #39) | Selection bar and All actions sheet, Obsidian commands | *Group* shows for two or more items that are not already exactly one group; *Ungroup* when any selected item is grouped; *Lock* when an element is selected. Picking a member picks the group, so there is no group handle or outline of its own: the selection box is the group |
| Locked element chip (0.20, #39) | Floats over the page, centred below a tap with the lasso on a locked element, 5 s (`nb-grp-chip`, on the shared chip component) | A lock icon and *Locked*, and one chip *Unlock*. A locked element is never selected, so this is the only way to reach it on the page; it goes by itself after 5 s, or when a selection is made |
| *Locked elements…* (0.20, #39) | Page menu and All actions sheet (only when the page has a locked element), command | A list on the modal shell: an icon and the kind and text of each locked element, tap the name to scroll to it, *Unlock* per row, *Unlock all* |
| Exercise page, page from template, insert PDF pages, image page, scan pages, scan as image | Insert section of the sheets; exercise page also on the lecture bar | Less frequent; grouped |
| Go to page number, recently edited pages, one page at a time (`goto-page-number`, `recent-pages`, `toggle-page-mode`) | **Page sheet, first section "Go to"** (tap the page indicator); also in the All actions sheet; one page at a time is also a quick slot | Getting to a page starts where the page number is |
| Back, forward (`nav-back`, `nav-forward`; wave 0.10) | **Quick slots** of the toolbar (rank 64 and 63, after insert image and add page) once the history of visited pages has somewhere to go; **page sheet, first section "Go to"**; All actions sheet; commands (hotkeys); the mouse's back and forward buttons on desktop | Returning to where you were is a navigation act and belongs next to getting to a page. Hidden until there is a history, so no slot is wasted; on a phone there are no quick slots, so the page sheet is the way |
| Minimap (0.17, #173) | A floating overview of the page in view (title bar with move handle and collapse, page picture, view rectangle) in one of four corners, or a round button when collapsed; shown on infinite pages and at high zoom; setting *Page overview (minimap)* | A navigation aid like the scrollbar: no command or registry entry. Panel tokens (`--nb-panel`, `--nb-shadow-float`), accent rectangle; sits below the lock badge and left of the fast scrollbar |
| Fast scrollbar (wave 0.10) | A thumb along the right edge of the page in continuous scroll; shown after a scroll or when a mouse nears the edge; setting *Fast scrollbar* | A control of the scroll itself, not an action: it has no command and no registry entry (page by page mode has its own swipe) |
| Outline in the page panel (0.13, roadmap 407) | Page panel, outline mode (list button): bookmarks, PDF and slide changes, large handwriting (a picture of the ink) and markers, nested; settings *Pages → Outline* switch each source | One list for where things are in the notebook. Rows are 44 px design-token rows (icon square, title, page), nested by level with a guide line, one "you are here" row; tap navigates. Built by the pure `model/outline-builder.ts` |
| Status bar item (wave 0.10) | Obsidian's status bar, desktop only: "p. 3/12 · Saved"; a click opens the page panel | Mobile has no status bar: the toolbar's page indicator and save state show the same |
| Page switcher across notebooks (`go-to-page`) | All actions sheet (Go to), library, palette | Leaves the notebook |
| Split a heavy page (`page-split`) | Heavy-page banner, page sheet (only on a heavy page) | Acts on that page |
| Check sync safety, check notebooks integrity (`sync-check`, `check-integrity`) | All actions sheet (Notebooks), notebook menu, settings, palette | Folder-wide checks, rare |
| Check library: unreadable notebooks and unused files (`library-check`; wave 0.10, roadmap 27) | Library sidebar (*Check library*), All actions sheet (Notebooks), notebook menu, palette | Folder-wide check, rare; opens a report that only lists, then a confirmation before anything moves to the trash |
| Banner buttons (safe mode, storage, integrity, other device, heavy page) | Their status banner only | Meaningful only while the banner is shown |
| **Lock page / Unlock page** (`page-lock`, `page-unlock`; command `page-lock-toggle`, 0.16) | Page sheet and the multi-selection menu of the pages panel; the **lock mark** beside the page number, a **badge** over the page (a button: a tap unlocks), the lock on a thumbnail of the pages panel (a button) and on a card of the notebook map (a badge and a lock button); the notice *Page locked · Unlock* when a write is refused | A finished page is protected from stray pen marks. The marks are state that is also a control (the badge, the panel lock, the map button), so each one works; the mark beside the number is the only one that only informs |
| Global bookmarks (0.24, #265) | Page sheet *Bookmark in the global list*; command and sheet *Global bookmarks*; Home chip *Bookmarks* (once the list has a page) | A dialog on the modal shell: a row per page (title, notebook and page number), four 44 px icon buttons per row (up, down, rename, remove); a gone page or a missing notebook is dashed with a Missing badge |
| Duplicate/move/delete page, bookmark, edit bookmark, page tags, paper, size, orientation, infinite, move to notebook, save as template, restore version, deleted pages | Page sheet (page indicator, thumbnail menu) and Page section | Act on one page, reached from the page |
| Select similar, align and distribute, rotate / mirror / exact size of the selection (`selection-similar`, `selection-align-menu`, `selection-transform-menu` and their entries; wave 0.10) | **Second row** of the contextual bar of a selection: three buttons, each opening a native menu of registry actions (so the first row keeps copy, cut, duplicate, paste, delete, to front, to back); every entry is also in the All actions sheet (Selection section) and a command that applies only with a selection | Operations on a selection belong next to it, but the first row is full on a tablet; the row is cut to the bar width like the first and appears only when it has something to offer (align needs two things, similar needs ink) |
| Clean up strokes (`selection-cleanup`; 0.23, #314) | **Second row** of the contextual bar of an ink selection, next to Select similar (the row is cut to the bar width), also in the All actions sheet (Selection section) and the command palette; the setting *Trim hooks as you write* is in Settings > Writing | Tidying the ends of strokes belongs to the selection, one tap, one undo step; the action is hidden without ink, and the notice counts what it did |
| Snap (`snap-toggle`; 0.17, #71) | Contextual bar of a selection (a checked toggle, the first button to go on a narrow bar) and the All actions sheet; shown only while the setting *Snap and guides* is not Off | Pauses the magnetic snap for this notebook view; the way out during one drag is a held finger or Alt. While a selection is dragged the live layer draws the guides (pink: items, teal: page and margins, faint blue: paper grid), one pixel wide, never interactive |
| Rectangle selection, select by colour or tool (`select-rectangle`, `select-by-style`; wave 0.10) | Contextual bar of the lasso (a checked toggle and a button), *Lasso \| Rectangle* in the lasso's tool options (tap the lasso again), All actions sheet while the lasso is on or something is selected, commands | The shape of a selection is a setting *of* the lasso; choosing by style needs no selection first |
| Layer order of the selection (`layer-front`, `layer-back`, `layer-forward`, `layer-backward`; wave 0.9) | Contextual bar of a selection (*To front* and *To back* rank above the rest of the second tier, so they fit the bar on a tablet; on a phone the bar is cut to its basics), All actions sheet, commands (they apply only with a selection) | Act on what is selected, next to it; the sheet and the hotkeys keep all four reachable |
| Date and time stamp (`insert-date-stamp`; wave 0.10) | All actions sheet, command | Inserts at the pen, so it needs no place of its own; the format is a setting |
| Copy to other devices (`selection-copy-devices`), Paste from another device (`selection-paste-device`; wave 0.10) | Contextual bar of a selection (copy) and of a selection or the lasso (paste), All actions sheet, commands (copy applies only with a selection) | Act on the selection or the lasso next to it; the sheet and the hotkeys keep them reachable on a phone |
| Find and replace in text boxes (`find-replace`; wave 0.9) | All actions sheet (Go to), command | Notebook-wide, rare; opens a panel |
| Page information (`page-info`; wave 0.9) | Page sheet, All actions sheet, command | Describes one page, reached from the page |
| PDF search, hide annotations, dim backgrounds | PDF contextual bar + PDF & reading section; search next/previous in the search panel and commands | Relevant only with PDF pages |
| PDF margins, update PDF, export annotations | PDF bar (margins), page sheet, PDF & reading section | Page-level PDF work |
| PDF side by side: open, link, show slide, add notes page, close | PDF bar (open), side-pane bar (the rest), Side by side section | Appear only when they apply |
| New lecture, exercise paper | Lecture bar during lecture mode, Lecture section | Class-time tools |
| Lecture mode (`lecture-mode`, 0.14) | All actions sheet (Lecture), command; automatic from the timetable (setting *Study → Lecture mode*: off / ask / automatic) | While it is on the contextual bar shows the lecture tools; a glass banner (icon square, text, *Start* / *Not now*) offers it in ask mode and a pill chip (top left, *Course · until HH:MM*, *End*) shows it; neither starts, asks or ends under the pen |
| Slide strip (0.14, #417) | Side-pane header button, actions sheet (Side by side group), palette | A modal on the shared shell: one row per slide (slide tile, chips for its page, notes, exercise page, linked ink, questions); filter chips *With notes* / *All slides*; empty state with *Open PDF side by side* |
| Drawing states (0.15, #241) | All actions and page sheet (*Drawing states*), palette; *Make part* in All actions (Selection) and in the strip | A strip floating at the bottom of the page: states chips (*As drawn* first) with a plus, previous / play / next; a *Parts* row (chips, *Make part* for the ink selected); while a part is in edit, an editor row (name, hide, put back, colour swatches, dissolve, done). Wraps on a phone; every control at least 40 px |
| Slide badges (0.14, #226) | Over the page, to the right of each block of ink written beside a slide | A 22 px pill (slide icon and number) in a 40 px transparent tap target; accent when that slide is in the pane; hidden with the text tool and by the setting *Slide badges* |
| Markers (`marker-gap`, `marker-question`, `marker-important`, `marker-critical`, `marker-star`, `marker-homework`), structured box (`marker-box`), End of lecture panel (`end-of-lecture`) | Lecture bar during a class, Lecture section, radial shapes ring → Markers ring (markers and box), page sheet (panel), commands | Captured while the lecture runs; the next tap or drag places one |
| Insert equation, insert graph (`insert-equation`, `insert-graph`; wave 0.9: math) | All actions sheet (Insert), commands | Inserted now and then; not quick slots, so the designed slots stay |
| Edit equation or graph, convert to ink (`math-edit`, `math-convert-ink`) | Contextual bar of a selection holding exactly one equation or graph (*Edit*) or equations (*Convert to ink*), commands | Act on what is selected; the graph panel and the equation editor float over the page while open |
| Excerpt to page…, copy as excerpt (`excerpt-to-page`, `excerpt-copy`; v10, roadmap 105) | Contextual bar of a selection and of the lasso with nothing selected (then the next drag outlines the region), All actions sheet (Insert), commands | Cut from what is selected or from the page under the lasso; the go-to-page picker chooses the target page, the clipboard carries it to another notebook |
| Go to source (`excerpt-open-source`) | Contextual bar of a selection holding an excerpt (first), command; also a tap on the excerpt's corner badge with any tool but the lasso and the eraser | The way back is next to the excerpt; the badge also works in read-only mode (it edits nothing) |
| Invisible ink (`invisible-ink`), show solutions (`show-solutions`, page: `show-page-solutions`) | View section of the sheet (ink and solutions), page sheet (page solutions), commands | A pen mode and view-only toggles |
| Read-only mode (`toggle-read-only`; wave 0.10) | View section of the sheet, command; while on, the lock button in the toolbar replaces the pen indicator and the favourites (and switches it off) | A mode of this view: the toolbar says so and offers the way out in the same place |
| Export pages as PNG images (`export-png`), Print (`print`; wave 0.10) | Sheet (Export & share), notebook menu, commands; both open *Export…* on that format. Print exists only where the device can print (desktop) | Choices of the one export dialog; no control that cannot work on a phone |
| Export written area (`export-area`), Export selection as picture (`selection-export-area`; 0.23) | Sheet (Export & share), notebook menu, command; the selection bar and sheet | One small dialog: what, format (PNG or SVG, both transparent), scale; Save and Copy |
| Copy as image (`selection-copy-image` on the second row of the selection bar from tablet width, `page-copy-image` in the page menu and sheet; 0.25) | Selection bar, notebook menu, sheet, command | No dialog: one tap; a notice says where the picture went (clipboard, share sheet or a saved PNG). Background in Settings, Integration |
| Pen gesture mode (`pen-gesture-mode`) | Quick slot, All actions sheet (View & input) | A toggle used in bursts |
| Gesture cheat sheet, custom gestures (`pen-gesture-sheet`, `pen-gesture-custom`) | All actions sheet (View & input), command palette; the cheat sheet also from the mode badge | Reference and set-up, rare |
| Ruler, pen only, fit to width | Quick slots + View & input section | Toggles used in bursts |
| Next/previous page | Commands (hotkeys), pages panel, scrolling | Keyboard only |
| Copy link, insert link/embed, export page PDF/SVG | Page sheet (Export & share) | Act on one page |
| Export notebook PDF | All actions sheet (Export & share), notebook menu | Notebook-wide |
| New/open/continue notebook, library, import PDF, lecture from slides, scan to new notebook, loose sheet, timetable, open class | Library, ribbon, command palette | Not inside a notebook |
| Pen button test, benchmark, stress test | Command palette (diagnostics) | Developer tools |
| Embed, restore version, tags, companion, repair, merge copies, restore page, zettel | Registered by their modules (integration, zettel); notebook menu where they add entries | Other features own them |
| Inbox (open, process next), textbook reference (set, open at a page, remove, insert) | Registry actions (wave 0.8): Inbox ones are global (`main.ts`), textbook ones are view actions (`view/view-actions.ts` → `view/textbook-ref-ui.ts`); "All actions" sheet and palette, same command ids | Zettel and reading groups |

### Page indicator: one behaviour

Tapping the page indicator ("3 / 12") always opens the **page sheet** of the page in view. Its first section is
**Go to**, with *Go to page number…* first, so jumping to a page is two taps (indicator → Go to page number…) and the
page's own actions are one scroll away. The old direct "tap → go to page" (wave 0.7) and the "…" page menu are merged
into this one sheet, so the indicator never means two different things; *Go to page number…* keeps its command for a
hotkey.

## 4. The layout engine ("generative UI")

`buildLayout(context, width, usage, now)`:

1. `toolbarPlan(width, slot)` (slot = button size + gap of the toolbar size setting, wave 0.9): one or two rows and how many quick slots fit (fixed metrics that match the CSS, so there is
   no measure → re-layout loop).
2. `contextBar`: the most specific active context (`CONTEXT_ORDER`) that has relevant actions; its actions ranked by
   `priority + usageBoost`, cut to `contextCapacity(width)`.
3. Quick slots: relevant `quick` actions not already in the contextual bar, ranked the same way.
4. `buildSheet`: Recent (up to 4 used actions not visible elsewhere), then the groups in `GROUP_ORDER` in registry
   order; with a query, a single ranked result list (label, keywords, group, accents ignored).

Use counts (`src/ui/usage.ts`, per notebook since 0.14: see *Adaptive rules*) are stored per device with `app.saveLocalStorage("notebook-ui-usage")`: count and last
use, half-life 14 days, boost at most 30 points (priorities are 0–100), so use reorders neighbours but never pushes a
designed primary action out.

### Adaptive rules (0.14, roadmap 392, 393, 402)

Deterministic tables in `src/ui/adapt.ts`; no learning model, no AI. Each family has its own switch (Settings > Appearance:
*Toolbar follows the page*, *Toolbar learns from each notebook*, *Selection bar follows what is selected*); with a switch
off the layout is exactly the designed order. A rule never shows an action that `when` hides: it adds a fixed amount to an
action's priority, so the same context, width and settings always give the same bar.

- **Page type (392).** `pageKindOf` (`src/ui/page-kind.ts`) reads the page's background, paper and size (nothing is stored):
  slide (PDF page at least 1.3 times wider than tall), PDF, image, ruled (ruled, Cornell, calligraphy), grid (grid, dotted,
  millimetre, isometric, hexagonal), plain. A slide puts the snapping highlighter (new action `toggle-snap-highlighter`, the
  same switch as the highlighter's option and the settings), PDF search and margins first and labels the bar *Slide*. The
  tools a page invites get a small accent dot (ruled: pen and text; grid: shapes; slide and PDF: highlighter; their order
  never changes), and on grid paper the ruler leads the quick slots.
- **Learning per notebook (393).** Use counts are kept per notebook (the document id, which survives a rename) in the
  device's local storage next to the device-wide counts (`src/ui/usage-store.ts`): at most 60 notebooks and 60 actions each,
  never in the notebook file or the vault, never synced. A notebook ranks by its own counts once it has 8 recorded uses;
  until then by the device's counts, so a new notebook is not a blank toolbar. *Reset the adaptive toolbar* forgets them.
- **Pinned slots (393).** Press and hold a quick slot, or a row of *All actions* that can be a quick action, to pin it (at
  most 3, plugin setting `pinnedQuick`). Pinned actions come first, in the order pinned, whatever the ranking and the page
  say; a pin that does not apply to the page (for example Back with no history) is skipped and returns when it does.
- **Selection by content (402).** `selectionKindOf` (`src/ui/selection-kind.ts`): ink, picture, text, mixed or object. Ink puts
  *Save as stamp*, *Select similar* and *Link* first; a picture *White to transparent*, front/back and transform; text *Link*;
  a mixed selection align and layer order. The bar is labelled *Ink selection*, *Picture selection*, *Text selection*,
  *Mixed selection*; the colour and width rows already follow the content (text: colour only; a picture: none).

## 5. Interaction: pen, finger, mouse

- **Pen** writes. Tapping a control with the pen works like a finger. The side button opens the radial menu at the
  tip; releasing the button over a control chooses it (flick), a tap chooses too. A pen stroke over a popover, sheet
  or bar never reaches the page.
- **Finger** pans and zooms (pen-only mode) or writes (finger mode). Taps on controls; long press on a favourite saves
  the current pen. Two-/three-finger taps undo/redo. Sheets on a phone are bottom sheets within thumb reach.
- **Mouse** clicks; right click on a favourite offers save/reset (also reachable by long press and from the radial).
  Escape closes popovers, sheets and the radial menu. Every action has a command for hotkeys.
- A tap outside an open popover/sheet closes it and is swallowed (no stray ink), as in Samsung Notes.
- **Tabs of open notebooks** (wave 0.10, 363): an optional strip above the toolbar (setting, off by default) lists the open
  notebook leaves; a two-finger sideways swipe on the toolbar strip, never on the page, goes to the next / previous one.
  The registry actions `notebook-next` and `notebook-previous` (sheet, command palette) do the same. The strip is not an
  action surface: its buttons are the open notebooks themselves.
- **Automatic line break** (wave 0.10, 353): a setting, not an action. After pen-up near the right margin on ruled or grid
  paper the view eases to the start of the next line; any touch cancels it, and it never moves while a contact is down.

## 6. Radial menu

A dark dial (always dark, in both themes, like a physical tool), 264 px, soft shadow and a subtle inner ring.

- **Main**: centre — an SVG illustration of the active tool (pen body, tip, a band in the current colour; the
  highlighter is a chisel marker; other tools show their icon on a pen-shaped body). Top-left undo, top-right redo.
  Left: width bubble (a dot of the current width). Right: colour bubble (filled with the current colour). Bottom: a
  pill with favourites · current tool (raised) · shapes & ruler.
- **Colour**: 12 swatches around the ring (pen or highlighter palette), a custom colour button with a rainbow ring
  (native colour picker) and an eyedropper (the next tap on the page picks the colour under it). The centre goes back.
- **Width**: an arc slider of growing dots with the value in the middle ("2", pt; eraser size in px; text size in
  pt). Drag or tap a dot.
- **Pen case**: the tools drawn as pens along an arc, pen and highlighter with a stroke preview in their colour; "+"
  switches to the favourites ring in save mode ("tap a slot to save the current pen").
- **Favourites**: the six favourite pens around the ring; tap applies, or saves in save mode.
- **Shapes**: line, arrow, rectangle, ellipse, ruler.
- Transitions: 160 ms scale/fade between states, none with `prefers-reduced-motion`.
- The public API used by the input code is unchanged: `new PenRadial(host, ctx)`, `open(x, y)`, `close()`,
  `noteTools(state)`, `isOpen`, `destroy()`.

## 7. Visual system

0.12: the tokens are the `--nb-*` set of DESIGN.md §2, declared once on `body` in `styles.css` (block *Notebook design
tokens*): a dark and a light palette (`body.theme-dark`, `body.theme-light`) and the *Follow Obsidian theme* mapping on
`body.notebook-style-obsidian`. The names below are kept as aliases (`--nb-surface` is `--nb-panel`, `--nb-accent-soft`
is `--nb-accent-bg`, …); before 0.12 they were built on Obsidian variables:

| Token | Value |
|---|---|
| Surfaces | `--nb-surface: var(--background-primary)`, `--nb-surface-2: var(--background-secondary)`, `--nb-surface-raised: var(--background-primary)` with `--nb-border: var(--background-modifier-border)` |
| Accent | `--nb-accent: var(--interactive-accent)`, `--nb-accent-soft: hsla(var(--interactive-accent-hsl), 0.14)` |
| Elevation | `--nb-shadow-1` (bars), `--nb-shadow-2` (popovers, sheets), `--nb-shadow-3` (radial, dialogs) |
| Radii | `--nb-radius-s: 8px`, `--nb-radius-m: 12px`, `--nb-radius-l: 18px`, `--nb-radius-pill: 999px` |
| Spacing | 4 px grid: `--nb-space-1` … `--nb-space-5` = 4, 8, 12, 16, 24 |
| Type | `--nb-font-ui: var(--font-interface)`; sizes `--nb-text-s: var(--font-ui-smaller)`, `--nb-text-m: var(--font-ui-small)`, `--nb-text-l: var(--font-ui-medium)`; section titles small caps-like uppercase 11 px, letter-spacing .06em |
| Targets | `--nb-target: 40px` minimum (44 px on touch layouts) |
| Motion | `--nb-motion-fast: 120ms`, `--nb-motion: 180ms`, ease `cubic-bezier(.2,.8,.2,1)`; all transitions are removed under `prefers-reduced-motion: reduce` |
| Radial | `--nb-dial-bg: #1d1e22`, `--nb-dial-ring`, `--nb-dial-fg` (fixed dark palette, readable in both themes) |

Components: icon buttons are 40 × 40, radius `--nb-radius-s`, transparent until hovered/active; the active tool has
the accent soft fill and an accent underline dot; groups are separated by 1 px dividers; popovers and sheets use
`--nb-radius-l` and `--nb-shadow-2`; the contextual bar is a pill with `--nb-shadow-2`.

**0.13: the editing chrome on DESIGN.md** (block `0.13 ds-notebook` at the end of `styles.css`, scoped under `.workspace-leaf-content .view-content.notebook-view` so it beats Obsidian's button rules). Icon buttons are 44 px at the normal size (`toolbarScale`: compact 40, normal 44, large 52; a normal bar on a view too narrow for eight of them uses 40, `toolbarScaleFor`); tools and history are capsules; popovers, sheets, the contextual bar and the banners are glass panels (`--nb-panel` over a blur, `--nb-border`, `--nb-shadow-*`); sheet rows have a 34 px icon square; the dial keeps its fixed navy palette with a hairline ring and accent halo; the status bar item and the page-operations `Menu` (tagged `nb-ui nb-menu`) follow the tokens. On touch every text button is at least 44 px; under `prefers-reduced-motion` the blur, glows, transitions and entrance animations are removed. Decoration (icon squares, halos) is never a control.

## 8. Accessibility

- Every icon button has an `aria-label` (and `title` on desktop); toggles use `aria-pressed`; buttons that open
  popovers use `aria-haspopup`/`aria-expanded`; sheets are `role="dialog"` with a labelled search field.
- Focus: `:focus-visible` ring of 2 px `--nb-accent`; Escape closes the topmost layer; the sheet search field gets
  focus on desktop only (no keyboard pop-up on tablets).
- Targets ≥ 40 px (checked by the harness at 360, 412, 740, 800 and 1280 px).
- The radial menu items are buttons with labels; the state is announced through a polite live region in the dial.
- Colour is never the only signal: the active tool has a fill and a mark, toggles a check.

## 9. Files

| File | Role |
|---|---|
| `src/ui/actions.ts` | Registry and context types (pure) |
| `src/ui/layout.ts` | Layout engine (pure) |
| `src/ui/usage.ts` | Use counts (pure) |
| `src/ui/radial-model.ts` | Radial palettes, width scales, arc geometry (pure) |
| `src/ui/action-sheet.ts` | Sheet component (All actions, page sheet) |
| `src/ui/components/*.ts` | 0.12 design-system components: subject card, section header, chips, list row, favourite row, KPI tile, quick action, search pill, navigation rail, icon square |
| `src/library/library-view.ts`, `home-view.ts`, `home-surface.ts`, `library-sections.ts`, `inbox-bell.ts` | 0.12 library and Home (§11) |
| `src/library/greeting.ts`, `activity-log.ts`, `home-stats.ts`, `home-data.ts`, `page-thumbs.ts` | 0.13 Home: greeting, writing activity, pure statistics, what the widgets show, page thumbnails (all but the last are Node-testable) |
| `src/zettel/inbox-view.ts`, `modals.ts`, `zk-ui.ts` | 0.13 Zettelkasten surfaces: the Inbox page, the card dialogs, the card list (§12) |
| `src/library/dashboard.ts` | Subjects, smart collections, statistics (pure) |
| `src/ui/context-bar.ts` | Contextual bar component |
| `src/ui/dismiss.ts` | Tap-outside / Escape closing shared by popovers and sheets (a tap on the page draws nothing) |
| `src/view/view-actions.ts` | What each view action does (one runner per registry id) |
| `src/view/view-ui.ts` | Mounts the contextual bar and the sheets, runs the layout engine once per frame, keeps the use counts |
| `src/view/commands.ts` | Generates the Obsidian commands from the registry |
| `NotebookView.uiContext()` / `runAction()` | The view's context for the engine, and the single entry point that runs and counts an action |
| `src/view/toolbar.ts` | Primary toolbar (quick slots from the layout) |
| `src/view/radial-menu.ts` | Radial dial |
| `src/view/settings-schema.ts` | The settings tab described once: sections, groups, rows, visibility and search (pure) |
| `src/view/settings-tab.ts` | Draws the settings tab from the schema (Obsidian 1.13+ definitions and the older hand-drawn tab) |
| `src/view/create-dialog.ts`, `src/view/create-logic.ts` | Creation dialog (wave 0.12) and its pure rules (names, sizes, folder list, the new document) |
| `src/ui/components/modal-shell.ts`, `modal-shell-model.ts` | The shared shell of every other dialog, prompt and floating card (wave 0.13) |
| `src/ui/components/subject-card.ts` | The subject card (DESIGN.md §3) shared by the library, Home and the creation dialog's folder preview: `subjectCard(parent, { name, color, seed, artStyle?, icon?, lines, shape, art, onOpen? })`. The art is laid out beside the icon and text, never under them: in a row from the end of the text to the right edge, in a tile the column right of them (a long name narrows it) |
| `src/library/folder-meta.ts`, `folder-meta-store.ts`, `folder-meta-events.ts` | Folder colour, icon, description and art style (per-device sidecar in `_meta`), the read API `getFolderMeta` / `onFolderMetaChange`, renames |

## 10. Settings

The plugin's settings tab follows DESIGN.md §6. It is generated from one list, `src/view/settings-schema.ts`
(pure, tested in Node), and drawn by `src/view/settings-tab.ts` in both ways Obsidian draws a tab: the declarative
definitions of Obsidian 1.13+ (`getSettingDefinitions`, groups with `visible` predicates, re-evaluated with
`refreshDomState()` after every change) and the hand-drawn tab of older versions (`display()`, the same rows, shown or
hidden in place). Both read what to show from one function, `settingsView`, so they cannot drift.

### Sections

| # | Section | What goes there |
|---|---|---|
| 1 | **Writing** | Defaults of new notebooks (paper, page size, orientation), how ink behaves (stabilization, ink follows objects, automatic line break). Advanced: area eraser removes text and images, date stamp format, predicted ink, low-latency ink |
| 2 | **Pen & input** | Finger drawing, palm rejection, pressure, the S Pen side button and its options, finger long-press, finger taps, scribble to erase. Group *Pen gestures*. Advanced: large touches, zero-pressure press, button while writing, edge rejection and its zones |
| 3 | **Pages & navigation** | Scrolling, fast scrollbar, add a page at the bottom, scroll up near the bottom, page-turner keys |
| 4 | **PDF & reading** | Snap highlighter to text, dim backgrounds and strength, crop PDF margins |
| 5 | **Library & files** | Notebooks folder, trash retention, version history (backups). Advanced: loose sheet location, templates folder |
| 6 | **Sync & safety** | Device name, check sync safety (only when the sync safety service runs). 0.22: the *Cloud sync* group (collapsed while off; service, client ID and Google client secret, account, *Sync now* with the status line, scope, triggers, Wi-Fi only, large files, activity log) |
| 7 | **Export** | Export settings, when there are any (the section is hidden while it is empty) |
| 8 | **Obsidian integration** | Tabs of open notebooks, companion notes and their options |
| 9 | **Study** | Groups *Class timetable* (edit, offer the current class, open without asking, start early) and *Zettelkasten* |
| 10 | **Appearance & language** | Language, Style (Notebook / Follow Obsidian theme), toolbar size, night mode, tips (on/off, *Show tips again*) |
| 11 | **Diagnostics** | Pen button test, performance benchmark, performance overlay (the first two are also commands) |

### Rules

- **Placement.** A new setting is a `SettingSpec` in the section where a person would look for it, next to related
  settings, with an `order` (gaps of 10 leave room). Never at the end of the list, never a new section for one feature.
- **Most used first.** The main rows of a section are the common choices; the rest gets `group: ADVANCED`, a collapsed
  *Advanced* row that shows how many settings it holds.
- **Relevance.** A dependent option has `parent` and `visible` and is shown only while its parent is on (a dependent of
  a dependent also follows the root). Options of a feature not in use sit in a collapsible group (`GROUPS`) whose `open`
  predicate says when the feature is in use; the person can open or close any group, and that choice lasts while the
  tab is open. Rows that need a service (sync, timetable) are hidden when it is not running. A section with nothing to
  show is hidden.
- **Search.** The pill at the top filters every row by name, description, section and group title in every UI language
  (accents and case ignored, every word must match) plus a few keywords. While searching, groups are expanded and their
  disclosure rows hidden, the section headers of the matches stay, a match whose parent is off shows the parent instead,
  and "No setting matches" appears when nothing does. Obsidian's own settings search also finds the rows: their names in
  the other languages are passed as `aliases`.
- **Wording.** Short names in sentence case, at most one line of description (`tests/settings-schema.test.ts` limits
  names to 48 and descriptions to 90 characters in every language), all strings in `en.ts` and `it.ts`.
- **Keys.** Every key of `DEFAULT_SETTINGS` is in exactly one section, except the internal keys listed with their reason
  in `INTERNAL_SETTING_KEYS` (favourite pens, eraser size, recent colours, side-button-seen flag, last notebook / page /
  position, Zettelkasten slip boxes). The test fails when a new key is in no section.
- **Look.** The design-system tokens (DESIGN.md §2.1–2.2: `--nb-bg`, `--nb-panel`, `--nb-tile`, `--nb-border`,
  `--nb-text`, `--nb-text-muted`, `--nb-accent`, `--nb-accent-bg` and radii) are the global ones of `styles.css` ("Notebook design tokens");
  *Style → Follow Obsidian theme* (`appearanceStyle`, class `notebook-style-obsidian` on `body`) maps them onto Obsidian's variables.
  Each section is a panel (16 px radius, 1 px border) with an icon square and a 20 px / 600 title; rows have a 15 px / 500
  name and a muted 13 px description with the control on the right (under the name on a phone); dropdowns and buttons
  are pills, text fields 14 px tiles, all at least 40 px tall; the search pill stays at the top while the list scrolls.

### Extension point: S Pen button settings

New rows of the side button are added to `PEN_BUTTON_EXTENSIONS` in `src/view/settings-schema.ts` (the marked block),
with `section: "input"` and an `order` from 41 to 49, so they sit between *Pen side button* (40) and *Hold the pen still
for the radial menu* (50); use `group: ADVANCED` for the rare ones, and `parent: "penSideButton", visible: penButtonOn`
when they only matter while the button does something. Their keys go in `DEFAULT_SETTINGS` and their strings in
`en.ts` / `it.ts` as usual; nothing else in the tab changes. The 0.11.2 S Pen settings live there:

| Row | Key | Place | Shown |
|---|---|---|---|
| *Button click: next stroke erases* | `penButtonEraserNext` | order 41 | while the side button does something |
| *Pen key* | `penButtonKey` | order 42, custom row `pen-key` (dropdown, key capture, hotkey warning; `view/pen-button-settings.ts`) | always (the key works whatever the button does) |
| *Pen key action* | `penButtonKeyAction` | order 43, parent *Pen key* | once a key is set |
| *Button before / after contact* (side button timing) | `penButtonContactBeforeMs`, `penButtonContactAfterMs` | *Advanced*, orders 31-32 | while the side button does something |

A row that needs its own drawing uses `control: { type: "custom", render: … }` with a new `SettingCustomId` handled by
`renderCustom` in `settings-tab.ts`; an action row uses `{ type: "action", run: … }` with a new `SettingActionId`
handled by `run`.

## 11. Home and the library (0.12, DESIGN.md §3–§4)

Home (`docs/design/reference/home.png`) and the library (`library.png`) are two surfaces of one view
(`src/library/library-view.ts`; `HomeView` in `home-view.ts` only opens it on Home). They share the library index,
the reading pass and the thumbnail queue, and switch in place from the navigation rail. Everything they show is
computed on the device from the index (`src/library/dashboard.ts`, pure and tested) and from this device's recent
pages log; nothing is invented and empty sections are hidden, except where something can be created (below).

**Creation is always reachable (0.12.2).** The header of Home and of the library ends with the primary **+ New** pill
(`ui/components/new-button.ts`), aligned in the header row; it opens the New menu. (0.12.2 also had a compact **+** in
the rail; 0.12.3 removed it: it sat on the brand, and creation belongs to the header and the quick actions.) Home's quick actions are always shown. A vault with no
notebooks shows an empty state (`ui/components/empty-state.ts`: the art engine's `emptyStateImage`, *Start your first
notebook*, one line, *Create a notebook* · *Create a folder* · *Import a PDF*) on Home, in the library's *All* and
*Subjects* and in an empty notebooks folder, and Home hides the statistics until there is something to count.
*Subject folders* with no subject folders shows a dashed *Create a folder* tile (`ui/components/create-tile.ts`,
the creation dialog's Folder tab) in place of the cards, on Home, in the library dashboard and on the subjects page.
An empty folder offers the same three buttons for that folder; lists that fill up by themselves (favourites, recent,
a tag, a collection, the archive, a search) only explain how. Each Home section is drawn on its own: one that fails is
logged and does not take the rest of Home with it.

**Shell.** Navigation rail (`ui/components/nav-rail.ts`): brand; *Home*, *Notebooks*, *PDF* (only when a notebook has
PDF pages), *Tags*, *Settings* (opens the plugin's settings tab); *Vault*: the folder tree under the notebooks folder,
each folder with the colour of its subject (top-level folder) and its folder menu (long press or right click), a drop
target for dragged notebooks; 0.17 (#120): above *Vault* a *Collections* section (saved rules over the library: a row per collection with its live count, a pencil that appears on hover and is always shown on touch, and a *New collection* row; the editor is a shell dialog `nb-coll-editor` with a live count); at the bottom *Archive*, *Trash*, *Check library*. Width classes of the view: **wide**
(≥ 1100 px: rail with labels, which a fold button turns into icons), **medium** (600–1099 px, a tablet in portrait:
icons only, subject folders only in the tree), **phone** (< 600 px: the rail is a sheet from the left, opened from the
menu button of the header). Page header: title and subtitle (a folder shows its breadcrumb, each part a link and a
drop target), the search pill (Ctrl/⌘ K on desktop), the *Now: course* button while a class is on, the inbox bell; on
the library also tag filter, sort and grid / list; on both, last, the primary *+ New* (a menu of New notebook, New folder, Import PDF, Lecture from
slides, Scan, Loose sheet; inside a folder the notebook and the folder go there, elsewhere New notebook and New folder
run the registry actions `new-notebook` and `new-folder`; all of them open the creation dialog, `view/create-dialog.ts`).

**Home (0.13, structure revised; same visual style).** Top to bottom:
1. *Header*: the title, and as subtitle a greeting that follows the clock ("Buonasera, Alex · 3 pagine scritte oggi": morning 05-11, afternoon 12-17, evening 18-21, night 22-04; the name is the setting *Appearance → Your name*, no name = no name; with no page written today the count becomes "Ready when you are"). Pages written today come from the writing activity log below. Search, the bell and *+ New* stay where they were.
2. *Continue row*: the hero card (2/3 of the width; stacked on a phone) with a large page thumbnail of the lecture in progress: the timetable's current class, its notebook (the class's link: a notebook, or a course folder whose latest notebook opens: `pickTarget`, `TimetableService.nowTarget()`), the page last edited when known. The button (and a tap anywhere) is `openNow`, which opens it at today's lecture page. With a course whose folder has no notebook yet the thumbnail is a dashed blank and the action is *Start a notebook for <course>* (creates it in the course's folder). With no class in progress it is *Continue where you left off*: the last opened notebook (the instant-start setting), else the one changed last. With no notebook at all the slot holds the empty state that teaches the first step. Linking a course to a folder already exists: the timetable editor's *Notebook or folder* field. Beside it (1/3) the *Quick page* card: one tap opens Quick notes (made the first time) at a new blank page of the last page's size and paper; a last page still blank is shown instead, so tapping twice never piles up empty pages.
3. *Quick actions*: low tiles (about 70 px: icon and title; the description is the tooltip and `aria-description`); two per row on a tablet in portrait and on a phone.
4. *Subject folders*: a three-column grid of low cards (two on a tablet in portrait, one on a phone; as many cards as fit, *Show all* for the rest), ending in the dashed *New folder* card, which spans the rest of the last row so the grid has no gap.
5. *Recent notes* next to *Statistics* (stacked below a wide view). Recent notes are grouped by notebook (three notebooks, three pages each): the notebook header (subject pill, kebab = the notebook menu) and its pages, each with its own page thumbnail on the left (drawn on demand, one at a time while the pen is quiet, cached in memory) and a ⋯ menu on the right: *Open page*, *Open in a new tab*, *Show in the library* (the folder opens and the notebook's card is scrolled into view and flashed), *Pin / Unpin*, *Favourite*. A chip row filters by subject (shown with two or more subjects). *Statistics*: *Pages written* (a bar chart of the last 7 or 14 days, switch kept in the view state, today's bar in solid accent, a text description for assistive tech), *Days in a row* (the streak; it stays alive until the day ends), *Writing time (estimated)*, *PDFs annotated* and *Most active subject* (a bar split by subject colour with a legend). Widgets that are zero are hidden; the chart turns into a hint with *Write now* when nothing was written, and *PDFs* into *Import your first PDF →* (it starts the import) when the library has no PDF notebook. Everything is CSS (no chart library), in token colours.

**Writing activity (0.13).** `library/activity-log.ts`, kept in the device-local storage of Obsidian next to the recent pages log (`view/recent-pages.ts`): per day, the pages edited (short notebook/page key and the notebook's path, which follows renames) and the minutes of the day in which something was written; 90 days, 300 pages a day; never in a notebook or a synced file, no format change. Pages from the recent pages log (their last edit) are folded in when Home reads it, so the days before the log existed still show. Writing time is the number of minutes with an edit: an estimate, per device.

**Sidebar (0.13).** Under the navigation: *Pinned* (notebooks pinned with the library's pin, and folders pinned from their menu; at most eight; every row opens on tap and has the same press-and-hold / right-click menu, which unpins it; with none, one line says how to pin), then *Vault*. Folder rows show the notebook count and the pages inside ("12 · 248 p"; the tooltip words both). Pinned folders are the `pinned` field of the folder metadata (`folders-<device>.json`, merged per field like the colour, followed by renames); pinned notebooks are the library state's `pinned`.

**Dynamic sections (0.14).** *Now*, *To complete* and *Changed on another device* (rules in `library/dynamic-sections.ts`) are panels above the subject folders on the library dashboard (list rows with the reason as the second line, a count badge, *Show all*; Changed also has *Mark as seen*), places of the library (`{ collection: "now" | "todo" | "changed" }`, so the grid, list, search and empty states are the ones of the smart collections), sidebar items with counts under Notebooks and a chip row under Home's Continue row. Each is drawn only when it has something. Recent is Home's Recent notes.

**Library.** Filter chips *All · Subjects · Recent · Favourites · With PDF · Archive* (single choice). *All* shows the
dashboard: subject cards (four in a row, two on a tablet in portrait, two compact ones on a phone), *Smart
collections* (To study: open gap, question or homework markers or a to-study tag; Favourites: starred or pinned;
With PDF; Recent: changed in the last 7 days; Exams: an exam tag; empty ones hidden), *Frequent tags* (subject
colours on tags that name a subject), *Recent notebooks* next to *Favourite notebooks* (page thumbnail from the index
cache, amber star that writes the notebook's metadata), then *All notebooks*: the 0.10 grid (pinned group, manual
order, drag, keyboard) or the same cards as a list, drawn 60 at a time with *Show more*. A folder shows its
subfolders as subject cards and its notebooks. Search groups its results as folders, tags and notebooks (with the
page of a text match); in a folder, tag or collection a chip switches between this view and everywhere.

**Folder look and covers.** Subject and folder cards are the shared `ui/components/subject-card.ts` (also the creation
dialog's folder preview). Their colour, the symbol on the folder icon and the art style come from the folder metadata
(`host.folderMeta.getFolderMeta(path)`, redrawn on `onFolderMetaChange`), else from `colorFor(name)` and
`artStyleFor(name)`; the rail tree and the subject pills use the same colour. A notebook made with a v11 cover
(`meta.coverArt`, kept in the index as `coverArt`) shows that cover in the grid instead of its first page.

**Inbox bell.** `library/inbox-bell.ts`, through the Inbox service's public API (`zettel/inbox-service.ts`): the
badge counts the open items of the last scan (hidden at 0); the first scan runs once the library has been read and
the pen is idle, and again when the bell opens if the last one is older than two minutes; the service's change
events keep the badge current. The popover (a bottom sheet on a phone) lists eight items with *Open in notebook*,
*Process in the inbox* and *Discard*; *Open inbox* opens the Inbox view.

**Decoration.** Generated art (the art module) behind the page header, on subject cards, smart collections, quick
actions and empty states, and a soft accent glow behind section titles. It never takes input, never covers text and
is removed under `prefers-reduced-motion: reduce`.

## 12. Zettelkasten surfaces (0.13, DESIGN.md §3–§5)

**Inbox.** `zettel/inbox-view.ts` is an `nb-ui nb-app` page: header (title, count, *Start processing*, refresh, a faint generated band from `zk-ui.ts`), filter chips (`ui/components/chip`) with a *Show processed* toggle, and one `nb-panel` per notebook coloured by `colorFor(name)` (subject variables). Item rows are buttons (icon square by kind, first line, page, state pills, chevron) that expand in place; the panel holds the ink preview, the text and the actions (one accent action). Under 600 px (`is-phone`, a ResizeObserver) the panel stacks. Each part (filters, list) is drawn through `drawSafely`, so a failure leaves an error card, not an empty view. The first scan shows placeholder rows; empty states use `ui/components/empty-state` with the generated illustration.

**Dialogs.** `zettel/modals.ts`: `CardModal` and `ConfirmCardsModal` carry `nb-ui` on the modal element; head (icon square, title, one line), labelled fields, the card type as radio tiles (`CARD_TYPE_LOOK`: permanent blue, literature amber, fleeting violet), a tag preview, footer buttons. `CardListModal` keeps the fuzzy suggest behaviour and draws rows as id, title, location.

**Card regions** over the page (`notebook-zettel-region`, `overlay.ts`) are unchanged: tokens only, no pointer events.
## Hint bubble (0.13)

A just-in-time tip (`src/ui/components/hint-bubble.ts`, rules in `src/ui/hint-logic.ts`): a floating card at the bottom centre
(`--nb-panel`, `--nb-border-strong`, `--nb-radius-card`, `--nb-shadow-float`), an accent icon square, a 15 px title, one 13 px
sentence in muted text, a *Turn off tips* link and a 40 px × button. It never takes focus, disappears after about 12 s and shows
once per tip, at most one per 4 minutes and not while the pen is writing. Tips are switched in Settings → Appearance & language.

## Orientation and size classes (0.14, roadmap #430)

`src/ui/viewport-class.ts` classifies a view (not the screen) by width, height and aspect: `nb-vp-phone|tablet|desktop`, `nb-vp-portrait|landscape`, `nb-vp-short` (landscape under about 480 px of height), plus `data-nb-viewport="tablet-landscape"` on the root of the notebook view and of Home / the library. Thresholds are sticky (hysteresis), so rotation or a dragged split does not flicker. Surfaces adapt with CSS only: short landscape tightens the toolbar, context bar and page headers and gives dialogs the whole window height. A fine pointer on a wide view is a desktop; a coarse pointer never is.

## Notebook map (0.14, roadmap #408)

A dialog on the shared shell (`modalShell`, wide, no footer) opened by the grid button in the page panel's header. Body: a row of filter chips (`chip`, one per state that exists, with the page count) and an auto-fill grid of cards (`.nb-map-card`: thumbnail, state badges at its bottom right, page number and earliest due date below). Badges are small pills with the state icon (question, gap, homework, practice, empty, key point) and a number when there are several; they are decoration of a card that is itself the control. The current page has an accent border, a lecture's first page an accent top edge. Thumbnails come from the page panel's cache, drawn lazily at the first pause in writing. Logic: `src/model/notebook-map.ts`; view: `src/view/notebook-map-modal.ts`. 0.20 (#102): when the handwriting has headings, a *Titles* chip (icon `heading`, count of pages) keeps only the pages that have one, and a card shows up to two pictures of them under the thumbnail (white sheet, 1 px border, `.nb-map-title`, drawn lazily with the thumbnail from the shared bounded heading cache); a picture is a small button (a span with `role="button"`) that goes to the line. Logic: `src/model/heading-index.ts`.

## Move a selection to a page (0.16, roadmap #78)

A wide dialog on the modal shell, with the notebook map's classes (`nb-map-modal nb-move-modal`): the same auto-fill grid of cards (`.nb-map-card`, thumbnail from the page panel's cache, page number). The first card is dashed with a plus (*New page after N*), the source page is not offered, and one chip (*Keep exact position*) sits above the grid. Tapping a card is the whole interaction: the dialog closes and the toast offers *Go to page*. View: `src/view/page-picker-modal.ts`; logic: `src/model/selection-move.ts`.

## Shared files (0.16, roadmap #177)

PDFs and images shared to Obsidian from other apps (they land in the attachments folder) are offered where the user starts: a *Shared files* panel on Home between the dynamic-section chips and the quick actions (library list rows, the newest three, a count badge, *Show all*; drawn only when something waits, by `library/shared-inbox-ui.ts`), a *Shared files* rail item with a count under Notebooks, and a full list in a shell dialog (`SharedInboxModal`, wide). A row's tap and its kebab open the same menu: *New notebook from it*, *Add to notebook...*, *Dismiss*, *Move to trash*. The notebook picker is the search list of *Move to notebook*; an image adds a two-row choice dialog (*As a new page* / *On a page*) on the modal shell. Dialogs that delete (*Move to trash*, the offer to move the original after use) are confirmations with the destructive button.

## Library views: Board and Calendar (0.15, roadmap #161 #162)

The library header has a **Views** button (board icon; calendar icon while the Calendar is on) next to the grid / list toggle, opening a menu of *Cards*, *Board*, *Calendar*. The mode is part of the view state (`layout`). Not offered on Home, Subjects, Tags and the archive. Both modes show the notebooks of the current place (`placeQuery`), keep the chips row, and use only `--nb-*` tokens under `.nb-ui`.

**Board** (`src/library/board-view.ts`, pure logic in `board-logic.ts`, statuses in `board-state.ts` / `board-state-store.ts`). Columns are panels with a 3 px top edge and a dot in the column colour (`--nb-c`), a name, a count bubble and a stack of low cards (colour edge from the notebook cover, title, pages · last change, tags, a 44 px ⋯ button). A column under a dragged card gets the colour outline and tint (`is-drop-target`). Wide and medium: columns of at least 240 px side by side, scrolling sideways inside the board. Phone: a strip of 40 px column tabs (also drop targets) over one column. Dragging reuses `attachPress` (`drag.ts`): `data-drop-column` marks a column or a tab; `onDragMove` scrolls the board near its edges. The columns editor is a shell dialog (`src/view/board-columns-modal.ts`, narrow rows with a name field, eight palette swatches, up / down / remove), opened from the Board's header and from *Settings › Library*.

**Calendar** (`src/library/calendar-view.ts`, data in `calendar-logic.ts`). Header row: previous, the month (week on a phone), next, *Today*. A month grid of 7-column rows of 56 px day buttons: the date, up to three dots in the colours of the notebooks written that day, a tint stepped by the day's amount (`lvl-1`…`lvl-4`), an accent date for today and an accent border for the selected day. Beside it (under it on a narrow tablet) the selected day's panel: its notebooks as rows (cover colour edge, name, "N pages written" / *Created* / *Changed*) with *Page N* chips under a row when the pages are known. Phone: a week strip and an agenda of the week, a section per day with writing (and the selected day).

## Storage manager (0.15, roadmap #128)

A wide dialog on the modal shell (`src/library/storage-dialog.ts`, styles under `.nb-storage-modal`): a summary card (total, a stacked bar that is not a control, a legend), then sections in a fixed order: Notebooks (sort chips), Unused files, Duplicate pictures, Heavy pictures (threshold chips), Old backups and copies. Rows are at least 52 px; every row with a checkbox or a button is a 40 px target; the action button of a list sits under it and names how many files and how many bytes it will touch. Every action opens a confirmation (`confirmList`) that lists every file or notebook; Escape, × and Cancel change nothing. While a scan or an action runs the dialog carries `is-busy`. Reached from the library rail, the command palette and *Settings → Library*.

## Presentation mode (0.16, roadmap #87)

A black overlay (`.nb-ui.nb-present`, fixed, above the notebook and Obsidian's own chrome; the notebook container also asks the Fullscreen API where it exists) with one page fitted to the screen, a laser canvas, a pill-shaped page counter at the bottom and three 44 px round buttons at the top right (laser, write while presenting, exit). The counter and the buttons fade out after 2-3 seconds and come back on any tap or pointer move; with *write while presenting* the buttons stay and the overlay becomes transparent so the notebook's own canvas takes the pen. The surround is black in both themes (a stage, not a surface); the controls use `--nb-accent` when on. Settings: *Settings > PDF & reading* (*Present drawings with states step by step*, *Pen is a laser pointer while presenting*). The notebook map has a *Presentation* button next to its filter chips; the More sheet has *Presentation* in the View section.

## PDF text and links (0.16, roadmap #45 #46)

**Select text** is a mode of the notebook view, not a tool: the registry action `pdf-select-text` (group Reading, contextual bar of PDF pages after *Search*, the sheet, the command) toggles it. While it is on, a slim pill at the bottom of the page area (`.notebook-pdftext-bar`, `--nb-surface-raised`, pill radius, a 40 px *Done* button in the accent colour) names the mode and ends it. Every contact (pen, finger, mouse) selects; the input policy lets a finger select, and nothing is drawn. The selection is a translucent accent-blue fill on one overlay canvas (`.notebook-pdftext-overlay`, never saved); the links of the visible PDF pages are outlined with a dashed line while the mode is on, so it is clear what a tap follows. A floating bubble (`.notebook-pdftext-bubble`, `--nb-shadow-float`) sits above the selection (below it when there is no room): *Copy* (accent tint), *Copy as quote* and a clear button, each at least 40 px; below 420 px wide the labels go and the icons stay (with their `aria-label`).

**PDF outline** in the Outline of the page panel: rows of kind `pdf` (book icon in the accent colour) nested under the PDF's row; with *Its own section* a small uppercase heading *PDF outline* (`.nb-outline-section`) opens the list. An entry whose PDF page is not in the notebook shows a note under its title (it goes to the next page that is).

**Web links** ask in a narrow shell dialog (`.notebook-pdflink-modal`): the address in a monospace block, *Cancel* and *Open link*.

## Merge, split, extract pages (0.17, roadmap #77)

One narrow-to-wide dialog on the modal shell (`nb-xfer`, `src/library/transfer-dialog.ts`) with three bodies. *Merge*: a search field over a short list of notebooks (single choice, accent border on the chosen one, its page count under the list), a *Where the pages go* select (*At the end* or *After page N*) and a *Move the merged notebook to the trash afterwards* check. *Split*: a select of the page the new notebook starts at, one sentence saying what stays and what goes, the new name. *Extract*: a checklist of pages (number, start of the first text box, a lock mark for a locked page; *All* / *None*), two chips (*Keep them here* / *Remove them from here*), the new name. Whatever takes pages out of a notebook turns the primary button into the danger button and says so in its label; locked pages that would leave add a bordered, accent-tinted block with its own check, and the button stays off until it is ticked. The notebook map gets a *Select pages* chip: in that mode a tap toggles a card (accent ring, `aria-pressed`) instead of going to the page, and a sticky bar shows the count, *Extract…* and *Split before this page…*. Library menu items: *Merge another notebook into this one…*, *Split at a page…*, *Extract pages to a new notebook…*. Logic: `src/model/notebook-transfer.ts` (plans), `src/library/transfer-logic.ts` (what the dialog may do), `src/library/page-transfer.ts` (the run).

## Margin comments (0.18, roadmap #86)

Numbered markers in the right margin of a page (`nb-cm-marker`, 24 px disc with a larger invisible target, the accent colour; resolved ones are muted with a check), each joined by a thin line to a faint dashed outline of its region. A tap opens the comment's card and highlights the region (solid outline, accent tint); a tap on the marker again closes it. The card (`nb-cm-card`, the shared card surface: panel colour, `--nb-shadow-float`) floats beside the marker on a tablet or desktop and docks to the bottom edge on a phone: number badge and title, the thread (author, time, *edited*, text, the sketch, Edit and Delete icon buttons; replies indented with an accent rule), a reply box with a send button, and a *Resolve* / *Reopen* pill. The side panel (`nb-cm-panel`, command and sheet *Comments panel*) floats at the right edge (a bottom sheet on a phone): title with the count, an add button, three filter chips (*Open* / *Resolved* / *All*, with counts) and rows (badge, two lines of text, page, device, replies, a check when resolved); a tap jumps to the region and opens the card. *Comment* on a selection and *Comment on a region* open the editor on the modal shell (text box and a sketch pad with *Undo last stroke* and *Clear sketch*); the region is drawn with a one-shot surface over the page area with a hint pill and a *Cancel* button (Escape too). On a locked page the card shows *Page locked* and offers no edits. Settings (Reading): *Show comment markers*, *Include comments in exports*. All tokens are `--nb-*`, scoped under `.nb-ui`.
## Mentions (0.18, roadmap O7)

A **count pill** (`.nb-ui.nb-mentions-badge`, a real button) sits at the top left of the page area, mirroring the lock badge on the right: a link icon in the accent colour and the number of notes that link to the page in view; hidden at zero, slightly tighter on phones. A tap opens the **Mentions sheet** on the modal shell (`.notebook-mentions-modal`, medium): a group *Linking to page N* and a group *Linking to the notebook*, each a list of full-width rows (`.nb-mentions-row`: file icon, note name, folder in muted text, and under them one muted line of context). Rows are cards with the border turning accent on hover and focus; the context line fills in lazily and is hidden when empty.
## Quick tabs (0.18, roadmap #227)

A slim strip (`nb-qt`, `src/view/quick-tabs.ts`) between the toolbar and the page: one pill per pinned page on `--nb-tile` with a `--nb-border` outline; the tab of the page in view takes `--nb-accent` on `--nb-accent-bg`, *Back* is an accent-outlined pill with a corner arrow, a tab of another notebook carries a book icon, a tab whose page is gone is dashed and faint. The first button collapses the strip to a pin with the count. Tabs are 30 px tall (36 px with a coarse pointer), shorter on `nb-vp-phone`; on a short landscape view the strip is a 76 px column beside the page (the view moves it). The tab menu and the page-number menu use the `nb-menu` style. Dragging lifts the tab (`--nb-shadow-2`) and an accent bar marks where it will land. Nothing here is decoration posing as a control: every pill is a button.

## Figures gallery (0.19, roadmap #228)

The **Figures** dialog (`.nb-figures-modal`, wide, on the modal shell) is a grid of thumbnails of the pictures and figure cut-outs of the notebook. Above the grid a scope chip row (*This section* / *Whole notebook* / *Some pages*, the first only when the notebook has lectures) and, beside it, the kind chips (*All*, *Photos*, *Crops*) with counts; *Some pages* shows a text field (the standard modal input) under the chips. Each card (`.nb-figures-card`) is a tile with a 4:3 frame (the picture contained on white, so a diagram is never cropped), a page pill at the bottom left, a small kind mark at the top right and a round ... button at the bottom right (the long press and the right click open the same menu). Thumbnails are not drawn until the card is near the screen: until then the frame shows a quiet image glyph; a picture that cannot be read shows an "image off" glyph with the reason. Grid: `minmax(150px, 1fr)`, 128 px on a phone. The dialog is read-only.

## Reference window (0.20, roadmap #107)
A floating `modal-shell`-like card over the page area (`src/view/ref-window.ts`, styles in the 0.20 refwindow block of `styles.css`): header (icon square in the reference's colour, title, minimise, close; the whole header is the drag handle), the picture or note, and a footer (page stepper, *Fit*, opacity slider, resize grip). A minimised window is a pill chip at the same corner. Tokens only (`--nb-panel`, `--nb-border`, `--nb-radius-panel`, `--nb-shadow-float`), light and dark. It is a small element inside the notebook body, not a layer over the canvas: the pen outside its rectangle is untouched, a pen inside does nothing, fingers pan and zoom the reference. Geometry (clamping, snapping, remembered place per orientation) is pure in `src/ui/ref-window-geometry.ts`; pan and zoom in `src/ui/ref-window-pan.ts`. Opened by the actions `ref-open`, `ref-page`, `ref-close` and `selection-open-reference`, the hover card button and the file menu.

## Share page (0.20, roadmap #30)

*Share page…* (page menu, page sheet, palette) and *Share selection…* (selection menu) open a medium dialog on the modal shell (`.notebook-share-modal`, icon `share-2`): *What to share* (Page N / The selection / Some pages…), the page range field (only for *Some pages*), *Format* (PNG image / PDF; hidden for a selection, which is always a PNG), the *Clean copy* switch of the export dialog, one quiet note that says whether the share sheet or a saved copy is used, and *Cancel* plus a primary button that reads *Share* (with a share icon) where the device can share files and *Save a copy* where it cannot. After sharing there is no dialog: the system share sheet is the feedback. When a copy was saved, or the browser wants a new tap, a notice carries pill buttons (`.nb-share-notice-btn`: *Open*, *Copy image*, *Share*) on the same tokens as the other pill buttons.

## Recent symbols (0.21, roadmap #212)
A floating pill (`.notebook-symbol-strip`, `src/view/symbol-strip.ts`, styles in the 0.21 symbols block) at the top centre of the page area: up to 12 round 40 px buttons, a character in the text font or a small SVG of a saved symbol in the text colour; the armed button uses the active-tool colours and a muted "Tap the page" hint follows. While armed a transparent catcher covers the page (outside the stage) and takes one tap. Same raised surface, border and shadow as the contextual bar; scrolls sideways on a phone.

## Related pages (0.26, roadmap #422)

A right-sidebar `ItemView` (`src/view/related-view.ts`) in the `nb-ui` scope: a small header (title, the note, a refresh icon button), then one tile per page (thumbnail 44x58, notebook, page number, a reason pill that is not a control, the matched text, `+n` for further reasons) with a link icon button. Empty states use the shared empty-state component. Every button has a long-press explanation.

## Colours with meaning (0.22, roadmap #101)

**Legend editor** (`src/view/meaning-modals.ts`, `MeaningsEditorModal`): a shell dialog that reuses the Board columns editor rows (`nb-colrow*`, class `nb-meaning-editor`): a label field, 20 palette swatches plus a round "other colour" input, up / down / remove. Every change is saved at once. Opened from *Settings > Reading & PDF* (global legend) or the notebook menu (adds a switch for a legend of this notebook only; while it is off the list shows the global legend, read-only). A red inline note names two meanings that are too close in colour. **Filter by meaning** (`MeaningFilterModal`): a narrow shell list, one row per meaning with its colour dot and stroke count, *Show everything* first. While a meaning is chosen a pill (`.nb-meaning-pill`, bottom left, 36 px, colour dot, label, a 32 px × button) sits over the page; the renderer draws other ink at 16 % opacity (`Renderer.setInkDim`). **Digest by colour** (`src/view/meaning-digest.ts`): a medium shell dialog (picture quality) and a note, built like the highlights digest.

## Change cover (0.22, roadmap #53)
One dialog on the modal shell (`src/library/cover-dialog.ts`): the 3:4 frame (a canvas, with the card's spine) on the left, source chips (Pattern, Image, Page, Template) and their controls on the right; on a phone the frame sits on top. Swatches, style tiles and zoom/pager controls are 40 px targets in the `.nb-ui` scope (`styles.css`, block `0.22 covers`).

## Saved views (0.23, roadmap #264)
One narrow dialog on the modal shell (`.nb-views-modal`, `src/view/saved-views-modal.ts`, block `0.23 savedviews` in `styles.css`): a *Name this view* field with a *Save* button on the same line (the field offers the next free name and a muted line says what will be saved: page and zoom), then the list. A row (`.nb-views-row`, a tile like the locked-elements list, 56 px) is a big tap target that goes to the view and closes the dialog (name, then a muted *Page 3 · 135%*) and a round 44 px `...` button that opens the menu (*Go to*, *Rename*, *Update to the current view*, *Move up*, *Move down*, *Remove*). *Rename* turns the name into a field (Enter keeps it, Escape leaves it). A view whose page is gone has a dashed border, a muted name and the line *Page missing* in the danger colour; a tap on it says so and nothing moves, and the menu offers rename, move and remove only. A read-only notebook shows the list, disables the field and the button and offers only *Go to*. Commands and sheet entries: *Save current view…* (opens the dialog on the field and closes it once saved) and *Go to saved view…* (the list). No floating piece: nothing joins the pill stack.

## Welcome back (0.23, roadmap #420)
A quiet glass card at the top centre (`.notebook-welcome-back`), the second tier of the floating stack: its top is picked by `:has` rules from what sits above it (symbols strip, "Back to slide" pill, "Referenced on" chip), and it is hidden while the "Referenced on" list is open. Rows are real 38px buttons with a small accent icon; counts beyond the listed rows are muted text, not controls. Checked in the `pillstack` and `welcomeback` harness scenarios.

## Shape fill and line style (0.24, roadmap #37)
Two small segmented controls built by one function (`src/view/shape-style-row.ts`, block `0.24 shapefill` in `styles.css`) and shown in two places: the Shape tool's options (under the shape kinds; the fill only for the rectangle and the ellipse) and the selection bar (a rounded panel row after the colour and width rows, shown only when the selection has a shape). *Fill*: No fill / Solid / Tint, then a compact row of colours whose first swatch is a ring ("same as the line"); *Line*: Solid / Dashed / Dotted. Compact 30 px swatches and buttons, `--nb-*` tokens only, light and dark.

## Action history (0.25, roadmap #84)

One narrow dialog on the modal shell (`.nb-hist-modal`, `src/view/history-panel.ts`, block `0.25 histpanel` in `styles.css`): a list of tiles (`.nb-hist-row`, 56 px, a full-width button) newest first. Each tile has an icon for the kind of step, a title ("Stroke written", "Added: text box"), and a muted line with the item count, the page (*p. 3*) and the time (*just now*, *5 min ago*, then the time of day). Two muted section heads split the list: *Undone steps (tap to bring back)* (dashed border, dimmed, a redo icon) above and *Steps made* below, where the tile the document is at has the accent border and fill and an accent pill *Now* (it cannot be tapped). The last tile is *Start of the history*. A tap goes back or forward to the point just after that step, the list redraws in place (scroll kept) and a notice says how many steps were taken, or where a refused step stopped the jump. A read-only notebook shows the list with a note and every tile disabled. Entry: the all-actions sheet (History) and the notebook menu, *Action history…*; no floating piece, nothing joins the pill stack.

## Long-press explanation (0.24, roadmap #429)

A finger held about 0.5 s (10 px of drift allowed) on an icon button of the toolbar, the selection and contextual bars or the Home header shows a floating card (`.nb-help-bubble`, panel surface, a small arrow) anchored to the icon: name (the control's label), one line on what it does, and a hint when there is one. It is non-interactive (`pointer-events: none`), sits below the icon (above near the bottom edge) and stays on screen. The press does not activate the button: the click that ends it is swallowed. It hides about 1.2 s after the finger lifts, or at once on a tap elsewhere. Only `pointerType: "touch"` starts it: the mouse keeps its hover tooltip and the pen is never intercepted. Controls with their own long press (pinnable quick actions, the page indicator quick tab) are skipped. The names come from the action registry labels; the descriptions are `help.*` keys mapped in `src/ui/help-text.ts` (a control without one shows its name alone). Setting: Appearance > *Explain icons on long press*.

## Area highlighter (0.25, roadmap #99)
The highlighter's options gain one segmented row, *Stroke | Area* (the same `notebook-segmented` text buttons as the lasso's *Lasso | Rectangle*; each has a long-press explanation), above the colours. In *Area* the width row and the snap-to-text row are hidden (a rectangle has neither). A drag shows the rectangle live with the final look (the highlighter's translucency, multiplied over the page, with a hairline edge to read the corners) and no control of its own; the selection bar for an area shows the highlighter colour swatches only. The same action is *Area highlighter* in the all-actions sheet (reading group, ranked first with the highlighter in hand and on PDF pages). No new colours or components: the area is drawn in the highlighter's colours with the highlighter's opacity, so the page stays the page.
