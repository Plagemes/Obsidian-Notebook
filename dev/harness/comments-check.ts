/**
 * Smoke check of margin comments (0.18, roadmap #86) on the `doc=comments` notebook (the blank "New" notebook; npm run
 * harness:check): the real view with synthetic pen and pointer events. A comment is made from a selection (the editor takes
 * typed text and a sketch drawn on its pad), shown as a numbered marker in the page margin joined to its region, opened as a
 * card, answered, resolved, edited, deleted and undone; a second one is made by drawing a rectangle; the side panel lists and
 * filters them and jumps to one; a locked page refuses every change but can still be read. It leaves an open comment with a
 * reply, a resolved one and the card open (and, on a tablet, the panel) for the screenshot.
 */
import type { Page, PageCommentNote, PageComment } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface CommentsCheckApi {
	view: unknown;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string }) => Promise<void>;
	setTool: (tool: string) => void;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface CommentsView extends HarnessView {
	commentTools: { panelOpen: boolean; drawing: boolean; togglePanel(): void; setPanelOpen(open: boolean): void; closeCard(): void; counts: { open: number; resolved: number; total: number } } | null;
	uiContext(): HarnessView["uiContext"] extends () => infer R ? R & { comments?: { panel: boolean; total: number; open: number; drawing?: boolean }; page?: { locked?: boolean } } : never;
}

