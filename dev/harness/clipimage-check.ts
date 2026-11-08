/**
 * Smoke check of "Copy as image" (0.25, roadmap #277, `doc=clipimage`, npm run harness:check): the real copyAsImage draws the written area
 * and hands it to a stand-in image clipboard (white or transparent corner, per the setting), falls back to the share sheet and then to a
 * saved PNG when the device lacks the clipboard, refuses an empty page with a notice, and leaves a small preview on screen for the shot.
 */
import { TFile, type App } from "obsidian";
import { copyAsImage } from "../../src/view/copy-image";
import type { AreaHost } from "../../src/view/export-area";
import { createPage, createStroke, quantizePoint } from "../../src/model/document";
import { PAGE_SIZES, type Page, type Point } from "../../src/model/types";
import type { CheckResult } from "./reading-check";

export interface ClipImageCheckApi {
	app: unknown;
	errors: string[];
	notices: string[];
}

let card: HTMLElement | null = null;
const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

function demoPage(): Page {
	const p = createPage(PAGE_SIZES.a4);
	const pts = (y: number): Point[] => Array.from({ length: 14 }, (_, i) => quantizePoint(120 + i * 14, y + Math.sin(i / 2) * 8, 0.3 + (i % 5) / 8));
	p.strokes.push(createStroke("#1e1e1e", 4, pts(200)), createStroke("#2255cc", 4, pts(240)));
	p.elements = [{ id: "t1", type: "text", x: 110, y: 280, width: 220, text: "Copy as image", fontSize: 18, color: "#000000" }];
	return p;
}

function host(app: App, page: Page): AreaHost {
	const made: unknown = Object.assign(Object.create(TFile.prototype) as object, { basename: "Demo", parent: { path: "Notebooks" }, path: "Notebooks/Demo.notebook" });
	if (!(made instanceof TFile)) throw new Error("harness: could not build the demo file");
	return { app, file: made, page, pageNumber: 1, media: null, exportOptions: {}, render: {}, selection: { strokes: [page.strokes[1]!], elements: [] } };
}

async function cornerAlpha(blob: Blob): Promise<number> {
	const bmp = await createImageBitmap(blob);
	const c = createEl("canvas");
	c.width = bmp.width;
	c.height = bmp.height;
	const ctx = c.getContext("2d")!;
	ctx.drawImage(bmp, 0, 0);
	return ctx.getImageData(0, 0, 1, 1).data[3]!;
}

type Nav = Record<string, unknown>;
function withNavigator<T>(patch: Nav, run: () => Promise<T>): Promise<T> {
	const nav = navigator as unknown as Nav;
	const saved: Array<[string, PropertyDescriptor | undefined]> = Object.keys(patch).map((k) => [k, Object.getOwnPropertyDescriptor(nav, k)]);
	for (const [k, v] of Object.entries(patch)) Object.defineProperty(navigator, k, { configurable: true, value: v });
	return run().finally(() => {
		for (const [k, d] of saved) {
			if (d) Object.defineProperty(navigator, k, d);
			else delete nav[k];
		}
	});
}

