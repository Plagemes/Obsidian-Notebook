/**
 * Smoke check of "Change cover…" (0.22, roadmap #53; `doc=covers`, npm run harness:check): the real dialog on the harness vault,
 * driven through the DOM. Checked: the four sources (pattern, image, page, template), that Cancel writes nothing, that a pattern
 * changes only `meta.coverArt`, that a template, a cropped image and a page each end as a small JPEG asset the notebook names
 * (and the notebook still reads back whole), that dragging and zooming move the crop, that a big photo is reduced for editing,
 * and the shell rules (targets, overflow, fit). `coverShot(state)` leaves one view open for the screenshots. The vault is the
 * in-memory stand-in: nothing here touches a real vault. The host below does what library/host.ts does, with the same pure
 * functions (patchNotebookCover, storeAssetTracked), minus the open-view path.
 */
import type { App } from "obsidian";
import { CoverDialog, type CoverChange, type CoverDialogHost } from "../../src/library/cover-dialog";
import { patchNotebookCover } from "../../src/library/host-logic";
import { renderThumbnail } from "../../src/library/thumbnail";
import { cloneMeta, createDocument, createPage, createStroke } from "../../src/model/document";
import { parse, serialize } from "../../src/model/serialize";
import { DEFAULT_META, PAGE_SIZES, type NotebookDocument, type NotebookMeta } from "../../src/model/types";
import { storeAssetTracked } from "../../src/view/media";
import { obsidianStyledButtons } from "./library-check";
import type { CheckResult } from "./reading-check";

export interface CoversCheckApi {
	app: unknown;
	errors: string[];
	notices: string[];
}

export const COVER_STATES = ["pattern", "image", "page", "template"] as const;
export type CoverState = typeof COVER_STATES[number];

const ROOT = "Notebooks";
const PATH = `${ROOT}/Biology.notebook`;
const frames = (n = 2) => new Promise<void>((resolve) => {
	let left = n;
	const step = () => (--left <= 0 ? resolve() : window.requestAnimationFrame(step));
	window.requestAnimationFrame(step);
});
const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const visible = (el: Element): boolean => {
	const r = el.getBoundingClientRect();
	return r.width > 0 && r.height > 0;
};

let current: CoverDialog | null = null;
let applied: CoverChange[] = [];
let picks = 0;

/** A photo-sized picture with a gradient and some structure (3200 x 2400, so the editor has to reduce it). */
async function photo(): Promise<ArrayBuffer> {
	const canvas = createEl("canvas");
	canvas.width = 3200;
	canvas.height = 2400;
	const ctx = canvas.getContext("2d")!;
	const g = ctx.createLinearGradient(0, 0, 3200, 2400);
	g.addColorStop(0, "#1f6f8b");
	g.addColorStop(0.5, "#f2c14e");
	g.addColorStop(1, "#d1495b");
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, 3200, 2400);
	ctx.fillStyle = "rgba(255,255,255,0.8)";
	for (let i = 0; i < 12; i++) ctx.fillRect(200 + i * 240, 300 + (i % 4) * 400, 120, 900);
	ctx.fillStyle = "#16191f";
	ctx.beginPath();
	ctx.arc(1600, 1200, 500, 0, Math.PI * 2);
	ctx.fill();
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.9));
	return blob!.arrayBuffer();
}

async function seed(app: App): Promise<NotebookDocument> {
	for (const f of app.vault.getFiles()) if (f.path === PATH || f.path.startsWith(`${ROOT}/_assets/`)) await app.fileManager.trashFile(f);
	const doc = createDocument(new Date("2026-10-20T10:00:00.000Z"));
	doc.meta = cloneMeta(DEFAULT_META);
	doc.meta.cover = "#3fa7a0";
	doc.meta.coverArt = { kind: "art", style: "waves", seed: "bio" };
	for (let p = 0; p < 3; p++) {
		const page = p === 0 ? doc.pages[0]! : createPage(PAGE_SIZES.a4);
		for (let i = 0; i < 6; i++) page.strokes.push(createStroke("#1e1e1e", 2, [[40, 80 + i * 40 + p * 6, 0.5], [200, 70 + i * 40, 0.5], [420, 90 + i * 40 + p * 10, 0.5]]));
		if (p > 0) doc.pages.push(page);
	}
	await app.vault.create(PATH, serialize(doc));
	return doc;
}

