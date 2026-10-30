import { en, type MessageKey } from "./en";
import { it } from "./it";

export type Messages = Partial<Record<MessageKey, string>>;

/** The UI language setting: follow Obsidian, or force one of the registered languages. */
export type UiLanguage = "auto" | LanguageCode;

/**
 * Registry of the UI languages. To add one: create `src/i18n/<code>.ts` with a single object literal (like `it.ts`),
 * add it here, and `tests/i18n.test.ts` checks it against English. Missing keys fall back to English at runtime.
 */
export const LANGUAGES = {
	en: { label: "English", messages: en },
	it: { label: "Italiano", messages: it },
} as const;

export type LanguageCode = keyof typeof LANGUAGES;

export const LANGUAGE_CODES = Object.keys(LANGUAGES) as LanguageCode[];

export function isUiLanguage(value: unknown): value is UiLanguage {
	return value === "auto" || (typeof value === "string" && Object.prototype.hasOwnProperty.call(LANGUAGES, value));
}

/** The language in effect: the setting, or for "auto" the one of Obsidian (e.g. "it-IT" -> "it"), else English. */
export function resolveLanguage(setting: UiLanguage, obsidianLanguage: string): LanguageCode {
	if (setting !== "auto") return setting;
	const base = obsidianLanguage.toLowerCase().split(/[-_]/)[0] ?? "";
	return LANGUAGE_CODES.find((code) => code === base) ?? "en";
}
