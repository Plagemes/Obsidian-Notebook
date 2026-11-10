import { describe, expect, it } from "vitest";
import type { CompanionTextDeps } from "../src/model/companion-content";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import { newCardText, readCard, type NewCard } from "../src/zettel/card-content";
import { CUSTOM_TEMPLATES_MAX, readCardTemplateSettings, readCustomTemplate } from "../src/zettel/card-template-settings";
import {
	allTemplates, applyTemplate, BLANK_TEMPLATE_ID, builtinTemplates, CARD_TEMPLATE_KEY, cleanSection, customTemplates, findTemplate, newTemplateId,
	parseSections, SECTION_MAX, templateBody, templateTags,
} from "../src/zettel/card-templates";
import { en, type MessageKey } from "../src/i18n/en";
import { it as itMessages } from "../src/i18n/it";

/** Test stand-ins for Obsidian's frontmatter helpers: `key: <JSON>` lines (as in zettel.test.ts). */
const deps: CompanionTextDeps = {
	frontmatterInfo(text) {
		const open = /^---\r?\n/.exec(text);
		if (!open) return { exists: false, from: 0, to: 0 };
		const from = open[0].length;
		const close = text.indexOf("\n---", from - 1);
		return close < 0 ? { exists: false, from: 0, to: 0 } : { exists: true, from, to: close + 1 };
	},
	parseFrontmatter(yaml) {
		const out: Record<string, unknown> = {};
		for (const raw of yaml.split(/\r?\n/)) {
			if (!raw.trim()) continue;
			const i = raw.indexOf(":");
			if (i < 0) return null;
			try {
				out[raw.slice(0, i).trim()] = JSON.parse(raw.slice(i + 1).trim());
			} catch {
				return null;
			}
		}
		return out;
	},
	stringify(data) {
		return Object.entries(data).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n") + "\n";
	},
};

const tr = (k: MessageKey): string => en[k];
const card: NewCard = {
	id: "202611101200", title: "Entropy", type: "permanent", source: "", tags: ["physics"], date: "2026-11-10",
	notebookPath: "Notebooks/Physics.notebook", notebookId: "nb1", pageId: "p1", page: 1, region: null,
};

describe("built-in templates", () => {
	it("are concept, question, quote and definition, each with four areas, in English and Italian", () => {
		for (const messages of [en, itMessages] as Array<Record<string, string>>) {
			const list = builtinTemplates((k) => messages[k]!);
			expect(list.map((x) => x.id)).toEqual(["concept", "question", "quote", "definition"]);
			for (const tpl of list) {
				expect(tpl.sections).toHaveLength(4);
				expect(tpl.name.length).toBeGreaterThan(0);
				expect(tpl.sections.every((s) => s.length > 0)).toBe(true);
			}
		}
		expect(builtinTemplates((k) => (itMessages as Record<string, string>)[k]!)[2]!.name).toBe("Citazione");
	});

	it("suggest a type and tags", () => {
		const by = Object.fromEntries(builtinTemplates(tr).map((x) => [x.id, x]));
		expect(by.quote).toMatchObject({ type: "literature", tags: ["quote"] });
		expect(by.question).toMatchObject({ type: "fleeting", tags: ["question"] });
		expect(by.concept?.tags).toEqual([]);
	});
});

