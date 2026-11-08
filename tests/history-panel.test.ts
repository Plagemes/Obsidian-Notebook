/**
 * 0.25 (#84): the action history panel — the title of every command class, the labels the code uses, the jump to a point (undo and
 * redo, through the ordinary History steps), a refused step in the middle, and the rows of the list.
 */
import { describe, expect, it, vi } from "vitest";
import { en } from "../src/i18n/en";
import { it as itMessages } from "../src/i18n/it";
import { RemoveAsset } from "../src/model/asset-ops";
import { UpdateCheckbox } from "../src/model/checklist-commands";
import { SetPageComments } from "../src/model/comments";
import { createDocument, createPage } from "../src/model/document";
import { UpdateItems } from "../src/model/groups";
import {
	AddAsset, AddElement, AddPage, AddStroke, Batch, DeletePage, EraseStrokes, History, InsertPages, MovePage, RemoveElement, ReorderLayer, ReplaceElement,
	ReplaceStroke, SetMeta, SetPageBackground, SetPageInfinite, SetPageMargins, SetPageSize, SetPaper, type Command,
} from "../src/model/history";
import { describeCommand, LABELS, leavesOf, titleForLabel } from "../src/model/history-describe";
import { finishJump, jumpHistory, JumpRunner, planJump } from "../src/model/history-jump";
import { SetMarkerDone } from "../src/model/marker-commands";
import { SetPageContent } from "../src/model/page-content";
import { exemptFromLocks, SetPageLocked } from "../src/model/page-lock";
import { ReorderPages } from "../src/model/page-ops";
import { ReplacePage } from "../src/model/page-restore";
import { SetPageTags } from "../src/model/page-tags";
import { SetPageTimes } from "../src/model/page-times";
import { freezeStroke } from "../src/model/serialize";
import { AddSlideRef } from "../src/model/slide-links";
import { SetPageStates } from "../src/model/states";
import { DEFAULT_META, type Asset, type NotebookDocument, type PageElement } from "../src/model/types";
import { SetViews } from "../src/model/views";
import { line, sampleDocument } from "./helpers";

