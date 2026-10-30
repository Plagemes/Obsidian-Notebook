// The seven line-art families. Each draws with fine lines (0.5–1.3 px) batched into a few paths per opacity level,
// so a 600 × 200 card is a handful of stroke calls. Pure logic: no DOM globals, no obsidian.
import { ValueNoise } from "./prng";
import { DASH_FINE, DASH_LONG, LEVELS, SOLID, levelAlpha, fillDots, scaled, strokeLine, type Painter } from "./painter";

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------------------------------------------
// branches: recursive vessels with tapering, glowing strokes (evokes the anatomy and heart references).

const MAX_DEPTH = 8;

export function drawBranches(p: Painter): void {
	const { rng, w, h, unit } = p;
	// One bucket of quadratic segments per depth: [x0, y0, cx, cy, x1, y1, …].
	const buckets: number[][] = [];
	for (let d = 0; d <= MAX_DEPTH; d++) buckets.push([]);
	const tips: number[] = [];
	const maxDepth = 4 + Math.round(p.density * 2) + (rng.chance(0.35) ? 1 : 0);
	const margin = 30 * unit;

	const grow = (x: number, y: number, angle: number, len: number, depth: number, mirrorX: number | null): void => {
		const bend = rng.range(-0.28, 0.28) * len;
		const ex = x + Math.cos(angle) * len, ey = y + Math.sin(angle) * len;
		const cx = (x + ex) / 2 - Math.sin(angle) * bend, cy = (y + ey) / 2 + Math.cos(angle) * bend;
		const b = buckets[Math.min(depth, MAX_DEPTH)]!;
		b.push(x, y, cx, cy, ex, ey);
		if (mirrorX !== null) b.push(2 * mirrorX - x, y, 2 * mirrorX - cx, cy, 2 * mirrorX - ex, ey);
		const outside = ex < p.x0 - margin || ex > w + margin || ey < -margin || ey > h + margin;
		if (depth >= maxDepth || outside || len < 4.5 * unit) {
			if (rng.chance(0.18)) {
				tips.push(ex, ey);
				if (mirrorX !== null) tips.push(2 * mirrorX - ex, ey);
			}
			return;
		}
		const children = rng.chance(0.1) ? 3 : 2;
		const spread = rng.range(0.32, 0.62);
		for (let i = 0; i < children; i++) {
			const t = i / (children - 1) - 0.5;
			grow(ex, ey, angle + t * 2 * spread + rng.range(-0.12, 0.12), len * rng.range(0.7, 0.84), depth + 1, mirrorX);
		}
	};

	if (rng.chance(0.5)) {
		// Symmetric "figure": a wavy spine with mirrored vessels on both sides, plus faint rib arcs.
		const sx = p.fx;
		let y = h + 10 * unit, x = sx;
		const spine = buckets[0]!;
		while (y > -10 * unit) {
			const ny = y - rng.range(16, 26) * unit;
			const nx = sx + rng.range(-1.5, 1.5) * unit;
			spine.push(x, y, (x + nx) / 2 + rng.range(-2, 2) * unit, (y + ny) / 2, nx, ny);
			x = nx;
			y = ny;
		}
		const pairs = scaled(5, p.density);
		for (let i = 0; i < pairs; i++) {
			const py = h * (0.1 + 0.85 * (i + rng.range(0.1, 0.9)) / pairs);
			const a = -Math.PI / 2 + rng.range(0.5, 1.45);
			grow(sx + 1.5 * unit, py, a, rng.range(18, 30) * unit, 1, sx);
		}
		const ribs = rng.int(3, 6);
		const { ctx } = p;
		ctx.beginPath();
		for (let i = 0; i < ribs; i++) {
			const ry = h * 0.32 + i * 9 * unit;
			const rx = (38 - i * 2.5) * unit;
			ctx.moveTo(sx + rx, ry + 8 * unit);
			ctx.quadraticCurveTo(sx + rx * 0.8, ry - 6 * unit, sx, ry - 2 * unit);
			ctx.quadraticCurveTo(sx - rx * 0.8, ry - 6 * unit, sx - rx, ry + 8 * unit);
		}
		strokeLine(p, 0.6, LEVELS[0] * 0.8);
	} else {
		// An organ-like node at the focus (irregular concentric outlines) with vessels running out of it.
		const { ctx } = p;
		const r = rng.range(22, 34) * unit;
		const rings = rng.int(3, 5);
		const bumps = 7;
		const phase: number[] = [];
		for (let i = 0; i < bumps; i++) phase.push(rng.range(0.82, 1.15));
		ctx.beginPath();
		for (let k = 0; k < rings; k++) {
			const rr = r * (1 - k * 0.16);
			for (let i = 0; i <= bumps; i++) {
				const a0 = (i / bumps) * TAU, a1 = ((i + 0.5) / bumps) * TAU, a2 = ((i + 1) / bumps) * TAU;
				const r0 = rr * phase[i % bumps]!, r2 = rr * phase[(i + 1) % bumps]!;
				const xA = p.fx + Math.cos(a0) * r0, yA = p.fy + Math.sin(a0) * r0 * 1.1;
				if (i === 0) ctx.moveTo(xA, yA);
				if (i === bumps) break;
				const cr = (r0 + r2) * 0.56;
				ctx.quadraticCurveTo(p.fx + Math.cos(a1) * cr, p.fy + Math.sin(a1) * cr * 1.1, p.fx + Math.cos(a2) * r2, p.fy + Math.sin(a2) * r2 * 1.1);
			}
			ctx.closePath();
		}
		strokeLine(p, 0.9, LEVELS[2], true);
		const trunks = scaled(6, p.density);
		for (let i = 0; i < trunks; i++) {
			const a = (i / trunks) * TAU + rng.range(-0.3, 0.3);
			grow(p.fx + Math.cos(a) * r, p.fy + Math.sin(a) * r * 1.1, a, rng.range(18, 30) * unit, 0, null);
		}
	}

	const { ctx } = p;
	for (let d = 0; d <= MAX_DEPTH; d++) {
		const b = buckets[d]!;
		if (b.length === 0) continue;
		ctx.beginPath();
		for (let i = 0; i + 5 < b.length; i += 6) {
			ctx.moveTo(b[i]!, b[i + 1]!);
			ctx.quadraticCurveTo(b[i + 2]!, b[i + 3]!, b[i + 4]!, b[i + 5]!);
		}
		strokeLine(p, Math.max(0.55, 1.35 * Math.pow(0.8, d)), Math.max(0.3, 0.95 - d * 0.08), d <= 1);
	}
	if (tips.length) {
		ctx.beginPath();
		for (let i = 0; i + 1 < tips.length; i += 2) {
			ctx.moveTo(tips[i]! + 1.2, tips[i + 1]!);
			ctx.arc(tips[i]!, tips[i + 1]!, 1.2, 0, TAU);
		}
		fillDots(p, 0.7);
	}
}

