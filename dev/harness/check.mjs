// Headless smoke check of the browser harness (npm run harness:check).
//
// Builds the harness, serves it, starts a headless Chrome/Chromium/Edge (CHROME_PATH, or the usual
// install paths) and drives it over the DevTools protocol. For each scenario (old v3 notebook and new
// notebook × light and dark theme × phone, tablet and desktop viewports with their device pixel
// ratios, plus the low-latency ink setting) it runs the in-page check (layout, canvases, pen,
// highlighter and eraser input through synthetic pen PointerEvents), then takes a screenshot and
// checks the *composited* pixels: paper where the page is, ink where the pen wrote. Screenshots go to
// dev/harness/dist/shots/. Exit code 1 on any failure. HARNESS_DOC=practice runs only the scenarios of that notebook.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { buildHarness } from "./build.mjs";
import { Cdp, findChrome, sleep } from "./chrome.mjs";
import { serve } from "./serve.mjs";

const DEVICES = {
	// Samsung Galaxy Tab S-class tablet in portrait, Android WebView.
	tablet: { width: 800, height: 1280, deviceScaleFactor: 2, mobile: true, touch: true },
	phone: { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, touch: true },
	// Small phone (360 CSS px is the common narrow Android width): the toolbar must still fit.
	narrow: { width: 360, height: 740, deviceScaleFactor: 3, mobile: true, touch: true },
	desktop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, touch: false },
	// The same tablet held sideways.
	tabletLandscape: { width: 1280, height: 800, deviceScaleFactor: 2, mobile: true, touch: true },
	// 0.13 polish: a short landscape phone (740 CSS px wide): the toolbar must keep three quick slots (Back among them).
	phoneLandscape: { width: 740, height: 360, deviceScaleFactor: 2.625, mobile: true, touch: true },
};

// The families of src/ui/art/generative-art.ts (ART_STYLES), for the art gallery pages.
const ART_STYLES = ["contours", "cells", "waves", "branches", "flow", "orbits", "grid", "veins"];

const SCENARIOS = [];
for (const doc of ["v3", "new"]) {
	for (const theme of ["light", "dark"]) {
		for (const device of Object.keys(DEVICES)) SCENARIOS.push({ doc, theme, device, lowLatency: false });
	}
}
// 0.12 design system: Home and the library on a seeded demo vault, at the size of the reference images (1448 × 1086),
// tablet portrait and phone, dark and light. Screenshots also go to dev/harness/dist/shots/design/ for review.
DEVICES.reference = { width: 1448, height: 1086, deviceScaleFactor: 1, mobile: true, touch: true };
for (const surface of ["home", "library"]) {
	for (const theme of ["dark", "light"]) {
		for (const device of ["reference", "tablet", "phone"]) SCENARIOS.push({ doc: "library", surface, theme, device, lowLatency: false });
	}
}
// 0.13 home2: Home's Continue card in its three states (lecture in progress: the default scenarios above; a class without a
// notebook yet; no class: the notebook left off in), tablet and phone, dark and light, plus the tablet held sideways.
for (const variant of ["create", "last"]) {
	for (const theme of ["dark", "light"]) {
		for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "library", surface: "home", variant, theme, device, lowLatency: false });
	}
}
for (const theme of ["dark", "light"]) SCENARIOS.push({ doc: "library", surface: "home", theme, device: "tabletLandscape", lowLatency: false });
// 0.14 layout: Home and the library held sideways on a phone (short landscape), dark and light.
for (const surface of ["home", "library"]) {
	for (const theme of ["dark", "light"]) SCENARIOS.push({ doc: "library", surface, theme, device: "phoneLandscape", lowLatency: false });
}
// 0.12.2: Home and the library on an empty vault (no notebooks, no notebooks folder yet): the + New button, the quick
// actions and the empty state are there and open the creation dialog. Screenshots in dev/harness/dist/shots/design/.
for (const surface of ["home", "library"]) {
	for (const theme of ["dark", "light"]) {
		for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "empty", surface, theme, device, lowLatency: false });
	}
}
// 0.12.3: the empty vault on a hostile WebView (newer built-ins deleted, the art engine failing): everything but the art
// is drawn. Screenshots of Home / the library and of both tabs of the creation dialog in dev/harness/dist/shots/design/.
SCENARIOS.push({ doc: "empty", surface: "home", theme: "dark", device: "tablet", lowLatency: false, hostile: true });
SCENARIOS.push({ doc: "empty", surface: "library", theme: "dark", device: "tablet", lowLatency: false, hostile: true });
SCENARIOS.push({ doc: "empty", surface: "home", theme: "light", device: "phone", lowLatency: false, hostile: true });
// Phone held sideways: little height for the toolbar popovers.
DEVICES.landscape = { width: 740, height: 360, deviceScaleFactor: 3, mobile: true, touch: true };
SCENARIOS.push({ doc: "new", theme: "light", device: "landscape", lowLatency: false });
SCENARIOS.push({ doc: "pdf", theme: "light", device: "tablet", lowLatency: false });
SCENARIOS.push({ doc: "v3", theme: "dark", device: "tablet", lowLatency: true });
SCENARIOS.push({ doc: "new", theme: "light", device: "phone", lowLatency: true });
// Injected faults: wet ink failing on every paint, and one stored stroke that cannot be drawn.
SCENARIOS.push({ doc: "v3", theme: "dark", device: "tablet", lowLatency: false, fault: "wet" });
SCENARIOS.push({ doc: "v3", theme: "dark", device: "tablet", lowLatency: true, fault: "wet" });
SCENARIOS.push({ doc: "v3", theme: "light", device: "tablet", lowLatency: false, fault: "stroke" });
// The PDF reading tools (search, snapping highlighter, hidden annotations, dimming) on a notebook of three fake PDF pages.
SCENARIOS.push({ doc: "pdf", theme: "light", device: "desktop", lowLatency: false });
SCENARIOS.push({ doc: "pdf", theme: "dark", device: "narrow", lowLatency: false });
// The practice strip, the peek and the timer on a notebook with a practice copy (wave 0.9).
SCENARIOS.push({ doc: "practice", theme: "light", device: "desktop", lowLatency: false });
SCENARIOS.push({ doc: "practice", theme: "dark", device: "narrow", lowLatency: false });
// 0.14 lecture: automatic lecture mode (ask, automatic, the pen, the end of the class) and the prefilled lecture page.
for (const theme of ["dark", "light"]) {
	for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "lecture", theme, device, lowLatency: false });
}
// The generated outline (0.13): bookmarks, slides, large handwriting and markers in the page panel, tablet and phone, light and dark.
SCENARIOS.push({ doc: "outline", theme: "light", device: "tablet", lowLatency: false });
SCENARIOS.push({ doc: "outline", theme: "dark", device: "tablet", lowLatency: false });
SCENARIOS.push({ doc: "outline", theme: "light", device: "phone", lowLatency: false });
SCENARIOS.push({ doc: "outline", theme: "dark", device: "phone", lowLatency: false });
// The notebook map (0.14, #408): a grid of pages with state badges and filters, tablet and phone, light and dark.
SCENARIOS.push({ doc: "nbmap", theme: "light", device: "tablet", lowLatency: false });
SCENARIOS.push({ doc: "nbmap", theme: "dark", device: "tablet", lowLatency: false });
SCENARIOS.push({ doc: "nbmap", theme: "light", device: "phone", lowLatency: false });
SCENARIOS.push({ doc: "nbmap", theme: "dark", device: "phone", lowLatency: false });
// 0.19 gallery: the Figures gallery (tablet and phone, light and dark).
for (const theme of ["light", "dark"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "figures", theme, device, lowLatency: false });
// Move a selection to another page (0.16, #78): the page picker, tablet and phone, light and dark.
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "movesel", theme, device, lowLatency: false });
// Presentation mode (0.16, #87): full screen page with the laser pointer, tablet and phone, light and dark.
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "present", theme, device, lowLatency: false });

