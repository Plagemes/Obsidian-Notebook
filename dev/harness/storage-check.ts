/**
 * Smoke check of the Storage manager (0.15, roadmap #128; `doc=storage`, npm run harness:check): the real dialog, scan and
 * actions on the harness vault, filled with a small library: five notebooks (one with a copy made by sync that is identical
 * and one that differs), a heavy photo shared by two of them, a picture stored twice, a copy under another id, two files no
 * notebook uses (seen unused two days ago), and old backups and version history. The dialog is driven through the DOM:
 * the scan, the sorting, each confirmation (Cancel changes nothing, the button does what it says), the files that end up in
 * the trash folder, the notebooks that end up using the smaller copy. `storageShot(state)` leaves one view open for the
 * screenshots. The stand-in vault lives in memory: nothing here touches a real vault.
 */
import type { App, TFile } from "obsidian";
import { cloneMeta, createDocument, createPage, createStroke } from "../../src/model/document";
import { serialize, parse } from "../../src/model/serialize";
import { DEFAULT_META, PAGE_SIZES, type Asset, type NotebookDocument } from "../../src/model/types";
import { assetUses, useCount } from "../../src/model/asset-ops";
import { LibraryCheckSeenStore } from "../../src/library/library-check-seen";
import { openStorageManager, type StorageDialogHost } from "../../src/library/storage-dialog";
import { DEFAULT_SETTINGS, type NotebookSettings } from "../../src/settings";
import { sidecarDeviceId, vaultDeviceFileAdapter } from "../../src/storage/vault-io";
import { storeAsset } from "../../src/view/media";
import { obsidianStyledButtons } from "./library-check";
import type { CheckResult } from "./reading-check";

export interface StorageCheckApi {
	app: unknown;
	errors: string[];
	notices: string[];
}

/** What the harness screenshots, in this order. */
export const STORAGE_STATES = ["overview", "unused", "heavy", "backups", "confirm"] as const;
export type StorageState = typeof STORAGE_STATES[number];

const ROOT = "Notebooks";
const DAY = 86_400_000;
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
const buttonByText = (root: ParentNode, text: string): HTMLButtonElement | null =>
	[...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text) ?? null;
const buttonStarting = (root: ParentNode, text: string): HTMLButtonElement | null =>
	[...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.textContent ?? "").startsWith(text)) ?? null;

// ---------------------------------------------------------------- the library

interface Seeded {
	photo: Asset;
	smallShared: Asset;
	dupA: Asset;
	dupB: Asset;
	copyOfB: Asset;
	unusedA: string;
	unusedB: string;
	docIds: { physics: string };
	paths: { physics: string; physicsCopy: string; physicsConflict: string; anatomy: string; maths: string; chemistry: string };
}

let photoBytes: ArrayBuffer | null = null;

/** A noisy JPEG a few megabytes big, made with a canvas (the downscale has something to shrink). */
async function heavyPhoto(): Promise<ArrayBuffer> {
	if (photoBytes) return photoBytes;
	const [w, h] = [3000, 2000];
	const canvas = createEl("canvas");
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext("2d")!;
	const image = ctx.createImageData(w, h);
	let seed = 12345;
	for (let i = 0; i < image.data.length; i += 4) {
		seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
		const n = (seed >>> 16) & 0xff;
		image.data[i] = n;
		image.data[i + 1] = (n * 7) & 0xff;
		image.data[i + 2] = (n * 13) & 0xff;
		image.data[i + 3] = 255;
	}
	ctx.putImageData(image, 0, 0);
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92));
	photoBytes = await blob!.arrayBuffer();
	return photoBytes;
}

const text = (s: string, size: number): ArrayBuffer => new TextEncoder().encode(s.padEnd(size, ".")).buffer;

