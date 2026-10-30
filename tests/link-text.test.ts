import { describe, expect, it } from "vitest";
import {
	completeLink, hitLink, inkLinkElement, linkMarkup, linkRects, linkTrigger, linktextOf, lineRuns, newNotePath, noteScore, pageLinks,
	parseLinks, rankHeadings, rankNotes, soleLink, splitLinkInner,
} from "../src/ink/link-text";
import { layoutText, textElementBounds } from "../src/ink/text-layout";
import type { PageElement, TextElement } from "../src/model/types";

/** 10 pt per character at font size 10: easy to compute by hand. */
const mono = (s: string, fs: number) => Array.from(s).length * fs;

function box(text: string, over: Partial<TextElement> = {}): TextElement {
	return { id: "t", type: "text", x: 50, y: 100, width: 600, text, fontSize: 10, color: "#000000", ...over };
}

describe("parsing links", () => {
	it("reads a simple link", () => {
		const [l] = parseLinks("see [[Physics]] now");
		expect(l).toMatchObject({ start: 4, end: 15, target: "Physics", subpath: "", alias: null, display: "Physics" });
	});

	it("reads aliases and headings", () => {
		expect(parseLinks("[[Note|the note]]")[0]).toMatchObject({ target: "Note", alias: "the note", display: "the note" });
		expect(parseLinks("[[Note#Heading]]")[0]).toMatchObject({ target: "Note", subpath: "Heading", display: "Note#Heading" });
		expect(parseLinks("[[Folder/Note#A#B|x]]")[0]).toMatchObject({ target: "Folder/Note", subpath: "A#B", alias: "x" });
		expect(parseLinks("[[Note.notebook#p3]]")[0]).toMatchObject({ target: "Note.notebook", subpath: "p3" });
	});

	it("finds several links, also on different lines", () => {
		const links = parseLinks("[[A]] and [[B|b]]\n[[C]]");
		expect(links.map((l) => l.target)).toEqual(["A", "B", "C"]);
	});

	it("ignores what is not a link", () => {
		expect(parseLinks("plain [text] and [[ ]] and [[]] and [[#Heading]] and [[|x]]")).toEqual([]);
		expect(parseLinks("![[embedded.png]]")).toEqual([]);
		expect(parseLinks("[[unclosed")).toEqual([]);
		expect(parseLinks("[[a\nb]]")).toEqual([]);
		expect(parseLinks("[[a[[b]]")).toHaveLength(1);
	});

	it("treats a Windows line ending like a newline", () => {
		expect(parseLinks("a\r\n[[B]]")[0]?.start).toBe(2);
	});

	it("splits the inside of a link", () => {
		expect(splitLinkInner("A#B|c")).toEqual({ target: "A", subpath: "B", alias: "c" });
		expect(splitLinkInner("#only")).toBeNull();
		expect(splitLinkInner("  ")).toBeNull();
		expect(linktextOf({ target: "A", subpath: "B" })).toBe("A#B");
		expect(linktextOf({ target: "A", subpath: "" })).toBe("A");
	});

	it("builds markup that parses back", () => {
		expect(linkMarkup("Note")).toBe("[[Note]]");
		expect(linkMarkup("Note", "alias")).toBe("[[Note|alias]]");
		expect(linkMarkup("Note", "Note")).toBe("[[Note]]");
		expect(linkMarkup("a|b]]c")).toBe("[[a b c]]");
		expect(parseLinks(linkMarkup("Folder/Note#H", "x"))[0]).toMatchObject({ target: "Folder/Note", subpath: "H", alias: "x" });
	});

	it("tells a lone link from a link in text", () => {
		expect(soleLink("[[A]]")?.target).toBe("A");
		expect(soleLink("  [[A]]\n\n\n")?.target).toBe("A");
		expect(soleLink("see [[A]]")).toBeNull();
		expect(soleLink("[[A]] [[B]]")).toBeNull();
		expect(soleLink("")).toBeNull();
	});

	it("lists the links of a page's text boxes", () => {
		const elements: PageElement[] = [box("[[A]]"), { id: "i", type: "image", asset: "a", x: 0, y: 0, width: 1, height: 1, rotation: 0 }, box("x [[B]]")];
		expect(pageLinks(elements).map((l) => l.target)).toEqual(["A", "B"]);
	});
});

