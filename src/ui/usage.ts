// ui redesign: how often and how recently each action was used, on this device. Pure; the view keeps the map in
// Obsidian's per-device local storage (never in the vault, never synced, never sent anywhere).

export interface UsageEntry {
	/** Number of uses (capped). */
	n: number;
	/** Last use, ms since the epoch. */
	last: number;
}

export type UsageMap = Readonly<Record<string, UsageEntry>>;

/** Local storage key. */
export const USAGE_KEY = "notebook-ui-usage";
const MAX_COUNT = 10_000;
const MAX_ENTRIES = 200;
/** A use counts half as much after this long. */
export const HALF_LIFE_MS = 14 * 24 * 3600 * 1000;
/** Largest boost recent use can give an action (priorities are 0–100). */
export const MAX_BOOST = 30;

const ID = /^[a-z0-9-]{1,64}$/;

/** Whatever was stored, as a valid map: bad entries are dropped, counts are clamped, at most MAX_ENTRIES are kept. */
export function normaliseUsage(data: unknown): UsageMap {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
	const out: Record<string, UsageEntry> = {};
	const entries = Object.entries(data as Record<string, unknown>)
		.filter(([id, v]) => ID.test(id) && typeof v === "object" && v !== null)
		.map(([id, v]) => {
			const o = v as Record<string, unknown>;
			const n = typeof o.n === "number" && Number.isFinite(o.n) ? Math.min(MAX_COUNT, Math.max(0, Math.floor(o.n))) : 0;
			const last = typeof o.last === "number" && Number.isFinite(o.last) ? Math.max(0, o.last) : 0;
			return [id, { n, last }] as const;
		})
		.filter(([, e]) => e.n > 0)
		.sort((a, b) => b[1].last - a[1].last)
		.slice(0, MAX_ENTRIES);
	for (const [id, e] of entries) out[id] = e;
	return out;
}

/** The map after one more use of `id` at `now` (a new object; the input is not changed). */
export function recordUse(map: UsageMap, id: string, now: number): UsageMap {
	if (!ID.test(id)) return map;
	const prev = map[id];
	return normaliseUsage({ ...map, [id]: { n: Math.min(MAX_COUNT, (prev?.n ?? 0) + 1), last: Math.max(now, prev?.last ?? 0) } });
}

/** Extra priority from use: grows with the count (logarithmically) and fades with time since the last use. */
export function usageBoost(entry: UsageEntry | undefined, now: number): number {
	if (!entry || entry.n <= 0) return 0;
	const age = Math.max(0, now - entry.last);
	const decay = Math.pow(0.5, age / HALF_LIFE_MS);
	return Math.min(MAX_BOOST, 10 * Math.log2(1 + entry.n)) * decay;
}
