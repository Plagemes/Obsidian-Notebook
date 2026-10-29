import {
	A4_HEIGHT, A4_WIDTH, CURRENT_VERSION, FORMAT_ID, GRID_5MM,
	type NotebookDocument, type Page, type Point, type Stroke,
} from "./types";

export function createId(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c?.randomUUID) return c.randomUUID();
	let id = "";
	for (let i = 0; i < 4; i++) id += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
	return id;
}

export function createPage(): Page {
	return {
		id: createId(),
		width: A4_WIDTH,
		height: A4_HEIGHT,
		paper: { kind: "grid", spacing: GRID_5MM },
		strokes: [],
	};
}

export function createDocument(now: Date = new Date()): NotebookDocument {
	const iso = now.toISOString();
	return {
		format: FORMAT_ID,
		version: CURRENT_VERSION,
		id: createId(),
		createdAt: iso,
		modifiedAt: iso,
		pages: [createPage()],
	};
}

/** Rounds like the file does: x/y to 0.01 pt, pressure to 0.001 within [0, 1]. */
export function quantizePoint(x: number, y: number, pressure: number): Point {
	const p = Number.isFinite(pressure) ? Math.min(1, Math.max(0, pressure)) : 0.5;
	return [Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round(p * 1000) / 1000];
}

export function createStroke(color: string, width: number, points: Point[] = []): Stroke {
	return { id: createId(), tool: "pen", color, width, points };
}

export function findPage(doc: NotebookDocument, pageId: string): Page | undefined {
	return doc.pages.find((p) => p.id === pageId);
}
