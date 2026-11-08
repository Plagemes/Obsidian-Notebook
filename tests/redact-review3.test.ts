// 0.26 privacy review, round 3 (#285): each fix has a SECRET marker test with its own positive control (without the box, or with the box
// elsewhere, the same output carries the marker). The store fixes (T5, T6, T9) are in redact-store.test.ts.
import { describe, expect, it, vi } from "vitest";
import { TFile, type App } from "obsidian";

vi.mock("obsidian", async () => (await import("./fake-vault")).obsidianMock());

import { charEm, elementKept, pessimisticMeasure, redactBounds, redactPages, withExcerptChains } from "../src/ink/redact";
import { countBoxes, type Redactions } from "../src/model/redact";
import { A4_HEIGHT, A4_WIDTH, PAPER_SPACING, RENDER_INK, type ExcerptElement, type Page, type PageElement, type Point, type Stroke } from "../src/model/types";
import { planWithRedaction, type AreaHost } from "../src/view/export-area";
import { RedactCommits } from "../src/view/redact-commits";
import { REDACT_KEY, loadRedactState, saveRedactState } from "../src/ui/redact-store";

function page(id: string, elements: PageElement[] = [], strokes: Stroke[] = []): Page {
	return { id, width: A4_WIDTH, height: A4_HEIGHT, paper: { kind: "ruled", spacing: PAPER_SPACING.ruled }, strokes, ...(elements.length ? { elements } : {}) };
}

function line(id: string, points: Array<[number, number]>): Stroke {
	return { id, tool: "pen", color: "#1e1e1e", width: 2, render: RENDER_INK, points: points.map(([x, y]): Point => [x, y, 0.5]) };
}

const holds = (p: unknown, marker: string): boolean => JSON.stringify(p ?? null).includes(marker);
const far = { x: 450, y: 760, width: 40, height: 40 };

// ------------------------------------------------------------------------------------------------------------------------------ T1, T4

describe("T1: an excerpt of a page of this notebook never shows a stale snapshot of what is now covered", () => {
	// The excerpt A (p5) was taken from p2 when the secret ink was at 100,100; the ink was then moved to 300,600 and boxed there. The box
	// does not touch the excerpt's source region, but the snapshot still shows the ink.
	const moved: PageElement = { id: "t", type: "text", x: 300, y: 600, width: 160, text: "SECRET-moved", fontSize: 14, color: "#000000" };
	const p2 = page("p2", [moved]);
	const a: ExcerptElement = { id: "A", type: "excerpt", x: 50, y: 50, width: 200, height: 100, asset: "snapSECRET", source: { notebook: "Demo", doc: "d", page: "p2", x: 100, y: 100, width: 50, height: 20 } };
	const p5 = page("p5", [a]);
	const boxed: Redactions = { p2: [{ x: 290, y: 590, width: 200, height: 40 }] };

	it("the export leaves the excerpt out (and the ink is covered where it is now); the control with no box keeps both", () => {
		const control = redactPages([p2, p5], {});
		expect(holds(control[0], "SECRET-moved")).toBe(true);
		expect(holds(control[1], "snapSECRET")).toBe(true);
		const out = redactPages([p2, p5], boxed);
		expect(holds(out[0], "SECRET-moved")).toBe(false);
		expect(holds(out[1], "snapSECRET")).toBe(false);
	});

	it("also when one page is written with the set made over the notebook, and in Figures › Copy", () => {
		const set = withExcerptChains([p2, p5], boxed);
		expect(holds(redactPages([p5], set)[0], "snapSECRET")).toBe(false);
		expect(elementKept(p5, "A", set)).toBe(false);
		// Control: the same with no box.
		const none = withExcerptChains([p2, p5], {});
		expect(holds(redactPages([p5], none)[0], "snapSECRET")).toBe(true);
		expect(elementKept(p5, "A", none)).toBe(true);
	});

	it("T4: a box within a pen's reach of the source region (not on it) drops the excerpt, as it would cut the ink", () => {
		const reach = { p2: [{ x: 100 + 50 + 6, y: 100, width: 20, height: 20 }] };
		expect(holds(redactPages([p2, p5], reach)[1], "snapSECRET")).toBe(false);
		expect(holds(redactPages([p2, p5], {})[1], "snapSECRET")).toBe(true);
	});
});