/** Every source file of the plugin as text (the labels the code gives its steps are read from it). */
const SOURCES = import.meta.glob<string>("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

vi.mock("obsidian", () => ({ getLanguage: () => "en" }));

const { historyRows, jumpNotice, pagesText, timeText } = await import("../src/view/history-panel-logic");

const textBox = (id: string, text = "hello"): PageElement => ({ id, type: "text", x: 10, y: 10, width: 100, text, fontSize: 14, color: "#000000" });
const asset = { id: "a1", kind: "image", path: "x.png", name: "x.png", bytes: 1 } as unknown as Asset;

/** One instance of every command class that exists, with the key its title must be. */
function everyClass(): Array<[string, Command, string]> {
	const page = createPage();
	const other = createPage();
	const s = line(0, 0, 10, 10);
	const s2 = freezeStroke({ ...s, points: s.points.map(([x, y, p]) => [x + 5, y, p] as [number, number, number]) });
	const restyled = freezeStroke({ ...s, color: "#ff0000" });
	const shape = freezeStroke({ ...s, tool: "shape" });
	const shapeRestyled = freezeStroke({ ...shape, color: "#00ff00" });
	const el = textBox("e1");
	const paper = { kind: "ruled", spacing: 28 } as never;
	return [
		["AddStroke", new AddStroke(page.id, s, 0), "histpanel.t.stroke"],
		["EraseStrokes", new EraseStrokes(page.id, [{ stroke: s, index: 0 }]), "histpanel.t.erased"],
		["ReplaceStroke erase", new ReplaceStroke(page.id, s, [], 0), "histpanel.t.erased"],
		["ReplaceStroke cut", new ReplaceStroke(page.id, s, [s2, restyled], 0), "histpanel.t.cut"],
		["ReplaceStroke moved", new ReplaceStroke(page.id, s, [s2], 0), "histpanel.t.strokeChanged"],
		["ReplaceStroke restyled", new ReplaceStroke(page.id, s, [restyled], 0), "histpanel.t.strokeRestyled"],
		["ReplaceStroke shape restyled", new ReplaceStroke(page.id, shape, [shapeRestyled], 0), "histpanel.t.shapeRestyled"],
		["AddPage", new AddPage(other, 1), "histpanel.t.pageAdded"],
		["DeletePage", new DeletePage(other, 1), "histpanel.t.pageDeleted"],
		["MovePage", new MovePage(page.id, 0, 1), "histpanel.t.pageMoved"],
		["SetPaper", new SetPaper(page.id, paper, paper), "histpanel.t.paper"],
		["SetPageSize", new SetPageSize(page.id, { width: 1, height: 1 }, { width: 2, height: 2 }), "histpanel.t.pageSize"],
		["SetPageMargins", new SetPageMargins(page.id, undefined, { left: 1, right: 1, bottom: 1 }), "histpanel.t.margins"],
		["SetPageBackground", new SetPageBackground(page.id, { kind: "image", asset: "a1" } as never, { width: 1, height: 1 }), "histpanel.t.background"],
		["AddElement", new AddElement(page.id, el, 0), "histpanel.t.added"],
		["RemoveElement", new RemoveElement(page.id, el), "histpanel.t.removed"],
		["ReplaceElement", new ReplaceElement(page.id, el, textBox("e1", "other")), "histpanel.t.edited"],
		["ReorderLayer", new ReorderLayer(page.id, "strokes", [s], [s]), "histpanel.t.layerOrder"],
		["SetMeta", new SetMeta(DEFAULT_META, DEFAULT_META), "histpanel.t.meta"],
		["AddAsset", new AddAsset(asset), "histpanel.t.fileAdded"],
		["RemoveAsset", new RemoveAsset("a1"), "histpanel.t.fileRemoved"],
		["InsertPages", new InsertPages([other], 1), "histpanel.t.pagesInserted"],
		["SetPageInfinite", new SetPageInfinite(page.id, true), "histpanel.t.infinite"],
		["UpdateCheckbox", new UpdateCheckbox(page.id, "c1", (c) => c, "Edit checkbox"), "histpanel.t.checkbox"],
		["SetPageComments", new SetPageComments(page.id, undefined, [], "Change comments"), "histpanel.t.comments"],
		["SetPageComments (add)", new SetPageComments(page.id, undefined, [], "Add comment"), "histpanel.t.commentAdded"],
		["UpdateItems", new UpdateItems(page.id, new Set(["s"]), (i) => i, "Something unheard of"), "histpanel.t.items"],
		["UpdateItems (Group)", new UpdateItems(page.id, new Set(["s"]), (i) => i, "Group"), "histpanel.t.group"],
		["SetMarkerDone", new SetMarkerDone(page.id, "m1", true), "histpanel.t.marker"],
		["SetPageContent", new SetPageContent({ pageId: page.id, strokes: [], elements: undefined }), "histpanel.t.content"],
		["SetPageLocked", new SetPageLocked(page.id, true), "histpanel.t.pageLocked"],
		["ReorderPages", new ReorderPages([page.id], [page.id]), "histpanel.t.pagesReordered"],
		["ReplacePage", new ReplacePage(page, other), "histpanel.t.pageRestored"],
		["SetPageTags", new SetPageTags(page.id, undefined, ["a"]), "histpanel.t.pageTags"],
		["SetPageTimes", new SetPageTimes(page.id, { startAt: 1, endAt: 2 }), "histpanel.t.pageTimes"],
		["AddSlideRef", new AddSlideRef({ id: "r1", source: "x", page: 1 }), "histpanel.t.slideLink"],
		["SetPageStates", new SetPageStates(page.id, undefined, undefined, "Change states"), "histpanel.t.states"],
		["SetViews", new SetViews([], [], "Change saved views"), "histpanel.t.views"],
		["Batch (named)", new Batch("Restyle selection", [new ReplaceStroke(page.id, s, [restyled], 0), new ReplaceStroke(page.id, s, [restyled], 0)]), "histpanel.t.restyle"],
		["Batch of strokes", new Batch("Something unheard of", [new AddStroke(page.id, s, 0), new AddStroke(page.id, s2, 1)]), "histpanel.t.strokes"],
		["Batch of mixed parts", new Batch("Something unheard of", [new AddStroke(page.id, s, 0), new AddElement(page.id, el, 0)]), "histpanel.t.several"],
		["Batch of one named", new Batch("Delete selection", [new ReplaceStroke(page.id, s, [], 0)]), "histpanel.t.deleteSelection"],
		["lock-exempt wrapper", exemptFromLocks(new Batch("Merge conflicted copy", [new AddStroke(page.id, s, 0), new AddElement(page.id, el, 0)])), "histpanel.t.merged"],
	];
}

describe("the title of every step", () => {
	it("gives each command class its own title (never the generic one) and the key exists in English and Italian", () => {
		for (const [name, cmd, key] of everyClass()) {
			const d = describeCommand(cmd);
			expect(d.key, name).toBe(key);
			expect(d.key, name).not.toBe("histpanel.t.change");
			expect(en[d.key].length, name).toBeGreaterThan(0);
			expect(itMessages[d.key], name).toBeTruthy();
			expect(d.icon, name).toMatch(/^[a-z0-9-]+$/);
		}
	});

	it("names the kind of element an element step is about", () => {
		const page = createPage();
		for (const [type, noun] of [["text", "histpanel.thing.text"], ["sticky", "histpanel.thing.sticky"], ["checkbox", "histpanel.thing.checkbox"]] as const) {
			const d = describeCommand(new AddElement(page.id, { ...textBox("x"), type } as unknown as PageElement, 0));
			expect(d.thing, type).toBe(noun);
		}
	});

	it("counts the strokes and elements a batch touches, and the pages it is on, once each", () => {
		const a = createPage();
		const b = createPage();
		const s = line(0, 0, 10, 10);
		const d = describeCommand(new Batch("Move selection to page", [new ReplaceStroke(a.id, s, [], 0), new ReplaceStroke(a.id, s, [], 1), new AddStroke(b.id, s, 0), new EraseStrokes(b.id, [{ stroke: s, index: 0 }, { stroke: s, index: 1 }])]));
		expect(d.count).toBe(5);
		expect(d.pageIds).toEqual([a.id, b.id]);
	});

	it("falls back to a generic title for a command nobody has described, and uses its label when the code is known to use it", () => {
		const unknown: Command = { label: "Brand new thing", apply: () => undefined, revert: () => undefined };
		expect(describeCommand(unknown).key).toBe("histpanel.t.change");
		const known: Command = { label: "Insert PDF", apply: () => undefined, revert: () => undefined };
		expect(describeCommand(known).key).toBe("histpanel.t.pdf");
	});

	it("never throws, whatever the command is", () => {
		const broken = { label: "x", apply: () => undefined, revert: () => undefined, commands: null, inner: 5 } as unknown as Command;
		expect(() => describeCommand(broken)).not.toThrow();
		expect(describeCommand(broken).key).toBe("histpanel.t.change");
	});

	it("opens batches and the lock-exempt wrapper", () => {
		const page = createPage();
		const s = line(0, 0, 1, 1);
		const inner = new AddStroke(page.id, s, 0);
		expect(leavesOf(new Batch("a", [new Batch("b", [inner]), exemptFromLocks(inner)]))).toEqual([inner, inner]);
	});

	it("has a title for every label the source code gives a step", () => {
		const labels = new Set<string>();
		for (const code of Object.values(SOURCES)) {
			for (const re of [
				/new Batch\(\s*"([^"]+)"/g,
				/readonly label = "([^"]+)"/g,
				/\blabel = "([A-Z][^"]+)"[,)]/g,
				/new (?:UpdateItems|SetPageComments|SetPageStates|SetViews|UpdateCheckbox)\([^;\n]*?,\s*"([A-Z][^"]+)"\)/g,
				/\b(?:pasteCommand|applyPlacement)\([^;\n]*?"([A-Z][^"]+)"\)/g,
			]) for (const m of code.matchAll(re)) for (const g of m.slice(1)) if (g) labels.add(g);
		}
		expect(labels.size).toBeGreaterThan(50);
		expect([...labels].filter((l) => titleForLabel(l) === null).sort()).toEqual([]);
	});

	it("keeps every label of the table pointing at an existing English and Italian message", () => {
		for (const [label, [key]] of Object.entries(LABELS)) {
			expect(en[key], label).toBeTruthy();
			expect(itMessages[key], label).toBeTruthy();
		}
	});
});

