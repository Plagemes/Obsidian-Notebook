/**
 * Smoke check of groups and locked elements (0.20, roadmap #39) on the `doc=groups` notebook (the blank "New" notebook; npm run
 * harness:check): the real view with synthetic pen events. Two frames and two strokes are selected with the lasso and grouped from the
 * registry (one undo step); a tap with the lasso on one member selects the whole group; Ungroup splits it; Lock fixes the frames, after
 * which a lasso over the page leaves them out and a tap on one shows the "Locked · Unlock" chip, whose button unlocks it; the page menu's
 * "Locked elements…" lists what is locked and unlocks it; a locked page refuses all of it. It leaves the two frames locked, the ink
 * grouped with them, and the chip over one frame for the screenshot.
 */
import { AddElement } from "../../src/model/history";
import type { BoxElement, Page, PageElement, Stroke } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface GroupsCheckApi {
	view: unknown;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string; steps?: number }) => Promise<void>;
	setTool: (tool: string) => void;
	strokeCount: () => number;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface GroupsView extends HarnessView {
	selection: { elements: PageElement[]; strokes: Stroke[] } | null;
	setPageLocked(page: Page, value: boolean): boolean;
	runAction(id: string, arg?: { page?: number; value?: string }): void;
	uiContext(): HarnessView["uiContext"] extends () => infer R ? R & { selection?: { grouped?: number; canGroup?: boolean; strokes?: number; elements?: number } | null; page?: { lockedElements?: number } } : never;
}

