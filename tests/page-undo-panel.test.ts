/**
 * 0.28 (#98): the history panel with per-page undo on marks the steps of the page in view and the steps that touch the whole notebook; the
 * list itself, the order and the current point stay those of the global history, and with the setting off nothing changes.
 */
import { describe, expect, it, vi } from "vitest";
import { createDocument, createPage } from "../src/model/document";
import { AddPage, AddStroke, Batch, History, ReplaceStroke } from "../src/model/history";
import { pageRules } from "../src/model/page-undo";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import { line } from "./helpers";

vi.mock("obsidian", () => ({ getLanguage: () => "en" }));

const { historyRows, scopeOfStep } = await import("../src/view/history-panel-logic");

function setup() {
	const doc = createDocument();
	doc.pages.push(createPage());
	const history = new History(() => doc);
	history.setPageRules(pageRules);
	return { doc, history, a: doc.pages[0]!.id, b: doc.pages[1]!.id };
}

describe("history panel rows with per-page undo", () => {
	it("marks the steps of the page in view, the steps of other pages and the global ones", () => {
		const { doc, history, a, b } = setup();
		const s = line(0, 0, 5, 5);
		history.execute(new AddStroke(a, s, 0));
		history.execute(new AddStroke(b, line(0, 10, 5, 15), 0));
		history.execute(new Batch("Move selection to page", [new ReplaceStroke(a, s, [], 0), new AddStroke(b, { ...s }, 1, false)]));
		history.execute(new AddPage(createPage(), 2));
		const rows = historyRows(history.entries(), doc, 0, { pageId: a });
		// newest first: add page (global), move (global), stroke on b (other), stroke on a (here), start
		expect(rows.map((r) => r.scope)).toEqual(["global", "global", "other", "here", undefined]);
		expect(rows[0]!.detail).toContain("whole notebook");
		expect(rows[3]!.detail).toContain("this page");
		expect(rows[3]!.detail).toContain("p. 1");
		expect(rows[1]!.detail).toContain("p. 1, 2");
	});

	it("is the same list, in the same order, with the current point marked, as without per-page undo", () => {
		const { doc, history, a, b } = setup();
		history.execute(new AddStroke(a, line(0, 0, 5, 5), 0));
		history.execute(new AddStroke(b, line(0, 10, 5, 15), 0));
		history.undoOnPage(a);
		const plain = historyRows(history.entries(), doc, 0);
		const marked = historyRows(history.entries(), doc, 0, { pageId: a });
		expect(marked.map((r) => [r.kind, r.side, r.current, r.cmd])).toEqual(plain.map((r) => [r.kind, r.side, r.current, r.cmd]));
		expect(plain.every((r) => r.scope === undefined)).toBe(true);
		// the undone step of page a is in the undone section, the step of b is where the document is now
		expect(plain.map((r) => `${r.side}${r.current ? "*" : ""}`)).toEqual(["redo", "undo*", "undo"]);
	});

	it("a page without a number (unknown) marks nothing as 'here'", () => {
		const { history, a } = setup();
		const cmd = new AddStroke(a, line(0, 0, 5, 5), 0);
		history.execute(cmd);
		expect(scopeOfStep(cmd, { pageId: null })).toBe("other");
		expect(scopeOfStep(cmd, { pageId: a })).toBe("here");
	});
});

describe("the Per-page undo setting", () => {
	it("is off by default and read leniently", () => {
		expect(DEFAULT_SETTINGS.pageUndo).toBe(false);
		expect(readSettings({ pageUndo: true }).pageUndo).toBe(true);
		expect(readSettings({ pageUndo: "yes" }).pageUndo).toBe(false);
		expect(readSettings({}).pageUndo).toBe(false);
	});
});