// ---------------------------------------------------------------------------------------------------------------
// cells: Voronoi cells (half-plane clipping on a jittered grid), drawn as rounded double outlines with nuclei.

/** Clips the convex polygon `poly` ([x, y, …]) to the half-plane closer to (sx, sy) than to (nx, ny). */
function clipToSite(poly: number[], sx: number, sy: number, nx: number, ny: number): number[] {
	const mx = (sx + nx) / 2, my = (sy + ny) / 2, dx = nx - sx, dy = ny - sy;
	const out: number[] = [];
	const n = poly.length / 2;
	for (let i = 0; i < n; i++) {
		const ax = poly[2 * i]!, ay = poly[2 * i + 1]!;
		const j = (i + 1) % n;
		const bx = poly[2 * j]!, by = poly[2 * j + 1]!;
		const da = (ax - mx) * dx + (ay - my) * dy, db = (bx - mx) * dx + (by - my) * dy;
		if (da <= 0) out.push(ax, ay);
		if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
			const t = da / (da - db);
			out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
		}
	}
	return out;
}

/** A closed smooth curve through the edge midpoints of `poly`, scaled by k towards (cx, cy). */
function roundedCell(p: Painter, poly: number[], cx: number, cy: number, k: number): void {
	const { ctx } = p;
	const n = poly.length / 2;
	if (n < 3) return;
	const X = (i: number): number => cx + (poly[2 * (i % n)]! - cx) * k;
	const Y = (i: number): number => cy + (poly[2 * (i % n) + 1]! - cy) * k;
	ctx.moveTo((X(0) + X(1)) / 2, (Y(0) + Y(1)) / 2);
	for (let i = 1; i <= n; i++) ctx.quadraticCurveTo(X(i), Y(i), (X(i) + X(i + 1)) / 2, (Y(i) + Y(i + 1)) / 2);
	ctx.closePath();
}

