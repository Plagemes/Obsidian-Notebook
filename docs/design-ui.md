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
| **Quick slots** | 0–6 ranked actions (insert image, stamps, add page, ruler, pen only, fit, board shot) | As many as fit the width: 0 on a phone, 4–5 on a tablet, 6 on desktop. Ranked by priority + recent use on this device |
| **Tool options popover** | Colour, width, eraser mode/filter/size, shape kind, text size, snap-to-text | Tap the active tool again, or the current-pen indicator |
| **Contextual bar** | Floating pill at the bottom of the page with a context label and its actions; can be collapsed to a single chip | Selection (copy, cut, duplicate, paste, white → transparent, save as stamp, delete, restyle rows; a **second row** under the main row with Select similar, Align and distribute, Rotate / mirror / size, wave 0.10) › lasso (paste, rectangle selection, select by colour or tool) › PDF side pane open (link, add notes page, show slide, close) › class now (board shot, new lecture, exercise page) › PDF page (search, hide annotations, dim, margins, open side by side) › image page (dim, margins) |
| **All actions sheet** | Grouped, searchable sheet (popover on tablet/desktop, bottom sheet on phone). Sections: Recent, Insert, Page, PDF & reading, Side by side, Lecture, View & input, Export & share | The ⊞ button at the end of the toolbar |
| **Page sheet** | The same component scoped to one page. First section **Go to**: *Go to page number…* (page number, `p12` or a bookmark), *Recently edited pages*, *One page at a time*. Then the page: arrange, bookmark, tags, paper and size as chips, orientation, infinite, split (heavy page), delete; insert after; PDF page actions; share/export | Tap the page indicator, or a thumbnail's menu in the pages panel |
| **Status banners** | Safe mode (*Open normally*, *Repair…*, *Show images and PDFs*), storage full (*Retry now*), integrity (*Restore the newer version*, *Restore a version…*, *Keep this version*), open on another device (*Open read-only*, *Open anyway*, *Edit anyway*), heavy page (*Split page*, *Dismiss*) | Only while the situation lasts; the banner owns its recovery buttons (they are listed in the registry with the `banner` surface) |
| **Radial menu** | Dark dial at the pen tip: undo/redo, width bubble, colour bubble, tool illustration, favourites · pen case · shapes | S Pen side button (or long press, per settings) |
| **Notebook menu** | Obsidian's "More options" of the notebook tab | Notebook-wide actions: open library, export notebook, zettel entries |
| **Home** | The library view on its Home surface (0.12, §11) | Subject folders, recent notes, statistics, quick actions (New notebook, New folder, Import PDF, Scan), inbox bell |
| **Library** | The library view (0.12, §11): rail, filter chips, dashboard, notebook grid or list | Create, import PDF, lecture from slides, scan, loose sheet, library check, timetable |
| **Settings** | Plugin settings tab, generated from `view/settings-schema.ts` (§10): eleven sections by task, a search, collapsed *Advanced* and feature groups | Diagnostics (pen button test, benchmark) are also commands |
| **Creation dialog** (wave 0.12) | One modal, two tabs as a segmented control: **Notebook** (cover preview with *Change cover* (pattern, colour, image) and a shuffle button for a new variation; name, description, folder list with icons, page template tiles drawn by the paper renderer, page size A4 · A5 · B5 · Letter · Custom in mm, orientation tiles) and **Folder** (the library's own subject card as the preview, `ui/components/subject-card.ts`, above the form, with *Change colour* and *Change pattern*; name, description, location, icon row plus Lucide search, eight subject colours plus the colour picker). Inline name errors, Enter submits. A full-height sheet with the preview on top under 600 px. Decoration (header art band, glow behind the preview, faint art on the selected template tile) never acts as a control and is off with reduced motion | Registry actions `new-notebook` (Notebook tab) and `new-folder` (Folder tab), the command *New notebook* (`create`), *New folder*, the library's buttons and menus (through `host.createNotebook(folder)` / `host.createFolder(parent)`) |
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
| Undo, redo | Toolbar, radial, two/three-finger taps, commands | Always needed |
| Pages panel (`toggle-pages-panel`) | Toolbar row 1 (first button) | Navigation is primary |
| Copy, cut, duplicate, paste, white → transparent, save as stamp, delete selection | Contextual bar (selection / lasso) | Act on what is selected, next to it |
| Restyle selection (colour, width) | Contextual bar, second row | Same |
| Insert image, stamps, add page, board shot | Quick slots (ranked) + Insert section | Frequent inserts one tap away when there is room |
| Exercise page, page from template, insert PDF pages, image page, scan pages, scan as image | Insert section of the sheets; exercise page also on the lecture bar | Less frequent; grouped |
| Go to page number, recently edited pages, one page at a time (`goto-page-number`, `recent-pages`, `toggle-page-mode`) | **Page sheet, first section "Go to"** (tap the page indicator); also in the All actions sheet; one page at a time is also a quick slot | Getting to a page starts where the page number is |
| Back, forward (`nav-back`, `nav-forward`; wave 0.10) | **Quick slots** of the toolbar (rank 64 and 63, after insert image and add page) once the history of visited pages has somewhere to go; **page sheet, first section "Go to"**; All actions sheet; commands (hotkeys); the mouse's back and forward buttons on desktop | Returning to where you were is a navigation act and belongs next to getting to a page. Hidden until there is a history, so no slot is wasted; on a phone there are no quick slots, so the page sheet is the way |
| Fast scrollbar (wave 0.10) | A thumb along the right edge of the page in continuous scroll; shown after a scroll or when a mouse nears the edge; setting *Fast scrollbar* | A control of the scroll itself, not an action: it has no command and no registry entry (page by page mode has its own swipe) |
| Status bar item (wave 0.10) | Obsidian's status bar, desktop only: "p. 3/12 · Saved"; a click opens the page panel | Mobile has no status bar: the toolbar's page indicator and save state show the same |
| Page switcher across notebooks (`go-to-page`) | All actions sheet (Go to), library, palette | Leaves the notebook |
| Split a heavy page (`page-split`) | Heavy-page banner, page sheet (only on a heavy page) | Acts on that page |
| Check sync safety, check notebooks integrity (`sync-check`, `check-integrity`) | All actions sheet (Notebooks), notebook menu, settings, palette | Folder-wide checks, rare |
| Check library: unreadable notebooks and unused files (`library-check`; wave 0.10, roadmap 27) | Library sidebar (*Check library*), All actions sheet (Notebooks), notebook menu, palette | Folder-wide check, rare; opens a report that only lists, then a confirmation before anything moves to the trash |
| Banner buttons (safe mode, storage, integrity, other device, heavy page) | Their status banner only | Meaningful only while the banner is shown |
| Duplicate/move/delete page, bookmark, edit bookmark, page tags, paper, size, orientation, infinite, move to notebook, save as template, restore version, deleted pages | Page sheet (page indicator, thumbnail menu) and Page section | Act on one page, reached from the page |
| Select similar, align and distribute, rotate / mirror / exact size of the selection (`selection-similar`, `selection-align-menu`, `selection-transform-menu` and their entries; wave 0.10) | **Second row** of the contextual bar of a selection: three buttons, each opening a native menu of registry actions (so the first row keeps copy, cut, duplicate, paste, delete, to front, to back); every entry is also in the All actions sheet (Selection section) and a command that applies only with a selection | Operations on a selection belong next to it, but the first row is full on a tablet; the row is cut to the bar width like the first and appears only when it has something to offer (align needs two things, similar needs ink) |
| Rectangle selection, select by colour or tool (`select-rectangle`, `select-by-style`; wave 0.10) | Contextual bar of the lasso (a checked toggle and a button), *Lasso \| Rectangle* in the lasso's tool options (tap the lasso again), All actions sheet while the lasso is on or something is selected, commands | The shape of a selection is a setting *of* the lasso; choosing by style needs no selection first |
| Layer order of the selection (`layer-front`, `layer-back`, `layer-forward`, `layer-backward`; wave 0.9) | Contextual bar of a selection (*To front* and *To back* rank above the rest of the second tier, so they fit the bar on a tablet; on a phone the bar is cut to its basics), All actions sheet, commands (they apply only with a selection) | Act on what is selected, next to it; the sheet and the hotkeys keep all four reachable |
| Date and time stamp (`insert-date-stamp`; wave 0.10) | All actions sheet, command | Inserts at the pen, so it needs no place of its own; the format is a setting |
| Copy to other devices (`selection-copy-devices`), Paste from another device (`selection-paste-device`; wave 0.10) | Contextual bar of a selection (copy) and of a selection or the lasso (paste), All actions sheet, commands (copy applies only with a selection) | Act on the selection or the lasso next to it; the sheet and the hotkeys keep them reachable on a phone |
| Find and replace in text boxes (`find-replace`; wave 0.9) | All actions sheet (Go to), command | Notebook-wide, rare; opens a panel |
| Page information (`page-info`; wave 0.9) | Page sheet, All actions sheet, command | Describes one page, reached from the page |
| PDF search, hide annotations, dim backgrounds | PDF contextual bar + PDF & reading section; search next/previous in the search panel and commands | Relevant only with PDF pages |
| PDF margins, update PDF, export annotations | PDF bar (margins), page sheet, PDF & reading section | Page-level PDF work |
| PDF side by side: open, link, show slide, add notes page, close | PDF bar (open), side-pane bar (the rest), Side by side section | Appear only when they apply |
| New lecture, exercise paper | Lecture bar during a class, Lecture section | Class-time tools |
| Markers (`marker-gap`, `marker-question`, `marker-important`, `marker-critical`, `marker-star`, `marker-homework`), structured box (`marker-box`), End of lecture panel (`end-of-lecture`) | Lecture bar during a class, Lecture section, radial shapes ring → Markers ring (markers and box), page sheet (panel), commands | Captured while the lecture runs; the next tap or drag places one |
| Insert equation, insert graph (`insert-equation`, `insert-graph`; wave 0.9: math) | All actions sheet (Insert), commands | Inserted now and then; not quick slots, so the designed slots stay |
| Edit equation or graph, convert to ink (`math-edit`, `math-convert-ink`) | Contextual bar of a selection holding exactly one equation or graph (*Edit*) or equations (*Convert to ink*), commands | Act on what is selected; the graph panel and the equation editor float over the page while open |
| Excerpt to page…, copy as excerpt (`excerpt-to-page`, `excerpt-copy`; v10, roadmap 105) | Contextual bar of a selection and of the lasso with nothing selected (then the next drag outlines the region), All actions sheet (Insert), commands | Cut from what is selected or from the page under the lasso; the go-to-page picker chooses the target page, the clipboard carries it to another notebook |
| Go to source (`excerpt-open-source`) | Contextual bar of a selection holding an excerpt (first), command; also a tap on the excerpt's corner badge with any tool but the lasso and the eraser | The way back is next to the excerpt; the badge also works in read-only mode (it edits nothing) |
| Invisible ink (`invisible-ink`), show solutions (`show-solutions`, page: `show-page-solutions`) | View section of the sheet (ink and solutions), page sheet (page solutions), commands | A pen mode and view-only toggles |
| Read-only mode (`toggle-read-only`; wave 0.10) | View section of the sheet, command; while on, the lock button in the toolbar replaces the pen indicator and the favourites (and switches it off) | A mode of this view: the toolbar says so and offers the way out in the same place |
| Export pages as PNG images (`export-png`), Print (`print`; wave 0.10) | Sheet (Export & share), notebook menu, commands; both open *Export…* on that format. Print exists only where the device can print (desktop) | Choices of the one export dialog; no control that cannot work on a phone |
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

Use counts (`src/ui/usage.ts`) are stored per device with `app.saveLocalStorage("notebook-ui-usage")`: count and last
use, half-life 14 days, boost at most 30 points (priorities are 0–100), so use reorders neighbours but never pushes a
designed primary action out.

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
| 6 | **Sync & safety** | Device name, check sync safety (only when the sync safety service runs) |
| 7 | **Export** | Export settings, when there are any (the section is hidden while it is empty) |
| 8 | **Obsidian integration** | Tabs of open notebooks, companion notes and their options |
| 9 | **Study** | Groups *Class timetable* (edit, offer the current class, open without asking, start early) and *Zettelkasten* |
| 10 | **Appearance & language** | Language, Style (Notebook / Follow Obsidian theme), toolbar size, night mode |
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
pages log; nothing is invented and empty sections are hidden.

**Shell.** Navigation rail (`ui/components/nav-rail.ts`): brand; *Home*, *Notebooks*, *PDF* (only when a notebook has
PDF pages), *Tags*, *Settings* (opens the plugin's settings tab); *Vault*: the folder tree under the notebooks folder,
each folder with the colour of its subject (top-level folder) and its folder menu (long press or right click), a drop
target for dragged notebooks; at the bottom *Archive*, *Trash*, *Check library*. Width classes of the view: **wide**
(≥ 1100 px: rail with labels, which a fold button turns into icons), **medium** (600–1099 px, a tablet in portrait:
icons only, subject folders only in the tree), **phone** (< 600 px: the rail is a sheet from the left, opened from the
menu button of the header). Page header: title and subtitle (a folder shows its breadcrumb, each part a link and a
drop target), the search pill (Ctrl/⌘ K on desktop), the *Now: course* button while a class is on, the inbox bell; on
the library also tag filter, sort, grid / list and *New* (a menu of New notebook, New folder, Import PDF, Lecture from
slides, Scan, Loose sheet; inside a folder the notebook and the folder go there, elsewhere New notebook and New folder
run the registry actions `new-notebook` and `new-folder`; all of them open the creation dialog, `view/create-dialog.ts`).

**Home.** *Subject folders*: one card per top-level folder (four at most, *Show all* opens the subjects page).
*Recent notes*: the pages edited last on this device (bookmark title or notebook name, page number, time, subject
and tag pills, kebab = the notebook menu; without a log, the notebooks changed last). *Statistics* (period 1, 4 or 12
weeks, kept in the view state): notebooks created (with the change against the period before, the only exact
comparison), pages edited on this device, PDF notebooks changed, tags used; each tile opens its detail. *Quick
actions*: New notebook, New folder, Import PDF, Scan (when available).

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
