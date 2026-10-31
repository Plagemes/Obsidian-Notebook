/**
 * 0.13: the contextual greeting of Home ("Buonasera, Alex · 3 pagine scritte oggi"). Pure: no 'obsidian', no DOM. The text
 * itself comes from the i18n tables; this decides which one to use.
 */

export const DAY_PARTS = ["morning", "afternoon", "evening", "night"] as const;
export type DayPart = typeof DAY_PARTS[number];

/** Longest name kept from the "Your name" setting. */
export const USER_NAME_MAX = 40;

/** Morning 05–11, afternoon 12–17, evening 18–21, night 22–04 (local hours). */
export function dayPart(hour: number): DayPart {
	const h = Math.trunc(((hour % 24) + 24) % 24);
	if (h >= 5 && h < 12) return "morning";
	if (h >= 12 && h < 18) return "afternoon";
	if (h >= 18 && h < 22) return "evening";
	return "night";
}

/** The "Your name" setting made safe for a heading: one line, single spaces, at most `USER_NAME_MAX` characters. */
export function cleanUserName(value: unknown): string {
	if (typeof value !== "string") return "";
	// Control characters (a pasted newline, a tab) become spaces; runs of spaces become one.
	const plain = [...value].map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c)).join("");
	return [...plain.replace(/\s+/g, " ").trim()].slice(0, USER_NAME_MAX).join("").trim();
}

export interface GreetingInput {
	/** Local time. */
	now: Date;
	/** The "Your name" setting (any text; cleaned here). */
	name: string;
	/** Pages written today on this device. */
	pagesToday: number;
}

export interface Greeting {
	part: DayPart;
	name: string;
	pagesToday: number;
}

export function greetingOf(input: GreetingInput): Greeting {
	return { part: dayPart(input.now.getHours()), name: cleanUserName(input.name), pagesToday: Math.max(0, Math.trunc(input.pagesToday) || 0) };
}

/** What the greeting needs from the i18n table: a message by key (the keys are listed in `GREETING_KEYS`). */
export type Translate = (key: GreetingKey, vars?: Record<string, string>) => string;

export const GREETING_KEYS = [
	"home.greeting.morning", "home.greeting.afternoon", "home.greeting.evening", "home.greeting.night",
	"home.greeting.morning.named", "home.greeting.afternoon.named", "home.greeting.evening.named", "home.greeting.night.named",
	"home.greeting.pages.one", "home.greeting.pages.many", "home.greeting.idle",
] as const;
export type GreetingKey = typeof GREETING_KEYS[number];

/** "Good evening, Alex · 3 pages written today", or "Good evening · Ready when you are." when nothing was written yet. */
export function greetingText(g: Greeting, tr: Translate): string {
	const salute = g.name ? tr(`home.greeting.${g.part}.named` as GreetingKey, { name: g.name }) : tr(`home.greeting.${g.part}` as GreetingKey);
	const tail = g.pagesToday > 0
		? tr(g.pagesToday === 1 ? "home.greeting.pages.one" : "home.greeting.pages.many", { n: String(g.pagesToday) })
		: tr("home.greeting.idle");
	return `${salute} · ${tail}`;
}
