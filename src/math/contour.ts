/**
 * Marching squares (#110, #113): level lines of a scalar field sampled on a grid. Used for implicit curves
 * (F(x, y) = 0 over a graph's viewport) and for tracing the outline of typeset maths from its coverage raster.
 * Pure: no 'obsidian', no DOM.
 */

export type Pt = [number, number];
export type Polyline = Pt[];

export interface Field {
	/** Number of samples along x and y (the grid has (nx − 1) × (ny − 1) cells). */
	nx: number;
	ny: number;
	/** Value at sample (i, j), row-major: values[j * nx + i]. NaN or ±Infinity: undefined there. */
	values: ArrayLike<number>;
}

/** A segment between two points on cell edges, each edge named by the index of its first sample and its direction. */
interface Segment {
	a: Pt;
	b: Pt;
	ka: number;
	kb: number;
}

/**
 * Segments of the level line `value = level` in grid coordinates (sample (i, j) is the point (i, j)), linearly
 * interpolated along the cell edges. Saddle cells are resolved with the mean of the four corners. Cells with an
 * undefined corner are skipped. `keep(cellI, cellJ, a, b)` may reject a segment (a pole crossing, for instance).
 */
function segments(field: Field, level: number, keep?: (i: number, j: number, a: Pt, b: Pt) => boolean): Segment[] {
	const { nx, ny, values } = field;
	const out: Segment[] = [];
	// Edge keys: horizontal edge from (i, j) = 2 * (j * nx + i), vertical edge from (i, j) = 2 * (j * nx + i) + 1.
	const hKey = (i: number, j: number) => 2 * (j * nx + i);
	const vKey = (i: number, j: number) => 2 * (j * nx + i) + 1;
	for (let j = 0; j < ny - 1; j++) {
		for (let i = 0; i < nx - 1; i++) {
			const v00 = values[j * nx + i]!;
			const v10 = values[j * nx + i + 1]!;
			const v11 = values[(j + 1) * nx + i + 1]!;
			const v01 = values[(j + 1) * nx + i]!;
			if (!Number.isFinite(v00) || !Number.isFinite(v10) || !Number.isFinite(v11) || !Number.isFinite(v01)) continue;
			const c = (v00 > level ? 1 : 0) | (v10 > level ? 2 : 0) | (v11 > level ? 4 : 0) | (v01 > level ? 8 : 0);
			if (c === 0 || c === 15) continue;
			const lerp = (va: number, vb: number) => {
				const d = vb - va;
				return d === 0 ? 0.5 : Math.min(1, Math.max(0, (level - va) / d));
			};
			// Points on the four edges: top (j, between i and i+1), right, bottom, left.
			const top = (): [Pt, number] => [[i + lerp(v00, v10), j], hKey(i, j)];
			const right = (): [Pt, number] => [[i + 1, j + lerp(v10, v11)], vKey(i + 1, j)];
			const bottom = (): [Pt, number] => [[i + lerp(v01, v11), j + 1], hKey(i, j + 1)];
			const left = (): [Pt, number] => [[i, j + lerp(v00, v01)], vKey(i, j)];
			const add = (p: [Pt, number], q: [Pt, number]) => {
				if (keep && !keep(i, j, p[0], q[0])) return;
				out.push({ a: p[0], b: q[0], ka: p[1], kb: q[1] });
			};
			switch (c) {
				case 1: case 14: add(left(), top()); break;
				case 2: case 13: add(top(), right()); break;
				case 3: case 12: add(left(), right()); break;
				case 4: case 11: add(right(), bottom()); break;
				case 6: case 9: add(top(), bottom()); break;
				case 7: case 8: add(left(), bottom()); break;
				case 5: case 10: {
					// Saddle: the centre decides which corners are connected.
					const centre = (v00 + v10 + v11 + v01) / 4 > level;
					const highDiagonal = c === 5 ? centre : !centre;
					if (highDiagonal) {
						add(left(), bottom());
						add(top(), right());
					} else {
						add(left(), top());
						add(right(), bottom());
					}
					break;
				}
			}
		}
	}
	return out;
}

/**
 * Joins segments that share an edge point into polylines. A closed loop ends with its first point repeated.
 */
function link(segs: Segment[]): Polyline[] {
	const byKey = new Map<number, number[]>();
	const add = (k: number, s: number) => {
		const list = byKey.get(k);
		if (list) list.push(s);
		else byKey.set(k, [s]);
	};
	segs.forEach((s, i) => {
		add(s.ka, i);
		add(s.kb, i);
	});
	const used = new Uint8Array(segs.length);
	const next = (key: number, from: number): number => {
		for (const s of byKey.get(key) ?? []) if (s !== from && !used[s]) return s;
		return -1;
	};
	const out: Polyline[] = [];
	for (let start = 0; start < segs.length; start++) {
		if (used[start]) continue;
		used[start] = 1;
		const s0 = segs[start]!;
		// Walk forward from b, then backward from a.
		const forward: Pt[] = [s0.a, s0.b];
		let key = s0.kb;
		let prev = start;
		for (;;) {
			const n = next(key, prev);
			if (n < 0) break;
			used[n] = 1;
			const s = segs[n]!;
			if (s.ka === key) {
				forward.push(s.b);
				key = s.kb;
			} else {
				forward.push(s.a);
				key = s.ka;
			}
			prev = n;
		}
		if (key === s0.ka) {
			out.push(forward);
			continue;
		}
		const backward: Pt[] = [];
		key = s0.ka;
		prev = start;
		for (;;) {
			const n = next(key, prev);
			if (n < 0) break;
			used[n] = 1;
			const s = segs[n]!;
			if (s.ka === key) {
				backward.push(s.b);
				key = s.kb;
			} else {
				backward.push(s.a);
				key = s.ka;
			}
			prev = n;
		}
		out.push([...backward.reverse(), ...forward]);
	}
	return out;
}

/** Level lines of `field` at `level`, in grid coordinates, as polylines (closed ones repeat their first point). */
export function contours(field: Field, level = 0, keep?: (i: number, j: number, a: Pt, b: Pt) => boolean): Polyline[] {
	return link(segments(field, level, keep));
}

/** Perpendicular distance from p to the line through a and b. */
function distance(p: Pt, a: Pt, b: Pt): number {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const len = Math.hypot(dx, dy);
	if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
	return Math.abs(dx * (a[1] - p[1]) - dy * (a[0] - p[0])) / len;
}

/** Ramer–Douglas–Peucker simplification (iterative, so long lines cannot overflow the stack). */
export function simplify(line: readonly Pt[], tolerance: number): Pt[] {
	if (line.length <= 2) return line.slice();
	const keep = new Uint8Array(line.length);
	keep[0] = 1;
	keep[line.length - 1] = 1;
	const stack: Array<[number, number]> = [[0, line.length - 1]];
	while (stack.length > 0) {
		const [from, to] = stack.pop()!;
		let worst = -1;
		let at = -1;
		for (let i = from + 1; i < to; i++) {
			const d = distance(line[i]!, line[from]!, line[to]!);
			if (d > worst) {
				worst = d;
				at = i;
			}
		}
		if (at >= 0 && worst > tolerance) {
			keep[at] = 1;
			stack.push([from, at], [at, to]);
		}
	}
	return line.filter((_, i) => keep[i] === 1);
}