function hostFor(app: App, doc: NotebookDocument): CoverDialogHost {
	return {
		name: "Cell biology",
		color: doc.meta?.cover ?? DEFAULT_META.cover,
		current: doc.meta?.coverArt,
		seed: doc.id,
		pickImage: async () => {
			picks++;
			return { name: "photo.jpg", bytes: await photo(), type: "image/jpeg" };
		},
		pageCount: () => Promise.resolve(doc.pages.length),
		pageImage: (index) => Promise.resolve(renderThumbnail(doc.pages[index]!, 1000, { mime: "image/jpeg", quality: 0.85 })),
		apply: async (change) => {
			applied.push(change);
			const file = app.vault.getFileByPath(PATH)!;
			const asset = change.picture ? (await storeAssetTracked(app, ROOT, change.picture.bytes, change.picture.name, "image")).asset : null;
			const patch: Partial<NotebookMeta> = {
				...(change.color ? { cover: change.color } : {}),
				coverArt: asset ? { kind: "image", asset: asset.id } : change.art ? { kind: "art", ...change.art } : undefined,
			};
			const r = patchNotebookCover(await app.vault.read(file), asset, patch);
			if (!r.ok) throw new Error(r.message);
			await app.vault.modify(file, r.text);
		},
	};
}

const dialogEl = (): HTMLElement | null => document.querySelector<HTMLElement>(".modal.nb-cover-dialog");
const canvasEl = (): HTMLCanvasElement | null => dialogEl()?.querySelector<HTMLCanvasElement>(".nb-cover-canvas") ?? null;
const chipFor = (mode: string): HTMLButtonElement | null => dialogEl()?.querySelector<HTMLButtonElement>(`[data-key="cover-mode:${mode}"]`) ?? null;
const buttonByText = (text: string): HTMLButtonElement | null => [...(dialogEl()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent === text) ?? null;

function adopt(): void {
	for (const el of document.querySelectorAll<HTMLElement>("body > .modal")) {
		const root = document.body.createDiv({ cls: "harness-modal-container" });
		root.appendChild(el);
	}
}

export function closeCovers(): void {
	current?.close();
	current = null;
	for (const layer of document.querySelectorAll(".harness-modal-container")) if (!layer.querySelector(".modal")) layer.remove();
}

async function waitFor(what: () => boolean, ms = 8000): Promise<boolean> {
	for (let t = 0; t < ms; t += 50) {
		if (what()) return true;
		await sleep(50);
	}
	return what();
}

async function openDialog(app: App): Promise<void> {
	closeCovers();
	const doc = await seed(app);
	applied = [];
	picks = 0;
	current = new CoverDialog(app, hostFor(app, doc));
	current.open();
	adopt();
	await frames(3);
}

/** A hash of the frame's pixels (a cheap way to see that it changed or is not blank). */
function frameStats(): { sum: number; spread: number } {
	const c = canvasEl();
	const ctx = c?.getContext("2d");
	if (!c || !ctx) return { sum: 0, spread: 0 };
	const data = ctx.getImageData(0, 0, c.width, c.height).data;
	let sum = 0;
	let min = 255;
	let max = 0;
	for (let i = 0; i < data.length; i += 4 * 37) {
		const v = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
		sum += v;
		if (v < min) min = v;
		if (v > max) max = v;
	}
	return { sum: Math.round(sum), spread: max - min };
}

const vaultSnapshot = (app: App): string => app.vault.getFiles().map((f) => `${f.path}:${f.stat.size}:${f.stat.mtime}`).sort().join("|");

async function readDoc(app: App): Promise<NotebookDocument | null> {
	const parsed = parse(await app.vault.read(app.vault.getFileByPath(PATH)!));
	return parsed.ok ? parsed.doc : null;
}

function pointer(el: HTMLElement, type: string, x: number, y: number, id = 1): void {
	el.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true, pointerType: "touch", isPrimary: true }));
}