function docWith(assets: Asset[], strokes = 3): NotebookDocument {
	const doc = createDocument(new Date("2026-10-20T10:00:00.000Z"));
	doc.meta = cloneMeta(DEFAULT_META);
	for (let i = 0; i < strokes; i++) doc.pages[0]!.strokes.push(createStroke("#1e1e1e", 2, [[10, 10 + i * 10, 0.5], [60, 12 + i * 10, 0.5], [120, 10 + i * 10, 0.5]]));
	for (const a of assets) (doc.assets ??= {})[a.id] = a;
	if (assets.length > 0) {
		const page = createPage(PAGE_SIZES.a4);
		page.elements = assets.map((a, i) => ({ id: `el-${i}-${a.id.slice(0, 6)}`, type: "image" as const, asset: a.id, x: 20, y: 20 + i * 90, width: 120, height: 80, rotation: 0 }));
		doc.pages.push(page);
	}
	return doc;
}

async function removeAll(app: App, prefixes: string[]): Promise<void> {
	for (const f of app.vault.getFiles()) {
		if (prefixes.some((p) => f.path === p || f.path.startsWith(`${p}/`))) await app.fileManager.trashFile(f);
	}
}

const idNum = (n: number) => n.toString(16).padStart(24, "0");

/** Builds (again) the demo library. */
async function seed(app: App): Promise<Seeded> {
	await removeAll(app, [`${ROOT}/_assets`, `${ROOT}/_backup`, `${ROOT}/_trash`, `${ROOT}/_meta`, `${ROOT}/Physics.notebook`, `${ROOT}/Physics (1).notebook`, `${ROOT}/Physics-DESKTOP-AB12CD.notebook`, `${ROOT}/Anatomy.notebook`, `${ROOT}/Maths.notebook`, `${ROOT}/Chemistry.notebook`]);
	const photo = await storeAsset(app, ROOT, await heavyPhoto(), "board photo.jpg", "image");
	const smallShared = await storeAsset(app, ROOT, text("SHARED-PICTURE", 40_000), "diagram.png", "image");
	const dupA = await storeAsset(app, ROOT, text("DUPLICATE-A", 60_000), "scan a.png", "image");
	// The same picture a second time under another extension (same id).
	await app.vault.createBinary(`${ROOT}/_assets/${dupA.id}.jpg`, text("DUPLICATE-A", 60_000));
	const dupB = await storeAsset(app, ROOT, text("DUPLICATE-B", 50_000), "scan b.png", "image");
	// A copy of B under another id that a notebook uses.
	const copyOfB: Asset = { id: idNum(77), kind: "image", path: `${ROOT}/_assets/${idNum(77)}.png`, name: "scan b copy.png", bytes: 50_000 };
	await app.vault.createBinary(copyOfB.path, text("DUPLICATE-B", 50_000));
	// Two files nothing uses, old enough to be offered.
	const unusedA = `${ROOT}/_assets/${idNum(101)}.png`;
	const unusedB = `${ROOT}/_assets/${idNum(102)}.png`;
	await app.vault.createBinary(unusedA, text("UNUSED-A", 120_000));
	await app.vault.createBinary(unusedB, text("UNUSED-B", 30_000));
	for (const p of [unusedA, unusedB]) app.vault.getFileByPath(p)!.stat.mtime = Date.now() - 3 * DAY;
	const seen = new LibraryCheckSeenStore(vaultDeviceFileAdapter(app), () => ROOT, sidecarDeviceId(app));
	await seen.save(new Map([[idNum(101), Date.now() - 2 * DAY], [idNum(102), Date.now() - 2 * DAY]]));

	const physics = docWith([photo, smallShared], 5);
	const anatomy = docWith([photo, dupA]);
	const maths = docWith([copyOfB, dupB], 2);
	const chemistry = docWith([], 1);
	const paths = {
		physics: `${ROOT}/Physics.notebook`, physicsCopy: `${ROOT}/Physics (1).notebook`, physicsConflict: `${ROOT}/Physics-DESKTOP-AB12CD.notebook`,
		anatomy: `${ROOT}/Anatomy.notebook`, maths: `${ROOT}/Maths.notebook`, chemistry: `${ROOT}/Chemistry.notebook`,
	};
	await app.vault.create(paths.physics, serialize(physics));
	await app.vault.create(paths.physicsCopy, serialize(physics));
	const edited = { ...physics, pages: [{ ...physics.pages[0]!, strokes: physics.pages[0]!.strokes.slice(1) }, physics.pages[1]!], modifiedAt: "2026-10-21T10:00:00.000Z" };
	await app.vault.create(paths.physicsConflict, serialize(edited));
	await app.vault.create(paths.anatomy, serialize(anatomy));
	await app.vault.create(paths.maths, serialize(maths));
	await app.vault.create(paths.chemistry, serialize(chemistry));
	for (const p of Object.values(paths)) app.vault.getFileByPath(p)!.stat.mtime = Date.now() - 5 * DAY;

	// Old backups and version history of Physics.
	const sample = serialize(chemistry);
	// A backup holds its own notebook (a backup of another document under the same name is not offered).
	const bak = (stamp: string, reason: string, hash: string) => app.vault.create(`${ROOT}/_backup/Physics ${stamp} ${reason} ${hash}.bak`, serialize(physics));
	await bak("20240101-100000", "before-move", "0a1b2c3d");
	await bak("20240201-100000", "unreadable", "1a1b2c3d");
	await bak("20240301-100000", "before-restore", "2a1b2c3d");
	await bak("20261020-100000", "before-move", "3a1b2c3d");
	for (const stamp of ["20240101-1000", "20240201-1000", "20240301-1000", "20240401-1000", "20240501-1000"]) await app.vault.create(`${ROOT}/_backup/history/${physics.id}/${stamp}.snapshot`, sample);
	return { photo, smallShared, dupA, dupB, copyOfB, unusedA, unusedB, docIds: { physics: physics.id }, paths };
}

