/**
 * Simple stand-ins for Obsidian's Lucide icons in the browser harness, so screenshots look like the real view. Drawn
 * for the harness (24 × 24, 2 px strokes); not Lucide's artwork. Unknown names fall back to two letters.
 */
const P: Record<string, string> = {
	"panel-left": "M4 4h16v16H4z M9 4v16",
	"pencil": "M4 20l1-4L16 5l3 3L8 19z M14 7l3 3",
	"highlighter": "M9 15l-3 3h-3l3-3 M9 15l8-8 3 3-8 8z M12 18l-3-3",
	"eraser": "M7 20h11 M4 15l9-9 6 6-7 7H8z M9 10l6 6",
	"lasso": "M5 10c0-3.5 3.6-6 7.5-6S20 6.5 20 10s-3.6 6-7.5 6c-1.6 0-3-.4-4.2-1 M8 14c-1 1-1.5 2.5-.5 3.5S10 19 10 21",
	"lasso-select": "M5 10c0-3.5 3.6-6 7.5-6S20 6.5 20 10 M8 14c-1 1-1.5 2.5-.5 3.5S10 19 10 21 M14 13l6 2-3 1-1 3z",
	"shapes": "M4 14h7v7H4z M17.5 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M9 3l4 7H5z",
	"type": "M5 6V4h14v2 M12 4v16 M9 20h6",
	"move-vertical": "M12 3v18 M8 7l4-4 4 4 M8 17l4 4 4-4",
	"undo": "M9 14L4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
	"redo": "M15 14l5-5-5-5 M20 9H9.5a5.5 5.5 0 0 0 0 11H13",
	"layout-grid": "M4 4h7v7H4z M13 4h7v7h-7z M13 13h7v7h-7z M4 13h7v7H4z",
	"image-plus": "M21 12v7H3V5h10 M3 16l5-5 5 5 M14 14l2-2 5 5 M18 3v6 M15 6h6",
	"image": "M3 5h18v14H3z M3 16l5-5 5 5 M14 14l2-2 5 5 M15.5 8.5h.01",
	"stamp": "M5 21h14 M6 17h12v-3H6z M10 14V10a2 2 0 1 1 4 0v4 M9 6a3 3 0 1 1 6 0",
	"camera": "M3 8h4l2-3h6l2 3h4v11H3z M12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
	"file-plus": "M14 3H6v18h12V7z M14 3v4h4 M12 11v6 M9 14h6",
	"file-plus-2": "M14 3H6v18h12V7z M14 3v4h4 M9 15h6 M12 12v6",
	"file-input": "M14 3H6v18h12V7z M14 3v4h4 M3 14h9 M9 11l3 3-3 3",
	"file-output": "M14 3H6v18h12V7z M14 3v4h4 M9 14h12 M18 11l3 3-3 3",
	"file-down": "M14 3H6v18h12V7z M14 3v4h4 M12 11v7 M9 15l3 3 3-3",
	"file-text": "M14 3H6v18h12V7z M14 3v4h4 M9 12h6 M9 16h6",
	"file-search": "M14 3H6v18h6 M14 3v4h4v4 M17 19.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M19 19l2 2",
	"file-symlink": "M14 3H6v18h12V7z M14 3v4h4 M9 17l4-4 M10 13h3v3",
	"ruler": "M3 16L16 3l5 5L8 21z M7 12l2 2 M10 9l2 2 M13 6l2 2",
	"pen-tool": "M12 19l7-7 3 3-7 7z M18 13l-1.5-7.5L2 2l3.5 14.5L13 18z M2 2l7.6 7.6 M11 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
	"move-horizontal": "M3 12h18 M7 8l-4 4 4 4 M17 8l4 4-4 4",
	"search": "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M21 21l-5-5",
	"eye-off": "M3 3l18 18 M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-2.4 3 M6.6 6.6C4 8.3 3 12 3 12s4 6 9 6c1.7 0 3.2-.6 4.4-1.4",
	"sun-dim": "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M12 3v1 M12 20v1 M3 12h1 M20 12h1 M5.6 5.6l.7.7 M17.7 17.7l.7.7 M5.6 18.4l.7-.7 M17.7 6.3l.7-.7",
	"columns-2": "M4 4h16v16H4z M12 4v16",
	"link": "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
	"panel-right-close": "M4 4h16v16H4z M15 4v16 M8 9l3 3-3 3",
	"graduation-cap": "M2 9l10-5 10 5-10 5z M6 11v5c3 2 9 2 12 0v-5 M22 9v6",
	"copy": "M8 8h12v12H8z M4 16V4h12",
	"copy-plus": "M8 8h12v12H8z M4 16V4h12 M14 11v6 M11 14h6",
	"scissors": "M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M20 4L8.1 15.9 M14.5 14.5L20 20 M8.1 8.1L12 12",
	"clipboard-paste": "M9 4h6v3H9z M15 5h3v15H6V5h3 M12 10v7 M9 14l3 3 3-3",
	"trash-2": "M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3",
	"chevron-down": "M6 9l6 6 6-6",
	"chevron-up": "M6 15l6-6 6 6",
	"x": "M6 6l12 12 M18 6L6 18",
	"minus": "M5 12h14",
	"plus": "M12 5v14 M5 12h14",
	"arrow-up-right": "M7 17L17 7 M8 7h9v9",
	"arrow-up": "M12 19V5 M5 12l7-7 7 7",
	"arrow-down": "M12 5v14 M5 12l7 7 7-7",
	"square": "M4 4h16v16H4z",
	"square-dashed": "M4 4h3 M10 4h4 M17 4h3v3 M20 10v4 M20 17v3h-3 M14 20h-4 M7 20H4v-3 M4 14v-4",
	"circle": "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
	"star": "M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z",
	"bookmark": "M6 3h12v18l-6-4-6 4z",
	"bookmark-plus": "M6 3h12v18l-6-4-6 4z M12 7v6 M9 10h6",
	"tag": "M3 12V3h9l9 9-9 9z M7.5 7.5h.01",
	"tags": "M3 11V3h8l8 8-8 8z M7 7h.01 M15 3l7 7-7 7",
	"grid-3x3": "M4 4h16v16H4z M4 9.3h16 M4 14.7h16 M9.3 4v16 M14.7 4v16",
	"ratio": "M6 3h12v18H6z M10 7h4 M10 17h4",
	"rotate-cw": "M20 12a8 8 0 1 1-2.3-5.7L20 8 M20 3v5h-5",
	"rotate-ccw": "M4 12a8 8 0 1 0 2.3-5.7L4 8 M4 3v5h5",
	"refresh-cw": "M4 12a8 8 0 0 1 14-5.3L20 8 M20 3v5h-5 M20 12a8 8 0 0 1-14 5.3L4 16 M4 21v-5h5",
	"infinity": "M12 12c-2-3-4-4.5-6-4.5a4.5 4.5 0 0 0 0 9c2 0 4-1.5 6-4.5zm0 0c2 3 4 4.5 6 4.5a4.5 4.5 0 0 0 0-9c-2 0-4 1.5-6 4.5z",
	"folder-input": "M3 7V5h6l2 2h10v12H3v-4 M2 13h9 M8 10l3 3-3 3",
	"layout-template": "M4 4h16v6H4z M4 14h8v6H4z M16 14h4v6h-4z",
	"history": "M3 12a9 9 0 1 0 2.6-6.4L3 8 M3 3v5h5 M12 7v5l3 3",
	"archive-restore": "M3 4h18v4H3z M5 8v12h4 M19 8v12h-4 M12 20v-8 M9 15l3-3 3 3",
	"picture-in-picture": "M3 5h18v14H3z M12 12h7v5h-7z",
	"pencil-ruler": "M13 7l4-4 4 4-4 4 M3 21l1-4L15 6l3 3L7 20z M5 9L3 7l4-4 2 2",
	"scan": "M3 7V3h4 M17 3h4v4 M21 17v4h-4 M7 21H3v-4",
	"scan-line": "M3 7V3h4 M17 3h4v4 M21 17v4h-4 M7 21H3v-4 M7 12h10",
	"palette": "M12 21a9 9 0 1 1 9-9c0 2.5-2 4-4 4h-2a2 2 0 0 0-1.5 3.3c.6.7.2 1.7-1.5 1.7z M7.5 11h.01 M10.5 7.5h.01 M15 8h.01",
	"save": "M5 3h11l3 3v15H5z M8 3v5h8 M8 21v-7h8v7",
	"library": "M4 4v16 M8 4v16 M12 5l4 15 M16 4l4 15",
	"droplet": "M12 3l6 7a7 7 0 1 1-12 0z",
	"pipette": "M19 3a2.8 2.8 0 0 1 2 4.8l-3 3-4-4 3-3A2.8 2.8 0 0 1 19 3z M14 7l3 3-9 9H5v-3z",
	"check": "M5 12l5 5 9-10",
	"chevron-left": "M15 6l-6 6 6 6",
	"sparkles": "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z M19 3v4 M17 5h4",
	"sticky-note": "M4 4h16v10l-6 6H4z M14 20v-6h6",
};

const SVG_NS = "http://www.w3.org/2000/svg";

/** Draws the stand-in of icon `name` into `el` (replacing its content), as Obsidian's setIcon does. */
export function drawIcon(el: HTMLElement, name: string): boolean {
	const d = P[name];
	if (!d) return false;
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("width", "20");
	svg.setAttribute("height", "20");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "1.9");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("class", `svg-icon lucide-${name}`);
	const path = document.createElementNS(SVG_NS, "path");
	path.setAttribute("d", d);
	svg.appendChild(path);
	el.appendChild(svg);
	return true;
}
