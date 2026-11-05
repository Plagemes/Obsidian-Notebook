import { describe, expect, it } from "vitest";
import {
	appendLookUpLine, buildLookUpLine, clampLookUpWidth, entriesOfNotebook, LOOKUP_WIDTH_DEFAULT, LOOKUP_WIDTH_MAX, LOOKUP_WIDTH_MIN, lookUpDate, lookUpNotePath, lookUpPictureName,
	lookUpSubpath, lookUpWord, openCount, parseLookUpLine, parseLookUpNote,
} from "../src/model/look-up";

const link = "[[Notebooks/Maths.notebook#p3&id=abc123|Maths p. 3]]";

describe("look up later: path and settings", () => {
	it("defaults to a note in the notebooks folder", () => {
		expect(lookUpNotePath("", "Notebooks")).toBe("Notebooks/Look up later.md");
		expect(lookUpNotePath("  ", "Notebooks/")).toBe("Notebooks/Look up later.md");
		expect(lookUpNotePath("", "")).toBe("Look up later.md");
	});
	it("keeps a configured path, adding .md and dropping a leading slash", () => {
		expect(lookUpNotePath("Words/To check", "Notebooks")).toBe("Words/To check.md");
		expect(lookUpNotePath("/Words/list.MD", "Notebooks")).toBe("Words/list.MD");
		expect(lookUpNotePath(`a${String.fromCharCode(92)}b`, "x")).toBe("a/b.md");
	});
	it("keeps the width in range", () => {
		expect(clampLookUpWidth(1)).toBe(LOOKUP_WIDTH_MIN);
		expect(clampLookUpWidth(9999)).toBe(LOOKUP_WIDTH_MAX);
		expect(clampLookUpWidth("x")).toBe(LOOKUP_WIDTH_DEFAULT);
		expect(clampLookUpWidth(NaN)).toBe(LOOKUP_WIDTH_DEFAULT);
		expect(clampLookUpWidth(150.4)).toBe(150);
	});
	it("names the picture and formats the date", () => {
		expect(lookUpPictureName("Maths", 3, "093015")).toBe("Maths lookup p3-093015.png");
		expect(lookUpDate(new Date(2026, 10, 4, 9))).toBe("2026-11-04");
	});
});

describe("look up later: building a line", () => {
	it("has the picture, the typed word, the link and the date", () => {
		expect(buildLookUpLine({ image: "![[crop.png|150]]", word: "ephemeral", pageLink: link, date: "2026-11-04" })).toBe(`- [ ] ![[crop.png|150]] ephemeral — ${link} (2026-11-04)`);
	});
	it("works without a word or without a picture", () => {
		expect(buildLookUpLine({ image: "![[c.png|150]]", word: "  ", pageLink: link, date: "2026-11-04" })).toBe(`- [ ] ![[c.png|150]] — ${link} (2026-11-04)`);
		expect(buildLookUpLine({ image: null, word: "x", pageLink: link, date: "2026-11-04" })).toBe(`- [ ] x — ${link} (2026-11-04)`);
	});
	it("escapes typed text and never lets it break the line", () => {
		const w = lookUpWord("a *b* [[c]] %% <x>\n$y$");
		expect(w).not.toContain("\n");
		const B = String.fromCharCode(92);
		expect(w).toBe(`a ${B}*b${B}* ${B}[${B}[c${B}]${B}] ${B}%${B}% ${B}<x> ${B}$y${B}$`);
		expect(lookUpWord("# heading")).toBe(`${B}# heading`);
		expect(lookUpWord("a — b")).toBe("a - b");
		expect(lookUpWord("x".repeat(500)).length).toBe(120);
	});
});

