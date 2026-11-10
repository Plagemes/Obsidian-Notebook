import type { MessageKey } from "../i18n";
import { countNumbers, type ChartData, type ChartKind } from "../math/chart-layout";

/**
 * What the "Chart from table" dialog says about the numbers it read (0.29, #244). Pure: no 'obsidian', so the tests reach it.
 * The lines under the picture, as message keys, most important first: nothing to show; cells left out; columns left out; what a pie shows.
 */
export function readNotes(data: ChartData, kind: ChartKind): MessageKey[] {
	if (countNumbers(data, kind) === 0) return ["chart.read.none"];
	const notes: MessageKey[] = [];
	if (data.skipped > 0) notes.push("chart.read.skipped");
	if (data.droppedSeries > 0 && kind !== "pie") notes.push("chart.read.dropped");
	if (kind === "pie" && data.series.length > 1) notes.push("chart.read.pie");
	return notes;
}