export async function checkClipImage(api: ClipImageCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const written: string[] = [];
	const app = Object.assign(Object.create(api.app as object) as object, {
		vault: {
			getAbstractFileByPath: (path: string) => (written.includes(path) ? {} : null),
			createBinary: (path: string) => { written.push(path); return Promise.resolve({ path }); },
			create: (path: string) => { written.push(path); return Promise.resolve({ path }); },
		},
		saveLocalStorage: () => undefined,
		loadLocalStorage: () => null,
	}) as unknown as App;
	const page = demoPage();
	let copied: Blob | null = null;
	const clipboard = { write: async (items: ClipboardItem[]) => { copied = await items[0]!.getType("image/png"); } };
	const both = { imageClipboard: true, shareFiles: true };

	let route = await withNavigator({ clipboard }, () => copyAsImage(host(app, page), "page", "white", both));
	add("copies through the image clipboard", route === "clipboard" && !!copied, String(route));
	const white = copied ? await cornerAlpha(copied) : -1;
	add("white background: the corner is opaque", white === 255, String(white));
	if (copied) {
		card?.remove();
		card = document.body.createDiv({ cls: "nb-ui" });
		card.setAttr("style", "position:fixed;left:16px;top:16px;right:16px;padding:12px;background:#8a8a8a;border-radius:12px;z-index:99999;display:flex;gap:12px;align-items:center;");
		const img = card.createEl("img");
		img.setAttr("style", "max-width:60%;max-height:240px;");
		img.src = URL.createObjectURL(copied);
		card.createDiv({ text: api.notices[api.notices.length - 1] ?? "" }).setAttr("style", "color:#fff;font:14px sans-serif;");
	}
	copied = null;
	route = await withNavigator({ clipboard }, () => copyAsImage(host(app, page), "selection", "transparent", both));
	const clear = copied ? await cornerAlpha(copied) : -1;
	add("transparent setting keeps the corner transparent, and the selection alone is copied", route === "clipboard" && clear === 0, `${route} ${clear}`);

	// No image clipboard: the share sheet takes the PNG.
	let shared: { files: File[] } | null = null;
	route = await withNavigator({ share: (d: { files: File[] }) => { shared = d; return Promise.resolve(); } }, () => copyAsImage(host(app, page), "page", "white", { imageClipboard: false, shareFiles: true }));
	add("falls back to the share sheet with a PNG file", route === "share" && shared !== null && (shared as { files: File[] }).files[0]?.type === "image/png", String(route));

	// Clipboard refuses: the next way is tried, with a notice.
	route = await withNavigator({ clipboard: { write: () => Promise.reject(new Error("blocked")) }, share: () => Promise.resolve() }, () => copyAsImage(host(app, page), "page", "white", both));
	add("a refused clipboard falls through to the share sheet", route === "share", String(route));

	// Nothing available: a PNG is saved, and the notice says so.
	route = await copyAsImage(host(app, page), "page", "white", { imageClipboard: false, shareFiles: false });
	await sleep(30);
	add("last resort: a PNG is saved next to the notebook", route === "save" && written.some((p) => p.endsWith(".png")) && api.notices.some((n) => /saved/i.test(n)), `${route} ${written.join("|")}`);

	// Share sheet closed by the user: nothing else is tried.
	const before = written.length;
	route = await withNavigator({ share: () => Promise.reject(Object.assign(new Error("x"), { name: "AbortError" })) }, () => copyAsImage(host(app, page), "page", "white", { imageClipboard: false, shareFiles: true }));
	add("closing the share sheet stops, with a notice and no saved copy", route === null && written.length === before && api.notices.some((n) => /cancelled/i.test(n)));

	// A share that comes too long after the tap (the browser wants a fresh one): no file is saved, one notice asks for a new tap.
	const beforeTap = written.length;
	const noticesBefore = api.notices.length;
	route = await withNavigator({ share: () => Promise.reject(Object.assign(new Error("x"), { name: "NotAllowedError" })) }, () => copyAsImage(host(app, page), "page", "white", { imageClipboard: false, shareFiles: true }));
	const tapNotices = api.notices.slice(noticesBefore).filter((n) => !/^working/i.test(n) && !/preparing|drawing/i.test(n));
	add("a share that needs a new tap saves nothing and asks for one tap", route === null && written.length === beforeTap && tapNotices.filter((n) => /tap/i.test(n)).length === 1 && !tapNotices.some((n) => /saved|copied/i.test(n)), tapNotices.join(" | "));

	const empty = await copyAsImage(host(app, createPage(PAGE_SIZES.a4)), "page", "white", both);
	add("an empty page is refused with a notice", empty === null && api.notices.some((n) => /nothing written/i.test(n)));

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: [...api.errors], notices: [...api.notices], env: { dpr: window.devicePixelRatio } };
}

/** What the harness page exposes (wired in harness.ts with one line). */
export function clipImageApi(api: ClipImageCheckApi): Record<string, unknown> {
	return {
		checkClipImage: async () => {
			try {
				return JSON.parse(JSON.stringify(await checkClipImage(api))) as unknown;
			} catch (e) {
				return { ok: false, results: [], errors: [`clipimage check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} };
			}
		},
		closeClipImage: () => { card?.remove(); card = null; },
	};
}
