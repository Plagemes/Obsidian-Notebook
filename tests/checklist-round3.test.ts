/**
 * Third review of the handwritten checklists (wave 0.19). H1: an upkeep change (`History.applyQuietly`: a link that follows a renamed
 * note, or is dropped because its line is gone) replaces a checkbox object without an undo step; the steps in the stacks are told
 * (`Command.remap`), so Undo and Redo of a move, a move to another page or a margin change never make a second copy of it, and keep
 * the link the upkeep left. A backstop takes back any undo or redo the writer would refuse. LOW: a followed link keeps the time it
 * was made; the "path too long" notice is said once per checkbox.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planCrossPageTransform } from "../src/ink/cross-page";
import { layoutPages, PAGE_GAP } from "../src/ink/layout";
import { applyPlacement, emptyPlacement } from "../src/ink/selection-transform";
import { translate } from "../src/ink/transform";
import { CHECKBOX_PATH_MAX } from "../src/model/checklist";
import { setCheckboxTask, toggleCheckbox } from "../src/model/checklist-commands";
import { GONE_CONFIRM_MS } from "../src/model/checklist-sync";
import { createDocument, createPage } from "../src/model/document";
import { AddStroke, Batch, History, quietSwap, ReplaceElement, SetPageMargins, type Command } from "../src/model/history";
import { checkContent, freezeElement, serializeChecked } from "../src/model/serialize";
import type { CheckboxElement, NotebookDocument, PageElement } from "../src/model/types";
import { recordRename } from "../src/storage/renamed-notes";
import { FakeVault } from "./fake-vault";
import { line } from "./helpers";

vi.mock("obsidian", async () => (await import("./fake-vault")).obsidianMock());

const { ChecklistTools } = await import("../src/view/checklist-tools");
const { Notice } = (await import("obsidian")) as unknown as { Notice: { shown: string[] } };

const NOTE = "Daily/2026-11-05.md";
const RENAMED = "Journal/today.md";
const BLOCK = "nb-abc123";
const LINE = `- [ ] read chapter 4 ^${BLOCK}`;
const T_LINK = 1_760_000_000_000;
const T_GONE = T_LINK + 120_000;

function linkedBox(over: Partial<CheckboxElement> = {}): CheckboxElement {
	return freezeElement({ id: "c1", type: "checkbox", x: 10, y: 10, size: 20, color: "#1f2430", task: { path: NOTE, block: BLOCK }, taskAt: T_LINK, ...over });
}

function docWith(box: CheckboxElement, pages = 1): NotebookDocument {
	const doc = createDocument(new Date("2026-11-05T10:00:00.000Z"), { width: 200, height: 300 });
	doc.id = "doc";
	doc.pages[0]!.id = "p1";
	doc.pages[0]!.elements = [box];
	for (let i = 1; i < pages; i++) {
		const p = createPage({ width: 200, height: 300 });
		p.id = `p${i + 1}`;
		doc.pages.push(p);
	}
	return doc;
}

/** Every copy of the checkbox in the document, with the page it is on. */
function copies(doc: NotebookDocument, id = "c1"): Array<{ pageId: string; el: CheckboxElement }> {
	return doc.pages.flatMap((p) => (p.elements ?? []).filter((e) => e.id === id).map((e) => ({ pageId: p.id, el: e as CheckboxElement })));
}

function only(doc: NotebookDocument): { pageId: string; el: CheckboxElement } {
	const all = copies(doc);
	expect(all).toHaveLength(1);
	expect(serializeChecked(doc).ok).toBe(true);
	return all[0]!;
}

const follow = (pageId: string): Command => setCheckboxTask(pageId, "c1", { path: RENAMED, block: BLOCK }, T_LINK + 1);
const unlink = (pageId: string): Command => setCheckboxTask(pageId, "c1", null, T_GONE);

function guarded(doc: NotebookDocument, refused: Array<{ message: string; step?: string }> = []): History {
	return new History(() => doc, 500, checkContent, (message, step) => refused.push({ message, ...(step ? { step } : {}) }));
}

/** The lasso move of the checkbox by (dx, 0), as the selection tool makes it. */
function lassoMove(doc: NotebookDocument, dx: number): Command {
	const page = doc.pages[0]!;
	const el = page.elements![0]!;
	const placement = emptyPlacement();
	placement.elements.set(el, translate(dx, 0));
	return applyPlacement(page, [], [el], placement)!.command;
}

