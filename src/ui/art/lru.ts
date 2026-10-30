// A small least-recently-used cache (pure logic). Map keeps insertion order, so the first key is the oldest.

export class LruCache<V> {
	private readonly map = new Map<string, V>();
	/** Lookups answered from the cache / lookups that had to build the value (for tests and the harness). */
	hits = 0;
	misses = 0;

	constructor(readonly capacity: number) {}

	get size(): number {
		return this.map.size;
	}

	has(key: string): boolean {
		return this.map.has(key);
	}

	/** The cached value (now the most recently used), or `make()`'s value stored under `key`. */
	getOrCreate(key: string, make: () => V): V {
		const found = this.map.get(key);
		if (found !== undefined) {
			this.hits++;
			this.map.delete(key);
			this.map.set(key, found);
			return found;
		}
		this.misses++;
		const value = make();
		this.map.set(key, value);
		while (this.map.size > this.capacity) {
			const oldest = this.map.keys().next();
			if (oldest.done) break;
			this.map.delete(oldest.value);
		}
		return value;
	}

	clear(): void {
		this.map.clear();
		this.hits = 0;
		this.misses = 0;
	}
}