describe("links in a laid-out text box", () => {
	it("cuts a wrapped box into runs", () => {
		const text = "go to [[Physics]] today";
		const layout = layoutText(text, 10, 120, (s) => mono(s, 10));
		const runs = lineRuns(text, layout.lines, parseLinks(text));
		expect(runs.flat().map((r) => r.text).join("")).toBe(layout.lines.join(""));
		const linked = runs.flat().filter((r) => r.link).map((r) => r.text).join("");
		expect(linked.replace(/\s/g, "")).toBe("[[Physics]]");
	});

	it("keeps a link that wraps in two pieces", () => {
		const text = "a [[Long note name]] b";
		const el = box(text, { width: 100 });
		const rects = linkRects(el, mono);
		expect(rects.length).toBeGreaterThanOrEqual(2);
		expect(new Set(rects.map((r) => r.link.target))).toEqual(new Set(["Long note name"]));
		for (const r of rects) expect(r.width).toBeLessThanOrEqual(100);
	});

	it("puts the rectangle of a link where it is drawn", () => {
		const el = box("ab [[Note]] cd");
		const [r] = linkRects(el, mono);
		expect(r).toMatchObject({ x: 50 + 3 * 10, y: 100, width: 8 * 10 });
	});

	it("follows explicit newlines and empty lines", () => {
		const el = box("first\n\n[[Second]]");
		const [r] = linkRects(el, mono);
		expect(r?.y).toBeCloseTo(100 + 2 * 12.5);
	});

	it("hits a link and nothing around it", () => {
		const el = box("ab [[Note]] cd");
		expect(hitLink([el], 50 + 5 * 10, 105, 0, mono)?.link.target).toBe("Note");
		expect(hitLink([el], 50 + 1 * 10, 105, 0, mono)).toBeNull();
		expect(hitLink([el], 50 + 5 * 10, 200, 0, mono)).toBeNull();
		expect(hitLink([el], 50 + 5 * 10, 105 + 10, 6, mono)?.link.target).toBe("Note");
		expect(hitLink([box("no links here")], 55, 105, 6, mono)).toBeNull();
	});

	it("takes the topmost box and a lone link by its whole box", () => {
		const under = box("[[Under]]", { id: "u" });
		const over = box("[[Over]]", { id: "o" });
		expect(hitLink([under, over], 52, 104, 0, mono)?.link.target).toBe("Over");
		const lone = box("[[Lone]]\n\n\n\n", { width: 200 });
		const hit = hitLink([lone], 200, 140, 0, mono);
		expect(hit).toMatchObject({ whole: true });
		expect(hit?.link.target).toBe("Lone");
		expect(hitLink([lone], 300, 140, 0, mono)).toBeNull();
	});

	it("survives odd elements", () => {
		expect(hitLink([null, 5, { type: "text" }, { type: "text", text: 3 }], 0, 0, 5, mono)).toBeNull();
	});
});

describe("ink links", () => {
	const page = { width: 595, height: 842 };
	const region = { minX: 100, minY: 200, maxX: 260, maxY: 260 };

	it("places the label above the ink and covers the ink with the box", () => {
		const el = inkLinkElement("id1", region, "Physics", page, "#1e293b", mono);
		const b = textElementBounds(el, (s) => mono(s, el.fontSize));
		expect(el.text.startsWith("[[Physics]]")).toBe(true);
		expect(el.y).toBeLessThan(region.minY);
		expect(el.x).toBe(100);
		expect(el.width).toBe(160);
		expect(b.maxY).toBeGreaterThanOrEqual(region.maxY);
		expect(b.maxY).toBeLessThan(region.maxY + el.fontSize * 1.25);
		expect(soleLink(el.text)?.target).toBe("Physics");
	});

	it("stays on the page", () => {
		const top = inkLinkElement("a", { minX: 5, minY: 2, maxX: 40, maxY: 30 }, "Note", page, "#000000", mono);
		expect(top.y).toBe(0);
		const right = inkLinkElement("b", { minX: 580, minY: 300, maxX: 590, maxY: 320 }, "Note", page, "#000000", mono);
		expect(right.x + right.width).toBeLessThanOrEqual(page.width);
		expect(right.x).toBeGreaterThanOrEqual(0);
	});

	it("gives a long label room instead of cutting it", () => {
		const el = inkLinkElement("c", { minX: 100, minY: 200, maxX: 110, maxY: 215 }, "A rather long note title", page, "#000000", mono);
		expect(el.width).toBeGreaterThanOrEqual(mono("[[A rather long note title]]", el.fontSize));
	});

	it("bounds the number of lines on a huge region", () => {
		const el = inkLinkElement("d", { minX: 0, minY: 0, maxX: 595, maxY: 842 }, "Note", { width: 595, height: 100000 }, "#000000", mono);
		expect(el.text.split("\n").length).toBeLessThanOrEqual(120);
	});
});