// ------------------------------------------------------------------ H1

describe("H1: an upkeep change and the steps in the stacks", () => {
	it("lasso move → follow → unlink → undo → redo: one checkbox, saved, with the link the upkeep left", () => {
		const doc = docWith(linkedBox());
		const history = guarded(doc);
		expect(history.execute(lassoMove(doc, 30))).toBe(true);
		expect(only(doc).el.x).toBe(40);
		expect(history.applyQuietly(follow("p1"))).toBe(true);
		expect(only(doc).el.task?.path).toBe(RENAMED);
		expect(history.applyQuietly(unlink("p1"))).toBe(true);
		expect(history.undo()).not.toBeNull();
		let box = only(doc).el;
		expect(box.x).toBe(10);
		expect(box.task).toBeUndefined();
		expect(box.taskAt).toBe(T_GONE);
		expect(history.redo()).not.toBeNull();
		box = only(doc).el;
		expect(box.x).toBe(40);
		expect(box.task).toBeUndefined();
		expect(history.undo()).not.toBeNull();
		expect(only(doc).el.x).toBe(10);
	});

	it("after a follow alone, undoing the move keeps the new path", () => {
		const doc = docWith(linkedBox());
		const history = guarded(doc);
		history.execute(lassoMove(doc, 30));
		history.applyQuietly(follow("p1"));
		history.undo();
		expect(only(doc).el).toMatchObject({ x: 10, task: { path: RENAMED, block: BLOCK }, taskAt: T_LINK + 1 });
		history.redo();
		expect(only(doc).el).toMatchObject({ x: 40, task: { path: RENAMED, block: BLOCK } });
	});

	it("an upkeep change while the move is undone: redo keeps it as well", () => {
		const doc = docWith(linkedBox());
		const history = guarded(doc);
		history.execute(lassoMove(doc, 30));
		history.undo();
		expect(history.applyQuietly(follow("p1"))).toBe(true);
		expect(history.redo()).not.toBeNull();
		expect(only(doc).el).toMatchObject({ x: 40, task: { path: RENAMED } });
		history.undo();
		expect(only(doc).el).toMatchObject({ x: 10, task: { path: RENAMED } });
	});

	it("undoing past the step that made the link still takes it away, and redo brings back the followed one", () => {
		const doc = docWith(linkedBox({ task: undefined, taskAt: undefined }));
		const history = guarded(doc);
		expect(history.execute(setCheckboxTask("p1", "c1", { path: NOTE, block: BLOCK }, T_LINK))).toBe(true);
		history.execute(lassoMove(doc, 30));
		history.applyQuietly(follow("p1"));
		history.undo(); // the move
		history.undo(); // the link
		expect(only(doc).el.task).toBeUndefined();
		expect(only(doc).el.taskAt).toBeUndefined();
		history.redo(); // the link, as the upkeep left it
		expect(only(doc).el.task?.path).toBe(RENAMED);
		history.redo(); // and the move finds it
		expect(only(doc).el).toMatchObject({ x: 40, task: { path: RENAMED } });
	});

	it("a move to another page → follow → unlink → undo → redo: one checkbox on one page", () => {
		const doc = docWith(linkedBox({ y: 250 }), 2);
		const boxes = layoutPages(doc.pages).boxes;
		const el = doc.pages[0]!.elements![0]!;
		const plan = planCrossPageTransform({ boxes, pages: doc.pages, primary: 0, parts: [{ pageIndex: 0, strokes: [], elements: [el] }], matrix: translate(0, 300 + PAGE_GAP) })!;
		expect(plan.reparented).toBe(1);
		const history = guarded(doc);
		expect(history.execute(plan.command)).toBe(true);
		expect(only(doc).pageId).toBe("p2");
		expect(history.applyQuietly(follow("p2"))).toBe(true);
		expect(history.applyQuietly(unlink("p2"))).toBe(true);
		expect(history.undo()).not.toBeNull();
		let at = only(doc);
		expect(at.pageId).toBe("p1");
		expect(at.el.y).toBe(250);
		expect(at.el.task).toBeUndefined();
		expect(history.redo()).not.toBeNull();
		at = only(doc);
		expect(at.pageId).toBe("p2");
		expect(at.el.task).toBeUndefined();
	});

	it("a margin change → follow → undo → redo: the checkbox moves back and forth and keeps the new path", () => {
		const doc = docWith(linkedBox());
		const history = guarded(doc);
		expect(history.execute(new SetPageMargins("p1", undefined, { left: 25, right: 0, bottom: 0 }))).toBe(true);
		expect(only(doc).el.x).toBe(35);
		expect(history.applyQuietly(follow("p1"))).toBe(true);
		expect(history.undo()).not.toBeNull();
		expect(only(doc).el).toMatchObject({ x: 10, task: { path: RENAMED } });
		expect(history.redo()).not.toBeNull();
		expect(only(doc).el).toMatchObject({ x: 35, task: { path: RENAMED } });
		history.applyQuietly(unlink("p1"));
		history.undo();
		expect(only(doc).el.x).toBe(10);
		expect(only(doc).el.task).toBeUndefined();
	});

	it("an upkeep change that does more than replace elements is refused and changes nothing", () => {
		const doc = docWith(linkedBox());
		const history = guarded(doc);
		const sneaky = new Batch("upkeep", [follow("p1"), new AddStroke("p1", line(1, 1, 5, 5), 0)]);
		expect(history.applyQuietly(sneaky)).toBe(false);
		expect(doc.pages[0]!.strokes).toHaveLength(0);
		expect(only(doc).el.task?.path).toBe(NOTE);
	});

	it("the swap carries a changed field only into the copies that had what was replaced", () => {
		const old = linkedBox({ x: 40 });
		const next = freezeElement({ ...old, task: { path: RENAMED, block: BLOCK }, taskAt: T_LINK + 1 });
		const swap = quietSwap(new Map<PageElement, PageElement>([[old, next]]));
		expect(swap(old)).toBe(next);
		const earlier = linkedBox();
		expect(swap(earlier)).toMatchObject({ x: 10, task: { path: RENAMED }, taskAt: T_LINK + 1 });
		expect(swap(earlier)).toBe(swap(earlier));
		const unlinked = linkedBox({ task: undefined, taskAt: undefined });
		expect(swap(unlinked)).toBe(unlinked);
		const other = linkedBox({ id: "c2" });
		expect(swap(other)).toBe(other);
	});
});

