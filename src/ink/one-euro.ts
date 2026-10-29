/**
 * Adaptive low-pass filter for pen positions (the "1€ filter", Casiez, Roussel and Vogel, CHI 2012;
 * written from the paper's description). The cutoff frequency rises with speed: when the pen is
 * almost still, a low cutoff removes tremor and digitizer jitter; when it moves, the cutoff goes up
 * and the lag behind the pen drops towards zero.
 *
 * Allocation-free: `filter()` writes the result to `x` and `y`.
 */
export interface OneEuroParams {
	/** Cutoff (Hz) when the pen is still. */
	minCutoff: number;
	/** Cutoff increase per unit of speed (Hz per CSS px/s). */
	beta: number;
	/** Cutoff (Hz) of the speed estimate. */
	dCutoff: number;
}

/**
 * Maps the "Stabilization" setting (0–10) to filter parameters; 0 (or less) turns the filter off.
 * Measured on synthetic 240 Hz input (tests/engine.test.ts): at level 2 (the default) the filter
 * removes more jitter at rest than the old exponential stabilizer at the same level, and lags
 * less at every writing speed (1.2–1.5 px at 300–1000 px/s, against 1.5–5 px); level 10 is a strong
 * stabilizer that still lags far less than the old level 10 when writing fast.
 */
export function stabilizationParams(level: number): OneEuroParams | null {
	if (!(level > 0)) return null;
	const l = Math.min(10, level);
	return { minCutoff: 20 / l, beta: 0.2 / l, dCutoff: 4 };
}

function alpha(cutoff: number, dt: number): number {
	const tau = 1 / (2 * Math.PI * cutoff);
	return 1 / (1 + tau / dt);
}

export class OneEuroFilter {
	/** Last filtered position. */
	x = 0;
	y = 0;
	private dx = 0;
	private dy = 0;
	private rawX = 0;
	private rawY = 0;
	private lastT = 0;
	private started = false;

	constructor(public params: OneEuroParams | null = null) {}

	get enabled(): boolean {
		return this.params !== null;
	}

	reset(x: number, y: number, t: number): void {
		this.x = this.rawX = x;
		this.y = this.rawY = y;
		this.dx = this.dy = 0;
		this.lastT = t;
		this.started = true;
	}

	/** `x`, `y` in CSS px, `t` in ms. */
	filter(x: number, y: number, t: number): void {
		const p = this.params;
		if (!p || !this.started) {
			this.reset(x, y, t);
			return;
		}
		// Samples with the same (or an out-of-order) timestamp: assume a 240 Hz digitizer.
		const dt = t > this.lastT ? Math.min(0.1, (t - this.lastT) / 1000) : 1 / 240;
		this.lastT = Math.max(this.lastT, t);
		const ad = alpha(p.dCutoff, dt);
		this.dx += ((x - this.rawX) / dt - this.dx) * ad;
		this.dy += ((y - this.rawY) / dt - this.dy) * ad;
		this.rawX = x;
		this.rawY = y;
		const speed = Math.sqrt(this.dx * this.dx + this.dy * this.dy);
		const a = alpha(p.minCutoff + p.beta * speed, dt);
		this.x += (x - this.x) * a;
		this.y += (y - this.y) * a;
	}
}
