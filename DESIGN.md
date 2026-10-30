# Design system

This is the visual and interaction contract for every surface of Notebook. The reference designs are in `docs/design/reference/`: [`home.png`](docs/design/reference/home.png) (home dashboard), [`library.png`](docs/design/reference/library.png) (notebook library), [`subject-cards.jpg`](docs/design/reference/subject-cards.jpg) (subject cards with generated art), [`new-notebook.png`](docs/design/reference/new-notebook.png) and [`new-folder.png`](docs/design/reference/new-folder.png) (creation dialog). When a decision is not covered here, match those images. It applies to every screen, function and interface of the plugin, present and future (§4, scope rule). The behavioural design (surfaces, layout engine, action registry) is in [`docs/design-ui.md`](docs/design-ui.md).

## 1. Direction

**Premium, minimal, functional, generative.**

- **Premium.** A dark, deep-navy canvas. Content sits in calm, softly bordered panels. Each subject owns a colour, used with restraint: vivid on subject cards, a tint everywhere else. Typography is confident: large bold titles, quiet secondary text. It should feel like a first-class study app, not a developer tool.
- **Minimal.** One idea per panel. Generous spacing, no visual noise, no walls of text. Each element has a single job, and secondary detail is muted rather than removed.
- **Functional.** Every visible control works (CLAUDE.md rule 8): no fake buttons, no dead menu items. Every card, tile, chip and row is a real target that opens or does something. Pen, finger and mouse are all first-class.
- **Generative.** The interface is assembled at run time from the user's data and context. Subjects, smart collections, frequent tags, recent items, statistics and quick actions are computed locally. The procedural subject artwork is generated, not stock imagery. It is deterministic: no AI, no network, nothing leaves the device (CLAUDE.md rules 5 and 7).

## 2. Design tokens

All colours, sizes and radii are CSS custom properties prefixed `--nb-`, defined once in `styles.css` on the plugin's root classes. Components never use raw values.

### 2.1 Colour: dark (reference)

| Token | Value | Use |
|---|---|---|
| `--nb-bg` | `#0A0E17` | View background |
| `--nb-bg-elevated` | `#0F1420` | Sidebar / navigation rail |
| `--nb-panel` | `#121826` | Panels ("Note recenti", "Statistiche", list containers) |
| `--nb-tile` | `#161D2D` | Tiles inside panels (KPI tiles, rows on hover) |
| `--nb-border` | `rgba(255,255,255,0.07)` | 1 px borders of panels, tiles, chips |
| `--nb-border-strong` | `rgba(255,255,255,0.12)` | Inputs, dividers that must read |
| `--nb-text` | `#F4F6FB` | Titles and primary text |
| `--nb-text-muted` | `#9AA3B5` | Subtitles, meta, timestamps |
| `--nb-text-faint` | `#6B7487` | Section labels such as "VAULT", disabled |
| `--nb-accent` | `#6D8BFF` | Links ("Mostra tutte →"), focus ring, active state |
| `--nb-accent-bg` | `rgba(109,139,255,0.16)` | Active nav item, active chip, selected tile |
| `--nb-success` | `#3DD68C` | Positive deltas ("↑ +24%") |
| `--nb-danger` | `#F2555A` | Destructive actions only |
| `--nb-star` | `#F5B83D` | Favourite star |

### 2.2 Colour: light (derived)

Light mode keeps the same structure: `--nb-bg #F6F7FB`, `--nb-panel #FFFFFF`, `--nb-tile #F1F3F9`, `--nb-border rgba(15,23,42,0.08)`, `--nb-text #0E1424`, `--nb-text-muted #5B6478`, accent `#4F6BF0`. Subject colours stay the same; their tints use lower alpha.

The setting **Appearance → Style** offers:
- *Notebook*: these tokens, the default;
- *Follow Obsidian theme*: tokens mapped onto Obsidian's `--background-*`, `--text-*` and `--interactive-accent`.

### 2.3 Subject palette

