import { describe, expect, it } from "vitest";
import {
	cleanSignDateCustom, isSignDateMode, padStroke, planSignature, signatureClip, signDateText, SIGNATURE_WIDTH,
} from "../src/ink/signature";
import { readStamp, serializeStamp } from "../src/ink/stamps";
import { createDocument } from "../src/model/document";
import { History } from "../src/model/history";
import { checkContent } from "../src/model/serialize";

const when = new Date(2026, 10, 5, 9, 30);
const sig = () => signatureClip([
	padStroke("#111111", 2, [[10, 40, 0.5], [40, 10, 0.5], [80, 50, 0.5]]),
	padStroke("#111111", 2, [[20, 60, 0.5], [90, 62, 0.5]]),
])!;
const fresh = () => {
	const doc = createDocument(new Date("2026-11-05T10:00:00.000Z"));
	return { doc, page: doc.pages[0]! };
};

describe("sign date text", () => {
	it("formats ISO, custom and the language's own form", () => {
		expect(signDateText(when, "iso", "")).toBe("2026-11-05");
		expect(signDateText(when, "custom", "DD/MM/YYYY")).toBe("05/11/2026");
		expect(signDateText(when, "custom", "[Rome,] D MMM YYYY", "en")).toBe("Rome, 5 Nov 2026");
		expect(signDateText(when, "locale", "", "en")).toBe("November 5, 2026");
		expect(signDateText(when, "locale", "", "it")).toBe("5 novembre 2026");
	});
	it("falls back to ISO for an empty custom pattern and to English for a bad locale", () => {
		expect(signDateText(when, "custom", "   ")).toBe("2026-11-05");
		expect(signDateText(when, "locale", "", "not a locale!!")).toMatch(/2026/);
	});
	it("cleans a saved pattern and recognises modes", () => {
		expect(cleanSignDateCustom("  D/M  ")).toBe("D/M");
		expect(cleanSignDateCustom("")).toBe("DD/MM/YYYY");
		expect(cleanSignDateCustom(3)).toBe("DD/MM/YYYY");
		expect(isSignDateMode("iso")).toBe(true);
		expect(isSignDateMode("x")).toBe(false);
	});
});

describe("signature clip and placement", () => {
	it("makes nothing from an empty pad", () => {
		expect(signatureClip([])).toBeNull();
		expect(signatureClip([padStroke("#000", 2, [])])).toBeNull();
	});
	it("survives the stamp file round trip", () => {
		const saved = serializeStamp(sig());
		expect(saved.ok).toBe(true);
		if (saved.ok) expect(readStamp(saved.text).ok).toBe(true);
	});
	it("places the signature scaled, with fresh ids, in one group with its date, as one undo step", () => {
		const { doc, page } = fresh();
		const clip = sig();
		const plan = planSignature(clip, doc, page, [300, 400], { dateText: "2026-11-05", fontSize: 14, color: "#000000", newGroup: () => "g-new" })!;
		expect(plan.strokes).toHaveLength(2);
		expect(plan.elements).toHaveLength(1);
		expect(plan.group).toBe("g-new");
		expect([...plan.strokes, ...plan.elements].every((i) => i.group === "g-new")).toBe(true);
		const ids = new Set([...plan.strokes, ...plan.elements].map((i) => i.id));
		expect(ids.size).toBe(3);
		for (const s of clip.strokes) expect(ids.has(s.id)).toBe(false);
		const xs = plan.strokes.flatMap((s) => s.points.map((p) => p[0]));
		expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(SIGNATURE_WIDTH, -1);
		const sigBottom = Math.max(...plan.strokes.flatMap((s) => s.points.map((p) => p[1])));
		expect(plan.elements[0]!.y).toBeGreaterThan(sigBottom);

		const history = new History(() => doc);
		history.execute(plan.command);
		expect(page.strokes).toHaveLength(2);
		expect(page.elements).toHaveLength(1);
		expect(checkContent(doc)).toBeNull();
		history.undo();
		expect(page.strokes).toHaveLength(0);
		expect(page.elements ?? []).toHaveLength(0);
		history.redo();
		expect(page.strokes).toHaveLength(2);
	});
	it("gives every placement its own group and keeps a lone item ungrouped", () => {
		const { doc, page } = fresh();
		const a = planSignature(sig(), doc, page, [300, 400], { dateText: "x", fontSize: 14, color: "#000" })!;
		const b = planSignature(sig(), doc, page, [300, 400], { dateText: "x", fontSize: 14, color: "#000" })!;
		expect(a.group).not.toBe(b.group);
		const oneStroke = signatureClip([padStroke("#111111", 2, [[0, 0, 0.5], [50, 20, 0.5]])])!;
		const lone = planSignature(oneStroke, doc, page, [300, 400], { fontSize: 14, color: "#000" })!;
		expect(lone.group).toBeNull();
		expect(lone.strokes.every((s) => s.group === undefined)).toBe(true);
		const dateOnly = planSignature(null, doc, page, [300, 400], { dateText: "2026-11-05", fontSize: 14, color: "#000" })!;
		expect(dateOnly.strokes).toHaveLength(0);
		expect(dateOnly.elements[0]!.group).toBeUndefined();
		expect(planSignature(null, doc, page, [1, 1], { fontSize: 14, color: "#000" })).toBeNull();
	});
	it("a locked page refuses the step", () => {
		const { doc, page } = fresh();
		page.locked = true;
		const plan = planSignature(sig(), doc, page, [300, 400], { dateText: "x", fontSize: 14, color: "#000" })!;
		const history = new History(() => doc);
		history.execute(plan.command);
		expect(page.strokes).toHaveLength(0);
	});
	it("stays inside the page near an edge", () => {
		const { doc, page } = fresh();
		const plan = planSignature(sig(), doc, page, [page.width - 2, page.height - 2], { dateText: "2026-11-05", fontSize: 14, color: "#000" })!;
		for (const s of plan.strokes) for (const p of s.points) { expect(p[0]).toBeLessThanOrEqual(page.width); expect(p[1]).toBeLessThanOrEqual(page.height); }
		expect(plan.elements[0]!.y).toBeLessThan(page.height);
	});
});