export function drawCells(p: Painter): void {
	const { rng, w, h, unit, ctx } = p;
	const s = (44 - 14 * p.density) * unit;
	const cols = Math.ceil((w - p.x0) / s) + 3, rows = Math.ceil(h / s) + 3;
	const ox = p.x0 - s, oy = -s;
	const sx = new Float32Array(cols * rows), sy = new Float32Array(cols * rows);
	const alive = new Uint8Array(cols * rows);
	for (let j = 0; j < rows; j++) {
		for (let i = 0; i < cols; i++) {
			const k = j * cols + i;
			sx[k] = ox + (i + 0.5 + rng.range(-0.42, 0.42)) * s;
			sy[k] = oy + (j + 0.5 + rng.range(-0.42, 0.42)) * s;
			// Dropping a few sites gives a foam of mixed cell sizes.
			alive[k] = rng.chance(0.82) ? 1 : 0;
		}
	}
	const outer: number[][] = [[], [], []];
	const cells: Array<{ poly: number[]; x: number; y: number; level: number; nucleus: boolean }> = [];
	for (let j = 0; j < rows; j++) {
		for (let i = 0; i < cols; i++) {
			const k = j * cols + i;
			if (!alive[k]) continue;
			const x = sx[k]!, y = sy[k]!;
			const R = 3 * s;
			let poly = [x - R, y - R, x + R, y - R, x + R, y + R, x - R, y + R];
			for (let dj = -3; dj <= 3 && poly.length >= 6; dj++) {
				for (let di = -3; di <= 3 && poly.length >= 6; di++) {
					if (di === 0 && dj === 0) continue;
					const ii = i + di, jj = j + dj;
					if (ii < 0 || jj < 0 || ii >= cols || jj >= rows) continue;
					const kk = jj * cols + ii;
					if (!alive[kk]) continue;
					poly = clipToSite(poly, x, y, sx[kk]!, sy[kk]!);
				}
			}
			if (poly.length < 6) continue;
			// The centroid (vertex mean is enough for these small convex cells).
			let cx = 0, cy = 0;
			for (let v = 0; v < poly.length; v += 2) {
				cx += poly[v]!;
				cy += poly[v + 1]!;
			}
			cx /= poly.length / 2;
			cy /= poly.length / 2;
			const level = rng.int(0, 2);
			cells.push({ poly, x: cx, y: cy, level, nucleus: rng.chance(0.3) });
			outer[level]!.push(cells.length - 1);
		}
	}
	for (let level = 0; level < 3; level++) {
		const list = outer[level]!;
		if (!list.length) continue;
		ctx.beginPath();
		for (const idx of list) {
			const c = cells[idx]!;
			roundedCell(p, c.poly, c.x, c.y, 0.9);
		}
		strokeLine(p, level === 2 ? 1.1 : 0.85, levelAlpha(level));
		if (level < 2) continue;
		ctx.beginPath();
		for (const idx of list) {
			const c = cells[idx]!;
			roundedCell(p, c.poly, c.x, c.y, 0.7);
		}
		strokeLine(p, 0.6, levelAlpha(level) * 0.55);
	}
	ctx.beginPath();
	for (const c of cells) {
		if (!c.nucleus) continue;
		const r = rng.range(1, 2.2) * unit;
		ctx.moveTo(c.x + r, c.y);
		ctx.arc(c.x, c.y, r, 0, TAU);
	}
	fillDots(p, 0.45);
}

// ---------------------------------------------------------------------------------------------------------------
// Shared: a fine grid, and formula-like strokes (pseudo-glyphs: an integral sign, letters, brackets, an equals sign).