// Magnetic snap and alignment guides (0.17, #71): a stroke dragged beside another lands on its edge; the guides are drawn during the drag.
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "snap", theme, device, lowLatency: false });
// 0.20 headings (#102): the Titles filter and title strips of the notebook map (dev/harness/headings-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "headings", theme, device, lowLatency: false });
// 0.18 a4split (#178): Split into sheets in the export dialog, with the preview of the cuts (dev/harness/a4split-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "a4split", theme, device, lowLatency: false });
// 0.19 cleanexport (#239): the Clean copy switch in the export dialog (dev/harness/cleanexport-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "cleanexport", theme, device, lowLatency: false });
// 0.21 htmlexport (#164): Interactive HTML in the export dialog and its viewer (dev/harness/htmlexport-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "htmlexport", theme, device, lowLatency: false });
// 0.23 exportarea (#280): export of the written area or the selection as transparent PNG or SVG (dev/harness/exportarea-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "exportarea", theme, device, lowLatency: false });
// 0.25 clipimage (#277): Copy as image with its fallbacks (dev/harness/clipimage-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "clipimage", theme, device, lowLatency: false });
// 0.24 tagsuggest: suggested tags in the tag editors (dev/harness/tagsuggest-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "tagsuggest", theme, device, lowLatency: false });
// 0.27 pdfsuggest (#418): suggested PDF search terms (dev/harness/pdfsuggest-check.ts), tablet and phone, light and dark (dist/shots/pdfsuggest-*.png, pdfsuggest-typed-*.png).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "pdfsuggest", theme, device, lowLatency: false });
// 0.24 handin (#334): the Hand in dialog and its cover (dev/harness/handin-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "handin", theme, device, lowLatency: false });
// 0.26 redact (#285): redaction before export, the Redact dialog and its row in the export dialog (dev/harness/redact-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "redact", theme, device, lowLatency: false });
// 0.20 share (#30): Share page… dialog and both branches of the share (dev/harness/share-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "share", theme, device, lowLatency: false });
// Quick tabs (0.18, #227): the strip with pinned pages, Back, a gone page, another notebook; tablet and phone, light and dark.
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "quicktabs", theme, device, lowLatency: false });
// 0.24 bookmarks (#265): global bookmarks list and dialog (dev/harness/bookmarks-check.ts), tablet and phone, light and dark.
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "bookmarks", theme, device, lowLatency: false });
// Locked pages (0.16, #124): the lock badge, the refused edits and the lock in the page panel, tablet and phone, light and dark.
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "lock", theme, device, lowLatency: false });
// 0.20 refwindow (#107): the floating reference window (dev/harness/refwindow-check.ts), tablet and phone, light and dark (dist/shots/refwindow-*.png).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "refwindow", theme, device, lowLatency: false });
// 0.20 dropfiles (#79): files dragged onto a page: the frame, the blocked frame, the PDF choice and the pictures placed (dev/harness/dropfiles-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "dropfiles", theme, device, lowLatency: false });
// Ghost guide lines on blank paper (0.20, #94).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "ghostlines", theme, device, lowLatency: false });
// 0.21 pagetime (#217): start and end time of a page (dev/harness/pagetime-check.ts), tablet and phone, light and dark (dist/shots/pagetime-*.png).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "pagetime", theme, device, lowLatency: false });
// 0.22 pens (#35): fountain pen, brush and marker: the pen options and a specimen (dev/harness/pens-check.ts), tablet and phone, light and dark (dist/shots/pens-*.png).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "pens", theme, device, lowLatency: false });
// Sticky notes (0.17, #20): an open note with text and handwriting and a collapsed one, tablet and phone, light and dark.
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "sticky", theme, device, lowLatency: false });
// Margin comments (0.18, #86): markers, card, side panel, editor and the drawn rectangle, tablet and phone, light and dark.
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "comments", theme, device, lowLatency: false });
// Handwritten checklists (0.19, #103): tap to tick, the square drawn by hand and its offer, the task line, tablet and phone, light and dark.
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "checklists", theme, device, lowLatency: false });
// Groups and locked elements (0.20, #39): group, tap to select the group, lock, the Unlock chip and the list of locked elements, tablet and phone, light and dark.
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "groups", theme, device, lowLatency: false });
// 0.22 axes (#206): an L or a + drawn by hand offered as axes (dev/harness/axes-check.ts), tablet and phone, light and dark (dist/shots/axes-*.png).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "axes", theme, device, lowLatency: false });
// 0.23 chembal (#294): the Balance reaction preview over typed reactions (dev/harness/chembal-check.ts), tablet and phone, light and dark (dist/shots/chembal-*.png).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "chembal", theme, device, lowLatency: false });
// 0.21 signstamp (#154): the sign-and-date dialog, the signature pad and the placed signature (dev/harness/signstamp-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "signstamp", theme, device, lowLatency: false });
// Minimap (0.17, #173): the overview of an infinite page, tablet and phone, light and dark.
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "minimap", theme, device, lowLatency: false });
// 0.21 slideback (#225): the pill back to the current slide (dev/harness/slideback-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "slideback", theme, device, lowLatency: false });
// 0.23 savedviews (#264): saved views (dev/harness/savedviews-check.ts), tablet and phone, light and dark (dist/shots/savedviews-*.png).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "savedviews", theme, device, lowLatency: false });
// 0.25 histpanel (#84): the action history panel (dev/harness/histpanel-check.ts), tablet and phone, light and dark (dist/shots/histpanel-*.png).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "histpanel", theme, device, lowLatency: false });
// 0.27 workspaces (#375): workspace presets and their picker (dev/harness/workspaces-check.ts), tablet and phone, light and dark (dist/shots/workspaces-*.png).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "workspaces", theme, device, lowLatency: false });
// 0.26 related (#422): the Related pages panel (dev/harness/related-check.ts), tablet and phone, light and dark (dist/shots/related-*.png, related-empty-*.png).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "related", theme, device, lowLatency: false });
// 0.22 pagerefs (#179): the chip and list of pages that link here (dev/harness/pagerefs-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "pagerefs", theme, device, lowLatency: false });
// 0.22 review fix: every floating pill at once, no overlap (dev/harness/pillstack-check.ts), tablet and phone, light and dark (dist/shots/pillstack-*.png).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "pillstack", theme, device, lowLatency: false });
// 0.24 navadapt (#414): the adaptive page navigator (dev/harness/navadapt-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "navadapt", theme, device, lowLatency: false });
// 0.25 markedview (#419): marked pages only in the page navigator (dev/harness/markedview-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "markedview", theme, device, lowLatency: false });
// 0.27 spread (#49): two pages side by side on the landscape tablet, one column on the phone (dev/harness/spread-check.ts), dist/shots/design/spread-*.png.
for (const device of ["tabletLandscape", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "spread", theme, device, lowLatency: false });
// 0.27 macros (#170): the macro manager, the toolbar button and a run (dev/harness/macros-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "macros", theme, device, lowLatency: false });
// 0.28 linehandle (#256): Reorder lines (dev/harness/linehandle-check.ts), dist/shots/design/linehandle-*.png.
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "linehandle", theme, device, lowLatency: false });
// 0.26 tidy (#238): Tidy up (dev/harness/tidy-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "tidy", theme, device, lowLatency: false });
// 0.23 welcomeback (#420): the welcome-back card (dev/harness/welcomeback-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "welcomeback", theme, device, lowLatency: false });
// 0.27 plannertasks (#266): the tasks chip on planner pages (dev/harness/plannertasks-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "plannertasks", theme, device, lowLatency: false });
// 0.24 iconhelp (#429): the long-press explanation bubble (dev/harness/iconhelp-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "iconhelp", theme, device, lowLatency: false });
// 0.25 toolfade (#399): the bars fade while the pen writes (dev/harness/toolfade-check.ts), dist/shots/design/toolfade-*.png.
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "toolfade", theme, device, lowLatency: false });
// 0.27 inputlayout (#431): layout by input device (dev/harness/inputlayout-check.ts), dist/shots/design/inputlayout-*.png.
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "inputlayout", theme, device, lowLatency: false });
// 0.26 zoomwidth (#350): pen width follows zoom (dev/harness/zoomwidth-check.ts), dist/shots/design/zoomwidth-*.png.
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "zoomwidth", theme, device, lowLatency: false });
// 0.27 semzoom (#130): semantic zoom (dev/harness/semzoom-check.ts), dist/shots/design/semzoom-*.png.
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "semzoom", theme, device, lowLatency: false });
// 0.22 lecthead (#210): the lecture header (dev/harness/lecthead-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "lecthead", theme, device, lowLatency: false });
// 0.23 dimcheck (#293): the units hint of the equation editor (dev/harness/dimcheck-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "dimcheck", theme, device, lowLatency: false });
// 0.24 palettectx (#424): the context-ordered All actions sheet (dev/harness/palettectx-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "palettectx", theme, device, lowLatency: false });
// 0.23 termorder (#416): the Library sorted by the active term (dev/harness/termorder-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "termorder", surface: "library", theme, device, lowLatency: false });
// 0.23 hookclean (#314): clean-up of hooks and stray dots (dev/harness/hookclean-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "hookclean", theme, device, lowLatency: false });
// 0.24 shapefill (#37): filled shapes and dashed or dotted lines (dev/harness/shapefill-check.ts), tablet and phone, light and dark (dist/shots/shapefill-*.png).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "shapefill", theme, device, lowLatency: false });
// 0.25 areahl (#99): the area highlighter on a PDF page (dev/harness/areahl-check.ts), tablet and phone, light and dark (dist/shots/areahl-*.png).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "areahl", theme, device, lowLatency: false });
// 0.26 opacity (#358): the opacity of ink, pictures and areas (dev/harness/opacity-check.ts), tablet and phone, light and dark (dist/shots/opacity-*.png).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "opacity", theme, device, lowLatency: false });
// 0.27 taper (#351): the taper of the ends of a line (dev/harness/taper-check.ts), tablet and phone, light and dark (dist/shots/taper-*.png).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "taper", theme, device, lowLatency: false });
// 0.26 smooth (#66): Smooth and Straighten strokes (dev/harness/smooth-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "smooth", theme, device, lowLatency: false });
// 0.26 ctxpalette (#394): the colour picker's context rows on a PDF page and a written page (dev/harness/ctxpalette-check.ts), tablet and phone, light and dark (dist/shots/ctxpalette-*.png, ctxpalettew-*.png).
for (const doc of ["ctxpalette", "ctxpalettew"]) for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc, theme, device, lowLatency: false });
// 0.25 baseline (#93): Align to baseline (dev/harness/baseline-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "baseline", theme, device, lowLatency: false });
// 0.25 papersuggest (#409): suggested paper in the "+" strip (dev/harness/papersuggest-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "papersuggest", theme, device, lowLatency: false });
// 0.24 strokejoin (#313): join broken strokes (dev/harness/strokejoin-check.ts).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "strokejoin", theme, device, lowLatency: false });
// 0.25 profiles (#219): writing profiles chip on the pen options (dev/harness/profiles-check.ts), tablet and phone, light and dark (dist/shots/profiles-*.png).
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "profiles", theme, device, lowLatency: false });
// Recent symbols (0.21, #212): the strip, a tapped character and a saved symbol placed pen-sized, tablet and phone, light and dark.
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "symbols", theme, device, lowLatency: false });
// 0.21 backups: scheduled zip backups and their settings rows (dev/harness/backups-check.ts), tablet and phone, dark and light.
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "backups", theme, device, lowLatency: false });
// 0.22 synccore: the cloud sync settings and a run against an in-memory cloud (dev/harness/synccore-check.ts); "modal" keeps the deletion dialog open.
for (const variant of [undefined, "modal"]) for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "synccore", variant, theme, device, lowLatency: false });
// The automatic page header (0.15, #75): drawn on the paper, tablet and phone, light and dark.
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "header", theme, device, lowLatency: false });
// 0.16 pdftext: copying text from a PDF page and the PDF outline and links (dev/harness/pdftext-check.ts), tablet and phone, light and dark.
for (const theme of ["light", "dark"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "pdftext", theme, device, lowLatency: false });
// Anchored excerpts (v10): a region of a fake PDF page excerpted to a new page, drawn live, and the badge's jump back.
SCENARIOS.push({ doc: "excerpt", theme: "light", device: "desktop", lowLatency: false });
SCENARIOS.push({ doc: "excerpt", theme: "dark", device: "tablet", lowLatency: false });
// Read-only mode, PNG export with ranges and Print (wave 0.10): desktop can print, a phone and a tablet cannot.
SCENARIOS.push({ doc: "readonly", theme: "light", device: "desktop", lowLatency: false });
SCENARIOS.push({ doc: "readonly", theme: "dark", device: "narrow", lowLatency: false });
SCENARIOS.push({ doc: "readonly", theme: "light", device: "tablet", lowLatency: false });
// Smart "+" (0.14, #410): the strip of likely pages, tablet and phone, light and dark.
SCENARIOS.push({ doc: "smartadd", theme: "light", device: "tablet", lowLatency: false });
SCENARIOS.push({ doc: "smartadd", theme: "dark", device: "tablet", lowLatency: false });
SCENARIOS.push({ doc: "smartadd", theme: "light", device: "phone", lowLatency: false });
SCENARIOS.push({ doc: "smartadd", theme: "dark", device: "phone", lowLatency: false });
// The settings tab (sections, a dependent option, Advanced, search in both languages, Style, 40 px targets) on a phone, a tablet and a desktop.
SCENARIOS.push({ doc: "settings", theme: "light", device: "narrow", lowLatency: false });
SCENARIOS.push({ doc: "settings", theme: "dark", device: "tablet", lowLatency: false });
SCENARIOS.push({ doc: "settings", theme: "dark", device: "desktop", lowLatency: false });
// The light desktop settings too: with the dark one, the pair shown in the README (docs/media/).
SCENARIOS.push({ doc: "settings", theme: "light", device: "desktop", lowLatency: false });
// wave 0.12: the creation dialog (both tabs) at tablet and phone widths, light and dark.
for (const theme of ["light", "dark"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "create", theme, device, lowLatency: false });
// 0.13 ds-zettel: the Inbox, the card dialogs and the card regions at tablet and phone widths, light and dark.
for (const theme of ["light", "dark"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "zettel", theme, device, lowLatency: false });
// wave 0.13 ds-modals: every dialog, prompt and card on the shared modal shell (dev/harness/modals-check.ts), tablet and phone, light and dark.
for (const theme of ["light", "dark"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "modals", theme, device, lowLatency: false });
// 0.15 templates: the notebook template picker, the creation dialog with a template, the manager (dev/harness/templates-check.ts).
for (const theme of ["light", "dark"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "templates", theme, device, lowLatency: false });
// 0.20 planner (#118): the Planner tab of the creation dialog and the generated pages (dev/harness/planner-check.ts), tablet and phone, light and dark.
for (const theme of ["light", "dark"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "planner", theme, device, lowLatency: false });
// 0.15 storage (128): the Storage manager at tablet and phone widths, light and dark (dev/harness/storage-check.ts).
for (const theme of ["light", "dark"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "storage", theme, device, lowLatency: false });
// 0.22 covers (#53): "Change cover…" at tablet and phone widths, light and dark (dev/harness/covers-check.ts, dist/shots/design/covers-*.png).
for (const theme of ["light", "dark"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "covers", theme, device, lowLatency: false });
// 0.17 pdfcopy (#23): the notebook menu entry, the save hook and the three settings rows (dev/harness/pdfcopy-check.ts), tablet and phone, light and dark.
for (const theme of ["light", "dark"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "pdfcopy", theme, device, lowLatency: false });
// 0.16 bulk import (#80): the dialog, its run and the drop at tablet and phone widths, light and dark (dev/harness/bulk-check.ts).
for (const theme of ["light", "dark"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "bulk", theme, device, lowLatency: false });
// 0.17 merge / split / extract (#77): the dialog, the run and the map's selection mode (dev/harness/pagesplit-check.ts).
for (const theme of ["light", "dark"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "xfer", theme, device, lowLatency: false });
// 0.18 linkback (#186): copy to notebook with a link back: the dialog, the run and the map's button (dev/harness/linkback-check.ts).
for (const theme of ["light", "dark"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "linkback", theme, device, lowLatency: false });
// 0.12.1: the whole plugin's onload against the stub: what it registers, the settings tab through both of Obsidian's paths,
// and injected failures (a failing step, failing settings definitions, an unreadable data.json).
// 0.13 ds-notebook: the notebook's editing chrome (toolbar, options, sheets, contextual bar, dial, banner) at tablet and
// phone widths, light and dark; screenshots in dist/shots/design/ (notebook-<state>-<theme>-<device>.png).
for (const theme of ["light", "dark"]) for (const device of ["tablet", "phone", "narrow"]) SCENARIOS.push({ doc: "chrome", theme, device, lowLatency: false });
SCENARIOS.push({ doc: "plugin", theme: "dark", device: "tablet", lowLatency: false });
SCENARIOS.push({ doc: "plugin", theme: "light", device: "desktop", lowLatency: false });
// 0.13 hints: the tip bubble at tablet and phone widths, dark and light (dev/harness/dist/shots/hints-*.png).
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "hints", theme, device, lowLatency: false });
// 0.15 daily: "Today's page" and the link from the daily note (dev/harness/daily-check.ts), tablet and phone, dark and light.
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "daily", theme, device, lowLatency: false });
// 0.14 toolbar: the generative interface (page-type marks, pinned slots, selection bar by content, PDF snap control), tablet and phone, light and dark.
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) for (const doc of ["toolbar", "toolbar-pdf"]) SCENARIOS.push({ doc, theme, device, lowLatency: false });
// 0.19 lookup: the Look up later word dialog and list sheet (dev/harness/lookup-check.ts), tablet and phone, dark and light.
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "lookup", theme, device, lowLatency: false });
// 0.21 bookindex: the back-of-book index dialog (dev/harness/bookindex-check.ts), tablet and phone, dark and light.
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "bookindex", theme, device, lowLatency: false });
// 0.23 formulasheet: the formula sheet dialog (dev/harness/formulasheet-check.ts).
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "formulasheet", theme, device, lowLatency: false });
// 0.14 slides: ink linked to the slide beside it (badges) and the slide strip, tablet and phone, dark and light (dist/shots/slides-*.png).
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "slides", theme, device, lowLatency: false });
// 0.15 pensets: pen sets per subject on the strip, the switcher chip and the manager, tablet and phone, dark and light (dist/shots/pensets-*.png).
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "pensets", theme, device, lowLatency: false });
// 0.16 inbox: files shared from other apps, as Home's card, the rail badge and the full list (dev/harness/inbox-check.ts), tablet and phone, dark and light.
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "inbox", theme, device, lowLatency: false });
// 0.17 task: "Make task" from a selection (dev/harness/task-check.ts), tablet and phone, dark and light.
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "task", theme, device, lowLatency: false });
// 0.18 qr: the "Show QR code" dialog (dev/harness/qr-check.ts), tablet and phone, dark and light.
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "qr", theme, device, lowLatency: false });
// 0.19 templates: the notebook-new card of a note (dev/harness/tplnote-check.ts), tablet and phone, dark and light (dist/shots/tplnote-*.png).
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "tplnote", theme, device, lowLatency: false });
// 0.26 gallery: the notebook-gallery block of a note (dev/harness/gallery-check.ts), tablet and phone, dark and light (dist/shots/gallery-*.png).
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "gallery", theme, device, lowLatency: false });
// 0.20 vdiff: the visual version diff dialog (dev/harness/vdiff-check.ts), tablet and phone, dark and light (dist/shots/vdiff-*.png).
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "vdiff", theme, device, lowLatency: false });
// 0.19 snapshot: the version-history list with the lecture-snapshots filter (dev/harness/snapshot-check.ts).
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "snapshot", theme, device, lowLatency: false });
// 0.18 pdfannot: "Annotate in Notebook" choice dialog (dev/harness/annotate-check.ts), tablet and phone, dark and light.
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "annotate", theme, device, lowLatency: false });
// 0.15 states: a figure with parts and states, moved with the selection handles (dist/shots/states-*.png).
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "states", theme, device, lowLatency: false });
// 0.16 digest: the Highlights digest dialog and the note it writes (dev/harness/digest-check.ts), tablet and phone, dark and light (dist/shots/digest-*.png).
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "digest", theme, device, lowLatency: false });
// 0.22 colormeaning (#101): colours with meaning, the filter and the digest by colour (dev/harness/colours-check.ts), tablet and phone, dark and light (dist/shots/colours-*.png, coloursedit-*.png).
for (const doc of ["colours", "coloursedit"]) for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc, theme, device, lowLatency: false });

