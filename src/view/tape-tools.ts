/**
 * Study tape in the notebook view (0.29, roadmap #10, format v27). Self-contained: the view forwards pen gestures and owns nothing of this
 * but a `TapeTools` instance. The model is `model/tape.ts`, the look `ink/tape-render.ts`.
 *
 * - "Study tape" is a mode (the action of the same name, a command, the All actions sheet): while it is on, a drag on a page with the pen,
 *   the mouse or a finger that draws lays a tape (one undo step), a tap on a tape reveals or hides it. Choosing a tool in the toolbar, read-only
 *   mode or running the action again turns it off.
 * - Whatever the mode, a tap on a tape reveals it or hides it again: with the pen or the highlighter in hand (a contact that starts on a hidden
 *   tape is taken whole, so no ink goes where nobody can see it; on a revealed tape the contact is ink unless it was a tap), with a finger that
 *   pans, and with anything on a read-only notebook. Revealing is view-only (`TapeReveal`): never saved, never an undo step, reset when the
 *   notebook is opened again. "Reveal all" and "Hide all" work on the same state.
 */
import { t } from "../i18n";
import { AddElement, type Command } from "../model/history";
import { createTape, hidingTapes, tapeAt, tapeCounts, TapeReveal } from "../model/tape";
import type { NotebookDocument, Page, TapeElement } from "../model/types";
import { showNotice } from "./notice";

/** What the view gives the tape tools. */
export interface TapeHost {
	stage(): HTMLElement;
	doc(): NotebookDocument | null;
	/** The document can be edited now (not read-only, not being drawn on). */
	editable(): boolean;
	/** Runs a command as one undo step (false when it was refused: a locked page, a read-only notebook). */
	execute(cmd: Command): boolean;
	/** The colour of a new tape (the setting). */
	color(): string;
	/** CSS px per pt. */
	scale(): number;
	/** The page and page-local point under a client position; null off the pages. */
	pageAt(clientX: number, clientY: number): { pageIndex: number; local: [number, number] } | null;
	/** A finger contact pans (it does not draw). */
	fingerNavigates(e: PointerEvent): boolean;
	/** The pen is down, or was active within the palm rejection time at `t`: a finger contact then is a palm. */
	penBusy(t: number): boolean;
	/** Shows (or clears) the tape being dragged. */
	preview(pageIndex: number, tape: TapeElement | null): void;
	/** Redraws the pages (a tape was revealed or hidden) and the UI (the actions' state). */
	repaint(): void;
}

/** Contact moved further than this (CSS px): a drag, not a tap. */
const TAP_SLOP_PX = 8;
/** Longest contact that still counts as a tap, ms. */
const TAP_MS = 500;
/** A finger or a pen on a read-only notebook that moves farther than this (CSS px) or stays longer (ms) is not tapping. */
const POINTER_SLOP = 10;
const POINTER_MS = 450;

interface Gesture {
	/** "draw": a tape being dragged (the mode is on); "tap": a contact that started on a hidden tape (a tap reveals it). */
	mode: "draw" | "tap";
	pageIndex: number;
	pageId: string;
	start: [number, number];
	end: [number, number];
	sx: number;
	sy: number;
	t: number;
	moved: boolean;
	target: TapeElement | null;
}

/** A contact that started on a revealed tape: a tap if it lifts soon without moving (it hides the tape), otherwise ordinary ink. */
interface Contact {
	pageId: string;
	target: TapeElement;
	sx: number;
	sy: number;
	t: number;
}

export class TapeTools {
	/** Which tapes are revealed in this view (view-only). The renderer reads it. */
	readonly reveal = new TapeReveal();
	/** The "Study tape" mode is on: a drag lays a tape. */
	drawing = false;
	private gesture: Gesture | null = null;
	private contact: Contact | null = null;
	private pointer: { id: number; x: number; y: number; t: number } | null = null;
	private readonly off: Array<() => void> = [];

