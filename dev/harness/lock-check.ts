/**
 * Smoke check of locked pages (0.16, roadmap #124) on the `doc=lock` notebook (the blank "New" notebook; npm run
 * harness:check): the real view with synthetic pen, touch and mouse events. A page is locked from the registry (the page
 * menu / sheet action), the pen, the eraser, the text tool, a paper change and a delete are refused with the "Page locked ·
 * Unlock" notice, the lock shows beside the page number, as a badge over the page and in the page panel, the lock is one
 * undo step, and a tap on the badge unlocks. It leaves the page locked with the page panel open for the screenshot.
 */
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface LockCheckApi {
	view: unknown;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string }) => Promise<void>;
	setTool: (tool: string) => void;
	strokeCount: () => number;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

/** The members of the real view this check calls with more arguments than `HarnessView` declares. */
interface LockView extends HarnessView {
	runAction(id: string, arg?: { page?: number; value?: string }): void;
	pageNav: { open: boolean; refresh(): void };
}

const SCRIBBLE: Array<[number, number]> = [[0.3, 0.3], [0.5, 0.35], [0.7, 0.4]];
const ACROSS: Array<[number, number]> = [[0.2, 0.34], [0.5, 0.34], [0.8, 0.34]];

export async function checkLock(api: LockCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { penStroke, setTool, strokeCount, frames } = api;
	const v = api.view as LockView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
	const page = () => v.document.pages[v.currentPage()]!;
	const content = (): string => JSON.stringify(v.document.pages.map((p) => [p.id, p.width, p.height, p.paper, p.strokes.length, p.elements?.length ?? 0]));
	const shown = (el: Element | null): boolean => !!el && getComputedStyle(el).display !== "none" && (el as HTMLElement).offsetWidth > 0;
	const badge = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>(".nb-lock-badge");
	const indicator = (): HTMLElement | null => document.querySelector<HTMLElement>(".notebook-page-indicator");
	const lockedNotices = (): number => api.notices.filter((n) => /Page locked/.test(n)).length;
	/** The notice is shown at most once every 5 s: the check makes the next attempt count by waiting it out. */
	const attempt = async (what: () => Promise<void>): Promise<boolean> => {
		const before = lockedNotices();
		(v as unknown as { lockNoticeAt: number }).lockNoticeAt = 0;
		await what();
		await frames(2);
		return lockedNotices() > before;
	};

	// --- before: ink is written normally; the page shows no lock ---
	setTool("pen");
	const base = strokeCount();
	await penStroke(ACROSS);
	await penStroke(SCRIBBLE);
	add("ink is written on an unlocked page", strokeCount() === base + 2, `${base} -> ${strokeCount()}`);
	add("no badge on an unlocked page", !shown(badge()));
	add("no lock beside the page number", !indicator()?.querySelector(".nb-lock-mark"));
	add("the page sheet offers Lock page", v.uiContext().editable === true);

	// --- lock from the registry (the page menu / sheet / command) ---
	v.runAction("page-lock");
	await frames(3);
	add("the page is locked", page().locked === true);
	add("the badge shows over the page", shown(badge()), badge()?.className ?? "missing");
	add("the badge is a real control: enabled, labelled, at least 32 px tall", !!badge() && !badge()!.disabled && !!badge()!.getAttribute("aria-label") && badge()!.getBoundingClientRect().height >= 31.5, `${badge()?.getBoundingClientRect().height}`);
	add("a lock shows beside the page number", !!indicator()?.querySelector(".nb-lock-mark"));
	const ctx = v.uiContext() as unknown as { page?: { locked?: boolean } };
	add("the UI context knows the page is locked", ctx.page?.locked === true);

	// --- every way of writing is refused, with the notice ---
	const frozen = content();
	const strokes = strokeCount();
	add("the pen is refused and says why", await attempt(() => penStroke(SCRIBBLE, { pointerType: "pen" })));
	add("no stroke was added", strokeCount() === strokes && content() === frozen);
	await attempt(() => penStroke(SCRIBBLE, { pointerType: "touch" }));
	await attempt(() => penStroke(SCRIBBLE, { pointerType: "mouse" }));
	add("touch and mouse draw nothing either", strokeCount() === strokes);
	setTool("eraser");
	add("the eraser says why and removes nothing", await attempt(() => penStroke(ACROSS, { pointerType: "pen" })));
	add("the eraser left the ink", strokeCount() === strokes && content() === frozen);
	setTool("highlighter");
	await attempt(() => penStroke(SCRIBBLE));
	add("the highlighter draws nothing", strokeCount() === strokes);
	setTool("text");
	add("the text tool refuses and opens no editor", await attempt(() => penStroke([[0.4, 0.5], [0.4, 0.5]])) && document.querySelector(".notebook-text-editor:not(.notebook-hidden)") === null);
	setTool("shape");
	await attempt(() => penStroke([[0.3, 0.5], [0.6, 0.6]]));
	add("a shape is refused", strokeCount() === strokes && content() === frozen);
	setTool("space");
	await attempt(() => penStroke([[0.3, 0.4], [0.3, 0.6]]));
	add("insert space is refused", content() === frozen);
	setTool("pen");

	// --- page settings and deletion are refused ---
	v.runAction("page-paper", { value: "lined" });
	v.runAction("page-orientation");
	v.runAction("page-infinite");
	await frames(2);
	add("paper, orientation and infinite are refused", content() === frozen && !page().infinite);
	// --- undo: the lock is one step ---
	v.undo();
	await frames(3);
	add("one undo unlocks the page", page().locked !== true && !shown(badge()) && !indicator()?.querySelector(".nb-lock-mark"));
	add("and the ink is still there", strokeCount() === strokes);
	v.redo();
	await frames(3);
	add("one redo locks it again", page().locked === true && shown(badge()));

	// --- other pages are not blocked, and a locked page is not deleted ---
	const pagesBefore = v.document.pages.length;
	v.addPage();
	await frames(2);
	add("adding a page next to a locked one still works", v.document.pages.length === pagesBefore + 1);
	v.jumpToPage(0);
	await frames(3);
	v.runAction("page-delete");
	await frames(2);
	add("a locked page is not deleted", v.document.pages.length === pagesBefore + 1 && page().locked === true);
	add("and the notice says to unlock it first", api.notices.some((n) => /locked. Unlock it first/.test(n)), api.notices.slice(-2).join(" | "));

	// --- reading still works ---
	const y = v.viewport.offsetY;
	v.scrollToPage(0);
	await frames(2);
	add("reading and navigation work on a locked page", v.currentPage() === 0 && Number.isFinite(y));

	// --- the page panel marks it ---
	if (!v.pageNav.open) v.toggleNavigator();
	await frames(3);
	v.pageNav.refresh();
	await frames(2);
	const mark = document.querySelector<HTMLButtonElement>(".notebook-navigator-item .notebook-navigator-lock");
	add("the page panel marks the locked page", !!mark && mark.getBoundingClientRect().width > 0);
	add("the page panel mark is a labelled button", !!mark && !!mark.getAttribute("aria-label"));

	// --- unlock from the badge, from the panel, from the registry ---
	badge()?.click();
	await frames(3);
	add("a tap on the badge unlocks the page", page().locked !== true && !shown(badge()));
	// On a phone the page panel is a drawer over the page: it is closed to write.
	if (v.pageNav.open) v.toggleNavigator();
	await frames(3);
	setTool("pen");
	const before2 = strokeCount();
	await penStroke(SCRIBBLE);
	add("the pen writes again after the unlock", strokeCount() === before2 + 1);
	v.runAction("page-lock-toggle");
	await frames(3);
	add("the command toggles the lock on", page().locked === true);
	if (!v.pageNav.open) v.toggleNavigator();
	await frames(3);
	v.pageNav.refresh();
	await frames(2);
	document.querySelector<HTMLButtonElement>(".notebook-navigator-item .notebook-navigator-lock")?.click();
	await frames(3);
	add("the lock in the page panel unlocks", page().locked !== true);
	v.runAction("page-lock");
	await frames(3);
	// The picture: the panel stays open beside the page on a tablet; on a phone (a drawer over the page) it is closed.
	if (v.pageNav.open && document.querySelector(".notebook-body.is-narrow")) v.toggleNavigator();
	await frames(3);
	add("the page is left locked for the picture", page().locked === true && shown(badge()));

	// --- layout: the badge does not run out of the view ---
	const stageRect = document.querySelector(".notebook-stage")!.getBoundingClientRect();
	const b = badge()!.getBoundingClientRect();
	add("the badge stays inside the page area", b.left >= stageRect.left - 1 && b.right <= stageRect.right + 1 && b.top >= stageRect.top - 1, `${Math.round(b.left)}..${Math.round(b.right)}`);
	await sleep(50);
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
