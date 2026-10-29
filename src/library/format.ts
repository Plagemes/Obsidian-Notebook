/** Small formatting helpers. Pure, no 'obsidian'. */

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export function collatorCompare(a: string, b: string): number {
	return collator.compare(a, b);
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
	["year", 365 * 24 * 3600],
	["month", 30 * 24 * 3600],
	["week", 7 * 24 * 3600],
	["day", 24 * 3600],
	["hour", 3600],
	["minute", 60],
];

/** "3 hours ago", "yesterday", "now" in the given locale. */
export function relativeTime(ms: number, now: number, locale?: string): string {
	const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
	const seconds = Math.round((ms - now) / 1000);
	const abs = Math.abs(seconds);
	for (const [unit, size] of UNITS) {
		if (abs >= size) return rtf.format(Math.trunc(seconds / size), unit);
	}
	return rtf.format(0, "second");
}

/** Path of `name.ext` inside `dir`, adding " 2", " 3"… until `exists` says it is free. */
export function uniquePath(dir: string, name: string, ext: string, exists: (path: string) => boolean): string {
	const prefix = dir === "" || dir === "/" ? "" : `${dir}/`;
	let path = `${prefix}${name}.${ext}`;
	for (let i = 2; exists(path); i++) path = `${prefix}${name} ${i}.${ext}`;
	return path;
}
