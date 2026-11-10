// Coloured sections (0.30, #52): the pure view helpers (context for the action registry, the next colour, next/previous section, spans).
import { describe, expect, it } from "vitest";
import { createDocument } from "../src/model/document";
import { resolveSections, sectionsOf } from "../src/model/sections";
import type { NotebookDocument, Section } from "../src/model/types";
import { ACTIONS, baseContext, isEnabled, isRelevant } from "../src/ui/actions";
import { contextBoost, HERE_MIN_BOOST } from "../src/ui/context-rank";
import { ACTION_HELP } from "../src/ui/help-text";
import { SUBJECT_COLORS } from "../src/ui/palette";
import { nextSectionColor, sectionsContext, sectionSpan, stepTarget } from "../src/view/sections-logic";

const section = (id: string, page: string, color = "#2f80f7"): Section => ({ id, title: `Section ${id}`, color, page });

/** Seven pages p1..p7; A starts at p2 (p2, p3), B at p4 (p4, p5), C at p6 (p6, p7). p1 is in no section. */
function doc(): NotebookDocument {
	const d = createDocument(new Date("2026-11-10T10:00:00.000Z"));
	const first = d.pages[0]!;
	first.id = "p1";
	for (let i = 2; i <= 7; i++) d.pages.push({ ...first, id: `p${i}`, strokes: [] });
	d.sections = [section("c", "p6"), section("a", "p2"), section("b", "p4")];
	return d;
}

describe("sectionsContext", () => {
	it("is empty without a document or without sections", () => {
		expect(sectionsContext(null, 0)).toEqual({ count: 0, here: false, starts: false });
		const d = doc();
		delete d.sections;
		expect(sectionsContext(d, 3)).toEqual({ count: 0, here: false, starts: false });
	});

	it("says whether the page is in a section and whether it starts one", () => {
		const d = doc();
		expect(sectionsContext(d, 0)).toEqual({ count: 3, here: false, starts: false });
		expect(sectionsContext(d, 1)).toEqual({ count: 3, here: true, starts: true });
		expect(sectionsContext(d, 2)).toEqual({ count: 3, here: true, starts: false });
		expect(sectionsContext(d, 6)).toEqual({ count: 3, here: true, starts: false });
	});

	it("does not count a dormant section (its page is gone)", () => {
		const d = doc();
		d.sections = [...d.sections!, section("x", "gone")];
		expect(sectionsContext(d, 0).count).toBe(3);
	});
});

describe("nextSectionColor", () => {
	it("takes the first palette colour no section uses, in lower case", () => {
		expect(nextSectionColor([])).toBe(SUBJECT_COLORS[0]!.base.toLowerCase());
		const used = [section("a", "p1", SUBJECT_COLORS[0]!.base), section("b", "p2", SUBJECT_COLORS[1]!.base.toLowerCase())];
		expect(nextSectionColor(used)).toBe(SUBJECT_COLORS[2]!.base.toLowerCase());
	});

	it("cycles through the palette once every colour is used", () => {
		const all = SUBJECT_COLORS.map((c, i) => section(`s${i}`, `p${i}`, c.base));
		expect(nextSectionColor(all)).toBe(SUBJECT_COLORS[all.length % SUBJECT_COLORS.length]!.base.toLowerCase());
	});
});

describe("stepTarget", () => {
	const all = () => { const d = doc(); return resolveSections(d.pages, sectionsOf(d)); };
	const id = (r: ReturnType<typeof stepTarget>) => r?.section.id ?? null;

	it("goes forward to the start of the next section", () => {
		expect(id(stepTarget(all(), 0, 1))).toBe("a");
		expect(id(stepTarget(all(), 1, 1))).toBe("b");
		expect(id(stepTarget(all(), 4, 1))).toBe("c");
		expect(stepTarget(all(), 5, 1)).toBeNull();
	});

	it("goes back to the start of the section in view, else to the section before", () => {
		expect(id(stepTarget(all(), 2, -1))).toBe("a");
		expect(id(stepTarget(all(), 3, -1))).toBe("a");
		expect(id(stepTarget(all(), 6, -1))).toBe("c");
		expect(id(stepTarget(all(), 5, -1))).toBe("b");
		expect(stepTarget(all(), 1, -1)).toBeNull();
		expect(stepTarget(all(), 0, -1)).toBeNull();
	});

	it("has nowhere to go without sections", () => {
		expect(stepTarget([], 3, 1)).toBeNull();
		expect(stepTarget([], 3, -1)).toBeNull();
	});
});

describe("sectionSpan", () => {
	it("gives 1-based first and last page numbers and the count", () => {
		const r = all3();
		expect(r.map(sectionSpan)).toEqual([{ first: 2, last: 3, count: 2 }, { first: 4, last: 5, count: 2 }, { first: 6, last: 7, count: 2 }]);
	});
});

describe("the sections actions (registry, help, context rank)", () => {
	const IDS = ["sections-list", "section-new", "section-rename", "section-recolour", "section-delete", "section-next", "section-previous"];
	const by = (id: string) => ACTIONS.find((a) => a.id === id)!;
	const divided = baseContext({ sections: { count: 3, here: true, starts: true } });
	const inside = baseContext({ sections: { count: 3, here: true, starts: false } });

	it("are registered with a long-press help each", () => {
		for (const id of IDS) {
			expect(by(id), id).toBeTruthy();
			expect(ACTION_HELP[id], id).toBeTruthy();
		}
	});

	it("offer a new section where none starts, and rename, recolour and delete inside one", () => {
		expect(isRelevant(by("section-new"), baseContext())).toBe(true);
		expect(isRelevant(by("section-new"), divided)).toBe(false);
		expect(isRelevant(by("section-new"), inside)).toBe(true);
		for (const id of ["section-rename", "section-recolour", "section-delete"]) {
			expect(isRelevant(by(id), baseContext()), id).toBe(false);
			expect(isRelevant(by(id), inside), id).toBe(true);
		}
		expect(isRelevant(by("section-next"), baseContext())).toBe(false);
		expect(isRelevant(by("section-next"), divided)).toBe(true);
	});

	it("edit only an editable notebook; the list and the jumps also work read-only", () => {
		const ro = baseContext({ editable: false, sections: { count: 3, here: true, starts: true } });
		expect(isEnabled(by("section-rename"), ro)).toBe(false);
		expect(isEnabled(by("section-delete"), ro)).toBe(false);
		expect(isEnabled(by("sections-list"), ro)).toBe(true);
		expect(isEnabled(by("section-next"), ro)).toBe(true);
	});

	it("rank the list and the jumps first in a notebook of three or more sections, never without sections", () => {
		expect(contextBoost(by("sections-list"), divided)).toBeGreaterThanOrEqual(HERE_MIN_BOOST);
		expect(contextBoost(by("section-next"), baseContext({ sections: { count: 2, here: true, starts: false } }))).toBeLessThan(HERE_MIN_BOOST);
		expect(contextBoost(by("sections-list"), baseContext())).toBeLessThan(contextBoost(by("sections-list"), divided));
		expect(contextBoost(by("sections-list"), baseContext())).toBeLessThan(HERE_MIN_BOOST);
		expect(contextBoost(by("section-rename"), divided)).toBeGreaterThan(contextBoost(by("section-rename"), inside));
		expect(contextBoost(by("section-new"), baseContext())).toBeLessThan(HERE_MIN_BOOST);
	});
});

function all3() {
	const d = doc();
	return resolveSections(d.pages, sectionsOf(d));
}
