/**
 * 0.17 review fixes, round 2 (H1-H5): what a paste or duplicate of a collapsed sticky note hands back as the selection, the
 * pen-gesture and cross-page moves of such a note, task text that is a link, the extract-with-move order, the PDF copy read-back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
	return new Proxy(real, { get: (target, key) => (key === "then" ? undefined : key in target ? target[key as string] : Stub), has: (_t, key) => key !== "then" });
});
vi.mock("../src/library/library-modals", () => ({ PromptModal: class {} }));
vi.mock("../src/view/toolbar", () => ({ PEN_COLORS: ["#111111"], PEN_WIDTHS: [1], HIGHLIGHTER_COLORS: ["#ffee00"], HIGHLIGHTER_WIDTHS: [10] }));

import { createDocument, createPage, createStroke } from "../src/model/document";
import { History, type Command } from "../src/model/history";
import { freezeElement, freezeStroke } from "../src/model/serialize";
import { hiddenStickyInk } from "../src/model/sticky";
import type { NotebookDocument, Page, StickyElement, Stroke } from "../src/model/types";
import { internalClip } from "../src/view/clipboard";
import { SelectionActions, type SelectionHost, type SelectionState } from "../src/view/selection-actions";

const stamp = "2026-11-05T10:00:00.000Z";

function stroke(id: string, x: number, y: number, color = "#111111"): Stroke {
	return freezeStroke({ ...createStroke(color, 2, [[x, y, 0.5], [x + 20, y, 0.5], [x + 20, y + 10, 0.5]]), id });
}

function note(id: string, over: Partial<StickyElement> = {}): StickyElement {
	return freezeElement({ id, type: "sticky", x: 100, y: 100, width: 150, height: 150, color: "#F59E0B", fontSize: 14, ...over });
}

/** Page p1: collapsed note n1 hiding s1 and s2, plus ink off the note (s3). */
function collapsedDoc(): NotebookDocument {
	const doc = createDocument(new Date(stamp), { width: 400, height: 600 });
	doc.id = "doc";
	const page = doc.pages[0]!;
	page.id = "p1";
	page.elements = [note("n1", { collapsed: true, ink: ["s1", "s2"] })];
	page.strokes.push(stroke("s1", 110, 178), stroke("s2", 115, 188), stroke("s3", 300, 400));
	return doc;
}

function liveHidden(page: Page): string[] {
	const ids = new Set(page.strokes.map((s) => s.id));
	return [...(hiddenStickyInk(page.elements) ?? [])].filter((id) => ids.has(id));
}

class El {
	dataset: Record<string, string> = {};
	createDiv(): El {
		return new El();
	}
	empty(): void {}
	remove(): void {}
	addClass(): void {}
	toggleClass(): void {}
	addEventListener(): void {}
}

interface Rig {
	history: History;
	actions: SelectionActions;
	current: () => SelectionState | null;
}

/** Selection actions over `doc`; `select` really replaces the selection, so a later restyle acts on what was handed back. */
function rig(doc: NotebookDocument, first: SelectionState | null): Rig {
	const history = new History(() => doc);
	let sel = first;
	const host: Partial<SelectionHost> = {
		doc: () => doc,
		media: () => ({ addPending: () => undefined, removePending: () => undefined }) as never,
		editable: () => true,
		selection: () => sel,
		boxes: () => doc.pages.map((_, i) => ({ x: 0, y: i * 700, width: 400, height: 600 })),
		execute: (cmd: Command) => history.execute(cmd),
		select: (pageIndex, strokes, elements, others) => void (sel = { pageIndex, strokes, elements, ...(others?.length ? { others } : {}) }),
		stillHere: () => true,
		folder: () => "",
		pasteTarget: () => ({ pageIndex: 0, page: doc.pages[0]!, x: 200, y: 300 }),
	};
	const actions = new SelectionActions(new El() as unknown as HTMLElement, host as SelectionHost);
	return { history, actions, current: () => sel };
}

const restyle = (r: Rig, color: string): void =>
	(r.actions as unknown as { restyle(req: { group: "ink"; color: string }): void }).restyle({ group: "ink", color });

// --- H1: the selection handed back holds no hidden ink ---

describe("H1: paste and duplicate of a collapsed note select the note, not its hidden ink", () => {
	beforeEach(() => internalClip.clear());

	const colours = (page: Page): string[] => page.strokes.map((s) => s.color);

	it("paste: the new note's ink is in the document but not in the selection; restyle leaves it alone", async () => {
		const doc = collapsedDoc();
		const r = rig(doc, { pageIndex: 0, strokes: [], elements: [doc.pages[0]!.elements![0]!] });
		expect(r.actions.copySync()).not.toBeNull();
		await (r.actions as unknown as { pasteInternal(): Promise<void> }).pasteInternal();
		const page = doc.pages[0]!;
		expect(page.elements).toHaveLength(2);
		expect(page.strokes).toHaveLength(5);
		expect(liveHidden(page)).toHaveLength(4);
		const sel = r.current()!;
		expect(sel.elements).toHaveLength(1);
		expect(sel.strokes).toEqual([]);
		restyle(r, "#ff0000");
		expect(colours(page).every((c) => c === "#111111")).toBe(true);
	});

	it("paste of a note together with visible ink selects the visible ink only", async () => {
		const doc = collapsedDoc();
		const s3 = doc.pages[0]!.strokes[2]!;
		const r = rig(doc, { pageIndex: 0, strokes: [s3], elements: [doc.pages[0]!.elements![0]!] });
		r.actions.copySync();
		await (r.actions as unknown as { pasteInternal(): Promise<void> }).pasteInternal();
		const sel = r.current()!;
		expect(sel.strokes).toHaveLength(1);
		expect(sel.strokes[0]).not.toBe(s3);
		restyle(r, "#ff0000");
		const page = doc.pages[0]!;
		// Only the pasted visible stroke changed colour: the two hidden ones of the copy and of the original are untouched.
		expect(colours(page).filter((c) => c === "#ff0000")).toHaveLength(1);
	});

	it("duplicate: same, the selection is the new note", () => {
		const doc = collapsedDoc();
		const r = rig(doc, { pageIndex: 0, strokes: [], elements: [doc.pages[0]!.elements![0]!] });
		r.actions.duplicate();
		const page = doc.pages[0]!;
		expect(page.strokes).toHaveLength(5);
		const sel = r.current()!;
		expect(sel.strokes).toEqual([]);
		expect(sel.elements).toHaveLength(1);
		expect(sel.elements[0]).toBe(page.elements![1]);
		restyle(r, "#ff0000");
		expect(colours(page).every((c) => c === "#111111")).toBe(true);
	});

	it("duplicate across pages: neither part of the selection holds hidden ink", () => {
		const doc = collapsedDoc();
		const p2 = createPage({ width: 400, height: 600 });
		p2.elements = [note("n2", { collapsed: true, ink: ["t1"] })];
		p2.strokes.push(stroke("t1", 120, 160));
		doc.pages.push(p2);
		const r = rig(doc, {
			pageIndex: 0, strokes: [], elements: [doc.pages[0]!.elements![0]!],
			others: [{ pageIndex: 1, strokes: [], elements: [p2.elements![0]!] }],
		});
		r.actions.duplicate();
		const sel = r.current()!;
		expect(doc.pages[0]!.strokes).toHaveLength(5);
		expect(doc.pages[1]!.strokes).toHaveLength(2);
		expect(sel.strokes).toEqual([]);
		expect(sel.others!.every((part) => part.strokes.length === 0 && part.elements.length === 1)).toBe(true);
	});
});
