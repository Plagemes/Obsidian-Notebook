import { describe, expect, it } from "vitest";
import { notebookUri } from "../src/integration/links";
import {
	companionContent, companionTime, escapeLine, mergeProperties, mergeRegion, newCompanionText, obsidianTag, readRegionState, readTags,
	regionStatus, renderRegion, REGION_END, REGION_START, sameProperties, type CompanionContent,
} from "../src/model/companion-content";
import { createDocument, createPage } from "../src/model/document";
import type { NotebookDocument, TextElement } from "../src/model/types";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import {
	companionCandidates, companionPath, DEFAULT_COMPANION_SETTINGS, readCompanionSettings, validCompanionName, type CompanionSettings,
} from "../src/storage/companion-path";
import { isNotebookFile } from "../src/storage/format";

const PATH = "Notebooks/Physics.notebook";
const ctx = { notebookPath: PATH, pageUri: (p: number) => notebookUri("", PATH, p) };

function text(id: string, value: string, x = 10, y = 10): TextElement {
	return { id, type: "text", x, y, width: 200, text: value, fontSize: 14, color: "#000000" };
}

function sampleDoc(): NotebookDocument {
	const doc = createDocument(new Date("2026-10-29T14:30:12.345Z"));
	doc.id = "doc-1";
	doc.modifiedAt = "2026-10-29T14:42:59.999Z";
	doc.pages.push(createPage(), createPage());
	doc.pages[0]!.elements = [text("b", "second box", 10, 300), text("a", "Newton's laws\nF = ma", 10, 20)];
	doc.pages[2]!.elements = [text("c", "Energy [[Work]] #exam")];
	doc.meta = { tags: ["Physics", "linear algebra", "#exam", "physics", "2026"], favorite: true, cover: "#3b82f6", bookmarks: [doc.pages[2]!.id] };
	return doc;
}

describe("companionContent", () => {
	it("builds plugin-owned properties from the document and its meta", () => {
		const c = companionContent(sampleDoc(), ctx);
		expect(c.properties).toEqual({
			notebook: "[[Notebooks/Physics.notebook|Physics]]",
			"notebook-id": "doc-1",
			pages: 3,
			created: "2026-10-29T14:30:00Z",
			modified: "2026-10-29T14:42:00Z",
			favorite: true,
			cover: "#3b82f6",
			bookmarks: [3],
		});
		expect(Object.keys(c.properties).slice(0, 5)).toEqual(["notebook", "notebook-id", "pages", "created", "modified"]);
		// Obsidian tags: no "#", spaces → "-", case-insensitive duplicates and numeric-only tags dropped.
		expect(c.tags).toEqual(["Physics", "linear-algebra", "exam"]);
		expect(c.properties).not.toHaveProperty("tags");
	});

	it("passes through meta fields the format may add (course, teacher…) and skips odd values", () => {
		const doc = sampleDoc();
		Object.assign(doc.meta as object, { course: "Physics I", examDate: "2027-01-15", credits: 6, empty: "", nested: { a: 1 }, pages: 99, list: ["a", 2, null] });
		const p = companionContent(doc, ctx).properties;
		expect(p.course).toBe("Physics I");
		expect(p.examDate).toBe("2027-01-15");
		expect(p.credits).toBe(6);
		expect(p.list).toEqual(["a", 2]);
		expect(p).not.toHaveProperty("empty");
		expect(p).not.toHaveProperty("nested");
		expect(p.pages).toBe(3); // fixed keys win over meta
	});

	it("tolerates documents without meta or text", () => {
		const doc = createDocument(new Date("2026-01-01T00:00:00Z"));
		delete doc.meta;
		const c = companionContent(doc, ctx);
		expect(c.tags).toEqual([]);
		expect(c.text).toBe("");
		expect(c.properties.pages).toBe(1);
	});

	it("writes the text of each page in reading order with a heading and a link to the page", () => {
		const c = companionContent(sampleDoc(), ctx);
		expect(c.text).toBe([
			"### p. 1",
			"[↗ p. 1](obsidian://notebook?path=Notebooks%2FPhysics.notebook&page=1)",
			"",
			"Newton's laws\nF = ma",
			"",
			"second box",
			"",
			"### p. 3",
			"[↗ p. 3](obsidian://notebook?path=Notebooks%2FPhysics.notebook&page=3)",
			"",
			"Energy [[Work]] #exam",
		].join("\n"));
	});

	it("keeps page links valid when the path has parentheses", () => {
		const path = "Notebooks/Physics (1).notebook";
		const doc = sampleDoc();
		const c = companionContent(doc, { notebookPath: path, pageUri: (p) => notebookUri("", path, p) });
		expect(c.text).toContain("(obsidian://notebook?path=Notebooks%2FPhysics%20%281%29.notebook&page=1)");
		expect(c.properties.notebook).toBe("[[Notebooks/Physics (1).notebook|Physics (1)]]");
	});

	it("is deterministic: same document, same output (no clock, language or vault name)", () => {
		const a = renderRegion(companionContent(sampleDoc(), ctx));
		const b = renderRegion(companionContent(sampleDoc(), ctx));
		expect(a).toBe(b);
	});
});