// ------------------------------------------------------------------------------------------------------------------------------ T2

describe("T2: a picture of a selection applies every box that touches the selected text measured at its widest", () => {
	function notebookFile(): TFile {
		const Made = TFile as unknown as new (path: string) => unknown;
		const made = new Made("Notebooks/Demo.notebook");
		if (!(made instanceof TFile)) throw new Error("test: could not build the notebook file");
		Object.defineProperty(made, "parent", { value: { path: "Notebooks" } });
		return made;
	}

	for (const [name, text] of [
		["CJK", `SECRET-sel ${"機密顧客名前".repeat(40)}`],
		["capitals", `SECRET-sel ${"WMWMW MWMWM ".repeat(36)}`],
	] as const) {
		it(`${name}: a box over the real last line, far below the estimated area, leaves the text out; the control keeps it`, () => {
			const el: PageElement = { id: "t", type: "text", x: 60, y: 80, width: 300, text, fontSize: 14, color: "#000000" };
			const ink = line("s", [[60, 60], [200, 64]]);
			const p = page("p1", [el], [ink]);
			const host = (redact?: Redactions): AreaHost => ({
				app: {} as App, file: notebookFile(), page: p, pageNumber: 1, selection: { strokes: [ink], elements: [el] }, media: null, exportOptions: redact ? { redact } : {}, render: {},
			});
			const plain = planWithRedaction(host(), "selection")!;
			const bottom = plain.rect.y + plain.rect.height;
			const real = redactBounds(el).maxY;
			const last = { x: 80, y: real - 14, width: 40, height: 10 };
			expect(last.y).toBeGreaterThan(bottom + 40); // past the estimated area and the 24 pt reach the boxes were chosen with before
			expect(holds(planWithRedaction(host({ p1: [far] }), "selection")?.page, "SECRET-sel")).toBe(true);
			expect(holds(planWithRedaction(host({ p1: [last] }), "selection")?.page, "SECRET-sel")).toBe(false);
		});
	}
});

// ------------------------------------------------------------------------------------------------------------------------------ T7