export async function checkCovers(api: CoversCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const app = api.app as App;
	const results: CheckResult[] = [];
	const add = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });
	const guard = async (name: string, fn: () => Promise<void>) => {
		try {
			await fn();
		} catch (e) {
			add(`${name}: threw`, false, (e as Error).stack ?? String(e));
		}
	};

	await guard("open", async () => {
		await openDialog(app);
		const d = dialogEl();
		add("open: the dialog is on the screen with a title", !!d && /Change cover/.test(d.textContent ?? ""));
		add("open: four sources are offered", ["art", "image", "page", "template"].every((m) => !!chipFor(m)));
		add("open: the pattern source is on and the apply button works", chipFor("art")?.getAttribute("aria-pressed") === "true" && buttonByText("Use this cover")?.disabled === false);
		await waitFor(() => frameStats().spread > 20);
		add("open: the frame shows the generated cover", frameStats().spread > 20, JSON.stringify(frameStats()));
	});

	await guard("cancel", async () => {
		await openDialog(app);
		const before = vaultSnapshot(app);
		chipFor("image")!.click();
		await frames(2);
		add("image: applying is not possible before a picture is chosen", buttonByText("Use this cover")?.disabled === true);
		buttonByText("Choose an image…")!.click();
		await waitFor(() => !!dialogEl()?.querySelector(".nb-cover-slider"));
		add("image: the chosen photo shows in the frame with a zoom slider", !!dialogEl()?.querySelector(".nb-cover-slider") && frameStats().spread > 40, JSON.stringify(frameStats()));
		add("image: a big photo is reduced for editing and says so", /Reduced to 1600 × 1200/.test(dialogEl()?.textContent ?? ""), (dialogEl()?.textContent ?? "").slice(0, 200));
		buttonByText("Cancel")!.click();
		await frames(2);
		add("cancel: the dialog closes and the vault is exactly as it was", !dialogEl() && vaultSnapshot(app) === before && applied.length === 0);
	});

	await guard("pattern", async () => {
		await openDialog(app);
		dialogEl()!.querySelectorAll<HTMLButtonElement>(".nb-cover-style")[3]!.click();
		await frames(2);
		buttonByText("Use this cover")!.click();
		await waitFor(() => applied.length > 0 && !dialogEl());
		const doc = await readDoc(app);
		add("pattern: the cover is generated art of the chosen family, no picture stored", doc?.meta?.coverArt?.kind === "art" && Object.keys(doc.assets ?? {}).length === 0, JSON.stringify(doc?.meta?.coverArt));
		add("pattern: the dialog closed after the change", !dialogEl());
	});

	await guard("template", async () => {
		await openDialog(app);
		chipFor("template")!.click();
		await waitFor(() => dialogEl()!.querySelectorAll(".nb-cover-template").length === 5 && frameStats().spread > 20);
		const tiles = [...dialogEl()!.querySelectorAll<HTMLButtonElement>(".nb-cover-template")];
		add("template: five templates are offered", tiles.length === 5, String(tiles.length));
		const seen = new Set<number>();
		for (const tile of tiles) {
			tile.click();
			await frames(3);
			await sleep(60);
			seen.add(frameStats().sum);
		}
		add("template: each template draws a different cover", seen.size === 5, [...seen].join(","));
		buttonByText("Use this cover")!.click();
		await waitFor(() => applied.length > 0 && !dialogEl());
		const doc = await readDoc(app);
		const art = doc?.meta?.coverArt;
		const asset = art?.kind === "image" ? doc?.assets?.[art.asset] : undefined;
		const bytes = asset ? await app.vault.readBinary(app.vault.getFileByPath(asset.path)!) : null;
		const head = bytes ? new Uint8Array(bytes.slice(0, 3)) : new Uint8Array();
		add("template: the cover is an image the notebook names", !!asset, JSON.stringify(art));
		add("template: the asset is a small JPEG next to the notebook", !!bytes && head[0] === 0xff && head[1] === 0xd8 && bytes.byteLength < 400_000 && !!asset && asset.path.startsWith(`${ROOT}/_assets/`), `${bytes?.byteLength} ${asset?.path}`);
		add("template: the cover colour was set and the pages are untouched", doc?.meta?.cover === applied[0]?.color && doc?.pages.length === 3 && doc.pages[0]!.strokes.length === 6, `${doc?.meta?.cover}`);
	});

	await guard("image", async () => {
		await openDialog(app);
		chipFor("image")!.click();
		await frames(2);
		buttonByText("Choose an image…")!.click();
		await waitFor(() => !!dialogEl()?.querySelector(".nb-cover-slider"));
		await frames(3);
		const c = canvasEl()!;
		const r = c.getBoundingClientRect();
		const start = frameStats().sum;
		const slider = dialogEl()!.querySelector<HTMLInputElement>(".nb-cover-slider")!;
		slider.value = "2.5";
		slider.dispatchEvent(new Event("input", { bubbles: true }));
		await frames(3);
		const zoomed = frameStats().sum;
		add("image: the zoom slider changes what the frame shows", zoomed !== start, `${start} -> ${zoomed}`);
		pointer(c, "pointerdown", r.left + r.width / 2, r.top + r.height / 2);
		pointer(c, "pointermove", r.left + r.width / 2 - 60, r.top + r.height / 2 - 30);
		pointer(c, "pointerup", r.left + r.width / 2 - 60, r.top + r.height / 2 - 30);
		await frames(3);
		const panned = frameStats().sum;
		add("image: dragging the picture moves the crop", panned !== zoomed, `${zoomed} -> ${panned}`);
		c.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, clientX: r.left + 10, clientY: r.top + 10, bubbles: true, cancelable: true }));
		await frames(3);
		add("image: the wheel zooms and keeps the slider in step", Number(slider.value) > 2.5, slider.value);
		buttonByText("Use this cover")!.click();
		await waitFor(() => applied.length > 0 && !dialogEl());
		const doc = await readDoc(app);
		const art = doc?.meta?.coverArt;
		const asset = art?.kind === "image" ? doc?.assets?.[art.asset] : undefined;
		const bytes = asset ? await app.vault.readBinary(app.vault.getFileByPath(asset.path)!) : null;
		add("image: the cropped photo is stored small, not the 3200 px original", !!bytes && bytes.byteLength < 250_000 && asset?.kind === "image", `${bytes?.byteLength}`);
		add("image: the cover colour is left alone", doc?.meta?.cover === "#3fa7a0" && applied[0]?.color === undefined, `${doc?.meta?.cover}`);
		add("image: the picker was asked once", picks === 1, String(picks));
	});

	await guard("page", async () => {
		await openDialog(app);
		chipFor("page")!.click();
		await waitFor(() => !!dialogEl()?.querySelector(".nb-cover-slider") && frameStats().spread > 20);
		add("page: the first page shows with its position", /of 3/.test(dialogEl()?.textContent ?? "") && frameStats().spread > 20, (dialogEl()?.textContent ?? "").slice(0, 200));
		const before = frameStats().sum;
		dialogEl()!.querySelector<HTMLButtonElement>(".nb-cover-next")!.click();
		await waitFor(() => (dialogEl()?.querySelector<HTMLInputElement>(".nb-cover-page")?.value ?? "") === "2");
		await sleep(250);
		await frames(3);
		add("page: the next button moves to page 2", dialogEl()?.querySelector<HTMLInputElement>(".nb-cover-page")?.value === "2", dialogEl()?.querySelector<HTMLInputElement>(".nb-cover-page")?.value ?? "");
		add("page: the frame changed with the page", frameStats().sum !== before, `${before} -> ${frameStats().sum}`);
		buttonByText("Use this cover")!.click();
		await waitFor(() => applied.length > 0 && !dialogEl());
		const doc = await readDoc(app);
		add("page: the cover is a stored picture", doc?.meta?.coverArt?.kind === "image" && !!doc.assets && Object.keys(doc.assets).length === 1, JSON.stringify(doc?.meta?.coverArt));
	});

	await guard("shell", async () => {
		for (const mode of ["art", "image", "template"] as const) {
			await openDialog(app);
			chipFor(mode)!.click();
			await sleep(150);
			if (mode === "image") {
				buttonByText("Choose an image…")!.click();
				await waitFor(() => !!dialogEl()?.querySelector(".nb-cover-slider"));
			}
			await frames(3);
			const d = dialogEl()!;
			const small = [...d.querySelectorAll<HTMLElement>("button, .nb-chip, input[type=range], input[type=number]")].filter(visible).filter((el) => Math.min(el.getBoundingClientRect().width, el.getBoundingClientRect().height) < 39.5);
			add(`shell (${mode}): every target is at least 40 px`, small.length === 0, small.slice(0, 3).map((el) => `${el.className} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`).join(", "));
			const body = d.querySelector<HTMLElement>(".nb-modal-body")!;
			add(`shell (${mode}): nothing overflows sideways`, body.scrollWidth <= body.clientWidth + 1, `${body.scrollWidth} > ${body.clientWidth}`);
			const r = d.getBoundingClientRect();
			add(`shell (${mode}): fits the screen`, r.left >= -0.5 && r.right <= window.innerWidth + 0.5 && r.top >= -0.5 && r.bottom <= window.innerHeight + 0.5, `${Math.round(r.left)}..${Math.round(r.right)} in ${window.innerWidth}`);
			add(`shell (${mode}): no button shows Obsidian's default look`, obsidianStyledButtons(d).length === 0, obsidianStyledButtons(d).slice(0, 3).map((b) => b.className).join(","));
		}
	});

	closeCovers();
	await openDialog(app);
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}

