import { describe, expect, it } from "vitest";
import { findNewBlocks, formatNewBlock, isTemplateNote, newBlockSlot, parseNewBlock, replaceNewBlock, templateFoldersFrom } from "../src/integration/new-block";
import { linkMarkup, parseCreateOptions, pickTemplate } from "../src/integration/api-plan";

describe("parseNewBlock", () => {
	it("reads quoted, single-quoted, bare and colon forms", () => {
		const r = parseNewBlock('name="Maths sketches"\ntemplate=\'Lecture\'\nfolder: Notebooks/Maths\ncontent=false\nopen = yes');
		expect(r).toEqual({ ok: true, spec: { name: "Maths sketches", template: "Lecture", folder: "Notebooks/Maths", content: false, open: true } });
	});
	it("refuses what it cannot read, without guessing", () => {
		expect(parseNewBlock("  \n")).toMatchObject({ ok: false, error: "empty" });
		expect(parseNewBlock("hello")).toMatchObject({ ok: false, error: "syntax" });
		expect(parseNewBlock('name="x')).toMatchObject({ ok: false, error: "syntax" });
		expect(parseNewBlock('name="x"\ncolour=red')).toMatchObject({ ok: false, error: "unknown-key", detail: "colour" });
		expect(parseNewBlock("template=Lecture")).toMatchObject({ ok: false, error: "no-name" });
		expect(parseNewBlock("name=x\nopen=maybe")).toMatchObject({ ok: false, error: "bad-value" });
	});
	it("refuses template syntax that was not expanded", () => {
		expect(parseNewBlock('name="{{title}} sketches"')).toMatchObject({ ok: false, error: "unexpanded" });
		expect(parseNewBlock('name="<% tp.file.title %>"')).toMatchObject({ ok: false, error: "unexpanded" });
	});
	it("round-trips through formatNewBlock", () => {
		const spec = { name: "A", template: "T", folder: "F", content: true, open: false };
		const found = findNewBlocks(formatNewBlock(spec));
		expect(found).toHaveLength(1);
		expect(parseNewBlock(found[0]!.source)).toEqual({ ok: true, spec });
	});
});

const block = (body: string, fence = "```") => `${fence}notebook-new\n${body}\n${fence}`;

