// 0.28 geosuggest (#403): the chips of the selection bar. Turns the selected strokes into the plain geometry the rules in selection-kind.ts
// read, and the answer into action ids. No 'obsidian' import; the view caches the result per selection.
import { strokeBounds } from "../ink/hit-test";
import { isLinePen, type PageElement, type Stroke } from "../model/types";
import { suggestFromGeometry, suggestionActions, type GeoStroke } from "./selection-kind";

/** At most this many points of a stroke are looked at (first and last always). */
const SAMPLE = 40;

export function geoStrokeOf(s: Stroke): GeoStroke {
	const b = strokeBounds(s);
	const n = s.points.length;
	const step = Math.max(1, Math.ceil(n / SAMPLE));
	const pts: Array<readonly [number, number]> = [];
	for (let i = 0; i < n; i += step) pts.push([s.points[i]![0], s.points[i]![1]]);
	const last = s.points[n - 1];
	if (last && (n - 1) % step !== 0) pts.push([last[0], last[1]]);
	return { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY, pts, handwriting: isLinePen(s.tool) };
}

/** The action ids to offer as chips for a selection on ONE page (empty when it holds anything but ink, or the rules find nothing). */
export function suggestForSelection(strokes: readonly Stroke[], elements: readonly PageElement[]): string[] {
	if (elements.length > 0 || strokes.length === 0) return [];
	return suggestionActions(suggestFromGeometry(strokes.map(geoStrokeOf), 0));
}
