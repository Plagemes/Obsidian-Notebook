import { describe, expect, it } from "vitest";
import { createDocument, createPage, createStroke } from "../src/model/document";
import { History } from "../src/model/history";
import { createPdfPages } from "../src/model/pages";
import { freezeStroke, serializeChecked } from "../src/model/serialize";
import type { Asset, NotebookDocument } from "../src/model/types";
import {
	countMatches, differenceHash, hammingHex, insertionIndex, makeFingerprint, matchRepublished, needsImageHash,
	normalizePageText, pdfSources, planRepublish, tokenize, type NewSource, type OldSource,
} from "../src/pdf/republish";

const OLD = "aaaaaaaaaaaaaaaaaaaaaaaa";
const NEW = "bbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER = "cccccccccccccccccccccccc";

const pdfAsset = (id: string, name = "slides.pdf"): Asset => ({ id, kind: "pdf", path: `N/_assets/${id}.pdf`, name, bytes: 1 });

/** Slide texts long enough to be compared by text. */
const slide = (title: string, body = "explained with several words on the slide") =>
	makeFingerprint([`Lecture 3, ${title}:`, body, "Course of Physics - University"]);

function oldSources(texts: string[], asset = OLD): OldSource[] {
	return texts.map((t, i) => ({ asset, page: i + 1, fp: slide(t) }));
}

function fresh(texts: string[]): NewSource[] {
	return texts.map((t, i) => ({ page: i + 1, fp: slide(t) }));
}

describe("fingerprints", () => {
	it("normalises text and words", () => {
		expect(normalizePageText(["  Hello\n", "World ", "ﬁne"])).toBe("hello world fine");
		expect(tokenize("Ciao, ciao! è 3 x2 a")).toEqual(["ciao", "x2"]);
		expect(needsImageHash("title")).toBe(true);
		expect(needsImageHash(normalizePageText(["a long enough line of slide text"]))).toBe(false);
	});

	it("differenceHash: 16 hex chars, stable, sensitive to the picture", () => {
		const w = 18;
		const h = 16;
		const img = (f: (x: number, y: number) => number) => {
			const data = new Uint8ClampedArray(w * h * 4);
			for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
				const v = f(x, y);
				data.set([v, v, v, 255], (y * w + x) * 4);
			}
			return data;
		};
		const gradient = img((x) => 255 - x * 14);
		const a = differenceHash(gradient, w, h);
		expect(a).toMatch(/^[0-9a-f]{16}$/);
		expect(differenceHash(gradient, w, h)).toBe(a);
		expect(a).toBe("ffffffffffffffff"); // every cell brighter than its right neighbour
		const flipped = differenceHash(img((x) => x * 14), w, h);
		expect(hammingHex(a, flipped)).toBe(64);
		expect(differenceHash(new Uint8ClampedArray(0), 0, 0)).toBe("0000000000000000");
		expect(hammingHex("ff", "fe")).toBe(1);
		expect(hammingHex("ff", "f")).toBe(Infinity);
	});
});

