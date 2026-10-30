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
};

// The families of src/ui/art/generative-art.ts (ART_STYLES), for the art gallery pages.
const ART_STYLES = ["contours", "cells", "waves", "branches", "flow", "orbits", "grid"];

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
// Anchored excerpts (v10): a region of a fake PDF page excerpted to a new page, drawn live, and the badge's jump back.
SCENARIOS.push({ doc: "excerpt", theme: "light", device: "desktop", lowLatency: false });
SCENARIOS.push({ doc: "excerpt", theme: "dark", device: "tablet", lowLatency: false });
// Read-only mode, PNG export with ranges and Print (wave 0.10): desktop can print, a phone and a tablet cannot.
SCENARIOS.push({ doc: "readonly", theme: "light", device: "desktop", lowLatency: false });
SCENARIOS.push({ doc: "readonly", theme: "dark", device: "narrow", lowLatency: false });
SCENARIOS.push({ doc: "readonly", theme: "light", device: "tablet", lowLatency: false });
// The settings tab (sections, a dependent option, Advanced, search in both languages, Style, 40 px targets) on a phone, a tablet and a desktop.
SCENARIOS.push({ doc: "settings", theme: "light", device: "narrow", lowLatency: false });
SCENARIOS.push({ doc: "settings", theme: "dark", device: "tablet", lowLatency: false });
SCENARIOS.push({ doc: "settings", theme: "dark", device: "desktop", lowLatency: false });
// The light desktop settings too: with the dark one, the pair shown in the README (docs/media/).
SCENARIOS.push({ doc: "settings", theme: "light", device: "desktop", lowLatency: false });
// wave 0.12: the creation dialog (both tabs) at tablet and phone widths, light and dark.
for (const theme of ["light", "dark"]) for (const device of ["tablet", "phone"]) SCENARIOS.push({ doc: "create", theme, device, lowLatency: false });
// 0.12.1: the whole plugin's onload against the stub: what it registers, the settings tab through both of Obsidian's paths,
// and injected failures (a failing step, failing settings definitions, an unreadable data.json).
SCENARIOS.push({ doc: "plugin", theme: "dark", device: "tablet", lowLatency: false });
SCENARIOS.push({ doc: "plugin", theme: "light", device: "desktop", lowLatency: false });

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
			const name = `${s.doc}${s.surface ? `-${s.surface}` : ""}-${s.theme}-${s.device}${s.lowLatency ? "-lowlatency" : ""}${s.fault ? `-fault-${s.fault}` : ""}`;
			await cdp.send("Emulation.setDeviceMetricsOverride", { width: d.width, height: d.height, deviceScaleFactor: d.deviceScaleFactor, mobile: d.mobile });
			await cdp.send("Emulation.setTouchEmulationEnabled", d.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
			const url = `http://127.0.0.1:${port}/index.html?doc=${s.doc}&theme=${s.theme}${s.lowLatency ? "&lowLatency=1" : ""}${s.fault ? `&fault=${s.fault}` : ""}${s.surface ? `&surface=${s.surface}` : ""}`;
			await cdp.send("Page.navigate", { url });
			let report;
			try {
				for (let i = 0; i < 100; i++) {
					if (await cdp.evaluate("typeof window.harness === 'object' && !!window.harness.ready")) break;
					await sleep(100);
				}
				await cdp.evaluate("window.harness.ready.then(() => true)");
				report = await cdp.evaluate(s.doc === "pdf" ? "window.harness.checkReading()" : s.doc === "practice" ? "window.harness.checkPractice()" : s.doc === "readonly" ? "window.harness.checkReadOnly()" : s.doc === "excerpt" ? "window.harness.checkExcerpt()" : s.doc === "settings" ? "window.harness.checkSettings()" : s.doc === "plugin" ? "window.harness.checkPlugin()" : s.doc === "create" ? "window.harness.checkCreate('notebook')" : s.doc === "library" ? "window.harness.checkLibrary()" : "window.harness.check()", 60000);
			} catch (e) {
				report = { ok: false, results: [], errors: [String(e.message ?? e)] };
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
			// wave 0.12: the creation dialog's Folder tab (the Notebook tab is the screenshot above).
			if (s.doc === "create") {
				try {
					await cdp.evaluate("window.harness.createShot('folder').then(() => true)");
					writeFileSync(join(shots, `${name}-folder.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
				} catch (e) {
					problems.push(`folder tab screenshot: ${e.message}`);
				}
			}
			// 0.12: review screenshots of Home and the library, then their controls (bell, rail, quick actions, search, star, list).
			if (s.doc === "library") {
				const designDir = join(shots, "design");
				mkdirSync(designDir, { recursive: true });
				writeFileSync(join(designDir, `${s.surface}-${s.theme}-${s.device}.png`), png);
				const shotAs = async (file) => writeFileSync(join(designDir, `${s.surface}-${s.theme}-${s.device}-${file}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
				try {
					if (s.theme === "dark") {
						for (const state of ["bell", "search", "list"]) {
							await cdp.evaluate(`window.harness.libraryState('${state}')`);
							await shotAs(state);
							await cdp.evaluate("window.harness.libraryState('reset')");
						}
					}
					const r = await cdp.evaluate("window.harness.interactLibrary()", 60000);
					problems.push(...r.results.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`));
				} catch (e) {
					problems.push(`library interactions: ${e.message}`);
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
				for (const style of [...ART_STYLES, "icons"]) pages.push({ theme, style, device: "desktopHiDpi" });
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
		// The repository banner (1280 × 400), the social preview (1280 × 640) and the roadmap page's art band (1600 × 320), dark
		// and light: exact-size screenshots in dist/shots/banner/, copied into docs/media/ when the art changes.
		// HARNESS_DOC=banner runs only these.
		if (!process.env.HARNESS_DOC || process.env.HARNESS_DOC === "banner") {
			const bannerDir = join(shots, "banner");
			mkdirSync(bannerDir, { recursive: true });
			for (const b of [{ kind: "banner", theme: "dark", height: 400 }, { kind: "banner", theme: "light", height: 400 }, { kind: "social", theme: "dark", height: 640 }, { kind: "social", theme: "light", height: 640 }, { kind: "band", theme: "dark", width: 1600, height: 320 }, { kind: "band", theme: "light", width: 1600, height: 320 }]) {
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
