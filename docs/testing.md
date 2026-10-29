# Testing

## Feature status

Legend: ✅ yes · ❌ no · — not applicable. The **Verified on hardware** column is filled in **only by the user** after running the protocol below; nothing in it was tested by the developer tooling (no Android hardware available). "Experimental" means the behaviour depends on the device or WebView and needs tuning from real measurements.

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
| Palm rejection by contact size (setting, off by default) | ✅ | ✅ routing logic only | | ✅ | depends on what the device reports for touch size |
| Pen: 9 colours, 5 widths | ✅ | ❌ | | | |
| Highlighter: 5 colours, 3 widths, constant width | ✅ | ✅ format round-trip | | | |
| Highlighter translucent with `multiply` blending | ✅ | ❌ (canvas) | | ✅ | live preview is not multiplied until the stroke is committed |
| Stabilization (0–10, default 2) | ✅ | ✅ | | | tune levels on the device |
| Whole-stroke eraser (toolbar) | ✅ | ✅ hit test | | | |
| Segment eraser (cuts strokes; works across pages in one gesture) | ✅ | ✅ cutting logic; ❌ across pages (view) | | | |
| Pen eraser button (`buttons & 32`) | ✅ | ❌ | | ✅ | S Pen button mapping unknown |
| Lasso selection (≥ 50% of points inside) | ✅ | ✅ | | | |
| Selection: move, resize (bottom-right handle), rotate (handle above), delete | ✅ (basic) | ✅ matrices, stroke transform; ❌ handles and gestures (view) | | | one page per selection; no copy/paste |
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
| Page sizes A4, A5, Letter + landscape (per page) | ✅ | ✅ command logic; ❌ view | | | no custom sizes (M3c) |
| Changing page size keeps strokes where they are (outside ones clipped, kept in the file) | ✅ | ✅ strokes untouched by `SetPageSize`; ❌ clipping on screen | | | |
| Page menu: duplicate, move up/down, delete, paper, size, orientation (all undoable) | ✅ | ✅ commands and undo/redo; ❌ menu (view) | | | |
| Add page copies size and paper of the page in view | ✅ | ❌ (view) | | | |
| New-notebook dialog with size, orientation and paper; last choice remembered | ✅ | ✅ settings parsing; ❌ dialog | | | |
| Default paper / size / orientation settings | ✅ | ✅ settings parsing; ❌ settings tab | | | |
| Export page / notebook as PDF, page as SVG (written next to the notebook) | ✅ | ✅ generators (structure, offsets, y-flip, highlighter, determinism); ❌ file writing (Obsidian) | | ✅ | PDF and SVG checked with pdf.js and resvg on the PC only; not opened on Android; PDF is uncompressed (large with a lot of ink) |
| Format v3 (paper kinds) + migration v2→v3 (identity) | ✅ | ✅ | | | |
| 0.2.x opens a 0.3 file read-only and keeps a backup | ✅ | ✅ future-version handling (same code path as v2 in 0.1); ❌ with a real 0.2 install | | | |
| Reopen shows identical strokes | ✅ | ✅ round-trip | | | |
| English UI + Italian translation | ✅ | ❌ | | | |
| No Node/Electron imports in `main.js` | ✅ | ✅ `scripts/check-bundle.mjs` in `npm run build` | | | |

## Automated checks

Numbers from the final run of M3a (development PC).

| Command | Result |
|---|---|
| `npm test` (unit project only; benchmarks are separate) | 12 files, 199 tests passed |
| `npm run lint` | eslint + `tsc --noEmit`: no errors; `eslint-plugin-obsidianmd` recommended rules: no errors or warnings |
| `npm run build` | ok; `check-bundle: ok (requires found: obsidian)` |
| `npm run bench` | ok; numbers below (PC only) |

