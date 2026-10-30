# Notebook — Obsidian plugin for handwritten notes

## What it is
Open source (MIT), local-first Obsidian plugin that adds the "Notebooks" section: notes handwritten with a stylus, with a premium-app experience (Samsung Notes / Goodnotes / Notewise).
Top priority: **Android + stylus (S Pen)**. Secondary: Windows.
Full vision and roadmap: `docs/spec.md`. Do not anticipate future phases without a request.

## Stack
- TypeScript + esbuild, starting from the `obsidian-sample-plugin` structure.
- `manifest.json`: `"isDesktopOnly": false`.
- Rendering: Canvas 2D. Stroke shape: perfect-freehand (MIT), unless a justified alternative is documented in `docs/architecture.md`.
- Tests: vitest for pure logic.

## Non-negotiable rules
1. **Never use Node/Electron modules** (`fs`, `path`, `electron`, `child_process`, dynamic `require`) in runtime code: the plugin runs in the Android WebView. Files only via `app.vault` / `app.fileManager`.
2. **Strokes are always vector**: points `[x, y, pressure]` in page coordinates (never screen) + style (tool, color, width). Never raster only.
3. **Versioned document format**: `version` field; every schema change has a tested migration function.
4. **Zero data loss**: debounced saving, plus flush on view close, `onunload`, `visibilitychange`/`pagehide`. Before overwriting, serialize and re-validate; unreadable files are never overwritten and a backup copy is kept.
5. **No mandatory cloud**, no telemetry.
6. **Licenses**: before copying or adapting external code, check the license and record it in `docs/research.md`. No GPL/AGPL code in the repo.
7. **No AI** until writing and persistence are stable (see roadmap).
8. **No fake controls**: every visible control works. Decorative graphics (artwork, gradients, glows, illustrations) are welcome where they help the look, as long as they never pose as controls or get in the way (see `DESIGN.md`).
9. **Honesty about status**: do not declare a feature complete if it is unverified. You cannot test on Android hardware: do not simulate those results.

## Architecture
```
src/
  main.ts        plugin registration, commands, ribbon, settings
  view/          Obsidian view, toolbar, UI
  ink/           input (Pointer Events), stroke engine, rendering   ← does NOT import 'obsidian'
  model/         document types, (de)serialization, migrations, undo/redo ← does NOT import 'obsidian'
  storage/       read/write via the Vault API
tests/           vitest on ink/ and model/
```
`ink/` and `model/` must be testable in Node without Obsidian.

## Technical notes on input
- `touch-action: none` on the canvas; distinguish with `pointerType` (`pen` / `touch` / `mouse`).
- `getCoalescedEvents()` for point density; `getPredictedEvents()` optional to reduce perceived latency.
- Basic palm rejection: if the pen is active or was used in the last N ms, touch does not draw and only pans/zooms. Make N and the "write with finger" mode configurable.
- Pressure: some devices report a constant value (0.5 or 0) → fall back to pressure simulated from velocity.
- Two layers: static canvas (saved strokes) and live canvas (stroke in progress). Redraw the static layer only when it changes. Use `requestAnimationFrame` and account for `devicePixelRatio`.

## Feature status
`docs/testing.md` contains a table for each feature with these columns: implemented · automated test · verified on hardware · experimental · to do.
Only the user fills in the "verified on hardware" column.

## Workflow
- Every screen, function and interface (present and future) follows `DESIGN.md`: premium, minimal, functional, generative UI/UX, with its tokens and components. A new feature ships already styled and adds its settings in the same change, placed organically in the right section.
- Small commits with clear messages.
- A task is done only if `npm run build`, `npm run lint` and `npm test` pass.
- Update `CHANGELOG.md` and `docs/` when the architecture or format changes.
- Subagents only for independent work (research, review). Two agents never edit the same file.
- Repo content (code, comments, docs, commit messages) is in English. The plugin UI is in English with an Italian translation.
- Never add Claude/AI as co-author or contributor in commits, PRs or docs.

## Commands
- `npm run dev` — build in watch mode
- `npm run build` — production build (`main.js`, `manifest.json`, `styles.css`)
- `npm test` — vitest
- `npm run lint` — eslint + tsc --noEmit
