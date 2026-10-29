/**
 * White to transparent (pure, on RGBA pixels). Pasted screenshots and typed or printed pictures come on a white
 * rectangle; with the white removed they blend with the paper. The result is stored as a NEW image asset (the
 * document format is not touched), so undo simply points the element back to the old asset.
 */

/** Pixels whose darkest channel is at or above this are fully transparent. */
export const WHITE_CUT = 248;
/** Pixels whose darkest channel is at or below this are fully opaque; between the two the alpha ramps linearly. */
export const WHITE_KEEP = 214;

/** Alpha (0-255) for a pixel whose darkest colour channel is `min`; never raises an alpha that is already lower. */
export function alphaForMin(min: number, alpha = 255): number {
	if (min >= WHITE_CUT) return 0;
	if (min <= WHITE_KEEP) return alpha;
	const k = (WHITE_CUT - min) / (WHITE_CUT - WHITE_KEEP);
	return Math.min(alpha, Math.round(255 * k));
}

/**
 * Makes near-white pixels transparent, in place, and returns how many pixels became (at least partly) transparent.
 * The colour of kept pixels is not changed. `data` is RGBA, like `ImageData.data`.
 */
export function whiteToTransparent(data: Uint8ClampedArray): number {
	let changed = 0;
	for (let i = 0; i + 3 < data.length; i += 4) {
		const r = data[i]!;
		const g = data[i + 1]!;
		const b = data[i + 2]!;
		const a = data[i + 3]!;
		const next = alphaForMin(Math.min(r, g, b), a);
		if (next !== a) {
			data[i + 3] = next;
			changed++;
		}
	}
	return changed;
}