describe("History.entries / stepsTo / depth", () => {
	function strokes(n: number) {
		const doc = sampleDocument(0);
		const page = doc.pages[0]!;
		let now = 1000;
		const history = new History(() => doc, 500, null, null, null, null, () => (now += 1000));
		const made = Array.from({ length: n }, (_, i) => new AddStroke(page.id, line(0, i * 10, 50, i * 10), i));
		for (const c of made) history.execute(c);
		return { doc, page, history, made };
	}

	it("lists the undo steps oldest first with the time they were made, and the redo steps with the next one first", () => {
		const { history, made } = strokes(4);
		history.undo();
		history.undo();
		const e = history.entries();
		expect(e.undo.map((x) => x.cmd)).toEqual([made[0], made[1]]);
		expect(e.redo.map((x) => x.cmd)).toEqual([made[2], made[3]]);
		// the time of each step is the clock when it was recorded, and it stays with the step through undo and redo
		const times = [...e.undo, ...e.redo].map((x) => x.at);
		expect(times.every((x) => typeof x === "number")).toBe(true);
		expect(times).toEqual([...times].sort((a, b) => (a as number) - (b as number)));
		expect(new Set(times).size).toBe(4);
		expect(history.depth()).toEqual({ undo: 2, redo: 2 });
	});

	it("counts the steps to a point", () => {
		const { history, made } = strokes(4);
		expect(history.stepsTo(made[3]!)).toEqual({ direction: "undo", steps: 0 });
		expect(history.stepsTo(made[0]!)).toEqual({ direction: "undo", steps: 3 });
		history.undo();
		history.undo();
		history.undo();
		expect(history.stepsTo(made[0]!)).toEqual({ direction: "undo", steps: 0 });
		expect(history.stepsTo(made[1]!)).toEqual({ direction: "redo", steps: 1 });
		expect(history.stepsTo(made[3]!)).toEqual({ direction: "redo", steps: 3 });
		expect(history.stepsTo(new AddStroke("p", line(0, 0, 1, 1), 0))).toBeNull();
	});

	it("changes nothing by being asked", () => {
		const { history } = strokes(3);
		const before = history.entries();
		history.entries().undo.pop();
		expect(history.entries().undo.length).toBe(before.undo.length);
	});
});

