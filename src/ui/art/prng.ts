// Seeded randomness for the procedural art: the same seed always gives the same picture.
// Pure logic (no DOM, no obsidian): tested in Node.

/** 32-bit FNV-1a hash of a string (UTF-16 code units). Stable across platforms and runs. */
export function hashString(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	// Final avalanche (from murmur3's fmix32) so that similar strings land far apart.
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return h >>> 0;
}

/** A seeded random source: `next()` in [0, 1), plus small helpers. */
export interface Rng {
	next(): number;
	/** Uniform in [a, b). */
	range(a: number, b: number): number;
	/** Integer in [a, b] (both inclusive). */
	int(a: number, b: number): number;
	/** True with probability p. */
	chance(p: number): boolean;
}

/** mulberry32 (public domain, Tommy Ettinger): a small, fast 32-bit generator with good statistics for graphics. */
export function mulberry32(seed: number): Rng {
	let a = seed >>> 0;
	const next = (): number => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		next,
		range: (lo, hi) => lo + (hi - lo) * next(),
		int: (lo, hi) => lo + Math.floor((hi - lo + 1) * next()),
		chance: (p) => next() < p,
	};
}

/** The generator for a string seed. */
export function rngFor(seed: string): Rng {
	return mulberry32(hashString(seed));
}

/**
 * Seeded 2D value noise with smooth (quintic) interpolation on a 256-entry lattice, plus fractal sums of it.
 * Values are in [0, 1]. Used by the contour and flow families.
 */
export class ValueNoise {
	private readonly values = new Float32Array(256);
	private readonly perm = new Uint8Array(512);

	constructor(rng: Rng) {
		for (let i = 0; i < 256; i++) {
			this.values[i] = rng.next();
			this.perm[i] = i;
		}
		for (let i = 255; i > 0; i--) {
			const j = Math.floor(rng.next() * (i + 1));
			const t = this.perm[i]!;
			this.perm[i] = this.perm[j]!;
			this.perm[j] = t;
		}
		for (let i = 0; i < 256; i++) this.perm[i + 256] = this.perm[i]!;
	}

	private lattice(ix: number, iy: number): number {
		return this.values[this.perm[(this.perm[ix & 255]! + iy) & 511]!]!;
	}

	noise(x: number, y: number): number {
		const ix = Math.floor(x), iy = Math.floor(y);
		const fx = x - ix, fy = y - iy;
		const sx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
		const sy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
		const a = this.lattice(ix, iy), b = this.lattice(ix + 1, iy);
		const c = this.lattice(ix, iy + 1), d = this.lattice(ix + 1, iy + 1);
		const top = a + (b - a) * sx, bottom = c + (d - c) * sx;
		return top + (bottom - top) * sy;
	}

	/** Fractal sum of `octaves` octaves, normalised back to [0, 1]. */
	fbm(x: number, y: number, octaves: number): number {
		let sum = 0, amp = 1, norm = 0, f = 1;
		for (let o = 0; o < octaves; o++) {
			sum += amp * this.noise(x * f, y * f);
			norm += amp;
			amp *= 0.5;
			f *= 2.03;
		}
		return sum / norm;
	}
}
