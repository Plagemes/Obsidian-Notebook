/**
 * Smoke check of the semantic zoom (0.27, roadmap #130) on the `doc=semzoom` notebook (the "Outline" notebook: slides of a fake PDF
 * named "Calculus 101", large handwriting headings, a titled bookmark; npm run harness:check with HARNESS_DOC=semzoom). The real view:
 * at the fit-to-width zoom the overlay is off; zoomed far out it fades in with the headings (pictures of the ink), the bookmark and the
 * PDF name as large labels that stay inside the view and do not overlap; a tap with a finger or a click with the mouse on a label zooms to
 * that spot; the setting turns it off; page-by-page mode and the presentation do not show it; the document is not changed.
 * `semzoomShot(state)` leaves the view for the screenshots (overview, fade, labels).
 */
import { fitWidth } from "../../src/ink/viewport";
import { semanticRange } from "../../src/ink/semantic-zoom";
import type { CheckResult } from "./reading-check";

export interface SemzoomCheckApi {
	view: unknown;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface Label { key: string; kind: string; text: string; x: number; y: number; width: number; height: number }

interface SemView {
	document: unknown;
	host: { settings: { semanticZoom: boolean; scrollMode: string; outlineHeadings: boolean } };
	applySettings(s: unknown): void;
	setViewport(v: { scale: number; offsetX: number; offsetY: number }, interactive?: boolean): void;
	viewport: { scale: number; offsetX: number; offsetY: number };
	viewSize: { width: number; height: number };
	layout: { width: number; height: number; boxes: Array<{ x: number; y: number; width: number; height: number }> };
	semzoom: { visible: boolean; opacity: number; labelCount: number; el: HTMLElement; snapshot(): Label[]; labelAt(x: number, y: number): { key: string; pageIndex: number } | null };
	currentPage(): number;
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const stage = (): HTMLElement => document.querySelector<HTMLElement>(".notebook-stage")!;

/** The scale at which the overlay is complete / halfway, for this view. */
function scales(v: SemView): { fit: number; far: number; mid: number } {
	const fit = fitWidth(v.viewSize, v.layout).scale;
	const { on, full } = semanticRange(fit);
	return { fit, far: Math.max(0.25, full * 0.97), mid: (on + full) / 2 };
}

function goTo(v: SemView, scale: number, page = 0, y = 0): void {
	const box = v.layout.boxes[page]!;
	v.setViewport({ scale, offsetX: (v.viewSize.width - box.width * scale) / 2 - box.x * scale, offsetY: 16 - (box.y + y) * scale }, true);
}

async function until(fn: () => boolean, ms = 6000): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (fn()) return true;
		await sleep(80);
	}
	return fn();
}

function pointer(el: Element, type: string, x: number, y: number, kind: "touch" | "mouse", id = 61): boolean {
	return el.dispatchEvent(new PointerEvent(type, {
		pointerId: id, pointerType: kind, isPrimary: true, clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, bubbles: true, cancelable: true, composed: true,
	}));
}