describe("typing [[", () => {
	it("finds the link being typed", () => {
		expect(linkTrigger("see [[Phy", 9)).toEqual({ start: 6, query: "Phy" });
		expect(linkTrigger("[[", 2)).toEqual({ start: 2, query: "" });
		expect(linkTrigger("[[Note#Hea", 10)?.query).toBe("Note#Hea");
	});

	it("does not trigger outside an open link", () => {
		expect(linkTrigger("plain text", 10)).toBeNull();
		expect(linkTrigger("[[done]] and more", 17)).toBeNull();
		expect(linkTrigger("[[Note|ali", 10)).toBeNull();
		expect(linkTrigger("[[a\nb", 5)).toBeNull();
		expect(linkTrigger("[[a [b", 6)).toBeNull();
	});

	it("completes the link and swallows a closing ]] that is already there", () => {
		const t = linkTrigger("see [[Phy", 9)!;
		expect(completeLink("see [[Phy", t, 9, "Physics")).toEqual({ text: "see [[Physics]]", cursor: 15 });
		const t2 = linkTrigger("see [[Phy]] more", 9)!;
		expect(completeLink("see [[Phy]] more", t2, 9, "Physics")).toEqual({ text: "see [[Physics]] more", cursor: 15 });
	});
});

describe("choosing a note", () => {
	const notes = [
		{ path: "Physics/Mechanics.md", basename: "Mechanics", mtime: 5 },
		{ path: "Physics.md", basename: "Physics", mtime: 1 },
		{ path: "Chem/Physical chemistry.md", basename: "Physical chemistry", mtime: 9 },
		{ path: "Archive/Old physics notes.md", basename: "Old physics notes", mtime: 3 },
		{ path: "Daily/2026-10-29.md", basename: "2026-10-29", mtime: 10 },
	];

	it("ranks exact, prefix, word start, substring, folder and fuzzy matches in that order", () => {
		expect(noteScore("physics", notes[1]!)).toBe(100);
		expect(noteScore("phys", notes[1]!)).toBe(80);
		expect(noteScore("phys", notes[3]!)).toBe(60);
		expect(noteScore("ysic", notes[1]!)).toBe(50);
		expect(noteScore("phys", notes[0]!)).toBe(30);
		expect(noteScore("pcm", notes[2]!)).toBe(10);
		expect(noteScore("zzz", notes[1]!)).toBe(0);
	});

	it("lists the best matches first", () => {
		expect(rankNotes("physics", notes).map((n) => n.basename)).toEqual(["Physics", "Old physics notes", "Mechanics", "Physical chemistry"]);
		expect(rankNotes("phys", notes)[0]?.basename).toBe("Physics");
	});

	it("lists recent notes for an empty query and respects the limit", () => {
		expect(rankNotes("", notes).map((n) => n.basename)).toEqual(["2026-10-29", "Physical chemistry", "Mechanics", "Old physics notes", "Physics"]);
		expect(rankNotes("", notes, 2)).toHaveLength(2);
	});

	it("filters headings", () => {
		expect(rankHeadings("ne", ["Intro", "Newton", "Energy"])).toEqual(["Newton", "Energy"]);
		expect(rankHeadings("", ["A", "B"])).toEqual(["A", "B"]);
	});
});

describe("creating the note of an unresolved link", () => {
	it("puts a bare name in the default folder", () => {
		expect(newNotePath("Ideas", "Notes")).toEqual({ path: "Notes/Ideas.md", folder: "Notes", name: "Ideas" });
		expect(newNotePath("Ideas", "")).toEqual({ path: "Ideas.md", folder: "", name: "Ideas" });
		expect(newNotePath("Ideas", "/")?.path).toBe("Ideas.md");
	});

	it("takes a name with folders from the vault root", () => {
		expect(newNotePath("Projects/Alpha", "Notes")).toEqual({ path: "Projects/Alpha.md", folder: "Projects", name: "Alpha" });
		expect(newNotePath("Projects/Alpha.md", "Notes")?.path).toBe("Projects/Alpha.md");
	});

	it("refuses names that cannot be files", () => {
		expect(newNotePath("", "")).toBeNull();
		expect(newNotePath("a:b", "")).toBeNull();
		expect(newNotePath("a?b", "")).toBeNull();
		expect(newNotePath("../escape", "")).toBeNull();
		expect(newNotePath("a//b", "")).toBeNull();
	});
});
