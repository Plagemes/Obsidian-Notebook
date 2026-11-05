import { describe, expect, it } from "vitest";
import { formatNewBlock, findNewBlocks, parseNewBlock, replaceNewBlock } from "../src/integration/new-block";
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