// ------------------------------------------------------------------ the backstop

describe("H1 backstop: an undo or a redo the writer would refuse", () => {
	/** A step that, undone, leaves two copies of the checkbox (as a step that missed an upkeep change could). */
	class Duplicating implements Command {
		readonly label = "bad";
		apply(): void {}
		revert(d: NotebookDocument): void {
			d.pages[0]!.elements!.push(linkedBox({ x: 99 }));
		}
	}

	it("the guard sees a second copy of an element", () => {
		const doc = docWith(linkedBox());
		expect(checkContent(doc)).toBeNull();
		doc.pages[0]!.elements!.push(linkedBox({ x: 99 }));
		expect(checkContent(doc)).toMatch(/duplicate id/);
	});

	it("undo: the document stays as it was, the step leaves the history, and it is said", () => {
		const doc = docWith(linkedBox());
		const refused: Array<{ message: string; step?: string }> = [];
		const history = guarded(doc, refused);
		expect(history.execute(toggleCheckbox("p1", "c1", 5))).toBe(true);
		history.record(new Duplicating());
		const before = JSON.stringify(doc);
		const elements = doc.pages[0]!.elements;
		expect(history.undo()).toBeNull();
		expect(JSON.stringify(doc)).toBe(before);
		expect(doc.pages[0]!.elements).toBe(elements);
		expect(refused.map((r) => r.step)).toEqual(["undo"]);
		expect(refused[0]!.message).toMatch(/duplicate id/);
		expect(history.canRedo()).toBe(false);
		expect(serializeChecked(doc).ok).toBe(true);
		// the step under it is undone as usual
		expect(history.undo()).not.toBeNull();
		expect(only(doc).el.checked).toBeUndefined();
	});

	it("redo: the same", () => {
		const doc = docWith(linkedBox());
		const refused: Array<{ message: string; step?: string }> = [];
		const history = guarded(doc, refused);
		let applied = 0;
		const bad: Command = {
			label: "bad redo",
			apply: (d) => {
				if (applied++ > 0) d.pages[0]!.elements!.push(linkedBox({ x: 77 }));
				d.pages[0]!.width = 222;
			},
			revert: (d) => {
				d.pages[0]!.width = 200;
			},
		};
		expect(history.execute(bad)).toBe(true);
		expect(history.undo()).not.toBeNull();
		const before = JSON.stringify(doc);
		expect(history.redo()).toBeNull();
		expect(JSON.stringify(doc)).toBe(before);
		expect(refused.map((r) => r.step)).toEqual(["redo"]);
		expect(history.canUndo()).toBe(false);
		expect(history.canRedo()).toBe(false);
	});

	it("a step that is fine is undone and redone as before", () => {
		const doc = docWith(linkedBox());
		const refused: Array<{ message: string; step?: string }> = [];
		const history = guarded(doc, refused);
		const move = new ReplaceElement("p1", doc.pages[0]!.elements![0]!, linkedBox({ x: 50 }));
		expect(history.execute(move)).toBe(true);
		expect(history.undo()).toBe(move);
		expect(history.redo()).toBe(move);
		expect(only(doc).el.x).toBe(50);
		expect(refused).toEqual([]);
	});
});

