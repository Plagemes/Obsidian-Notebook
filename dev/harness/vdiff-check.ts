/**
 * 0.20 vdiff (roadmap #121): the visual version diff dialog on the `doc=vdiff` scenario (npm run harness:check). Two versions of a
 * small notebook (a modified page with added, removed, moved and changed ink and a moved box, a removed page, an added page and an
 * unchanged page) are compared in the real dialog. Checked: the summary and the page list (changed pages first, counts), the three
 * views draw a canvas that fits the screen and differ from each other, the page navigation, the "All pages" filter, the restore
 * button naming the version and being a 40 px target, and the dialog staying inside the screen. It leaves the dialog open (overlay
 * view, the modified page) for the screenshot. The notebooks are built in memory and never written.
 */
import { createDocument, createPage, createStroke } from "../../src/model/document";
import type { BoxElement, NotebookDocument, Page, Point, TextElement } from "../../src/model/types";
import { VersionDiffModal } from "../../src/view/version-diff-dialog";
import { App } from "./obsidian-stub";
import type { CheckResult } from "./reading-check";

export interface VdiffCheckApi {
	errors: string[];
	notices: string[];
}

function squiggle(x: number, y: number, n = 40, amp = 14): Point[] {
	const pts: Point[] = [];
	for (let i = 0; i < n; i++) pts.push([Math.round((x + i * 6) * 100) / 100, Math.round((y + Math.sin(i / 3) * amp) * 100) / 100, 0.6]);
	return pts;
}

const ink = (id: string, x: number, y: number, color = "#1e1e1e") => ({ ...createStroke(color, 2.4, squiggle(x, y)), id });

function page(id: string, strokes: ReturnType<typeof ink>[], elements?: Page["elements"]): Page {
	const p = createPage();
	p.id = id;
	p.strokes = strokes;
	if (elements) p.elements = elements;
	return p;
}

const title = (x: number, text: string): TextElement => ({ id: "title", type: "text", x, y: 60, width: 320, text, fontSize: 20, color: "#1e1e1e" });
const box = (x: number, y: number): BoxElement => ({ id: "def", type: "box", kind: "definition", x, y, width: 260, height: 90, title: "Definition" });

function build(): { before: NotebookDocument; after: NotebookDocument } {
	const b = createDocument();
	b.pages = [
		page("intro", [ink("i1", 60, 140)], [title(60, "Linear maps")]),
		page("work", [ink("w1", 60, 200), ink("w2", 60, 260), ink("w3", 60, 320, "#2563eb"), ink("w4", 60, 380), ink("w5", 60, 440)], [box(60, 520), title(60, "Worked example")]),
		page("gone", [ink("g1", 80, 200), ink("g2", 80, 280)]),
		page("same", [ink("s1", 60, 200)]),
	];
	const a = createDocument();
	a.pages = [
		page("intro", [ink("i1", 60, 140)], [title(60, "Linear maps")]),
		// w2 removed, w3 recoloured, w4 moved, w6 new; the box moved
		page("work", [ink("w1", 60, 200), ink("w3", 60, 320, "#dc2626"), ink("w4", 120, 400), ink("w5", 60, 440), ink("w6", 60, 600, "#16a34a")], [box(180, 560), title(60, "Worked example")]),
		page("same", [ink("s1", 60, 200)]),
		page("added", [ink("n1", 60, 200), ink("n2", 60, 300)]),
	];
	return { before: b, after: a };
}

