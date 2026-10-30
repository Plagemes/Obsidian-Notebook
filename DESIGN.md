# Design system

This is the visual and interaction contract for every surface of Notebook. The reference design is in [`docs/design/reference/home.png`](docs/design/reference/home.png) (home dashboard) and [`docs/design/reference/library.png`](docs/design/reference/library.png) (notebook library). When a decision is not covered here, match those two images. The behavioural design (surfaces, layout engine, action registry) is in [`docs/design-ui.md`](docs/design-ui.md).

## 1. Direction

**Premium, minimal, functional, generative.**

- **Premium.** A dark, deep-navy canvas. Content sits in calm, softly bordered panels. Each subject owns a colour, used with restraint: vivid on subject cards, a tint everywhere else. Typography is confident: large bold titles, quiet secondary text. It should feel like a first-class study app, not a developer tool.
- **Minimal.** One idea per panel. Generous spacing, no visual noise, no walls of text. Each element has a single job, and secondary detail is muted rather than removed.
- **Functional.** Every visible control works (CLAUDE.md rule 8). Every card, tile, chip and row is a real target that opens or does something. Pen, finger and mouse are all first-class.
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
- **Subject artwork:** a procedural, line-art pattern generated from the subject name and colour (contour lines, cells, waves, curves). It sits on the right half of the card, fading into the card gradient, and is never a stock image.
  - Generation is deterministic, cheap (a cached canvas or SVG) and off when *Reduce motion and effects* is on.
  - It is part of the card target, so it is not decorative UI.
- **Thumbnails:** favourite and recent notebooks show a real page thumbnail (56 px, radius 10) from the existing thumbnail cache.

## 3. Components

Each component lives in the plugin as one reusable builder, for example `ui/components/subject-card.ts`, with the same tokens on every surface.

| Component | Anatomy (from the reference) | Behaviour |
|---|---|---|
| **Page header** | Large title + muted subtitle on the left. On the right: search pill, circular icon buttons (filter, sort, view toggle; the active one gets an accent fill) | The search pill searches the current surface. The `⌘K` / `Ctrl K` hint is shown only on desktop |
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
| **Navigation rail** | Brand (icon + "Quaderni / per Obsidian"); items Home · Quaderni · PDF · Canvas · Tag · Impostazioni (active: accent-tinted pill); "VAULT" label; folder tree with subject-coloured folders; "Archivio" at the bottom | Inside the plugin's own views only. It collapses to icons on narrow widths and becomes a bottom sheet on phone |

**Exclusions:**
- "AI Study" in the reference is **not shown** until AI is allowed by the roadmap (CLAUDE.md rule 7). Its place stays empty rather than showing a control that does nothing.
- "Canvas" appears only if that feature exists.
- The notification bell and avatar appear only if they have a real function (sync status, profile) — otherwise they are omitted.

## 4. Surfaces mapped to the reference

- **Home** (`home.png`): page header · *Cartelle per materia* (subject cards, 2×2 on tablet) · *Note recenti* (list panel) next to *Statistiche* (2×2 KPI tiles) · *Azioni rapide* (4 quick-action tiles).
- **Library** (`library.png`): page header with filter / sort / view buttons · filter chips · subject cards (4 in a row) · *Raccolte intelligenti* (smart collection tiles: Da studiare, Preferiti, Con PDF, Recenti, Esami) · *Tag frequenti* (tag chips) · *Quaderni recenti* (list panel) next to *Quaderni preferiti* (favourite rows).
- **Notebook view:** the writing surface stays the page first. The toolbar, contextual bar, sheets and radial menu use the same tokens, radii, icon squares and chip styles, in their compact sizes.
- **Settings:** the same tokens (§6).

## 5. Generative UI / UX

- **Every user action is registered once** in the action registry (`src/ui/actions.ts`), with its group, icon, priority and when it is relevant. Toolbars, contextual bars, sheets, quick actions, the radial menu and the command palette are generated from it.
- **Content sections are computed from the vault:**
  - subjects come from folders and subject tags;
  - smart collections come from rules (to study, favourites, with PDF, recent, exams);
  - frequent tags come from usage;
  - statistics come from local counters.
- **Empty or irrelevant sections are hidden,** not shown empty. Order adapts to use only where it is meant to: quick slots, "Recenti". Fixed tools never move.
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