describe("look up later: appending", () => {
	it("adds at the end and keeps the note byte for byte", () => {
		const original = "# Words\r\n\r\n- [ ] old";
		const out = appendLookUpLine(original, "- [ ] new");
		expect(out).toBe(`${original}\r\n- [ ] new\r\n`);
		expect(appendLookUpLine("", "- [ ] new")).toBe("- [ ] new\n");
		expect(appendLookUpLine("a\n", "- [ ] new")).toBe("a\n- [ ] new\n");
	});
	it("does not add the same line twice", () => {
		expect(appendLookUpLine("x\n- [ ] new\n", "- [ ] new")).toBeNull();
	});
});

describe("look up later: parsing", () => {
	it("reads back what it built", () => {
		const line = buildLookUpLine({ image: "![[Attachments/Maths lookup p3-093015.png|150]]", word: "a *b*", pageLink: link, date: "2026-11-04" });
		const e = parseLookUpLine(line, 7);
		expect(e).toEqual({
			line: 7, done: false, word: "a *b*", imagePath: "Attachments/Maths lookup p3-093015.png", linkPath: "Notebooks/Maths.notebook", subpath: "p3&id=abc123",
			page: 3, pageId: "abc123", date: "2026-11-04",
		});
	});
	it("reads an entry with no word, a ticked one and Markdown links", () => {
		expect(parseLookUpLine(`- [x] ![[c.png|150]] — ${link} (2026-11-04)`)).toMatchObject({ done: true, word: "", imagePath: "c.png", page: 3 });
		const md = parseLookUpLine("- [ ] ![](Attachments/My%20crop.png) word — [Maths p. 3](<Notebooks/My Maths.notebook#p3&id=q>) (2026-01-02)");
		expect(md).toMatchObject({ word: "word", imagePath: "Attachments/My crop.png", linkPath: "Notebooks/My Maths.notebook", pageId: "q", page: 3, date: "2026-01-02" });
		expect(parseLookUpLine("- [ ] ![](a.png) — [p](Notebooks/A%20B.notebook#p2) (2026-01-02)")).toMatchObject({ linkPath: "Notebooks/A B.notebook", page: 2 });
	});
	it("copes with a word that contains links, dashes or brackets", () => {
		const line = buildLookUpLine({ image: null, word: "see [[x]] - y (2026-01-01)", pageLink: link, date: "2026-11-04" });
		const e = parseLookUpLine(line);
		expect(e?.word).toBe("see [[x]] - y");
		expect(e?.linkPath).toBe("Notebooks/Maths.notebook");
	});
	it("ignores lines that are not entries", () => {
		expect(parseLookUpLine("# Look up later")).toBeNull();
		expect(parseLookUpLine("- plain bullet")).toBeNull();
		expect(parseLookUpLine("- [ ] a task with no link (2026-01-01)")).toBeNull();
		expect(parseLookUpLine("- [ ] ![[only-embed.png]]")).toBeNull();
	});
	it("reads page numbers and ids from a subpath", () => {
		expect(lookUpSubpath("p12&id=a%20b")).toEqual({ page: 12, pageId: "a b" });
		expect(lookUpSubpath("page=4")).toEqual({ page: 4, pageId: null });
		expect(lookUpSubpath("Heading")).toEqual({ page: null, pageId: null });
		expect(lookUpSubpath("")).toEqual({ page: null, pageId: null });
	});
	it("reads a whole note, filters one notebook and counts the open ones", () => {
		const other = "[[Notebooks/Physics.notebook#p1|Physics p. 1]]";
		const text = ["# Look up later", "", `- [ ] ![[a.png|150]] one — ${link} (2026-11-04)`, `- [x] two — ${other} (2026-11-04)`, "text", `- [x] ![[b.png|150]] — ${link} (2026-11-05)`].join("\r\n");
		const all = parseLookUpNote(text);
		expect(all.map((e) => e.line)).toEqual([2, 3, 5]);
		const mine = entriesOfNotebook(all, (p) => p === "Notebooks/Maths.notebook");
		expect(mine.map((e) => e.word)).toEqual(["one", ""]);
		expect(openCount(mine)).toBe(1);
	});
});