describe("matchRepublished", () => {
	it("(a) whole PDF with more pages: existing ones unchanged, only the extra ones are new", () => {
		const old = oldSources(["intro", "waves", "optics"]);
		const r = matchRepublished(old, fresh(["intro", "waves", "optics", "lenses", "summary"]), OLD);
		expect(r.matches.map((m) => m.status)).toEqual(["unchanged", "unchanged", "unchanged", "new", "new"]);
		expect(r.matches[1]!.source).toBe(old[1]);
		expect(countMatches(r)).toEqual({ added: 2, updated: 0, unchanged: 3, missing: 0 });
	});

	it("recognises slides by content even when the order changed", () => {
		const old = oldSources(["intro", "waves", "optics"]);
		const r = matchRepublished(old, fresh(["optics", "new one", "intro", "waves"]), OLD);
		expect(r.matches.map((m) => [m.status, m.source?.page])).toEqual([
			["unchanged", 3], ["new", undefined], ["unchanged", 1], ["unchanged", 2],
		]);
	});

	it("(b) a changed slide is 'updated', a removed one is reported missing", () => {
		const old = [
			{ asset: OLD, page: 1, fp: slide("intro") },
			{ asset: OLD, page: 2, fp: slide("waves", "interference and diffraction of light in thin films") },
			{ asset: OLD, page: 3, fp: slide("dropped slide", "nothing in common with anything else here") },
		];
		const next: NewSource[] = [
			{ page: 1, fp: slide("intro") },
			{ page: 2, fp: slide("waves", "interference and diffraction of light in thin films and soap bubbles") },
			{ page: 3, fp: slide("brand new", "completely different content about quantum tunnelling") },
		];
		const r = matchRepublished(old, next, OLD);
		expect(r.matches.map((m) => m.status)).toEqual(["unchanged", "updated", "new"]);
		expect(r.matches[1]!.source).toBe(old[1]);
		expect(r.matches[1]!.similarity).toBeGreaterThan(0.5);
		expect(r.missing).toEqual([old[2]]);
	});

	it("(c) only the new pages published: everything is new and goes after the anchor PDF", () => {
		const r = matchRepublished(oldSources(["intro", "waves"]), fresh(["lenses", "mirrors"]), OLD);
		expect(r.matches.map((m) => m.status)).toEqual(["new", "new"]);
		expect(r.family).toEqual([OLD]);
	});

	it("ignores headers and footers when judging similarity", () => {
		// Slides that share only the footer must not be taken for versions of each other.
		const old = oldSources(["alpha", "beta", "gamma", "delta"]).map((o, i) => ({
			...o, fp: makeFingerprint([`topic ${["alpha", "beta", "gamma", "delta"][i]} unique${i}`, "Course of Physics University Lecture three"]),
		}));
		const next = [{ page: 5, fp: makeFingerprint(["topic epsilon unique9", "Course of Physics University Lecture three"]) }];
		const r = matchRepublished(old, next, OLD);
		expect(r.matches[0]!.status).toBe("new");
	});

	it("does not take slides of unrelated PDFs as updated versions", () => {
		const old = [
			...oldSources(["intro", "waves"]),
			{ asset: OTHER, page: 1, fp: slide("waves", "explained with several words on the slide, chemistry") },
		];
		const r = matchRepublished(old, fresh(["intro", "waves", "waves 2"]), OLD);
		expect(r.matches.map((m) => m.status)).toEqual(["unchanged", "unchanged", "new"]);
		expect(r.family).toEqual([OLD]);
	});

	it("text-poor slides are compared by image hash", () => {
		const blankA = makeFingerprint(["Fig. 1"], "ff00ff00ff00ff00");
		const blankB = makeFingerprint(["Fig. 1"], "ff00ff00ff00ff01"); // 1 bit: same
		const changed = makeFingerprint(["Fig. 1"], "ff00ff00ff00f0f0"); // 4 bits: updated
		const other = makeFingerprint(["Fig. 2"], "0123456789abcdef");
		const old: OldSource[] = [{ asset: OLD, page: 1, fp: blankA }, { asset: OLD, page: 2, fp: makeFingerprint(["Fig. 1"], "00ff00ff00ff00ff") }];
		const r = matchRepublished(old, [{ page: 1, fp: blankB }, { page: 2, fp: other }], OLD);
		expect(r.matches.map((m) => m.status)).toEqual(["unchanged", "new"]);
		const r2 = matchRepublished([old[0]!], [{ page: 1, fp: changed }], OLD);
		expect(r2.matches[0]!.status).toBe("updated");
	});

	it("duplicate slides match one to one, nearest page first", () => {
		const old = oldSources(["questions", "body", "questions"]);
		const r = matchRepublished(old, fresh(["questions", "body", "questions", "questions"]), OLD);
		expect(r.matches.map((m) => [m.status, m.source?.page])).toEqual([
			["unchanged", 1], ["unchanged", 2], ["unchanged", 3], ["new", undefined],
		]);
	});

	it("without an anchor the family comes from the unchanged pages", () => {
		const old = [...oldSources(["intro"], OLD), ...oldSources(["x"], OTHER)];
		const r = matchRepublished(old, fresh(["intro", "more"]), null);
		expect(r.family).toEqual([OLD]);
	});
});

