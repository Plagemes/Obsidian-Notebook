import { describe, expect, it } from "vitest";
import { appendInsertBlock, buildInsertLine, clampInsertWidth, cropSvg, editorStillTargets, insertionAtCursor, insertPictureName, insertPoint } from "../src/model/note-insert";

describe("note insert text", () => {
	it("clamps the width", () => {
		expect(clampInsertWidth(10)).toBe(100);
		expect(clampInsertWidth(99999)).toBe(1600);
		expect(clampInsertWidth(412.4)).toBe(412);
		expect(clampInsertWidth("x")).toBe(400);
		expect(clampInsertWidth(NaN)).toBe(400);
	});
	it("names the picture", () => {
		expect(insertPictureName("Physics", 3, "101500", "png")).toBe("Physics p3-101500.png");
		expect(insertPictureName("Physics", 3, "101500", "svg")).toBe("Physics p3-101500.svg");
	});
	it("builds the line with and without the link back", () => {
		expect(buildInsertLine({ embed: "![[a.png]]", width: 400, pageLink: null })).toBe("![[a.png|400]]");
		expect(buildInsertLine({ embed: "![[a.png]]", width: 300, pageLink: "[[Phys#p3&id=x|↩]]" })).toBe("![[a.png|300]] [[Phys#p3&id=x|↩]]");
		expect(buildInsertLine({ embed: "![](a.png)", width: 300, pageLink: null })).toBe("![|300](a.png)");
	});
	it("puts the block on its own lines at a cursor", () => {
		expect(insertionAtCursor("X", "", "")).toBe("X");
		expect(insertionAtCursor("X", "abc", "")).toBe("\nX");
		expect(insertionAtCursor("X", "", "abc")).toBe("X\n");
		expect(insertionAtCursor("X", "a", "b")).toBe("\nX\n");
	});
	it("appends at the end of a note", () => {
		expect(appendInsertBlock("", "X")).toBe("X\n");
		expect(appendInsertBlock("a", "X")).toBe("a\n\nX\n");
		expect(appendInsertBlock("a\n", "X")).toBe("a\n\nX\n");
		expect(appendInsertBlock("a\n\n", "X")).toBe("a\n\nX\n");
	});
	it("crops an svg by its root only", () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 595 842"><rect width="595" height="842"/></svg>';
		const out = cropSvg(svg, { x: 10, y: 20, width: 100, height: 50 });
		expect(out).toContain('viewBox="10 20 100 50"');
		expect(out).toContain('<rect width="595" height="842"/></svg>');
		expect(out?.match(/<svg/g)?.length).toBe(1);
		expect(cropSvg("<p>", { x: 0, y: 0, width: 1, height: 1 })).toBeNull();
	});
});

describe("insertion point", () => {
	const lines = ["---", "title: x", "---", "first", "second"];
	const get = (n: number) => lines[n] ?? "";
	it("keeps a cursor in the body where it is", () => {
		expect(insertPoint({ line: 3, ch: 2 }, 2, get, 4)).toEqual({ line: 3, ch: 2, before: "fi", after: "rst" });
		expect(insertPoint({ line: 0, ch: 0 }, null, get, 4)).toEqual({ line: 0, ch: 0, before: "", after: "---" });
	});
	it("moves a cursor inside the front matter to just after it", () => {
		for (const line of [0, 1, 2]) {
			const p = insertPoint({ line, ch: 1 }, 2, get, 4);
			expect(p).toEqual({ line: 3, ch: 0, before: "", after: "first" });
		}
		expect(insertionAtCursor("X", "", "first")).toBe("X\n");
	});
	it("goes to the end when the front matter is the whole note", () => {
		const fm = ["---", "a: 1", "---"];
		const p = insertPoint({ line: 0, ch: 0 }, 2, (n) => fm[n] ?? "", 2);
		expect(p).toEqual({ line: 2, ch: 3, before: "---", after: "" });
		expect(insertionAtCursor("X", p.before, p.after)).toBe("\nX");
	});
});

describe("the editor chosen before drawing", () => {
	it("is used only while it still shows the same note in source mode", () => {
		expect(editorStillTargets("a.md", "a.md", "source")).toBe(true);
		expect(editorStillTargets("b.md", "a.md", "source")).toBe(false);
		expect(editorStillTargets(undefined, "a.md", "source")).toBe(false);
		expect(editorStillTargets("a.md", "a.md", "preview")).toBe(false);
	});
});
