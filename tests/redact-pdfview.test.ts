/**
 * 0.28 review (Q1, rotate/crop of a PDF page x redaction, FAIL CLOSED): a redaction box is in page coordinates, so a page turned or cropped after
 * its box was drawn must never be exported (the box is where the old page was) and a page that has boxes is never turned or cropped.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async () => {
	const base = (await import("./fake-vault")).obsidianMock();
	class Notice {
		static shown: string[] = [];
		constructor(message: unknown) {
			Notice.shown.push(String(message));
		}
		setMessage(): void {}
		hide(): void {}
	}
	return { ...base, Notice };
});

import { pageToSvg } from "../src/ink/export-svg";
import { createDocument } from "../src/model/document";
import { History } from "../src/model/history";
import { addBox, backgroundGeometry, cleanBox, normaliseRedactions, pageViewKey, staleRedactionPages, tagNewBoxes, type Redactions } from "../src/model/redact";
import { buildViewCommands } from "../src/model/pdf-view-ops";
import { planPageView, SetPdfView } from "../src/model/pdf-view-command";
import type { NotebookDocument, Page, TextElement } from "../src/model/types";
import { RedactionUnavailableError, redactBlockedMessage, withRedaction } from "../src/view/export-redact";

const ASSET = "abcdef0123456789abcdef01";
const SOURCE = { width: 600, height: 800 };
const BOX = { x: 100, y: 100, width: 220, height: 40 };

function pdfDoc(): { doc: NotebookDocument; page: Page } {
	const doc = createDocument(new Date("2026-11-10T10:00:00.000Z"));
	doc.assets = { [ASSET]: { id: ASSET, kind: "pdf", path: "N/_assets/x.pdf", name: "slides.pdf", bytes: 10 } };
	const page = doc.pages[0]!;
	page.id = "p1";
	page.width = SOURCE.width;
	page.height = SOURCE.height;
	page.background = { kind: "pdf", asset: ASSET, page: 1 };
	const secret: TextElement = { id: "t1", type: "text", x: 110, y: 105, width: 200, text: "SECRET number 123", fontSize: 14, color: "#000000" };
	page.elements = [Object.freeze(secret)];
	return { doc, page };
}

describe("a redaction box remembers the view of its page", () => {
	it("keeps a view key on a box, drops one that is not ours, and tells boxes apart by it", () => {
		expect(cleanBox({ ...BOX, view: "r90" })).toEqual({ ...BOX, view: "r90" });
		expect(cleanBox({ ...BOX, view: "<script>" })).toEqual(BOX);
		expect(cleanBox({ ...BOX, view: 5 })).toEqual(BOX);
		const set = normaliseRedactions({ p1: [BOX, { ...BOX, view: "r90" }, { ...BOX, view: "r90" }] });
		expect(set.p1).toEqual([BOX, { ...BOX, view: "r90" }]);
		expect(addBox({}, "p1", { ...BOX, view: "r90" })).toEqual({ p1: [{ ...BOX, view: "r90" }] });
	});

	it("tags the boxes drawn now with the turn and crop of their page and leaves the old ones as they were", () => {
		const { page } = pdfDoc();
		const upright: Redactions = { p1: [BOX] };
		// 0.29 (round-3 review Z2): a box drawn now also records the geometry of the page's background.
		expect(tagNewBoxes(upright, undefined, [page])).toEqual({ p1: [{ ...BOX, geo: backgroundGeometry(page) }] });
		const turned = { ...page, background: { kind: "pdf" as const, asset: ASSET, page: 1, rotate: 90 as const } };
		expect(pageViewKey(turned)).toBe("r90");
		const drawn: Redactions = { p1: [BOX, { x: 10, y: 10, width: 50, height: 20 }] };
		// BOX was there before (untagged: drawn on the upright page); the second box is new.
		const tagged = tagNewBoxes(drawn, { p1: [BOX] }, [turned]);
		expect(tagged.p1![0]).toEqual(BOX);
		expect(tagged.p1![1]).toEqual({ x: 10, y: 10, width: 50, height: 20, view: "r90", geo: backgroundGeometry(turned) });
	});

	it("finds the pages whose boxes were drawn on another view", () => {
		const { page } = pdfDoc();
		const turned = { ...page, background: { kind: "pdf" as const, asset: ASSET, page: 1, rotate: 90 as const } };
		expect(staleRedactionPages([page], { p1: [BOX] })).toEqual([]);
		expect(staleRedactionPages([turned], { p1: [BOX] })).toEqual(["p1"]);
		expect(staleRedactionPages([turned], { p1: [{ ...BOX, view: "r90" }] })).toEqual([]);
		expect(staleRedactionPages([page], { p1: [{ ...BOX, view: "r90" }] })).toEqual(["p1"]);
		expect(staleRedactionPages([turned], { other: [BOX] })).toEqual([]);
		expect(staleRedactionPages([turned], undefined)).toEqual([]);
	});
});

describe("an export never writes a page turned or cropped after its box was drawn", () => {
	it("covers the secret while the page is as it was when the box was drawn", () => {
		const { page } = pdfDoc();
		const { pages } = withRedaction([page], { redact: { p1: [BOX] } });
		expect(pageToSvg(pages[0]!)).not.toContain("SECRET");
	});

	it("refuses the turned page (the SECRET is not written, nothing is blacked out in the wrong place)", () => {
		const { doc, page } = pdfDoc();
		const history = new History(() => doc);
		expect(history.execute(new SetPdfView(page.id, planPageView(page, SOURCE, { rotate: 90 })!))).toBe(true);
		expect(() => withRedaction([page], { redact: { p1: [BOX] } })).toThrow(RedactionUnavailableError);
		try {
			withRedaction([page], { redact: { p1: [BOX] } });
		} catch (e) {
			expect((e as Error).message).toBe(redactBlockedMessage({ redactStale: true }));
			expect((e as Error).message).not.toBe(redactBlockedMessage({}));
		}
		// A box drawn on the turned page is tagged with its view and covers it; the old page's box is refused as before.
		const redrawn = tagNewBoxes({ p1: [{ x: 600, y: 100, width: 40, height: 220 }] }, undefined, [page]);
		expect(() => withRedaction([page], { redact: redrawn })).not.toThrow();
		// Undoing the turn makes the tagged box stale in its turn.
		history.undo();
		expect(() => withRedaction([page], { redact: redrawn })).toThrow(RedactionUnavailableError);
	});

	it("refuses a cropped page too", () => {
		const { doc, page } = pdfDoc();
		new History(() => doc).execute(new SetPdfView(page.id, planPageView(page, SOURCE, { crop: { x: 20, y: 20, width: 500, height: 700 } })!, "crop"));
		expect(() => withRedaction([page], { redact: { p1: [BOX] } })).toThrow(RedactionUnavailableError);
	});

	it("does not mind boxes that are switched off (nothing is applied) or pages without boxes", () => {
		const { doc, page } = pdfDoc();
		new History(() => doc).execute(new SetPdfView(page.id, planPageView(page, SOURCE, { rotate: 90 })!));
		expect(() => withRedaction([page], {})).not.toThrow();
		expect(() => withRedaction([page], { redact: { elsewhere: [BOX] } })).not.toThrow();
	});
});

describe("a page that has redaction boxes is never turned or cropped", () => {
	it("skips it and says why, for one page and for all the pages of the PDF", () => {
		const { doc, page } = pdfDoc();
		const second = { ...structuredClone(page), id: "p2", background: { kind: "pdf" as const, asset: ASSET, page: 2 }, elements: [] } as Page;
		doc.pages.push(second);
		const targets = [page, second].map((p) => ({ page: p, source: SOURCE }));
		const redacted = (id: string) => id === "p1";
		const build = buildViewCommands(targets, { turns: 1 }, { doc, redacted });
		expect(build.redacted).toBe(1);
		expect(build.commands.map((c) => c.pageId)).toEqual(["p2"]);
		const alone = buildViewCommands([targets[0]!], { turns: 1 }, { doc, redacted });
		expect(alone.commands).toHaveLength(0);
		expect(alone.redacted).toBe(1);
		// Without the redaction check nothing is skipped.
		expect(buildViewCommands(targets, { turns: 1 }, { doc }).commands).toHaveLength(2);
	});
});