	constructor(private readonly host: TapeHost) {
		const stage = host.stage();
		this.listen(stage, "pointerdown", (e) => this.onPointerDown(e as PointerEvent), true);
		this.listen(stage, "pointerup", (e) => this.onPointerUp(e as PointerEvent));
		this.listen(stage, "pointercancel", () => (this.pointer = null));
	}

	private listen(el: HTMLElement, type: string, fn: (e: Event) => void, capture = false): void {
		el.addEventListener(type, fn, capture);
		this.off.push(() => el.removeEventListener(type, fn, capture));
	}

	destroy(): void {
		for (const f of this.off.splice(0)) f();
		this.gesture = null;
		this.contact = null;
	}

	/** Page of the gesture in progress, or null when no contact is ours. */
	get gesturePage(): number | null {
		return this.gesture?.pageIndex ?? null;
	}

	// ------------------------------------------------------------------ the mode and the actions

	/** Turns the "Study tape" mode on or off (on only when the notebook can be edited). */
	toggleDrawing(): void {
		if (this.drawing) {
			this.stopDrawing();
			showNotice(t("tape.mode.off"));
		} else {
			if (!this.host.editable()) return;
			this.drawing = true;
			showNotice(t("tape.mode.on"));
		}
		this.host.repaint();
	}

	/** Turns the mode off without a word (another tool was chosen, the notebook became read-only). */
	stopDrawing(): void {
		if (!this.drawing) return;
		this.drawing = false;
		if (this.gesture?.mode === "draw") {
			this.host.preview(this.gesture.pageIndex, null);
			this.gesture = null;
		}
	}

	/** How many tapes the notebook has and how many are revealed. */
	counts(): { total: number; revealed: number } {
		return tapeCounts(this.host.doc()?.pages ?? [], this.reveal);
	}

	/** Reveals every tape of the notebook. */
	revealAll(): void {
		const doc = this.host.doc();
		if (!doc) return;
		const all = doc.pages.flatMap((p) => hidingTapes(p, this.reveal));
		if (this.reveal.revealAll(all)) this.host.repaint();
	}

	/** Hides every tape of the notebook again. */
	hideAll(): void {
		if (this.reveal.hideAll()) this.host.repaint();
	}

	/** Reveals a hidden tape or hides a revealed one (view-only). */
	toggle(target: TapeElement): void {
		this.reveal.toggle(target.id);
		try {
			window.navigator.vibrate?.(6);
		} catch {
			// Vibration is optional.
		}
		this.host.repaint();
	}

	/** A new document was loaded: tapes that are gone are forgotten (the others keep their state). */
	docChanged(): void {
		this.reveal.prune(this.host.doc());
	}

	// ------------------------------------------------------------------ the pen

	/**
	 * Pen, mouse or finger-that-draws down at `local` on page `pageIndex`. Returns true when the contact is ours: a drag of the "Study tape"
	 * mode, or a contact that starts on a hidden tape with the pen or the highlighter in hand (nothing is written under a tape). A contact on a
	 * revealed tape is only noted (it is ink unless `takeTap` finds it was a tap).
	 */
	begin(pageIndex: number, page: Page, local: [number, number], screen: { x: number; y: number; t: number }, tool: string, locked = false): boolean {
		this.gesture = null;
		this.contact = null;
		if (!this.host.editable()) return false;
		const base = { pageIndex, pageId: page.id, start: local, end: local, sx: screen.x, sy: screen.y, t: screen.t, moved: false };
		const hit = tapeAt(page.elements ?? [], local[0], local[1]);
		// A locked page takes no new tape (the view says why); its tapes still reveal (that changes nothing in the notebook).
		if (this.drawing && !locked) {
			this.gesture = { ...base, mode: "draw", target: hit };
			return true;
		}
		if (!hit || (tool !== "pen" && tool !== "highlighter")) return false;
		if (!this.reveal.isRevealed(hit.id)) {
			this.gesture = { ...base, mode: "tap", target: hit };
			return true;
		}
		this.contact = { pageId: page.id, target: hit, sx: screen.x, sy: screen.y, t: screen.t };
		return false;
	}