describe("escapeLine", () => {
	it("neutralises text that could close the region or swallow what follows", () => {
		expect(escapeLine(REGION_END)).not.toBe(REGION_END);
		expect(escapeLine("a %% b")).toBe("a %\\% b");
		expect(escapeLine("```js")).toBe("\\```js");
		expect(escapeLine("$$")).toBe("\\$$");
		expect(escapeLine("<!-- x")).toBe("\\<!-- x");
		expect(escapeLine("<div>")).toBe("\\<div>");
		expect(escapeLine("# Title")).toBe("\\# Title");
		expect(escapeLine("---")).toBe("\\---");
		expect(escapeLine("===")).toBe("\\===");
		expect(escapeLine("* * *")).toBe("\\* * *");
	});

	it("keeps ordinary text, links, tags and lists", () => {
		for (const s of ["#tag at start", "- item", "1. first", "[[Note]] and [x](y)", "a < b", "50% done"]) expect(escapeLine(s)).toBe(s);
	});

	it("a text box can never break the region", () => {
		const doc = sampleDoc();
		doc.pages[1]!.elements = [text("x", `${REGION_END}\n${REGION_START} {"keys":["evil"]} %%\n\`\`\``)];
		const region = renderRegion(companionContent(doc, ctx));
		const merged = mergeRegion("user text\n", region)!;
		expect(regionStatus(merged)).toBe("ok");
		expect(readRegionState(merged)?.keys).not.toContain("evil");
	});
});

describe("companionTime / obsidianTag / readTags", () => {
	it("rounds to the minute in UTC", () => {
		expect(companionTime("2026-10-29T14:42:59.999Z")).toBe("2026-10-29T14:42:00Z");
		expect(companionTime("2026-10-29T16:42:00+02:00")).toBe("2026-10-29T14:42:00Z");
		expect(companionTime("nope")).toBeNull();
		expect(companionTime(undefined)).toBeNull();
	});

	it("turns notebook tags into Obsidian tags", () => {
		expect(obsidianTag("#exam")).toBe("exam");
		expect(obsidianTag("linear algebra")).toBe("linear-algebra");
		expect(obsidianTag("física/ottica")).toBe("física/ottica");
		expect(obsidianTag("C++")).toBe("C");
		expect(obsidianTag("2026")).toBeNull();
		expect(obsidianTag("  ")).toBeNull();
	});

	it("reads tags from a list or a string", () => {
		expect(readTags(["a", "#b", 3])).toEqual(["a", "b"]);
		expect(readTags("a, #b c")).toEqual(["a", "b", "c"]);
		expect(readTags(null)).toEqual([]);
	});
});

