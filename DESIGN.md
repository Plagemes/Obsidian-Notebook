# Design rules

These rules apply to every change to the interface. The detailed design (surfaces, layout engine, action registry) is in [`docs/design-ui.md`](docs/design-ui.md); this file is the short list that every feature must satisfy.

## 1. Premium, minimal, functional

- **Premium**: calm, precise, consistent. It should feel like a first-class notes app, not a developer tool. Spacing, radii, icon sizes and motion follow one scale, set by Obsidian's CSS variables and the toolbar size setting.
- **Minimal**: the page keeps the space. Show only what helps in the current context. No duplicate controls, no decorative elements, no walls of text. Explanations go in a short description line or a help link, not in the control.
- **Functional**: every visible control works (CLAUDE.md rule 8). Pen, finger and mouse are all first-class, with targets of at least 40 px and no hover-only or right-click-only affordances.

## 2. Generative UI / UX

The interface is **assembled at run time from the context**, not laid out by hand: what is selected, what kind of page is in view, the device and width, what this person uses most. It is deterministic: no AI, no network, nothing leaves the device.

- Every user action is registered once in the action registry (`src/ui/actions.ts`), with its group, icon, priority and when it is relevant. The toolbar, contextual bar, sheets, radial menu and command palette are generated from it.
- Relevant actions surface where the work is: next to the selection, on the page, in the PDF bar. Rare actions live in the searchable "All actions" sheet.
- Fixed tools never move. Only the slots meant to adapt to use do.

## 3. Settings are part of the generative UI

- **Rule: when you add a feature, add its settings in the same change**, placed organically. Each setting goes in the section where a person would look for it, next to related settings. Never append it at the end of the list, and never add a section for a single feature.
- The settings tab is organised by **what the person is doing**, not by when the feature was built. The sections and their order are defined once (see `docs/design-ui.md`, *Settings*); a new setting picks one of them.
- **Generative there too**:
  - settings that only matter in some contexts are shown only then: dependent options appear when their parent is on, and options for a device or feature that is not in use are hidden or collapsed;
  - a search box filters all settings;
  - each section starts with its most-used options; advanced options sit in a collapsed *Advanced* group of that section.
- **Defaults are right** for a new user on an Android tablet with a pen. A new setting must not change behaviour for existing users unless that is the point of the change.
- Every setting has a short name (sentence case) and at most one line of description, in English and Italian.
- Diagnostics (pen button test, benchmark, logs) live in one *Diagnostics* section at the end, and are also commands.

## 4. Checklist for every feature

1. Registered in the action registry, with its placement decided per §2.
2. Settings added in the right section, and shown only when relevant, per §3.
3. Strings in English and Italian.
4. Works with pen, finger and mouse, on phone, tablet and desktop widths.
5. `docs/design-ui.md` updated if a surface or the settings structure changed.