function notebook(): NotebookDocument {
	const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"));
	const old = pdfAsset(OLD);
	doc.assets = { [OLD]: old };
	const pages = createPdfPages(old, [{ width: 600, height: 400 }, { width: 600, height: 400 }, { width: 600, height: 400 }]);
	pages[1]!.strokes.push(freezeStroke(createStroke("#000000", 2, [[10, 10, 0.5]])));
	pages[1]!.margins = { left: 0, right: 100, bottom: 0 };
	pages[1]!.width = 700;
	pages[2]!.margins = { left: 20, right: 80, bottom: 0 };
	pages[2]!.width = 700;
	// A blank note page after the last slide.
	doc.pages = [doc.pages[0]!, ...pages, createPage()];
	return doc;
}

describe("planRepublish", () => {
	it("pdfSources lists each PDF page once", () => {
		const doc = notebook();
		doc.pages.push({ ...doc.pages[1]!, id: "dup", strokes: [] });
		expect(pdfSources(doc)).toEqual([{ asset: OLD, page: 1 }, { asset: OLD, page: 2 }, { asset: OLD, page: 3 }]);
	});

	it("inserts after the last page of the PDF and the note pages after it", () => {
		const doc = notebook();
		expect(insertionIndex(doc, [OLD])).toBe(5);
		expect(insertionIndex(doc, [OTHER])).toBe(doc.pages.length);
	});

	it("one undo step: new pages appended with the family's margins, accepted updates switched keeping the ink", () => {
		const doc = notebook();
		const history = new History(() => doc);
		const before = doc.pages.slice();
		const inked = doc.pages[2]!;
		const ink = inked.strokes[0]!;
		const result = matchRepublished(
			[{ asset: OLD, page: 1, fp: slide("one") }, { asset: OLD, page: 2, fp: slide("two", "the original body text of slide two here") }, { asset: OLD, page: 3, fp: slide("three") }],
			[
				{ page: 1, fp: slide("one") },
				{ page: 2, fp: slide("two", "the original body text of slide two here, corrected") },
				{ page: 3, fp: slide("three") },
				{ page: 4, fp: slide("four", "brand new content for the fourth slide only") },
			],
			OLD,
		);
		const sizes = [{ width: 600, height: 400 }, { width: 620, height: 400 }, { width: 600, height: 400 }, { width: 600, height: 400 }];
		const plan = planRepublish(doc, result, pdfAsset(NEW), sizes, new Set([2]));
		expect(plan.added).toBe(1);
		expect(plan.switched).toBe(1);
		expect(plan.insertAt).toBe(5);
		history.execute(plan.command!);

		expect(doc.assets![NEW]).toBeDefined();
		expect(doc.assets![OLD]).toBeDefined();
		const added = doc.pages[5]!;
		expect(added.background).toEqual({ kind: "pdf", asset: NEW, page: 4 });
		expect(added.margins).toEqual({ left: 20, right: 80, bottom: 0 });
		expect(added.width).toBe(700);
		expect(inked.background).toEqual({ kind: "pdf", asset: NEW, page: 2 });
		expect(inked.width).toBe(720);
		expect(inked.strokes[0]).toBe(ink);
		expect(doc.pages[1]!.background).toEqual({ kind: "pdf", asset: OLD, page: 1 });
		expect(serializeChecked(doc).ok).toBe(true);

		history.undo();
		expect(doc.pages).toEqual(before);
		expect(inked.background).toEqual({ kind: "pdf", asset: OLD, page: 2 });
		expect(inked.width).toBe(700);
		expect(doc.assets![NEW]).toBeUndefined();
	});

	it("keeping the old version of an updated slide changes nothing on it", () => {
		const doc = notebook();
		const result = matchRepublished(
			[{ asset: OLD, page: 1, fp: slide("one", "a body that will be edited a little bit") }],
			[{ page: 1, fp: slide("one", "a body that will be edited a little bit more") }],
			OLD,
		);
		expect(result.matches[0]!.status).toBe("updated");
		const plan = planRepublish(doc, result, pdfAsset(NEW), [{ width: 600, height: 400 }], new Set());
		expect(plan.command).toBeNull();
	});

	it("rejects a plan whose sizes do not cover the new pages", () => {
		const doc = notebook();
		const result = matchRepublished([], fresh(["a", "b"]), OLD);
		expect(() => planRepublish(doc, result, pdfAsset(NEW), [{ width: 1, height: 1 }], new Set())).toThrow(RangeError);
	});
});
