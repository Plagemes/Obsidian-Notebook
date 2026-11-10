import { t } from "../i18n";
import {
	bucketInsertIndex, bucketStroke, bucketWindow, isBucketFill, maskFromAlpha, paintBucket, type BucketFailure, type BucketWindow,
} from "../ink/paint-bucket";
import { strokeSvgPath } from "../ink/stroke-shape";
import { createId } from "../model/document";
import type { Page, Stroke } from "../model/types";

/** The page under a screen point and what the bucket needs of it. */
export interface BucketTarget {
	page: Page;
	pageIndex: number;
	/** The ink in view on the page (hidden ink, collapsed note ink and the like already left out). */
	ink: readonly Stroke[];
	/** Page coordinates (pt). */
	x: number;
	y: number;
}

export interface PaintBucketHost {
	/** The page area: the next contact on it (its canvases) is the tap. */
	stage: HTMLElement;
	editable(): boolean;
	/** The tool in hand: another one ends the mode. */
	tool(): string;
	notify(text: string): void;
	target(clientX: number, clientY: number): BucketTarget | null;
	/** The colour of the fill: the colour of the pen in hand, a tint (or solid) and the pen's opacity. */
	look(): { colour: string; tint: boolean; opacity: number | undefined };
	/** Adds the fill to the page as one History step; false when the step was refused. */
	add(target: BucketTarget, stroke: Stroke, index: number): boolean;
}

/** The ink is drawn into the mask for at most this long (ms); a page with more ink than that is "too busy". */
const RASTER_BUDGET_MS = 1500;

const MESSAGES: Readonly<Record<BucketFailure, "bucket.open" | "bucket.onInk" | "bucket.tooSmall" | "bucket.tooBig" | "bucket.busy">> = {
	open: "bucket.open",
	onInk: "bucket.onInk",
	tooSmall: "bucket.tooSmall",
	tooBig: "bucket.tooBig",
	busy: "bucket.busy",
};

/**
 * The paint bucket (0.28, #184) of one notebook view. Armed by the registry action `paint-bucket`; the next contact on the page is the tap, like the
 * page eyedropper (window capture phase, so nothing is drawn; a contact on the toolbar or a panel ends the mode instead). The ink of the page is drawn
 * into a low resolution mask, `ink/paint-bucket.ts` finds the enclosed area under the tap and traces it, and the area goes onto the page as a filled
 * shape stroke at the back of the page's ink: vector, one undo step.
 */
export class PaintBucket {
	private armedNow = false;
	private toolAtArm = "";
	private contact: { id: number; x: number; y: number } | null = null;

	constructor(private readonly host: PaintBucketHost) {}

	get armed(): boolean {
		return this.armedNow;
	}

	arm(): void {
		if (!this.host.editable()) return;
		this.cancel();
		this.armedNow = true;
		this.toolAtArm = this.host.tool();
		this.host.notify(t("bucket.hint"));
		window.addEventListener("pointerdown", this.onDown, true);
		window.addEventListener("keydown", this.onKey, true);
	}

	cancel(): void {
		window.removeEventListener("pointerdown", this.onDown, true);
		window.removeEventListener("keydown", this.onKey, true);
		this.removeContactListeners();
		this.contact = null;
		this.armedNow = false;
	}

	/** The toolbar changed: another tool in hand drops the mode. */
	noteTool(tool: string): void {
		if (this.armedNow && tool !== this.toolAtArm) this.cancel();
	}

	destroy(): void {
		this.cancel();
	}

	private readonly onKey = (e: KeyboardEvent): void => {
		if (e.key !== "Escape") return;
		e.preventDefault();
		e.stopPropagation();
		this.cancel();
	};

	private isPage(target: EventTarget | null): boolean {
		const el = target as HTMLElement | null;
		if (!el || !this.host.stage.contains(el)) return false;
		return el === this.host.stage || el.tagName === "CANVAS";
	}

	private readonly onDown = (e: PointerEvent): void => {
		if (this.contact) {
			stop(e);
			return;
		}
		if (!this.isPage(e.target)) {
			this.cancel(); // the toolbar or a panel: the mode ends and the control works as usual
			return;
		}
		stop(e);
		this.contact = { id: e.pointerId, x: e.clientX, y: e.clientY };
		for (const type of ["pointermove", "pointerrawupdate", "pointerup", "pointercancel"]) window.addEventListener(type, this.onContact, true);
	};

	private readonly onContact = (ev: Event): void => {
		const e = ev as PointerEvent;
		const c = this.contact;
		if (!c || e.pointerId !== c.id) return;
		stop(e);
		if (e.type === "pointercancel") {
			this.endContact();
			return;
		}
		c.x = e.clientX;
		c.y = e.clientY;
		if (e.type === "pointerup") {
			this.endContact();
			this.fillAt(c.x, c.y);
		}
	};

	private removeContactListeners(): void {
		for (const type of ["pointermove", "pointerrawupdate", "pointerup", "pointercancel"]) window.removeEventListener(type, this.onContact, true);
	}

	private endContact(): void {
		this.removeContactListeners();
		this.contact = null;
	}

	private fillAt(clientX: number, clientY: number): void {
		try {
			const target = this.host.target(clientX, clientY);
			if (!target) {
				this.host.notify(t("bucket.noPage"));
				return;
			}
			const win = bucketWindow(target.page.width, target.page.height, target.x, target.y);
			const raster = rasterise(target.ink, win);
			if (!raster) {
				this.host.notify(t("bucket.busy"));
				return;
			}
			const result = paintBucket({
				mask: raster, cols: win.cols, rows: win.rows, scale: win.scale, originX: win.x, originY: win.y, x: target.x, y: target.y,
				now: () => performance.now(),
			});
			if (!result.ok) {
				this.host.notify(t(MESSAGES[result.reason]));
				return;
			}
			const look = this.host.look();
			const stroke = bucketStroke(result.points, look.colour, look.tint, look.opacity, createId());
			// The mode ends with the fill (like the eyedropper): the next fill is armed again.
			this.cancel();
			this.host.add(target, stroke, bucketInsertIndex(target.page.strokes));
		} catch (e) {
			console.error("[notebook] paint bucket failed", e);
			this.host.notify(t("bucket.busy"));
		}
	}
}

/** The ink of the page as a mask (1 = ink) at the window's resolution, or null when drawing it takes too long. */
function rasterise(ink: readonly Stroke[], win: BucketWindow): Uint8Array | null {
	const canvas = createEl("canvas");
	canvas.width = win.cols;
	canvas.height = win.rows;
	const g = canvas.getContext("2d", { willReadFrequently: true });
	if (!g) return null;
	g.setTransform(win.scale, 0, 0, win.scale, -win.x * win.scale, -win.y * win.scale);
	g.fillStyle = "#000000";
	const started = performance.now();
	let n = 0;
	for (const stroke of ink) {
		// The wall is a line the person drew: not a translucent highlight, and not the fill of an earlier bucket.
		if (stroke.tool === "highlighter" || isBucketFill(stroke)) continue;
		if ((++n & 63) === 0 && performance.now() - started > RASTER_BUDGET_MS) return null;
		const d = strokeSvgPath(stroke);
		if (d) g.fill(new Path2D(d));
	}
	const data = g.getImageData(0, 0, win.cols, win.rows).data;
	return maskFromAlpha(data, win.cols, win.rows);
}

function stop(e: Event): void {
	e.stopPropagation();
	e.preventDefault();
}
