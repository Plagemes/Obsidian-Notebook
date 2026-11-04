// v13 (#241): the file form of a page's states: what the writer keeps (`normalizePageStates`) and the line it writes
// (`statesLine`). Pure, no 'obsidian'. The reader is `readPageStates` in serialize.ts (it needs the validation helpers
// of that file); model/states.ts holds the editing operations and the render-time transform.
import {
	STATES_ID_MAX, STATES_MAX_ITEMS, STATES_MAX_PARTS, STATES_MAX_ROT, STATES_MAX_SCALE, STATES_MAX_SHIFT, STATES_MAX_STATES,
	STATES_MIN_SCALE, STATES_NAME_MAX, type PageState, type PageStates, type PartPose, type StatePart,
} from "./types";

export const STATE_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const round = (v: number, digits: number): number => {
	const k = 10 ** digits;
	return Math.round(v * k) / k;
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** A name as the file keeps it: trimmed, at most STATES_NAME_MAX characters; undefined when nothing is left. */
export function cleanStateName(v: unknown): string | undefined {
	if (typeof v !== "string") return undefined;
	const t = v.trim().slice(0, STATES_NAME_MAX).trim();
	return t.length > 0 ? t : undefined;
}

const validId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= STATES_ID_MAX;

/** Whether a pose changes nothing (a part in such a pose is where it was drawn). */
export function isIdentityPose(p: Omit<PartPose, "part">): boolean {
	return (p.dx ?? 0) === 0 && (p.dy ?? 0) === 0 && (p.rot ?? 0) === 0 && (p.scale ?? 1) === 1 && !p.hidden && p.color === undefined;
}

/** A pose in canonical form (numbers rounded and bounded, defaults left out); null when it changes nothing or names no part. */
export function canonicalPose(p: PartPose): PartPose | null {
	if (!validId(p.part)) return null;
	const out: PartPose = { part: p.part };
	const num = (v: number | undefined, digits: number, lo: number, hi: number): number | undefined => {
		if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
		return round(clamp(v, lo, hi), digits);
	};
	const dx = num(p.dx, 2, -STATES_MAX_SHIFT, STATES_MAX_SHIFT);
	const dy = num(p.dy, 2, -STATES_MAX_SHIFT, STATES_MAX_SHIFT);
	const rot = num(p.rot, 2, -STATES_MAX_ROT, STATES_MAX_ROT);
	const scale = num(p.scale, 4, STATES_MIN_SCALE, STATES_MAX_SCALE);
	if (dx !== undefined && dx !== 0) out.dx = dx;
	if (dy !== undefined && dy !== 0) out.dy = dy;
	if (rot !== undefined && rot !== 0) out.rot = rot;
	if (scale !== undefined && scale !== 1) out.scale = scale;
	if (p.hidden === true) out.hidden = true;
	if (typeof p.color === "string" && STATE_COLOR_RE.test(p.color)) out.color = p.color;
	return isIdentityPose(out) ? null : out;
}

/**
 * The states of a page as the writer keeps them. `strokeIds`: the ids of the strokes of the page. Items that are not
 * strokes of the page (erased, moved to another page) leave their part, a part without a stroke goes, poses of parts
 * that are gone go, identity poses go, names are trimmed and numbers rounded and bounded, and an `active` that names no
 * state is dropped. Returns undefined when nothing is left to write. Applying it twice changes nothing.
 */
export function normalizePageStates(states: PageStates | undefined, strokeIds: ReadonlySet<string>): PageStates | undefined {
	if (!states) return undefined;
	const taken = new Set<string>();
	const partIds = new Set<string>();
	const parts: StatePart[] = [];
	for (const part of states.parts) {
		if (parts.length >= STATES_MAX_PARTS) break;
		if (!validId(part.id) || partIds.has(part.id)) continue;
		const items: string[] = [];
		for (const id of part.items) {
			if (items.length >= STATES_MAX_ITEMS) break;
			if (!strokeIds.has(id) || taken.has(id)) continue;
			taken.add(id);
			items.push(id);
		}
		if (items.length === 0) continue;
		const px = Number.isFinite(part.pivot[0]) ? round(clamp(part.pivot[0], -1e6, 1e6), 2) : 0;
		const py = Number.isFinite(part.pivot[1]) ? round(clamp(part.pivot[1], -1e6, 1e6), 2) : 0;
		const out: StatePart = { id: part.id, pivot: [px, py], items };
		const name = cleanStateName(part.name);
		if (name !== undefined) out.name = name;
		partIds.add(part.id);
		parts.push(out);
	}
	const stateIds = new Set<string>();
	const list: PageState[] = [];
	for (const st of states.list) {
		if (list.length >= STATES_MAX_STATES) break;
		if (!validId(st.id) || stateIds.has(st.id)) continue;
		const seen = new Set<string>();
		const poses: PartPose[] = [];
		for (const pose of st.poses) {
			if (!partIds.has(pose.part) || seen.has(pose.part)) continue;
			const c = canonicalPose(pose);
			if (!c) continue;
			seen.add(pose.part);
			poses.push(c);
		}
		stateIds.add(st.id);
		list.push({ id: st.id, name: cleanStateName(st.name) ?? "State", poses });
	}
	if (parts.length === 0 && list.length === 0) return undefined;
	const out: PageStates = { parts, list };
	if (states.active !== undefined && stateIds.has(states.active)) out.active = states.active;
	return out;
}

const j = (v: unknown): string => JSON.stringify(v);

function poseLine(p: PartPose): string {
	let s = `{"part":${j(p.part)}`;
	if (p.dx !== undefined) s += `,"dx":${j(p.dx)}`;
	if (p.dy !== undefined) s += `,"dy":${j(p.dy)}`;
	if (p.rot !== undefined) s += `,"rot":${j(p.rot)}`;
	if (p.scale !== undefined) s += `,"scale":${j(p.scale)}`;
	if (p.hidden) s += `,"hidden":true`;
	if (p.color !== undefined) s += `,"color":${j(p.color)}`;
	return `${s}}`;
}

/** The single line a page's (normalised) states are written as, in a fixed key order. */
export function statesLine(s: PageStates): string {
	const parts = s.parts.map((p) => `{"id":${j(p.id)}${p.name !== undefined ? `,"name":${j(p.name)}` : ""},"pivot":${j(p.pivot)},"items":${j(p.items)}}`);
	const list = s.list.map((st) => `{"id":${j(st.id)},"name":${j(st.name)},"poses":[${st.poses.map(poseLine).join(",")}]}`);
	const active = s.active !== undefined ? `,"active":${j(s.active)}` : "";
	return `{"parts":[${parts.join(",")}],"list":[${list.join(",")}]${active}}`;
}
