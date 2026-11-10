import { describe, expect, it } from "vitest";
import { ACTIONS, baseContext, isEnabled, isRelevant } from "../src/ui/actions";
import { contextBoost, forThisPage, HERE_MIN_BOOST } from "../src/ui/context-rank";
import { ACTION_HELP } from "../src/ui/help-text";
import { placementsOf } from "../src/ui/layout";
import { LABELS } from "../src/model/history-describe";
import enSrc from "../src/i18n/en.ts?raw";
import itSrc from "../src/i18n/it.ts?raw";

const by = (id: string) => ACTIONS.find((a) => a.id === id)!;
const sel = (markers: { kind: "figure" | "region" | "set"; stale: boolean } | null, extra: Record<string, unknown> = {}) =>
	baseContext({ tool: "lasso", selection: { strokes: 0, elements: 1, images: 1, markers, ...extra } });
const ADD = "figure-marker-add";
const RENUMBER = "figure-markers-renumber";

describe("figure marker actions (#247)", () => {
	it("Add shows for a figure, a region or a marker; Renumber only for markers", () => {
		for (const kind of ["figure", "region", "set"] as const) expect(isRelevant(by(ADD), sel({ kind, stale: false })), kind).toBe(true);
		expect(isRelevant(by(RENUMBER), sel({ kind: "set", stale: false }))).toBe(true);
		expect(isRelevant(by(RENUMBER), sel({ kind: "figure", stale: false }))).toBe(false);
		expect(isRelevant(by(RENUMBER), sel({ kind: "region", stale: false }))).toBe(false);
		for (const id of [ADD, RENUMBER]) {
			expect(isRelevant(by(id), baseContext()), id).toBe(false);
			expect(isRelevant(by(id), sel(null)), id).toBe(false);
			// the selection bar keeps its rows: these live in the All actions sheet (and as commands)
			for (const w of [360, 800, 1280]) {
				const places = placementsOf(id, sel({ kind: "set", stale: true }), w);
				expect(places, `${id} at ${w}`).toContain("sheet");
				expect(places, `${id} at ${w}`).not.toContain("context");
			}
		}
	});

	it("are disabled on a locked page and on a read-only notebook", () => {
		const m = { kind: "set" as const, stale: true };
		const locked = baseContext({ tool: "lasso", selection: { strokes: 3, elements: 0, images: 0, markers: m }, page: { index: 0, count: 1, background: "none", infinite: false, bookmarked: false, locked: true } });
		const ro = baseContext({ editable: false, tool: "lasso", selection: { strokes: 3, elements: 0, images: 0, markers: m } });
		for (const id of [ADD, RENUMBER]) {
			expect(isEnabled(by(id), locked), id).toBe(false);
			expect(isEnabled(by(id), ro), id).toBe(false);
			expect(isEnabled(by(id), sel(m)), id).toBe(true);
		}
	});

	it("come first under 'For this page' for the selection they fit, and not otherwise", () => {
		const base = (id: string, c: ReturnType<typeof sel>) => contextBoost(by(id), c);
		const none = sel(null, { images: 0, elements: 0, strokes: 3 });
		// a selected picture: Add reaches "For this page"
		expect(base(ADD, sel({ kind: "figure", stale: false })) - base(ADD, none)).toBe(HERE_MIN_BOOST + 1);
		// a figure whose markers changed since: Renumber reaches it; one that is in order only leans forward
		expect(base(RENUMBER, sel({ kind: "set", stale: true }, { images: 0 })) - base(RENUMBER, none)).toBe(HERE_MIN_BOOST + 7);
		expect(base(RENUMBER, sel({ kind: "set", stale: false }, { images: 0 })) - base(RENUMBER, none)).toBe(2);
		// ink: Add only leans forward; a picture's selection does not make Renumber fit
		expect(base(ADD, sel({ kind: "region", stale: false }, { images: 0, elements: 0, strokes: 5 })) - base(ADD, none)).toBe(3);
		expect(base(RENUMBER, sel({ kind: "figure", stale: true }))).toBe(base(RENUMBER, none));
		const seen = new Set<string>();
		expect(forThisPage(ACTIONS, sel({ kind: "figure", stale: false }), {}, 0, seen, 200).map((a) => a.id)).toContain(ADD);
		expect(forThisPage(ACTIONS, sel({ kind: "set", stale: true }, { images: 0, elements: 2, strokes: 2 }), {}, 0, seen, 200).map((a) => a.id)).toContain(RENUMBER);
	});

	it("have help text, command names, and Italian strings", () => {
		for (const id of [ADD, RENUMBER]) {
			const key = ACTION_HELP[id];
			expect(key, id).toBeTruthy();
			expect(enSrc.includes(`"${key}":`), `${id} en`).toBe(true);
			expect(itSrc.includes(`"${key}":`), `${id} it`).toBe(true);
			expect(typeof by(id).command).toBe("string");
			for (const k of [by(id).label, by(id).command as string]) {
				expect(enSrc.includes(`"${k}":`), `${k} en`).toBe(true);
				expect(itSrc.includes(`"${k}":`), `${k} it`).toBe(true);
			}
		}
	});

	it("name their two History steps in the history panel", () => {
		expect(LABELS["Add marker"]).toBeTruthy();
		expect(LABELS["Renumber markers"]).toBeTruthy();
	});

	it("keep every notice and refusal in both languages", () => {
		for (const k of ["added", "addedLegend", "renumbered", "renumberedDropped", "same", "none", "full", "redacted", "locked", "states", "nowhere", "noTarget", "mixed", "gone"]) {
			expect(enSrc.includes(`"fm.${k}":`), `fm.${k} en`).toBe(true);
			expect(itSrc.includes(`"fm.${k}":`), `fm.${k} it`).toBe(true);
		}
	});
});
