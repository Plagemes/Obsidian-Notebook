import { createId, quantizePoint } from "./document";
import { A4_HEIGHT, A4_WIDTH, DEFAULT_META, FORMAT_ID, GRID_5MM, RENDER_FREEHAND } from "./types";

export type RawObject = Record<string, unknown>;

/** Migrates a document from version N to N+1. Input is not validated yet: throw if it is not recognised. */
export type Migration = (raw: RawObject) => RawObject;

export class MigrationError extends Error {}

/**
 * v0: prototype format without a `version` field and a single implicit page.
 * `{ strokes: [{ points: [{ x, y, p? }], color, size }] }`
 */
function v0ToV1(raw: RawObject): RawObject {
	const strokes = raw.strokes;
	if (!Array.isArray(strokes)) throw new MigrationError("v0: missing 'strokes'");
	const now = new Date().toISOString();
	return {
		format: FORMAT_ID,
		version: 1,
		id: createId(),
		createdAt: now,
		modifiedAt: now,
		pages: [{
			id: createId(),
			width: A4_WIDTH,
			height: A4_HEIGHT,
			paper: { kind: "grid", spacing: GRID_5MM },
			strokes: strokes.map((s: unknown, i) => {
				if (typeof s !== "object" || s === null) throw new MigrationError(`v0: invalid stroke ${i}`);
				const { points, color, size } = s as RawObject;
				if (!Array.isArray(points)) throw new MigrationError(`v0: stroke ${i} has no points`);
				return {
					id: createId(),
					tool: "pen",
					color,
					width: size,
					points: points.map((pt: unknown) => {
						const { x, y, p } = (pt ?? {}) as RawObject;
						if (typeof x !== "number" || typeof y !== "number") throw new MigrationError(`v0: invalid point in stroke ${i}`);
						return quantizePoint(x, y, typeof p === "number" ? p : 0.5);
					}),
				};
			}),
		}],
	};
}

/** v2 only widens the set of tools: every valid v1 document is a valid v2 document. */
function v1ToV2(raw: RawObject): RawObject {
	return { ...raw, version: 2 };
}

/** v3 only widens the set of paper kinds (and page sizes): every valid v2 document is a valid v3 document. */
function v2ToV3(raw: RawObject): RawObject {
	return { ...raw, version: 3 };
}

/**
 * v4 adds `meta` and `assets` to the document, `background`/`elements`/`infinite` to pages (all
 * optional, so existing pages are untouched) and the "shape" tool. Every valid v3 document becomes a
 * valid v4 document with default metadata and no assets. "shape" did not exist before v4, so a
 * pre-v4 file that contains it was not written by any version of this plugin: it is rejected rather
 * than guessed at (the caller never overwrites a file it could not read).
 */
function v3ToV4(raw: RawObject): RawObject {
	if (Array.isArray(raw.pages)) {
		for (const page of raw.pages as unknown[]) {
			const strokes = (page as RawObject | null)?.strokes;
			if (!Array.isArray(strokes)) continue;
			for (const s of strokes as unknown[]) {
				if ((s as RawObject | null)?.tool === "shape") throw new MigrationError("v3: tool 'shape' exists only from v4");
			}
		}
	}
	return {
		...raw,
		version: 4,
		meta: { tags: [], favorite: DEFAULT_META.favorite, cover: DEFAULT_META.cover, bookmarks: [] },
		assets: {},
	};
}

/**
 * v5 adds the required per-stroke `render` field. Every stroke written before v5 was drawn with
 * perfect-freehand, so it becomes render 1 (RENDER_FREEHAND) and keeps rendering exactly as before.
 * Pages and strokes that are not objects are left alone: validation rejects them afterwards.
 */
function v4ToV5(raw: RawObject): RawObject {
	if (!Array.isArray(raw.pages)) return { ...raw, version: 5 };
	const isObj = (v: unknown): v is RawObject => typeof v === "object" && v !== null && !Array.isArray(v);
	const pages = (raw.pages as unknown[]).map((page) => {
		if (!isObj(page) || !Array.isArray(page.strokes)) return page;
		return { ...page, strokes: (page.strokes as unknown[]).map((s) => (isObj(s) ? { ...s, render: RENDER_FREEHAND } : s)) };
	});
	return { ...raw, version: 5, pages };
}

/** MIGRATIONS[n] takes a document from version n to n+1. */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {
	0: v0ToV1,
	1: v1ToV2,
	2: v2ToV3,
	3: v3ToV4,
	4: v4ToV5,
};

/** Version declared by the file; an object without `version` but with `strokes` is treated as v0. */
export function detectVersion(raw: RawObject): number | null {
	if (raw.version === undefined) return Array.isArray(raw.strokes) ? 0 : null;
	if (typeof raw.version === "number" && Number.isInteger(raw.version) && raw.version >= 0) return raw.version;
	return null;
}

export function migrate(raw: RawObject, from: number, to: number): RawObject {
	let data = raw;
	for (let v = from; v < to; v++) {
		const step = MIGRATIONS[v];
		if (!step) throw new MigrationError(`no migration from v${v}`);
		data = step(data);
	}
	return data;
}
