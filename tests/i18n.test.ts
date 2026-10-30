import { describe, expect, it } from "vitest";
import enSource from "../src/i18n/en.ts?raw";
import itSource from "../src/i18n/it.ts?raw";
import { en } from "../src/i18n/en";
import { LANGUAGES, LANGUAGE_CODES, isUiLanguage, resolveLanguage } from "../src/i18n/languages";

const SOURCES: Record<string, string> = { en: enSource, it: itSource };

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string).sort();

/** Keys of the table literal in a source file, in order. Object literals silently keep the last duplicate. */
function sourceKeys(code: string): string[] {
	return [...(SOURCES[code] ?? "").matchAll(/^\t"([^"]+)":/gm)].map((m) => m[1] as string);
}

describe("i18n tables", () => {
	const enKeys = Object.keys(en);

	for (const code of LANGUAGE_CODES) {
		const messages: Record<string, string | undefined> = LANGUAGES[code].messages;

		describe(code, () => {
			it("has every English key and no unknown ones", () => {
				expect(enKeys.filter((k) => messages[k] === undefined)).toEqual([]);
				expect(Object.keys(messages).filter((k) => !(k in en))).toEqual([]);
			});

			it("has no empty strings", () => {
				expect(Object.entries(messages).filter(([, v]) => typeof v !== "string" || v.trim() === "").map(([k]) => k)).toEqual([]);
			});

			it("uses the same {placeholders} as English", () => {
				const bad = enKeys.filter((k) => JSON.stringify(placeholders(messages[k] ?? "")) !== JSON.stringify(placeholders((en as Record<string, string>)[k] as string)));
				expect(bad).toEqual([]);
			});

			it("has no duplicate keys in its source", () => {
				const keys = sourceKeys(code);
				expect(keys.length).toBeGreaterThan(0);
				expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
				expect(keys.length).toBe(Object.keys(messages).length);
			});
		});
	}
});

describe("language resolution", () => {
	it("follows Obsidian for auto, falling back to English", () => {
		expect(resolveLanguage("auto", "it")).toBe("it");
		expect(resolveLanguage("auto", "it-IT")).toBe("it");
		expect(resolveLanguage("auto", "en")).toBe("en");
		expect(resolveLanguage("auto", "zh-TW")).toBe("en");
	});

	it("an explicit choice wins over Obsidian", () => {
		expect(resolveLanguage("en", "it")).toBe("en");
		expect(resolveLanguage("it", "en")).toBe("it");
	});

	it("validates the setting value", () => {
		expect(isUiLanguage("auto")).toBe(true);
		expect(isUiLanguage("it")).toBe(true);
		expect(isUiLanguage("xx")).toBe(false);
		expect(isUiLanguage("toString")).toBe(false);
		expect(isUiLanguage(3)).toBe(false);
	});
});

describe("keys used in the code", () => {
	const SRC = import.meta.glob<string>("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

	it("English and Italian have exactly the same keys", () => {
		expect(Object.keys(LANGUAGES.it.messages).sort()).toEqual(Object.keys(en).sort());
	});

	it("every statically visible t(\"…\") key exists", () => {
		const used = new Set<string>();
		for (const [file, text] of Object.entries(SRC)) {
			if (file.includes("/i18n/")) continue;
			for (const m of text.matchAll(/\bt\(\s*"([A-Za-z0-9_.]+)"/g)) used.add(m[1] as string);
		}
		expect(used.size).toBeGreaterThan(50);
		expect([...used].filter((k) => !(k in en))).toEqual([]);
	});
});
