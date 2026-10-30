// Level-of-detail benchmark of the real Renderer in desktop headless Chrome (npm run bench:lod).
//
// Scrolls through a generated notebook (default 10,000 strokes / 10 pages) at zoomed-out scales with the level of
// detail off and on, for both stroke geometries (render 1 perfect-freehand, render 2 wet ink), and prints the
// frame time of the first pass (paths are built) and of the second (paths cached). The canvas is read back after
// each frame so rasterisation is included.
//
// This is time on a PC. It is NOT a measurement on Android.
// Usage: node dev/harness/lod-bench.mjs [--strokes=10000] [--pages=10] [--frames=100] [--dpr=2] [--check-heavy]
// --check-heavy also runs the heavy page warning check (banner, Split page, undo, Dismiss).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHarness } from "./build.mjs";
import { serve } from "./serve.mjs";

const arg = (name, fallback) => {
	const a = process.argv.find((x) => x.startsWith(`--${name}=`));
	return a ? Number(a.slice(name.length + 3)) : fallback;
};
const strokes = arg("strokes", 10000);
const pages = arg("pages", 10);
const frames = arg("frames", 100);
const dpr = arg("dpr", 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
	return [
		process.env.CHROME_PATH,
		"C:/Program Files/Google/Chrome/Application/chrome.exe",
		"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
		"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
		"C:/Program Files/Microsoft/Edge/Application/msedge.exe",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
	].filter(Boolean).find((p) => existsSync(p)) ?? null;
}

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
			if (msg.error) p.reject(new Error(msg.error.message));
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
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
	}
	async evaluate(expression) {
		const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
		return r.result.value;
	}
}

const chrome = findChrome();
if (!chrome) {
	console.error("bench:lod: no Chrome/Chromium/Edge found. Set CHROME_PATH.");
	process.exit(2);
}
const dist = await buildHarness();
const server = serve(dist, 0);
await new Promise((r) => server.once("listening", r));
const port = server.address().port;
const profile = mkdtempSync(join(tmpdir(), "notebook-lodbench-"));
const browser = spawn(chrome, [
	"--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run",
	"--no-default-browser-check", "--disable-extensions", "--hide-scrollbars", "about:blank",
], { stdio: "ignore" });
try {
	let devtools = null;
	for (let i = 0; i < 100 && !devtools; i++) {
		await sleep(100);
		const f = join(profile, "DevToolsActivePort");
		if (existsSync(f)) devtools = Number(readFileSync(f, "utf8").split("\n")[0]);
	}
	if (!devtools) throw new Error("Chrome did not start");
	const targets = await (await fetch(`http://127.0.0.1:${devtools}/json/list`)).json();
	const cdp = new Cdp(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
	await cdp.open();
	await cdp.send("Page.enable");
	await cdp.send("Runtime.enable");
	await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: dpr, mobile: false });
	await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/index.html?doc=new` });
	for (let i = 0; i < 100; i++) {
		if (await cdp.evaluate("typeof window.harness === 'object' && !!window.harness.ready")) break;
		await sleep(100);
	}
	await cdp.evaluate("window.harness.ready.then(() => true)");
	const out = await cdp.evaluate(`window.harness.measureLod(${strokes}, ${pages}, [0.49, 0.35, 0.25], [1, 2], ${frames})`);
	console.log(`LOD benchmark: ${out.strokes} strokes on ${pages} pages, view ${out.width}x${out.height} @${out.dpr}x, ${frames} frames scrolling through the whole notebook, canvas read back after each frame`);
	console.log("render  scale  LOD  level  | cold pass: mean / p95 / max ms | warm pass: mean / p95 / max ms | strokes per frame");
	const f = (n) => n.toFixed(1).padStart(6);
	for (const r of out.rows) {
		console.log(
			`  ${r.render}     ${r.scale.toFixed(2)}   ${r.lod ? "on " : "off"}   ${String(r.level).padStart(3)}   | ${f(r.cold.meanMs)} ${f(r.cold.p95Ms)} ${f(r.cold.maxMs)} | ${f(r.warm.meanMs)} ${f(r.warm.p95Ms)} ${f(r.warm.maxMs)} | ${r.warm.strokesPerFrame.toFixed(0)}`,
		);
	}
	console.log("(desktop headless Chrome: time on a PC, not measured on Android)");
	const diffs = await cdp.evaluate("window.harness.compareLod(1000)");
	console.log("pixel difference, exact vs simplified strokes (one page of 1,000 strokes):");
	for (const d of diffs) {
		console.log(`  render ${d.render} scale ${d.scale.toFixed(2)}: ${d.bigDiffPct.toFixed(3)}% of pixels differ by more than 64/255, ${d.anyDiffPct.toFixed(1)}% differ at all, mean difference ${d.meanDiff.toFixed(3)}/255 (ink covers ${d.inkPct.toFixed(1)}%)`);
	}
	if (process.argv.includes("--check-heavy")) {
		await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/index.html?doc=new` });
		await sleep(1500);
		await cdp.evaluate("window.harness.ready.then(() => true)");
		console.log("heavy page check:", JSON.stringify(await cdp.evaluate("window.harness.checkHeavy(3500)")));
	}
	cdp.ws.close();
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
process.exit(0);