describe("replaceNewBlock", () => {
	const b1 = block('name="A"');
	const b2 = block('name="B"');
	it("replaces only the matching block and keeps the rest byte for byte", () => {
		const text = `# Title\r\n\nbefore\n${b1}\nmiddle\n${b2}\nafter\n`;
		expect(replaceNewBlock(text, 'name="B"', "![[B.notebook]]")).toBe(`# Title\r\n\nbefore\n${b1}\nmiddle\n![[B.notebook]]\nafter\n`);
	});
	it("does nothing when there is no such block", () => {
		expect(replaceNewBlock("just text", 'name="A"', "x")).toBeNull();
		expect(replaceNewBlock(b1, 'name="Z"', "x")).toBeNull();
	});
	it("tells identical blocks apart only by the section line, else refuses", () => {
		const text = `${b1}\n\n${b1}\n`;
		expect(replaceNewBlock(text, 'name="A"', "X")).toBeNull();
		expect(replaceNewBlock(text, 'name="A"', "X", 4)).toBe(`${b1}\n\nX\n`);
		expect(replaceNewBlock(text, 'name="A"', "X", 0)).toBe(`X\n\n${b1}\n`);
	});
	it("keeps the block it was made for when lines are typed above while the notebook is being made (M12)", () => {
		const text = `${b1}\n\n${b1}\n`;
		// The button of the second identical block: its slot is fixed before anything is made.
		const slot = newBlockSlot(text, 'name="A"', 4);
		expect(slot).toEqual({ index: 1, count: 2 });
		expect(newBlockSlot(text, 'name="A"')).toBeNull(); // two identical blocks and no hint: no guess
		// Three lines typed above meanwhile: the old hint (4) would now point at the first block's line + 1; the slot still finds the second one.
		const typed = `a\nb\nc\n${text}`;
		expect(replaceNewBlock(typed, 'name="A"', "X", 4, slot!)).toBe(`a\nb\nc\n${b1}\n\nX\n`);
		// Without the slot the stale hint would have replaced the wrong block or none.
		expect(replaceNewBlock(typed, 'name="A"', "X", 4)).toBeNull();
		// A block was added or removed meanwhile (the count changed): only a unique block is replaced, never a guess.
		expect(replaceNewBlock(`${b1}\n\n${b1}\n\n${b1}\n`, 'name="A"', "X", 4, slot!)).toBeNull();
		expect(replaceNewBlock(`${b1}\n`, 'name="A"', "X", 4, slot!)).toBe("X\n");
	});
	it("finds the template folders of core Templates and Templater, and tells a template note from a normal one (M13)", () => {
		const app = {
			internalPlugins: { getPluginById: (id: string) => (id === "templates" ? { enabled: true, instance: { options: { folder: "Templates/" } } } : null) },
			plugins: { plugins: { "templater-obsidian": { settings: { templates_folder: "/Tpl/Notebooks" } } } },
		};
		const folders = templateFoldersFrom(app);
		expect(folders).toEqual(["Templates", "Tpl/Notebooks"]);
		expect(isTemplateNote("Templates/Class note.md", folders)).toBe(true);
		expect(isTemplateNote("Tpl/Notebooks/sub/Lab.md", folders)).toBe(true);
		expect(isTemplateNote("Templates2/Note.md", folders)).toBe(false);
		expect(isTemplateNote("Daily/2026-11-04.md", folders)).toBe(false);
		// A disabled core plugin, missing plugins or odd internals read as no folder.
		expect(templateFoldersFrom({ internalPlugins: { getPluginById: () => ({ enabled: false, instance: { options: { folder: "T" } } }) } })).toEqual([]);
		expect(templateFoldersFrom(undefined)).toEqual([]);
		expect(templateFoldersFrom({ internalPlugins: { getPluginById: () => { throw new Error("x"); } } })).toEqual([]);
		expect(isTemplateNote("Anything.md", [])).toBe(false);
	});
	it("ignores an example inside a longer fence and other languages", () => {
		const example = `\`\`\`\`md\n${b1}\n\`\`\`\`\n`;
		expect(findNewBlocks(example)).toHaveLength(0);
		expect(replaceNewBlock(example, 'name="A"', "X")).toBeNull();
		expect(findNewBlocks("```js\nname=\"A\"\n```")).toHaveLength(0);
	});
	it("handles ~~~ fences, CRLF and a missing final newline", () => {
		const text = "~~~notebook-new\r\nname=\"A\"\r\n~~~";
		expect(replaceNewBlock(text, 'name="A"', "X")).toBe("X");
	});
	it("leaves an unclosed fence alone", () => {
		expect(replaceNewBlock("```notebook-new\nname=\"A\"\n", 'name="A"', "X")).toBeNull();
	});
});

describe("API additions", () => {
	it("picks a template by name or path", () => {
		const list = [{ name: "Lecture", path: "Notebooks/_templates/notebooks/Lecture.notebook" }, { name: "Lab", path: "x/Lab.notebook" }];
		expect(pickTemplate(list, "lecture")?.name).toBe("Lecture");
		expect(pickTemplate(list, "Lab.notebook")?.name).toBe("Lab");
		expect(pickTemplate(list, "x/Lab")?.name).toBe("Lab");
		expect(pickTemplate(list, "Nope")).toBeUndefined();
	});
	it("builds link markup", () => {
		expect(linkMarkup("[[A.notebook]]")).toEqual({ link: "[[A.notebook]]", embed: "![[A.notebook]]" });
		expect(linkMarkup("![[A.notebook]]")).toEqual({ link: "[[A.notebook]]", embed: "![[A.notebook]]" });
	});
	it("validates the template options", () => {
		expect(parseCreateOptions({ template: " Lecture ", templateContent: false })).toMatchObject({ template: "Lecture", templateContent: false, });
		expect(() => parseCreateOptions({ template: "L", paper: "grid" })).toThrow(/cannot be combined/);
		expect(() => parseCreateOptions({ templateContent: true })).toThrow(/needs options.template/);
		expect(() => parseCreateOptions({ template: "" })).toThrow();
		expect(parseCreateOptions({ template: "L", tags: ["a"] })).toMatchObject({ tags: ["a"] });
	});
});
