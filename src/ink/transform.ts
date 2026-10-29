/** 2D affine matrix [a, b, c, d, e, f], same convention as Canvas setTransform: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `multiply(m, n)` applies n first, then m. */
export function multiply(m: Matrix, n: Matrix): Matrix {
	return [
		m[0] * n[0] + m[2] * n[1],
		m[1] * n[0] + m[3] * n[1],
		m[0] * n[2] + m[2] * n[3],
		m[1] * n[2] + m[3] * n[3],
		m[0] * n[4] + m[2] * n[5] + m[4],
		m[1] * n[4] + m[3] * n[5] + m[5],
	];
}

export function translate(dx: number, dy: number): Matrix {
	return [1, 0, 0, 1, dx, dy];
}

export function scaleAbout(sx: number, sy: number, cx: number, cy: number): Matrix {
	return [sx, 0, 0, sy, cx - sx * cx, cy - sy * cy];
}

export function rotateAbout(angle: number, cx: number, cy: number): Matrix {
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	return [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
	return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Uniform scale factor of the matrix (geometric mean of the axis scales), used to scale stroke widths. */
export function scaleFactor(m: Matrix): number {
	return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

export function isIdentity(m: Matrix, eps = 1e-9): boolean {
	return m.every((v, i) => Math.abs(v - IDENTITY[i]!) < eps);
}

/** Inverse matrix; identity for a degenerate (non-invertible) matrix. */
export function invert(m: Matrix): Matrix {
	const det = m[0] * m[3] - m[1] * m[2];
	if (Math.abs(det) < 1e-12) return IDENTITY;
	const [a, b, c, d, e, f] = m;
	return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
