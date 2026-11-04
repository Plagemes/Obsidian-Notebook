/**
 * Smoke check of bulk import (0.16, roadmap #80; `doc=bulk`, npm run harness:check): the real dialog, runner, asset store and
 * notebook creation on the harness vault. Files are made in the page (real PNGs from a canvas, fake PDFs whose page count the
 * stand-in reports); the dialog is driven through the DOM: the list with its skip reasons, unique names against a notebook
 * that already exists, the editable name, "all images into one notebook", paper and cover, the run with its progress, a stop in
 * the middle, the summary and "Open". A drop of files on a folder row is simulated with a real DragEvent. `bulkShot(state)`
 * leaves one view open for the screenshots. The stand-in vault lives in memory: nothing here touches a real vault.
 */
import type { App, TFile } from "obsidian";
import { BulkImportDialog, type BulkImportHost } from "../../src/library/bulk-import-dialog";
import { attachFileDrop, fileSource, type FileDropTarget } from "../../src/library/bulk-drop";
import { BulkSkipError, runBulkImport, type BulkControl, type BulkJob, type BulkLook } from "../../src/library/bulk-import-run";
import { artStyleFor } from "../../src/ui/art/generative-art";
import { photoSize, PhotoDecodeError } from "../../src/scan/decode";
import { createDocument } from "../../src/model/document";
import { parse } from "../../src/model/serialize";
import { createNotebook } from "../../src/storage/notebooks";
import { existsInsensitive } from "../../src/storage/names";
import { storeAsset } from "../../src/view/media";
import { joinPath } from "../../src/view/create-logic";
import { NEW_NOTEBOOK_EXTENSION } from "../../src/storage/format";
import { obsidianStyledButtons } from "./library-check";
import type { CheckResult } from "./reading-check";
import { normalizePath } from "obsidian";

export interface BulkCheckApi {
	app: unknown;
	errors: string[];
	notices: string[];
}

/** What the harness screenshots, in this order. */
export const BULK_STATES = ["form", "images", "progress", "summary", "drop"] as const;
export type BulkState = typeof BULK_STATES[number];

const ROOT = "Notebooks";
const frames = (n = 2) => new Promise<void>((resolve) => {
	let left = n;
	const step = () => (--left <= 0 ? resolve() : window.requestAnimationFrame(step));
	window.requestAnimationFrame(step);
});
const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>(".modal.nb-bulk");
const q = <T extends Element = HTMLElement>(sel: string) => dialog()?.querySelector<T>(sel) ?? null;
const qa = (sel: string) => [...(dialog()?.querySelectorAll<HTMLElement>(sel) ?? [])];
const textOf = (el: Element | null | undefined) => el?.textContent ?? "";
const buttonStarting = (text: string) => qa("button").find((b) => textOf(b).startsWith(text)) ?? null;
const chip = (label: string) => qa(".nb-chip").find((c) => textOf(c).startsWith(label)) ?? null;

async function waitFor(what: () => boolean, ms = 15_000): Promise<boolean> {
	for (let t = 0; t < ms; t += 40) {
		if (what()) return true;
		await sleep(40);
	}
	return what();
}

/** Puts a `.modal` inside a dimmed layer, as Obsidian's modal container does (once). */
function adopt(): void {
	for (const el of document.querySelectorAll<HTMLElement>("body > .modal")) {
		const root = document.body.createDiv({ cls: "harness-modal-container" });
		root.appendChild(el);
	}
}

export function closeBulk(): void {
	q(".nb-modal-close")?.click();
	for (const layer of document.querySelectorAll(".harness-modal-container")) if (!layer.querySelector(".modal")) layer.remove();
}

// ---------------------------------------------------------------- the files

const encode = (s: string) => new TextEncoder().encode(s);

/** A real PNG of the given colour and shape. */
async function png(name: string, color: string, w = 400, h = 300): Promise<File> {
	const c = createEl("canvas");
	c.width = w;
	c.height = h;
	const ctx = c.getContext("2d")!;
	ctx.fillStyle = color;
	ctx.fillRect(0, 0, w, h);
	ctx.fillStyle = "#fff";
	ctx.fillRect(w / 4, h / 4, w / 2, h / 2);
	const blob = await new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("no png"))), "image/png"));
	return new File([blob], name, { type: "image/png" });
}

const pdf = (name: string, pages = 3) => new File([encode(`%PDF-1.4\n% pages=${pages}\n${"x".repeat(2000)}`)], name, { type: "application/pdf" });

