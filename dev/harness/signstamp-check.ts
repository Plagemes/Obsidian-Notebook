/**
 * Smoke check of the reusable signature and date stamp (0.21, roadmap #154) on the `doc=signstamp` notebook (the blank "New"
 * notebook; npm run harness:check): the real view. "Sign and date" opens its dialog from the registry; the signature pad takes two
 * synthetic strokes and saves them as the stamp "My signature"; Place puts the signature and the date on the page as one undo step,
 * every item with the same fresh group; a second placement gets another group; undo and redo restore it; a locked page refuses.
 * `signstampShot` leaves one state on screen for the screenshots.
 */
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface SignstampCheckApi {
	view: unknown;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface SignView extends HarnessView {
	runAction(id: string, arg?: { page?: number; value?: string }): void;
	setPageLocked(page: unknown, value: boolean): boolean;
}

export type SignstampState = "empty" | "pad" | "ready" | "placed";
export const SIGNSTAMP_STATES: SignstampState[] = ["empty", "pad", "ready", "placed"];

const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
const btn = (label: RegExp): HTMLButtonElement | null =>
	[...document.querySelectorAll<HTMLButtonElement>(".nb-sign .nb-modal-btn-label")].find((s) => label.test(s.textContent ?? ""))?.closest("button") ?? null;

/** Draws a stroke on the pad with synthetic pointer events. */
function padStroke(canvas: HTMLCanvasElement, pts: Array<[number, number]>): void {
	const r = canvas.getBoundingClientRect();
	const ev = (type: string, p: [number, number]) =>
		canvas.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: "pen", button: 0, pressure: 0.5, clientX: r.left + p[0] * r.width, clientY: r.top + p[1] * r.height, bubbles: true, cancelable: true }));
	ev("pointerdown", pts[0]!);
	for (const p of pts.slice(1)) ev("pointermove", p);
	ev("pointerup", pts[pts.length - 1]!);
}

const SCRIBBLE: Array<[number, number]> = [[0.12, 0.7], [0.2, 0.3], [0.3, 0.65], [0.4, 0.3], [0.5, 0.68], [0.62, 0.42], [0.8, 0.62], [0.9, 0.55]];
const UNDERLINE: Array<[number, number]> = [[0.1, 0.8], [0.4, 0.78], [0.75, 0.8], [0.92, 0.76]];

async function openDialog(v: SignView, frames: SignstampCheckApi["frames"]): Promise<void> {
	v.runAction("sign-and-date");
	await frames(4);
}

async function drawSignature(v: SignView, frames: SignstampCheckApi["frames"]): Promise<boolean> {
	btn(/Draw signature|Redraw signature/)?.click();
	await frames(6);
	const canvas = q<HTMLCanvasElement>(".nb-sign-canvas");
	if (!canvas) return false;
	padStroke(canvas, SCRIBBLE);
	padStroke(canvas, UNDERLINE);
	await frames(2);
	return !btn(/Save signature/)?.disabled;
}

export async function checkSignstamp(api: SignstampCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { frames } = api;
	const v = api.view as SignView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const page = () => v.document.pages[v.currentPage()]!;

	await openDialog(v, frames);
	add("Sign and date opens the dialog", !!q(".nb-sign .nb-sign-preview"));
	add("with no signature yet it says so", !!q(".nb-sign .nb-sign-empty"));
	add("Place is enabled because the date is on", btn(/^Place$/)?.disabled === false);
	add("the date check is a real checkbox", !!q('.nb-sign input[type="checkbox"]'));

	add("the pad takes two strokes and Save becomes enabled", await drawSignature(v, frames));
	btn(/^Undo$/)?.click();
	await frames(1);
	add("Undo on the pad removes the last stroke", !btn(/Save signature/)?.disabled && !btn(/^Clear$/)?.disabled);
	padStroke(q<HTMLCanvasElement>(".nb-sign-canvas")!, UNDERLINE);
	await frames(1);
	btn(/Save signature/)?.click();
	await frames(12);
	add("Save closes the pad and the dialog shows the signature", !q(".nb-sign-pad") && !!q(".nb-sign .nb-sign-preview svg path"));
	add("a notice says it was saved", api.notices.some((n) => /Signature saved/.test(n)), api.notices.slice(-1).join(""));

	const strokes0 = page().strokes.length;
	const elements0 = page().elements?.length ?? 0;
	btn(/^Place$/)?.click();
	await frames(6);
	const newStrokes = page().strokes.slice(strokes0);
	const newEls = (page().elements ?? []).slice(elements0);
	add("Place adds the signature ink and the date text", newStrokes.length === 2 && newEls.length === 1 && newEls[0]!.type === "text", `${newStrokes.length} strokes, ${newEls.length} elements`);
	const group = newStrokes[0]?.group;
	add("all of them share one group", !!group && newStrokes.every((s) => s.group === group) && newEls[0]!.group === group);

	v.runAction("sign-and-date");
	await frames(4);
	await new Promise((r) => window.setTimeout(r, 300));
	btn(/^Place$/)?.click();
	await frames(6);
	const second = page().strokes.slice(strokes0 + 2);
	add("a second placement gets a group of its own", second.length === 2 && !!second[0]!.group && second[0]!.group !== group);
	v.undo();
	await frames(3);
	add("one undo takes the whole second placement away", page().strokes.length === strokes0 + 2 && (page().elements?.length ?? 0) === elements0 + 1);
	v.redo();
	await frames(3);
	add("one redo puts it back", page().strokes.length === strokes0 + 4);
	v.undo();
	await frames(3);

	const locked = v.setPageLocked(page(), true);
	await frames(2);
	const before = page().strokes.length;
	if (locked) {
		v.runAction("sign-and-date");
		await frames(4);
		btn(/^Place$/)?.click();
		await frames(4);
	}
	add("a locked page refuses the signature", locked && page().strokes.length === before);
	v.setPageLocked(page(), false);
	await frames(2);
	document.querySelectorAll<HTMLElement>(".nb-sign .nb-modal-close, .modal-container .modal-close-button").forEach((b) => b.click());

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: {} };
}

/** Leaves one state on screen for a screenshot. */
export async function signstampShot(api: SignstampCheckApi, state: SignstampState): Promise<void> {
	const v = api.view as SignView;
	const { frames } = api;
	if (state === "placed") {
		await openDialog(v, frames);
		btn(/^Place$/)?.click();
		await frames(8);
		return;
	}
	await openDialog(v, frames);
	if (state === "empty") return;
	await drawSignature(v, frames);
	if (state === "pad") return;
	btn(/Save signature/)?.click();
	await frames(12);
}
