import { createId, quantizePoint } from "./document";
import { A4_HEIGHT, A4_WIDTH, FORMAT_ID, GRID_5MM } from "./types";

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

/** MIGRATIONS[n] takes a document from version n to n+1. */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {
	0: v0ToV1,
	1: v1ToV2,
	2: v2ToV3,
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
