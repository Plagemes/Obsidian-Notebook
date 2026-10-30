import { getLanguage } from "obsidian";
import { LANGUAGES, resolveLanguage, type Messages, type UiLanguage } from "./i18n/languages";
import { en, type MessageKey } from "./i18n/en";

export type { MessageKey } from "./i18n/en";
export { LANGUAGES, LANGUAGE_CODES, isUiLanguage, resolveLanguage, type LanguageCode, type UiLanguage } from "./i18n/languages";

let setting: UiLanguage = "auto";
let table: Messages | null = null;
const listeners = new Set<() => void>();

/**
 * Sets the UI language (the `uiLanguage` setting) and drops the cached table, so the next `t()` uses it.
 * Strings already rendered are not touched: surfaces re-render on `onLanguageChanged`. Command names are registered
 * once, so they follow the language at plugin startup.
 */
export function setUiLanguage(language: UiLanguage): void {
	if (language === setting && table) return;
	const changed = language !== setting;
	setting = language;
	table = null;
	if (changed) for (const fn of [...listeners]) fn();
}

/** Calls `fn` after the UI language changed. Returns the unsubscribe function. */
export function onLanguageChanged(fn: () => void): () => void {
	listeners.add(fn);
	return () => void listeners.delete(fn);
}

export function t(key: MessageKey, vars?: Record<string, string>): string {
	table ??= LANGUAGES[resolveLanguage(setting, getLanguage())].messages;
	let text = table[key] ?? en[key];
	if (vars) for (const [k, v] of Object.entries(vars)) text = text.replace(`{${k}}`, v);
	return text;
}
