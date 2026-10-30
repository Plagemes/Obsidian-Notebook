// The glossy filled folder icon of the reference designs (DESIGN.md §2.6), as inline SVG markup. Pure logic.
import { darken, hex, hexOf, lighten, rgbOf } from "./art-colour";

const cache = new Map<string, string>();

/**
 * Inline SVG of the folder in `color`: a back panel with a tab, a front flap with a top-light gradient, a highlight
 * along its top edge, a soft gloss and a darker base. Drawn on a 64 × 52 grid; `size` is the rendered width in CSS px
 * (the height is size × 52 / 64). Gradient ids derive from the colour, so several icons on one page never clash
 * (two icons of the same colour share identical definitions).
 */
export function folderIconSvg(color: string, size = 56): string {
	const base = hexOf(color);
	const width = Math.max(8, Math.round(size));
	const key = `${base}|${width}`;
	const hit = cache.get(key);
	if (hit) return hit;
	const c = rgbOf(base);
	const id = `nbf-${base.slice(1)}`;
	const backTop = hex(darken(c, 0.12)), backBottom = hex(darken(c, 0.34));
	const frontTop = hex(lighten(c, 0.3)), frontMid = hex(c), frontBottom = hex(darken(c, 0.1));
	const height = Math.round((width * 52) / 64);
	const front = "M4 20.5Q4 16.5 8 16.5H56Q60 16.5 60 20.5V44Q60 48 56 48H8Q4 48 4 44Z";
	const svg =
		`<svg class="notebook-folder-icon" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 64 52" aria-hidden="true" focusable="false">` +
		`<defs>` +
		`<linearGradient id="${id}-b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${backTop}"/><stop offset="1" stop-color="${backBottom}"/></linearGradient>` +
		`<linearGradient id="${id}-f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${frontTop}"/><stop offset="0.5" stop-color="${frontMid}"/><stop offset="1" stop-color="${frontBottom}"/></linearGradient>` +
		`<linearGradient id="${id}-g" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.32"/><stop offset="0.55" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
		`<linearGradient id="${id}-d" x1="0" y1="0" x2="0" y2="1"><stop offset="0.7" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.2"/></linearGradient>` +
		`<radialGradient id="${id}-s" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#000" stop-opacity="0.35"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>` +
		`</defs>` +
		`<ellipse cx="32" cy="49" rx="28" ry="3" fill="url(#${id}-s)"/>` +
		`<path d="M4 9Q4 5 8 5H22.5Q25 5 26.6 6.9L29.6 10.5H56Q60 10.5 60 14.5V44Q60 48 56 48H8Q4 48 4 44Z" fill="url(#${id}-b)"/>` +
		`<path d="M8.5 13.5H55.5V30H8.5Z" fill="#fff" fill-opacity="0.16"/>` +
		`<path d="${front}" fill="url(#${id}-f)"/>` +
		`<path d="${front}" fill="url(#${id}-g)"/>` +
		`<path d="${front}" fill="url(#${id}-d)"/>` +
		`<path d="M7.5 17.4H56.5" stroke="#fff" stroke-opacity="0.55" stroke-width="0.8" stroke-linecap="round"/>` +
		`</svg>`;
	if (cache.size > 64) cache.clear();
	cache.set(key, svg);
	return svg;
}
