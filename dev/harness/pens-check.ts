/**
 * Smoke check of the new pens (0.22, roadmap #35, format v20) on the `doc=pens` notebook (the blank "New" notebook; npm run harness:check):
 * the real view and toolbar with synthetic pen events. The pen options offer the four kinds and a nib angle for the fountain pen and the
 * marker; each kind writes a stroke of its own tool (a nib angle other than 45 is stored on the stroke, 45 is not); the committed ink is
 * saved and read back; the SVG and the PDF carry them (the marker 85% opaque); a favourite remembers the kind. The final state (a page
 * with a specimen of the four pens, the options open on the fountain pen with a 120 degree nib) is left for the screenshot.
 */
import { pagesToPdf } from "../../src/ink/export-pdf";
import { pageToSvg } from "../../src/ink/export-svg";
import { captureFavourite } from "../../src/view/favourites";
import { parse, serializeChecked } from "../../src/model/serialize";
import type { NotebookDocument, Stroke } from "../../src/model/types";
import type { CheckResult } from "./reading-check";

export interface PensCheckApi {
	view: unknown;
	stage: () => HTMLElement;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string; pressure?: number; steps?: number }) => Promise<void>;
	setTool: (tool: string) => void;
	openOptions: (tool: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface PensView {
	document: NotebookDocument;
	currentPage(): number;
	toolbar: { state: Record<string, unknown>; update(patch: Record<string, unknown>): void; closePopover(): void };
}

const visible = (el: Element | null): boolean => !!el && (el as HTMLElement).offsetWidth > 0 && (el as HTMLElement).offsetHeight > 0;

/** A wave across the page: `n` points from x0 to x1 around the height y, as fractions of the stage. */
function wave(x0: number, x1: number, y: number, amplitude: number, n = 22): Array<[number, number]> {
	return Array.from({ length: n }, (_, i): [number, number] => {
		const t = i / (n - 1);
		return [x0 + (x1 - x0) * t, y + amplitude * Math.sin(t * Math.PI * 4)];
	});
}

export async function checkPens(api: PensCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const v = api.view as PensView;
	const page = () => v.document.pages[v.currentPage()]!;
	const last = (): Stroke => page().strokes[page().strokes.length - 1]!;
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
	const kindButton = (kind: string): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>(`.notebook-pen-kinds .is-kind-${kind}`);
	const nibRow = (): HTMLElement | null => document.querySelector<HTMLElement>(".notebook-options .notebook-nib-row");

	// The options: four kinds, the ballpoint pen selected, no nib row.
	api.setTool("pen");
	await api.openOptions("pen");
	const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".notebook-options .notebook-pen-kinds .notebook-kind-button"));
	add("the pen options offer four pen kinds", buttons.length === 4, String(buttons.length));
	add("each kind has an icon and a name", buttons.every((b) => b.querySelector("svg") !== null && (b.querySelector(".notebook-kind-label")?.textContent ?? "").length > 2));
	add("the ballpoint pen is selected and the nib row is hidden", kindButton("pen")?.classList.contains("is-active") === true && !visible(nibRow()));

	kindButton("fountain")?.click();
	await api.frames(2);
	add("choosing the fountain pen selects it and shows the nib angle", v.toolbar.state.penKind === "fountain" && visible(nibRow()) && kindButton("fountain")?.getAttribute("aria-pressed") === "true");
	kindButton("brush")?.click();
	await api.frames(2);
	add("the brush has no nib angle", v.toolbar.state.penKind === "brush" && !visible(nibRow()));
	kindButton("marker")?.click();
	await api.frames(2);
	add("the marker has one", v.toolbar.state.penKind === "marker" && visible(nibRow()));
	add("the pen indicator takes the shape of the pen", document.querySelector(".notebook-chip-dot.is-kind-marker") !== null);
	v.toolbar.closePopover();
	await api.frames(2);

	// The specimen: a ballpoint line, then the same wave in each of the new pens, over it.
	const before = page().strokes.length;
	v.toolbar.update({ penKind: "pen", penWidth: 2, penColor: "#1e1e1e" });
	await api.penStroke(wave(0.1, 0.9, 0.22, 0.03), { pressure: 0.6 });
	add("the ballpoint pen writes a pen stroke", last().tool === "pen" && last().nib === undefined);

	v.toolbar.update({ penKind: "fountain", nibAngle: 45, penWidth: 5, penColor: "#1d4ed8" });
	await api.penStroke(wave(0.1, 0.9, 0.34, 0.035), { pressure: 0.6 });
	const fountain = last();
	add("the fountain pen writes a render 2 fountain stroke without a nib (45 is the default)", fountain.tool === "fountain" && fountain.render === 2 && fountain.nib === undefined, JSON.stringify([fountain.tool, fountain.render, fountain.nib]));

	v.toolbar.update({ penKind: "fountain", nibAngle: 120, penWidth: 5, penColor: "#7c3aed" });
	await api.penStroke(wave(0.1, 0.9, 0.46, 0.035), { pressure: 0.6 });
	add("a nib angle of 120 is stored on the stroke", last().tool === "fountain" && last().nib === 120, String(last().nib));

	v.toolbar.update({ penKind: "brush", penWidth: 6, penColor: "#dc2626" });
	await api.penStroke(wave(0.1, 0.9, 0.58, 0.035), { pressure: 0.85 });
	add("the brush writes a brush stroke with no nib", last().tool === "brush" && last().render === 2 && last().nib === undefined);
	await api.penStroke(wave(0.1, 0.9, 0.7, 0.035), { pressure: 0.3 });

	// The marker over the first line: the line shows through it.
	v.toolbar.update({ penKind: "marker", nibAngle: 45, penWidth: 10, penColor: "#15803d" });
	await api.penStroke([[0.1, 0.16], [0.5, 0.26], [0.9, 0.16]], { pressure: 0.6 });
	add("the marker writes a marker stroke", last().tool === "marker" && last().render === 2, last().tool);
	add("the marker has its own wet canvas", document.querySelector("canvas.is-marker") !== null);

	const strokes = page().strokes.slice(before);
	add("six strokes were written", strokes.length === 6, String(strokes.length));
	add("every new stroke is vector (points kept, page coordinates)", strokes.every((s) => s.points.length >= 4 && s.points.every((p) => p[0] >= 0 && p[1] >= 0)));

	// Saved and read back.
	const checked = serializeChecked(v.document, true);
	add("the notebook passes the writer's strict check", checked.ok, checked.ok ? "" : checked.message);
	if (checked.ok) {
		const back = parse(checked.text);
		const tools = back.ok ? back.doc.pages[v.currentPage()]!.strokes.slice(before).map((s) => `${s.tool}${s.nib ?? ""}`).join(",") : "";
		add("it reads back with the same tools and nib angles", back.ok && back.dropped === undefined && tools === "pen,fountain,fountain120,brush,brush,marker", tools);
		add("the file is format 20 or newer (24 since 0.26)", /"version": 2[0-4]\D/.test(checked.text));
	}

	// Exports: one construction, the marker 85% opaque.
	const svg = pageToSvg(page());
	add("the SVG draws every new stroke", (svg.match(/<path /g) ?? []).length >= 6);
	add("the marker is 85% opaque in the SVG and nothing else is", (svg.match(/fill-opacity="0.85"/g) ?? []).length === 1);
	const pdf = new TextDecoder("latin1").decode(pagesToPdf([page()]));
	add("the PDF gives the marker its own graphics state", pdf.includes("/GS3 gs") && pdf.includes("/ca 0.85"));

	// A favourite remembers the kind.
	v.toolbar.update({ penKind: "fountain", nibAngle: 120, penColor: "#7c3aed", penWidth: 5 });
	const fav = captureFavourite(v.toolbar.state as never);
	add("a favourite remembers the kind and the nib", fav.kind === "fountain" && fav.nib === 120, JSON.stringify(fav));

	// The nib angle row works.
	await api.openOptions("pen");
	const slider = document.querySelector<HTMLInputElement>(".notebook-options .notebook-nib-slider");
	if (slider) {
		slider.value = "60";
		slider.dispatchEvent(new Event("input", { bubbles: true }));
		const shown = document.querySelector(".notebook-options .notebook-nib-value")?.textContent ?? "";
		slider.dispatchEvent(new Event("change", { bubbles: true }));
		await api.frames(2);
		add("the nib slider changes the angle", v.toolbar.state.nibAngle === 60 && shown === "60°", `${String(v.toolbar.state.nibAngle)} ${shown}`);
	} else add("the nib slider exists", false);

	// The screenshot state: the options open on the fountain pen, nib 120.
	v.toolbar.update({ penKind: "fountain", nibAngle: 120 });
	await sleep(120);
	await api.openOptions("pen");
	await api.frames(3);
	add("the options stay inside the screen", (() => {
		const r = document.querySelector<HTMLElement>(".notebook-options")?.getBoundingClientRect();
		return !!r && r.left >= -1 && r.right <= window.innerWidth + 1;
	})());

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
