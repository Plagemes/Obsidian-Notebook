/**
 * Smoke check of colours with meaning (0.22, roadmap #101) on the `doc=colours` notebook (npm run harness:check): a ruled
 * page of handwriting in red (definition), a near shade of red, blue (example), green (important) and black, and a second page.
 * The real view is driven through its dialogs: the filter asks for a legend first, the legend editor starts from the usual
 * meanings (saved at once), "filter by meaning" draws the other colours faint (pixels counted on the static canvas, the
 * document untouched) and shows a pill that clears it, a legend of this notebook only is kept in an in-memory `_meta` folder
 * and wins over the global one, and the digest by colour writes a note with one section per meaning, keeps what the reader
 * wrote around the markers, makes no new pictures on a second run and leaves an unpaired marker alone. `coloursedit` ends with
 * the legend editor open, `colours` with the filter on (dist/shots/colours-*.png, coloursedit-*.png).
 */
import { createDocument, createPage } from "../../src/model/document";
import { serialize } from "../../src/model/serialize";
import type { Page, Stroke } from "../../src/model/types";
import { MeaningsStore } from "../../src/library/meanings-store";
import type { Meaning } from "../../src/model/colour-meaning";
import type { DeviceFileAdapter } from "../../src/storage/device-files";
import { reseed, writeLine } from "../../tests/words-gen";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface ColoursCheckApi {
	view: unknown;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

const RED = "#dc2626";
const RED_SHADE = "#d92b2b";
const BLUE = "#1d4ed8";
const GREEN = "#15803d";
const BLACK = "#1e1e1e";

class MemoryAdapter implements DeviceFileAdapter {
	files = new Map<string, string>();
	folders = new Set<string>();
	async exists(p: string) { return this.files.has(p) || this.folders.has(p); }
	async read(p: string) {
		const v = this.files.get(p);
		if (v === undefined) throw new Error("ENOENT");
		return v;
	}
	async write(p: string, d: string) { this.files.set(p, d); }
	async mkdir(p: string) { this.folders.add(p); }
	async list(folder: string) { return [...this.files.keys()].filter((k) => k.startsWith(`${folder}/`) && !k.slice(folder.length + 1).includes("/")); }
}

const adapter = new MemoryAdapter();
let store: MeaningsStore | null = null;

/** The per-notebook store the harness gives the view when the doc is `colours` or `coloursedit` (in-memory `_meta`). */
export function harnessMeanings(): MeaningsStore {
	store ??= new MeaningsStore(adapter, () => "Notebooks", "0a000000");
	return store;
}

function line(tag: string, text: string, y: number, colour: string): Stroke[] {
	return writeLine(tag, text, { x: 60, baseY: y, H: 26 }).map((s) => ({ ...s, color: colour, width: 2.2 }));
}

/** Serialised notebook of the check. */
export function coloursNotebook(): string {
	reseed(22);
	const doc = createDocument();
	const first: Page = createPage({ width: 595, height: 842 }, { kind: "ruled", spacing: 22.68 });
	first.strokes = [
		...line("def", "limit of a sequence", 120, RED),
		...line("ex", "example one half over n", 200, BLUE),
		...line("imp", "remember the epsilon", 280, GREEN),
		...line("note", "ordinary notes here", 360, BLACK),
		...line("red2", "definition of a series", 440, RED_SHADE),
	];
	const second: Page = createPage({ width: 595, height: 842 }, { kind: "ruled", spacing: 22.68 });
	second.strokes = [...line("def2", "continuity at a point", 140, RED), ...line("ex2", "example the sine", 230, BLUE)];
	doc.pages = [first, second];
	return serialize(doc);
}

interface AppLike {
	vault: {
		getFileByPath(p: string): { path: string; extension: string } | null;
		getFiles(): Array<{ path: string; extension: string }>;
		read(f: unknown): Promise<string>;
		process(f: unknown, fn: (s: string) => string): Promise<string>;
	};
}

interface ColoursView extends HarnessView {
	app: AppLike;
	host: HarnessView["host"] & { settings: { colourMeanings: Meaning[] } };
	openMeaningFilter(): void;
	openMeaningLegend(): void;
	openMeaningDigest(): void;
}

type CheckOutcome = { ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> };

/** The check; a crash in the middle is reported as a failed result after the results so far (not as a bare console error). */
export async function checkColours(api: ColoursCheckApi, editorLast = false): Promise<CheckOutcome> {
	const results: CheckResult[] = [];
	try {
		return await runColours(api, editorLast, results);
	} catch (e) {
		results.push({ name: "the check ran to the end", ok: false, detail: (e as Error).stack ?? String(e) });
		return { ok: false, results, errors: api.errors, notices: api.notices, env: {} };
	}
}

async function runColours(api: ColoursCheckApi, editorLast: boolean, results: CheckResult[]): Promise<CheckOutcome> {
	const { frames } = api;
	const v = api.view as ColoursView;
	const app = v.app;

	const add = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });
	const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
	const NOTE = "Notebooks/Colours — Colours.md";
	const noteText = async (): Promise<string> => {
		const f = app.vault.getFileByPath(NOTE);
		return f ? app.vault.read(f) : "";
	};
	const pictures = () => app.vault.getFiles().filter((f) => f.extension === "png" && f.path.includes("meaning p"));
	const modal = (needle: RegExp): HTMLElement | null => [...document.querySelectorAll<HTMLElement>(".modal")].find((m) => needle.test(m.textContent ?? "")) ?? null;
	const lift = (m: HTMLElement | null): void => {
		if (m && !m.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(m);
	};
	const closeModals = async (): Promise<void> => {
		for (const m of document.querySelectorAll<HTMLElement>(".modal")) m.querySelector<HTMLButtonElement>(".nb-modal-foot button:last-child")?.click();
		document.querySelectorAll(".harness-modal-container").forEach((c) => { if (!c.querySelector(".modal")) c.remove(); });
		await frames(2);
	};
	const pill = (): HTMLElement | null => document.querySelector<HTMLElement>(".nb-meaning-pill");
	const pillShown = (): boolean => !!pill() && getComputedStyle(pill()!).display !== "none";
	const inkPixels = (): { red: number; blue: number; green: number } => {
		const c = document.querySelector<HTMLCanvasElement>("canvas.notebook-canvas-static")!;
		const px = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
		let red = 0, blue = 0, green = 0;
		for (let i = 0; i < px.length; i += 4) {
			const r = px[i]!, g = px[i + 1]!, b = px[i + 2]!;
			if (r > 150 && g < 90 && b < 90) red++;
			else if (b > 150 && r < 90 && g < 120) blue++;
			else if (g > 100 && r < 60 && b < 100) green++;
		}
		return { red, blue, green };
	};
	const settle = async (before: number): Promise<void> => {
		for (let i = 0; i < 200 && !api.notices.slice(before).some((n) => /Digest by colour written|marker|failed|No ink/.test(n)); i++) await sleep(50);
		await frames(2);
	};
	const chooseMeaning = async (index: number | null): Promise<void> => {
		v.openMeaningFilter();
		await frames(3);
		const m = modal(/Filter by meaning/);
		lift(m);
		await frames(2);
		(m?.querySelector<HTMLElement>(`[data-key="${index === null ? "meaning-all" : `meaning-${index}`}"]`))?.click();
		await frames(3);
	};
	const runDigest = async (): Promise<void> => {
		v.openMeaningDigest();
		await frames(3);
		const m = modal(/Digest by colour/);
		lift(m);
		await frames(2);
		const before = api.notices.length;
		m?.querySelector<HTMLButtonElement>(".nb-modal-btn-primary, .nb-modal-foot button:last-child")?.click();
		await settle(before);
	};

	// No legend yet: the filter says so and leads to the editor.
	add("the harness starts without a legend", v.host.settings.colourMeanings.length === 0, "");
	v.openMeaningFilter();
	await frames(3);
	const empty = modal(/Filter by meaning/);
	add("the filter asks for a legend first", /No meanings are defined/.test(empty?.textContent ?? ""), empty?.textContent?.slice(0, 120) ?? "");
	const define = [...(empty?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => /Define meanings/.test(b.textContent ?? ""));
	define?.click();
	await frames(3);
	const editor = modal(/Colour meanings/);
	lift(editor);
	add("it opens the legend editor (the global one)", !!editor && !editor.querySelector(".nb-modal-check"), "");
	add("the editor offers the usual meanings", /Add the usual meanings/.test(editor?.textContent ?? ""), `${document.querySelectorAll(".modal").length} modals: ${(editor?.textContent ?? "").slice(0, 200)}`);
	[...(editor?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => /Add the usual meanings/.test(b.textContent ?? ""))?.click();
	await frames(3);
	add("they are saved at once", v.host.settings.colourMeanings.length === 3 && v.host.settings.colourMeanings[0]?.label === "Definition", JSON.stringify(v.host.settings.colourMeanings));
	add("the editor lists a row per meaning", (editor?.querySelectorAll(".nb-colrow").length ?? 0) === 3, "");
	// Rename the first meaning in the field.
	const first = editor?.querySelector<HTMLInputElement>('[data-key="meaning-label:0"]');
	if (first) {
		first.value = "Definition (maths)";
		first.dispatchEvent(new Event("change"));
	}
	await frames(2);
	add("renaming a meaning is saved", v.host.settings.colourMeanings[0]?.label === "Definition (maths)", "");
	if (first) {
		first.value = "Definition";
		first.dispatchEvent(new Event("change"));
	}
	await frames(2);
	// Two colours that are too close raise the warning and are kept apart by the free colour picker.
	await closeModals();

	// The filter.
	const before = inkPixels();
	add("the page shows red, blue and green ink", before.red > 500 && before.blue > 500 && before.green > 300, JSON.stringify(before));
	add("no pill while nothing is filtered", !pillShown(), "");
	const docBefore = JSON.stringify(v.document?.pages.map((p) => p.strokes.map((s) => [s.id, s.color])));
	await chooseMeaning(0);
	const red = inkPixels();
	add("the pill says what is shown", pillShown() && /Showing only: Definition/.test(pill()?.textContent ?? ""), pill()?.textContent ?? "");
	add("the filtered meaning keeps its ink (the shade of red too)", red.red > before.red * 0.9, `${before.red} -> ${red.red}`);
	add("the other colours are drawn faint", red.blue < before.blue * 0.1 && red.green < before.green * 0.1, `blue ${before.blue} -> ${red.blue}, green ${before.green} -> ${red.green}`);
	add("the notebook itself is not changed", JSON.stringify(v.document?.pages.map((p) => p.strokes.map((s) => [s.id, s.color]))) === docBefore, "");
	await chooseMeaning(1);
	const blue = inkPixels();
	add("another meaning swaps which ink is faint", blue.blue > before.blue * 0.9 && blue.red < before.red * 0.1, `blue ${blue.blue}, red ${blue.red}`);
	pill()?.querySelector<HTMLButtonElement>(".nb-meaning-pill-clear")?.click();
	await frames(3);
	const all = inkPixels();
	add("the pill's button shows everything again", !pillShown() && all.red > before.red * 0.95 && all.blue > before.blue * 0.95, JSON.stringify(all));

	// A legend of this notebook only.
	v.openMeaningLegend();
	await frames(3);
	let nb = modal(/Colour meanings/);
	lift(nb);
	const toggle = nb?.querySelector<HTMLInputElement>('.nb-modal-check input[type="checkbox"]');
	add("the notebook's editor offers a legend of its own", !!toggle && !toggle.checked, "");
	add("while off it shows the global legend and cannot edit it", (nb?.querySelector<HTMLInputElement>('[data-key="meaning-label:0"]')?.disabled ?? false) && /uses the legend from Settings/.test(nb?.textContent ?? ""), "");
	if (toggle) {
		toggle.checked = true;
		toggle.dispatchEvent(new Event("change"));
	}
	await frames(3);
	const label = nb?.querySelector<HTMLInputElement>('[data-key="meaning-label:0"]');
	if (label) {
		label.value = "Theorem";
		label.dispatchEvent(new Event("change"));
	}
	await sleep(100);
	await frames(2);
	const file = [...adapter.files.keys()].find((k) => k.includes("_meta/meanings-"));
	add("it is stored beside the notebooks, in this device's file", !!file && (adapter.files.get(file) ?? "").includes("Theorem"), file ?? "no file");
	add("the global legend is unchanged", v.host.settings.colourMeanings[0]?.label === "Definition", "");
	await closeModals();
	await chooseMeaning(0);
	add("the filter uses the notebook's legend", /Showing only: Theorem/.test(pill()?.textContent ?? ""), pill()?.textContent ?? "");
	pill()?.querySelector<HTMLButtonElement>(".nb-meaning-pill-clear")?.click();
	await frames(2);

	// The digest by colour (with the notebook's legend: Theorem, Example, Important).
	await runDigest();
	const text = await noteText();
	add("the note is written next to the notebook", text.length > 0, NOTE);
	add("it has the start and end markers", text.includes("<!-- notebook-meanings:start -->") && text.includes("<!-- notebook-meanings:end -->"), "");
	add("one section per meaning, in legend order", text.indexOf("## Theorem") > 0 && text.indexOf("## Theorem") < text.indexOf("## Example") && text.indexOf("## Example") < text.indexOf("## Important"), text.match(/^## .*$/gmu)?.join(" ; ") ?? "");
	const embeds = [...text.matchAll(/!\[\[([^\]]+)\]\]/gu)].map((m) => m[1]!);
	add("a picture for each place (at least 3 red, 2 blue, 1 green)", embeds.length >= 6, `${embeds.length} embeds, ${pictures().length} files`);
	add("each place links back to its page", (text.match(/#p\d&id=/gu) ?? []).length === embeds.length, "");
	add("black ink is not collected", !/ordinary/i.test(text), "");
	await app.vault.process(app.vault.getFileByPath(NOTE)!, (s) => `MY INTRO\n\n${s}\n\nMY OUTRO\n`);
	const files = pictures().length;
	await runDigest();
	const again = await noteText();
	add("the reader's text outside the markers is kept", again.startsWith("MY INTRO\n\n") && again.endsWith("\n\nMY OUTRO\n"), "");
	add("no new picture files on the second run", pictures().length === files, `${files} -> ${pictures().length}`);
	await runDigest();
	add("running it again changes nothing", (await noteText()) === again, "");
	const broken = again.replace("<!-- notebook-meanings:end -->", "");
	await app.vault.process(app.vault.getFileByPath(NOTE)!, () => broken);
	const n0 = api.notices.length;
	await runDigest();
	add("a note with an unpaired marker is left untouched", (await noteText()) === broken && api.notices.slice(n0).some((n) => /marker/.test(n)), api.notices.slice(n0).join(" | "));
	await app.vault.process(app.vault.getFileByPath(NOTE)!, () => again);

	// Back to the global legend.
	v.openMeaningLegend();
	await frames(3);
	nb = modal(/Colour meanings/);
	lift(nb);
	const toggle2 = nb?.querySelector<HTMLInputElement>('.nb-modal-check input[type="checkbox"]');
	if (toggle2) {
		toggle2.checked = false;
		toggle2.dispatchEvent(new Event("change"));
	}
	await sleep(100);
	await frames(2);
	add("switching it off removes the notebook's legend", !!toggle2 && harnessMeanings().get(v.document?.id ?? "") === null, "");
	await closeModals();

	// The end state for the screenshot.
	if (editorLast) {
		v.openMeaningLegend();
		await frames(3);
		lift(modal(/Colour meanings/));
	} else {
		await chooseMeaning(0);
		document.querySelectorAll(".harness-modal-container").forEach((c) => c.remove());
	}
	await frames(3);
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { pictures: pictures().length } };
}
