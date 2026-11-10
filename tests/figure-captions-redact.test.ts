// 0.29 (#248) review fix (F4): the redaction of a page measures a caption or a reference as the file will show it (with the figure numbers
// of the export), in the same scope as the writer, not as "Fig. ?".
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async () => {
	const base = (await import("./fake-vault")).obsidianMock();
	class Notice {
		constructor(_message: unknown) {}
		setMessage(): void {}
		hide(): void {}
	}
	return { ...base, Notice };
});

import { createPage } from "../src/model/document";
import { frozenFigureSource } from "../src/ink/figure-text";
import { redactBounds } from "../src/ink/redact";
import { withFigureScope } from "../src/ink/figure-text";
import { withRedaction } from "../src/view/export-redact";
import type { Page, TextElement } from "../src/model/types";

/** A narrow box: the long word before the number makes the shown text wrap onto more lines than "Fig. ?" does. */
const reference: TextElement = { id: "r1", type: "text", x: 20, y: 100, width: 30, text: "{{figref:f1}}", fontSize: 10, color: "#000" };
const pageOf = (): Page => {
	const p = createPage();
	p.id = "p1";
	p.elements = [reference];
	return p;
};
const longLabel = frozenFigureSource(new Map([["f1", 1234]]), "Figure number");

describe("redaction measures the text as the export will show it", () => {
	it("a scope changes the area a reference can cover", () => {
		const plain = redactBounds(reference);
		const scoped = withFigureScope(longLabel, () => redactBounds(reference));
		expect(scoped.maxY).toBeGreaterThan(plain.maxY);
	});

	it("withRedaction covers what the shown text reaches, using the figures of the export", () => {
		// A box below the two lines of "Fig. ?" and inside the extra lines of "Figure number 1234".
		const below = { x: 0, y: redactBounds(reference).maxY + 1, width: 200, height: 2 };
		const pages = [pageOf()];
		const kept = withRedaction(pages, { redact: { p1: [below] } }).pages[0]!;
		expect((kept.elements ?? []).map((e) => e.id)).toEqual(["r1"]); // measured as "Fig. ?": the box does not reach it
		const covered = withRedaction(pages, { redact: { p1: [below] }, figures: longLabel }).pages[0]!;
		expect(covered.elements ?? []).toEqual([]); // measured as "Figure number 1234": the box reaches its last line, so it is left out
	});
});