async function sampleFiles(): Promise<File[]> {
	return [
		pdf("Anatomy.pdf", 4),
		pdf("Chemistry notes.pdf", 2),
		await png("scan 10.png", "#2F80F7"),
		await png("scan 2.png", "#16C2A3", 300, 400),
		await png("scan 1.png", "#F59E0B"),
		new File([encode("just some text")], "notes.txt", { type: "text/plain" }),
		new File([encode("not a pdf at all")], "broken.pdf", { type: "application/pdf" }),
		new File([new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0])], "holiday.heic", { type: "image/heic" }),
		pdf("Anatomy.pdf", 4),
	];
}

// ---------------------------------------------------------------- the host

interface HostState {
	opened: string[];
	finished: string[][];
	notified: string[];
	/** Waits before each file (the stop test and the progress screenshot); resolves when released. */
	gate: Promise<void> | null;
	pdfPages: Map<string, number>;
}

function hostFor(app: App, st: HostState): BulkImportHost {
	return {
		root: () => ROOT,
		allFolders: () => ["Notebooks", "Notebooks/Anatomia", "Notebooks/Matematica"],
		taken: (dir, clean) => existsInsensitive(app.vault, normalizePath(joinPath(dir, `${clean}.${NEW_NOTEBOOK_EXTENSION}`))),
		run: (jobs: readonly BulkJob[], dir: string, look: BulkLook, ctl: BulkControl) => runBulkImport<TFile>(jobs, dir, look, {
			store: async (bytes, name, kind) => {
				const asset = await storeAsset(app, ROOT, bytes, name, kind);
				// The fake PDF says how many pages it has in its second line.
				if (kind === "pdf") st.pdfPages.set(asset.id, Number(/pages=(\d+)/.exec(new TextDecoder().decode(bytes.slice(0, 64)))?.[1] ?? 0));
				return asset;
			},
			pdfSizes: (id) => {
				const n = st.pdfPages.get(id) ?? 0;
				return Promise.resolve(Array.from({ length: n }, () => ({ width: 595.28, height: 841.89 })));
			},
			imageSize: (bytes, name, type) => photoSize(bytes, name, type).catch((e: unknown) => {
				throw e instanceof PhotoDecodeError && e.reason === "heic" ? new BulkSkipError("heic") : e;
			}),
			create: async (d, name, doc) => {
				const file = await createNotebook(app, d, name, doc);
				return { file, path: file.path };
			},
			artStyle: (name) => artStyleFor(name),
			yieldToUi: async () => {
				await sleep(0);
				if (st.gate) await st.gate;
			},
		}, ctl),
		open: (path) => void st.opened.push(path),
		finished: (outcomes) => void st.finished.push(outcomes.flatMap((o) => (o.path !== null ? [o.path] : []))),
		notify: (text) => void st.notified.push(text),
		today: () => "2026-11-04",
	};
}

async function seed(app: App): Promise<void> {
	for (const f of ["Notebooks", "Notebooks/Anatomia", "Notebooks/Matematica"]) if (!app.vault.getFolderByPath(f)) await app.vault.createFolder(f);
	// A notebook that already has the name of an incoming PDF: it must stay as it is.
	if (!app.vault.getFileByPath("Notebooks/Anatomy.notebook")) await createNotebook(app, ROOT, "Anatomy", createDocument());
	for (const f of app.vault.getFiles()) {
		if (f.path.startsWith("Notebooks/Anatomia/") && f.extension === "notebook") await app.fileManager.trashFile(f);
	}
}

async function open(app: App, files: File[], st: HostState, folder = ROOT): Promise<BulkImportDialog> {
	closeBulk();
	const d = new BulkImportDialog(app, hostFor(app, st), files.map(fileSource), folder);
	d.open();
	adopt();
	await waitFor(() => qa(".nb-bulk-row").length > 0);
	await frames(2);
	return d;
}

const newState = (): HostState => ({ opened: [], finished: [], notified: [], gate: null, pdfPages: new Map() });

