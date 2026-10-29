export type PressureMode = "auto" | "simulated";

/**
 * Decides whether to use the device pressure or simulate it from speed.
 *
 * Some devices report a constant value (0, 0.5 or 1). Pen pressure is trusted only after
 * seeing at least `distinctNeeded` different values in (0, 1), 0.5 excluded. Trust lasts for
 * the session: a real pressure device earns it during the first stroke.
 */
export class PressureModel {
	private readonly seen = new Set<number>();
	private trusted = false;
	private simulated = 0.5;
	private last: { x: number; y: number; t: number } | null = null;

	constructor(public mode: PressureMode = "auto", private readonly distinctNeeded = 3) {}

	get penPressureTrusted(): boolean {
		return this.trusted;
	}

	/** Call at the start of each stroke. */
	begin(): void {
		this.simulated = 0.5;
		this.last = null;
	}

	/**
	 * Pressure for one point. `x`, `y` in CSS px (speed is measured on screen),
	 * `t` in ms.
	 */
	sample(pointerType: string, raw: number, x: number, y: number, t: number): number {
		const simulated = this.simulate(x, y, t);
		if (this.mode === "simulated" || pointerType !== "pen") return simulated;
		if (!this.trusted) this.observe(raw);
		return this.trusted ? clamp01(raw) : simulated;
	}

	private observe(raw: number): void {
		if (!(raw > 0 && raw < 1) || raw === 0.5) return;
		this.seen.add(Math.round(raw * 100));
		if (this.seen.size >= this.distinctNeeded) this.trusted = true;
	}

	/** Faster = thinner, with an exponential moving average to avoid jumps. */
	private simulate(x: number, y: number, t: number): number {
		const prev = this.last;
		this.last = { x, y, t };
		if (!prev) return this.simulated;
		const dt = Math.max(1, t - prev.t);
		const speed = Math.hypot(x - prev.x, y - prev.y) / dt; // px/ms
		const target = clamp01(1 - Math.min(speed, 3) / 3 * 0.7) * 0.8 + 0.1;
		this.simulated += (target - this.simulated) * 0.3;
		return this.simulated;
	}
}

function clamp01(x: number): number {
	return Math.min(1, Math.max(0, x));
}
