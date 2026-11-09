/**
 * 0.15 review fixes, view side: switching and playing states never writes the notebook (the state shown is the view's own;
 * only "Set as default state" writes, as one undo step), and the part editor's selection has no colour or width rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
	class Stub {}
	const real: Record<string, unknown> = {
		setIcon: () => undefined,
		getLanguage: () => "en",
		Notice: class {
			hide(): void {}
			setMessage(): void {}
		},
		Menu: class {
			addItem(): this {
				return this;
			}
			showAtMouseEvent(): void {}
		},
	};
	// Every other export the imported modules name (Modal, Setting, TFile...) is an empty class.
	return new Proxy(real, { get: (target, key) => (key === "then" ? undefined : key in target ? target[key as string] : Stub), has: (_t, key) => key !== "then" });
});
vi.mock("../src/library/library-modals", () => ({ PromptModal: class {} }));
vi.mock("../src/view/toolbar", () => ({ PEN_COLORS: ["#111111"], PEN_WIDTHS: [1], HIGHLIGHTER_COLORS: ["#ffee00"], HIGHLIGHTER_WIDTHS: [10] }));

import { createDocument, createStroke } from "../src/model/document";
import { History } from "../src/model/history";
import { freezeStroke } from "../src/model/serialize";
import { addState, makePart, withActive, withPose } from "../src/model/states";
import type { NotebookDocument, Page, Stroke } from "../src/model/types";
import { SelectionActions, type SelectionHost, type SelectionState } from "../src/view/selection-actions";
import { StatesTools, type StatesHost } from "../src/view/states-tools";

const stamp = "2026-11-04T10:00:00.000Z";

function seeded(seed: number): () => number {
	let x = seed;
	return () => {
		x = (x * 1103515245 + 12345) % 2147483648;
		return x / 2147483648;
	};
}

function stroke(id: string, x: number): Stroke {
	return freezeStroke({ ...createStroke("#111111", 2, [[x, 10, 0.5], [x + 30, 10, 0.5], [x + 30, 40, 0.5]]), id });
}

/** A page with a part and two states ("A" and "B"); `active` is "A". */
function fixture(): { doc: NotebookDocument; page: Page; a: string; b: string } {
	const doc = createDocument(new Date(stamp));
	const page = doc.pages[0]!;
	page.strokes.push(stroke("s1", 10), stroke("s2", 100));
	const part = makePart(undefined, [page.strokes[0]!], "Block", seeded(1))!;
	const a = addState(part.states, "A", null, seeded(2))!;
	const b = addState(a.states, "B", a.stateId, seeded(3))!;
	let states = withPose(b.states, b.stateId, part.partId, { dx: 50 });
	states = withActive(states, a.stateId);
	page.states = states;
	return { doc, page, a: a.stateId, b: b.stateId };
}

interface Rig {
	tools: StatesTools;
	doc: NotebookDocument;
	page: Page;
	ids: { a: string; b: string };
	history: History;
	executed: string[];
	repaints: number;
}

function rig(editable = true): Rig {
	const f = fixture();
	const history = new History(() => f.doc);
	const executed: string[] = [];
	const state = { repaints: 0 };
	const host: StatesHost = {
		app: {} as never,
		parent: () => ({}) as HTMLElement,
		doc: () => f.doc,
		editable: () => editable,
		pageIndex: () => 0,
		execute: (cmd) => {
			executed.push(cmd.label);
			return history.execute(cmd);
		},
		repaint: () => void state.repaints++,
		selection: () => null,
		select: () => undefined,
		deselect: () => undefined,
		refreshUi: () => undefined,
	};
	const out: Rig = { tools: new StatesTools(host), doc: f.doc, page: f.page, ids: { a: f.a, b: f.b }, history, executed, repaints: 0 };
	Object.defineProperty(out, "repaints", { get: () => state.repaints });
	return out;
}