	/** The contact moved (stage px, and the page point when it is ours). Returns true while the gesture is ours. */
	move(local: [number, number] | null, screen: { x: number; y: number } | null): boolean {
		const c = this.contact;
		if (c && screen && Math.hypot(screen.x - c.sx, screen.y - c.sy) > TAP_SLOP_PX) this.contact = null;
		const g = this.gesture;
		if (!g) return false;
		if (screen && Math.hypot(screen.x - g.sx, screen.y - g.sy) > TAP_SLOP_PX) g.moved = true;
		if (local) g.end = local;
		if (g.mode === "draw" && g.moved) {
			const page = this.host.doc()?.pages[g.pageIndex];
			const tape = page && page.id === g.pageId ? createTape(g.start, g.end, page, this.host.color()) : null;
			this.host.preview(g.pageIndex, tape);
		}
		return true;
	}

	/** The contact ended. Returns true when it was ours. */
	end(cancelled: boolean, now: number): boolean {
		const g = this.gesture;
		if (!g) return false;
		this.gesture = null;
		if (g.mode === "draw") this.host.preview(g.pageIndex, null);
		if (cancelled) return true;
		const page = this.host.doc()?.pages[g.pageIndex];
		// The document may have been reloaded meanwhile: never act on another page.
		if (!page || page.id !== g.pageId) return true;
		const tapped = !g.moved && now - g.t <= TAP_MS;
		if (tapped) {
			if (g.target && page.elements?.includes(g.target)) this.toggle(g.target);
			else if (g.mode === "draw") showNotice(t("tape.hint.drag"));
			return true;
		}
		if (g.mode === "draw" && g.moved && this.host.editable()) {
			const tape = createTape(g.start, g.end, page, this.host.color());
			if (tape) this.host.execute(new AddElement(page.id, tape, page.elements?.length ?? 0));
		}
		return true;
	}

	/**
	 * A contact that was ink ended: the revealed tape that was tapped (short, unmoved, not cancelled), or null. The view then drops the dot the
	 * tap would have left and calls `toggle`.
	 */
	takeTap(cancelled: boolean, now: number, extentPx: () => number): TapeElement | null {
		const c = this.contact;
		this.contact = null;
		if (!c || cancelled || now - c.t > TAP_MS || extentPx() > TAP_SLOP_PX) return null;
		const page = this.host.doc()?.pages.find((p) => p.id === c.pageId);
		return page?.elements?.includes(c.target) ? c.target : null;
	}

	// ------------------------------------------------------------------ fingers that pan, and a read-only notebook

	/** Whether this pointer is one the pen path never sees: a finger that pans, or any contact on a notebook that cannot be edited. */
	private outsidePenPath(e: PointerEvent): boolean {
		if (!this.host.editable()) return true;
		return e.pointerType === "touch" && this.host.fingerNavigates(e);
	}

	private onPointerDown(e: PointerEvent): void {
		this.pointer = null;
		if (!e.isPrimary || !this.outsidePenPath(e)) return;
		// While the pen is down or was just used, a touch is a palm resting on the page: it reveals nothing.
		if (e.pointerType === "touch" && this.host.penBusy(e.timeStamp)) return;
		this.pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp };
	}

	private onPointerUp(e: PointerEvent): void {
		const tap = this.pointer;
		this.pointer = null;
		if (!tap || tap.id !== e.pointerId || e.timeStamp - tap.t > POINTER_MS) return;
		if (e.pointerType === "touch" && this.host.penBusy(e.timeStamp)) return;
		if (Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > POINTER_SLOP) return;
		const at = this.host.pageAt(e.clientX, e.clientY);
		const page = at ? this.host.doc()?.pages[at.pageIndex] : undefined;
		if (!at || !page) return;
		// A finger is less precise than a pen: a few px around the tape still count.
		const tol = e.pointerType === "touch" ? 6 / Math.max(0.05, this.host.scale()) : 0;
		const hit = tapeAt(page.elements ?? [], at.local[0], at.local[1], tol);
		if (hit) this.toggle(hit);
	}
}