function fineGrid(p: Painter, step: number, major: number, alphaMinor: number, alphaMajor: number): void {
	const { ctx, w, h } = p;
	const start = Math.floor(p.x0 / step) * step;
	ctx.beginPath();
	let n = 0;
	for (let x = start; x <= w; x += step, n++) {
		if (n % major === 0) continue;
		ctx.moveTo(x, 0);
		ctx.lineTo(x, h);
	}
	n = 0;
	for (let y = 0; y <= h; y += step, n++) {
		if (n % major === 0) continue;
		ctx.moveTo(start, y);
		ctx.lineTo(w, y);
	}
	strokeLine(p, 0.5, alphaMinor);
	ctx.beginPath();
	n = 0;
	for (let x = start; x <= w; x += step, n++) {
		if (n % major !== 0) continue;
		ctx.moveTo(x, 0);
		ctx.lineTo(x, h);
	}
	n = 0;
	for (let y = 0; y <= h; y += step, n++) {
		if (n % major !== 0) continue;
		ctx.moveTo(start, y);
		ctx.lineTo(w, y);
	}
	strokeLine(p, 0.6, alphaMajor);
}

function formula(p: Painter, x: number, y: number, size: number): void {
	const { ctx, rng } = p;
	ctx.beginPath();
	let cx = x;
	const glyphs = rng.int(4, 7);
	for (let g = 0; g < glyphs; g++) {
		const kind = g === 0 && rng.chance(0.7) ? 0 : rng.int(1, 4);
		if (kind === 0) {
			// ∫: a tall S.
			ctx.moveTo(cx + size * 0.45, y - size * 0.75);
			ctx.bezierCurveTo(cx + size * 0.1, y - size * 0.95, cx + size * 0.35, y + size * 0.6, cx - size * 0.05, y + size * 0.45);
			cx += size * 0.7;
		} else if (kind === 1) {
			// A letter: a small loop with a tail.
			const r = size * rng.range(0.18, 0.26);
			ctx.moveTo(cx + 2 * r, y - r);
			ctx.bezierCurveTo(cx - r * 0.4, y - r * 2.2, cx - r * 0.6, y + r, cx + r, y + r * 0.2);
			ctx.lineTo(cx + 2 * r + rng.range(0, r), y + r * 0.9);
			cx += size * rng.range(0.5, 0.7);
		} else if (kind === 2) {
			// ( … ): a bracket pair around a letter.
			ctx.moveTo(cx + size * 0.12, y - size * 0.45);
			ctx.quadraticCurveTo(cx - size * 0.08, y, cx + size * 0.12, y + size * 0.45);
			ctx.moveTo(cx + size * 0.5, y - size * 0.15);
			ctx.lineTo(cx + size * 0.3, y + size * 0.2);
			ctx.moveTo(cx + size * 0.62, y - size * 0.45);
			ctx.quadraticCurveTo(cx + size * 0.82, y, cx + size * 0.62, y + size * 0.45);
			cx += size;
		} else if (kind === 3) {
			// =
			ctx.moveTo(cx, y - size * 0.1);
			ctx.lineTo(cx + size * 0.4, y - size * 0.1);
			ctx.moveTo(cx, y + size * 0.1);
			ctx.lineTo(cx + size * 0.4, y + size * 0.1);
			cx += size * 0.65;
		} else {
			// A fraction: two short scribbles over a bar.
			const fw = size * rng.range(0.6, 0.9);
			ctx.moveTo(cx, y);
			ctx.lineTo(cx + fw, y);
			ctx.moveTo(cx + fw * 0.2, y - size * 0.4);
			ctx.quadraticCurveTo(cx + fw * 0.5, y - size * 0.6, cx + fw * 0.8, y - size * 0.3);
			ctx.moveTo(cx + fw * 0.25, y + size * 0.35);
			ctx.quadraticCurveTo(cx + fw * 0.5, y + size * 0.15, cx + fw * 0.75, y + size * 0.4);
			cx += fw + size * 0.25;
		}
	}
	strokeLine(p, 0.75, 0.42);
}

// ---------------------------------------------------------------------------------------------------------------
// waves: layered sine / Gaussian ribbons over a fine grid.

