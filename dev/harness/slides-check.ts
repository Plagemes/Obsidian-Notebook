/**
 * Smoke check of the notes ↔ slide link (0.14, #226, format v12) and of the slide strip (#417) on the `doc=slides`
 * notebook (npm run harness:check): a blank notes notebook with the fake PDF (fake-pdf.ts) opened beside it in the real
 * side-by-side pane. Ink written beside slide 2 and slide 3 is linked, badges appear, a tap shows the slide again,
 * undo/redo cover the link, the saved file is v12, and the strip lists both slides. The run leaves the strip open for the
 * screenshot; `slidesState("badges")` closes it for the second one (dev/harness/dist/shots/slides-*.png).
 */

import type { Plugin, TFile } from "obsidian";
import { initPdfSync, referencePane, referenceSlideKey, openSlideStripOf } from "../../src/view/pdf-sync";
import type { NotebookView } from "../../src/view/notebook-view";
import { FAKE_PATH } from "./fake-pdf";
import type { HarnessApp, HarnessSettings, HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface SlidesCheckApi {
	view: unknown;
	app: unknown;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string }) => Promise<void>;
	strokeCount: () => number;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

const HIGH: Array<[number, number]> = [[0.15, 0.2], [0.35, 0.22], [0.55, 0.2]];
const HIGH2: Array<[number, number]> = [[0.15, 0.26], [0.35, 0.28], [0.5, 0.26]];
const LOW: Array<[number, number]> = [[0.15, 0.6], [0.35, 0.62], [0.55, 0.6]];

let services = false;

function setUp(app: unknown): void {
	if (services) return;
	services = true;
	initPdfSync({ app, manifest: { id: "notebook" }, register: () => undefined } as unknown as Plugin, () => "Notebooks");
}

const badges = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(".nb-slide-badge")).filter((b) => b.offsetWidth > 0);