describe("T7: closing the Redact dialog without Done never replaces the stored boxes with a net-unchanged set", () => {
	function memory() {
		const data = new Map<string, unknown>();
		const app = {
			loadLocalStorage: (k: string) => data.get(k) ?? null,
			saveLocalStorage: (k: string, v: unknown) => { if (v === null) data.delete(k); else data.set(k, JSON.parse(JSON.stringify(v))); },
		};
		return { app, data };
	}
	/** What the notebook view hands the dialog as `commit`. */
	const commitTo = (app: ReturnType<typeof memory>["app"], id: string, log: Redactions[]) => (boxes: Redactions): void => {
		log.push(boxes);
		const now = loadRedactState(app, id);
		saveRedactState(app, id, { on: now.unreadable === true ? countBoxes(boxes) > 0 : now.on, boxes });
	};
	const secret = { x: 100, y: 100, width: 80, height: 30 };
	const drawn = { x: 300, y: 300, width: 40, height: 40 };

	it("unreadable boxes: draw, undo, Escape keeps the notebook refused (never 'no boxes'); Done sets what is shown", () => {
		const { app, data } = memory();
		data.set(REDACT_KEY, { "nb-a": { on: true, at: 1, boxes: "SECRET-torn" } });
		const log: Redactions[] = [];
		const c = new RedactCommits(commitTo(app, "nb-a", log), {}, true);
		c.change({ p1: [drawn] });
		c.change({});
		c.close({}, false);
		expect(log).toHaveLength(0);
		expect(loadRedactState(app, "nb-a").unreadable).toBe(true);
		// Control: Done with the same (empty) set is the reader's explicit "none".
		const done = new RedactCommits(commitTo(app, "nb-a", log), {}, true);
		done.change({ p1: [drawn] });
		done.close({ p1: [drawn] }, true);
		expect(loadRedactState(app, "nb-a")).toEqual({ on: true, boxes: { p1: [drawn] } });
	});

	it("readable boxes: draw, undo, Escape leaves the stored boxes as they were; a change closed with Escape is kept", () => {
		const { app } = memory();
		saveRedactState(app, "nb-a", { on: true, boxes: { p1: [secret] } }, 1);
		const log: Redactions[] = [];
		const c = new RedactCommits(commitTo(app, "nb-a", log), { p1: [secret] }, false);
		c.change({ p1: [secret, drawn] });
		c.change({ p1: [secret] });
		const before = log.length;
		c.close({ p1: [secret] }, false);
		expect(log).toHaveLength(before);
		expect(loadRedactState(app, "nb-a")).toEqual({ on: true, boxes: { p1: [secret] } });
		// Control: a real change is kept at once, and closing with Escape does not take it back.
		const k = new RedactCommits(commitTo(app, "nb-a", log), { p1: [secret] }, false);
		k.change({ p1: [secret, drawn] });
		k.close({ p1: [secret, drawn] }, false);
		expect(loadRedactState(app, "nb-a").boxes).toEqual({ p1: [secret, drawn] });
	});

	it("after a reset the boxes shown are kept at once and later changes too", () => {
		const log: Redactions[] = [];
		const c = new RedactCommits((b) => log.push(b), {}, true);
		c.change({ p1: [drawn] });
		expect(log).toHaveLength(0);
		c.reset({ p1: [drawn] });
		expect(log).toEqual([{ p1: [drawn] }]);
		c.change({ p1: [drawn, secret] });
		expect(log).toHaveLength(2);
	});
});

// ------------------------------------------------------------------------------------------------------------------------------ T8

describe("T8: the per-character bound covers the widest glyphs of the fonts the exports and the UI can use", () => {
	it("ASCII symbols and capitals, Latin-1, letterlike symbols, sub- and superscripts, technical signs, ligatures", () => {
		for (const ch of "#+<=>^~") expect(charEm(ch)).toBeGreaterThanOrEqual(0.838 * 1.05); // DejaVu Sans 0.838 em
		for (const ch of "@%mwWM") expect(charEm(ch)).toBeGreaterThanOrEqual(1.04 * 1.05); // DejaVu Sans Bold m 1.04 em, @ 1 em
		expect(charEm("¼")).toBeGreaterThanOrEqual(1.3);
		expect(charEm("Œ")).toBeGreaterThanOrEqual(1.07 * 1.1);
		expect(charEm("Æ")).toBeGreaterThanOrEqual(1.07 * 1.1);
		for (const ch of ["™", "₂", "⌘", "⭐", "ﬁ", "ℵ"]) {
			expect(charEm(ch)).toBeGreaterThanOrEqual(1.5);
			expect(charEm(ch)).toBeLessThanOrEqual(2); // a checked range, not the unknown 6 em
		}
	});

	it("a text box of 0.838 em symbols: a box over its real last line drops it; the control keeps it", () => {
		const text = `SECRET-sym ${"#~=+".repeat(30)}`;
		const el: PageElement = { id: "t", type: "text", x: 100, y: 100, width: 150, text, fontSize: 14, color: "#000000" };
		// What DejaVu Sans would lay out: every symbol 0.838 em, a letter at most 1 em.
		const dejavu = [...text].reduce((n, ch) => n + ("#~=+".includes(ch) ? 0.838 : 1), 0) * 14;
		expect(pessimisticMeasure(text, 14)).toBeGreaterThan(dejavu);
		const bounds = redactBounds(el);
		const lastLine = { x: 110, y: bounds.maxY - 12, width: 30, height: 8 };
		const p = page("p1", [el]);
		expect(holds(redactPages([p], { p1: [far] })[0], "SECRET-sym")).toBe(true);
		expect(holds(redactPages([p], { p1: [lastLine] })[0], "SECRET-sym")).toBe(false);
	});
});
