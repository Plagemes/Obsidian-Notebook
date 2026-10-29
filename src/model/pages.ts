import { createId } from "./document";
import { freezeStroke } from "./serialize";
import type { Page } from "./types";

/**
 * Copy of a page for "duplicate page": new page id and new stroke ids, same size, paper and
 * stroke content. Points are copied (not shared) and strokes are frozen like committed ones.
 * Lives apart from document.ts because serialize.ts -> migrations.ts -> document.ts would cycle.
 */
export function duplicatePage(page: Page): Page {
	return {
		id: createId(),
		width: page.width,
		height: page.height,
		paper: { kind: page.paper.kind, spacing: page.paper.spacing },
		strokes: page.strokes.map((s) => freezeStroke({
			id: createId(),
			tool: s.tool,
			color: s.color,
			width: s.width,
			points: s.points.map((p) => [p[0], p[1], p[2]] as [number, number, number]),
		})),
	};
}