function typeInto(input: HTMLInputElement | null, text: string): void {
	if (!input) throw new Error("no input");
	input.focus();
	input.value = text;
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

// ---------------------------------------------------------------- the check

export async function checkBulk(api: BulkCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	try {
		return await runChecks(api, results, add);
	} catch (e) {
		add(`stopped: ${(e as Error).message}`, false, `after: ${results[results.length - 1]?.name ?? "start"}`);
		return { ok: false, results, errors: api.errors, notices: api.notices, env: {} };
	}
}

async function runChecks(api: BulkCheckApi, results: CheckResult[], add: (name: string, ok: unknown, detail?: string) => void): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const app = api.app as App;
	await seed(app);
	const before = await app.vault.read(app.vault.getFileByPath("Notebooks/Anatomy.notebook")!);
	const st = newState();
	const files = await sampleFiles();

	// --- the list
	await open(app, files, st);
	const rows = () => qa(".nb-bulk-row:not(.is-skipped)");
	add("opens as a design-system dialog", !!dialog()?.classList.contains("nb-ui") && !!q(".nb-modal-head") && !!q(".nb-modal-foot"));
	add("one row per notebook: 2 PDFs and 3 images", rows().length === 5, `${rows().length}`);
	add("the names come from the files", rows().map((r) => r.querySelector<HTMLInputElement>(".nb-bulk-name")?.placeholder).join("|") === "Anatomy|Chemistry notes|scan 10|scan 2|scan 1", rows().map((r) => r.querySelector<HTMLInputElement>(".nb-bulk-name")?.placeholder).join("|"));
	add("a name that exists is shown as it will be saved", textOf(rows()[0]?.querySelector(".nb-bulk-hint")) === "Will be saved as “Anatomy 2”", textOf(rows()[0]?.querySelector(".nb-bulk-hint")));
	const skipped = qa(".nb-bulk-row.is-skipped");
	add("four files are left out, each with its reason", skipped.length === 4 && skipped.map((r) => r.dataset.reason).sort().join(",") === "corrupt,duplicate,heic,unsupported", skipped.map((r) => r.dataset.reason).join(","));
	add("and the same file listed twice makes one notebook", rows().filter((r) => textOf(r.querySelector(".nb-bulk-detail")).startsWith("Anatomy.pdf")).length === 1);
	add("the mode choice appears when there are several images", !!chip("All images into one notebook"));
	add("the import button says how many notebooks", !!buttonStarting("Import 5 notebooks"), qa(".nb-modal-foot button").map((b) => textOf(b)).join("|"));
	const small = qa("button, input, select").filter((b) => {
		const r = b.getBoundingClientRect();
		return r.width > 0 && (r.height < 31.5 || r.width < 31.5);
	});
	add("every control is a real target (30 px or more)", small.length === 0, small.map((b) => b.className).join(", "));
	const body = q(".nb-modal-body")!;
	add("nothing overflows sideways", body.scrollWidth <= body.clientWidth + 1, `${body.scrollWidth} > ${body.clientWidth}`);
	const modal = dialog();
	add("no button shows Obsidian's default button look", !!modal && obsidianStyledButtons(modal).length === 0);

	// --- editing: a name, the group of images, the paper and the cover
	typeInto(rows()[1]?.querySelector<HTMLInputElement>(".nb-bulk-name") ?? null, "Chemistry/Lab");
	chip("All images into one notebook")?.click();
	await frames(2);
	add("one notebook for all images: PDFs stay apart", rows().length === 3, `${rows().length}`);
	add("the images share a default name with the date", rows().some((r) => r.querySelector<HTMLInputElement>(".nb-bulk-name")?.placeholder === "Images 2026-11-04"));
	add("the group lists its images", rows().some((r) => textOf(r.querySelector(".nb-bulk-detail")).startsWith("3 images")));
	typeInto(rows().find((r) => r.dataset.key === "bulk:images")?.querySelector<HTMLInputElement>(".nb-bulk-name") ?? null, "Whiteboard");
	chip("Dotted")?.click();
	await frames(2);
	q<HTMLElement>('.nb-bulk-swatch[aria-label="Teal"]')?.click();
	await frames(2);
	add("the paper and the cover are marked", chip("Dotted")?.classList.contains("is-active") === true && q('.nb-bulk-swatch[aria-label="Teal"]')?.getAttribute("aria-checked") === "true");
	add("the typed names survive the redraws", rows().map((r) => r.querySelector<HTMLInputElement>(".nb-bulk-name")?.value).join("|") === "|Chemistry/Lab|Whiteboard", rows().map((r) => r.querySelector<HTMLInputElement>(".nb-bulk-name")?.value).join("|"));
	const folderSelect = q<HTMLSelectElement>(".nb-bulk-select")!;
	folderSelect.value = "Notebooks/Anatomia";
	folderSelect.dispatchEvent(new Event("change", { bubbles: true }));
	await frames(2);
	add("the folder can be chosen", folderSelect.value === "Notebooks/Anatomia");
	add("and the name check follows the folder (Anatomy is free there)", textOf(rows()[0]?.querySelector(".nb-bulk-hint")) === "");

	// --- the run
	buttonStarting("Import 3 notebooks")?.click();
	await frames(2);
	add("the run shows progress", !!q(".nb-bulk-progress") || !!q(".nb-bulk-summary"));
	await waitFor(() => !!q(".nb-bulk-summary"));
	await frames(2);
	const made = (path: string) => app.vault.getFileByPath(path);
	add("the PDF became a notebook in the chosen folder", !!made("Notebooks/Anatomia/Anatomy.notebook"));
	add("the typed name was used (sanitised)", !!made("Notebooks/Anatomia/Chemistry Lab.notebook"));
	add("all images share one notebook", !!made("Notebooks/Anatomia/Whiteboard.notebook"));
	const readDoc = async (path: string) => {
		const f = made(path);
		const parsed = f ? parse(await app.vault.read(f)) : null;
		return parsed?.ok ? parsed.doc : null;
	};
	const anatomy = await readDoc("Notebooks/Anatomia/Anatomy.notebook");
	add("the PDF notebook has one page per PDF page, backed by the PDF", anatomy?.pages.length === 4 && anatomy.pages.every((p) => p.background?.kind === "pdf" && p.paper.kind === "dotted"), `${anatomy?.pages.length}`);
	add("with the chosen cover", anatomy?.meta?.cover === "#16C2A3" && anatomy.meta.coverArt?.kind === "art");
	const board = await readDoc("Notebooks/Anatomia/Whiteboard.notebook");
	add("the image notebook has a page per image in file-name order, shaped like the pictures", board?.pages.length === 3 && board.pages.map((p) => Math.round((p.height / p.width) * 100)).join(",") === "75,133,75", board?.pages.map((p) => Math.round((p.height / p.width) * 100)).join(","));
	const first = board?.pages[0]?.background;
	const firstAsset = first?.kind === "image" ? board?.assets?.[first.asset] : undefined;
	add("the first page is 'scan 1' (natural order)", firstAsset?.name === "scan 1.png", firstAsset?.name ?? "");
	add("the notebook that already existed is untouched", (await app.vault.read(app.vault.getFileByPath("Notebooks/Anatomy.notebook")!)) === before);
	add("the summary says what was made and what was left out", textOf(q(".nb-bulk-summary")).includes("3 notebooks created · 9 pages") && textOf(q(".nb-bulk-summary")).includes("4 left out"), textOf(q(".nb-bulk-summary")));
	add("the reasons are listed", qa(".nb-bulk-row.is-skipped").length === 4 && textOf(dialog()).includes("HEIC photos cannot be read here"));
	add("the board hook got the new notebooks", st.finished.length === 1 && st.finished[0]!.length === 3);
	buttonStarting("Open")?.click();
	await frames(2);
	add("Open opens the first notebook made and closes the dialog", st.opened.length === 1 && st.opened[0] === "Notebooks/Anatomia/Anatomy.notebook" && !dialog(), st.opened.join(","));

	// --- importing again never overwrites
	const again = newState();
	await open(app, [pdf("Anatomy.pdf", 4)], again, "Notebooks/Anatomia");
	add("a second import of the same PDF gets a new name", textOf(rows()[0]?.querySelector(".nb-bulk-hint")) === "Will be saved as “Anatomy 2”");
	buttonStarting("Import 1 notebook")?.click();
	await waitFor(() => !!q(".nb-bulk-summary"));
	add("and both notebooks exist", !!made("Notebooks/Anatomia/Anatomy.notebook") && !!made("Notebooks/Anatomia/Anatomy 2.notebook"));
	closeBulk();

	// --- stopping in the middle
	const stop = newState();
	let release: () => void = () => undefined;
	stop.gate = new Promise<void>((r) => (release = r));
	await open(app, [pdf("One.pdf"), pdf("Two.pdf"), pdf("Three.pdf")], stop, "Notebooks/Matematica");
	buttonStarting("Import 3 notebooks")?.click();
	await waitFor(() => !!q(".nb-bulk-progress"));
	await frames(2);
	add("the progress shows the count and the file", textOf(q(".nb-bulk-progress")).includes("Importing 1 of 3") && textOf(q(".nb-bulk-progress")).includes("One"), textOf(q(".nb-bulk-progress")));
	add("there is a way to stop", !!buttonStarting("Stop after this file"));
	buttonStarting("Stop after this file")?.click();
	await frames(2);
	add("stopping says so", textOf(q(".nb-bulk-progress")).includes("Stopping after this file"));
	release();
	stop.gate = null;
	await waitFor(() => !!q(".nb-bulk-summary"));
	await frames(2);
	add("the summary says the import stopped", textOf(q(".nb-modal-title")) === "Import stopped" && textOf(q(".nb-bulk-summary")).includes("1 notebook created") && textOf(q(".nb-bulk-summary")).includes("2 not started"), textOf(q(".nb-bulk-summary")));
	add("the notebook in progress was finished, the others were not made", !!made("Notebooks/Matematica/One.notebook") && !made("Notebooks/Matematica/Two.notebook"));
	closeBulk();

	// --- nothing to import
	await open(app, [new File([encode("x")], "a.txt", { type: "text/plain" })], newState());
	add("when nothing can be imported the button is disabled and the reason shown", ((buttonStarting("Import 0") as HTMLButtonElement | null)?.disabled ?? false) && textOf(dialog()).includes("Nothing can be imported"));
	closeBulk();

	// --- a drop of files on a folder row
	const host = document.body.createDiv({ cls: "notebook-lib" });
	const row = host.createDiv({ cls: "nb-tree-row", attr: { "data-drop-folder": "Notebooks/Anatomia" }, text: "Anatomia" });
	const got: Array<{ n: number; target: FileDropTarget }> = [];
	attachFileDrop(host, { onFiles: (f, target) => void got.push({ n: f.length, target }), label: (t) => (t.folder ? `Drop to import into ${t.folder}` : "Drop PDFs or images to import them") });
	const dt = new DataTransfer();
	dt.items.add(pdf("A.pdf"));
	dt.items.add(pdf("B.pdf"));
	row.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
	add("files over a folder row highlight it and name the target", row.classList.contains("is-drop-target") && host.classList.contains("is-file-drop") && host.dataset.dropLabel === "Drop to import into Notebooks/Anatomia");
	const drop = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
	row.dispatchEvent(drop);
	await sleep(50);
	add("the drop is taken over from Obsidian and reports the files and the folder", drop.defaultPrevented && got.length === 1 && got[0]!.n === 2 && got[0]!.target.folder === "Notebooks/Anatomia", JSON.stringify(got));
	add("and the highlight is gone", !row.classList.contains("is-drop-target") && !host.classList.contains("is-file-drop"));
	const text = new DataTransfer();
	text.setData("text/plain", "hello");
	const other = new DragEvent("drop", { dataTransfer: text, bubbles: true, cancelable: true });
	row.dispatchEvent(other);
	add("a drag without files is left alone", !other.defaultPrevented && got.length === 1);
	host.remove();

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}