Each subject (a top-level folder or subject tag) has a colour. It is assigned automatically from this palette, by a stable hash of the name, and the user can change it.

| Name | Base | Tint (bg) | Example in reference |
|---|---|---|---|
| Red | `#F0565E` | `rgba(240,86,94,0.16)` | Anatomia |
| Blue | `#2F80F7` | `rgba(47,128,247,0.16)` | Fisiologia |
| Violet | `#8B5CF6` | `rgba(139,92,246,0.16)` | Biomateriali |
| Teal | `#16C2A3` | `rgba(22,194,163,0.16)` | Matematica |
| Amber | `#F59E0B` | `rgba(245,158,11,0.16)` | Esami |
| Pink | `#EC4899` | `rgba(236,72,153,0.16)` | Con PDF |
| Indigo | `#6366F1` | `rgba(99,102,241,0.16)` | Recenti |
| Green | `#22C55E` | `rgba(34,197,94,0.16)` | (spare) |

**Rules:**
- The base colour appears only on: the folder icon, the subject card gradient, the dot of a tag chip, and the text of a subject pill.
- Everything else uses the tint.
- Never put two vivid colours next to each other except on subject cards.

### 2.4 Typography

Obsidian's interface font (`--font-interface`). Numbers use `font-variant-numeric: tabular-nums`.

| Role | Size / weight / tracking | Example |
|---|---|---|
| Page title | 40 px / 800 / -0.02em | "Libreria quaderni" |
| Page subtitle | 15 px / 400, muted | "Organizza i tuoi quaderni…" |
| Section title | 20 px / 600 | "Cartelle per materia" |
| Card title | 20 px / 600 | "Anatomia" |
| Row / tile title | 15 px / 500 | "Struttura del tessuto osseo" |
| Meta | 13 px / 400, muted | "Ultima modifica: ieri, 18:06" |
| KPI number | 28 px / 700 | "12,5 h" |
| Chip / pill | 13 px / 500 | "Fisiologia" |
| Section label | 12 px / 600 / 0.06em, uppercase, faint | "VAULT" |

### 2.5 Spacing, radius, elevation

- **Spacing:** an 8 px grid (4 px for tight insides). Page padding 32 px on tablet and desktop, 16 px on phone. Gap between sections 32 px, between cards 16 px. Panel padding 20 px; tile padding 16 px.
- **Radius:**
  - subject cards and panels: 16 px;
  - tiles and inputs: 14 px;
  - icon squares: 12 px;
  - chips, pills, search field and circular buttons: fully rounded.
- **Elevation:**
  - depth comes from layered background tokens plus the 1 px border, not from heavy shadows;
  - at most a soft `0 8px 24px rgba(0,0,0,0.25)` on floating surfaces (popovers, radial menu, sheets);
  - subject cards may have an inner glow in their colour.

### 2.6 Iconography and imagery

- **Icons:** Lucide via `setIcon`, outline, 20 px (16 px in chips), stroke 1.75, `--nb-text-muted` by default and `--nb-text` when active.
- **Icon squares:** a 40–44 px rounded square with the colour tint and the icon in the base colour. Used for quick actions, smart collections, KPI tiles and PDF rows.
- **Folder icon:** the filled, glossy folder in the subject's base colour, drawn as inline SVG with a top-light gradient.
- **Subject and notebook artwork:** procedural line art generated by `src/ui/art/generative-art.ts` from a seed (the folder path or notebook id) and the subject colour. It is never a stock image. Reference: `subject-cards.jpg`.
  - It has the look of a scientific illustration: fine glowing lines (0.6–1.2 px) with varying opacity and a soft radial glow in the subject colour, fading in from the right half so the icon and title on the left stay clean.
  - The families are `branches` (vessels, trees), `cells` (Voronoi), `waves` (function ribbons over a fine grid), `contours` (topographic iso-lines), `flow` (streamlines), `orbits` and `grid` (graph paper with curves).
  - The family is picked deterministically from the name and can be changed by the user.
  - Notebook covers use the same engine in portrait: a soft diagonal gradient of the colour, large smooth wave shapes, and a faint art layer.
  - Generation is deterministic, cheap (a cached canvas or SVG) and off when *Reduce motion and effects* is on.
  - It is part of the card target, so it is not decorative UI.