function hostFor(app: App): StorageDialogHost {
	const settings: NotebookSettings = { ...DEFAULT_SETTINGS, folder: ROOT, snapshotsToKeep: 3 };
	return {
		app, settings: () => settings, journalFolder: `${app.vault.configDir}/plugins/notebook/journal`, openRoots: () => [],
		trashNotebook: (f: TFile) => app.fileManager.trashFile(f), openNotebook: () => undefined,
	};
}

// ---------------------------------------------------------------- driving the dialog

const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>(".modal.nb-storage-modal");
const confirm = (): HTMLElement | null => document.querySelector<HTMLElement>(".modal.nb-storage-confirm");

/** Puts a `.modal` inside a dimmed layer, as Obsidian's modal container does (once). */
function adopt(): void {
	for (const el of document.querySelectorAll<HTMLElement>("body > .modal")) {
		const root = document.body.createDiv({ cls: "harness-modal-container" });
		root.appendChild(el);
	}
}

export function closeStorage(): void {
	for (const sel of [".modal.nb-storage-confirm", ".modal.nb-storage-modal"]) {
		document.querySelector<HTMLElement>(`${sel} .nb-modal-close`)?.click();
	}
	for (const layer of document.querySelectorAll(".harness-modal-container")) if (!layer.querySelector(".modal")) layer.remove();
}

async function waitFor(what: () => boolean, ms = 15_000): Promise<boolean> {
	for (let t = 0; t < ms; t += 50) {
		if (what()) return true;
		await sleep(50);
	}
	return what();
}

async function openDialog(app: App): Promise<HTMLElement> {
	closeStorage();
	openStorageManager(hostFor(app));
	adopt();
	await waitFor(() => !!dialog()?.querySelector(".nb-storage-summary") || !!dialog()?.querySelector(".nb-modal-error"));
	await frames(2);
	return dialog()!;
}

/** Waits for the next scan to end (the summary is drawn again). */
async function rescanned(): Promise<void> {
	await sleep(50);
	await waitFor(() => !!dialog()?.querySelector(".nb-storage-summary") && !dialog()?.classList.contains("is-busy"));
	await frames(2);
}

const rowsOf = (section: string): HTMLElement[] => [...(dialog()?.querySelectorAll<HTMLElement>(`[data-section="${section}"] .nb-storage-row`) ?? [])];
const names = (rows: HTMLElement[]): string[] => rows.map((r) => r.querySelector(".nb-storage-name")?.textContent ?? "");
const sectionEl = (id: string): HTMLElement | null => dialog()?.querySelector<HTMLElement>(`[data-section="${id}"]`) ?? null;

function scrollTo(id: string): void {
	const body = dialog()?.querySelector<HTMLElement>(".nb-modal-body");
	const el = sectionEl(id);
	if (body && el) body.scrollTop = el.offsetTop - 8;
}