describe("B3: switching and playing states writes nothing", () => {
	// The tools use window.setInterval: a window with a clock that only moves when the test says so.
	const intervals = new Map<number, () => void>();
	let nextTimer = 1;
	const tick = (): void => {
		for (const fn of [...intervals.values()]) fn();
	};
	beforeEach(() => {
		intervals.clear();
		vi.stubGlobal("window", {
			setInterval: (fn: () => void) => {
				intervals.set(nextTimer, fn);
				return nextTimer++;
			},
			clearInterval: (id: number) => void intervals.delete(id),
		});
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("a notebook that can be edited keeps its table when a chip is tapped: no command, same table, the view shows the choice", () => {
		const r = rig();
		const table = r.page.states;
		expect(r.tools.shownStates.size).toBe(0);
		r.tools.switchTo(r.ids.b);
		expect(r.executed).toEqual([]);
		expect(r.page.states).toBe(table);
		expect(r.page.states!.active).toBe(r.ids.a);
		expect(r.tools.shownStates.get(r.page.id)).toBe(r.ids.b);
		expect(r.tools.viewPages([r.page])[0]!.strokes[0]).not.toBe(r.page.strokes[0]);
		r.tools.switchTo(null);
		expect(r.tools.viewPages([r.page])[0]!.strokes[0]).toBe(r.page.strokes[0]);
		expect(r.executed).toEqual([]);
		expect(r.page.states).toBe(table);
		expect(r.repaints).toBe(2);
	});

	it("playing shows every state in turn, stops on the last and writes nothing", () => {
		const r = rig();
		const table = r.page.states;
		r.tools.switchTo(null);
		r.tools.togglePlay();
		expect(r.tools.playingNow).toBe(true);
		const seen: Array<string | null | undefined> = [r.tools.shownStates.get(r.page.id)];
		for (let i = 0; i < 4; i++) {
			tick();
			seen.push(r.tools.shownStates.get(r.page.id));
		}
		expect(seen.slice(0, 3)).toEqual([null, r.ids.a, r.ids.b]);
		expect(r.tools.playingNow).toBe(false);
		expect(r.tools.shownStates.get(r.page.id)).toBe(r.ids.b);
		expect(r.executed).toEqual([]);
		expect(r.page.states).toBe(table);
		expect(r.page.states!.active).toBe(r.ids.a);
	});

	it("stepping and stopping the playback in the middle write nothing either", () => {
		const r = rig();
		const table = r.page.states;
		r.tools.togglePlay();
		tick();
		r.tools.togglePlay();
		expect(r.tools.playingNow).toBe(false);
		expect(r.executed).toEqual([]);
		expect(r.page.states).toBe(table);
	});

	it("only 'Set as default state' writes active: one undo step, and 'As drawn' can be the default", () => {
		const r = rig();
		r.tools.switchTo(r.ids.b);
		r.tools.setDefault();
		expect(r.executed).toEqual(["Set default state"]);
		expect(r.page.states!.active).toBe(r.ids.b);
		r.history.undo();
		expect(r.page.states!.active).toBe(r.ids.a);
		r.history.redo();
		expect(r.page.states!.active).toBe(r.ids.b);
		r.history.undo();
		// Already the default: nothing to write.
		r.tools.switchTo(r.ids.a);
		r.tools.setDefault();
		expect(r.executed).toEqual(["Set default state"]);
		r.tools.switchTo(null);
		r.tools.setDefault();
		expect(r.page.states!.active).toBeUndefined();
		expect(r.executed).toEqual(["Set default state", "Set default state"]);
		r.history.undo();
		expect(r.page.states!.active).toBe(r.ids.a);
	});

	it("a read-only notebook cannot set the default but still switches", () => {
		const r = rig(false);
		r.tools.switchTo(r.ids.b);
		r.tools.setDefault();
		expect(r.executed).toEqual([]);
		expect(r.page.states!.active).toBe(r.ids.a);
		expect(r.tools.shownStates.get(r.page.id)).toBe(r.ids.b);
	});

	it("a choice survives the editable flag changing, and a state that goes away falls back to the saved default", () => {
		const r = rig();
		r.tools.switchTo(r.ids.b);
		r.tools.refresh();
		expect(r.tools.shownStates.get(r.page.id)).toBe(r.ids.b);
		// The state is deleted elsewhere (a sync): the view shows the saved default instead of a state that does not exist.
		r.page.states = { ...r.page.states!, list: r.page.states!.list.filter((s) => s.id !== r.ids.b) };
		expect(r.tools.viewPages([r.page])[0]!.strokes).toEqual(r.page.strokes);
	});
});

// --- B4: the part editor's selection ---

class El {
	children: El[] = [];
	dataset: Record<string, string> = {};
	classes = new Set<string>();
	constructor(readonly tag = "div") {}
	createDiv(o?: { cls?: string }): El {
		return this.add("div", o);
	}
	createSpan(o?: { cls?: string }): El {
		return this.add("span", o);
	}
	createEl(tag: string, o?: { cls?: string }): El {
		return this.add(tag, o);
	}
	private add(tag: string, o?: { cls?: string }): El {
		const el = new El(tag);
		for (const c of (o?.cls ?? "").split(" ")) if (c) el.classes.add(c);
		this.children.push(el);
		return el;
	}
	empty(): void {
		this.children = [];
	}
	remove(): void {}
	addClass(c: string): void {
		this.classes.add(c);
	}
	toggleClass(c: string, on: boolean): void {
		if (on) this.classes.add(c);
		else this.classes.delete(c);
	}
	addEventListener(): void {}
	setCssProps(): void {}
	// The opacity row of the selection bar (0.26) builds a slider with a value label.
	setText(): void {}
	setAttribute(): void {}
	get childElementCount(): number {
		return this.children.length;
	}
}

function selectionRig(owned: boolean | undefined, editable = true): { bar: El; actions: SelectionActions } {
	const f = fixture();
	const sel: SelectionState = { pageIndex: 0, strokes: [f.page.strokes[0]!], elements: [] };
	const host: Partial<SelectionHost> = {
		doc: () => f.doc,
		editable: () => editable,
		selection: () => sel,
	};
	if (owned !== undefined) host.ownedByStates = () => owned;
	const parent = new El();
	const actions = new SelectionActions(parent as unknown as HTMLElement, host as SelectionHost);
	return { bar: parent.children[0]!, actions };
}

describe("B4: the part editor's selection shows no colour or width rows", () => {
	it("ordinary ink selected: the rows are there (colour and width)", () => {
		const { bar, actions } = selectionRig(false);
		actions.update();
		expect(bar.classes.has("notebook-hidden")).toBe(false);
		expect(bar.childElementCount).toBeGreaterThan(0);
	});

	it("the same selection owned by the states' part editor: no rows, the bar is hidden", () => {
		const { bar, actions } = selectionRig(true);
		actions.update();
		expect(bar.childElementCount).toBe(0);
		expect(bar.classes.has("notebook-hidden")).toBe(true);
		expect(bar.dataset.kind).toBeUndefined();
	});

	it("a host that does not know about states behaves as before, and a read-only notebook hides the bar", () => {
		const plain = selectionRig(undefined);
		plain.actions.update();
		expect(plain.bar.childElementCount).toBeGreaterThan(0);
		const readOnly = selectionRig(false, false);
		readOnly.actions.update();
		expect(readOnly.bar.classes.has("notebook-hidden")).toBe(true);
	});
});