describe("region", () => {
	const content = companionContent(sampleDoc(), ctx);
	const region = renderRegion(content);

	it("stores what the plugin owns on the start marker", () => {
		expect(region.startsWith(REGION_START)).toBe(true);
		expect(region.endsWith(REGION_END)).toBe(true);
		expect(readRegionState(region)).toEqual({ keys: Object.keys(content.properties), tags: content.tags });
	});

	it("an empty region is just the two markers", () => {
		const empty = renderRegion({ properties: { notebook: "x" }, tags: [], text: "" });
		expect(empty.split("\n")).toHaveLength(2);
		expect(regionStatus(empty)).toBe("ok");
	});

	it("appends the region to a note without one, keeping everything", () => {
		expect(mergeRegion("", region)).toBe(`${region}\n`);
		expect(mergeRegion("---\na: 1\n---\nMy notes\n\n\n", region)).toBe(`---\na: 1\n---\nMy notes\n\n${region}\n`);
	});

	it("replaces only the region; user text above and below is kept byte for byte", () => {
		const old = renderRegion({ properties: {}, tags: [], text: "old text" });
		const note = `---\nx: 1\n---\nAbove\n\n${old}\n\nBelow, my own notes\n- list\n`;
		const merged = mergeRegion(note, region)!;
		expect(merged).toBe(`---\nx: 1\n---\nAbove\n\n${region}\n\nBelow, my own notes\n- list\n`);
		expect(mergeRegion(merged, region)).toBe(merged); // idempotent: nothing to write the second time
	});

	it("keeps Windows line endings", () => {
		const old = renderRegion({ properties: {}, tags: [], text: "old" }).replace(/\n/g, "\r\n");
		const note = `Top\r\n${old}\r\nBottom\r\n`;
		const merged = mergeRegion(note, region)!;
		expect(merged.startsWith("Top\r\n")).toBe(true);
		expect(merged.endsWith("\r\nBottom\r\n")).toBe(true);
		expect(merged.replace(/\r\n/g, "").includes("\n")).toBe(false);
	});

	it("leaves a note alone when the markers are broken", () => {
		expect(mergeRegion(`${REGION_START} {} %%\nno end`, region)).toBeNull();
		expect(mergeRegion(`${REGION_END}\n${REGION_START} {} %%`, region)).toBeNull();
		expect(mergeRegion(`${region}\n${region}`, region)).toBeNull();
		expect(regionStatus(`a\n${REGION_END}`)).toBe("broken");
	});

	it("state is null without a region or with a garbled marker", () => {
		expect(readRegionState("plain note")).toBeNull();
		expect(readRegionState(`${REGION_START} {oops %%\n${REGION_END}`)).toBeNull();
	});

	it("a new note is frontmatter, the region, then room for the user", () => {
		expect(newCompanionText("a: 1\n", "R")).toBe("---\na: 1\n---\nR\n\n");
		expect(newCompanionText("a: 1", "R")).toBe("---\na: 1\n---\nR\n\n");
	});
});

