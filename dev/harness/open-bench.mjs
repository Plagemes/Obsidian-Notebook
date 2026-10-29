// Open-time benchmark of the real notebook view in desktop headless Chrome (npm run bench:open).
//
// Opens a generated notebook (default 10,000 strokes / 10 pages) in a fresh view several times and
// reports the median of each phase: file → document in the view, → first painted frame, → the page the
// reader wants (7 of 10) painted. `--no-restore` opens on page 1 and scrolls to the page afterwards (how
// 0.4.1 behaved: no saved position); the default asks for the page through the view state.
//
// This is CPU time on a PC with an in-memory vault. It is NOT a measurement on Android.
// Usage: node dev/harness/open-bench.mjs [--strokes=10000] [--pages=10] [--reps=7] [--page=7] [--no-restore]
//                                        [--snapshot=none|eager|deferred]  (emulates the snapshot started on open)
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
const reps = arg("reps", 7);
const page = arg("page", 7);
const restore = !process.argv.includes("--no-restore");
const snapshot = process.argv.find((x) => x.startsWith("--snapshot="))?.slice(11) ?? "none";
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

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
};

const chrome = findChrome();
if (!chrome) {
	console.error("bench:open: no Chrome/Chromium/Edge found. Set CHROME_PATH.");
	process.exit(2);
}
const dist = await buildHarness();
const server = serve(dist, 0);
await new Promise((r) => server.once("listening", r));
const port = server.address().port;
const profile = mkdtempSync(join(tmpdir(), "notebook-bench-"));
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
	// Samsung Galaxy Tab S-class tablet in landscape.
	await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 2, mobile: true });
	await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/index.html?doc=new` });
	for (let i = 0; i < 100; i++) {
		if (await cdp.evaluate("typeof window.harness === 'object' && !!window.harness.ready")) break;
		await sleep(100);
	}
	await cdp.evaluate("window.harness.ready.then(() => true)");
	const out = await cdp.evaluate(`window.harness.measureOpen(${strokes}, ${pages}, ${reps}, ${page}, ${restore}, "${snapshot}")`);
	const col = (k) => median(out.samples.map((s) => s[k]));
	const f = (n) => `${n.toFixed(0)} ms`;
	console.log(`open benchmark: ${out.strokes} strokes on ${pages} pages, file ${(out.bytes / 1e6).toFixed(2)} MB, ${out.samples.length} runs (median), wanted page ${page}, ${restore ? "position restored" : "opens on page 1, then scrolls"}, version-history snapshot: ${snapshot}`);
	console.log(`  read + parse + validate (DocumentSession.load): ${f(col("sessionMs"))}`);
	console.log(`  view setup after load (layout, fit, schedule):   ${f(col("viewMs"))}`);
	console.log(`  file opened (document in the view):              ${f(col("loadMs"))}`);
	console.log(`  first painted frame:                             ${f(col("firstPaintMs"))}`);
	console.log(`  wanted page painted:                             ${f(col("targetPaintMs"))}`);
	console.log("  (desktop headless Chrome, in-memory vault: CPU time only, not measured on Android)");
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
