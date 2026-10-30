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

const SCENARIOS = [];
for (const doc of ["v3", "new"]) {
	for (const theme of ["light", "dark"]) {
		for (const device of Object.keys(DEVICES)) SCENARIOS.push({ doc, theme, device, lowLatency: false });
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

function findChrome() {
	const candidates = [
		process.env.CHROME_PATH,
		"C:/Program Files/Google/Chrome/Application/chrome.exe",
		"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
		"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
		"C:/Program Files/Microsoft/Edge/Application/msedge.exe",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
	].filter(Boolean);
	return candidates.find((p) => existsSync(p)) ?? null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal DevTools protocol client over the built-in WebSocket. */
class Cdp {
	constructor(url) {
		this.ws = new WebSocket(url);
		this.id = 0;
		this.pending = new Map();
		this.ws.addEventListener("message", (e) => {
			const msg = JSON.parse(String(e.data));
			const p = msg.id !== undefined ? this.pending.get(msg.id) : null;
			if (!p) return;
			this.pending.delete(msg.id);
			if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
			else p.resolve(msg.result);
		});
	}
	open() {
		return new Promise((resolve, reject) => {
			this.ws.addEventListener("open", resolve, { once: true });
			this.ws.addEventListener("error", reject, { once: true });
		});
	}
	send(method, params = {}) {
		const id = ++this.id;
		this.ws.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
	}
	async evaluate(expression, timeoutMs = 30000) {
		const r = await Promise.race([
			this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
			sleep(timeoutMs).then(() => {
				throw new Error(`timed out: ${expression}`);
			}),
		]);
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
		return r.result.value;
	}
	close() {
		this.ws.close();
	}
}

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
		"--no-default-browser-check", "--disable-extensions", "--hide-scrollbars", "about:blank",
	], { stdio: "ignore" });
	let failures = 0;
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
			const name = `${s.doc}-${s.theme}-${s.device}${s.lowLatency ? "-lowlatency" : ""}${s.fault ? `-fault-${s.fault}` : ""}`;
			await cdp.send("Emulation.setDeviceMetricsOverride", { width: d.width, height: d.height, deviceScaleFactor: d.deviceScaleFactor, mobile: d.mobile });
			await cdp.send("Emulation.setTouchEmulationEnabled", d.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
			const url = `http://127.0.0.1:${port}/index.html?doc=${s.doc}&theme=${s.theme}${s.lowLatency ? "&lowLatency=1" : ""}${s.fault ? `&fault=${s.fault}` : ""}`;
			await cdp.send("Page.navigate", { url });
			let report;
			try {
				for (let i = 0; i < 100; i++) {
					if (await cdp.evaluate("typeof window.harness === 'object' && !!window.harness.ready")) break;
					await sleep(100);
				}
				await cdp.evaluate("window.harness.ready.then(() => true)");
				report = await cdp.evaluate(s.doc === "pdf" ? "window.harness.checkReading()" : s.doc === "practice" ? "window.harness.checkPractice()" : "window.harness.check()", 60000);
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
	console.log(failures ? `harness:check: ${failures} of ${SCENARIOS.length} scenarios failed (screenshots in ${shots})` : `harness:check: all ${SCENARIOS.length} scenarios ok (screenshots in ${shots})`);
	process.exit(failures ? 1 : 0);
}

await main();