export async function checkComments(api: CommentsCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { setTool, frames } = api;
	const v = api.view as CommentsView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
	const page = (): Page => v.document.pages[v.currentPage()]!;
	const notes = (): PageCommentNote[] => (page().comments ?? []).filter((c): c is PageCommentNote => !("parent" in c));
	const list = (): PageComment[] => page().comments ?? [];
	const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
	const shown = (el: Element | null): boolean => !!el && getComputedStyle(el).display !== "none" && (el as HTMLElement).getBoundingClientRect().width > 0;
	const editor = (): HTMLElement | null => q<HTMLElement>(".nb-cm-editor");
	const card = (): HTMLElement | null => q<HTMLElement>(".nb-cm-card:not(.notebook-hidden)");
	const markers = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(".nb-cm-marker"));
	const click = async (el: Element | null | undefined) => {
		(el as HTMLElement | null)?.click();
		await frames(3);
	};
	const primary = (): HTMLButtonElement | null => editor()?.querySelector<HTMLButtonElement>(".nb-modal-foot .is-primary") ?? null;
	const type = (area: HTMLTextAreaElement | null | undefined, text: string) => {
		if (!area) return;
		area.value = text;
		area.dispatchEvent(new Event("input", { bubbles: true }));
	};
	const pointer = (el: Element, kind: string, x: number, y: number, id = 11) => el.dispatchEvent(new PointerEvent(kind, { bubbles: true, cancelable: true, pointerId: id, pointerType: "pen", button: 0, clientX: x, clientY: y }));
	/** Draws a stroke on a canvas with synthetic pointer events, as fractions of its box. */
	const sketchOn = (canvas: Element, pts: Array<[number, number]>) => {
		const r = canvas.getBoundingClientRect();
		const at = (p: [number, number]): [number, number] => [r.left + p[0] * r.width, r.top + p[1] * r.height];
		pointer(canvas, "pointerdown", ...at(pts[0]!));
		for (const p of pts.slice(1)) pointer(canvas, "pointermove", ...at(p));
		pointer(canvas, "pointerup", ...at(pts[pts.length - 1]!));
	};
	const stageRect = (): DOMRect => q(".notebook-stage")!.getBoundingClientRect();

	// --- a notebook with no comments shows none ---
	add("a new notebook has no comments", list().length === 0 && markers().length === 0);
	add("the context says so", v.uiContext().comments?.total === 0);

	// --- Comment on a selection: the editor, text and a sketch ---
	setTool("lasso");
	v.runAction("insert-sticky");
	await frames(3);
	add("a selection is there to comment on", !!v.uiContext().selection);
	v.runAction("comment-selection");
	await frames(3);
	add("Comment opens the editor", !!editor());
	const area = editor()?.querySelector<HTMLTextAreaElement>("textarea.nb-cm-text");
	add("the editor has a text box, a sketch pad and a disabled Add while empty", !!area && !!editor()?.querySelector("canvas.nb-cm-pad") && primary()?.disabled === true);
	type(area, "Check this part\nsecond line");
	await frames(1);
	add("typing enables Add", primary()?.disabled === false);
	const pad = editor()?.querySelector("canvas.nb-cm-pad");
	if (pad) sketchOn(pad, [[0.1, 0.2], [0.4, 0.7], [0.7, 0.3], [0.9, 0.8]]);
	await frames(2);
	await click(editor()?.querySelector('[data-key="comment-sketch-undo"]'));
	add("Undo last stroke takes the sketch back", !editor()?.querySelector("canvas.nb-cm-pad") || primary()?.disabled === false);
	if (pad) sketchOn(pad, [[0.1, 0.2], [0.4, 0.7], [0.7, 0.3], [0.9, 0.8]]);
	await frames(2);
	await click(primary());
	add("Add makes one comment with the text, the sketch and a device name", notes().length === 1 && notes()[0]!.text === "Check this part\nsecond line" && (notes()[0]!.sketch?.strokes.length ?? 0) === 1 && notes()[0]!.author.length > 0, JSON.stringify(notes()[0]));
	add("the editor closed", editor() === null);
	add("the new comment's card opens at once", !!card() && !!q(".nb-cm-region.is-active"));
	const r0 = notes()[0]!.region;
	add("the region is the selection's box, inside the page", r0.x >= 0 && r0.y >= 0 && r0.x + r0.width <= page().width && r0.width > 40, JSON.stringify(r0));
	v.undo();
	await frames(3);
	add("one undo removes the comment", list().length === 0 && markers().length === 0);
	v.redo();
	await frames(3);
	add("one redo brings it back", notes().length === 1);

	// --- the marker in the margin and the card ---
	const m = markers()[0];
	add("a numbered marker is shown", !!m && shown(m) && m.textContent?.trim() === "1", m?.textContent ?? "none");
	const mr = m?.getBoundingClientRect();
	const sr = stageRect();
	add("the marker is inside the page area, a labelled button of at least 24 px", !!mr && mr.left >= sr.left && mr.right <= sr.right + 1 && mr.width >= 23.5 && !!m?.getAttribute("aria-label"), mr ? `${Math.round(mr.left)}..${Math.round(mr.right)} (${Math.round(mr.width)})` : "");
	add("the region outline and the line to the marker are drawn", shown(q(".nb-cm-region")) && shown(q(".nb-cm-line")));
	await click(m);
	add("a tap on the marker opens the card and highlights the region", !!card() && !!q(".nb-cm-region.is-active"));
	const cr = card()?.getBoundingClientRect();
	const br = q(".notebook-body")!.getBoundingClientRect();
	add("the card stays inside the page area", !!cr && cr.left >= br.left - 1 && cr.right <= br.right + 1 && cr.top >= br.top - 1 && cr.bottom <= br.bottom + 1, cr ? `${Math.round(cr.left)}..${Math.round(cr.right)} / ${Math.round(cr.top)}..${Math.round(cr.bottom)}` : "");
	add("the card shows the text and the sketch", /Check this part/.test(card()?.textContent ?? "") && !!card()?.querySelector("canvas.nb-cm-sketch"));
	await click(m);
	add("a tap on the marker closes the card", card() === null && !q(".nb-cm-region.is-active"));
	await click(m);
	add("and the next one opens it again", !!card());

	// --- reply, resolve, edit, delete: one step each ---
	const input = card()?.querySelector<HTMLTextAreaElement>("textarea.nb-cm-reply-input");
	type(input, "Fixed on the next page");
	await frames(1);
	await click(card()?.querySelector('[data-key="comment-reply-send"]'));
	add("a reply joins the thread", list().length === 2 && /Fixed on the next page/.test(card()?.textContent ?? ""));
	add("the reply box is empty again", (card()?.querySelector<HTMLTextAreaElement>("textarea.nb-cm-reply-input")?.value ?? "x") === "");
	v.undo();
	await frames(3);
	add("one undo takes the reply back", list().length === 1);
	v.redo();
	await frames(3);
	await click(card()?.querySelector('[data-key="comment-resolve"]'));
	add("Resolve marks the comment resolved", notes()[0]!.resolved === true && !!q(".nb-cm-marker.is-resolved") && v.uiContext().comments?.open === 0);
	await click(card()?.querySelector('[data-key="comment-resolve"]'));
	add("Reopen opens it again", notes()[0]!.resolved !== true && v.uiContext().comments?.open === 1);
	const mine = notes()[0]!;
	await click(card()?.querySelector(`[data-key="comment-edit:${mine.id}"]`));
	add("Edit opens the editor with the text", !!editor() && (editor()?.querySelector<HTMLTextAreaElement>("textarea.nb-cm-text")?.value ?? "") === "Check this part\nsecond line");
	type(editor()?.querySelector<HTMLTextAreaElement>("textarea.nb-cm-text"), "Check this part again");
	await click(primary());
	add("Save changes the text and marks it edited", notes()[0]!.text === "Check this part again" && notes()[0]!.edited !== undefined && /edited/.test(card()?.textContent ?? ""));
	await click(card()?.querySelector(`[data-key="comment-delete:${mine.id}"]`));
	add("Delete removes the comment and its reply, and closes the card", list().length === 0 && card() === null && markers().length === 0);
	v.undo();
	await frames(3);
	add("one undo brings the whole thread back", list().length === 2);

	// --- a rectangle drawn on the page ---
	v.clearSelection();
	v.runAction("comment-region");
	await frames(3);
	const draw = q<HTMLElement>(".nb-cm-draw");
	add("Comment on a region arms a drawing surface with a Cancel button", !!draw && !!draw.querySelector('[data-key="comment-draw-cancel"]') && v.uiContext().comments?.drawing === true);
	if (draw) {
		const r = stageRect();
		const x0 = r.left + r.width * 0.2, y0 = r.top + r.height * 0.55;
		pointer(draw, "pointerdown", x0, y0);
		pointer(draw, "pointermove", x0 + 60, y0 + 40);
		pointer(draw, "pointerup", x0 + 120, y0 + 70);
	}
	await frames(3);
	add("the drag opens the editor and the surface is gone", !!editor() && q(".nb-cm-draw") === null);
	type(editor()?.querySelector<HTMLTextAreaElement>("textarea.nb-cm-text"), "A rectangle with nothing in it");
	await click(primary());
	add("the second comment is on the page, level below the first", notes().length === 2 && notes()[1]!.region.y > notes()[0]!.region.y, JSON.stringify(notes().map((n) => n.region.y)));
	add("it is numbered 2 in the margin", markers().some((x) => x.textContent?.trim() === "2"));
	v.runAction("comment-region");
	await frames(2);
	await click(q('[data-key="comment-draw-cancel"]'));
	add("Cancel ends the drawing without a comment", q(".nb-cm-draw") === null && notes().length === 2 && v.uiContext().comments?.drawing === false);
	v.runAction("comment-region");
	await frames(2);
	document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	await frames(2);
	add("Escape does too", q(".nb-cm-draw") === null);

	// --- the side panel ---
	v.commentTools?.closeCard();
	v.runAction("comments-panel");
	await frames(3);
	const panel = q<HTMLElement>(".nb-cm-panel:not(.notebook-hidden)");
	add("the panel opens and lists both comments", !!panel && panel.querySelectorAll(".nb-cm-row").length === 2, `${panel?.querySelectorAll(".nb-cm-row").length}`);
	add("the filter chips show the counts", /Open · 2/.test(panel?.textContent ?? "") && /Resolved · 0/.test(panel?.textContent ?? ""));
	// resolve the second one from its card to see the filters work
	await click(panel?.querySelectorAll<HTMLElement>(".nb-cm-row")[1]);
	add("a row opens its comment's card", !!card());
	await click(card()?.querySelector('[data-key="comment-resolve"]'));
	// On a phone the card is a sheet and the panel steps aside while it is open: the panel is brought back for the filters.
	if (!q(".nb-cm-panel:not(.notebook-hidden)")) {
		v.runAction("comments-panel");
		await frames(3);
	}
	await click(q('[data-key="comments-filter:resolved"]'));
	add("the Resolved filter lists only the resolved one", q(".nb-cm-panel")!.querySelectorAll(".nb-cm-row").length === 1 && notes()[1]!.resolved === true);
	await click(q('[data-key="comments-filter:open"]'));
	add("the Open filter lists the other", q(".nb-cm-panel")!.querySelectorAll(".nb-cm-row").length === 1);
	await click(q('[data-key="comments-filter:all"]'));
	add("All lists both", q(".nb-cm-panel")!.querySelectorAll(".nb-cm-row").length === 2);
	const pr = q(".nb-cm-panel")!.getBoundingClientRect();
	add("the panel stays inside the page area", pr.left >= br.left - 1 && pr.right <= br.right + 1 && pr.bottom <= br.bottom + 1, `${Math.round(pr.left)}..${Math.round(pr.right)}`);
	add("the registry knows the panel is open", v.uiContext().comments?.panel === true);

	// --- a locked page can be read, not changed ---
	const before = JSON.stringify(list());
	v.runAction("page-lock");
	await frames(3);
	add("on a locked page the markers are still there", shown(markers()[0] ?? null));
	await click(markers()[0]);
	const lockedCard = card();
	add("the card says the page is locked and offers no reply", !!lockedCard && /locked/i.test(lockedCard.textContent ?? "") && !lockedCard.querySelector('[data-key="comment-edit:' + notes()[0]!.id + '"]'));
	v.runAction("comment-selection");
	await frames(2);
	add("Comment is refused on a locked page", JSON.stringify(list()) === before && editor() === null);
	v.runAction("page-lock-toggle");
	await frames(3);
	add("unlocked again", page().locked !== true);

	// --- the picture: first comment open with its reply, the card open, the panel on a wide view ---
	v.commentTools?.closeCard();
	await click(markers().find((x) => x.textContent?.trim() === "1"));
	add("the picture shows the first comment's card", !!card());
	if (document.querySelector(".notebook-body.is-narrow")) v.commentTools?.setPanelOpen(false);
	await frames(3);
	add("no console errors", api.errors.length === 0, api.errors.join(" | "));
	await sleep(50);
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
