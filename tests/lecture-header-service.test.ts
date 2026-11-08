import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	setIcon: () => undefined,
	getLanguage: () => "en",
	Notice: class {
		hide(): void {}
		setMessage(): void {}
	},
	Modal: class {},
	Setting: class {},
}));

import { estimateMeasure } from "../src/ink/text-layout";
import { createDocument, createPage } from "../src/model/document";
import { AddPage, DeletePage, History, type Command } from "../src/model/history";
import { checkContent } from "../src/model/serialize";
import { lectureClassOf } from "../src/timetable/lecture-mode";
import type { ClassEntry } from "../src/timetable/schedule";
import type { EditContext } from "../src/view/edit-context";
import { LectureHeaderService, type LectureHeaderHost } from "../src/view/lecture-header";

const mon = (h: number, m = 0) => new Date(2026, 9, 26, h, m, 0, 0);
const entry: ClassEntry = { id: "a", course: "Analysis 1", day: 1, start: "09:00", end: "11:00", weeks: "all", lecturer: "Prof. Rossi", room: "B2" };

// Review fix (D1): the automatic lecture header only follows pages created by a forward edit.
describe("lecture header service: undo and redo are never a new page", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("window", globalThis);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	function scene(mode: "auto" | "ask" = "auto") {
		const doc = createDocument(new Date(2026, 9, 26), { width: 595, height: 842 });
		const history = new History(() => doc, 500, checkContent);
		const ctx = { doc, measure: estimateMeasure, currentPage: () => 0, execute: (cmd: Command) => history.execute(cmd) } as unknown as EditContext;
		const cls = lectureClassOf(entry, mon(9, 30));
		const host: LectureHeaderHost = {
			parent: () => ({ createDiv: () => { throw new Error("no chip expected"); } }) as unknown as HTMLElement,
			path: () => "Notebooks/a.notebook",
			settings: () => ({ lectureHeader: mode, lectureHeaderLecturer: true, lectureHeaderRoom: true, lectureHeaderDate: true, lectureHeaderTime: true }),
			classFor: () => cls,
			editContext: () => ctx,
			busy: () => false,
			locale: () => "en",
			now: () => mon(9, 30),
		};
		const service = new LectureHeaderService(host);
		service.opened();
		service.pagesChanged();
		return { doc, history, service };
	}
	const settle = () => vi.advanceTimersByTime(10);

	it("adding a page writes one header; undo then redo adds nothing and keeps the redo stack", () => {
		const { doc, history, service } = scene();
		history.execute(new AddPage(createPage({ width: 595, height: 842 }), 1));
		service.pagesChanged();
		settle();
		const added = doc.pages[1]!;
		expect(added.elements).toHaveLength(2);
		// Undo the header, then the page: the redo stack holds both.
		history.undo();
		service.pagesChanged();
		history.undo();
		service.pagesChanged();
		settle();
		expect(doc.pages).toHaveLength(1);
		expect(history.canRedo()).toBe(true);
		history.redo();
		service.pagesChanged();
		settle();
		expect(doc.pages).toHaveLength(2);
		// The page came back through a redo: no extra step, the second redo (the header itself) is still there.
		expect(doc.pages[1]!.elements ?? []).toHaveLength(0);
		expect(history.canRedo()).toBe(true);
		history.redo();
		service.pagesChanged();
		settle();
		expect(doc.pages[1]!.elements).toHaveLength(2);
		expect(history.canRedo()).toBe(false);
	});

	it("a deleted page that comes back through undo does not get a header, and the redo stack is intact", () => {
		const { doc, history, service } = scene();
		history.execute(new AddPage(createPage({ width: 595, height: 842 }), 1));
		service.pagesChanged();
		settle();
		const victim = doc.pages[1]!;
		history.execute(new DeletePage(victim, 1));
		service.pagesChanged();
		settle();
		// Work elsewhere (a new page and its header), then undo three times: the deleted page returns.
		history.execute(new AddPage(createPage({ width: 595, height: 842 }), 1));
		service.pagesChanged();
		settle();
		const steps = history.canRedo(); // forward edit emptied the redo stack
		expect(steps).toBe(false);
		history.undo();
		service.pagesChanged();
		history.undo();
		service.pagesChanged();
		history.undo();
		service.pagesChanged();
		settle();
		expect(doc.pages).toContain(victim);
		expect(history.canRedo()).toBe(true);
	});

	it("a brand new page after an undo is still new", () => {
		const { doc, history, service } = scene();
		history.execute(new AddPage(createPage({ width: 595, height: 842 }), 1));
		service.pagesChanged();
		settle();
		history.undo();
		service.pagesChanged();
		history.undo();
		service.pagesChanged();
		history.execute(new AddPage(createPage({ width: 595, height: 842 }), 1));
		service.pagesChanged();
		settle();
		expect(doc.pages[1]!.elements).toHaveLength(2);
	});
});