- **Thumbnails:** favourite and recent notebooks show a real page thumbnail (56 px, radius 10) from the existing thumbnail cache.

## 3. Components

Each component lives in the plugin as one reusable builder, for example `ui/components/subject-card.ts`, with the same tokens on every surface.

**CSS scope.** Every surface built on these components carries the class `nb-ui` on its root (the Home/library root, the creation dialog), and every component rule in `styles.css` starts with that scope (`.nb-ui .nb-chip`, `.nb-app.nb-ui …`). Obsidian styles every button and text input with selectors of specificity 0,1,1 (`button:not(.clickable-icon)`, `button:hover`, `input[type=search]`), which beat a single-class rule: unscoped, a component shows Obsidian's grey button. A reset at the top of the section neutralises those defaults inside `.nb-ui`; `tests/styles.test.ts` fails on an unscoped rule, and the browser harness loads the same Obsidian rules.

| Component | Anatomy (from the reference) | Behaviour |
|---|---|---|
| **Page header** | Large title + muted subtitle on the left. On the right: search pill, circular icon buttons (filter, sort, view toggle; the active one gets an accent fill), and last the primary **+ New** pill | The search pill searches the current surface. The `⌘K` / `Ctrl K` hint is shown only on desktop |
| **New button** | Accent pill: plus icon + "Nuovo" / "New" (`ui/components/new-button.ts`); a compact round "+" in the rail next to the brand | Opens the New menu: New notebook, New folder, Import PDF, Scan (when available) and the other creation actions. On every surface that lists notebooks, empty or not |
| **Empty state** | Panel with a centred illustration from the art engine (`emptyStateImage`; an icon square with reduced effects), a title ("Inizia il tuo primo quaderno"), one line of explanation, a primary accent button and secondary pill buttons (`ui/components/empty-state.ts`) | Teaches the next step. Buttons only for things that can be created there |
| **Create tile** | Dashed rounded tile the size of a card: icon square, title ("Crea una cartella"), one line (`ui/components/create-tile.ts`) | Stands in for the cards of a section that has none (subject folders); runs the creation it names |
| **Search pill** | Fully rounded, `--nb-panel`, magnifier icon, placeholder ("Cerca quaderni, tag, contenuti…"), keyboard-hint chip | Live filtering, results grouped by type |
| **Filter chips** | A row of pills: "Tutti" (active: accent tint + accent border) · "Materie" · "Recenti" · "Preferiti" · "Con PDF" · "Archivio", each with a leading icon | Single-select filter of the current surface. They wrap on phone |
| **Section header** | Icon + section title on the left; "Mostra tutte →" link in accent on the right | The link opens the full list. It is hidden when everything is already shown |
| **Subject card** | 16 px radius, gradient from the subject colour (dark at left, glow at right), glossy folder icon, title, meta ("12 quaderni · 248 note"), procedural artwork, chevron | Opens the subject. Grid: 4 per row on wide tablet, 2 on tablet portrait, 1 on phone |
| **Smart collection tile** | Tinted gradient background, icon square, title ("Da studiare"), count ("18 quaderni"), chevron | Opens the computed collection |
| **Tag chip** | Pill: coloured dot + label + count bubble. A trailing "+ Aggiungi tag" chip is outlined | Filters by tag; the add chip creates a tag |
| **List panel** | Panel with section header; rows of doc icon, title, timestamp (meta), subject pill (tinted) + neutral pill, kebab menu; 1 px dividers | A row opens the item; the kebab opens the item's actions (from the action registry) |
| **Favourite row** | Thumbnail, title, subject (in subject colour) · count, "Aggiornato …", amber star, kebab | The star toggles favourite |
| **KPI tile** | Icon in a tinted circle, big number, label, green delta "↑ +24%", mini bar sparkline in accent; panel header with a period dropdown pill ("Ultime 4 settimane") | Read-only. Tapping opens the detail. Computed locally |
| **Quick action tile** | Tinted gradient, icon square, title + two-line description, chevron | Runs the registered action |
| **Navigation rail** | Brand (icon + "Quaderni / per Obsidian"); items Home · Quaderni · PDF (only when PDF notebooks exist) · Tag · Impostazioni (active: accent-tinted pill); "VAULT" label; folder tree with subject-coloured folders; "Archivio" at the bottom | Inside the plugin's own views only. It collapses to icons on narrow widths and becomes a bottom sheet on phone |
| **Creation dialog** | One modal, two tabs as a segmented control ("Quaderno" / "Cartella"; active tab accent-filled), close ×. A large preview sits on the left: the notebook cover, or the folder icon on its art card, with a "Cambia copertina" / "Cambia colore" button underneath. The fields sit on the right. Footer: "Annulla" (secondary) and "Crea …" (primary, accent) | References: `new-notebook.png`, `new-folder.png`. On phone it is a full-height sheet with the preview on top |
| **Template tile** | A real paper preview (drawn by the page renderer) above its label; the selected tile has a 2 px accent border | Notebook tab: Vuota · Righe · Quadretti · Puntinata · Millimetrata (plus other existing paper kinds) |
| **Option tile** | Rounded rectangle, label (and an optional icon), accent border and tint when selected | Page format (A4 · A5 · B5 · Letter · Personalizzato) and orientation (Verticale · Orizzontale) |
| **Icon picker / colour swatches** | A row of icon squares (folder, graduation-cap, heart-pulse, flask, sigma, brain, atom, plus more); a row of round swatches from the subject palette (§2.3) plus a custom swatch; the selected item has an accent ring | Folder tab |