/** Leaves one view of the dialog open. */
export async function coverShot(api: CoversCheckApi, state: CoverState): Promise<void> {
	const app = api.app as App;
	await openDialog(app);
	if (state === "image") {
		chipFor("image")!.click();
		await frames(2);
		buttonByText("Choose an image…")!.click();
		await waitFor(() => !!dialogEl()?.querySelector(".nb-cover-slider"));
		const slider = dialogEl()!.querySelector<HTMLInputElement>(".nb-cover-slider")!;
		slider.value = "1.8";
		slider.dispatchEvent(new Event("input", { bubbles: true }));
	} else if (state === "page") {
		chipFor("page")!.click();
		await waitFor(() => !!dialogEl()?.querySelector(".nb-cover-slider"));
	} else if (state === "template") {
		chipFor("template")!.click();
		await waitFor(() => dialogEl()!.querySelectorAll(".nb-cover-template").length === 5);
		dialogEl()!.querySelectorAll<HTMLButtonElement>(".nb-cover-template")[1]!.click();
	}
	await sleep(300);
	await frames(3);
	window.scrollTo(0, 0);
}

/** What the harness page exposes (wired in harness.ts with one statement). */
export function coversApi(api: CoversCheckApi): Record<string, unknown> {
	return {
		checkCovers: async () => {
			try {
				return JSON.parse(JSON.stringify(await checkCovers(api))) as unknown;
			} catch (e) {
				return { ok: false, results: [], errors: [`covers check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} };
			}
		},
		coverShot: (state: CoverState) => coverShot(api, state),
		closeCovers,
		coverStates: [...COVER_STATES],
	};
}
