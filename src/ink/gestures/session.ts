import { dist, type Pt, type TrailPoint } from "./geometry";

/** Samples closer than this to the last kept one are not kept (the trail is for recognition and display, not for ink). */
export const TRAIL_MIN_STEP_PX = 1.5;
/** The trail never holds more than this many samples (a very long scribble keeps its most recent part). */
export const TRAIL_MAX_POINTS = 1500;
/** The preview is recomputed at most this often, ms. */
export const PREVIEW_INTERVAL_MS = 70;

/** The stroke of a gesture in progress, in CSS px relative to the stage. */
export class GestureTrail {
	readonly points: TrailPoint[] = [];
	/** Time of the first sample. */
	t0 = 0;
	private version = 0;

	reset(): void {
		this.points.length = 0;
		this.t0 = 0;
		this.version++;
	}

	add(x: number, y: number, t: number, p?: number): void {
		if (this.points.length === 0) this.t0 = t;
		const last = this.points[this.points.length - 1];
		const point: TrailPoint = p === undefined ? { x, y, t } : { x, y, t, p };
		if (last && dist(last, point) < TRAIL_MIN_STEP_PX) {
			// The newest position still counts as the tip of the line.
			this.points[this.points.length - 1] = point;
			return;
		}
		this.points.push(point);
		if (this.points.length > TRAIL_MAX_POINTS) this.points.splice(0, this.points.length - TRAIL_MAX_POINTS);
		this.version++;
	}

	get tip(): Pt | null {
		return this.points[this.points.length - 1] ?? null;
	}

	/** Changes whenever points were added or removed. */
	get revision(): number {
		return this.version;
	}

	get durationMs(): number {
		const last = this.points[this.points.length - 1];
		return last ? Math.max(0, last.t - this.t0) : 0;
	}
}

/** Decides when the preview has to be recomputed: the trail changed and enough time passed since the last time. */
export class PreviewClock {
	private lastAt = -Infinity;
	private lastRevision = -1;

	reset(): void {
		this.lastAt = -Infinity;
		this.lastRevision = -1;
	}

	due(now: number, revision: number, force = false): boolean {
		if (!force && (revision === this.lastRevision || now - this.lastAt < PREVIEW_INTERVAL_MS)) return false;
		this.lastAt = now;
		this.lastRevision = revision;
		return true;
	}
}