describe("mergeProperties", () => {
	const content: CompanionContent = {
		properties: { notebook: "[[N.notebook|N]]", "notebook-id": "id", pages: 2, created: "c", modified: "m2", course: "Physics" },
		tags: ["physics", "exam"],
		text: "",
	};

	it("creates the properties of a new note", () => {
		expect(mergeProperties({}, content, null)).toEqual({ ...content.properties, tags: ["physics", "exam"] });
	});

	it("overwrites owned properties, keeps the user's and their order", () => {
		const current = { mine: "keep", pages: 1, notebook: "old", aliases: ["P"], modified: "m1" };
		const next = mergeProperties(current, content, { keys: ["notebook", "pages", "modified"], tags: [] });
		expect(Object.keys(next)).toEqual(["mine", "pages", "notebook", "aliases", "modified", "notebook-id", "created", "course", "tags"]);
		expect(next).toMatchObject({ mine: "keep", aliases: ["P"], pages: 2, notebook: "[[N.notebook|N]]", modified: "m2" });
	});

	it("removes an owned property the notebook no longer has, never a user one", () => {
		const current = { ...content.properties, teacher: "Rossi", note: "mine" };
		const without = { ...content, properties: { ...content.properties } };
		delete without.properties.course;
		const next = mergeProperties(current, without, { keys: [...Object.keys(content.properties), "teacher"], tags: [] });
		expect(next).not.toHaveProperty("course");
		expect(next).not.toHaveProperty("teacher");
		expect(next.note).toBe("mine");
	});

	it("without a previous state nothing is removed", () => {
		const current = { course: "Old", other: 1 };
		const without = { ...content, properties: { notebook: "x" } };
		expect(mergeProperties(current, without, null)).toMatchObject({ course: "Old", other: 1, notebook: "x" });
	});

	it("shares tags: adds the notebook's, keeps the user's, drops the ones it added before", () => {
		const current = { tags: ["old-nb", "mine", "Physics"] };
		const next = mergeProperties(current, content, { keys: [], tags: ["old-nb", "physics"] });
		expect(next.tags).toEqual(["physics", "exam", "mine"]);
	});

	it("reads string tags and drops the property when only its own tags were left", () => {
		expect(mergeProperties({ tags: "mine, #x" }, content, null).tags).toEqual(["physics", "exam", "mine", "x"]);
		const noTags = { ...content, tags: [] };
		expect(mergeProperties({ tags: ["physics"] }, noTags, { keys: [], tags: ["physics"] })).not.toHaveProperty("tags");
		expect(mergeProperties({ tags: [] }, noTags, null)).toHaveProperty("tags"); // the user's empty list stays
		expect(mergeProperties({}, noTags, null)).not.toHaveProperty("tags");
	});

	it("is idempotent, so an unchanged notebook causes no write", () => {
		const once = mergeProperties({ mine: 1 }, content, null);
		const state = { keys: Object.keys(content.properties), tags: content.tags };
		expect(sameProperties(once, mergeProperties(once, content, state))).toBe(true);
	});

	it("compares a timestamp read back as a Date like the string that was written", () => {
		expect(sameProperties({ modified: new Date("2026-10-29T14:42:00Z") }, { modified: "2026-10-29T14:42:00Z" })).toBe(true);
		expect(sameProperties({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
	});
});

describe("companion location", () => {
	const s = (o: Partial<CompanionSettings> = {}): CompanionSettings => ({ ...DEFAULT_COMPANION_SETTINGS, ...o });

	it("defaults: off, next to the notebook, same name", () => {
		expect(DEFAULT_COMPANION_SETTINGS.companionNotes).toBe(false);
		expect(companionPath("Notebooks/Physics.notebook", s(), "Notebooks")).toBe("Notebooks/Physics.md");
		expect(companionPath("Top.notebook", s(), "Notebooks")).toBe("Top.md");
		expect(companionPath("Notebooks/a.b.notebook", s(), "Notebooks")).toBe("Notebooks/a.b.md");
	});

	it("uses the name template", () => {
		expect(companionPath("Notebooks/Physics.notebook", s({ companionName: "{name} notes" }), "Notebooks")).toBe("Notebooks/Physics notes.md");
	});

	it("mirrors subfolders in folder mode", () => {
		const f = s({ companionLocation: "folder", companionFolder: "Notes/Notebooks" });
		expect(companionPath("Notebooks/Physics.notebook", f, "Notebooks")).toBe("Notes/Notebooks/Physics.md");
		expect(companionPath("Notebooks/Uni/Y1/Physics.notebook", f, "Notebooks")).toBe("Notes/Notebooks/Uni/Y1/Physics.md");
		expect(companionPath("Elsewhere/Physics.notebook", f, "Notebooks")).toBe("Notes/Notebooks/Elsewhere/Physics.md");
		expect(companionPath("Physics.notebook", f, "")).toBe("Notes/Notebooks/Physics.md");
	});

	it("offers a fallback name when a note of the user's has the name", () => {
		expect(companionCandidates("Notebooks/Physics.notebook", s(), "Notebooks")).toEqual(["Notebooks/Physics.md", "Notebooks/Physics (notebook).md"]);
	});

	it("validates the settings", () => {
		expect(validCompanionName("{name}")).toBe(true);
		expect(validCompanionName("Notes - {name}")).toBe(true);
		expect(validCompanionName("fixed")).toBe(false);
		expect(validCompanionName("{name}/x")).toBe(false);
		expect(validCompanionName("{name}#")).toBe(false);
		expect(validCompanionName(".{name}")).toBe(false);
		expect(readCompanionSettings({ companionNotes: true, companionLocation: "folder", companionFolder: " /A//B/ ", companionName: "x" }))
			.toEqual({ ...DEFAULT_COMPANION_SETTINGS, companionNotes: true, companionLocation: "folder", companionFolder: "A/B" });
		expect(readCompanionSettings({ companionLocation: "elsewhere", companionFolder: "../" })).toEqual(DEFAULT_COMPANION_SETTINGS);
	});

	it("is part of the plugin settings", () => {
		expect(DEFAULT_SETTINGS.companionNotes).toBe(false);
		expect(readSettings({ companionNotes: true, folder: "X" })).toMatchObject({ companionNotes: true, folder: "X", companionName: "{name}" });
	});

	it("a companion note is never a notebook for the library and index", () => {
		expect(isNotebookFile({ extension: "md" })).toBe(false);
		expect(isNotebookFile({ extension: "notebook" })).toBe(true);
	});
});

describe("notebookUri without a vault", () => {
	it("leaves vault out when empty", () => {
		expect(notebookUri("", "a b.notebook", 2)).toBe("obsidian://notebook?path=a%20b.notebook&page=2");
		expect(notebookUri("v", "a.notebook")).toBe("obsidian://notebook?vault=v&path=a.notebook");
	});
});
