/**
 * Just-in-time hints (roadmap 425): the registry of tips and the rules for showing them. A tip appears the first time
 * its situation occurs and never again (the "seen" ids are stored in the plugin settings, not in a notebook), at most one
 * per `HINT_GAP_MS`, and never while the pen is writing. Pure: no 'obsidian', no DOM (tested in Node).
 */
import type { MessageKey } from "../i18n/en";

export const HINT_IDS = ["notebook-opened", "pen-detected", "radial-available", "pdf-imported", "lasso-selected", "palm-blocked", "inbox-item"] as const;
export type HintId = (typeof HINT_IDS)[number];

export interface HintDef {
	id: HintId;
	/** Lucide icon of the bubble. */
	icon: string;
	title: MessageKey;
	body: MessageKey;
}

export const HINTS: readonly HintDef[] = [
	{ id: "notebook-opened", icon: "book-open", title: "hint.notebookOpened.title", body: "hint.notebookOpened.body" },
	{ id: "pen-detected", icon: "pencil", title: "hint.penDetected.title", body: "hint.penDetected.body" },
	{ id: "radial-available", icon: "circle-dot", title: "hint.radial.title", body: "hint.radial.body" },
	{ id: "pdf-imported", icon: "file-text", title: "hint.pdfImported.title", body: "hint.pdfImported.body" },
	{ id: "lasso-selected", icon: "lasso", title: "hint.lasso.title", body: "hint.lasso.body" },
	{ id: "palm-blocked", icon: "hand", title: "hint.palm.title", body: "hint.palm.body" },
	{ id: "inbox-item", icon: "inbox", title: "hint.inbox.title", body: "hint.inbox.body" },
];

/** At most one hint per this long (per session), so tips never pile up. */
export const HINT_GAP_MS = 4 * 60_000;
/** How long a bubble stays on screen without being touched. */
export const HINT_VISIBLE_MS = 12_000;
/** The seen list is capped (a stored list longer than the registry can only be stale). */
const MAX_SEEN = 64;

export function isHintId(value: unknown): value is HintId {
	return typeof value === "string" && (HINT_IDS as readonly string[]).includes(value);
}

/** Whatever was stored, as a list of known ids without duplicates. Unknown ids are dropped (a removed tip stays quiet). */
export function normaliseSeen(data: unknown): HintId[] {
	if (!Array.isArray(data)) return [];
	const out: HintId[] = [];
	for (const v of data) if (isHintId(v) && !out.includes(v) && out.length < MAX_SEEN) out.push(v);
	return out;
}

export type HintDecision = "show" | "disabled" | "seen" | "unknown" | "writing" | "rate-limited";

export interface HintEngineDeps {
	now: () => number;
	enabled: () => boolean;
	isWriting: () => boolean;
	gapMs?: number;
}

/** The decision logic: which hint may be shown now. `shown` records it. */
export class HintEngine {
	private readonly seenIds: Set<HintId>;
	private lastShown = Number.NEGATIVE_INFINITY;

	constructor(private readonly deps: HintEngineDeps, seen: readonly HintId[] = []) {
		this.seenIds = new Set(seen);
	}

	/** The ids to store. */
	get seen(): HintId[] {
		return [...this.seenIds];
	}

	decide(id: string): HintDecision {
		if (!isHintId(id)) return "unknown";
		if (!this.deps.enabled()) return "disabled";
		if (this.seenIds.has(id)) return "seen";
		if (this.deps.isWriting()) return "writing";
		if (this.deps.now() - this.lastShown < (this.deps.gapMs ?? HINT_GAP_MS)) return "rate-limited";
		return "show";
	}

	/** The hint is on screen: it will not come back, and the next one waits for the gap. */
	shown(id: HintId): void {
		this.seenIds.add(id);
		this.lastShown = this.deps.now();
	}

	/** "Show tips again": every hint can come back (the gap restarts from now). */
	reset(): void {
		this.seenIds.clear();
		this.lastShown = Number.NEGATIVE_INFINITY;
	}
}