Added in M3a: migration v2→v3 (identity plus version, v0 and v1 files still reach v3), all five paper kinds in the round-trip, rejection of unknown kinds and bad spacing, `duplicatePage` (new ids, same content, unique ids in the document), `DeletePage` (order, undo/redo with the same page object, the last page is never deleted), `MovePage` (both directions, edges, clamping, exact undo), `SetPaper` and `SetPageSize` (exact undo, strokes untouched), paper pattern geometry for each kind (ruled first line and 25 mm margin, dots at intersections, millimetre major lines, culling, `includeMinor`), SVG output (size in mm with a pt viewBox, paper on/off, highlighter, escaping, determinism) and PDF output (header and trailer, one page object per page, `xref` offsets, `/Length`, MediaBox, y-flip, colours, ExtGState only with a highlighter, title escaping, two decimals).

Covered by tests: serialization round-trip and determinism, rejection of corrupt files (truncated, garbage, wrong format, bad points/colours/ids, future version), migrations v0→v1 and v1→v2, highlighter round-trip, `serializeChecked` (same output as `serialize`, frozen strokes, duplicate ids, NaN, incremental check equal to the full parse on a large document), undo/redo of adds, erases, `ReplaceStroke`, `AddPage` (never removes the last page) and `Batch`, eraser hit test (including fast movements and dots), segment cutting (including cuts between distant points and no single-point crumbs), lasso selection and selection bounds, affine transforms and stroke transform with width scaling, stabilizer, page layout and visible-page selection, screen↔page transform at 7 zoom levels, fit-width, zoom around a point, pan clamping, palm-rejection routing (time-based and contact size), pressure detection, the deterministic stress document, and the save session (debounce, max wait, no writes on broken/readonly files, conflict backups, echo detection, retry after a failed write, refusal to write a document that fails re-validation, backup-before-overwrite ordering when another writer races the save, no overwrite when the backup fails, external-change checks queued after flushes, close-time retries with an `unsaved` backup, deleted files never written, stale sessions silent).

Export checks outside the unit tests (development PC, not Android): a PDF generated by `pagesToPdf` was parsed with pdf.js (3 pages, Unicode title, fills, stroked paper lines, highlighter ExtGState) and an SVG from `pageToSvg` was rendered with resvg. Neither file was opened on an Android device or in Obsidian.

Independent review (M1): the data-safety code (session, Vault I/O, serializer, view lifecycle, undo) was reviewed by a separate agent that did not write it; its 7 findings (3 medium, 4 low, no corruption) were fixed and covered by the tests above.

Measured on the PC in M1 (not on Android): a 10,000-stroke notebook (268k points) is 6.8 MB; parse 156 ms, serialize 98 ms. In M2 the save check no longer re-parses documents over 1 MB each time. `npm run bench` on the dev PC (Windows, Node 24; 10,000 strokes, 10 pages, 6.69 MB): serialize 153 ms; open (parse + validate) 227 ms; open + first save with a cold cache 424 ms in total; next saves 16–19 ms; eraser hit test 0.04 ms per move (1,000 strokes, cached bounds); segment cut 0.005 ms; lasso over a quarter page 2.4 ms; stroke outline 0.04 ms. **These are PC numbers.** Android will be slower and must be measured with the in-app benchmark (step 21); record those numbers here once available.

Not covered automatically: everything that needs Obsidian or a real browser (DOM, canvas, Pointer Events, Vault API, view lifecycle, the toolbar, the page menu and dialogs, writing the export files, selection handles and gestures, the fast path and fling). That is what the manual protocol is for.

## Manual test protocol — Android + S Pen

Setup: install as in the README, enable the plugin, keep the default settings. Optionally connect `chrome://inspect` to watch the console for `[notebook]` errors. Write down device model, Android version and Obsidian version.

For each step note **pass / fail / notes** in the table at the end.