export function drawWaves(p: Painter): void {
	const { rng, w, h, unit, ctx } = p;
	fineGrid(p, 14 * unit, 4, 0.07, 0.13);
	const ribbons = rng.int(2, 3) + (p.density > 0.7 ? 1 : 0);
	const step = 4;
	for (let r = 0; r < ribbons; r++) {
		const gaussian = rng.chance(0.55);
		const base = h * rng.range(0.62, 0.92);
		const amp = h * rng.range(0.3, 0.62);
		const mu = rng.range(Math.max(p.x0, w * 0.45), w * 0.95);
		const sigma = rng.range(0.06, 0.16) * w;
		const k = rng.range(1.5, 4) * TAU / w;
		const phase = rng.range(0, TAU);
		const lines = scaled(5, p.density);
		const level = r === 0 ? 2 : rng.int(0, 2);
		for (let l = 0; l < lines; l++) {
			const t = lines === 1 ? 0 : l / (lines - 1);
			const a = amp * (0.55 + 0.45 * t);
			const shift = (t - 0.5) * sigma * 0.5;
			ctx.beginPath();
			for (let x = p.x0; x <= w + step; x += step) {
				const y = gaussian
					? base - a * Math.exp(-((x - mu - shift) ** 2) / (2 * sigma * sigma))
					: base - a * 0.5 * (1 + Math.sin(k * x + phase + t * 0.6)) * Math.exp(-((x - mu) ** 2) / (2 * (sigma * 2.4) ** 2));
				if (x === p.x0) ctx.moveTo(x, y);
				else ctx.lineTo(x, y);
			}
			const edge = l === lines - 1;
			strokeLine(p, edge ? 1.15 : 0.6, levelAlpha(level) * (edge ? 1 : 0.35 + 0.4 * t), edge);
		}
		if (gaussian && r === 0) {
			// Vertical hatching under the main curve (an area under a density function).
			ctx.beginPath();
			for (let x = mu - 2.2 * sigma; x <= mu + 2.2 * sigma; x += 6 * unit) {
				if (x < p.x0) continue;
				ctx.moveTo(x, base);
				ctx.lineTo(x, base - amp * Math.exp(-((x - mu) ** 2) / (2 * sigma * sigma)));
			}
			strokeLine(p, 0.5, 0.18);
		}
	}
	if (rng.chance(0.6)) formula(p, w * rng.range(0.62, 0.72), h * 0.2, 16 * unit);
}

// ---------------------------------------------------------------------------------------------------------------
// contours: topographic iso-lines of seeded fractal value noise (marching squares).

export function drawContours(p: Painter): void {
	const { rng, w, h, unit, ctx } = p;
	const noise = new ValueNoise(rng);
	const cell = 8 * unit;
	const x0 = Math.max(0, p.x0 - cell);
	const nx = Math.ceil((w - x0) / cell) + 1, ny = Math.ceil(h / cell) + 1;
	const field = new Float32Array(nx * ny);
	const freq = 1 / (h * rng.range(0.3, 0.48));
	const ox = rng.range(0, 100), oy = rng.range(0, 100);
	// A hill at the focus so the lines gather on the visible side.
	const hillR = h * rng.range(0.45, 0.8);
	for (let j = 0; j < ny; j++) {
		for (let i = 0; i < nx; i++) {
			const x = x0 + i * cell, y = j * cell;
			const d = Math.hypot(x - p.fx, y - p.fy) / hillR;
			field[j * nx + i] = noise.fbm(ox + x * freq, oy + y * freq, 3) * 0.8 + 0.25 * Math.exp(-d * d);
		}
	}
	const levels = 8 + Math.round(p.density * 7);
	// Thousands of short segments: round caps would be most of the raster cost and are invisible at this width.
	ctx.lineCap = "butt";
	for (let l = 0; l < levels; l++) {
		const iso = 0.2 + (0.8 * (l + 0.5)) / levels;
		const index = l % 4 === 3;
		ctx.beginPath();
		for (let j = 0; j + 1 < ny; j++) {
			for (let i = 0; i + 1 < nx; i++) {
				const a = field[j * nx + i]!, b = field[j * nx + i + 1]!, c = field[(j + 1) * nx + i + 1]!, d = field[(j + 1) * nx + i]!;
				const code = (a > iso ? 8 : 0) | (b > iso ? 4 : 0) | (c > iso ? 2 : 0) | (d > iso ? 1 : 0);
				if (code === 0 || code === 15) continue;
				const x = x0 + i * cell, y = j * cell;
				// Edge crossings: top (a-b), right (b-c), bottom (d-c), left (a-d).
				const tX = x + cell * ((iso - a) / (b - a)), rY = y + cell * ((iso - b) / (c - b));
				const bX = x + cell * ((iso - d) / (c - d)), lY = y + cell * ((iso - a) / (d - a));
				const seg = (x1: number, y1: number, x2: number, y2: number): void => {
					ctx.moveTo(x1, y1);
					ctx.lineTo(x2, y2);
				};
				switch (code) {
					case 1: case 14: seg(x, lY, bX, y + cell); break;
					case 2: case 13: seg(bX, y + cell, x + cell, rY); break;
					case 3: case 12: seg(x, lY, x + cell, rY); break;
					case 4: case 11: seg(tX, y, x + cell, rY); break;
					case 5: seg(x, lY, tX, y); seg(bX, y + cell, x + cell, rY); break;
					case 6: case 9: seg(tX, y, bX, y + cell); break;
					case 7: case 8: seg(x, lY, tX, y); break;
					case 10: seg(tX, y, x + cell, rY); seg(x, lY, bX, y + cell); break;
				}
			}
		}
		const level = index ? 2 : l % 2;
		strokeLine(p, index ? 1.05 : 0.6, levelAlpha(level) * (0.75 + 0.25 * (l / levels)), index && l > levels / 2);
	}
	ctx.lineCap = "round";
	// A few survey marks.
	ctx.beginPath();
	const marks = rng.int(2, 4);
	for (let m = 0; m < marks; m++) {
		const x = rng.range(Math.max(p.x0, w * 0.55), w * 0.95), y = rng.range(h * 0.15, h * 0.85), r = 2.5 * unit;
		ctx.moveTo(x - r, y);
		ctx.lineTo(x + r, y);
		ctx.moveTo(x, y - r);
		ctx.lineTo(x, y + r);
	}
	strokeLine(p, 0.7, 0.55);
}