// ------------------------------------------------------------------ LOW: the view

function viewRig(files: Record<string, string>, box: CheckboxElement = linkedBox()) {
	const fake = new FakeVault(files);
	const handlers: Array<(file: { path: string }, oldPath: string) => void> = [];
	const store = new Map<string, unknown>();
	const app = {
		vault: {
			...fake.vault,
			on: (name: string, fn: (file: { path: string }, oldPath: string) => void) => {
				if (name === "rename") handlers.push(fn);
				return {};
			},
		},
		loadLocalStorage: (k: string) => store.get(k) ?? null,
		saveLocalStorage: (k: string, v: unknown) => void store.set(k, v),
	};
	const doc = docWith(box);
	const history = guarded(doc);
	const host = {
		app,
		stage: () => ({ addEventListener: () => undefined, removeEventListener: () => undefined }),
		doc: () => doc,
		editable: () => true,
		execute: (cmd: never) => history.execute(cmd),
		maintain: (cmd: never) => history.applyQuietly(cmd),
		settings: () => ({}),
		register: () => undefined,
		refresh: () => undefined,
	};
	const tools = new ChecklistTools(host as never);
	const current = (): CheckboxElement => doc.pages[0]!.elements![0] as CheckboxElement;
	const tick = (): void => {
		history.execute(toggleCheckbox("p1", "c1", Date.now()));
		tools.docChanged();
	};
	const touch = (path: string, mtime: number): void => {
		(fake.vault.getFileByPath(path) as unknown as { stat: { mtime: number } }).stat.mtime = mtime;
	};
	return { fake, handlers, app, doc, history, tools, current, tick, touch };
}

describe("LOW: the view", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(T_LINK + 2000);
		vi.stubGlobal("window", { setTimeout, clearTimeout, navigator: {} });
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		Notice.shown.length = 0;
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("a followed link keeps the time it was made", () => {
		const r = viewRig({ [NOTE]: `${LINE}\n` });
		for (const h of r.handlers) h({ path: RENAMED }, NOTE);
		expect(r.current()).toMatchObject({ task: { path: RENAMED }, taskAt: T_LINK + 1 });
		r.tools.destroy();
	});

	it("a note renamed while the notebook was closed and edited since the link: a deleted line reads as gone", async () => {
		const r = viewRig({ [RENAMED]: "# 2026-11-05\n" });
		recordRename(r.app, NOTE, RENAMED, T_LINK + 1000);
		r.touch(RENAMED, T_LINK + 1500); // the line was deleted after the link, before the notebook opened
		vi.setSystemTime(T_LINK + 60_000);
		r.tools.reset();
		expect(r.current().task?.path).toBe(RENAMED);
		r.tick();
		await r.tools.reconcile();
		expect(r.current().task).toBeDefined();
		vi.setSystemTime(Date.now() + GONE_CONFIRM_MS + 1);
		await r.tools.reconcile();
		expect(r.current().task).toBeUndefined();
		expect(serializeChecked(r.doc).ok).toBe(true);
		r.tools.destroy();
	});

	it("the path-too-long notice is said once per checkbox, however often the rename comes back", () => {
		const r = viewRig({ [NOTE]: `${LINE}\n` });
		const long = `${"d/".repeat(CHECKBOX_PATH_MAX)}x.md`;
		for (let i = 0; i < 3; i++) for (const h of r.handlers) h({ path: long }, NOTE);
		expect(r.current().task?.path).toBe(NOTE);
		expect(Notice.shown).toHaveLength(1);
		r.tools.destroy();
	});
});
