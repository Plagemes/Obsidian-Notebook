// A picture the art engine can make, described instead of drawn: the callers show a cached one at once, or draw their
// element without it and let the picture arrive (off the main thread) a moment later.
import { artImageAsync, coverImageAsync, emptyStateImageAsync, peekArtImage, type ArtSpec } from "./generative-art";

export interface ArtRef {
	kind: "art" | "cover" | "empty";
	spec: ArtSpec;
	w: number;
	h: number;
	dpr?: number;
}

/** A ready data URL, or a description of one to make. */
export type ArtSource = string | ArtRef;

export function artRef(kind: ArtRef["kind"], spec: ArtSpec, w: number, h: number): ArtRef {
	const dpr = Math.min(2, (typeof activeWindow !== "undefined" ? activeWindow.devicePixelRatio : 1) || 1);
	return { kind, spec, w, h, dpr };
}

/** The picture if it is in memory already ("" when the engine is off), else undefined. Never draws. */
export function peekRef(ref: ArtRef): string | undefined {
	try {
		return peekArtImage(ref.kind, ref.spec, ref.w, ref.h, ref.dpr);
	} catch {
		return "";
	}
}

/** Makes the picture without blocking; never rejects ("" on failure). */
export function resolveRef(ref: ArtRef): Promise<string> {
	try {
		const p = ref.kind === "cover" ? coverImageAsync(ref.spec, ref.w, ref.h, ref.dpr) : ref.kind === "empty" ? emptyStateImageAsync(ref.spec, ref.w, ref.h, ref.dpr) : artImageAsync(ref.spec, ref.w, ref.h, ref.dpr);
		return p.catch(() => "");
	} catch {
		return Promise.resolve("");
	}
}

export interface ApplyArtOptions {
	/** The CSS custom property that receives `url("…")`; default `--nb-art`. */
	prop?: string;
	/** Receives the URL instead of the CSS property (an <img> source, for example). */
	set?: (url: string) => void;
	/** Called when no picture could be made (the element then stays without art). */
	onNone?: () => void;
}

/** Marks an element whose art arrived late: styles.css fades it in (not under reduced motion). */
export const ART_FADE_CLASS = "nb-art-fade";

/** The latest request per element: a slower, older picture never replaces a newer one (a style picked twice quickly). */
const latest = new WeakMap<HTMLElement, ArtRef>();

function set(el: HTMLElement, o: ApplyArtOptions, url: string): void {
	if (o.set) o.set(url);
	else el.setCssProps({ [o.prop ?? "--nb-art"]: `url("${url}")` });
}

/**
 * Gives `el` its art. A ready URL or a cached picture is set at once (no flicker, no fade); otherwise the element is
 * left as it is and the picture is set when it arrives, with a short fade. Nothing happens after the element is
 * detached, and a failure only leaves the element without art.
 */
export function applyArt(el: HTMLElement, src: ArtSource | undefined, o: ApplyArtOptions = {}): void {
	if (!src) return;
	latest.delete(el);
	if (typeof src === "string") {
		set(el, o, src);
		return;
	}
	const hit = peekRef(src);
	if (hit !== undefined) {
		if (hit) set(el, o, hit);
		else o.onNone?.();
		return;
	}
	latest.set(el, src);
	void resolveRef(src).then((url) => {
		if (!el.isConnected || latest.get(el) !== src) return;
		if (!url) {
			o.onNone?.();
			return;
		}
		set(el, o, url);
		el.addClass(ART_FADE_CLASS);
	});
}
