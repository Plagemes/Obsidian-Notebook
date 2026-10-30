/**
 * A small least-recently-used cache for the picture bitmaps of an export (pure: what a value is, and how it is freed, is
 * up to the caller). A decoded photo can take tens of megabytes, so the cache is bounded by the number of entries and by
 * their approximate decoded size, and the entries the page being drawn needs are never evicted.
 */
export class BitmapCache<V> {
	private readonly entries = new Map<string, { value: V; cost: number }>();

	/** `release` frees an evicted value (closes the bitmap). */
	constructor(private readonly release: (value: V) => void) {}

	get size(): number {
		return this.entries.size;
	}

	/** Approximate decoded bytes of everything held. */
	get cost(): number {
		let sum = 0;
		for (const e of this.entries.values()) sum += e.cost;
		return sum;
	}

	has(key: string): boolean {
		return this.entries.has(key);
	}

	/** The value, marked as the most recently used; undefined when there is none. */
	get(key: string): V | undefined {
		const e = this.entries.get(key);
		if (!e) return undefined;
		this.entries.delete(key);
		this.entries.set(key, e);
		return e.value;
	}

	set(key: string, value: V, cost: number): void {
		const old = this.entries.get(key);
		if (old && old.value !== value) this.release(old.value);
		this.entries.delete(key);
		this.entries.set(key, { value, cost });
	}

	/**
	 * Evicts (and releases) the least recently used entries that are not in `keep` until at most `maxEntries` entries and
	 * `maxCost` bytes are held, or only the kept ones are left. Returns how many were evicted.
	 */
	trim(maxEntries: number, maxCost: number, keep: ReadonlySet<string>): number {
		let cost = this.cost;
		let evicted = 0;
		for (const [key, e] of [...this.entries]) {
			if (this.entries.size <= maxEntries && cost <= maxCost) break;
			if (keep.has(key)) continue;
			this.entries.delete(key);
			cost -= e.cost;
			this.release(e.value);
			evicted++;
		}
		return evicted;
	}

	/** Releases and forgets everything. */
	clear(): void {
		for (const e of this.entries.values()) this.release(e.value);
		this.entries.clear();
	}
}

/** Bitmaps kept between the pages of an export (plus the ones the page being drawn uses). */
export const MAX_CACHED_BITMAPS = 8;
/** Approximate decoded size (bytes) of the bitmaps kept between pages: phones have little memory for them. */
export const MAX_CACHED_BITMAP_BYTES = 96 * 1024 * 1024;