describe("applying a template", () => {
	const text = newCardText(card, (d) => deps.stringify(d));
	const concept = builtinTemplates(tr)[0]!;

	it("leaves a blank card exactly as before", () => {
		expect(applyTemplate(text, null, deps)).toBe(text);
		expect(findTemplate(builtinTemplates(tr), BLANK_TEMPLATE_ID)).toBeNull();
		expect(findTemplate(builtinTemplates(tr), undefined)).toBeNull();
		expect(findTemplate(builtinTemplates(tr), "gone")).toBeNull();
		expect(findTemplate(builtinTemplates(tr), "quote")?.id).toBe("quote");
	});

	it("adds one heading per area after the transcription and records the template", () => {
		const out = applyTemplate(text, concept, deps);
		expect(out).toContain(`${CARD_TEMPLATE_KEY}: "concept"`);
		const body = out.slice(out.indexOf("\n---\n", 4) + 5);
		expect(body).toMatch(/!\[\[Notebooks\/Physics\.notebook#/);
		expect(body.indexOf("## Transcription")).toBeLessThan(body.indexOf("## The idea in one sentence"));
		expect(body.match(/^## /gm)).toHaveLength(5);
		expect(body.endsWith("## Connections\n\n")).toBe(true);
	});

	it("keeps the card readable as a card", () => {
		const out = applyTemplate(text, concept, deps);
		const info = deps.frontmatterInfo(out);
		const fm = deps.parseFrontmatter(out.slice(info.from, info.to))!;
		expect(readCard("Zettelkasten/x.md", fm)).toMatchObject({ id: card.id, pageId: "p1", notebookId: "nb1" });
	});

	it("keeps the transcription text the card was made with", () => {
		const withText = newCardText({ ...card, transcription: "heat flows to cold" }, (d) => deps.stringify(d));
		const out = applyTemplate(withText, concept, deps);
		expect(out).toContain("## Transcription\n\nheat flows to cold\n\n## The idea in one sentence");
	});

	it("merges the template's tags after the person's, without duplicates", () => {
		const quote = builtinTemplates(tr)[2]!;
		expect(templateTags(["physics", "Quote"], quote)).toEqual(["physics", "Quote"]);
		expect(templateTags(["physics"], quote)).toEqual(["physics", "quote"]);
		expect(templateTags(["a"], null)).toEqual(["a"]);
	});

	it("fills {{date}} in the areas of a custom template, and cleans headings", () => {
		const [tpl] = customTemplates([{ id: "custom-1", name: "Log", type: "fleeting", tags: [], sections: ["Seen on {{date}}", "## Next\nstep"] }]);
		const body = templateBody(tpl!, new Date(2026, 10, 9, 8, 0));
		expect(body).toBe("## Seen on 2026-11-09\n\n## Next step\n\n");
	});

	it("writes no heading for a template without areas but still records it", () => {
		const [tpl] = customTemplates([{ id: "custom-1", name: "Tag only", type: "permanent", tags: ["x"], sections: [] }]);
		const out = applyTemplate(text, tpl!, deps);
		expect(out).toContain(`${CARD_TEMPLATE_KEY}: "custom-1"`);
		expect(out.match(/^## /gm)).toHaveLength(1);
	});
});

describe("sections", () => {
	it("are one per line, cleaned and bounded", () => {
		expect(cleanSection("  ### Why  ")).toBe("Why");
		expect(cleanSection("#")).toBe("");
		expect(cleanSection("x".repeat(200))).toHaveLength(80);
		expect(parseSections("A\n\n  \nB\r\n# C")).toEqual(["A", "B", "C"]);
		expect(parseSections(Array.from({ length: 30 }, (_, i) => `s${i}`).join("\n"))).toHaveLength(SECTION_MAX);
	});

	it("get a free custom id", () => {
		expect(newTemplateId([])).toBe("custom-1");
		expect(newTemplateId([{ id: "custom-1" }, { id: "custom-3" }])).toBe("custom-2");
	});
});

describe("custom template settings", () => {
	it("read leniently: bad entries dropped, parts defaulted, unknown fields kept", () => {
		expect(readCustomTemplate(null)).toBeNull();
		expect(readCustomTemplate({ id: "a" })).toBeNull();
		expect(readCustomTemplate({ name: "x" })).toBeNull();
		const t = readCustomTemplate({ id: "a", name: " My ", type: "nonsense", tags: ["t", 5], sections: "no", future: { a: 1 } })!;
		expect(t).toMatchObject({ id: "a", name: "My", type: "permanent", tags: ["t"], sections: [], future: { a: 1 } });
		const list = readCardTemplateSettings({ zettelCardTemplates: [t, { id: "a", name: "dup" }, 7, { id: "blank", name: "B" }, { id: "b", name: "B", type: "literature" }] }).zettelCardTemplates;
		expect(list.map((x) => x.id)).toEqual(["a", "b"]);
		expect(list[0]!.future).toEqual({ a: 1 });
		expect(readCardTemplateSettings({ zettelCardTemplates: "x" }).zettelCardTemplates).toEqual([]);
		const many = Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, name: `n${i}` }));
		expect(readCardTemplateSettings({ zettelCardTemplates: many }).zettelCardTemplates).toHaveLength(CUSTOM_TEMPLATES_MAX);
	});

	it("are part of the plugin settings and survive a save and load", () => {
		expect(DEFAULT_SETTINGS.zettelCardTemplates).toEqual([]);
		const s = readSettings({ zettelCardTemplates: [{ id: "c1", name: "Mine", type: "literature", tags: ["a"], sections: ["One", "Two"] }] });
		expect(s.zettelCardTemplates[0]).toMatchObject({ id: "c1", sections: ["One", "Two"] });
		expect(readSettings(JSON.parse(JSON.stringify(s)) as Record<string, unknown>).zettelCardTemplates).toEqual(s.zettelCardTemplates);
		expect(allTemplates(tr, s.zettelCardTemplates).map((x) => x.id)).toEqual(["concept", "question", "quote", "definition", "c1"]);
	});
});
