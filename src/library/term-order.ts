/**
 * 0.23 (#416): notebooks ordered by the active term. Pure logic (no DOM, no 'obsidian').
 * A notebook belongs to a course through the timetable's existing link (`ClassEntry.notebook`: the notebook itself or a
 * course folder). A class is "in the active term" when today lies inside its `from`/`to` dates (a class without dates
 * always counts). Order: notebooks of the active term's courses (soonest next class first, then course order), then
 * notebooks of the other courses (course order), then the rest; ties and the rest keep the incoming order.
 */
import { linkCovers, nextClass, type ClassEntry, type Timetable } from "../timetable/schedule";

export function inActiveTerm(entry: ClassEntry, today: string): boolean {
	return (!entry.from || today >= entry.from) && (!entry.to || today <= entry.to);
}

const dayString = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** A term is active when some class of the timetable has no end date or has one that is dated around today. */
export function hasActiveTerm(tt: Timetable | null | undefined, now: Date): boolean {
	return !!tt && tt.entries.some((e) => inActiveTerm(e, dayString(now)) && (!!e.from || !!e.to));
}

/** True when the timetable has at least one class (the "Active term" sort is offered then). */
export function hasTimetable(tt: Timetable | null | undefined): boolean {
	return !!tt && tt.entries.length > 0;
}

interface Rank { group: 0 | 1 | 2; next: number; course: number }

function rankOf(path: string, tt: Timetable, now: Date, today: string): Rank {
	let best: Rank = { group: 2, next: Infinity, course: Infinity };
	tt.entries.forEach((e, i) => {
		if (!linkCovers(e.notebook, path)) return;
		const active = inActiveTerm(e, today);
		const group = active ? 0 : 1;
		const next = active ? (nextClass({ ...tt, entries: [e] }, now)?.start.getTime() ?? Infinity) : Infinity;
		const r: Rank = { group, next, course: i };
		if (r.group < best.group || (r.group === best.group && (r.next < best.next || (r.next === best.next && r.course < best.course)))) best = r;
	});
	return best;
}

/** Stable reorder of `items` (already in base order) by the active term. Without a timetable the order is unchanged. */
export function orderByTerm<T>(items: readonly T[], pathOf: (item: T) => string, tt: Timetable | null | undefined, now: Date): T[] {
	if (!tt || tt.entries.length === 0) return [...items];
	const today = dayString(now);
	const ranked = items.map((item, i) => ({ item, i, r: rankOf(pathOf(item), tt, now, today) }));
	ranked.sort((a, b) => a.r.group - b.r.group || (a.r.next === b.r.next ? 0 : a.r.next < b.r.next ? -1 : 1) || a.r.course - b.r.course || a.i - b.i);
	return ranked.map((x) => x.item);
}