| **Inbox bell** | Circular icon button in the page header, with an accent count badge (hidden at 0) | The bell is the **Zettelkasten inbox**: quick notes and fleeting items waiting to be processed. Tap: popover (sheet on phone) titled "In arrivo" with list rows (icon square, first line, source notebook pill, relative time, kebab with the inbox actions) and "Apri inbox". Hidden when the Zettelkasten is off |

**Only functional controls.** The reference images are a graphic example, not a feature list. Rails, headers and menus show only controls that work in the plugin:
- no Canvas;
- no AI Study (CLAUDE.md rule 7);
- no avatar.

The bell is kept because it has a real job: it is the inbox. A new control appears only when it has a real function behind it.

**Decoration is welcome.** Purely graphic elements are allowed and encouraged wherever they make a surface richer, as long as they never pose as controls, never hide content, stay quiet behind text, and switch off with *Reduce motion and effects*. Examples:
- generated line art on cards, covers and section backgrounds;
- soft colour glows and gradients;
- illustrations for empty states and onboarding;
- subtle pattern bands in headers;
- decorative icons in icon squares.

They use the same palette and art engine (§2.3, §2.6).

## 4. Surfaces mapped to the reference

- **Home** (`home.png`): page header · *Cartelle per materia* (subject cards, 2×2 on tablet) · *Note recenti* (list panel) next to *Statistiche* (2×2 KPI tiles) · *Azioni rapide* (4 quick-action tiles).
- **Library** (`library.png`): page header with filter / sort / view buttons · filter chips · subject cards (4 in a row) · *Raccolte intelligenti* (smart collection tiles: Da studiare, Preferiti, Con PDF, Recenti, Esami) · *Tag frequenti* (tag chips) · *Quaderni recenti* (list panel) next to *Quaderni preferiti* (favourite rows).
- **Notebook view:** the writing surface stays the page first. The toolbar, contextual bar, sheets and radial menu use the same tokens, radii, icon squares and chip styles, in their compact sizes.
- **Settings:** the same tokens (§6).
- **Zettelkasten:** the inbox (In arrivo), cards, links and their menus use the list panel, list row, chip and section header components. The inbox count shows on the header bell.
- **Every other surface** uses the same tokens and components: modals and dialogs, popovers and sheets, banners and notices, the PDF bars, practice and lecture panels, the timetable, scan, export, find and replace, page info, library check, trash, move pages, and diagnostics. This includes surfaces that don't exist yet.

