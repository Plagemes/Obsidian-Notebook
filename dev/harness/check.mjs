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
// Move a selection to another page (0.16, #78): the page picker, tablet and phone, light and dark.
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "movesel", theme, device, lowLatency: false });
// Presentation mode (0.16, #87): full screen page with the laser pointer, tablet and phone, light and dark.
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "present", theme, device, lowLatency: false });

// Magnetic snap and alignment guides (0.17, #71): a stroke dragged beside another lands on its edge; the guides are drawn during the drag.
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "snap", theme, device, lowLatency: false });
// Locked pages (0.16, #124): the lock badge, the refused edits and the lock in the page panel, tablet and phone, light and dark.
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "lock", theme, device, lowLatency: false });
// Sticky notes (0.17, #20): an open note with text and handwriting and a collapsed one, tablet and phone, light and dark.
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "sticky", theme, device, lowLatency: false });
// Minimap (0.17, #173): the overview of an infinite page, tablet and phone, light and dark.
for (const device of ["tablet", "phone"]) for (const theme of ["light", "dark"]) SCENARIOS.push({ doc: "minimap", theme, device, lowLatency: false });
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
// 0.15 storage (128): the Storage manager at tablet and phone widths, light and dark (dev/harness/storage-check.ts).
for (const theme of ["light", "dark"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "storage", theme, device, lowLatency: false });
// 0.17 pdfcopy (#23): the notebook menu entry, the save hook and the three settings rows (dev/harness/pdfcopy-check.ts), tablet and phone, light and dark.
for (const theme of ["light", "dark"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "pdfcopy", theme, device, lowLatency: false });
// 0.16 bulk import (#80): the dialog, its run and the drop at tablet and phone widths, light and dark (dev/harness/bulk-check.ts).
for (const theme of ["light", "dark"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "bulk", theme, device, lowLatency: false });
// 0.17 merge / split / extract (#77): the dialog, the run and the map's selection mode (dev/harness/pagesplit-check.ts).
for (const theme of ["light", "dark"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "xfer", theme, device, lowLatency: false });
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
// 0.14 slides: ink linked to the slide beside it (badges) and the slide strip, tablet and phone, dark and light (dist/shots/slides-*.png).
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "slides", theme, device, lowLatency: false });
// 0.15 pensets: pen sets per subject on the strip, the switcher chip and the manager, tablet and phone, dark and light (dist/shots/pensets-*.png).
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "pensets", theme, device, lowLatency: false });
// 0.16 inbox: files shared from other apps, as Home's card, the rail badge and the full list (dev/harness/inbox-check.ts), tablet and phone, dark and light.
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "inbox", theme, device, lowLatency: false });
// 0.17 task: "Make task" from a selection (dev/harness/task-check.ts), tablet and phone, dark and light.
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "task", theme, device, lowLatency: false });
// 0.15 states: a figure with parts and states, moved with the selection handles (dist/shots/states-*.png).
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "states", theme, device, lowLatency: false });
// 0.16 digest: the Highlights digest dialog and the note it writes (dev/harness/digest-check.ts), tablet and phone, dark and light (dist/shots/digest-*.png).
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "digest", theme, device, lowLatency: false });

// 0.18 mentions: the Mentions sheet and the count badge (dev/harness/mentions-check.ts), tablet and phone, dark and light (dist/shots/mentions-*.png).
for (const theme of ["dark", "light"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "mentions", theme, device, lowLatency: false });

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
				else if (s.doc === "xfer") report = await cdp.evaluate("window.harness.checkXfer()", 120000);
				else if (s.doc === "pdfcopy") report = await cdp.evaluate("window.harness.checkPdfcopy()", 90000);
				else if (s.doc === "inbox") report = await cdp.evaluate("window.harness.checkInbox()", 60000);

				// 0.16 pdftext: its own check.
				else if (s.doc === "pdftext") report = await cdp.evaluate("window.harness.checkPdftext()", 90000);
				// 0.17 snap: its own check.
				else if (s.doc === "snap") report = await cdp.evaluate("window.harness.checkSnap()", 60000);
				// 0.18 mentions: its own check.
				else if (s.doc === "mentions") report = await cdp.evaluate("window.harness.checkMentions()", 60000);
				else
				report = await cdp.evaluate(s.doc === "states" ? "window.harness.checkStates()" : s.doc === "hints" ? "window.harness.checkHints()" : s.doc === "slides" ? "window.harness.checkSlides()" : s.doc === "zettel" ? "window.harness.checkZettel()" : s.doc === "pdf" ? "window.harness.checkReading()" : s.doc === "practice" ? "window.harness.checkPractice()" : s.doc === "lecture" ? "window.harness.checkLecture()" : s.doc === "outline" ? "window.harness.checkOutline()" : s.doc === "smartadd" ? "window.harness.checkSmartAdd()" : s.doc === "header" ? "window.harness.checkHeader()" : s.doc === "pensets" ? "window.harness.checkPenSets()" : s.doc === "task" ? "window.harness.checkTask()" : s.doc === "daily" ? "window.harness.checkDaily()" : s.doc === "nbmap" ? "window.harness.checkNbmap()" : s.doc === "movesel" ? "window.harness.checkMovesel()" : s.doc === "present" ? "window.harness.checkPresent()" : s.doc === "digest" ? "window.harness.checkDigest()" : s.doc === "lock" ? "window.harness.checkLock()" : s.doc === "sticky" ? "window.harness.checkSticky()" : s.doc === "minimap" ? "window.harness.checkMinimap()" : s.doc === "readonly" ? "window.harness.checkReadOnly()" : s.doc === "excerpt" ? "window.harness.checkExcerpt()" : s.doc === "settings" ? "window.harness.checkSettings()" : s.doc === "chrome" ? "window.harness.checkChrome()" : s.doc === "toolbar" || s.doc === "toolbar-pdf" ? "window.harness.checkAdaptiveToolbar()" : s.doc === "plugin" ? "window.harness.checkPlugin()" : s.doc === "create" ? "window.harness.checkCreate('notebook')" : s.doc === "modals" ? "window.harness.checkModals()" : s.doc === "templates" ? "window.harness.checkTemplates()" : s.doc === "library" ? "window.harness.checkLibrary()" : s.doc === "empty" ? (s.hostile ? "window.harness.checkHostile()" : "window.harness.checkEmpty()") : "window.harness.check()", 60000);
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