// ---------------------------------------------------------------------------------------------------------------
// flow: streamlines of a noise flow field, evenly spaced with an occupancy grid.

export function drawFlow(p: Painter): void {
	const { rng, w, h, unit, ctx } = p;
	const noise = new ValueNoise(rng);
	const freq = 1 / (h * rng.range(0.5, 0.9));
	const turn = rng.range(1.2, 2.2) * Math.PI;
	const bias = rng.range(-Math.PI, Math.PI);
	const cs = 4 * unit;
	const gx = Math.ceil(w / cs) + 1, gy = Math.ceil(h / cs) + 1;
	const occupied = new Uint8Array(gx * gy);
	const spacing = (24 - 8 * p.density) * unit;
	const stepLen = 3.5 * unit;
	const maxSteps = 50;
	const xs = new Float32Array(maxSteps + 1), ys = new Float32Array(maxSteps + 1);
	const lines: number[][] = [[], [], []];
	for (let sy = spacing / 2; sy < h; sy += spacing) {
		for (let sx = p.x0 + spacing / 2; sx < w; sx += spacing) {
			let x = sx + rng.range(-0.4, 0.4) * spacing, y = sy + rng.range(-0.4, 0.4) * spacing;
			let n = 0;
			for (; n <= maxSteps; n++) {
				if (x < p.x0 - 10 || x > w + 10 || y < -10 || y > h + 10) break;
				const ci = Math.floor(x / cs), cj = Math.floor(y / cs);
				if (ci >= 0 && cj >= 0 && ci < gx && cj < gy && occupied[cj * gx + ci]) break;
				xs[n] = x;
				ys[n] = y;
				const a = bias + noise.fbm(x * freq, y * freq, 2) * turn;
				x += Math.cos(a) * stepLen;
				y += Math.sin(a) * stepLen;
			}
			if (n < 6) continue;
			for (let k = 0; k < n; k++) {
				const ci = Math.floor(xs[k]! / cs), cj = Math.floor(ys[k]! / cs);
				if (ci >= 0 && cj >= 0 && ci < gx && cj < gy) occupied[cj * gx + ci] = 1;
			}
			const bucket = lines[n > 40 && rng.chance(0.5) ? 2 : rng.int(0, 1)]!;
			bucket.push(n);
			for (let k = 0; k < n; k++) bucket.push(xs[k]!, ys[k]!);
		}
	}
	for (let level = 0; level < 3; level++) {
		const b = lines[level]!;
		if (!b.length) continue;
		ctx.beginPath();
		let i = 0;
		while (i < b.length) {
			const n = b[i]!;
			ctx.moveTo(b[i + 1]!, b[i + 2]!);
			for (let k = 1; k < n; k++) ctx.lineTo(b[i + 1 + 2 * k]!, b[i + 2 + 2 * k]!);
			i += 1 + 2 * n;
		}
		strokeLine(p, level === 2 ? 0.95 : 0.65, levelAlpha(level));
	}
}

