import { describe, expect, it } from "vitest";
import { appendTaskLine, buildTaskLine, cleanTaskText, dueText, embedWithWidth, escapeTaskText, isIsoDate, isSubmitKey, taskCropRect, taskPictureName, taskStamp } from "../src/model/selection-task";
import { isPluginPictureName } from "../src/storage/plugin-written";

describe("task from a selection (0.17 #57)", () => {
	it("crops around the selection, padded and kept inside the page", () => {
		expect(taskCropRect({ minX: 100, minY: 100, maxX: 200, maxY: 160 }, { width: 595, height: 842 })).toEqual({ x: 88, y: 88, width: 124, height: 84 });
		const edge = taskCropRect({ minX: 0, minY: 0, maxX: 30, maxY: 30 }, { width: 595, height: 842 });
		expect(edge.x).toBe(0);
		expect(edge.y).toBe(0);
	});

	it("never makes a degenerate crop", () => {
		const r = taskCropRect({ minX: 300, minY: 300, maxX: 300, maxY: 300 }, { width: 595, height: 842 });
		expect(r.width).toBeGreaterThanOrEqual(48);
		expect(r.height).toBeGreaterThanOrEqual(48);
		const tiny = taskCropRect({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, { width: 10, height: 10 });
		expect(tiny.width).toBeGreaterThanOrEqual(1);
		expect(tiny.x + tiny.width).toBeLessThanOrEqual(10);
	});

	it("names the picture so the inbox recognises it", () => {
		const name = taskPictureName("Maths", 3, taskStamp(new Date(2026, 10, 4, 9, 5, 7)));
		expect(name).toBe("Maths task p3-090507.png");
		expect(isPluginPictureName(name)).toBe(true);
		expect(isPluginPictureName("Maths task p3-090507 2.png")).toBe(true);
		expect(isPluginPictureName("holiday task photo.png")).toBe(false);
	});

	it("validates dates for real", () => {
		expect(isIsoDate("2026-02-28")).toBe(true);
		expect(isIsoDate("2026-02-30")).toBe(false);
		expect(isIsoDate("")).toBe(false);
		expect(dueText("2026-11-10", true)).toBe("\u{1F4C5} 2026-11-10");
		expect(dueText("2026-11-10", false)).toBe("[due:: 2026-11-10]");
		expect(dueText("nope", true)).toBe("");
	});

	it("sets a display width on wiki and Markdown embeds", () => {
		expect(embedWithWidth("![[a b.png]]", 200)).toBe("![[a b.png|200]]");
		expect(embedWithWidth("![[a.png|50]]", 200)).toBe("![[a.png|200]]");
		expect(embedWithWidth("![](a%20b.png)", 200)).toBe("![|200](a%20b.png)");
		expect(embedWithWidth("![x|10](a.png)", 200)).toBe("![x|200](a.png)");
		expect(embedWithWidth("weird", 200)).toBe("weird");
	});

	it("builds the task line with the date last (the Tasks plugin reads it from the end)", () => {
		const line = buildTaskLine({ text: "  Call\nthe bank ", due: "2026-11-10", emoji: true, image: "![[c.png|200]]", pageLink: "[[Maths#p3]]" });
		expect(line).toBe("- [ ] Call the bank ![[c.png|200]] [[Maths#p3]] \u{1F4C5} 2026-11-10");
		expect(buildTaskLine({ text: "x", due: "", emoji: true, image: null, pageLink: "[[N#p1]]" })).toBe("- [ ] x [[N#p1]]");
		expect(cleanTaskText(" a \n b ")).toBe("a b");
	});

	it("appends without touching the rest of the note", () => {
		const line = "- [ ] a [[N#p1]]";
		expect(appendTaskLine("", line)).toBe(`${line}\n`);
		expect(appendTaskLine("# Day\nText", line)).toBe(`# Day\nText\n${line}\n`);
		expect(appendTaskLine("# Day\r\nText\r\n", line)).toBe(`# Day\r\nText\r\n${line}\r\n`);
		expect(appendTaskLine(`x\n${line}\ny`, line)).toBeNull();
	});
});

describe("F6: typed text cannot open a comment, a math block or a link", () => {
	const bs = "\\";
	/** `text` with a backslash in front of each character of `chars` that occurs in it, the way the expected result is easiest to read. */
	const esc = (text: string, chars: string) => [...text].map((c) => (chars.includes(c) ? bs + c : c)).join("");

	it("escapes what Markdown or Obsidian would act on", () => {
		expect(escapeTaskText("a %% b")).toBe(String.raw`a \%\% b`);
		expect(escapeTaskText("<!-- hide")).toBe(String.raw`\<!-- hide`);
		expect(escapeTaskText("pay $5 and $6")).toBe(String.raw`pay \$5 and \$6`);
		expect(escapeTaskText("see [[Secret]] and [x](y)")).toBe(String.raw`see \[\[Secret\]\] and \[x\](y)`);
		expect(escapeTaskText("![[pic.png]]")).toBe(String.raw`!\[\[pic.png\]\]`);
		expect(escapeTaskText("use `code` and *this* and _that_")).toBe(esc("use `code` and *this* and _that_", "`*_"));
		expect(escapeTaskText("back" + bs + "slash")).toBe("back" + bs + bs + "slash");
	});

	it("keeps a start that would be a heading, a quote or a list from becoming one", () => {
		expect(escapeTaskText("# Title")).toBe(String.raw`\# Title`);
		expect(escapeTaskText("### x")).toBe(String.raw`\### x`);
		expect(escapeTaskText("> quote")).toBe(String.raw`\> quote`);
		expect(escapeTaskText("- item")).toBe(String.raw`\- item`);
		expect(escapeTaskText("+ item")).toBe(String.raw`\+ item`);
		expect(escapeTaskText("1. step")).toBe(String.raw`1\. step`);
		expect(escapeTaskText("2) step")).toBe(String.raw`2\) step`);
	});

	it("leaves ordinary text, tags and numbers alone", () => {
		for (const text of ["Call the bank", "#homework by Friday", "-5 degrees", "3 apples, 2.5 kg", "naïve café 日本語"]) expect(escapeTaskText(text)).toBe(text);
	});

	it("the task line holds the escaped text, once, on one line", () => {
		const line = buildTaskLine({ text: "  %% hide\n[[x]] ", due: "", emoji: true, image: "![[c.png|200]]", pageLink: "[[N#p1]]" });
		expect(line).toBe(String.raw`- [ ] \%\% hide \[\[x\]\] ![[c.png|200]] [[N#p1]]`);
		expect(line.split("\n")).toHaveLength(1);
	});
});

describe("F7: Enter during an IME composition does not add the task", () => {
	it("accepts a plain Enter only", () => {
		expect(isSubmitKey({ key: "Enter" })).toBe(true);
		expect(isSubmitKey({ key: "Enter", isComposing: false, keyCode: 13 })).toBe(true);
		expect(isSubmitKey({ key: "Enter", isComposing: true })).toBe(false);
		expect(isSubmitKey({ key: "Enter", keyCode: 229 })).toBe(false);
		expect(isSubmitKey({ key: "a" })).toBe(false);
	});
});
