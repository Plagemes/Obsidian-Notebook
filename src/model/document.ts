import {
	CURRENT_VERSION, FORMAT_ID, PAGE_SIZES, PAPER_SPACING,
	type NotebookDocument, type Page, type Paper, type Point, type Stroke, type Tool,
} from "./types";

export function createId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
	let id = "";
	for (let i = 0; i < 4; i++) id += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
	return id;
}

export function createPage(
	size: { width: number; height: number } = PAGE_SIZES.a4,
	paper: Paper = { kind: "grid", spacing: PAPER_SPACING.grid },
): Page {
	return {
		id: createId(),
		width: size.width,
		height: size.height,
		paper: { kind: paper.kind, spacing: paper.spacing },
		strokes: [],
	};
}

export function createDocument(
	now: Date = new Date(),
	size: { width: number; height: number } = PAGE_SIZES.a4,
	paper: Paper = { kind: "grid", spacing: PAPER_SPACING.grid },
): NotebookDocument {
	const iso = now.toISOString();
	return {
		format: FORMAT_ID,
		version: CURRENT_VERSION,
		id: createId(),
		createdAt: iso,
		modifiedAt: iso,
		pages: [createPage(size, paper)],
	};
}

/** Rounds like the file does: x/y to 0.01 pt, pressure to 0.001 within [0, 1]. */
export function quantizePoint(x: number, y: number, pressure: number): Point {
	const p = Number.isFinite(pressure) ? Math.min(1, Math.max(0, pressure)) : 0.5;
	return [Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round(p * 1000) / 1000];
}

export function createStroke(color: string, width: number, points: Point[] = [], tool: Tool = "pen"): Stroke {
	return { id: createId(), tool, color, width, points };
}

export function findPage(doc: NotebookDocument, pageId: string): Page | undefined {
	return doc.pages.find((p) => p.id === pageId);
}