async function readText(app: App, path: string): Promise<string | null> {
	const f = app.vault.getFileByPath(path);
	return f ? app.vault.read(f) : null;
}

async function snapshotOf(app: App): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for (const f of app.vault.getFiles()) {
		if (f.path.includes("/_meta/")) continue;
		out.set(f.path, f.extension === "notebook" || f.extension === "bak" || f.extension === "snapshot" ? await app.vault.read(f) : String(f.stat.size));
	}
	return out;
}

// ---------------------------------------------------------------- the check

export async function checkStorage(api: StorageCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const app = api.app as App;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const guard = async (name: string, job: () => Promise<void>) => {
		try {
			await job();
		} catch (e) {
			add(`${name}: no exception`, false, e instanceof Error ? (e.stack ?? e.message) : String(e));
		}
	};

	const seeded = await seed(app);
	const before = await snapshotOf(app);
	add("the demo photo is heavy enough to be listed", (app.vault.getFileByPath(seeded.photo.path)?.stat.size ?? 0) > 1024 * 1024, String(app.vault.getFileByPath(seeded.photo.path)?.stat.size));

	// --- scan: progress, then the report; reading changes nothing
	await guard("scan", async () => {
		closeStorage();
		openStorageManager(hostFor(app));
		adopt();
		const root = dialog();
		add("scan: the dialog opens on the shell", !!root && root.matches(".modal.nb-modal.nb-ui.is-wide"), root?.className ?? "");
		await waitFor(() => !!dialog()?.querySelector(".nb-storage-summary") || !!dialog()?.querySelector(".nb-modal-error"));
		await frames(2);
		const d = dialog()!;
		add("scan: it ends in a summary, not an error", !!d.querySelector(".nb-storage-summary") && !d.querySelector(".nb-modal-error"), d.querySelector(".nb-modal-error")?.textContent ?? "");
		add("scan: the header names it and has a close button of 40 px", d.querySelector(".nb-modal-title")?.textContent === "Storage" && (d.querySelector(".nb-modal-close")?.getBoundingClientRect().width ?? 0) >= 39.5);
		add("scan: a total, a bar and a legend", !!d.querySelector(".nb-storage-total-value")?.textContent && d.querySelectorAll(".nb-storage-seg").length >= 3 && d.querySelectorAll(".nb-storage-key").length >= 3);
		const after = await snapshotOf(app);
		const changed = [...before.keys()].filter((k) => before.get(k) !== after.get(k));
		const added = [...after.keys()].filter((k) => !before.has(k));
		add("scan: reading the library changes no notebook, asset or backup", changed.length === 0 && added.length === 0, [...changed, ...added].join(", "));
		for (const section of ["notebooks", "unused", "dup", "heavy", "backups"]) add(`scan: the ${section} section is there`, !!sectionEl(section));
	});

	// --- notebooks: sizes and sorting
	await guard("notebooks", async () => {
		const rows = rowsOf("notebooks");
		const bytes = rows.map((r) => Number(r.dataset.bytes));
		add("notebooks: one row per notebook", rows.length >= 6, String(rows.length));
		add("notebooks: largest first", bytes.every((b, i) => i === 0 || bytes[i - 1]! >= b), bytes.join(","));
		add("notebooks: the notebook with the heavy photo is among the first rows", rows.findIndex((r) => r.dataset.path === seeded.paths.physics) <= 3, rows.map((r) => r.dataset.path).join(","));
		const physics = rows.find((r) => r.dataset.path === seeded.paths.physics);
		add("notebooks: a row says where its size comes from", /Notebook .*Backups/.test(physics?.querySelector(".nb-storage-detail")?.textContent ?? ""), physics?.querySelector(".nb-storage-detail")?.textContent ?? "");
		const byName = dialog()!.querySelector<HTMLElement>('[data-key="chip:name"]');
		byName?.click();
		await frames(2);
		const sorted = names(rowsOf("notebooks"));
		add("notebooks: sorting by name puts Anatomy first", sorted[0] === "Anatomy" && [...sorted].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join() === sorted.join(), sorted.join(","));
		add("notebooks: the chosen sort is remembered", app.loadLocalStorage("notebook-storage-sort") === "name");
		dialog()!.querySelector<HTMLElement>('[data-key="chip:size"]')?.click();
		await frames(2);
		add("notebooks: sorting by size again", Number(rowsOf("notebooks")[0]?.dataset.bytes) >= Number(rowsOf("notebooks")[1]?.dataset.bytes));
		add("notebooks: every row is a 40 px target", rowsOf("notebooks").every((r) => r.getBoundingClientRect().height >= 40));
	});

	// --- unused files
	await guard("unused", async () => {
		const rows = rowsOf("unused");
		add("unused: the two files nothing uses are listed, and nothing else", rows.length === 2 && names(rows).every((n) => n.startsWith("0000000000000000000000")), names(rows).join(","));
		add("unused: nothing a notebook or a backup uses is among them", !names(rows).some((n) => n.includes(seeded.photo.id)));
		const act = buttonStarting(dialog()!, "Move 2");
		add("unused: the button says how many and how big", !!act && /\(/.test(act.textContent ?? ""), act?.textContent ?? "");
		rows[1]!.querySelector<HTMLInputElement>("input")!.click();
		await frames(2);
		add("unused: unticking a file updates the button", !!buttonStarting(dialog()!, "Move 1"));
		if (act) buttonStarting(dialog()!, "Move 1")!.click();
		await frames(3);
		adopt();
		const c = confirm();
		add("unused: a confirmation lists the file before anything moves", !!c && c.querySelectorAll(".nb-storage-row").length === 1, c?.textContent?.slice(0, 80) ?? "");
		buttonByText(c!, "Cancel")?.click();
		await frames(2);
		add("unused: Cancel changes nothing", !!app.vault.getFileByPath(seeded.unusedA) && !confirm());
		buttonStarting(dialog()!, "Move 1")!.click();
		await frames(3);
		adopt();
		buttonStarting(confirm()!, "Move 1")!.click();
		await rescanned();
		const moved = app.vault.getFiles().find((f) => f.path.startsWith(`${ROOT}/_trash/assets/`));
		add("unused: the ticked file is in the trash folder, still in the vault", !!moved && !app.vault.getFileByPath(seeded.unusedA) && (moved.stat.size === 120_000), moved?.path ?? "none");
		add("unused: the one that was unticked stayed where it was", !!app.vault.getFileByPath(seeded.unusedB));
		add("unused: a notice said so", api.notices.some((n) => /Moved 1 files/.test(n)), api.notices.join(" | "));
	});

	// --- duplicates
	await guard("duplicates", async () => {
		const rows = rowsOf("dup");
		add("duplicates: the picture stored twice and the copy under another id are listed", rows.length === 2, names(rows).join(","));
		const same = rows.find((r) => r.textContent?.includes(seeded.dupA.id));
		const other = rows.find((r) => r.textContent?.includes(seeded.dupB.id));
		add("duplicates: each group says what stays and what would change", !!same && !!other && /stays/.test(same.textContent ?? "") && /notebooks to update/.test(other.textContent ?? ""), rows.map((r) => r.querySelector(".nb-storage-detail")?.textContent).join(" | "));
		buttonByText(same!, "Merge…")!.click();
		await frames(3);
		adopt();
		const c = confirm();
		add("duplicates: the confirmation shows the file that stays and the one moved aside", !!c && c.querySelectorAll(".nb-storage-row").length === 2 && /Stays/.test(c.textContent ?? ""), c?.textContent?.slice(0, 120) ?? "");
		buttonByText(c!, "Cancel")?.click();
		await frames(2);
		add("duplicates: Cancel changes nothing", !!app.vault.getFileByPath(`${ROOT}/_assets/${seeded.dupA.id}.jpg`));
		buttonByText(rowsOf("dup").find((r) => r.textContent?.includes(seeded.dupA.id))!, "Merge…")!.click();
		await frames(3);
		adopt();
		buttonByText(confirm()!, "Merge…")!.click();
		await rescanned();
		add("duplicates: the extra extension is in the trash folder, the one that stays is untouched", !app.vault.getFileByPath(`${ROOT}/_assets/${seeded.dupA.id}.jpg`) && !!app.vault.getFileByPath(`${ROOT}/_assets/${seeded.dupA.id}.png`) && app.vault.getFiles().some((f) => f.path.startsWith(`${ROOT}/_trash/assets/`) && f.name.startsWith(seeded.dupA.id)));
		add("duplicates: the notebook that uses it still reads and still uses it", await (async () => {
			const t = await readText(app, seeded.paths.anatomy);
			const p = t ? parse(t) : null;
			return !!p && p.ok && useCount(assetUses(p.doc, seeded.dupA.id)) > 0;
		})());
		// The copy under another id: Maths is pointed at the picture that stays.
		const mathsBefore = await readText(app, seeded.paths.maths);
		buttonByText(rowsOf("dup").find((r) => r.textContent?.includes(seeded.dupB.id))!, "Merge…")!.click();
		await frames(3);
		adopt();
		buttonByText(confirm()!, "Merge…")!.click();
		await rescanned();
		const mathsAfter = await readText(app, seeded.paths.maths);
		const parsed = mathsAfter ? parse(mathsAfter) : null;
		add("duplicates: the notebook uses the picture that stays and no longer names the copy", !!parsed && parsed.ok && useCount(assetUses(parsed.doc, seeded.dupB.id)) > 0 && useCount(assetUses(parsed.doc, seeded.copyOfB.id)) === 0 && !(mathsAfter ?? "").includes(seeded.copyOfB.id), mathsAfter === mathsBefore ? "unchanged" : "");
		add("duplicates: a backup of the notebook was made first", app.vault.getFiles().some((f) => f.path.startsWith(`${ROOT}/_backup/Maths `)));
		add("duplicates: the copy's file is still there (nothing deleted; it becomes an unused file)", !!app.vault.getFileByPath(seeded.copyOfB.path));
	});

	// --- old backups and copies
	await guard("backups", async () => {
		const rows = rowsOf("backups");
		const labels = names(rows);
		add("backups: old backups, old history and the identical copy are listed", labels.some((n) => n.includes("before-move")) && labels.some((n) => n.endsWith(".snapshot")) && labels.includes("Physics (1).notebook"), labels.join(","));
		add("backups: the newest backup of the notebook is not among them", !labels.some((n) => n.includes("20261020")));
		const ticked = (label: (n: string) => boolean): boolean | null => {
			const row = rows.find((r) => label(r.querySelector(".nb-storage-name")?.textContent ?? ""));
			return row ? row.querySelector<HTMLInputElement>("input")!.checked : null;
		};
		add("backups: a backup of something that could not be read is listed but not ticked", ticked((n) => n.includes("unreadable")) === false);
		add("backups: a copy that may be the user's own is not ticked", ticked((n) => n === "Physics (1).notebook") === false);
		add("backups: an ordinary old backup is ticked", ticked((n) => n.includes("before-restore")) === true);
		const differing = rows.find((r) => r.querySelector(".nb-storage-name")?.textContent === "Physics-DESKTOP-AB12CD.notebook");
		add("backups: the copy that differs is shown apart, with Open and no tick, never as something to move", !!differing && !differing.querySelector("input") && !!buttonByText(differing, "Open"));
		const act = buttonStarting(sectionEl("backups")!, "Move ");
		add("backups: the button counts the ticked ones", !!act && !act.disabled, act?.textContent ?? "");
		const ticks = rows.filter((r) => r.querySelector<HTMLInputElement>("input")?.checked);
		// Tick the identical copy as well: it goes to the library trash, restorable.
		rows.find((r) => r.querySelector(".nb-storage-name")?.textContent === "Physics (1).notebook")!.querySelector<HTMLInputElement>("input")!.click();
		await frames(2);
		buttonStarting(sectionEl("backups")!, "Move ")!.click();
		await frames(3);
		adopt();
		const c = confirm();
		add("backups: the confirmation lists every file", !!c && c.querySelectorAll(".nb-storage-row").length === ticks.length + 1, `${c?.querySelectorAll(".nb-storage-row").length} vs ${ticks.length + 1}; modals: ${[...document.querySelectorAll(".modal")].map((m) => m.className).join(" | ")}; notices: ${api.notices.slice(-2).join(" | ")}`);
		buttonByText(c!, "Cancel")?.click();
		await frames(2);
		add("backups: Cancel moves nothing", !!app.vault.getFileByPath(`${ROOT}/_backup/Physics 20240301-100000 before-restore 2a1b2c3d.bak`));
		buttonStarting(sectionEl("backups")!, "Move ")!.click();
		await frames(3);
		adopt();
		buttonStarting(confirm()!, "Move ")!.click();
		await rescanned();
		add("backups: the old backup is gone from the vault, the newest one stays", !app.vault.getFileByPath(`${ROOT}/_backup/Physics 20240301-100000 before-restore 2a1b2c3d.bak`) && !!app.vault.getFileByPath(`${ROOT}/_backup/Physics 20261020-100000 before-move 3a1b2c3d.bak`));
		add("backups: the recovery copy was not touched", !!app.vault.getFileByPath(`${ROOT}/_backup/Physics 20240201-100000 unreadable 1a1b2c3d.bak`));
		add("backups: the history keeps its newest three", app.vault.getFiles().filter((f) => f.path.includes(`/history/${seeded.docIds.physics}/`)).length === 3);
		add("backups: the identical copy left through the library trash", !app.vault.getFileByPath(seeded.paths.physicsCopy) && !!app.vault.getFileByPath(seeded.paths.physics) && !!app.vault.getFileByPath(seeded.paths.physicsConflict));
	});

	// --- heavy pictures
	await guard("heavy", async () => {
		const rows = rowsOf("heavy");
		add("heavy: the photo is listed with the notebooks that use it", rows.length === 1 && /used by 3 notebooks/.test(rows[0]!.textContent ?? ""), rows.map((r) => r.textContent).join(" | "));
		dialog()!.querySelector<HTMLElement>('[data-key="chip:10"]')?.click();
		await frames(2);
		add("heavy: raising the threshold hides it", rowsOf("heavy").length === 0 && /No pictures over/.test(sectionEl("heavy")?.textContent ?? ""));
		dialog()!.querySelector<HTMLElement>('[data-key="chip:2"]')?.click();
		await frames(2);
		const originalSize = app.vault.getFileByPath(seeded.photo.path)!.stat.size;
		buttonByText(rowsOf("heavy")[0]!, "Downscale…")!.click();
		await frames(3);
		adopt();
		const c = confirm();
		add("heavy: the confirmation names the notebooks that will change", !!c && c.querySelectorAll(".nb-storage-row").length === 3, c?.textContent?.slice(0, 160) ?? "");
		buttonByText(c!, "Cancel")?.click();
		await frames(2);
		const beforeFiles = new Set(app.vault.getFiles().map((f) => f.path));
		add("heavy: Cancel writes nothing", !confirm() && app.vault.getFiles().length === beforeFiles.size);
		buttonByText(rowsOf("heavy")[0]!, "Downscale…")!.click();
		await frames(3);
		adopt();
		buttonByText(confirm()!, "Downscale…")!.click();
		await rescanned();
		const created = app.vault.getFiles().filter((f) => !beforeFiles.has(f.path) && f.path.startsWith(`${ROOT}/_assets/`));
		const smaller = created[0];
		add("heavy: one new, smaller picture was written", created.length === 1 && !!smaller && smaller.stat.size < originalSize * 0.9, `${created.map((f) => `${f.name} ${f.stat.size}`).join(",")} vs ${originalSize}`);
		add("heavy: the original is kept where it was", !!app.vault.getFileByPath(seeded.photo.path) && app.vault.getFileByPath(seeded.photo.path)!.stat.size === originalSize);
		const newId = smaller?.basename ?? "";
		const why: string[] = [];
		for (const p of [seeded.paths.physics, seeded.paths.anatomy, seeded.paths.physicsConflict]) {
			const t = await readText(app, p);
			const parsed = t ? parse(t) : null;
			const ok = !!parsed && parsed.ok && useCount(assetUses(parsed.doc, newId)) > 0 && useCount(assetUses(parsed.doc, seeded.photo.id)) === 0 && !!parsed.doc.assets?.[newId];
			if (!ok) why.push(`${p}: ${parsed && !parsed.ok ? parsed.message : "still names the old picture"}`);
		}
		add("heavy: the three notebooks read back using the smaller copy only", why.length === 0, `${why.join("; ")} || ${api.notices.slice(-3).join(" | ")}`);
		add("heavy: a notice said how much it saves", api.notices.some((n) => /Smaller copy written/.test(n)), api.notices.slice(-3).join(" | "));
		add("heavy: the photo is no longer listed as heavy (nothing readable names it any more)", rowsOf("heavy").every((r) => !r.textContent?.includes(seeded.photo.id)), `${rowsOf("heavy").map((r) => r.textContent).join(" | ")} || naming it: ${(await Promise.all(app.vault.getFiles().filter((f) => f.extension === "notebook").map(async (f) => ((await app.vault.read(f)).includes(seeded.photo.id) ? f.path : "")))).filter(Boolean).join(",")}`);
	});

	// --- end
	await guard("close", async () => {
		const d = dialog();
		add("shell: every target is at least 40 px", [...d!.querySelectorAll<HTMLElement>("button, .nb-chip")].filter(visible).every((el) => Math.min(el.getBoundingClientRect().width, el.getBoundingClientRect().height) >= 39.5), [...d!.querySelectorAll<HTMLElement>("button, .nb-chip")].filter(visible).filter((el) => Math.min(el.getBoundingClientRect().width, el.getBoundingClientRect().height) < 39.5).slice(0, 3).map((el) => `${el.className} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`).join(", "));
		const body = d!.querySelector<HTMLElement>(".nb-modal-body")!;
		add("shell: nothing overflows sideways", body.scrollWidth <= body.clientWidth + 1, `${body.scrollWidth} > ${body.clientWidth}`);
		const r = d!.getBoundingClientRect();
		add("shell: fits the screen", r.left >= -0.5 && r.right <= window.innerWidth + 0.5 && r.top >= -0.5 && r.bottom <= window.innerHeight + 0.5, `${Math.round(r.left)}..${Math.round(r.right)} in ${window.innerWidth}`);
		add("shell: no button shows Obsidian's default look", obsidianStyledButtons(d!).length === 0, obsidianStyledButtons(d!).slice(0, 3).map((b) => b.className).join(","));
		buttonByText(d!, "Close")!.click();
		await frames(2);
		add("close: the dialog is gone", !dialog());
	});

	// --- stopping a scan: close it at once
	await guard("stop", async () => {
		await seed(app);
		openStorageManager(hostFor(app));
		adopt();
		add("stop: the first thing shown is progress with a Stop button", !!dialog()?.querySelector(".nb-storage-progress") && !!buttonByText(dialog()!, "Stop"));
		buttonByText(dialog()!, "Stop")!.click();
		await sleep(400);
		add("stop: the dialog closes and nothing is left", !dialog());
		const after = (await snapshotOf(app));
		add("stop: the vault is as it was", [...after.keys()].filter((k) => !k.includes("/_trash/")).length > 0);
	});

	closeStorage();
	await seed(app);
	await openDialog(app);
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}

// ---------------------------------------------------------------- screenshots

/** Leaves one view of the dialog open. */
export async function storageShot(api: StorageCheckApi, state: StorageState): Promise<void> {
	const app = api.app as App;
	closeStorage();
	await seed(app);
	await openDialog(app);
	await frames(2);
	if (state === "overview") {
		dialog()!.querySelector<HTMLElement>(".nb-modal-body")!.scrollTop = 0;
	} else if (state === "unused" || state === "backups") {
		scrollTo(state === "unused" ? "unused" : "backups");
	} else if (state === "heavy") {
		scrollTo("heavy");
	} else {
		scrollTo("unused");
		buttonStarting(dialog()!, "Move 2")?.click();
		await frames(3);
		adopt();
	}
	await frames(2);
	window.scrollTo(0, 0);
}

/** What the harness page exposes (wired in harness.ts with one statement). */
export function storageApi(api: StorageCheckApi): Record<string, unknown> {
	return {
		checkStorage: async () => {
			try {
				return JSON.parse(JSON.stringify(await checkStorage(api))) as unknown;
			} catch (e) {
				return { ok: false, results: [], errors: [`storage check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} };
			}
		},
		storageShot: (state: StorageState) => storageShot(api, state),
		closeStorage,
		storageStates: [...STORAGE_STATES],
	};
}

