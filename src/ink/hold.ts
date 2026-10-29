/**
 * The last few pen positions (CSS px) with their time, in a fixed ring buffer: the "hold still to
 * turn the stroke into a shape" check without an object per sample. Same rule as `isHold`
 * (recognize.ts): the pen has stayed within `radius` of its last position for `holdMs`.
 */
export class HoldTracker {
	private readonly xs: Float64Array;
	private readonly ys: Float64Array;
	private readonly ts: Float64Array;
	private start = 0;
	private size = 0;

	constructor(private readonly capacity = 48) {
		this.xs = new Float64Array(capacity);
		this.ys = new Float64Array(capacity);
		this.ts = new Float64Array(capacity);
	}

	get length(): number {
		return this.size;
	}

	clear(): void {
		this.start = 0;
		this.size = 0;
	}

	push(x: number, y: number, t: number): void {
		const i = (this.start + this.size) % this.capacity;
		this.xs[i] = x;
		this.ys[i] = y;
		this.ts[i] = t;
		if (this.size < this.capacity) this.size++;
		else this.start = (this.start + 1) % this.capacity;
	}

	/** Last position, or null when empty. */
	lastX(): number {
		return this.xs[(this.start + this.size - 1) % this.capacity]!;
	}

	lastY(): number {
		return this.ys[(this.start + this.size - 1) % this.capacity]!;
	}

	isHold(now: number, holdMs: number, radius: number): boolean {
		if (this.size === 0) return false;
		const li = (this.start + this.size - 1) % this.capacity;
		const lx = this.xs[li]!, ly = this.ys[li]!;
		let since = this.ts[li]!;
		for (let k = this.size - 2; k >= 0; k--) {
			const i = (this.start + k) % this.capacity;
			if (Math.hypot(this.xs[i]! - lx, this.ys[i]! - ly) > radius) break;
			since = this.ts[i]!;
		}
		return now - since >= holdMs;
	}
}