describe("jumping to a point", () => {
	function setup(n = 5) {
		const doc = sampleDocument(0);
		const page = doc.pages[0]!;
		const history = new History(() => doc);
		const made = Array.from({ length: n }, (_, i) => new AddStroke(page.id, line(0, i * 10, 50, i * 10), i));
		for (const c of made) history.execute(c);
		const ids = () => page.strokes.length;
		return { doc, page, history, made, ids };
	}

	it("goes back to the point just after a step, then forward again, and the document follows", () => {
		const { history, made, ids } = setup();
		const back = jumpHistory(history, { kind: "step", cmd: made[1]! });
		expect(back).toEqual({ direction: "undo", wanted: 3, done: 3, gone: false });
		expect(ids()).toBe(2);
		expect(history.depth()).toEqual({ undo: 2, redo: 3 });
		const forward = jumpHistory(history, { kind: "step", cmd: made[3]! });
		expect(forward).toEqual({ direction: "redo", wanted: 2, done: 2, gone: false });
		expect(ids()).toBe(4);
		expect(history.depth()).toEqual({ undo: 4, redo: 1 });
	});

	it("goes to the start of the history, and back to the end", () => {
		const { history, made, ids } = setup(3);
		expect(jumpHistory(history, { kind: "start" })).toMatchObject({ direction: "undo", wanted: 3, done: 3 });
		expect(ids()).toBe(0);
		expect(jumpHistory(history, { kind: "step", cmd: made[2]! })).toMatchObject({ direction: "redo", wanted: 3, done: 3 });
		expect(ids()).toBe(3);
	});

	it("takes no step when the document is already at the point", () => {
		const { history, made } = setup(3);
		expect(jumpHistory(history, { kind: "step", cmd: made[2]! })).toEqual({ direction: null, wanted: 0, done: 0, gone: false });
		expect(planJump(history, { kind: "step", cmd: made[2]! })).toEqual({ direction: "undo", steps: 0 });
	});

	it("reports a step that is no longer in the history, and changes nothing", () => {
		const { history, made, ids } = setup(3);
		jumpHistory(history, { kind: "step", cmd: made[0]! });
		history.execute(new AddStroke(made[0]!.pageId, line(9, 9, 20, 20), 1)); // a new edit clears the redo steps
		const r = jumpHistory(history, { kind: "step", cmd: made[2]! });
		expect(r).toEqual({ direction: null, wanted: 0, done: 0, gone: true });
		expect(ids()).toBe(2);
	});

	it("stops at a step the page lock refuses and says how far it got", () => {
		const doc = sampleDocument(0);
		doc.pages.push(createPage());
		const [p1, p2] = doc.pages as [NotebookDocument["pages"][number], NotebookDocument["pages"][number]];
		const locked: string[][] = [];
		const history = new History(() => doc, 500, null, null, null, (ids) => void locked.push([...ids]));
		const a1 = new AddStroke(p1.id, line(0, 0, 10, 0), 0);
		const a2 = new AddStroke(p1.id, line(0, 10, 10, 10), 1);
		const b1 = new AddStroke(p2.id, line(0, 0, 10, 10), 0);
		for (const c of [a1, a2, b1]) expect(history.execute(c)).toBe(true);
		p1.locked = true; // locked since (a change from elsewhere)
		const r = jumpHistory(history, { kind: "start" });
		expect(r).toEqual({ direction: "undo", wanted: 3, done: 1, gone: false });
		expect(locked).toEqual([[p1.id]]);
		expect(p2.strokes.length).toBe(0);
		expect(p1.strokes.length).toBe(2);
		// the refused step is still there to undo once the page is unlocked
		expect(history.depth()).toEqual({ undo: 2, redo: 1 });
		delete p1.locked;
		expect(jumpHistory(history, { kind: "start" })).toMatchObject({ done: 2, wanted: 2 });
		expect(p1.strokes.length).toBe(0);
	});

	it("stops at a step the document guard refuses (the step leaves the history, the document is as it was)", () => {
		const doc = sampleDocument(0);
		const page = doc.pages[0]!;
		const refused: Array<{ message: string; step?: string }> = [];
		const history = new History(() => doc, 500, (d) => (d.pages[0]!.width === 999 ? "bad width" : null), (message, step) => void refused.push({ message, ...(step ? { step } : {}) }));
		const first = new AddStroke(page.id, line(0, 0, 10, 0), 0);
		const bad: Command = {
			label: "bad",
			apply: (d) => void (d.pages[0]!.width = 222),
			revert: (d) => void (d.pages[0]!.width = 999),
		};
		const last = new AddStroke(page.id, line(0, 10, 10, 10), 1);
		for (const c of [first, bad, last]) expect(history.execute(c)).toBe(true);
		const r = jumpHistory(history, { kind: "start" });
		expect(r).toMatchObject({ direction: "undo", wanted: 3, done: 1 });
		expect(refused).toEqual([{ message: "bad width", step: "undo" }]);
		expect(page.width).toBe(222);
		expect(page.strokes.length).toBe(1);
		expect(history.depth().undo).toBe(1);
	});

	it("stops at a redo the guard refuses", () => {
		const doc = sampleDocument(0);
		const page = doc.pages[0]!;
		const refused: Array<string | undefined> = [];
		const history = new History(() => doc, 500, (d) => (d.pages[0]!.width === 999 ? "bad width" : null), (_m, step) => void refused.push(step));
		let applied = 0;
		const bad: Command = {
			label: "bad redo",
			apply: (d) => void (d.pages[0]!.width = applied++ > 0 ? 999 : 222),
			revert: (d) => void (d.pages[0]!.width = 200),
		};
		const a = new AddStroke(page.id, line(0, 0, 10, 0), 0);
		const c = new AddStroke(page.id, line(0, 10, 10, 10), 1);
		for (const x of [a, bad, c]) history.execute(x);
		jumpHistory(history, { kind: "start" });
		const r = jumpHistory(history, { kind: "step", cmd: c });
		expect(r).toMatchObject({ direction: "redo", wanted: 3, done: 1 });
		expect(refused).toEqual(["redo"]);
		expect(page.strokes.length).toBe(1);
		expect(page.width).toBe(200);
	});

	it("does nothing when the history is read-only", () => {
		const doc = sampleDocument(0);
		const page = doc.pages[0]!;
		let readOnly = false;
		const history = new History(() => doc, 500, null, null, () => readOnly);
		const made = [new AddStroke(page.id, line(0, 0, 10, 0), 0), new AddStroke(page.id, line(0, 10, 10, 10), 1)];
		for (const c of made) history.execute(c);
		readOnly = true;
		expect(jumpHistory(history, { kind: "start" })).toMatchObject({ wanted: 2, done: 0 });
		expect(page.strokes.length).toBe(2);
	});

	describe("a long jump in slices (review fix)", () => {
		/** A history with a guard that counts its calls, and `n` strokes; `badAt` makes the undo of that step leave a document the guard refuses. */
		function counted(n: number, badAt = -1) {
			const doc = sampleDocument(0);
			const page = doc.pages[0]!;
			let calls = 0;
			const refused: Array<string | undefined> = [];
			const history = new History(() => doc, 500, (d) => (++calls, d.pages[0]!.width === 999 ? "bad width" : null), (_m, step) => void refused.push(step));
			for (let i = 0; i < n; i++) {
				history.execute(new AddStroke(page.id, line(0, i, 50, i), i));
				if (i === badAt) {
					history.execute({ label: "bad", apply: (d) => void (d.pages[0]!.width = 222), revert: (d) => void (d.pages[0]!.width = 999) });
				}
			}
			calls = 0;
			return { doc, page, history, refused, calls: () => calls };
		}

		it("takes the same steps as a jump in one go, and the guard runs after every step", async () => {
			const one = counted(40);
			const plain = counted(40);
			for (let i = 0; i < 40; i++) plain.history.undo();
			const sliced = counted(40);
			const whole = jumpHistory(one.history, { kind: "start" });
			const runner = new JumpRunner(sliced.history, { kind: "start" });
			let yields = 0;
			let clock = 0;
			// A clock that moves one tick per reading: each slice takes about three steps.
			const result = await finishJump(runner, { budgetMs: 3, now: () => clock++, yieldToUi: async () => void yields++ });
			expect(result).toEqual(whole);
			expect(yields).toBeGreaterThan(3);
			expect(sliced.page.strokes.length).toBe(0);
			expect(sliced.history.depth()).toEqual(one.history.depth());
			// Every step checks the document after it; the check before it is the one the step before already made.
			expect(sliced.calls()).toBeLessThan(plain.calls());
			expect(one.calls()).toBe(41);
			expect(sliced.calls()).toBeGreaterThanOrEqual(40);
		});

		it("stops at a refused step exactly where one go stops, whatever the slices", async () => {
			const one = counted(12, 5);
			const sliced = counted(12, 5);
			const whole = jumpHistory(one.history, { kind: "start" });
			const runner = new JumpRunner(sliced.history, { kind: "start" });
			const result = await finishJump(runner, { budgetMs: 0, yieldToUi: async () => undefined });
			expect(result).toEqual(whole);
			expect(result.done).toBeLessThan(result.wanted);
			expect(sliced.refused).toEqual(one.refused);
			expect(sliced.page.width).toBe(one.page.width);
			expect(sliced.page.strokes.length).toBe(one.page.strokes.length);
			expect(sliced.history.depth()).toEqual(one.history.depth());
		});

		it("keeps a document that already failed the guard before the step (the step is not blamed), also inside a run", () => {
			const doc = sampleDocument(0);
			const page = doc.pages[0]!;
			const refused: unknown[] = [];
			const history = new History(() => doc, 500, (d) => (d.pages[0]!.width === 999 ? "bad width" : null), (m) => void refused.push(m));
			const made = [new AddStroke(page.id, line(0, 0, 10, 0), 0), new AddStroke(page.id, line(0, 10, 10, 10), 1), new AddStroke(page.id, line(0, 20, 10, 20), 2)];
			for (const c of made) history.execute(c);
			page.width = 999; // a change outside the history
			expect(jumpHistory(history, { kind: "start" })).toMatchObject({ wanted: 3, done: 3 });
			expect(refused).toEqual([]);
			expect(page.strokes.length).toBe(0);
		});

		it("a run forgets what it knew when it ends, and stops when asked to", async () => {
			const t = counted(10);
			const runner = new JumpRunner(t.history, { kind: "start" });
			let slices = 0;
			const result = await finishJump(runner, { budgetMs: 0, yieldToUi: async () => void slices++, keepGoing: () => slices < 3 });
			expect(result.done).toBeGreaterThan(0);
			expect(result.done).toBeLessThan(10);
			expect(t.page.strokes.length).toBe(10 - result.done);
			const before = t.calls();
			t.history.undo(); // an ordinary undo afterwards asks the guard before and after, as always
			expect(t.calls() - before).toBe(2);
		});

		it("a jump with nowhere to go is over at once, and a missing step is reported", () => {
			const { history, made } = setup(3);
			const here = new JumpRunner(history, { kind: "step", cmd: made[2]! });
			expect(here.advance(10)).toBe(true);
			expect(here.result()).toEqual({ direction: null, wanted: 0, done: 0, gone: false });
			const gone = new JumpRunner(history, { kind: "step", cmd: new AddStroke("p", line(0, 0, 1, 1), 0) });
			expect(gone.finished).toBe(true);
			expect(gone.result().gone).toBe(true);
		});
	});
});