export async function checkGroups(api: GroupsCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { penStroke, setTool, frames } = api;
	const v = api.view as GroupsView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const page = (): Page => v.document.pages[v.currentPage()]!;
	const frames_ = (): BoxElement[] => (page().elements ?? []).filter((e): e is BoxElement => e.type === "box");
	const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
	const click = async (el: Element | null | undefined) => {
		(el as HTMLElement | null)?.click();
		await frames(2);
	};
	/** A point of the page in view as fractions of the stage (what the synthetic pen takes). */
	const frac = (x: number, y: number): [number, number] => {
		const r = q(".notebook-stage")!.getBoundingClientRect();
		const box = v.layout.boxes[v.currentPage()]!;
		return [(v.viewport.offsetX + (box.x + x) * v.viewport.scale) / r.width, (v.viewport.offsetY + (box.y + y) * v.viewport.scale) / r.height];
	};
	/** A lasso around the page rectangle. */
	const around = (x0: number, y0: number, x1: number, y1: number): Array<[number, number]> => [frac(x0, y0), frac(x1, y0), frac(x1, y1), frac(x0, y1), frac(x0, y0 + 2)];
	const chipEl = (): HTMLElement | null => q<HTMLElement>(".nb-grp-chip");
	const listEl = (): HTMLElement | null => q<HTMLElement>(".nb-grp-modal");
	const groupsOf = (): Array<string | undefined> => [...page().strokes.map((s) => s.group), ...(page().elements ?? []).map((e) => e.group)];

	// --- the content: two frames and two strokes ---
	setTool("pen");
	await penStroke([frac(250, 120), frac(300, 112), frac(340, 124)]);
	await penStroke([frac(250, 175), frac(300, 168), frac(340, 180)]);
	const firstFrame: BoxElement = { id: "grp-frame-1", type: "box", kind: "definition", x: 90, y: 100, width: 130, height: 50, title: "Definition" };
	const secondFrame: BoxElement = { id: "grp-frame-2", type: "box", kind: "example", x: 90, y: 160, width: 130, height: 50, title: "Example" };
	v.applyCommand(new AddElement(page().id, firstFrame, 0));
	v.applyCommand(new AddElement(page().id, secondFrame, 1));
	await frames(3);
	add("a new page has two ink strokes and two frames, none grouped or locked", page().strokes.length === 2 && frames_().length === 2 && groupsOf().every((g) => g === undefined) && frames_().every((f) => f.locked !== true));

	// --- group ---
	setTool("lasso");
	await penStroke(around(60, 90, 380, 225));
	await frames(3);
	add("a lasso over everything selects the two strokes and the two frames", v.selection?.strokes.length === 2 && v.selection?.elements.length === 2);
	add("the bar offers Group (and not Ungroup)", v.uiContext().selection?.canGroup === true && v.uiContext().selection?.grouped === 0);
	v.runAction("selection-group");
	await frames(3);
	const ids = new Set(groupsOf());
	add("Group gives all four one group id", ids.size === 1 && !ids.has(undefined), JSON.stringify([...ids]));
	add("the grouped items stay selected and the bar now offers Ungroup, not Group", v.selection?.strokes.length === 2 && v.selection?.elements.length === 2 && v.uiContext().selection?.canGroup === false && v.uiContext().selection?.grouped === 4);
	v.undo();
	await frames(2);
	add("one undo takes the group away", groupsOf().every((g) => g === undefined));
	v.redo();
	await frames(2);
	add("one redo makes it again", new Set(groupsOf()).size === 1 && groupsOf()[0] !== undefined);

	// --- tapping one member selects the group ---
	v.clearSelection();
	await frames(2);
	await penStroke([frac(150, 125)]);
	await frames(3);
	add("a tap with the lasso on one frame selects the whole group", v.selection?.strokes.length === 2 && v.selection?.elements.length === 2, `${v.selection?.strokes.length} strokes, ${v.selection?.elements.length} frames`);
	v.clearSelection();
	await frames(2);
	await penStroke([frac(300, 112)]);
	await frames(3);
	add("a tap on a grouped stroke selects the whole group too", v.selection?.strokes.length === 2 && v.selection?.elements.length === 2);

	// --- ungroup ---
	v.runAction("selection-ungroup");
	await frames(3);
	add("Ungroup splits the group in one step", groupsOf().every((g) => g === undefined));
	v.undo();
	await frames(2);
	add("one undo makes the group again", new Set(groupsOf()).size === 1 && groupsOf()[0] !== undefined);

	// --- lock ---
	v.clearSelection();
	await frames(2);
	await penStroke([frac(150, 125)]);
	await frames(3);
	add("the group is selected again", v.selection?.elements.length === 2 && (v.uiContext().selection?.elements ?? 0) === 2);
	v.runAction("selection-lock");
	await frames(3);
	add("Lock locks both frames and drops the selection", frames_().every((f) => f.locked === true && typeof f.lockAt === "number") && v.selection === null);
	add("the page now reports two locked elements", v.uiContext().page?.lockedElements === 2);
	setTool("lasso");
	await penStroke(around(60, 90, 380, 225));
	await frames(3);
	add("a lasso over everything leaves the locked frames out and picks the strokes", v.selection?.strokes.length === 2 && v.selection?.elements.length === 0, `${v.selection?.strokes.length} strokes, ${v.selection?.elements.length} frames`);
	v.clearSelection();
	await frames(2);

	// --- the chip ---
	await penStroke([frac(150, 125)]);
	await frames(3);
	add("a tap on a locked frame selects nothing", v.selection === null);
	add("and shows the Locked chip with an Unlock button", !!chipEl() && !!chipEl()!.querySelector("button"));
	await click(chipEl()?.querySelector("button"));
	add("Unlock on the chip unlocks that frame and goes away", frames_()[0]!.locked !== true && frames_()[1]!.locked === true && chipEl() === null);
	v.undo();
	await frames(2);
	add("one undo locks it again", frames_()[0]!.locked === true);

	// --- the list in the page menu ---
	v.runAction("locked-elements", { page: v.currentPage() });
	await frames(3);
	const rows = (): HTMLElement[] => [...(listEl()?.querySelectorAll<HTMLElement>(".nb-grp-row") ?? [])];
	add("Locked elements… lists both frames", !!listEl() && rows().length === 2);
	await click(rows()[0]?.querySelector(".nb-grp-row-unlock"));
	add("Unlock in the list unlocks one frame and redraws the list", rows().length === 1 && frames_().filter((f) => f.locked === true).length === 1);
	await click(listEl()?.querySelector(".nb-modal-foot button"));
	add("the list closes", listEl() === null);
	// both locked again, as one step each
	setTool("lasso");
	await penStroke([frac(150, 125)]);
	await frames(3);
	v.runAction("selection-lock");
	await frames(3);
	add("both frames are locked again", frames_().every((f) => f.locked === true));

	// --- the page lock is respected ---
	v.setPageLocked(page(), true);
	await frames(2);
	setTool("lasso");
	await penStroke(around(60, 90, 380, 225));
	await frames(3);
	const before = JSON.stringify(groupsOf());
	v.runAction("selection-ungroup");
	await frames(2);
	add("a locked page refuses Ungroup", JSON.stringify(groupsOf()) === before);
	v.clearSelection();
	v.setPageLocked(page(), false);
	await frames(2);

	// --- the state that stays for the screenshot ---
	v.clearSelection();
	setTool("lasso");
	await penStroke([frac(150, 185)]);
	await frames(3);
	add("the chip is over the second frame for the screenshot", !!chipEl());
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: {} };
}
