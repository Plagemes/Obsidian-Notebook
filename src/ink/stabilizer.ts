/**
 * Input stabilization: the drawn point follows the pen with an exponential lag that smooths
 * hand tremor. Level 0 is off; higher levels smooth more and lag more. The stabilized points are
 * what gets stored, so a saved stroke keeps its shape if the setting changes later.
 */
export class Stabilizer {
	private x = 0;
	private y = 0;
	private rawX = 0;
	private rawY = 0;
	private active = false;

	constructor(public level = 0) {}

	private get alpha(): number {
		return 1 / (1 + this.level * 0.6);
	}

	reset(x: number, y: number): void {
		this.x = this.rawX = x;
		this.y = this.rawY = y;
		this.active = true;
	}

	push(x: number, y: number): [number, number] {
		this.rawX = x;
		this.rawY = y;
		if (!this.active || this.level <= 0) {
			this.x = x;
			this.y = y;
			return [x, y];
		}
		const a = this.alpha;
		this.x += (x - this.x) * a;
		this.y += (y - this.y) * a;
		return [this.x, this.y];
	}

	/** Points that bring the line from its lagging position to where the pen was lifted. */
	finish(): Array<[number, number]> {
		this.active = false;
		if (this.level <= 0) return [];
		const dx = this.rawX - this.x;
		const dy = this.rawY - this.y;
		const dist = Math.hypot(dx, dy);
		if (dist < 0.05) return [];
		const n = Math.min(6, Math.max(1, Math.ceil(dist / 2)));
		const out: Array<[number, number]> = [];
		for (let i = 1; i <= n; i++) out.push([this.x + (dx * i) / n, this.y + (dy * i) / n]);
		this.x = this.rawX;
		this.y = this.rawY;
		return out;
	}
}