describe("the rows of the panel", () => {
	function listed() {
		const doc = createDocument(new Date("2026-11-08T10:00:00.000Z"));
		doc.pages.push(createPage(), createPage());
		const [p1, p2, p3] = doc.pages as [NotebookDocument["pages"][number], NotebookDocument["pages"][number], NotebookDocument["pages"][number]];
		const history = new History(() => doc, 500, null, null, null, null, () => 10_000_000);
		const steps: Command[] = [
			new AddStroke(p1.id, line(0, 0, 10, 0), 0),
			new Batch("Transform selection", [new ReplaceStroke(p3.id, line(0, 0, 1, 1), [], 0), new ReplaceStroke(p3.id, line(0, 0, 2, 2), [], 0), new ReplaceStroke(p3.id, line(0, 0, 3, 3), [], 0), new ReplaceStroke(p3.id, line(0, 0, 4, 4), [], 0)]),
			new AddElement(p2.id, textBox("t1"), 0),
		];
		for (const c of steps) history.execute(c);
		return { doc, history, steps, p1, p2, p3 };
	}

	it("lists the undone steps first (furthest ahead on top), then the steps made with the current point marked, then the start", () => {
		const { doc, history, steps } = listed();
		history.undo();
		history.undo();
		const rows = historyRows(history.entries(), doc, 10_000_000 + 5 * 60_000);
		expect(rows.map((r) => [r.kind, r.side, r.current])).toEqual([
			["step", "redo", false], ["step", "redo", false], ["step", "undo", true], ["start", "undo", false],
		]);
		expect(rows.filter((r) => r.current)).toHaveLength(1);
		expect(rows[0]!.cmd).toBe(steps[2]);
		expect(rows[1]!.cmd).toBe(steps[1]);
		expect(rows[2]!.cmd).toBe(steps[0]);
	});

	it("marks the start as the current point when everything is undone, and shows nothing for an empty history", () => {
		const { doc, history } = listed();
		jumpHistory(history, { kind: "start" });
		const rows = historyRows(history.entries(), doc, 10_000_000);
		expect(rows[rows.length - 1]).toMatchObject({ kind: "start", current: true });
		expect(rows.filter((r) => r.current)).toHaveLength(1);
		expect(historyRows(new History(() => doc).entries(), doc, 0)).toEqual([]);
	});

	it("says what each step is, its page and when", () => {
		const { doc, history } = listed();
		const rows = historyRows(history.entries(), doc, 10_000_000 + 5 * 60_000);
		expect(rows[2]!.title).toBe("Stroke written");
		expect(rows[2]!.detail).toBe("p. 1 · 5 min ago");
		expect(rows[1]!.title).toBe("Selection moved or transformed");
		expect(rows[1]!.detail).toBe("4 items · p. 3 · 5 min ago");
		expect(rows[0]!.title).toBe("Added: text box");
		expect(rows[0]!.detail).toBe("p. 2 · 5 min ago");
		expect(rows[3]!.title).toBe("Start of the history");
	});

	it("page text: numbers, a count for many pages, nothing for a page that is gone", () => {
		const { doc, p1, p2, p3 } = listed();
		expect(pagesText(doc, [p3.id, p1.id])).toBe("p. 1, 3");
		expect(pagesText(doc, ["gone"])).toBe("");
		expect(pagesText(null, [p2.id])).toBe("");
		const many = createDocument(new Date());
		for (let i = 0; i < 5; i++) many.pages.push(createPage());
		expect(pagesText(many, many.pages.map((p) => p.id))).toBe("6 pages");
	});

	it("time text: just now, minutes, then the time of day", () => {
		expect(timeText(null, 0)).toBe("");
		expect(timeText(1000, 1000 + 10_000)).toBe("just now");
		expect(timeText(1000, 1000 + 7 * 60_000)).toBe("7 min ago");
		expect(timeText(1000, 1000 + 3 * 3_600_000)).toMatch(/\d/);
	});

	it("says the outcome of a jump", () => {
		expect(jumpNotice({ direction: "undo", wanted: 3, done: 3, gone: false })).toBe("Went back 3 steps.");
		expect(jumpNotice({ direction: "redo", wanted: 2, done: 2, gone: false })).toBe("Went forward 2 steps.");
		expect(jumpNotice({ direction: "undo", wanted: 3, done: 1, gone: false })).toBe("Stopped after 1 of 3 steps: the next step was refused.");
		expect(jumpNotice({ direction: "undo", wanted: 3, done: 1, gone: false, stopped: true })).toBe("The jump was interrupted because the notebook was closed or reloaded: 1 of 3 steps were taken.");
		expect(jumpNotice({ direction: null, wanted: 0, done: 0, gone: true })).toBe("That step is no longer in the history.");
		expect(jumpNotice({ direction: null, wanted: 0, done: 0, gone: false })).toBeNull();
	});
});

describe("registry", () => {
	it("has the action, its command, its help text and a context rule", async () => {
		const { actionById } = await import("../src/ui/actions");
		const { ACTION_HELP } = await import("../src/ui/help-text");
		const { contextBoost, HERE_MIN_BOOST } = await import("../src/ui/context-rank");
		const a = actionById("history-panel")!;
		expect(a).toBeTruthy();
		expect(a.command).toBe("command.historyPanel");
		expect(ACTION_HELP["history-panel"]).toBe("help.historyPanel");
		expect(itMessages["help.historyPanel"]).toBeTruthy();
		const base = { open: true, editable: true, presenting: false, sidePane: { open: false, available: false }, tool: "pen", selection: null, page: null, lecture: false } as never;
		expect(contextBoost(a, base)).toBe(0);
		expect(contextBoost(a, { ...(base as object), history: { undo: 3, redo: 0 } } as never)).toBe(12);
		expect(contextBoost(a, { ...(base as object), history: { undo: 3, redo: 2 } } as never)).toBeGreaterThanOrEqual(HERE_MIN_BOOST);
		expect(contextBoost(a, { ...(base as object), history: { undo: 3, redo: 2 }, presenting: true } as never)).toBe(0);
	});
});