1. **Create and write.** Ribbon → *Open notebooks* → *+ New notebook* → *Create*. Expected: a grid A4 page as wide as the screen, file in `Notebooks/`. Write a few lines of text.
2. **Perceived latency.** Write quickly and slowly, small handwriting and large loops. Expected: ink follows the pen tip without visible lag or gaps; no jagged segments on fast curves. Repeat with *Predicted points* off (settings) and compare.
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
14. **Highlighter.** Choose the highlighter, a colour and each width. Draw over pen text and over the grid. Expected: the text stays readable through the highlighter, the colour looks translucent and darkens the ink below it rather than covering it, the width does not change with pressure. Note whether the stroke looks different while drawing and after lifting the pen (the preview is not multiplied). Reopen the notebook: same look.
15. **Segment eraser.** Choose *Eraser → Segment*. Cut across a long stroke, across several strokes, and in one gesture from the end of one page into the next page. Expected: only the part under the eraser disappears, no stray dots remain, one undo restores everything erased in that gesture. Try a fast swipe and small circles. Switch back to *Whole stroke* and check it still removes entire strokes.
16. **Lasso.** Choose the lasso and draw a loop around some words, then: drag inside the frame to move them; drag the bottom-right handle to resize (uniform); drag the handle above the top edge to rotate; each time undo and redo. Then select again and delete with the toolbar button (on a keyboard also Delete/Backspace), undo. Escape or switching tool clears the selection. Expected: handles are easy to hit with the pen, the selection follows the pen without lag, a stroke is selected only when about half or more of it is inside the loop, and after reopening the transformed strokes are where you left them. Try a selection with 200+ strokes on the stress notebook and note how it feels.
17. **Stabilization.** Write a slow wavy line and a signature at levels 0, 2 (default), 5 and 10. Expected: higher levels smooth tremor but trail behind the pen and round off corners; the line catches up when you lift. Report which level feels right.
18. **Palm contact size.** Settings → *Ignore large touches*: leave at off, then try 30, 50 and 70 px. Rest a palm, a fist edge and a single finger on the screen. Expected: with a suitable value the palm is ignored completely (it does not scroll either) while a finger still scrolls. Report what range works on your device, or that the device reports a constant size (then the setting cannot help).
19. **Fling scrolling.** With one finger, flick the page up and down at different speeds, then touch the screen during the glide. Expected: the page keeps moving after the finger lifts, slows down smoothly and stops at once when touched. Check that a slow drag followed by a pause does not fling.
20. **Performance overlay.** Turn on *Performance overlay* and open the stress-test notebook. Note the readings (frame time, input→frame, redraw ms, strokes and pages drawn) in these situations: idle; writing; one-finger scrolling; pinch zooming in and out; at fit width and at high zoom. While scrolling or zooming the page may look blurred or blank at the edges for a moment and then sharpen (the fast path): note whether that is visible and bothersome.
21. **In-app benchmark.** Command palette → *Run performance benchmark* with a notebook open (the benchmark uses the size of the view). Wait for it to finish and use *Copy results*, then paste the whole output into the notes table below. Run it twice, in portrait and landscape if you can, and once with other apps closed.
22. **Notebook written by 0.1.** Open a notebook created with 0.1.x. Expected: identical strokes. Add a stroke and reopen: it works. Afterwards the file is format v3 and a 0.1.x or 0.2.x plugin would open it read-only (this last point can be checked on the PC).

23. **Paper and page size at creation.** Create a notebook for each paper (*Blank*, *Ruled*, *Grid*, *Dotted*, *Millimetre*) and each size (*A4*, *A5*, *Letter*), with and without *Landscape* (a few combinations are enough: at least one of each paper, one of each size, one landscape). Expected: the page has the right proportions and fits the view width; ruled paper has a first line below a top margin and a red margin line on the left; dotted paper has a dot at each grid intersection; millimetre paper has a darker line every 10 mm and the fine lines fade out when zoomed out and come back when zoomed in; the dialog opens with your last choice, and the same defaults appear in *Settings → Default paper / page size / Landscape by default*. Write on each, including near the edges.
24. **Page menu and undo.** In a notebook with three pages and some ink on each, open the page menu (three-dot button next to *Add page*) and use, one by one: *Duplicate page*; *Move page up* and *down* (disabled at the ends); *Delete page* (disabled with a single page); a different *Paper*; a different *Size*; *Landscape* / *Portrait*. After each, undo and redo. Expected: every action takes effect on the page in view, is a single undo step, and undo restores the exact previous state (order, paper, size, strokes). The duplicate has the same ink and can be edited independently. After shrinking a page (for example A4 to A5) with ink near the bottom: the ink outside is not shown; undo, or enlarging again, brings it back. *Add page* gives a page with the size and paper of the page in view. Close and reopen: same pages, order, papers and sizes.
25. **Export.** From the page menu run *Export page as PDF*, *Export notebook as PDF* and *Export page as SVG* on a notebook with several pages, mixed papers and sizes, a highlighter stroke and some Unicode in the notebook name (for example an accent). Expected: a notice with the path; the files appear next to the notebook (`<name>.pdf`, `<name> p2.pdf`, `<name> p2.svg`); running the same export again creates `… 2` files instead of overwriting. Open the PDF on the device (from the file explorer, or share it to a PDF viewer or another app) and check: page count, page sizes and orientation, paper pattern, ink in the right place and colours, highlighter translucent over the ink, no missing strokes. Note the file size of a page with a lot of ink (the PDF is not compressed) and how long the export takes. Open the SVG in a browser or an image viewer.
26. **0.2 opens a 0.3 file.** Take a notebook saved by 0.3 (for example one with a ruled or dotted page) to a device or vault that still has Notebook 0.2.x, and open it. Expected: it opens read-only with a warning, nothing can be edited, the file is unchanged, and a `.bak` copy appears in `Notebooks/_backup/`. Then open it again with 0.3: normal editing.

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