**Scope rule.** This design system applies to **every screen, function and interface of the plugin, present and future**. No surface keeps an older or one-off style.
- A new feature ships already styled with these tokens and components.
- An existing surface that does not match is a bug, to be fixed when it is next touched or in a dedicated pass.

## 5. Generative UI / UX

- **Every user action is registered once** in the action registry (`src/ui/actions.ts`), with its group, icon, priority and when it is relevant. Toolbars, contextual bars, sheets, quick actions, the radial menu and the command palette are generated from it.
- **Content sections are computed from the vault:**
  - subjects come from folders and subject tags;
  - smart collections come from rules (to study, favourites, with PDF, recent, exams);
  - frequent tags come from usage;
  - statistics come from local counters.
- **Empty or irrelevant sections are hidden,** not shown empty. Order adapts to use only where it is meant to: quick slots, "Recenti". Fixed tools never move.
- **Creation is always reachable** (header + New, quick actions). An empty vault or section shows an empty state that teaches the next step instead of hiding the section's purpose. A section of things that can be created (subject folders, notebooks in a folder) shows a dashed create tile in place of its cards; a list that fills up by itself (favourites, recent, a tag) only says how it fills.
- **Layout responds to width:** wide tablet, tablet portrait, phone.

## 6. Settings

- **Rule:** when you add a feature, add its settings in the same change, placed organically. Each setting goes in the section where a person would look for it, next to related settings. Never append it at the end of the list, and never add a section for a single feature.
- **Sections follow what the person is doing**, not when the feature was built, and their order is defined once (docs/design-ui.md, *Settings*):
  1. Writing
  2. Pen & input
  3. Pages & navigation
  4. PDF & reading
  5. Library & files
  6. Sync & safety
  7. Export
  8. Obsidian integration
  9. Study
  10. Appearance & language
  11. Diagnostics
- **Generative there too:**
  - dependent options appear only when their parent is on;
  - options for features not in use are collapsed;
  - each section shows its most-used options first, with an *Advanced* group collapsed;
  - a search box filters every setting.
- **Style:** the same tokens and components (section header, panels, chips, pill inputs).
- **Defaults** are right for a new user on an Android tablet with a pen. A new setting does not change behaviour for existing users unless that is the point of the change.
- **Wording:** a short name in sentence case and at most one line of description, in English and Italian.

## 7. Motion and accessibility

- **Motion:** short and quiet. 120–180 ms ease-out for hover, press and expand; no bounce. Everything respects `prefers-reduced-motion` and the plugin's *Reduce motion and effects* setting.
- **Targets:** at least 40 px (44 px on phone). Nothing is hover-only or right-click-only.
- **Contrast:** text on panels meets WCAG AA. Muted text is never used for essential information.
- **Focus:** a visible 2 px accent focus ring on every interactive element.

## 8. Checklist for every change

1. Uses `--nb-*` tokens and the shared components; no raw colours, sizes or one-off styles.
2. Matches the reference images in spacing, radius, type scale and colour use.
3. Registered in the action registry, with its placement decided per §5.
4. Settings added in the right section and shown only when relevant (§6).
5. Strings in English and Italian.
6. Works with pen, finger and mouse, on phone, tablet and desktop widths, in dark and light.
7. `docs/design-ui.md` is updated if a surface or the settings structure changed.
8. New component rules are scoped under `.nb-ui` (§3), and the surface is checked in the browser harness, which loads Obsidian's own button and input rules.
