# Testing

## Feature status

Legend: ✅ yes · ❌ no · — not applicable. The **Verified on hardware** column is filled in **only by the user** after running the protocol below; nothing in it was tested by the developer tooling (no Android hardware available).

| Feature | Implemented | Automated test | Verified on hardware | Experimental | To do |
|---|---|---|---|---|---|
| Ribbon icon + "New notebook" / "Open notebooks" commands | ✅ | ❌ (needs Obsidian) | | | |
| Notebook file created in the configured folder (default `Notebooks/`) | ✅ | ❌ (needs Obsidian) | | | |
| A4 grid page, fitted to width, refit on resize/rotation | ✅ | ✅ fit-width, transforms | | | |
| Pen input via Pointer Events (pen/touch/mouse) | ✅ | ✅ routing logic only | | | |
| Coalesced events | ✅ | ❌ (browser API) | | | |
| Predicted points (live layer only, never saved) | ✅ | ❌ | | ✅ | |
| Real pen pressure, simulated fallback for constant pressure | ✅ | ✅ | | | |
| Basic palm rejection (pen seen in the last N ms) | ✅ | ✅ | | | |
| "Draw with finger" setting | ✅ | ✅ | | | |
| Pen colours (4) and widths (3) | ✅ | ❌ | | | |
| Whole-stroke eraser (toolbar) | ✅ | ✅ hit test | | | |
| Pen eraser button (`buttons & 32`) | ✅ | ❌ | | ✅ | S Pen button mapping unknown |
| Undo/redo (command stack) | ✅ | ✅ | | | |
| One-finger pan, two-finger pinch zoom, wheel/Ctrl+wheel | ✅ (basic) | ✅ zoom/pan maths | | ✅ | smooth zoom in M2 |
| Autosave (1.5 s debounce, 10 s max wait) | ✅ | ✅ | | | |
| Flush on view close, file switch, plugin unload, `visibilitychange`, `pagehide` | ✅ | ❌ (needs Obsidian) | | | |
| Stroke in progress kept when the app goes to background | ✅ | ❌ | | | |
| Re-validation before every write | ✅ | ✅ | | | |
| Unreadable files never overwritten + backup copy | ✅ | ✅ | | | |
| Newer format version opened read-only | ✅ | ✅ | | | |
| External change (Sync): reload, or keep local + back up the other version | ✅ | ✅ | | | |
| Format v1 + migration v0→v1 | ✅ | ✅ | | | |
| Reopen shows identical strokes | ✅ | ✅ round-trip | | | |
| English UI + Italian translation | ✅ | ❌ | | | |
| No Node/Electron imports in `main.js` | ✅ | ✅ `scripts/check-bundle.mjs` in `npm run build` | | | |
| Multiple pages, lasso, highlighter, segment eraser | ❌ | | | | M2 |

## Automated checks

Run on 2026-10-29 (Windows, Node 24):

| Command | Result |
|---|---|
| `npm test` | 8 files, 91 tests passed |
| `npm run lint` | eslint + `tsc --noEmit`: no errors |
| `npm run build` | ok; `main.js` ~48 KB; `check-bundle: ok (requires found: obsidian)` |

Covered by tests: serialization round-trip and determinism, rejection of corrupt files (truncated, garbage, wrong format, bad points/colours/ids, future version), migration v0→v1, undo/redo of adds and multi-stroke erases, eraser hit test (including fast movements and dots), screen↔page transform at 7 zoom levels, fit-width, zoom around a point, pan clamping, palm-rejection routing, pressure detection, and the save session (debounce, max wait, no writes on broken/readonly files, conflict backups, echo detection, retry after a failed write, refusal to write a document that fails re-validation).

Not covered automatically: everything that needs Obsidian or a real browser (DOM, canvas, Pointer Events, Vault API, view lifecycle). That is what the manual protocol is for.

## Manual test protocol — Android + S Pen

Setup: install as in the README, enable the plugin, keep the default settings. Optionally connect `chrome://inspect` to watch the console for `[notebook]` errors. Write down device model, Android version and Obsidian version.

For each step note **pass / fail / notes** in the table at the end.

1. **Create and write.** Ribbon → *Open notebooks* → *+ New notebook* → *Create*. Expected: a grid A4 page as wide as the screen, file in `Notebooks/`. Write a few lines of text.
2. **Perceived latency.** Write quickly and slowly, small handwriting and large loops. Expected: ink follows the pen tip without visible lag or gaps; no jagged segments on fast curves. Repeat with *Predicted points* off (settings) and compare.
3. **Pressure.** Draw lines pressing lightly then hard. Expected: visibly thinner/thicker lines. If width does not change, set *Pressure* to *Always simulated* and confirm speed changes the width instead; report which one your device needs.
4. **Hand resting on the screen.** Rest the palm on the screen *before* the pen touches, and while writing; also touch with the palm right after lifting the pen. Expected: no stray marks from the palm; the page may scroll slightly at most. Repeat with *Draw with finger* on: a palm touching before the pen may start a mark, which must disappear when the pen touches down.
5. **Pinch/zoom and scroll.** One finger: scroll the page. Two fingers: zoom in and out, then write while zoomed. Expected: no ink from fingers, strokes land under the pen at every zoom level, the page never gets lost off screen. *Fit to width* restores the view.
6. **Eraser and undo.** Erase a few strokes with the eraser tool, swiping fast across several. Undo: they come back in place. Redo: they disappear again. If the S Pen button does anything, note what.
7. **Force close while writing.** Write a stroke, and while the pen is still on the screen (or within 1 s of lifting it) open the recent apps and swipe Obsidian away. Reopen Obsidian and the notebook. Expected: everything written before closing is there, including the stroke that was in progress. Repeat by pressing Home while writing, then closing from recents.
8. **Reopen.** Close the tab, reopen the notebook from *Open notebooks*. Restart Obsidian and reopen. Expected: exactly the same strokes, colours and widths.
9. **Screen rotation.** Rotate to landscape and back while a notebook is open, also right after writing. Expected: the page refits to the new width, the same part of the page stays at the top, nothing is lost, and the status shows *Saved* after a moment.
10. **Many strokes.** On the PC run `node scripts/make-stress-notebook.mjs 5000`, copy `stress.notebook` into the vault, open it on Android. Expected: opens in a few seconds at most; scrolling and zooming stay usable; writing on top of it still feels immediate; saving does not freeze the UI noticeably. Note how it feels at 2000 / 5000 / 10000 strokes.
11. **Corrupt file.** On the PC create `Notebooks/broken.notebook` containing `{ not json`. Open it on the device. Expected: an error message, no toolbar editing, the file stays unchanged, and a `.bak` copy appears in `Notebooks/_backup/`.
12. **Sync (if used).** Edit the same notebook on two devices without letting them sync, then sync. Expected: one version is shown and the other one is in `Notebooks/_backup/` as a `conflict` backup; nothing is lost.

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

## Quick check — Windows

Mouse: draw, erase, undo/redo with Ctrl+Z / Ctrl+Shift+Z, wheel scroll, Ctrl+wheel zoom, resize the window (the page refits), close and reopen the notebook. With a pen tablet or Surface pen: pressure and eraser end (`buttons & 32`).