Benchmark output (step 21): paste it here.

```
(paste results)
```

## Quick check — Windows

Mouse: draw, erase (both modes), undo/redo with Ctrl+Z / Ctrl+Shift+Z, wheel scroll, Ctrl+wheel zoom, resize the window (the page refits), add a page, use every page menu action with undo, create notebooks with each paper and size, export PDF and SVG and open them, lasso select/move/resize/rotate/delete, close and reopen the notebook. With a pen tablet or Surface pen: pressure and eraser end (`buttons & 32`).

## Known limitations (v0.3)

- Nothing has been verified on Android hardware yet.
- Highlighter, palm contact size, fling, the CSS fast path, predicted points and the performance overlay are experimental. The highlighter preview while drawing is not multiplied with the page; the final look appears when the stroke is committed.
- While the fast path moves the old bitmap during a pan or zoom, uncovered areas are blank and detail is not re-rendered until 120 ms after the gesture pauses.
- Page sizes are limited to A4, A5 and Letter (portrait or landscape); no custom sizes. Changing a page size does not move or scale its strokes: strokes outside a smaller page are kept in the file but clipped on screen and in exports.
- Exports: PDF and SVG always include the paper pattern, there is no option to leave it out. The PDF is not compressed, so a page with a lot of ink gives a large file (roughly 100-200 bytes per stroke point). Dots of dotted paper are tiny squares in the PDF and circles in the SVG. There is no export of a page range or a selection; page SVG and PDF are exported from the page menu, the whole notebook also from the command palette.
- The PDF and SVG were checked with pdf.js and resvg on the PC, not on Android.
- A lasso selection belongs to one page, strokes cannot be moved to another page, and there is no copy/paste. Resize is uniform only (one handle). Strokes moved partly outside their page are clipped when drawn.
- Stabilization is applied while writing and the stabilized points are what is saved; it cannot be changed after the fact.
- The segment eraser removes whole point runs: very short leftover pieces (a single point) are dropped.
- Every save serializes the whole document. The re-validation is full under 1 MB and incremental above it, so very large notebooks save faster than in 0.1, but a short freeze is still possible on slow tablets (to be measured with the in-app benchmark).
- The undo history is in memory only (500 commands) and is lost when the notebook is closed.
- A notebook saved by 0.2 (format v2) opens read-only in 0.1.x, and one saved by 0.3 (format v3) opens read-only in 0.2.x.
- If Android kills Obsidian without a `visibilitychange` event, the last ~1.5 s of changes (up to 10 s while writing continuously) can be lost.
- When another writer changes the file in the instant between our read and our write, the attempt is aborted by writing back the same content; this may bump the file's modification time (no data change).
- The S Pen side button is not mapped; only the standard `buttons & 32` eraser is handled.
- Notebooks are invisible to Obsidian search, tags, backlinks and graph (M4).
