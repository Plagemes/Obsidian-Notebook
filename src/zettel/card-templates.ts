/**
 * Card templates (Z9): the structure a new card note starts with. Pure: no 'obsidian'.
 *
 * A template adds three things to a card, none of which touches the notebook or its format: Markdown headings
 * (the labelled areas under the card's ink, filled in by typing in the note), tags merged into the card's tags,
 * and a `card-template` property recording which template made it. The type tile is preselected from the template
 * but stays the person's choice. The ink itself is the page or region the card is made of, as always.
 *
 * Built-in templates (concept, question, quote, definition) are defined by i18n keys, so they follow the plugin
 * language; custom templates live in the plugin settings (card-template-settings.ts) with their texts as typed.
 */
import type { MessageKey } from "../i18n/en";
import type { CompanionTextDeps } from "../model/companion-content";
import { expandPlaceholders } from "../model/notebook-template";
import { cleanTags, editProperties, type CardType } from "./card-content";
import type { CustomCardTemplate } from "./card-template-settings";

/** Frontmatter key that names the template a card was made from (informational; the plugin never reads it back). */
export const CARD_TEMPLATE_KEY = "card-template";
/** The "no template" choice: a card exactly as before. */
export const BLANK_TEMPLATE_ID = "blank";

export const SECTION_MAX = 12;
export const SECTION_LENGTH_MAX = 80;

export interface CardTemplate {
	id: string;
	builtin: boolean;
	name: string;
	/** One line under the name in the picker. */
	hint: string;
	/** Lucide icon. */
	icon: string;
	/** The type tile this template preselects. */
	type: CardType;
	tags: string[];
	/** Headings of the labelled areas, in order. */
	sections: string[];
}

interface BuiltinDef {
	id: string;
	icon: string;
	type: CardType;
	tags: readonly string[];
	name: MessageKey;
	hint: MessageKey;
	sections: readonly MessageKey[];
}

export const BUILTIN_DEFS: readonly BuiltinDef[] = [
	{
		id: "concept", icon: "lightbulb", type: "permanent", tags: [], name: "zettel.tpl.concept", hint: "zettel.tpl.concept.hint",
		sections: ["zettel.tpl.concept.s1", "zettel.tpl.concept.s2", "zettel.tpl.concept.s3", "zettel.tpl.concept.s4"],
	},
	{
		id: "question", icon: "circle-help", type: "fleeting", tags: ["question"], name: "zettel.tpl.question", hint: "zettel.tpl.question.hint",
		sections: ["zettel.tpl.question.s1", "zettel.tpl.question.s2", "zettel.tpl.question.s3", "zettel.tpl.question.s4"],
	},
	{
		id: "quote", icon: "quote", type: "literature", tags: ["quote"], name: "zettel.tpl.quote", hint: "zettel.tpl.quote.hint",
		sections: ["zettel.tpl.quote.s1", "zettel.tpl.quote.s2", "zettel.tpl.quote.s3", "zettel.tpl.quote.s4"],
	},
	{
		id: "definition", icon: "book-a", type: "permanent", tags: ["definition"], name: "zettel.tpl.definition", hint: "zettel.tpl.definition.hint",
		sections: ["zettel.tpl.definition.s1", "zettel.tpl.definition.s2", "zettel.tpl.definition.s3", "zettel.tpl.definition.s4"],
	},
];

/** A heading text as it will be written: one line, no leading `#`, trimmed, bounded. Empty when nothing is left. */
export function cleanSection(raw: string): string {
	return raw.replace(/[\r\n]+/g, " ").replace(/^[\s#]+/, "").trim().slice(0, SECTION_LENGTH_MAX).trim();
}

/** Headings typed one per line (blank lines dropped, at most SECTION_MAX). */
export function parseSections(text: string): string[] {
	const out: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const s = cleanSection(line);
		if (s) out.push(s);
		if (out.length >= SECTION_MAX) break;
	}
	return out;
}

export function builtinTemplates(tr: (key: MessageKey) => string): CardTemplate[] {
	return BUILTIN_DEFS.map((d) => ({
		id: d.id, builtin: true, name: tr(d.name), hint: tr(d.hint), icon: d.icon, type: d.type, tags: [...d.tags], sections: d.sections.map((k) => tr(k)),
	}));
}

export function customTemplates(list: readonly CustomCardTemplate[]): CardTemplate[] {
	return list.map((c) => ({
		id: c.id, builtin: false, name: c.name, hint: c.sections.slice(0, 3).join(" / "), icon: "layout-template", type: c.type, tags: [...c.tags], sections: [...c.sections],
	}));
}

/** The templates a picker offers: the built-in ones, then the custom ones. */
export function allTemplates(tr: (key: MessageKey) => string, custom: readonly CustomCardTemplate[]): CardTemplate[] {
	return [...builtinTemplates(tr), ...customTemplates(custom)];
}

/** The template with this id; null for blank, an empty id or one that no longer exists (a deleted custom template). */
export function findTemplate(templates: readonly CardTemplate[], id: string | undefined): CardTemplate | null {
	if (!id || id === BLANK_TEMPLATE_ID) return null;
	return templates.find((t) => t.id === id) ?? null;
}

/** A free id for a new custom template. */
export function newTemplateId(existing: readonly { id: string }[]): string {
	const taken = new Set(existing.map((e) => e.id));
	for (let n = 1; ; n++) {
		const id = `custom-${n}`;
		if (!taken.has(id)) return id;
	}
}

/** Tags of a card after adding the template's: cleaned, no duplicates, the person's own first. */
export function templateTags(own: readonly string[], template: CardTemplate | null): string[] {
	return cleanTags([...own, ...(template?.tags ?? [])]);
}

/** The Markdown the template adds after the card's text: one heading per labelled area, each followed by room to write. */
export function templateBody(template: CardTemplate, now: Date = new Date()): string {
	const parts: string[] = [];
	for (const raw of template.sections) {
		const heading = cleanSection(template.builtin ? raw : expandPlaceholders(raw, now));
		if (heading) parts.push(`## ${heading}\n\n`);
	}
	return parts.join("");
}

/**
 * The text of a new card note with the template applied: the headings after the transcription section and the
 * `card-template` property. A blank template (null) returns the text unchanged. The tags are merged beforehand, into
 * the `NewCard` (templateTags), so they are written in order with the other properties.
 */
export function applyTemplate(text: string, template: CardTemplate | null, deps: CompanionTextDeps, now: Date = new Date()): string {
	if (!template) return text;
	const body = templateBody(template, now);
	let out = text;
	if (body) out = `${out.replace(/\s*$/, "")}\n\n${body}`;
	const edit = editProperties(out, { [CARD_TEMPLATE_KEY]: template.id }, deps);
	return edit.kind === "changed" ? edit.text : out;
}