export async function bulkShot(api: BulkCheckApi, state: BulkState): Promise<void> {
	const app = api.app as App;
	closeBulk();
	document.querySelectorAll(".harness-bulk-drop").forEach((el) => el.remove());
	await seed(app);
	for (const f of app.vault.getFiles()) if (f.path.startsWith("Notebooks/Matematica/") && f.extension === "notebook") await app.fileManager.trashFile(f);
	const st = newState();
	const files = await sampleFiles();
	if (state === "drop") {
		// The library while files are dragged over a folder: the dashed frame, the label and the highlighted row.
		const lib = document.body.createDiv({ cls: "notebook-lib-root nb-ui harness-bulk-drop is-file-drop" });
		lib.dataset.dropLabel = "Drop to import into Anatomia";
		lib.createDiv({ cls: "nb-tree-row is-drop-target harness-bulk-drop-row", text: "Anatomia" });
		await frames(2);
		return;
	}
	await open(app, files, st);
	if (state === "images") {
		chip("All images into one notebook")?.click();
		chip("Dotted")?.click();
		await frames(2);
		q<HTMLElement>('.nb-bulk-swatch[aria-label="Violet"]')?.click();
	} else if (state === "progress" || state === "summary") {
		if (state === "progress") {
			let release: () => void = () => undefined;
			st.gate = new Promise<void>((r) => (release = r));
			(window as unknown as { __bulkRelease?: () => void }).__bulkRelease = release;
		}
		buttonStarting("Import")?.click();
		if (state === "progress") await waitFor(() => !!q(".nb-bulk-progress"));
		else await waitFor(() => !!q(".nb-bulk-summary"));
	}
	await frames(3);
	window.scrollTo(0, 0);
}

/** What the harness page exposes (wired in harness.ts with one statement). */
export function bulkApi(api: BulkCheckApi): Record<string, unknown> {
	return {
		checkBulk: async () => {
			try {
				return JSON.parse(JSON.stringify(await checkBulk(api))) as unknown;
			} catch (e) {
				return { ok: false, results: [], errors: [`bulk check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} };
			}
		},
		bulkShot: (state: BulkState) => bulkShot(api, state),
		closeBulk: () => {
			(window as unknown as { __bulkRelease?: () => void }).__bulkRelease?.();
			document.querySelectorAll(".harness-bulk-drop").forEach((el) => el.remove());
			closeBulk();
		},
		bulkStates: [...BULK_STATES],
	};
}
