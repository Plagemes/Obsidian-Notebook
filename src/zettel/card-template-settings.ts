/** Custom card templates (Z9) in the plugin settings. Pure: no 'obsidian'. Merged into NotebookSettings like the Zettelkasten settings. */
import { CARD_TYPES, type CardType } from "./card-content";

export interface CustomCardTemplate {
	id: string;
	name: string;
	/** The type tile the template preselects. */
	type: CardType;
	tags: string[];
	/** Headings of the labelled areas. */
	sections: string[];
	/** Fields a newer version wrote that this one does not know: kept as written when the list is saved again. */
	[unknown: string]: unknown;
}

export interface CardTemplateSettings {
	zettelCardTemplates: CustomCardTemplate[];
}

export const CUSTOM_TEMPLATES_MAX = 24;
export const TEMPLATE_NAME_MAX = 40;
const SECTIONS_MAX = 12;
const SECTION_LENGTH = 80;
const TAGS_MAX = 12;

export const DEFAULT_CARD_TEMPLATE_SETTINGS: Readonly<CardTemplateSettings> = { zettelCardTemplates: [] };

const strings = (v: unknown, max: number, length: number): string[] =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim().slice(0, length)).filter((x) => x.length > 0).slice(0, max) : [];

/** One template from saved data; null when it is unusable (no id or name). Wrong-typed parts fall back, unknown fields are kept. */
export function readCustomTemplate(raw: unknown): CustomCardTemplate | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const id = typeof r.id === "string" ? r.id.trim() : "";
	const name = typeof r.name === "string" ? r.name.trim().slice(0, TEMPLATE_NAME_MAX) : "";
	if (!id || !name) return null;
	return {
		...r,
		id, name,
		type: CARD_TYPES.includes(r.type as CardType) ? (r.type as CardType) : "permanent",
		tags: strings(r.tags, TAGS_MAX, 40),
		sections: strings(r.sections, SECTIONS_MAX, SECTION_LENGTH),
	};
}

/** The custom templates from saved plugin data: unusable entries and repeated ids are dropped, at most CUSTOM_TEMPLATES_MAX. */
export function readCardTemplateSettings(d: Record<string, unknown>): CardTemplateSettings {
	const list: CustomCardTemplate[] = [];
	const seen = new Set<string>();
	if (Array.isArray(d.zettelCardTemplates)) {
		for (const raw of d.zettelCardTemplates) {
			const tpl = readCustomTemplate(raw);
			if (!tpl || seen.has(tpl.id) || tpl.id === "blank") continue;
			seen.add(tpl.id);
			list.push(tpl);
			if (list.length >= CUSTOM_TEMPLATES_MAX) break;
		}
	}
	return { zettelCardTemplates: list };
}
