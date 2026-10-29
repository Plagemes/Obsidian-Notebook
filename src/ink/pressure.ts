export type PressureMode = "auto" | "simulated";

/**
 * Decides whether to use the device pressure or simulate it from speed.
 *
 * Some devices report a constant value (0, 0.5 or 1). The choice is made once, when a stroke
 * starts, and never changes in the middle of it (switching would make the line jump in width):
 * - the pen's pressure is used when the device has already proven real pressure (at least
 *   `distinctNeeded` different values in (0, 1), 0.5 excluded, seen in earlier strokes), or when
 *   the stroke's first sample already reports a value in (0, 1) other than 0.5;
 * - otherwise, and always for mouse and finger, pressure is simulated from speed. A device that
 *   proves real pressure during such a stroke uses it from the next stroke on.
 * A trusted pen that then reports exactly the same value for 200 samples in a row loses the trust
 * for later strokes.
 *
 * Real pressure gets a light causal smoothing (digitizer noise). Allocation-free per sample.
 */
export class PressureModel {
	private readonly seen = new Set<number>();
	private trusted = false;
	private real = false;
	private smoothed = 0.5;
	private simulated = 0.5;
	private hasLast = false;
	private lastX = 0;
	private lastY = 0;
	private lastT = 0;
	private lastRaw = -1;
	private constantRun = 0;

	constructor(public mode: PressureMode = "auto", private readonly distinctNeeded = 3) {}

	get penPressureTrusted(): boolean {
		return this.trusted;
	}

	/** True when the stroke in progress uses the device pressure. */
	get usingReal(): boolean {
		return this.real;
	}

	/** Call at the start of each stroke with its first sample's pointer type and raw pressure. */
	begin(pointerType = "pen", firstRaw = 0.5): void {
		this.simulated = 0.5;
		this.hasLast = false;
		this.constantRun = 0;
		this.lastRaw = -1;
		const pen = this.mode !== "simulated" && pointerType === "pen";
		const plausible = firstRaw > 0 && firstRaw < 1 && firstRaw !== 0.5;
		this.real = pen && (this.trusted || plausible);
		this.smoothed = clamp01(firstRaw);
	}

	/**
	 * Pressure for one point. `x`, `y` in CSS px (speed is measured on screen),
	 * `t` in ms.
	 */
	sample(pointerType: string, raw: number, x: number, y: number, t: number): number {
		const simulated = this.simulate(x, y, t);
		if (pointerType === "pen" && this.mode !== "simulated") this.observe(raw);
		if (!this.real) return simulated;
		this.smoothed += (clamp01(raw) - this.smoothed) * 0.6;
		return this.smoothed;
	}

	private observe(raw: number): void {
		this.constantRun = raw === this.lastRaw ? this.constantRun + 1 : 0;
		this.lastRaw = raw;
		if (this.trusted && this.constantRun >= 200) {
			this.trusted = false;
			this.seen.clear();
		}
		if (this.trusted || !(raw > 0 && raw < 1) || raw === 0.5) return;
		this.seen.add(Math.round(raw * 100));
		if (this.seen.size >= this.distinctNeeded) this.trusted = true;
	}

	/** Faster = thinner, with an exponential moving average to avoid jumps. */
	private simulate(x: number, y: number, t: number): number {
		if (!this.hasLast) {
			this.hasLast = true;
			this.lastX = x;
			this.lastY = y;
			this.lastT = t;
			return this.simulated;
		}
		const dt = Math.max(1, t - this.lastT);
		const speed = Math.hypot(x - this.lastX, y - this.lastY) / dt; // px/ms
		this.lastX = x;
		this.lastY = y;
		this.lastT = t;
		const target = clamp01(1 - Math.min(speed, 3) / 3 * 0.7) * 0.8 + 0.1;
		this.simulated += (target - this.simulated) * 0.3;
		return this.simulated;
	}
}

function clamp01(x: number): number {
	return Math.min(1, Math.max(0, x));
}