// 0.18 mentions: the Mentions sheet and the count badge (dev/harness/mentions-check.ts), tablet and phone, dark and light (dist/shots/mentions-*.png).
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "mentions", theme, device, lowLatency: false });
// 0.22 syncprov (#126): the cloud sign-in dialog (dev/harness/syncprov-check.ts), tablet and phone, dark and light (dist/shots/syncprov-*.png).
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "syncprov", theme, device, lowLatency: false });

/** RGBA pixel reader for the 8-bit, non-interlaced PNGs Chrome produces. */
function decodePng(buf) {
	let pos = 8, width = 0, height = 0, colorType = 6;
	const idat = [];
	while (pos < buf.length) {
		const len = buf.readUInt32BE(pos);
		const type = buf.toString("ascii", pos + 4, pos + 8);
		const data = buf.subarray(pos + 8, pos + 8 + len);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			colorType = data[9];
		} else if (type === "IDAT") idat.push(data);
		pos += 12 + len;
	}
	const bpp = colorType === 6 ? 4 : 3;
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * bpp;
	const px = Buffer.alloc(height * stride);
	for (let y = 0; y < height; y++) {
		const f = raw[y * (stride + 1)];
		for (let x = 0; x < stride; x++) {
			const v = raw[y * (stride + 1) + 1 + x];
			const a = x >= bpp ? px[y * stride + x - bpp] : 0;
			const b = y > 0 ? px[(y - 1) * stride + x] : 0;
			const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
			let p = 0;
			if (f === 1) p = a;
			else if (f === 2) p = b;
			else if (f === 3) p = (a + b) >> 1;
			else if (f === 4) {
				const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
				p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			}
			px[y * stride + x] = (v + p) & 255;
		}
	}
	return {
		width, height,
		at(x, y) {
			const i = Math.min(height - 1, Math.max(0, Math.round(y))) * stride + Math.min(width - 1, Math.max(0, Math.round(x))) * bpp;
			return [px[i], px[i + 1], px[i + 2]];
		},
	};
}