export async function checkSemzoom(api: SemzoomCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const v = api.view as SemView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const frames = api.frames;
	try {
		v.host.settings.semanticZoom = true;
		v.host.settings.scrollMode = "continuous";
		v.applySettings(v.host.settings);
		const before = JSON.stringify(v.document);
		const { fit, far, mid } = scales(v);
		const canvas = stage().querySelector("canvas")!;

		// --- at the fit-to-width zoom: nothing ---
		goTo(v, fit);
		await frames(4);
		add("off at the fit-to-width zoom", !v.semzoom.visible && v.semzoom.opacity === 0 && v.semzoom.labelCount === 0, `${v.semzoom.opacity}`);
		goTo(v, fit * 1.8);
		await frames(3);
		add("off when zoomed in", !v.semzoom.visible);

		// --- far out: labels ---
		goTo(v, far);
		await frames(3);
		const shown = await until(() => v.semzoom.visible && v.semzoom.labelCount >= 3);
		const labels = v.semzoom.snapshot();
		add("zoomed far out the overlay is on, at full opacity", shown && v.semzoom.opacity > 0.99, `${labels.length} labels, opacity ${v.semzoom.opacity}`);
		const kinds = new Set(labels.map((l) => l.kind));
		add("it shows headings (pictures of the ink)", kinds.has("heading"), [...kinds].join(","));
		add("it shows the titled bookmark", labels.some((l) => l.kind === "bookmark" && l.text === "Key theorem"), labels.map((l) => l.text).filter(Boolean).join("|"));
		add("it shows the PDF name", labels.some((l) => l.kind === "document" && /Calculus 101/.test(l.text)), "");
		const sr = stage().getBoundingClientRect();
		add("every label is inside the view", labels.every((l) => l.x >= -1 && l.y >= -1 && l.x + l.width <= sr.width + 1 && l.y + l.height <= sr.height + 1));
		add("labels are big enough to read (at least 20 px tall)", labels.every((l) => l.height >= 20), labels.map((l) => Math.round(l.height)).join(","));
		let overlap = false;
		for (const a of labels) for (const b of labels) if (a !== b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) overlap = true;
		add("no two labels overlap", !overlap);
		const pics = await until(() => {
			const imgs = Array.from(v.semzoom.el.querySelectorAll<HTMLImageElement>(".nb-sz-label.is-picture img"));
			return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0);
		});
		add("the heading pictures are drawn", pics, String(v.semzoom.el.querySelectorAll(".nb-sz-label.is-picture").length));
		const layerStyle = getComputedStyle(v.semzoom.el);
		add("the overlay does not take pointer events", layerStyle.pointerEvents === "none" && layerStyle.position === "absolute");
		add("viewing it did not change the document", JSON.stringify(v.document) === before);

		// --- the fade ---
		goTo(v, mid);
		await frames(4);
		add("halfway it is partly visible", v.semzoom.opacity > 0.15 && v.semzoom.opacity < 0.85, `${v.semzoom.opacity.toFixed(2)}`);

		// --- tap a label: a finger and the mouse ---
		for (const kind of ["touch", "mouse"] as const) {
			goTo(v, far);
			await until(() => v.semzoom.visible && v.semzoom.labelCount >= 3);
			await frames(2);
			const target = v.semzoom.snapshot().find((l) => l.kind === "heading") ?? v.semzoom.snapshot()[0]!;
			const x = sr.left + target.x + target.width / 2;
			const y = sr.top + target.y + target.height / 2;
			const hit = v.semzoom.labelAt(x, y);
			add(`${kind}: a label is under the tap point`, !!hit, hit?.key ?? "");
			pointer(canvas, "pointerdown", x, y, kind);
			pointer(canvas, "pointerup", x, y, kind);
			await frames(4);
			const page = hit?.pageIndex ?? 0;
			const box = v.layout.boxes[page]!;
			const topOfView = -v.viewport.offsetY / v.viewport.scale;
			add(`${kind}: a tap zooms to that spot`, Math.abs(v.viewport.scale - fit) < 1e-6 && topOfView >= box.y - 50 && topOfView <= box.y + box.height, `scale ${v.viewport.scale.toFixed(3)} fit ${fit.toFixed(3)} top ${Math.round(topOfView)}`);
			add(`${kind}: the overlay is gone after the jump`, !v.semzoom.visible);
		}
		add("tapping did not change the document", JSON.stringify(v.document) === before);

		// --- a drag is not a tap ---
		goTo(v, far);
		await until(() => v.semzoom.visible && v.semzoom.labelCount >= 3);
		const t2 = v.semzoom.snapshot()[0]!;
		const tx = sr.left + t2.x + t2.width / 2;
		const ty = sr.top + t2.y + t2.height / 2;
		const s0 = v.viewport.scale;
		pointer(canvas, "pointerdown", tx, ty, "touch", 62);
		pointer(canvas, "pointerup", tx, ty + 60, "touch", 62);
		await frames(3);
		add("a drag that starts on a label does not jump", Math.abs(v.viewport.scale - s0) < 1e-9);

		// --- setting, modes ---
		goTo(v, far);
		await until(() => v.semzoom.visible);
		v.host.settings.semanticZoom = false;
		v.applySettings(v.host.settings);
		await frames(4);
		add("the setting turns it off", !v.semzoom.visible);
		v.host.settings.semanticZoom = true;
		v.applySettings(v.host.settings);
		await frames(2);
		goTo(v, far);
		await frames(2);
		add("and on again", await until(() => v.semzoom.visible));
		v.host.settings.scrollMode = "pages";
		v.applySettings(v.host.settings);
		await frames(4);
		add("page-by-page mode does not show it", !v.semzoom.visible);
		v.host.settings.scrollMode = "continuous";
		v.applySettings(v.host.settings);
		await frames(3);
		add("the document is unchanged at the end", JSON.stringify(v.document) === before);
	} catch (e) {
		add(`stopped: ${(e as Error).message}`, false, `after: ${results[results.length - 1]?.name ?? "start"}`);
	}
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}

/** Leaves the view for a screenshot: far out (full), halfway (fade), or far out at the end of the notebook. */
export async function semzoomShot(api: SemzoomCheckApi, state: "overview" | "fade" | "later"): Promise<void> {
	const v = api.view as SemView;
	v.host.settings.semanticZoom = true;
	v.host.settings.scrollMode = "continuous";
	v.applySettings(v.host.settings);
	const { far, mid } = scales(v);
	if (state === "fade") goTo(v, mid);
	else if (state === "later") goTo(v, far, 2);
	else goTo(v, far);
	await api.frames(3);
	await until(() => v.semzoom.visible && v.semzoom.labelCount >= 2);
	await until(() => {
		const imgs = Array.from(v.semzoom.el.querySelectorAll<HTMLImageElement>(".nb-sz-label.is-picture img"));
		return imgs.every((i) => i.complete);
	}, 3000);
	await api.frames(4);
	await sleep(300);
}
