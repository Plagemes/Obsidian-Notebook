// ui redesign: closing floating layers (popovers, sheets) by a tap outside or Escape. A tap that lands on the page
// only closes the layer (as in Samsung Notes and Goodnotes): the rest of that pointer's sequence is kept from the page,
// so it leaves no ink. No 'obsidian' import.

const SEQUENCE = ["pointerdown", "pointermove", "pointerrawupdate", "pointerup", "pointercancel"] as const;
const swallowing = new Map<number, () => void>();

/** Keeps the pointer sequence that starts with `down` (down … up) from reaching anything else. */
export function swallowPointer(down: PointerEvent): void {
	const id = down.pointerId;
	const stop = (e: Event): void => {
		if ((e as PointerEvent).pointerId !== id) return;
		e.stopPropagation();
		e.preventDefault();
		if (e.type === "pointerup" || e.type === "pointercancel") off();
	};
	const off = (): void => {
		for (const type of SEQUENCE) window.removeEventListener(type, stop, true);
		swallowing.delete(id);
	};
	swallowing.get(id)?.();
	for (const type of SEQUENCE) window.addEventListener(type, stop, true);
	swallowing.set(id, off);
	stop(down);
}

/** Stops every pointer sequence still being swallowed (view closing). */
export function releaseSwallowed(): void {
	for (const off of [...swallowing.values()]) off();
}

export interface DismissOptions {
	/** Elements a tap inside of keeps the layer open (the layer itself, its anchor…). */
	inside: () => Array<Element | null | undefined>;
	close: () => void;
	/** Selector of the page area: a tap there closes the layer and draws nothing. */
	page?: string;
}

/** Listens for a tap outside and for Escape while a layer is open; returns the function that stops listening. */
export function listenDismiss(opts: DismissOptions): () => void {
	const offs: Array<() => void> = [];
	const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void): void => {
		window.addEventListener(type, fn, true);
		offs.push(() => window.removeEventListener(type, fn, true));
	};
	on("pointerdown", (e) => {
		const target = e.target as Element | null;
		if (!target || typeof target.closest !== "function") return;
		if (opts.inside().some((el) => el?.contains(target))) return;
		const onPage = !!opts.page && !!target.closest(opts.page);
		opts.close();
		if (onPage) swallowPointer(e);
	});
	on("keydown", (e) => {
		if (e.key !== "Escape") return;
		e.preventDefault();
		e.stopPropagation();
		opts.close();
	});
	return () => {
		for (const off of offs) off();
		offs.length = 0;
	};
}
