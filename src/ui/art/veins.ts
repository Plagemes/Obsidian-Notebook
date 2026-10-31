// "veins": organic venation by space colonization. Pure logic: no DOM globals, no obsidian.
//
// Algorithm: Runions, Lane and Prusinkiewicz, "Modeling Trees with a Space Colonization Algorithm" (2007) and Runions et al.,
// "Modeling and visualization of leaf venation patterns" (SIGGRAPH 2005). The idea (sources attract the nearest vein node;
// a node grows one step towards the mean direction of its sources; a source dies when a node comes close) is published
// research and is not subject to a licence; this implementation is written from scratch (no code copied). The incremental
// bookkeeping (each source remembers its nearest node and only new nodes are compared with it) keeps the cost to a few
// thousand distance tests per picture.
import { fillDots, strokeLine, LEVELS, type Painter } from "./painter";

const TAU = Math.PI * 2;
const MAX_NODES = 2600;
const MAX_ITERATIONS = 170;
const MAX_SOURCES = 1150;
/** Number of line weights the vein tree is drawn in (thin to thick). */
const WEIGHTS = 4;

type Mode = "leaf" | "delta" | "radial";

export function drawVeins(p: Painter): void {
	const { rng, w, h, unit, ctx } = p;
	const mode: Mode = (["leaf", "delta", "radial"] as const)[rng.int(0, 2)]!;
	const areaW = Math.max(10, w - p.x0);

	// The region the veins fill, as a membership test plus the starting nodes.
	const cx = p.fx, cy = p.fy;
	let inside: (x: number, y: number) => boolean;
	let bbox: [number, number, number, number];
	const nodeX: number[] = [], nodeY: number[] = [], parent: number[] = [];
	const addNode = (x: number, y: number, par: number): number => {
		nodeX.push(x);
		nodeY.push(y);
		parent.push(par);
		return nodeX.length - 1;
	};
	const outline: number[] = [];
	let spacing = (9.5 - 3.8 * p.density) * unit;

	if (mode === "leaf") {
		const rot = rng.range(-0.4, 0.4);
		const rx = Math.min(areaW * 0.47, w * 0.45), ry = h * rng.range(0.38, 0.46);
		const egg = rng.range(-0.18, 0.18);
		const cos = Math.cos(rot), sin = Math.sin(rot);
		const profile = (u: number): number => Math.sqrt(Math.max(0, 1 - u * u)) * (1 + egg * u);
		inside = (x, y) => {
			const dx = x - cx, dy = y - cy;
			const u = (dx * cos + dy * sin) / rx, v = (-dx * sin + dy * cos) / ry;
			return Math.abs(u) < 1 && Math.abs(v) < profile(u) * 0.97;
		};
		bbox = [cx - rx - ry, cy - rx - ry, cx + rx + ry, cy + rx + ry];
		for (let i = 0; i <= 64; i++) {
			const a = (i / 64) * TAU;
			const u = Math.cos(a), v = Math.sin(a) * profile(u);
			outline.push(cx + u * rx * cos - v * ry * sin, cy + u * rx * sin + v * ry * cos);
		}
		// A midrib: nodes along the long axis from the stem end towards the tip.
		const rib = Math.max(2.4 * unit, spacing * 0.5);
		const dir = rng.chance(0.5) ? -1 : 1;
		let prev = -1;
		for (let s = -rx * 1.02; s < rx * 0.35; s += rib) {
			prev = addNode(cx + dir * s * cos, cy + dir * s * sin, prev);
		}
	} else if (mode === "delta") {
		const left = p.x0 + 6 * unit, right = w - 4 * unit;
		inside = (x, y) => x > left && x < right && y > 2 * unit && y < h - 2 * unit;
		bbox = [left, 0, right, h];
		const roots = rng.int(2, 4);
		for (let i = 0; i < roots; i++) {
			const x = left + (right - left) * ((i + 0.5 + rng.range(-0.25, 0.25)) / roots);
			// A short trunk so the roots read as stems.
			const base = addNode(x, h + 4 * unit, -1);
			addNode(x + rng.range(-1, 1) * unit, h - 4 * unit, base);
		}
	} else {
		const R = Math.min(areaW, h) * 0.5 * 0.94;
		inside = (x, y) => {
			const d = Math.hypot(x - cx, y - cy);
			return d < R && d > R * 0.1;
		};
		bbox = [cx - R, cy - R, cx + R, cy + R];
		const arms = rng.int(5, 9);
		const a0 = rng.range(0, TAU);
		const r0 = R * 0.1;
		const root = addNode(cx, cy, -1);
		for (let i = 0; i < arms; i++) {
			const a = a0 + (i / arms) * TAU;
			addNode(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0, root);
		}
	}

	// Sources: a jittered grid inside the region. A first pass counts the grid points that fall inside; if there are more
	// than MAX_SOURCES the spacing grows until they fit, so the cap never cuts the picture short.
	const countAt = (sp: number): number => {
		let n = 0;
		for (let y = bbox[1] + sp / 2; y < bbox[3]; y += sp) {
			for (let x = bbox[0] + sp / 2; x < bbox[2]; x += sp) if (x >= p.x0 && x <= w && y >= 0 && y <= h && inside(x, y)) n++;
		}
		return n;
	};
	for (let tries = 0; tries < 6; tries++) {
		const n = countAt(spacing);
		if (n <= MAX_SOURCES * 0.96) break;
		spacing *= Math.sqrt(n / (MAX_SOURCES * 0.9));
	}
	const step = Math.max(2.2 * unit, spacing * 0.5);
	const kill = step * 2.1, reach = step * 6;
	const sx: number[] = [], sy: number[] = [];
	for (let y = bbox[1] + spacing / 2; y < bbox[3]; y += spacing) {
		for (let x = bbox[0] + spacing / 2; x < bbox[2]; x += spacing) {
			const px = x + rng.range(-0.45, 0.45) * spacing, py = y + rng.range(-0.45, 0.45) * spacing;
			if (px < p.x0 || px > w || py < 0 || py > h || !inside(px, py)) continue;
			sx.push(px);
			sy.push(py);
		}
	}
	const nSources = sx.length;
	if (nSources === 0) return;

	// A grid over the sources for range queries.
	const gcell = reach;
	const gx = Math.ceil(w / gcell) + 2, gy = Math.ceil(h / gcell) + 2;
	const grid: number[][] = Array.from({ length: gx * gy }, () => []);
	for (let i = 0; i < nSources; i++) {
		const ci = Math.min(gx - 1, Math.max(0, Math.floor(sx[i]! / gcell))), cj = Math.min(gy - 1, Math.max(0, Math.floor(sy[i]! / gcell)));
		grid[cj * gx + ci]!.push(i);
	}
	const alive = new Uint8Array(nSources).fill(1);
	const nearest = new Int32Array(nSources).fill(-1);
	const nearestD = new Float32Array(nSources).fill(Infinity);

	// Compares the nodes from `from` on with the sources around them: kills the close ones, remembers the nearest node.
	const touch = (from: number): void => {
		for (let n = from; n < nodeX.length; n++) {
			const x = nodeX[n]!, y = nodeY[n]!;
			const ci = Math.floor(x / gcell), cj = Math.floor(y / gcell);
			for (let j = Math.max(0, cj - 1); j <= Math.min(gy - 1, cj + 1); j++) {
				for (let i = Math.max(0, ci - 1); i <= Math.min(gx - 1, ci + 1); i++) {
					for (const s of grid[j * gx + i]!) {
						if (!alive[s]) continue;
						const d = Math.hypot(sx[s]! - x, sy[s]! - y);
						if (d < kill) alive[s] = 0;
						else if (d < reach && d < nearestD[s]!) {
							nearestD[s] = d;
							nearest[s] = n;
						}
					}
				}
			}
		}
	};
	touch(0);

	const accX = new Float32Array(MAX_NODES + 64), accY = new Float32Array(MAX_NODES + 64), accN = new Uint16Array(MAX_NODES + 64);
	for (let iter = 0; iter < MAX_ITERATIONS && nodeX.length < MAX_NODES; iter++) {
		const count = nodeX.length;
		accX.fill(0, 0, count);
		accY.fill(0, 0, count);
		accN.fill(0, 0, count);
		let active = 0;
		for (let s = 0; s < nSources; s++) {
			const n = nearest[s]!;
			if (!alive[s] || n < 0) continue;
			const dx = sx[s]! - nodeX[n]!, dy = sy[s]! - nodeY[n]!;
			const d = Math.hypot(dx, dy) || 1;
			accX[n] = accX[n]! + dx / d;
			accY[n] = accY[n]! + dy / d;
			accN[n] = accN[n]! + 1;
			active++;
		}
		if (active === 0) break;
		const before = nodeX.length;
		for (let n = 0; n < count && nodeX.length < MAX_NODES; n++) {
			if (!accN[n]) continue;
			let ax = accX[n]!, ay = accY[n]!;
			if (Math.hypot(ax, ay) < 1e-3) {
				// Sources pulling in opposite directions: turn a little so the vein does not stall.
				ax = -accY[n]! + 1e-3;
				ay = accX[n]!;
			}
			const l = Math.hypot(ax, ay) || 1;
			// A touch of wobble keeps the veins organic.
			const wob = rng.range(-0.12, 0.12);
			const ux = ax / l, uy = ay / l;
			const cs = Math.cos(wob), sn = Math.sin(wob);
			addNode(nodeX[n]! + (ux * cs - uy * sn) * step, nodeY[n]! + (ux * sn + uy * cs) * step, n);
		}
		if (nodeX.length === before) break;
		touch(before);
	}

	// Pipe model: a segment's weight grows with the number of tips it feeds. Parents always precede their children.
	const total = nodeX.length;
	const feed = new Float32Array(total).fill(1);
	for (let i = total - 1; i > 0; i--) {
		const par = parent[i]!;
		if (par >= 0) feed[par] = feed[par]! + feed[i]!;
	}
	let maxFeed = 1;
	for (let i = 0; i < total; i++) if (feed[i]! > maxFeed) maxFeed = feed[i]!;
	const buckets: number[][] = Array.from({ length: WEIGHTS }, () => []);
	const hasChild = new Uint8Array(total);
	for (let i = 0; i < total; i++) {
		const par = parent[i]!;
		if (par < 0) continue;
		hasChild[par] = 1;
		const t = Math.sqrt(feed[i]! / maxFeed);
		const b = Math.min(WEIGHTS - 1, Math.floor(t * WEIGHTS * 1.35));
		buckets[b]!.push(nodeX[par]!, nodeY[par]!, nodeX[i]!, nodeY[i]!);
	}

	if (outline.length) {
		ctx.beginPath();
		ctx.moveTo(outline[0]!, outline[1]!);
		for (let i = 2; i + 1 < outline.length; i += 2) ctx.lineTo(outline[i]!, outline[i + 1]!);
		ctx.closePath();
		strokeLine(p, 0.8, LEVELS[1], true);
	}
	for (let b = 0; b < WEIGHTS; b++) {
		const seg = buckets[b]!;
		if (!seg.length) continue;
		ctx.beginPath();
		for (let i = 0; i + 3 < seg.length; i += 4) {
			ctx.moveTo(seg[i]!, seg[i + 1]!);
			ctx.lineTo(seg[i + 2]!, seg[i + 3]!);
		}
		const thick = b / (WEIGHTS - 1);
		strokeLine(p, 0.5 + 1.15 * thick, 0.38 + 0.55 * thick, b >= WEIGHTS - 2);
	}
	// Tips: small dots at some of the free ends.
	ctx.beginPath();
	let dots = 0;
	for (let i = 0; i < total && dots < 90; i++) {
		if (hasChild[i] || parent[i]! < 0 || !rng.chance(0.14)) continue;
		ctx.moveTo(nodeX[i]! + 1.1, nodeY[i]!);
		ctx.arc(nodeX[i]!, nodeY[i]!, 1.1, 0, TAU);
		dots++;
	}
	fillDots(p, 0.6);
}