export async function checkVdiff(api: VdiffCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
	const { before, after } = build();
	const app = new App();
	const modal = new VersionDiffModal(app as never, {
		before: { doc: before, label: "2026-11-03 09:00", date: new Date(2026, 10, 3, 9, 0) },
		after: { doc: after, label: "Current notebook", date: null },
		afterIsCurrent: true,
		// A restore target that only records: the harness never changes a notebook here.
		restore: { editableDocument: () => after, applyCommand: () => true },
		startPageId: "work",
	});
	modal.open();
	await sleep(80);
	const root = document.querySelector<HTMLElement>(".nb-vdiff-modal") ?? document.querySelector<HTMLElement>(".modal");
	const rows = (): HTMLElement[] => Array.from(root?.querySelectorAll<HTMLElement>(".nb-vdiff-row") ?? []);
	const chip = (label: string) => Array.from(root?.querySelectorAll<HTMLElement>(".nb-chip") ?? []).find((c) => c.textContent?.includes(label));
	const canvas = (): HTMLCanvasElement | null => root?.querySelector<HTMLCanvasElement>(".nb-vdiff-canvas") ?? null;
	const sig = (c: HTMLCanvasElement | null): string => {
		if (!c) return "";
		const ctx = c.getContext("2d");
		if (!ctx) return "";
		const d = ctx.getImageData(0, 0, c.width, c.height).data;
		let h = 0;
		for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]!) | 0;
		return String(h);
	};
	const summary = root?.querySelector(".nb-vdiff-summary")?.textContent ?? "";
	add("the dialog is open", !!root);
	add("the summary counts the pages", summary.includes("1 added · 1 removed · 1 modified · 2 unchanged"), summary);
	add("the list shows the three changed pages only", rows().length === 3 && rows().every((r) => !r.classList.contains("is-unchanged")), rows().map((r) => r.dataset.page).join(","));
	add("the modified page is selected first", rows().find((r) => r.classList.contains("is-selected"))?.dataset.page === "work");
	const workText = rows().find((r) => r.dataset.page === "work")?.textContent ?? "";
	add("a row shows its counts", workText.includes("+1 −1 ~3"), workText);
	add("a removed page is listed as it was", rows().some((r) => r.dataset.page === "gone" && r.textContent?.includes("Was page 3")));
	const overlay = canvas();
	add("the overlay draws a canvas", !!overlay && overlay.width > 100);
	const box1 = overlay?.getBoundingClientRect();
	add("the canvas fits the screen", !!box1 && box1.left >= 0 && box1.right <= window.innerWidth + 1, box1 ? `${Math.round(box1.width)}px` : "");
	const sOverlay = sig(overlay);
	chip("Before")?.click();
	await sleep(40);
	const sBefore = sig(canvas());
	chip("After")?.click();
	await sleep(40);
	const sAfter = sig(canvas());
	add("before, after and overlay draw three different pictures", new Set([sOverlay, sBefore, sAfter]).size === 3, `${sBefore} ${sAfter} ${sOverlay}`);
	add("the view chips are real toggles", chip("After")?.getAttribute("aria-pressed") === "true" && chip("Before")?.getAttribute("aria-pressed") === "false");
	const restore = root?.querySelector<HTMLButtonElement>(".nb-vdiff-restore") ?? null;
	add("the restore button names the version", restore?.textContent?.includes("2026-11-03") === true, restore?.textContent ?? "");
	add("the restore button is a 40 px target", !!restore && restore.getBoundingClientRect().height >= 40);
	// The next changed page after "work" is the removed one, then "added" (the unchanged page between is skipped): no earlier version, so it cannot be restored.
	root?.querySelectorAll<HTMLElement>(".nb-vdiff-nav")[1]?.click();
	await sleep(40);
	root?.querySelectorAll<HTMLElement>(".nb-vdiff-nav")[1]?.click();
	await sleep(40);
	add("next goes to the added page", rows().find((r) => r.classList.contains("is-selected"))?.dataset.page === "added");
	add("an added page cannot be restored from the earlier version", root?.querySelector<HTMLButtonElement>(".nb-vdiff-restore")?.disabled === true);
	chip("All pages")?.click();
	await sleep(40);
	add("All pages lists all five", rows().length === 5, String(rows().length));
	chip("Changed")?.click();
	await sleep(20);
	rows().find((r) => r.dataset.page === "work")?.click();
	await sleep(40);
	chip("Overlay")?.click();
	await sleep(60);
	const dialog = root?.closest<HTMLElement>(".modal") ?? root;
	const r = dialog?.getBoundingClientRect();
	add("the dialog fits the screen", !!r && r.left >= 0 && r.right <= window.innerWidth + 1, r ? `${Math.round(r.width)}px` : "");
	add("the modified page is selected again, in the overlay", rows().find((x) => x.classList.contains("is-selected"))?.dataset.page === "work" && chip("Overlay")?.getAttribute("aria-pressed") === "true");
	if (dialog && !dialog.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(dialog);
	return { ok: results.every((x) => x.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
