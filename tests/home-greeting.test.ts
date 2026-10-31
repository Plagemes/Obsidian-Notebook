import { describe, expect, it } from "vitest";
import { cleanUserName, dayPart, greetingOf, greetingText, GREETING_KEYS, USER_NAME_MAX, type GreetingKey } from "../src/library/greeting";
import { en } from "../src/i18n/en";
import { it as itMessages } from "../src/i18n/it";
import { readSettings } from "../src/settings";

/** A tiny translator over the real English table. */
const tr = (key: GreetingKey, vars: Record<string, string> = {}): string =>
	en[key].replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? `{${name}}`);

describe("greeting: time of day", () => {
	it("splits the day into morning, afternoon, evening and night", () => {
		expect([4, 5, 11].map(dayPart)).toEqual(["night", "morning", "morning"]);
		expect([12, 17].map(dayPart)).toEqual(["afternoon", "afternoon"]);
		expect([18, 21].map(dayPart)).toEqual(["evening", "evening"]);
		expect([22, 23, 0, 3].map(dayPart)).toEqual(["night", "night", "night", "night"]);
	});

	it("tolerates hours outside 0-23", () => {
		expect(dayPart(24 + 9)).toBe("morning");
		expect(dayPart(-1)).toBe("night");
	});
});

describe("greeting: the name", () => {
	it("is trimmed to one line and a sensible length", () => {
		expect(cleanUserName("  Alex  ")).toBe("Alex");
		expect(cleanUserName("Alex\n\tGorbatiuk")).toBe("Alex Gorbatiuk");
		expect(cleanUserName("x".repeat(100))).toHaveLength(USER_NAME_MAX);
		expect(cleanUserName(42)).toBe("");
		expect(cleanUserName(undefined)).toBe("");
	});

	it("is kept by the settings reader, cleaned", () => {
		expect(readSettings({ userName: "  Alex " }).userName).toBe("Alex");
		expect(readSettings({ userName: 5 }).userName).toBe("");
		expect(readSettings({}).userName).toBe("");
	});
});

describe("greeting: the line", () => {
	const at = (h: number) => new Date(2026, 9, 31, h, 30);

	it("names the person and counts the pages written today", () => {
		const g = greetingOf({ now: at(19), name: "Alex", pagesToday: 3 });
		expect(greetingText(g, tr)).toBe("Good evening, Alex · 3 pages written today");
	});

	it("says '1 page' for one", () => {
		expect(greetingText(greetingOf({ now: at(9), name: "Alex", pagesToday: 1 }), tr)).toBe("Good morning, Alex · 1 page written today");
	});

	it("leaves the name out when there is none", () => {
		expect(greetingText(greetingOf({ now: at(14), name: "  ", pagesToday: 2 }), tr)).toBe("Good afternoon · 2 pages written today");
	});

	it("replaces the count with a gentle line when nothing was written", () => {
		expect(greetingText(greetingOf({ now: at(10), name: "Alex", pagesToday: 0 }), tr)).toBe("Good morning, Alex · Ready when you are");
		expect(greetingText(greetingOf({ now: at(23), name: "", pagesToday: -4 }), tr)).toBe("Good night · Ready when you are");
	});

	it("has every key in English and Italian with the same placeholders", () => {
		const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
		for (const key of GREETING_KEYS) {
			expect(en[key], key).toBeTruthy();
			expect(itMessages[key], key).toBeTruthy();
			expect(holes(itMessages[key] ?? ""), key).toBe(holes(en[key]));
		}
	});
});