// ---------------------------------------------------------------------------------------------------------------
// orbits: concentric ellipses and orbit paths with bodies, ticks and a glowing centre.

export function drawOrbits(p: Painter): void {
	const { rng, unit, ctx } = p;
	const cx = p.fx, cy = p.fy;
	const rot = rng.range(-0.4, 0.4);
	const ratio = rng.range(0.38, 0.62);
	const count = scaled(7, p.density);
	const r0 = rng.range(12, 20) * unit, dr = rng.range(13, 20) * unit;
	const bodies: number[] = [];
	for (let i = 0; i < count; i++) {
		const rx = r0 + i * dr, ry = rx * ratio;
		const level = i % 3 === 1 ? 2 : rng.int(0, 1);
		ctx.setLineDash(rng.chance(0.25) ? DASH_FINE : SOLID);
		ctx.beginPath();
		ctx.ellipse(cx, cy, rx, ry, rot, 0, TAU);
		strokeLine(p, level === 2 ? 1 : 0.65, levelAlpha(level), level === 2 && i < 3);
		if (rng.chance(0.55)) {
			const t = rng.range(0, TAU);
			const ex = Math.cos(t) * rx, ey = Math.sin(t) * ry;
			bodies.push(cx + ex * Math.cos(rot) - ey * Math.sin(rot), cy + ex * Math.sin(rot) + ey * Math.cos(rot), rng.range(1.4, 3.2) * unit);
		}
	}
	ctx.setLineDash(SOLID);
	// Two tilted transfer orbits crossing the system.
	const tilts = rng.int(1, 2);
	for (let i = 0; i < tilts; i++) {
		ctx.setLineDash(i === 0 ? SOLID : DASH_LONG);
		ctx.beginPath();
		const rx = r0 + rng.range(2, count) * dr;
		ctx.ellipse(cx + rng.range(-10, 10) * unit, cy, rx, rx * rng.range(0.2, 0.35), rot + rng.range(0.6, 1.2) * (rng.chance(0.5) ? 1 : -1), 0, TAU);
		strokeLine(p, 0.7, LEVELS[1]);
	}
	ctx.setLineDash(SOLID);
	// Ticks on the outermost orbit, like a dial.
	const outer = r0 + (count - 1) * dr + 6 * unit;
	ctx.beginPath();
	for (let k = 0; k < 72; k++) {
		const a = (k / 72) * TAU, len = (k % 6 === 0 ? 5 : 2.5) * unit;
		const ex1 = Math.cos(a) * outer, ey1 = Math.sin(a) * outer * ratio;
		const ex2 = Math.cos(a) * (outer + len), ey2 = Math.sin(a) * (outer + len) * ratio;
		ctx.moveTo(cx + ex1 * Math.cos(rot) - ey1 * Math.sin(rot), cy + ex1 * Math.sin(rot) + ey1 * Math.cos(rot));
		ctx.lineTo(cx + ex2 * Math.cos(rot) - ey2 * Math.sin(rot), cy + ex2 * Math.sin(rot) + ey2 * Math.cos(rot));
	}
	strokeLine(p, 0.5, LEVELS[0]);
	// The centre and the bodies, each with a thin halo ring.
	ctx.beginPath();
	ctx.moveTo(cx + 5 * unit, cy);
	ctx.arc(cx, cy, 5 * unit, 0, TAU);
	for (let i = 0; i + 2 < bodies.length; i += 3) {
		ctx.moveTo(bodies[i]! + bodies[i + 2]!, bodies[i + 1]!);
		ctx.arc(bodies[i]!, bodies[i + 1]!, bodies[i + 2]!, 0, TAU);
	}
	fillDots(p, 0.85);
	ctx.beginPath();
	ctx.moveTo(cx + 9 * unit, cy);
	ctx.arc(cx, cy, 9 * unit, 0, TAU);
	for (let i = 0; i + 2 < bodies.length; i += 3) {
		const r = bodies[i + 2]! * 2.2;
		ctx.moveTo(bodies[i]! + r, bodies[i + 1]!);
		ctx.arc(bodies[i]!, bodies[i + 1]!, r, 0, TAU);
	}
	strokeLine(p, 0.55, LEVELS[1], true);
}

