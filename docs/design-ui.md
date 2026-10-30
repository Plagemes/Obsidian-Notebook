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
| **Contextual bar** | Floating pill at the bottom of the page with a context label and its actions; can be collapsed to a single chip | Selection (copy, cut, duplicate, paste, white → transparent, save as stamp, delete, restyle rows) › lasso (paste) › PDF side pane open (link, add notes page, show slide, close) › class now (board shot, new lecture, exercise page) › PDF page (search, hide annotations, dim, margins, open side by side) › image page (dim, margins) |
| **All actions sheet** | Grouped, searchable sheet (popover on tablet/desktop, bottom sheet on phone). Sections: Recent, Insert, Page, PDF & reading, Side by side, Lecture, View & input, Export & share | The ⊞ button at the end of the toolbar |
| **Page sheet** | The same component scoped to one page. First section **Go to**: *Go to page number…* (page number, `p12` or a bookmark), *Recently edited pages*, *One page at a time*. Then the page: arrange, bookmark, tags, paper and size as chips, orientation, infinite, split (heavy page), delete; insert after; PDF page actions; share/export | Tap the page indicator, or a thumbnail's menu in the pages panel |
| **Status banners** | Safe mode (*Open normally*, *Repair…*, *Show images and PDFs*), storage full (*Retry now*), integrity (*Restore the newer version*, *Restore a version…*, *Keep this version*), open on another device (*Open read-only*, *Open anyway*, *Edit anyway*), heavy page (*Split page*, *Dismiss*) | Only while the situation lasts; the banner owns its recovery buttons (they are listed in the registry with the `banner` surface) |
| **Radial menu** | Dark dial at the pen tip: undo/redo, width bubble, colour bubble, tool illustration, favourites · pen case · shapes | S Pen side button (or long press, per settings) |
| **Notebook menu** | Obsidian's "More options" of the notebook tab | Notebook-wide actions: open library, export notebook, zettel entries |
| **Library** | The library view | Create, import PDF, lecture from slides, scan, timetable |
| **Settings** | Plugin settings tab | Diagnostics (pen button test, benchmark) are also commands |
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
| Favourite pens 1–6 (`favourite-*`) | Toolbar strip, radial favourites ring, commands | One tap to a saved pen; long press / radial "+" saves |
| Undo, redo | Toolbar, radial, two/three-finger taps, commands | Always needed |
| Pages panel (`toggle-pages-panel`) | Toolbar row 1 (first button) | Navigation is primary |
| Copy, cut, duplicate, paste, white → transparent, save as stamp, delete selection | Contextual bar (selection / lasso) | Act on what is selected, next to it |
| Restyle selection (colour, width) | Contextual bar, second row | Same |
| Insert image, stamps, add page, board shot | Quick slots (ranked) + Insert section | Frequent inserts one tap away when there is room |
| Exercise page, page from template, insert PDF pages, image page, scan pages, scan as image | Insert section of the sheets; exercise page also on the lecture bar | Less frequent; grouped |
| Go to page number, recently edited pages, one page at a time (`goto-page-number`, `recent-pages`, `toggle-page-mode`) | **Page sheet, first section "Go to"** (tap the page indicator); also in the All actions sheet; one page at a time is also a quick slot | Getting to a page starts where the page number is |
| Page switcher across notebooks (`go-to-page`) | All actions sheet (Go to), library, palette | Leaves the notebook |
| Split a heavy page (`page-split`) | Heavy-page banner, page sheet (only on a heavy page) | Acts on that page |
| Check sync safety, check notebooks integrity (`sync-check`, `check-integrity`) | All actions sheet (Notebooks), notebook menu, settings, palette | Folder-wide checks, rare |
| Banner buttons (safe mode, storage, integrity, other device, heavy page) | Their status banner only | Meaningful only while the banner is shown |
| Duplicate/move/delete page, bookmark, edit bookmark, page tags, paper, size, orientation, infinite, move to notebook, save as template, restore version, deleted pages | Page sheet (page indicator, thumbnail menu) and Page section | Act on one page, reached from the page |
| Layer order of the selection (`layer-front`, `layer-back`, `layer-forward`, `layer-backward`; wave 0.9) | Contextual bar of a selection (*To front* and *To back* rank above the rest of the second tier, so they fit the bar on a tablet; on a phone the bar is cut to its basics), All actions sheet, commands (they apply only with a selection) | Act on what is selected, next to it; the sheet and the hotkeys keep all four reachable |
| Find and replace in text boxes (`find-replace`; wave 0.9) | All actions sheet (Go to), command | Notebook-wide, rare; opens a panel |
| Page information (`page-info`; wave 0.9) | Page sheet, All actions sheet, command | Describes one page, reached from the page |
| PDF search, hide annotations, dim backgrounds | PDF contextual bar + PDF & reading section; search next/previous in the search panel and commands | Relevant only with PDF pages |
| PDF margins, update PDF, export annotations | PDF bar (margins), page sheet, PDF & reading section | Page-level PDF work |
| PDF side by side: open, link, show slide, add notes page, close | PDF bar (open), side-pane bar (the rest), Side by side section | Appear only when they apply |
| New lecture, exercise paper | Lecture bar during a class, Lecture section | Class-time tools |
| Markers (`marker-gap`, `marker-question`, `marker-important`, `marker-critical`, `marker-star`, `marker-homework`), structured box (`marker-box`), End of lecture panel (`end-of-lecture`) | Lecture bar during a class, Lecture section, radial shapes ring → Markers ring (markers and box), page sheet (panel), commands | Captured while the lecture runs; the next tap or drag places one |
| Insert equation, insert graph (`insert-equation`, `insert-graph`; wave 0.9: math) | All actions sheet (Insert), commands | Inserted now and then; not quick slots, so the designed slots stay |
| Edit equation or graph, convert to ink (`math-edit`, `math-convert-ink`) | Contextual bar of a selection holding exactly one equation or graph (*Edit*) or equations (*Convert to ink*), commands | Act on what is selected; the graph panel and the equation editor float over the page while open |
| Invisible ink (`invisible-ink`), show solutions (`show-solutions`, page: `show-page-solutions`) | View section of the sheet (ink and solutions), page sheet (page solutions), commands | A pen mode and view-only toggles |
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

Tokens are declared on `.notebook-view`, `.notebook-lib-root` and modal roots, built on Obsidian variables:

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
| `src/ui/context-bar.ts` | Contextual bar component |
| `src/ui/dismiss.ts` | Tap-outside / Escape closing shared by popovers and sheets (a tap on the page draws nothing) |
| `src/view/view-actions.ts` | What each view action does (one runner per registry id) |
| `src/view/view-ui.ts` | Mounts the contextual bar and the sheets, runs the layout engine once per frame, keeps the use counts |
| `src/view/commands.ts` | Generates the Obsidian commands from the registry |
| `NotebookView.uiContext()` / `runAction()` | The view's context for the engine, and the single entry point that runs and counts an action |
| `src/view/toolbar.ts` | Primary toolbar (quick slots from the layout) |
| `src/view/radial-menu.ts` | Radial dial |
