/**
 * The words of the units hint (#293): every sentence and quantity name exists in English and Italian, the hint is
 * quiet when there is nothing to say, long lists are cut, and the setting is stored, defaulted and listed.
 */
import { describe, expect, it } from "vitest";
import { en, type MessageKey } from "../src/i18n/en";
import { it as itTable } from "../src/i18n/it";
import { analyzeDimensions, QUANTITY_NAMES } from "../src/math/dimensions";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import { dimensionHint, HINT_MAX_SHOWN, issueText, type Translate } from "../src/view/dimension-hint";
import { settingSpecs } from "../src/view/settings-schema";

const tr = (table: Partial<Record<MessageKey, string>>): Translate => (key, vars) => {
	let text = table[key] ?? en[key];
	if (vars) for (const [k, v] of Object.entries(vars)) text = text.replace(`{${k}}`, v);
	return text;
};
const english = tr(en);
const italian = tr(itTable);

describe("quantity names", () => {
	it("are translated in both languages", () => {
		for (const q of QUANTITY_NAMES) {
			if (q === "dimensionless") continue;
			const key = `dimcheck.q.${q}` as MessageKey;
			expect(en[key], q).toBeTruthy();
			expect(itTable[key], q).toBeTruthy();
		}
	});
});

describe("the sentences", () => {
	it("spell out a sum of length and time", () => {
		const issue = analyzeDimensions("5\\,\\mathrm{m} + 3\\,\\mathrm{s}").issues[0]!;
		expect(issueText(issue, english)).toBe("Cannot add 5 m (length, m) and 3 s (time, s): the terms of a sum must have the same dimension.");
		expect(issueText(issue, italian)).toContain("lunghezza, m");
		expect(issueText(issue, italian)).toContain("tempo, s");
	});

	it("covers every kind of issue in both languages", () => {
		const cases = [
			"5\\,\\mathrm{m} - 3\\,\\mathrm{s}",
			"5\\,\\mathrm{m} = 3\\,\\mathrm{s}",
			"5\\,\\mathrm{m} < 3\\,\\mathrm{s}",
			"5\\,\\mathrm{m} + 3",
			"3 + 5\\,\\mathrm{m}",
			"2^{3\\,\\mathrm{m}}",
			"\\sin(3\\,\\mathrm{m})",
			"1\\,\\mathrm{J} = 1\\,\\mathrm{kg\\,m^2/s}",
		];
		for (const src of cases) {
			const issue = analyzeDimensions(src).issues[0]!;
			expect(issue, src).toBeDefined();
			for (const tx of [english, italian]) {
				const text = issueText(issue, tx);
				expect(text, src).not.toMatch(/\{\w+\}/);
				expect(text.length, src).toBeGreaterThan(20);
			}
		}
		expect(issueText(analyzeDimensions("5\\,\\mathrm{m} < 3\\,\\mathrm{s}").issues[0]!, english)).toContain("Cannot compare");
		expect(issueText(analyzeDimensions("5\\,\\mathrm{m} + 3").issues[0]!, english)).toContain("3 is a plain number");
		expect(issueText(analyzeDimensions("3 + 5\\,\\mathrm{m}").issues[0]!, english)).toContain("3 is a plain number");
	});

	it("names a dimension without a common name by its SI units", () => {
		const issue = analyzeDimensions("1\\,\\mathrm{m^3 kg^2} + 1\\,\\mathrm{s}").issues[0]!;
		expect(issueText(issue, english)).toContain("kg²·m³");
	});
});

describe("the hint", () => {
	it("is silent for empty text and for text without units", () => {
		expect(dimensionHint("", english)).toBeNull();
		expect(dimensionHint("   ", english)).toBeNull();
		expect(dimensionHint("\\frac{a}{b} = \\sqrt{x}", english)).toBeNull();
		expect(dimensionHint("E = m c^2", english)).toBeNull();
	});

	it("says the units agree when something was checked", () => {
		const h = dimensionHint("1\\,\\mathrm{N} = 1\\,\\mathrm{kg\\,m/s^2}", english);
		expect(h).toEqual({ lines: [], more: 0, consistent: true });
	});

	it("lists problems and counts the rest", () => {
		const lines = Array.from({ length: 5 }, () => "1\\,\\mathrm{m} + 1\\,\\mathrm{s}").join(" \\\\ ");
		const h = dimensionHint(lines, english)!;
		expect(h.consistent).toBe(false);
		expect(h.lines).toHaveLength(HINT_MAX_SHOWN);
		expect(h.more).toBe(5 - HINT_MAX_SHOWN);
	});
});

describe("the setting", () => {
	it("is on by default, read leniently and listed in the writing section", () => {
		expect(DEFAULT_SETTINGS.dimensionHint).toBe(true);
		expect(readSettings({ dimensionHint: false }).dimensionHint).toBe(false);
		expect(readSettings({ dimensionHint: "no" }).dimensionHint).toBe(true);
		expect(readSettings({}).dimensionHint).toBe(true);
		const spec = settingSpecs().find((s) => s.id === "dimensionHint");
		expect(spec?.section).toBe("writing");
		expect(spec?.control.type).toBe("toggle");
	});
});