// ---------------------------------------------------------------------------------------------------------------
// grid: graph paper, axes and plotted curves with data markers and a formula.

export function drawGrid(p: Painter): void {
	const { rng, w, h, unit, ctx } = p;
	fineGrid(p, 10 * unit, 5, 0.08, 0.16);
	const ax = Math.max(p.x0 + 20 * unit, w * rng.range(0.5, 0.6));
	const ay = h * rng.range(0.72, 0.85);
	// Axes with arrowheads and ticks.
	ctx.beginPath();
	ctx.moveTo(Math.max(p.x0, ax - 40 * unit), ay);
	ctx.lineTo(w - 8 * unit, ay);
	ctx.moveTo(w - 13 * unit, ay - 3.5 * unit);
	ctx.lineTo(w - 8 * unit, ay);
	ctx.lineTo(w - 13 * unit, ay + 3.5 * unit);
	ctx.moveTo(ax, h - 4 * unit);
	ctx.lineTo(ax, 10 * unit);
	ctx.moveTo(ax - 3.5 * unit, 15 * unit);
	ctx.lineTo(ax, 10 * unit);
	ctx.lineTo(ax + 3.5 * unit, 15 * unit);
	for (let x = ax + 20 * unit; x < w - 16 * unit; x += 20 * unit) {
		ctx.moveTo(x, ay - 2.5 * unit);
		ctx.lineTo(x, ay + 2.5 * unit);
	}
	for (let y = ay - 20 * unit; y > 18 * unit; y -= 20 * unit) {
		ctx.moveTo(ax - 2.5 * unit, y);
		ctx.lineTo(ax + 2.5 * unit, y);
	}
	strokeLine(p, 0.8, 0.6);
	// Curves: a Gaussian, a damped sine, a logistic; each one in a different weight.
	const span = w - ax;
	const curves = rng.int(1, 2) + (p.density >= 0.35 ? 1 : 0);
	const kinds = [0, 1, 2];
	for (let i = kinds.length - 1; i > 0; i--) {
		const j = rng.int(0, i);
		const t = kinds[i]!;
		kinds[i] = kinds[j]!;
		kinds[j] = t;
	}
	const markers: number[] = [];
	for (let c = 0; c < curves; c++) {
		const kind = kinds[c]!;
		const amp = (ay - 18 * unit) * rng.range(0.55, 0.95);
		const mu = ax + span * rng.range(0.3, 0.7), sigma = span * rng.range(0.1, 0.2);
		const f = (x: number): number => {
			const u = (x - ax) / span;
			if (kind === 0) return amp * Math.exp(-((x - mu) ** 2) / (2 * sigma * sigma));
			if (kind === 1) return amp * 0.5 * (1 + Math.sin(u * TAU * 2.2 + c)) * Math.exp(-u * 1.6);
			return amp / (1 + Math.exp(-(u - 0.5) * 10));
		};
		ctx.beginPath();
		const from = Math.max(p.x0, ax - 40 * unit);
		for (let x = from; x <= w; x += 3) {
			const y = ay - f(x);
			if (x === from) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		}
		const main = c === 0;
		strokeLine(p, main ? 1.25 : 0.8, main ? LEVELS[2] : LEVELS[1], main);
		if (main) {
			for (let x = ax + span * 0.08; x < w - 6 * unit; x += span * (0.15 - 0.07 * p.density)) markers.push(x, ay - f(x));
		}
	}
	ctx.beginPath();
	for (let i = 0; i + 1 < markers.length; i += 2) {
		ctx.moveTo(markers[i]! + 1.8 * unit, markers[i + 1]!);
		ctx.arc(markers[i]!, markers[i + 1]!, 1.8 * unit, 0, TAU);
	}
	fillDots(p, 0.9);
	formula(p, Math.max(p.x0 + 10 * unit, w * rng.range(0.6, 0.7)), h * 0.2, 15 * unit);
}