export async function checkSlides(api: SlidesCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { penStroke, strokeCount, frames } = api;
	const v = api.view as HarnessView;
	const nv = api.view as NotebookView;
	const app = api.app as HarnessApp;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
	const settle = async () => {
		await frames(3);
		await sleep(60);
		await frames(2);
	};

	setUp(api.app);
	const pane = referencePane(nv);
	const pdf = app.vault.getFileByPath(FAKE_PATH) as unknown as TFile | null;
	add("the side-by-side services and the fake PDF are there", !!pane && !!pdf);
	if (!pane || !pdf) return { ok: false, results, errors: api.errors, notices: api.notices, env: {} };

	// --- #226: link while writing ---
	await pane.show(pdf, 2);
	await settle();
	const key = referenceSlideKey(nv);
	add("the pane shows slide 2", key?.page === 2, JSON.stringify(key));
	add("no badge before any ink", badges().length === 0, String(badges().length));
	const base = strokeCount();
	await penStroke(HIGH);
	await penStroke(HIGH2);
	await settle();
	const page = () => v.document.pages[v.currentPage()]!;
	const linked = () => page().strokes.filter((s) => !!s.slide);
	add("both strokes are written", strokeCount() === base + 2, `${base} -> ${strokeCount()}`);
	add("both strokes are linked to one entry for slide 2", linked().length === 2 && new Set(linked().map((s) => s.slide)).size === 1 && v.document.slides?.length === 1 && v.document.slides[0]?.page === 2, JSON.stringify(v.document.slides));
	add("one badge for the block of ink", badges().length === 1, String(badges().length));
	const first = badges()[0];
	const box = first?.getBoundingClientRect();
	add("the badge is a touch target of at least 40 px", !!box && box.width >= 39.5 && box.height >= 39.5, box ? `${box.width}x${box.height}` : "missing");
	add("the badge shows the slide number", first?.textContent?.includes("2") ?? false, first?.textContent ?? "");
	add("the badge of the slide in the pane is highlighted", first?.classList.contains("is-current") ?? false, first?.className ?? "");

	await pane.show(pdf, 3);
	await settle();
	await penStroke(LOW);
	await settle();
	add("ink beside slide 3 gets its own entry and badge", v.document.slides?.length === 2 && badges().length === 2, `${v.document.slides?.length} entries, ${badges().length} badges`);

	// Tap: the pane shows the slide again.
	await pane.show(pdf, 1);
	await settle();
	const before = strokeCount();
	const two = badges().find((b) => b.textContent?.includes("2"));
	two?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 900, isPrimary: true, button: 0, buttons: 1 }));
	two?.click();
	await settle();
	await sleep(150);
	add("a tap on the badge shows slide 2 in the pane", referenceSlideKey(nv)?.page === 2, JSON.stringify(referenceSlideKey(nv)));
	add("the tap writes nothing", strokeCount() === before, `${before} -> ${strokeCount()}`);

	// Undo/redo cover the link.
	v.undo();
	await settle();
	add("undo removes the stroke and its slide entry", v.document.slides?.length !== 2 && badges().length === 1, `${v.document.slides?.length ?? 0} entries, ${badges().length} badges`);
	v.redo();
	await settle();
	add("redo restores both", v.document.slides?.length === 2 && badges().length === 2, `${v.document.slides?.length ?? 0} entries, ${badges().length} badges`);

	// The saved file is v12 and names the slides.
	await v.flushNow();
	const file = app.vault.getFileByPath("Notebooks/New.notebook") as unknown as TFile | null;
	const text = file ? await (app.vault as unknown as { read(f: TFile): Promise<string> }).read(file) : "";
	add("the saved file is current format (v13) with the slide table", /"version":\s*13/.test(text) && /"slides":/.test(text) && (text.match(/"slide":/g)?.length ?? 0) === 3, `${text.length} chars`);

	// Badges follow the setting.
	// The settings tab changes the plugin's settings object in place, then the views apply it.
	const s = v.host.settings as HarnessSettings & { slideInkBadges: boolean };
	s.slideInkBadges = false;
	v.applySettings(s);
	await settle();
	add("the setting hides the badges", badges().length === 0, String(badges().length));
	s.slideInkBadges = true;
	v.applySettings(s);
	await settle();
	add("and shows them again", badges().length === 2, String(badges().length));

	// --- #417: the slide strip ---
	await openSlideStripOf(nv);
	await settle();
	const modal = document.querySelector<HTMLElement>(".notebook-slide-strip");
	// Inside a dimmed layer, as Obsidian's modal container shows it (the stand-in appends the bare .modal to the body).
	const shell = modal?.closest<HTMLElement>(".modal") ?? modal;
	if (shell) document.body.createDiv({ cls: "harness-modal-container harness-slide-strip-layer" }).appendChild(shell);
	await settle();
	add("the strip opens on the modal shell", !!modal);
	const rows = modal ? Array.from(modal.querySelectorAll<HTMLElement>(".nb-slide-strip-row")) : [];
	add("one row per slide with notes", rows.length === 2, String(rows.length));
	const chips = modal ? Array.from(modal.querySelectorAll<HTMLElement>(".nb-slide-strip-row button")) : [];
	add("every control in a row is at least 40 px tall", chips.length > 0 && chips.every((c) => c.getBoundingClientRect().height >= 39.5), chips.map((c) => Math.round(c.getBoundingClientRect().height)).join(","));
	add("the strip does not scroll sideways", !!modal && modal.scrollWidth <= modal.clientWidth + 1, modal ? `${modal.scrollWidth} > ${modal.clientWidth}` : "");

	return {
		ok: results.every((r) => r.ok) && api.errors.length === 0,
		results,
		errors: api.errors,
		notices: api.notices,
		env: { entries: v.document.slides?.length ?? 0 },
	};
}

/** Screenshot states after the check: "badges" closes the strip and leaves the notes with their badges. */
export async function slidesState(frames: (n: number) => Promise<void>, state: "badges"): Promise<void> {
	if (state === "badges") {
		for (const el of Array.from(document.querySelectorAll<HTMLElement>(".harness-slide-strip-layer"))) el.remove();
	}
	await frames(3);
}
