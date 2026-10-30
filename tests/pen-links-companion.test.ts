import { describe, expect, it } from "vitest";
import { inkLinkElement, parseLinks, pageLinks } from "../src/ink/link-text";
import { notebookUri } from "../src/integration/links";
import { companionContent, mergeRegion, newCompanionText, renderRegion } from "../src/model/companion-content";
import { createDocument } from "../src/model/document";
import { parse, serialize } from "../src/model/serialize";
import type { TextElement } from "../src/model/types";

const PATH = "Notebooks/Physics.notebook";
const ctx = { notebookPath: PATH, pageUri: (p: number) => notebookUri("", PATH, p) };

function text(id: string, value: string, y: number): TextElement {
	return { id, type: "text", x: 10, y, width: 300, text: value, fontSize: 14, color: "#000000" };
}

describe("links in the companion note (O8)", () => {
	it("copies the links of text boxes, aliases and headings included, so the graph and backlinks see them", () => {
		const doc = createDocument(new Date("2026-10-29T10:00:00Z"));
		doc.pages[0]!.elements = [text("a", "Read [[Mechanics]] and [[Energy#Work|work]].", 20), text("b", "see [[Projects/Alpha]]", 80)];
		const c = companionContent(doc, ctx);
		expect(c.text).toContain("Read [[Mechanics]] and [[Energy#Work|work]].");
		expect(c.text).toContain("see [[Projects/Alpha]]");
	});

	it("lists an ink link once, without the empty lines that stretch its box over the ink", () => {
		const doc = createDocument(new Date("2026-10-29T10:00:00Z"));
		const el = inkLinkElement("x", { minX: 100, minY: 200, maxX: 300, maxY: 320 }, "Thermodynamics", { width: 595, height: 842 }, "#000000");
		expect(el.text.split("\n").length).toBeGreaterThan(5);
		doc.pages[0]!.elements = [el];
		const body = companionContent(doc, ctx).text;
		expect(body.match(/\[\[Thermodynamics\]\]/g)).toHaveLength(1);
		expect(body).not.toMatch(/\[\[Thermodynamics\]\]\n\n/);
	});

	it("keeps the generated region's rules: a link cannot close the region or escape it", () => {
		const doc = createDocument(new Date("2026-10-29T10:00:00Z"));
		doc.pages[0]!.elements = [text("a", "[[A%%B]] and %% end", 20)];
		const region = renderRegion(companionContent(doc, ctx));
		const merged = mergeRegion(newCompanionText("notebook: x\n", region), region);
		expect(merged).not.toBeNull();
		expect(merged!.match(/%% notebook-companion:end %%/g)).toHaveLength(1);
		// Only the two markers contain an unescaped %%.
		const unescaped = region.split("\n").filter((l) => l.replace(/%\\%/g, "").includes("%%"));
		expect(unescaped).toHaveLength(2);
	});

	it("stays the same text on every device (no clock, no language)", () => {
		const doc = createDocument(new Date("2026-10-29T10:00:00Z"));
		doc.pages[0]!.elements = [text("a", "[[Note]]", 20)];
		expect(renderRegion(companionContent(doc, ctx))).toBe(renderRegion(companionContent(doc, ctx)));
	});
});

describe("ink links need no format change", () => {
	it("survive a save and a load as ordinary text elements", () => {
		const doc = createDocument(new Date("2026-10-29T10:00:00Z"));
		doc.pages[0]!.elements = [inkLinkElement("x", { minX: 100, minY: 200, maxX: 300, maxY: 320 }, "Folder/Note#Heading", { width: 595, height: 842 }, "#1e293b")];
		const back = parse(serialize(doc));
		expect(back.ok).toBe(true);
		if (!back.ok) return;
		const links = pageLinks(back.doc.pages[0]!.elements ?? []);
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({ target: "Folder/Note", subpath: "Heading" });
		expect((back.doc.pages[0]!.elements?.[0] as TextElement).text).toBe(doc.pages[0]!.elements[0] && (doc.pages[0]!.elements[0] as TextElement).text);
		expect(parseLinks((back.doc.pages[0]!.elements?.[0] as TextElement).text)).toHaveLength(1);
	});
});
