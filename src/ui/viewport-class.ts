// 0.14 layout (roadmap #430): classifies the size of a view by width, height, orientation and aspect. Pure (no DOM, no
// 'obsidian'): unit-tested. The layout engine of the toolbar (layout.ts) reacts to width only; this module is what the
// surfaces use to decide "phone held sideways", "tablet upright", "short landscape", with hysteresis so a view that
// hovers around a threshold (a split being dragged, a keyboard opening, rotation in progress) does not flicker.

export type ViewportSize = "phone" | "tablet" | "desktop";
export type ViewportOrientation = "portrait" | "landscape";

export interface ViewportClass {
	size: ViewportSize;
	orientation: ViewportOrientation;
	/** Landscape with little height (a phone held sideways, a tablet with the keyboard up): vertical space is the scarce one. */
	shortHeight: boolean;
}

export interface ViewportHints {
	/** A touch screen as the main pointer (`pointer: coarse`): a wide, tall view with a fine pointer is a desktop. */
	coarse?: boolean;
}

/** Thresholds in CSS px; the second value of a pair is where the class is left again (hysteresis). */
export const VIEWPORT = {
	/** The short side of the view below which it is a phone. */
	phoneBelow: 520,
	phoneLeave: 548,
	/** The short side from which a view with a fine pointer is a desktop (a coarse pointer is never one). */
	desktopFrom: 760,
	desktopLeave: 728,
	/** A landscape view with a small height is a phone only up to this length (wider: a tablet with the keyboard up). */
	phoneLongBelow: 960,
	phoneLongLeave: 990,
	/** Landscape is entered at width / height >= this, left at <= `portraitAt`; in between the previous orientation stays. */
	landscapeAt: 1.08,
	portraitAt: 0.92,
	/** Short height: entered below `shortBelow` px, left at `shortLeave`. */
	shortBelow: 480,
	shortLeave: 520,
} as const;

/** Classifies a view `width` x `height` CSS px. With `prev` the thresholds are sticky. A view without size keeps `prev`. */
export function classifyViewport(width: number, height: number, prev?: ViewportClass | null, hints: ViewportHints = {}): ViewportClass {
	if (!(width > 0) || !(height > 0)) return prev ?? { size: "tablet", orientation: "landscape", shortHeight: false };
	const T = VIEWPORT;
	const aspect = width / height;
	const orientation: ViewportOrientation = aspect >= T.landscapeAt ? "landscape" : aspect <= T.portraitAt ? "portrait" : (prev?.orientation ?? (aspect >= 1 ? "landscape" : "portrait"));
	const short = Math.min(width, height);
	const wasPhone = prev?.size === "phone", wasDesktop = prev?.size === "desktop";
	let size: ViewportSize;
	const long = Math.max(width, height);
	if (short < (wasPhone ? T.phoneLeave : T.phoneBelow) && (orientation === "portrait" || long < (wasPhone ? T.phoneLongLeave : T.phoneLongBelow))) size = "phone";
	else if (hints.coarse) size = "tablet";
	else size = short >= (wasDesktop ? T.desktopLeave : T.desktopFrom) ? "desktop" : "tablet";
	const shortHeight = orientation === "landscape" && height < (prev?.shortHeight ? T.shortLeave : T.shortBelow);
	return { size, orientation, shortHeight };
}

export function sameViewport(a: ViewportClass | null | undefined, b: ViewportClass | null | undefined): boolean {
	return !!a && !!b && a.size === b.size && a.orientation === b.orientation && a.shortHeight === b.shortHeight;
}

/** "phone-landscape", "tablet-portrait", "desktop-landscape"; ends with "-short" for a short landscape. */
export function viewportKey(c: ViewportClass): string {
	return `${c.size}-${c.orientation}${c.shortHeight ? "-short" : ""}`;
}

/** The CSS classes of a class: nb-vp-<size>, nb-vp-<orientation>, and nb-vp-short. */
export function viewportClasses(c: ViewportClass): string[] {
	const out = [`nb-vp-${c.size}`, `nb-vp-${c.orientation}`];
	if (c.shortHeight) out.push("nb-vp-short");
	return out;
}

/** Every class `viewportClasses` can return (to clear before applying). */
export const ALL_VIEWPORT_CLASSES: readonly string[] = ["phone", "tablet", "desktop", "portrait", "landscape", "short"].map((n) => `nb-vp-${n}`);

/** Keeps the current class of one view and says when it changed. */
export class ViewportTracker {
	private cur: ViewportClass | null = null;
	constructor(private readonly hints: () => ViewportHints = () => ({})) {}

	get current(): ViewportClass | null {
		return this.cur;
	}

	/** Feeds a measured size; returns the new class when it changed, otherwise null. */
	update(width: number, height: number): ViewportClass | null {
		if (!(width > 0) || !(height > 0)) return null;
		const next = classifyViewport(width, height, this.cur, this.hints());
		if (sameViewport(this.cur, next)) return null;
		this.cur = next;
		return next;
	}
}

/** Puts the classes and `data-nb-viewport` on an element, replacing the previous ones. */
export function applyViewportClass(el: HTMLElement, c: ViewportClass): void {
	el.removeClass(...ALL_VIEWPORT_CLASSES);
	el.addClass(...viewportClasses(c));
	el.dataset.nbViewport = viewportKey(c);
}
