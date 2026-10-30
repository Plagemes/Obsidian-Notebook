// Headless Chrome helpers shared by the harness tools (check.mjs, media.mjs): find a browser, start it with a
// throw-away profile, and talk to it over the DevTools protocol.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function findChrome() {
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

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal DevTools protocol client over the built-in WebSocket. */
export class Cdp {
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
/** Starts headless Chrome on about:blank and connects to its page. `close()` stops it and removes the profile. */
export async function launchChrome(chrome) {
	const profile = mkdtempSync(join(tmpdir(), "notebook-harness-"));
	const browser = spawn(chrome, [
		"--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run",
		"--no-default-browser-check", "--disable-extensions", "--hide-scrollbars", "about:blank",
	], { stdio: "ignore" });
	const close = async () => {
		browser.kill();
		await sleep(300);
		try {
			rmSync(profile, { recursive: true, force: true });
		} catch {
			// Chrome may still hold the profile on Windows.
		}
	};
	let devtools = null;
	for (let i = 0; i < 100 && !devtools; i++) {
		await sleep(100);
		const f = join(profile, "DevToolsActivePort");
		if (existsSync(f)) devtools = Number(readFileSync(f, "utf8").split("\n")[0]);
	}
	if (!devtools) {
		await close();
		throw new Error("Chrome did not start");
	}
	const targets = await (await fetch(`http://127.0.0.1:${devtools}/json/list`)).json();
	const cdp = new Cdp(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
	await cdp.open();
	return { cdp, close };
}