async function main() {
	const chrome = findChrome();
	if (!chrome) {
		console.error("harness:check: no Chrome/Chromium/Edge found. Set CHROME_PATH, or run the manual steps in docs/testing.md (Browser harness).");
		process.exit(2);
	}
	const dist = await buildHarness();
	const shots = join(dist, "shots");
	mkdirSync(shots, { recursive: true });
	const server = serve(dist, 0);
	await new Promise((r) => server.once("listening", r));
	const port = server.address().port;

	const profile = mkdtempSync(join(tmpdir(), "notebook-harness-"));
	const browser = spawn(chrome, [
		"--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run",
		"--no-default-browser-check", "--disable-extensions", "--hide-scrollbars",
		// Chrome refuses to start as root (containers, CI images) unless its sandbox is off.
		...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
		"about:blank",
	], { stdio: "ignore" });
	let failures = 0;
	let total = SCENARIOS.filter((x) => !process.env.HARNESS_DOC || x.doc === process.env.HARNESS_DOC).length;
	try {
		let devtools = null;
		for (let i = 0; i < 100 && !devtools; i++) {
			await sleep(100);
			const f = join(profile, "DevToolsActivePort");
			if (existsSync(f)) devtools = Number(readFileSync(f, "utf8").split("\n")[0]);
		}
		if (!devtools) throw new Error("Chrome did not start");
		const targets = await (await fetch(`http://127.0.0.1:${devtools}/json/list`)).json();
		const page = targets.find((t) => t.type === "page");
		const cdp = new Cdp(page.webSocketDebuggerUrl);
		await cdp.open();
		await cdp.send("Page.enable");
		await cdp.send("Runtime.enable");

		for (const s of SCENARIOS.filter((x) => !process.env.HARNESS_DOC || x.doc === process.env.HARNESS_DOC)) {
			const d = DEVICES[s.device];
			const name = `${s.doc}${s.surface ? `-${s.surface}` : ""}${s.variant ? `-${s.variant}` : ""}-${s.theme}-${s.device}${s.lowLatency ? "-lowlatency" : ""}${s.fault ? `-fault-${s.fault}` : ""}${s.hostile ? "-hostile" : ""}`;
			await cdp.send("Emulation.setDeviceMetricsOverride", { width: d.width, height: d.height, deviceScaleFactor: d.deviceScaleFactor, mobile: d.mobile });
			await cdp.send("Emulation.setTouchEmulationEnabled", d.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
			const url = `http://127.0.0.1:${port}/index.html?doc=${s.doc}&theme=${s.theme}${s.lowLatency ? "&lowLatency=1" : ""}${s.fault ? `&fault=${s.fault}` : ""}${s.surface ? `&surface=${s.surface}` : ""}${s.variant ? `&variant=${s.variant}` : ""}${s.hostile ? "&hostile=1" : ""}`;
			await cdp.send("Page.navigate", { url });
			let report;
			try {
				for (let i = 0; i < 100; i++) {
					if (await cdp.evaluate("typeof window.harness === 'object' && !!window.harness.ready")) break;
					await sleep(100);
				}
				await cdp.evaluate("window.harness.ready.then(() => true)");
				// 0.15 storage: its own check (the list below is one line per document).
				if (s.doc === "storage") report = await cdp.evaluate("window.harness.checkStorage()", 120000);
				else if (s.doc === "bulk") report = await cdp.evaluate("window.harness.checkBulk()", 120000);
				else if (s.doc === "covers") report = await cdp.evaluate("window.harness.checkCovers()", 90000); // 0.22 covers
				else if (s.doc === "xfer") report = await cdp.evaluate("window.harness.checkXfer()", 120000);
				else if (s.doc === "linkback") report = await cdp.evaluate("window.harness.checkLinkback()", 120000);
				else if (s.doc === "slideback") report = await cdp.evaluate("window.harness.checkSlideback()", 60000);
				else if (s.doc === "pagerefs") report = await cdp.evaluate("window.harness.checkPagerefs()", 60000);
				else if (s.doc === "lecthead") report = await cdp.evaluate("window.harness.checkLecthead()", 90000);
				else if (s.doc === "dimcheck") report = await cdp.evaluate("window.harness.checkDimcheck()", 90000); // 0.23 dimcheck
				else if (s.doc === "palettectx") report = await cdp.evaluate("window.harness.checkPalettectx()", 90000); // 0.24 palettectx
				else if (s.doc === "termorder") report = await cdp.evaluate("window.harness.checkTermOrder()", 90000);
				else if (s.doc === "hookclean") report = await cdp.evaluate("window.harness.checkHookclean()", 90000); // 0.23 hookclean
				else if (s.doc === "shapefill") report = await cdp.evaluate("window.harness.checkShapefill()", 90000); // 0.24 shapefill
				else if (s.doc === "areahl") report = await cdp.evaluate("window.harness.checkAreahl()", 90000); // 0.25 areahl
				else if (s.doc === "opacity") report = await cdp.evaluate("window.harness.checkOpacity()", 90000); // 0.26 opacity
				else if (s.doc === "taper") report = await cdp.evaluate("window.harness.checkTaper()", 90000); // 0.27 taper
				else if (s.doc === "ctxpalette" || s.doc === "ctxpalettew") report = await cdp.evaluate("window.harness.checkCtxpalette()", 90000); // 0.26 ctxpalette
				else if (s.doc === "papersuggest") report = await cdp.evaluate("window.harness.checkPapersuggest()", 90000); // 0.25 papersuggest
				else if (s.doc === "strokejoin") report = await cdp.evaluate("window.harness.checkStrokejoin()", 90000); // 0.24 strokejoin
				else if (s.doc === "profiles") report = await cdp.evaluate("window.harness.checkProfiles()", 90000); // 0.25 profiles
				else if (s.doc === "pillstack") report = await cdp.evaluate("window.harness.checkPillstack()", 90000); // 0.22 review fix: all the floating pills at once
				else if (s.doc === "welcomeback") report = await cdp.evaluate("window.harness.checkWelcomeback()", 90000); // 0.23 welcomeback
				else if (s.doc === "plannertasks") report = await cdp.evaluate("window.harness.checkPlannertasks()", 90000); // 0.27 plannertasks
				else if (s.doc === "iconhelp") report = await cdp.evaluate("window.harness.checkIconhelp()", 90000); // 0.24 iconhelp
				else if (s.doc === "toolfade") report = await cdp.evaluate("window.harness.checkToolfade()", 120000); // 0.25 toolfade
				else if (s.doc === "inputlayout") report = await cdp.evaluate("window.harness.checkInputlayout()", 90000); // 0.27 inputlayout
				else if (s.doc === "zoomwidth") report = await cdp.evaluate("window.harness.checkZoomwidth()", 120000); // 0.26 zoomwidth
				else if (s.doc === "semzoom") report = await cdp.evaluate("window.harness.checkSemzoom()", 120000); // 0.27 semzoom
				else if (s.doc === "navadapt") report = await cdp.evaluate("window.harness.checkNavadapt()", 90000); // 0.24 navadapt
				else if (s.doc === "smooth") report = await cdp.evaluate("window.harness.checkSmooth()", 90000); // 0.26 smooth
				else if (s.doc === "baseline") report = await cdp.evaluate("window.harness.checkBaseline()", 90000); // 0.25 baseline
				else if (s.doc === "markedview") report = await cdp.evaluate("window.harness.checkMarkedview()", 90000); // 0.25 markedview
				else if (s.doc === "macros") report = await cdp.evaluate("window.harness.checkMacros()", 120000); // 0.27 macros
				else if (s.doc === "linehandle") report = await cdp.evaluate("window.harness.checkLinehandle()", 90000); // 0.28 linehandle
				else if (s.doc === "tidy") report = await cdp.evaluate("window.harness.checkTidy()", 90000); // 0.26 tidy
				else if (s.doc === "spread") report = await cdp.evaluate("window.harness.checkSpread()", 120000); // 0.27 spread
				else if (s.doc === "pdfcopy") report = await cdp.evaluate("window.harness.checkPdfcopy()", 90000);
				else if (s.doc === "inbox") report = await cdp.evaluate("window.harness.checkInbox()", 60000);

				// 0.16 pdftext: its own check.
				else if (s.doc === "pdftext") report = await cdp.evaluate("window.harness.checkPdftext()", 90000);
				// 0.17 snap: its own check.
				else if (s.doc === "snap") report = await cdp.evaluate("window.harness.checkSnap()", 60000);
				// 0.20 headings: its own check.
				else if (s.doc === "headings") report = await cdp.evaluate("window.harness.checkHeadings()", 60000);
				// 0.18 a4split: its own check.
				else if (s.doc === "a4split") report = await cdp.evaluate("window.harness.checkA4split()", 60000);
				else if (s.doc === "cleanexport") report = await cdp.evaluate("window.harness.checkCleanExport()", 60000);
				else if (s.doc === "htmlexport") report = await cdp.evaluate("window.harness.checkHtmlExport()", 60000);
				else if (s.doc === "exportarea") report = await cdp.evaluate("window.harness.checkExportArea()", 60000);
				else if (s.doc === "clipimage") report = await cdp.evaluate("window.harness.checkClipImage()", 60000); // 0.25 clipimage
				else if (s.doc === "tagsuggest") report = await cdp.evaluate("window.harness.checkTagSuggest()", 60000); // 0.24 tagsuggest
				else if (s.doc === "pdfsuggest") report = await cdp.evaluate("window.harness.checkPdfSuggest()", 60000); // 0.27 pdfsuggest
				else if (s.doc === "handin") report = await cdp.evaluate("window.harness.checkHandIn()", 60000); // 0.24 handin
				else if (s.doc === "redact") report = await cdp.evaluate("window.harness.checkRedact()", 90000); // 0.26 redact
				else if (s.doc === "ghostlines") report = await cdp.evaluate("window.harness.checkGhostlines()", 60000);
				else if (s.doc === "pagetime") report = await cdp.evaluate("window.harness.checkPagetime()", 60000);
				else if (s.doc === "pens") report = await cdp.evaluate("window.harness.checkPens()", 90000);
				else if (s.doc === "savedviews") report = await cdp.evaluate("window.harness.checkSavedviews()", 90000); // 0.23 savedviews
				else if (s.doc === "workspaces") report = await cdp.evaluate("window.harness.checkWorkspaces()", 90000); // 0.27 workspaces
				else if (s.doc === "histpanel") report = await cdp.evaluate("window.harness.checkHistpanel()", 90000); // 0.25 histpanel
				else if (s.doc === "related") report = await cdp.evaluate("window.harness.checkRelated()", 60000); // 0.26 related
				else if (s.doc === "share") report = await cdp.evaluate("window.harness.checkShare()", 180000); // 0.20 share
				// 0.18 mentions: its own check.
				else if (s.doc === "mentions") report = await cdp.evaluate("window.harness.checkMentions()", 60000);
				else if (s.doc === "symbols") report = await cdp.evaluate("window.harness.checkSymbols()", 60000); // 0.21 symbols
				else if (s.doc === "synccore") report = await cdp.evaluate("window.harness.checkSynccore()", 60000); // 0.22 synccore
				else if (s.doc === "syncprov") report = await cdp.evaluate("window.harness.checkSyncprov()", 60000); // 0.22 syncprov
				else
				report = await cdp.evaluate(s.doc === "dropfiles" ? "window.harness.checkDropFiles()" : s.doc === "states" ? "window.harness.checkStates()" : s.doc === "hints" ? "window.harness.checkHints()" : s.doc === "slides" ? "window.harness.checkSlides()" : s.doc === "zettel" ? "window.harness.checkZettel()" : s.doc === "pdf" ? "window.harness.checkReading()" : s.doc === "practice" ? "window.harness.checkPractice()" : s.doc === "lecture" ? "window.harness.checkLecture()" : s.doc === "outline" ? "window.harness.checkOutline()" : s.doc === "smartadd" ? "window.harness.checkSmartAdd()" : s.doc === "header" ? "window.harness.checkHeader()" : s.doc === "pensets" ? "window.harness.checkPenSets()" : s.doc === "task" ? "window.harness.checkTask()" : s.doc === "lookup" ? "window.harness.checkLookUp()" : s.doc === "formulasheet" ? "window.harness.checkFormulaSheet()" : s.doc === "bookindex" ? "window.harness.checkBookIndex()" :s.doc === "annotate" ? "window.harness.checkAnnotate()" : s.doc === "tplnote" ? "window.harness.checkTplNote()" : s.doc === "gallery" ? "window.harness.checkGallery()" :s.doc === "qr" ? "window.harness.checkQr()" : s.doc === "snapshot" ? "window.harness.checkSnapshot()" : s.doc === "vdiff" ? "window.harness.checkVdiff()" :s.doc === "backups" ? "window.harness.checkBackups()" : s.doc === "daily" ? "window.harness.checkDaily()" : s.doc === "nbmap" ? "window.harness.checkNbmap()" : s.doc === "figures" ? "window.harness.checkFigures()" :s.doc === "movesel" ? "window.harness.checkMovesel()" : s.doc === "present" ? "window.harness.checkPresent()" : s.doc === "digest" ? "window.harness.checkDigest()" : s.doc === "colours" ? "window.harness.checkColours()" : s.doc === "coloursedit" ? "window.harness.checkColours(true)" : s.doc === "lock" ? "window.harness.checkLock()" : s.doc === "signstamp" ? "window.harness.checkSignstamp()" : s.doc === "refwindow" ? "window.harness.checkRefwindow()" : s.doc === "quicktabs" ? "window.harness.checkQuicktabs()" : s.doc === "bookmarks" ? "window.harness.checkBookmarks()" : s.doc === "sticky" ? "window.harness.checkSticky()" : s.doc === "comments" ? "window.harness.checkComments()" : s.doc === "checklists" ? "window.harness.checkChecklists()" : s.doc === "axes" ? "window.harness.checkAxes()" : s.doc === "chembal" ? "window.harness.checkChembal()" : s.doc === "groups" ? "window.harness.checkGroups()" : s.doc === "minimap" ? "window.harness.checkMinimap()" : s.doc === "readonly" ? "window.harness.checkReadOnly()" : s.doc === "excerpt" ? "window.harness.checkExcerpt()" : s.doc === "settings" ? "window.harness.checkSettings()" : s.doc === "chrome" ? "window.harness.checkChrome()" : s.doc === "toolbar" || s.doc === "toolbar-pdf" ? "window.harness.checkAdaptiveToolbar()" : s.doc === "plugin" ? "window.harness.checkPlugin()" : s.doc === "create" ? "window.harness.checkCreate('notebook')" : s.doc === "modals" ? "window.harness.checkModals()" : s.doc === "templates" ? "window.harness.checkTemplates()" : s.doc === "planner" ? "window.harness.checkPlanner()" : s.doc === "library" ? "window.harness.checkLibrary()" : s.doc === "empty" ? (s.hostile ? "window.harness.checkHostile()" : "window.harness.checkEmpty()") : "window.harness.check()", 60000);
			} catch (e) {
				report = { ok: false, results: [], errors: [String(e.message ?? e)] };
			}
			// 0.14 layout: the orientation / size classes of the view (layout-check.ts).
			if ((s.doc === "new" || s.doc === "library") && s.device !== "reference") {
				try {
					const lc = await cdp.evaluate("window.harness.checkLayout()");
					report.results.push(...lc.results);
				} catch (e) {
					report.results.push({ name: "layout check", ok: false, detail: e.message });
				}
			}
			const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
			const png = Buffer.from(shot.data, "base64");
			writeFileSync(join(shots, `${name}.png`), png);
			const problems = report.results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`);
			problems.push(...report.errors.map((e) => `console error: ${e.split("\n")[0]}`));
			if (report.points) {
				const img = decodePng(png);
				const k = img.width / d.width;
				const [px, py] = report.points.paper;
				const paper = img.at(px * k, py * k);
				if (!(paper[0] > 200 && paper[1] > 200 && paper[2] > 200)) problems.push(`composited paper is not white at (${Math.round(px)}, ${Math.round(py)}): rgb(${paper})`);
				const [ix, iy] = report.points.ink;
				let dark = false;
				for (let dy = -32; dy <= 32 && !dark; dy++) {
					const c = img.at(ix * k, (iy + dy) * k);
					if (c[0] < 100 && c[1] < 100 && c[2] < 100) dark = true;
				}
				if (!dark) problems.push(`composited ink missing at (${Math.round(ix)}, ${Math.round(iy)})`);
			}
			// 0.14 lecture: review screenshots of the banner, the chip with the lecture page and the manual state.
			if (s.doc === "lecture") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of ["ask", "on", "plain"]) {
					try {
						await cdp.evaluate(`window.harness.lectureShot('${state}').then(() => true)`);
						writeFileSync(join(designDir, `lecture-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`lecture ${state} screenshot: ${e.message}`);
					}
				}
			}
			// 0.16 pdftext: a selection with its bubble, the PDF outline merged into the outline and as its own section.
			if (s.doc === "pdftext") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of ["select", "outline", "section"]) {
					try {
						await cdp.evaluate(`window.harness.pdftextShot('${state}').then(() => true)`, 30000);
						writeFileSync(join(designDir, `pdftext-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`pdftext ${state} screenshot: ${e.message}`);
					}
				}
			}
			// 0.15 storage: a screenshot of each state of the Storage manager.
			if (s.doc === "storage") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of await cdp.evaluate("window.harness.storageStates")) {
					try {
						await cdp.evaluate(`window.harness.storageShot('${state}').then(() => true)`, 60000);
						writeFileSync(join(designDir, `storage-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`storage ${state} screenshot: ${e.message}`);
					}
				}
				await cdp.evaluate("window.harness.closeStorage()");
			}
			// 0.22 covers: a screenshot of each source of the cover dialog.
			if (s.doc === "covers") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of await cdp.evaluate("window.harness.coverStates")) {
					try {
						await cdp.evaluate(`window.harness.coverShot('${state}').then(() => true)`, 60000);
						writeFileSync(join(designDir, `covers-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`covers ${state} screenshot: ${e.message}`);
					}
				}
				await cdp.evaluate("window.harness.closeCovers()");
			}
			// 0.20 dropfiles: a screenshot of each state of the drop (frame, blocked frame, PDF choice, pictures placed).
			if (s.doc === "dropfiles") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of await cdp.evaluate("window.harness.dropStates")) {
					try {
						await cdp.evaluate(`window.harness.dropShot('${state}').then(() => true)`, 60000);
						writeFileSync(join(designDir, `dropfiles-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`dropfiles ${state} screenshot: ${e.message}`);
					}
					await cdp.evaluate("window.harness.dropRelease()");
				}
			}
			// 0.24 handin: a screenshot of the dialog (all pages chosen, with the pre-flight) and of the cover page.
			if (s.doc === "handin") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of await cdp.evaluate("window.harness.handinStates")) {
					try {
						await cdp.evaluate(`window.harness.handinShot('${state}').then(() => true)`, 60000);
						writeFileSync(join(designDir, `handin-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`handin ${state} screenshot: ${e.message}`);
					}
					await cdp.evaluate("window.harness.closeHandIn()");
				}
			}
			// 0.26 redact: a screenshot of the export dialog's row, of the editor over a plain page and over a scanned one.
			if (s.doc === "redact") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of await cdp.evaluate("window.harness.redactStates")) {
					try {
						await cdp.evaluate(`window.harness.redactShot('${state}').then(() => true)`, 60000);
						writeFileSync(join(designDir, `redact-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`redact ${state} screenshot: ${e.message}`);
					}
					await cdp.evaluate("window.harness.closeRedact()");
				}
			}
			// 0.21 signstamp: a screenshot of each state (dialog, pad, dialog with the signature, signature placed).
			if (s.doc === "signstamp") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of await cdp.evaluate("window.harness.signstampStates")) {
					try {
						await cdp.evaluate(`window.harness.signstampShot('${state}').then(() => true)`, 60000);
						writeFileSync(join(designDir, `signstamp-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`signstamp ${state} screenshot: ${e.message}`);
					}
					await cdp.evaluate("document.querySelectorAll('.modal-container .modal-close-button, .nb-sign .nb-modal-close').forEach((b) => b.click())");
				}
			}
			// 0.16 bulk import: a screenshot of each state of the dialog and of the drop frame.
			if (s.doc === "bulk") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of await cdp.evaluate("window.harness.bulkStates")) {
					try {
						await cdp.evaluate(`window.harness.bulkShot('${state}').then(() => true)`, 60000);
						writeFileSync(join(designDir, `bulk-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`bulk ${state} screenshot: ${e.message}`);
					}
					await cdp.evaluate("window.harness.closeBulk()");
				}
			}
			// 0.17 merge / split / extract: a screenshot of each body of the dialog and of the map's selection mode.
			if (s.doc === "xfer") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of await cdp.evaluate("window.harness.xferStates")) {
					try {
						await cdp.evaluate(`window.harness.xferShot('${state}').then(() => true)`, 60000);
						writeFileSync(join(designDir, `xfer-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`xfer ${state} screenshot: ${e.message}`);
					}
					await cdp.evaluate("window.harness.closeXfer()");
				}
			}
			// 0.18 linkback: a screenshot of the dialog and of the map's selection bar.
			if (s.doc === "linkback") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of await cdp.evaluate("window.harness.linkbackStates")) {
					try {
						await cdp.evaluate(`window.harness.linkbackShot('${state}').then(() => true)`, 60000);
						writeFileSync(join(designDir, `linkback-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`linkback ${state} screenshot: ${e.message}`);
					}
					await cdp.evaluate("window.harness.closeLinkback()");
				}
			}
			// 0.26 smooth: screenshots of shaky handwriting (selected), smoothed and straightened.
			if (s.doc === "smooth") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of ["before", "smooth", "straighten"]) {
					try {
						await cdp.evaluate(`window.harness.smoothShot('${state}').then(() => true)`, 60000);
						writeFileSync(join(designDir, `smooth-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`smooth ${state} screenshot: ${e.message}`);
					}
				}
			}
			// 0.25 baseline: screenshots of crooked words (selected), aligned, and aligned on ruled paper.
			if (s.doc === "baseline") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of ["before", "after", "ruled"]) {
					try {
						await cdp.evaluate(`window.harness.baselineShot('${state}').then(() => true)`, 60000);
						writeFileSync(join(designDir, `baseline-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`baseline ${state} screenshot: ${e.message}`);
					}
				}
			}
			// 0.27 spread: the pair with writing on both pages, zoomed on the right page with the minimap, and the page sheet with its toggle.
			if (s.doc === "spread") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of ["pair", "zoom", "sheet"]) {
					try {
						await cdp.evaluate(`window.harness.spreadShot('${state}').then(() => true)`, 90000);
						writeFileSync(join(designDir, `spread-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`spread ${state} screenshot: ${e.message}`);
					}
				}
			}
			// 0.27 macros: screenshots of the toolbar with its macro buttons, the manager, the editor and the sheet's Macros section.
			if (s.doc === "macros") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of ["toolbar", "list", "editor", "sheet"]) {
					try {
						await cdp.evaluate(`window.harness.macrosShot('${state}').then(() => true)`, 60000);
						writeFileSync(join(designDir, `macros-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`macros ${state} screenshot: ${e.message}`);
					}
				}
			}
			// 0.28 linehandle: screenshots of the handles at rest, a drag in progress, and the page after the drop.
			if (s.doc === "linehandle") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of ["rest", "drag", "after"]) {
					try {
						await cdp.evaluate(`window.harness.linehandleShot('${state}').then(() => true)`, 60000);
						writeFileSync(join(designDir, `linehandle-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`linehandle ${state} screenshot: ${e.message}`);
					}
				}
			}
			// 0.26 tidy: screenshots of the crooked page, the sheet open over it, and the page tidied.
			if (s.doc === "tidy") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of ["before", "sheet", "after"]) {
					try {
						await cdp.evaluate(`window.harness.tidyShot('${state}').then(() => true)`, 60000);
						writeFileSync(join(designDir, `tidy-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`tidy ${state} screenshot: ${e.message}`);
					}
				}
			}
			// 0.25 markedview: a screenshot of the marked-only list.
			if (s.doc === "markedview") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				try {
					await cdp.evaluate("window.harness.markedviewShot().then(() => true)", 60000);
					writeFileSync(join(designDir, `markedview-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
				} catch (e) {
					problems.push(`markedview screenshot: ${e.message}`);
				}
			}
			// 0.24 navadapt: a screenshot of the list.
			if (s.doc === "navadapt") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				try {
					await cdp.evaluate("window.harness.navadaptShot().then(() => true)", 60000);
					writeFileSync(join(designDir, `navadapt-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
				} catch (e) {
					problems.push(`navadapt screenshot: ${e.message}`);
				}
			}
			// 0.27 plannertasks: the chip, the open list and the weekly page.
			if (s.doc === "plannertasks") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of ["chip", "panel", "week"]) {
					try {
						await cdp.evaluate(`window.harness.plannertasksShot('${state}').then(() => true)`, 60000);
						writeFileSync(join(designDir, `plannertasks-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`plannertasks screenshot ${state}: ${e.message}`);
					}
				}
			}
			// 0.23 welcomeback: a screenshot of the card.
			if (s.doc === "welcomeback") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				try {
					await cdp.evaluate("window.harness.welcomebackShot().then(() => true)", 60000);
					writeFileSync(join(designDir, `welcomeback-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
				} catch (e) {
					problems.push(`welcomeback screenshot: ${e.message}`);
				}
			}
			// 0.27 semzoom: the overview far out, halfway through the fade and further down the notebook.
			if (s.doc === "semzoom") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of ["overview", "fade", "later"]) {
					try {
						await cdp.evaluate(`window.harness.semzoomShot('${state}').then(() => true)`, 60000);
						writeFileSync(join(designDir, `semzoom-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`semzoom ${state} screenshot: ${e.message}`);
					}
				}
			}
			// 0.26 zoomwidth: the pen options at two zooms, option off and on.
			if (s.doc === "zoomwidth") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const [zoom, on] of [[1, false], [4, false], [1, true], [4, true]]) {
					try {
						await cdp.evaluate(`window.harness.zoomwidthShot(${zoom}, ${on}).then(() => true)`, 60000);
						writeFileSync(join(designDir, `zoomwidth-${on ? "on" : "off"}-${zoom}x-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`zoomwidth ${zoom}x ${on} screenshot: ${e.message}`);
					}
				}
			}
			// 0.27 inputlayout: screenshots of the pen, finger and mouse layouts.
			if (s.doc === "inputlayout") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const kind of ["pen", "touch", "mouse"]) {
					try {
						await cdp.evaluate(`window.harness.inputlayoutShot('${kind}').then(() => true)`, 60000);
						writeFileSync(join(designDir, `inputlayout-${kind}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`inputlayout ${kind} screenshot: ${e.message}`);
					}
				}
			}
			// 0.25 toolfade: screenshots of the faded and the restored bars.
			if (s.doc === "toolfade") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of ["faded", "restored"]) {
					try {
						await cdp.evaluate(`window.harness.toolfadeShot('${state}').then(() => true)`, 60000);
						writeFileSync(join(designDir, `toolfade-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`toolfade ${state} screenshot: ${e.message}`);
					}
				}
			}
			// 0.24 iconhelp: a screenshot of the bubble on the eraser.
			if (s.doc === "iconhelp") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				try {
					await cdp.evaluate("window.harness.iconhelpShot().then(() => true)", 60000);
					writeFileSync(join(designDir, `iconhelp-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
				} catch (e) {
					problems.push(`iconhelp screenshot: ${e.message}`);
				}
			}
			// 0.21 slideback: a screenshot of the pill while scrolled away from the written page.
			if (s.doc === "slideback") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				try {
					await cdp.evaluate("window.harness.slidebackShot('away').then(() => true)", 60000);
					writeFileSync(join(designDir, `slideback-away-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
				} catch (e) {
					problems.push(`slideback screenshot: ${e.message}`);
				}
			}
			// 0.22 pagerefs: screenshots of the chip and of its open list.
			if (s.doc === "pagerefs") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of ["chip", "list"]) {
					try {
						await cdp.evaluate(`window.harness.pagerefsShot('${state}').then(() => true)`, 60000);
						writeFileSync(join(designDir, `pagerefs-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`pagerefs screenshot ${state}: ${e.message}`);
					}
				}
			}
			// 0.24 palettectx: the sheet with the eraser in hand.
			if (s.doc === "palettectx") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				try {
					await cdp.evaluate("window.harness.palettectxShot().then(() => true)", 60000);
					writeFileSync(join(designDir, `palettectx-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
				} catch (e) {
					problems.push(`palettectx screenshot: ${e.message}`);
				}
			}
			// 0.23 dimcheck: the units hint under the equation preview, three formulas.
			if (s.doc === "dimcheck") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of ["bad", "good", "many"]) {
					try {
						await cdp.evaluate(`window.harness.dimcheckShot('${state}').then(() => true)`, 60000);
						writeFileSync(join(designDir, `dimcheck-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`dimcheck ${state} screenshot: ${e.message}`);
					}
				}
			}
			// 0.22 lecthead: the chip, and the header written on a new page.
			if (s.doc === "lecthead") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of ["chip", "header"]) {
					try {
						await cdp.evaluate(`window.harness.lectheadShot('${state}').then(() => true)`, 60000);
						writeFileSync(join(designDir, `lecthead-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`lecthead ${state} screenshot: ${e.message}`);
					}
				}
			}
			// 0.13 ds-zettel: review screenshots of each Zettelkasten surface.
			if (s.doc === "zettel") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of ["inbox", "open", "empty", "caught-up", "scanning", "card", "card-luhmann", "list", "confirm", "overlay"]) {
					try {
						await cdp.evaluate(`window.harness.zettelState('${state}').then(() => true)`);
						writeFileSync(join(designDir, `zettel-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`zettel ${state} screenshot: ${e.message}`);
					}
				}
			}
			// 0.26 related: the nothing-related and no-note states of the panel.
			if (s.doc === "related") {
				for (const state of ["empty", "none"]) {
					try {
						await cdp.evaluate(`window.harness.relatedShot('${state}').then(() => true)`);
						writeFileSync(join(shots, `related-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`related ${state} screenshot: ${e.message}`);
					}
				}
			}
			// 0.27 pdfsuggest: the chips filtered by what is typed.
			if (s.doc === "pdfsuggest") {
				try {
					await cdp.evaluate("window.harness.pdfsuggestShot('typed').then(() => true)");
					writeFileSync(join(shots, `pdfsuggest-typed-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
				} catch (e) {
					problems.push(`pdfsuggest typed screenshot: ${e.message}`);
				}
			}
			// 0.16 inbox: the full list over Home (Home itself is the screenshot above).
			if (s.doc === "inbox") {
				try {
					await cdp.evaluate("window.harness.inboxShot('list').then(() => true)");
					writeFileSync(join(shots, `${name}-list.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					await cdp.evaluate("window.harness.inboxShot('close').then(() => true)");
				} catch (e) {
					problems.push(`inbox list screenshot: ${e.message}`);
				}
			}
			// 0.15 pensets: the pen options with the switcher chip, then the manager.
			if (s.doc === "pensets") {
				for (const state of ["options", "manager"]) {
					try {
						await cdp.evaluate(`window.harness.pensetsShot('${state}').then(() => true)`);
						writeFileSync(join(shots, `${name}-${state}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`pensets ${state} screenshot: ${e.message}`);
					}
				}
				await cdp.evaluate("window.harness.pensetsShot('close').then(() => true)");
			}
			// 0.14 slides: the notes with their badges, after the strip (the screenshot above).
			if (s.doc === "slides") {
				try {
					await cdp.evaluate("window.harness.slidesState('badges').then(() => true)");
					writeFileSync(join(shots, `${name}-badges.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
				} catch (e) {
					problems.push(`slides badges screenshot: ${e.message}`);
				}
			}
			// wave 0.12: the creation dialog's Folder tab (the Notebook tab is the screenshot above).
			if (s.doc === "create") {
				try {
					await cdp.evaluate("window.harness.createShot('folder').then(() => true)");
					writeFileSync(join(shots, `${name}-folder.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
				} catch (e) {
					problems.push(`folder tab screenshot: ${e.message}`);
				}
			}
			// 0.13 ds-notebook: one screenshot per state of the chrome, for review.
			if (s.doc === "chrome") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of ["toolbar", "options-pen", "options-eraser", "sheet", "page-sheet", "selection", "radial-main", "radial-color", "heavy"]) {
					try {
						await cdp.evaluate(`window.harness.chromeShot('${state}').then(() => true)`);
						writeFileSync(join(designDir, `notebook-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`${state} screenshot: ${e.message}`);
					}
				}
				await cdp.evaluate("window.harness.closeAll().then(() => true)");
			}
			// 0.14 toolbar: one screenshot per state of the adaptive toolbar (grid page, a pinned slot, an ink selection).
			if (s.doc === "toolbar") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of ["page", "pinned", "selection"]) {
					try {
						await cdp.evaluate(`window.harness.adaptiveToolbarShot('${state}').then(() => true)`);
						writeFileSync(join(designDir, `toolbar-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`${state} screenshot: ${e.message}`);
					}
				}
				await cdp.evaluate("window.harness.closeAll().then(() => true)");
			}
			// wave 0.13 ds-modals: a screenshot of each dialog, prompt and card, in dev/harness/dist/shots/design/.
			if (s.doc === "modals") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				try {
					const names = await cdp.evaluate("window.harness.modalNames");
					for (const modal of names) {
						await cdp.evaluate(`window.harness.modalShot('${modal}').then(() => true)`);
						writeFileSync(join(designDir, `modals-${modal}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					}
					await cdp.evaluate("window.harness.closeModal()");
				} catch (e) {
					problems.push(`modal screenshots: ${e.message}`);
				}
			}
			// 0.15 templates: the picker, the creation dialog with a template chosen and the manager of the settings tab.
			if (s.doc === "templates") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of await cdp.evaluate("window.harness.templateStates")) {
					try {
						await cdp.evaluate(`window.harness.templatesShot('${state}').then(() => true)`);
						writeFileSync(join(designDir, `templates-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`templates ${state} screenshot: ${e.message}`);
					}
				}
				await cdp.evaluate("window.harness.closeTemplates()");
			}
			// 0.20 planner: the dialog's Planner tab with the large-notebook warning, and the generated pages.
			if (s.doc === "planner") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				for (const state of await cdp.evaluate("window.harness.plannerStates")) {
					try {
						await cdp.evaluate(`window.harness.plannerShot('${state}').then(() => true)`);
						writeFileSync(join(designDir, `planner-${state}-${s.theme}-${s.device}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`planner ${state} screenshot: ${e.message}`);
					}
				}
				await cdp.evaluate("window.harness.closePlanner()");
			}
			// 0.12: review screenshots of Home and the library, then their controls (bell, rail, quick actions, search, star, list).
			if (s.doc === "library") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				const base = `${s.surface}${s.variant ? `-${s.variant}` : ""}-${s.theme}-${s.device}`;
				writeFileSync(join(designDir, `${base}.png`), png);
				// 0.13 home2: Home is taller than the screen: a second shot of the whole page (the viewport grown to its height).
				if (s.surface === "home") {
					try {
						const full = await cdp.evaluate("(() => { const el = document.querySelector('.nb-scroll'); return el ? Math.ceil(el.scrollHeight + el.getBoundingClientRect().top) : 0; })()");
						if (full > d.height) {
							await cdp.send("Emulation.setDeviceMetricsOverride", { width: d.width, height: Math.min(5000, full), deviceScaleFactor: d.deviceScaleFactor, mobile: d.mobile });
							await sleep(500);
							writeFileSync(join(designDir, `${base}-full.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
							await cdp.send("Emulation.setDeviceMetricsOverride", { width: d.width, height: d.height, deviceScaleFactor: d.deviceScaleFactor, mobile: d.mobile });
							await sleep(300);
						}
					} catch (e) {
						problems.push(`full-page screenshot: ${e.message}`);
					}
				}
				const shotAs = async (file) => writeFileSync(join(designDir, `${base}-${file}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
				try {
					if (s.theme === "dark") {
						for (const state of ["bell", "search", "list"]) {
							await cdp.evaluate(`window.harness.libraryState('${state}')`);
							await shotAs(state);
							await cdp.evaluate("window.harness.libraryState('reset')");
						}
					}
					// 0.13 home2: the revised Home's structure and controls, and review shots of its pinned and 14-day states.
					if (s.surface === "home") {
						const h2 = await cdp.evaluate("window.harness.checkHome2()", 60000);
						problems.push(...h2.results.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`));
						problems.push(...h2.errors.map((e) => `console error: ${e.split("\n")[0]}`));
						if (!s.variant && s.theme === "dark") {
							for (const state of ["pinned", "range14"]) {
								await cdp.evaluate(`window.harness.home2State('${state}')`);
								await shotAs(state);
								await cdp.evaluate("window.harness.home2State('reset')");
							}
						}
					}
					// 0.14 sections: Now / To complete / Changed on another device, and a review shot of the seeded state.
					const sec = await cdp.evaluate("window.harness.checkSections()", 60000);
					problems.push(...sec.results.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`));
					if (!s.variant) {
						await cdp.evaluate("window.harness.sectionsState('on')");
						await shotAs("sections");
						await cdp.evaluate("window.harness.sectionsState('reset')");
					}
					// 0.15 views: the Board and the Calendar, and review shots of each (and of the Board's columns editor).
					if (s.surface === "library" && !s.variant) {
						const vw = await cdp.evaluate("window.harness.checkViews()", 90000);
						problems.push(...vw.results.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`));
						problems.push(...vw.errors.map((e) => `console error: ${e.split("\n")[0]}`));
						for (const state of ["board", "calendar", "board-editor"]) {
							await cdp.evaluate(`window.harness.viewsState('${state}')`);
							await shotAs(`views-${state}`);
							await cdp.evaluate("window.harness.viewsState('reset')");
						}
					}
					// 0.17 collections: saved collections in the rail, and review shots of the list and of the editor.
					if (s.surface === "library" && !s.variant) {
						const co = await cdp.evaluate("window.harness.checkCollections()", 90000);
						problems.push(...co.results.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`));
						problems.push(...co.errors.map((e) => `console error: ${e.split("\n")[0]}`));
						for (const state of ["list", "editor"]) {
							await cdp.evaluate(`window.harness.collectionsState('${state}')`);
							await shotAs(`collections-${state}`);
							await cdp.evaluate("window.harness.collectionsState('reset')");
						}
					}
					const r = await cdp.evaluate("window.harness.interactLibrary()", 60000);
					problems.push(...r.results.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`));
				} catch (e) {
					problems.push(`library interactions: ${e.message}`);
				}
			}
			// 0.12.2: review screenshots of the empty vault, and of the creation dialog its empty state opens.
			if (s.doc === "empty" && s.hostile) {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				writeFileSync(join(designDir, `hostile-${s.surface}-${s.theme}-${s.device}.png`), png);
				for (const tab of ["notebook", "folder"]) {
					try {
						if (!(await cdp.evaluate(`window.harness.hostileDialog('${tab}')`))) problems.push(`hostile: the creation dialog's ${tab} tab did not open`);
						writeFileSync(join(designDir, `hostile-${s.surface}-${s.theme}-${s.device}-dialog-${tab}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					} catch (e) {
						problems.push(`hostile dialog screenshot: ${e.message}`);
					}
				}
			}
			if (s.doc === "empty" && !s.hostile) {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				writeFileSync(join(designDir, `empty-${s.surface}-${s.theme}-${s.device}.png`), png);
				try {
					if (!(await cdp.evaluate("window.harness.emptyDialogShot()"))) problems.push("the empty state's Create a notebook did not open the dialog");
					writeFileSync(join(designDir, `empty-${s.surface}-${s.theme}-${s.device}-dialog.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
				} catch (e) {
					problems.push(`empty dialog screenshot: ${e.message}`);
				}
			}
			// The toolbar with the eraser options and the "more" menu open (narrow phone and tablet, light theme).
			if (!s.fault && s.doc === "new" && s.theme === "light" && (s.device === "narrow" || s.device === "tablet")) {
				try {
					await cdp.evaluate("window.harness.openOptions('eraser').then(() => true)");
					writeFileSync(join(shots, `${name}-eraser-options.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
					await cdp.evaluate("window.harness.openMore().then(() => true)");
					writeFileSync(join(shots, `${name}-more.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
				} catch (e) {
					problems.push(`popover screenshots: ${e.message}`);
				}
			}
			// ui redesign: the main states of the interface, for review (UI_SHOTS, default dist/shots/ui).
			const uiDevices = ["narrow", "tablet", "tabletLandscape", "desktop"];
			if (!s.fault && !s.lowLatency && uiDevices.includes(s.device) && (s.doc === "new" || s.doc === "pdf")) {
				const uiDir = process.env.UI_SHOTS ?? join(shots, "ui");
				mkdirSync(uiDir, { recursive: true });
				const shotAs = async (file) => writeFileSync(join(uiDir, `${s.device}-${s.theme}-${file}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
				try {
					await cdp.evaluate("window.harness.closeAll().then(() => true)");
					if (s.doc === "pdf") {
						await shotAs("pdf-context");
						await cdp.evaluate("window.harness.openMore().then(() => true)");
						await shotAs("pdf-sheet");
					} else {
						await shotAs("toolbar");
						const states = [
							["options-pen", "window.harness.openOptions('pen')"],
							["sheet", "window.harness.openMore()"],
							["page-sheet", "window.harness.openPageSheet()"],
							["selection", "window.harness.closeAll().then(() => window.harness.selectFirstStroke())"],
						];
						for (const state of ["main", "color", "width", "tools", "save", "shapes"]) states.push([`radial-${state}`, `window.harness.radialState('${state}')`]);
						for (const [file, expr] of states) {
							if (s.theme === "dark" && !file.startsWith("radial")) continue;
							await cdp.evaluate(`window.harness.closeAll().then(() => ${expr}).then(() => true)`);
							await shotAs(file);
						}
					}
					await cdp.evaluate("window.harness.closeAll().then(() => true)");
				} catch (e) {
					problems.push(`ui screenshots: ${e.message}`);
				}
			}
			if (problems.length) {
				failures++;
				console.log(`FAIL ${name}`);
				for (const p of problems) console.log(`     ${p}`);
			} else {
				console.log(`ok   ${name}  (dpr ${report.env?.dpr}, pointerrawupdate ${report.env?.rawUpdates}, desynchronized ${report.env?.wetDesynchronized})`);
			}
		}
		// The art gallery (src/ui/art): every style in the eight subject colours as cards and covers, plus the folder
		// icons, in dark and light; full-page screenshots in dist/shots/art/. HARNESS_DOC=art runs only these.
		if (!process.env.HARNESS_DOC || process.env.HARNESS_DOC === "art") {
			const artDir = join(shots, "art");
			mkdirSync(artDir, { recursive: true });
			const pages = [];
			for (const theme of ["dark", "light"]) {
				for (const style of [...ART_STYLES, "growth", "icons"]) pages.push({ theme, style, device: "desktopHiDpi" });
				for (const device of ["tablet", "phone"]) pages.push({ theme, style: "mix", device });
			}
			for (const a of pages) {
				const d = a.device === "desktopHiDpi" ? { ...DEVICES.desktop, deviceScaleFactor: 2 } : DEVICES[a.device];
				const name = `art-${a.theme}-${a.style}-${a.device}`;
				await cdp.send("Emulation.setDeviceMetricsOverride", { width: d.width, height: d.height, deviceScaleFactor: d.deviceScaleFactor, mobile: d.mobile });
				await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/art.html?theme=${a.theme}&style=${a.style}` });
				let report;
				try {
					for (let i = 0; i < 100; i++) {
						if (await cdp.evaluate("typeof window.artGallery === 'object'")) break;
						await sleep(100);
					}
					await cdp.evaluate("window.artGallery.ready.then(() => true)");
					// The checks (timing, determinism, cache) once per theme, on the desktop page of one style.
					report = a.style === "cells" ? await cdp.evaluate("window.artGallery.check()", 60000) : { ok: true, results: [], errors: [], timings: {} };
					await sleep(150);
				} catch (e) {
					report = { ok: false, results: [], errors: [String(e.message ?? e)], timings: {} };
				}
				const metrics = await cdp.send("Page.getLayoutMetrics");
				const size = metrics.cssContentSize ?? metrics.contentSize;
				const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: d.width, height: Math.ceil(size.height), scale: 1 } });
				writeFileSync(join(artDir, `${name}.png`), Buffer.from(shot.data, "base64"));
				const problems = report.results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`);
				problems.push(...report.errors.map((e) => `console error: ${e.split("\n")[0]}`));
				total++;
				const t = Object.entries(report.timings).map(([k, v]) => `${k} ${v} ms`).join(", ");
				if (problems.length) {
					failures++;
					console.log(`FAIL ${name}${t ? `  (draw 600x200 @2x: ${t})` : ""}`);
					for (const p of problems) console.log(`     ${p}`);
				} else {
					console.log(`ok   ${name}${t ? `  (draw 600x200 @2x: ${t})` : ""}`);
				}
				if (process.env.ART_BENCH && a.style === "cells") {
					const v = await cdp.evaluate(`JSON.stringify(Object.fromEntries(${JSON.stringify(ART_STYLES)}.map((s) => [s, ["card", "noglow", "flat"].map((k) => window.artGallery.bench(s, 9, k)).join(" / ")])))`, 120000);
					console.log(`     bench card / noglow / flat: ${v}`);
				}
			}
		}
		// The repository banner (1280 × 400), the social preview (1280 × 640) and the roadmap page's art band (1600 × 240), dark
		// and light: exact-size screenshots in dist/shots/banner/, copied into docs/media/ when the art changes.
		// HARNESS_DOC=banner runs only these.
		if (!process.env.HARNESS_DOC || process.env.HARNESS_DOC === "banner") {
			const bannerDir = join(shots, "banner");
			mkdirSync(bannerDir, { recursive: true });
			for (const b of [{ kind: "banner", theme: "dark", height: 400 }, { kind: "banner", theme: "light", height: 400 }, { kind: "social", theme: "dark", height: 640 }, { kind: "social", theme: "light", height: 640 }, { kind: "band", theme: "dark", width: 1600, height: 240 }, { kind: "band", theme: "light", width: 1600, height: 240 }]) {
				const name = `${b.kind}-${b.theme}`;
				const width = b.width ?? 1280;
				await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: b.height, deviceScaleFactor: 1, mobile: false });
				await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
				await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/banner.html?theme=${b.theme}&kind=${b.kind}` });
				let report;
				try {
					for (let i = 0; i < 100; i++) {
						if (await cdp.evaluate("typeof window.banner === 'object'")) break;
						await sleep(100);
					}
					await cdp.evaluate("window.banner.ready.then(() => true)");
					report = await cdp.evaluate("window.banner.check()", 60000);
					await sleep(150);
				} catch (e) {
					report = { ok: false, results: [], errors: [String(e.message ?? e)] };
				}
				const png = Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height: b.height, scale: 1 } })).data, "base64");
				writeFileSync(join(bannerDir, `${name}.png`), png);
				const problems = report.results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`);
				problems.push(...report.errors.map((e) => `console error: ${e.split("\n")[0]}`));
				const img = decodePng(png);
				if (img.width !== width || img.height !== b.height) problems.push(`screenshot is ${img.width} × ${img.height}, expected ${width} × ${b.height}`);
				total++;
				if (problems.length) {
					failures++;
					console.log(`FAIL ${name}`);
					for (const p of problems) console.log(`     ${p}`);
				} else console.log(`ok   ${name}`);
			}
		}
		cdp.close();
	} finally {
		browser.kill();
		server.close();
		await sleep(300);
		try {
			rmSync(profile, { recursive: true, force: true });
		} catch {
			// Chrome may still hold the profile on Windows.
		}
	}
	console.log(failures ? `harness:check: ${failures} of ${total} scenarios failed (screenshots in ${shots})` : `harness:check: all ${total} scenarios ok (screenshots in ${shots})`);
	process.exit(failures ? 1 : 0);
}

await main();
