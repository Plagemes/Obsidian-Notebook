/**
 * Counts consecutive taps (1, 2, 3): a tap continues the series when it comes within `maxGapMs`
 * of the previous one and within `maxDistPx` of it. After the third tap the series starts over.
 */
export class MultiTap {
	private count = 0;
	private t = -Infinity;
	private x = 0;
	private y = 0;

	constructor(private readonly maxGapMs = 400, private readonly maxDistPx = 30) {}

	/** Registers a finished tap and returns its number in the series. */
	tap(t: number, x: number, y: number): number {
		const continues = this.count > 0 && this.count < 3 && t - this.t <= this.maxGapMs && t >= this.t
			&& Math.hypot(x - this.x, y - this.y) <= this.maxDistPx;
		this.count = continues ? this.count + 1 : 1;
		this.t = t;
		this.x = x;
		this.y = y;
		return this.count;
	}

	reset(): void {
		this.count = 0;
		this.t = -Infinity;
	}
}
