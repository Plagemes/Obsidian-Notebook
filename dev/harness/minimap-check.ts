/**
 * Smoke check of the minimap (0.17, roadmap #173) on the `doc=minimap` notebook (the blank "New" notebook; npm run
 * harness:check): the real view with synthetic pointer events. On an infinite page the overview appears by itself, shows
 * the picture of the page and the rectangle the view shows; a tap and a drag on it pan the view; the handle moves it to
 * another corner; it collapses to a button and back; the setting turns it never / always; the document is not changed.
 * It leaves the overview open on a zoomed infinite page with some ink for the screenshot.
 */
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface MinimapCheckApi {
	view: unknown;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string }) => Promise<void>;
	setTool: (tool: string) => void;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface MinimapView extends HarnessView {
	runAction(id: string, arg?: { page?: number; value?: string }): void;
	setViewport(v: { scale: number; offsetX: number; offsetY: number }, interactive?: boolean): void;
	viewSize: { width: number; height: number };
	minimap: { visible: boolean; el: HTMLElement; invalidate(): void; update(): void; preferences: { corner: string; collapsed: boolean } };
}

const WORDS: Array<Array<[number, number]>> = [
	[[0.15, 0.1], [0.4, 0.12], [0.7, 0.1]],
	[[0.2, 0.3], [0.5, 0.34], [0.8, 0.3]],
	[[0.15, 0.55], [0.45, 0.6], [0.75, 0.55]],
];

export async function checkMinimap(api: MinimapCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { penStroke, setTool, frames } = api;
	const v = api.view as MinimapView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
	const q = <T extends Element>(sel: string): T | null => v.minimap.el.querySelector<T>(sel);
	const shown = (): boolean => !v.minimap.el.classList.contains("notebook-hidden") && v.minimap.el.getBoundingClientRect().width > 0;
	const page = () => v.document.pages[v.currentPage()]!;
	const mode = (m: "auto" | "always" | "never") => {
		(v.host.settings as unknown as { minimapMode: string }).minimapMode = m;
		v.applySettings(v.host.settings);
	};
	const pointer = (el: Element, type: string, x: number, y: number, id = 41) =>
		el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: "touch", clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, bubbles: true, cancelable: true }));
	const scrollTop = (): number => -v.viewport.offsetY / v.viewport.scale;

	// 0.27 (#431): the synthetic contacts below are touches, which would switch the input layout (a bigger toolbar, so a refit of
	// the stage) in the middle of the check; the layout is pinned to the pen, as the check was written for.
	(v.host.settings as unknown as { inputLayout: string }).inputLayout = "pen";
	mode("auto");
	await frames(3);
	// --- a normal page at fit: no overview ---
	add("no overview on a normal page that fits", !shown());

	// --- ink, then make the page infinite ---
	setTool("pen");
	for (const w of WORDS) await penStroke(w);
	const strokes = page().strokes.length;
	v.runAction("page-infinite");
	await frames(3);
	add("the page is infinite", page().infinite === true);
	// A tall infinite page: the view shows only a part of it.
	const p = page();
	add("an infinite page appears with its overview (automatic)", p.infinite === true && (shown() || v.viewSize.height >= p.height * v.viewport.scale));
	if (!shown()) {
		// Not tall enough to scroll yet: zoom in so the view shows only a part of it.
		v.setViewport({ scale: v.viewport.scale * 2, offsetX: v.viewport.offsetX, offsetY: v.viewport.offsetY }, false);
		await frames(3);
	}
	add("the overview is shown", shown());
	await sleep(1500);
	await frames(2);
	const img = q<HTMLImageElement>(".nb-minimap-img");
	add("the overview has a picture of the page", !!img && img.src.startsWith("data:image/"), (img?.src ?? "").slice(0, 24));
	const rect = q<HTMLElement>(".nb-minimap-rect");
	const rr = rect?.getBoundingClientRect();
	const pr = q<HTMLElement>(".nb-minimap-page")?.getBoundingClientRect();
	add("the view rectangle sits inside the map", !!rr && !!pr && rr.width > 2 && rr.height > 2 && rr.left >= pr.left - 1 && rr.right <= pr.right + 1 && rr.top >= pr.top - 1 && rr.bottom <= pr.bottom + 1, rr ? `${Math.round(rr.width)}x${Math.round(rr.height)}` : "");

	// --- tap and drag pan ---
	const map = q<HTMLElement>(".nb-minimap-map")!;
	const mb = q<HTMLElement>(".nb-minimap-page")!.getBoundingClientRect();
	const before = scrollTop();
	pointer(map, "pointerdown", mb.left + mb.width / 2, mb.top + mb.height * 0.85);
	pointer(map, "pointerup", mb.left + mb.width / 2, mb.top + mb.height * 0.85);
	await frames(3);
	const afterTap = scrollTop();
	add("a tap on the map pans the view there", afterTap > before + 10 || before > 0, `${Math.round(before)} -> ${Math.round(afterTap)}`);
	pointer(map, "pointerdown", mb.left + mb.width / 2, mb.top + mb.height * 0.5);
	pointer(map, "pointermove", mb.left + mb.width / 2, mb.top + mb.height * 0.2);
	await frames(2);
	const afterDrag = scrollTop();
	pointer(map, "pointerup", mb.left + mb.width / 2, mb.top + mb.height * 0.2);
	add("a drag on the map follows the finger", afterDrag < afterTap, `${Math.round(afterTap)} -> ${Math.round(afterDrag)}`);
	add("panning from the map did not change the page", page().strokes.length === strokes);

	// --- the rectangle follows the view when it scrolls elsewhere ---
	const top0 = q<HTMLElement>(".nb-minimap-rect")!.getBoundingClientRect().top;
	v.setViewport({ ...v.viewport, offsetY: v.viewport.offsetY - 300 }, true);
	await frames(2);
	const top1 = q<HTMLElement>(".nb-minimap-rect")!.getBoundingClientRect().top;
	add("the rectangle follows the view", Math.abs(top1 - top0) > 0.4 || scrollTop() <= 0, `${top0.toFixed(1)} -> ${top1.toFixed(1)}`);

	// --- corner ---
	const grip = q<HTMLElement>(".nb-minimap-grip")!;
	const body = v.minimap.el.parentElement!.getBoundingClientRect();
	const startCorner = v.minimap.preferences.corner;
	const target = startCorner === "tl" ? [body.right - 40, body.bottom - 40] : [body.left + 40, body.top + 40];
	const g = grip.getBoundingClientRect();
	pointer(grip, "pointerdown", g.left + 8, g.top + 8, 42);
	pointer(grip, "pointermove", target[0]!, target[1]!, 42);
	pointer(grip, "pointerup", target[0]!, target[1]!, 42);
	await frames(3);
	add("the handle moves it to another corner", v.minimap.preferences.corner !== startCorner, `${startCorner} -> ${v.minimap.preferences.corner}`);
	const mm = v.minimap.el.getBoundingClientRect();
	add("it stays inside the page area", mm.left >= body.left - 1 && mm.right <= body.right + 1 && mm.top >= body.top - 1 && mm.bottom <= body.bottom + 1);

	// --- collapse and expand ---
	q<HTMLButtonElement>(".nb-minimap-collapse")!.click();
	await frames(2);
	const pill = q<HTMLButtonElement>(".nb-minimap-pill")!;
	add("collapse leaves a small button", v.minimap.preferences.collapsed && pill.getBoundingClientRect().width >= 36 && !q<HTMLElement>(".nb-minimap-map")!.offsetWidth);
	pill.click();
	await frames(3);
	add("the button brings the map back", !v.minimap.preferences.collapsed && q<HTMLElement>(".nb-minimap-map")!.offsetWidth > 0);

	// --- the setting ---
	mode("never");
	await frames(2);
	add("never hides it", !shown());
	mode("always");
	await frames(2);
	add("always shows it", shown());
	mode("auto");
	await frames(2);
	add("automatic shows it again on the infinite page", shown());

	// --- the picture follows the page (throttled) ---
	const src0 = q<HTMLImageElement>(".nb-minimap-img")!.src;
	await penStroke([[0.2, 0.8], [0.5, 0.85], [0.8, 0.8]]);
	await sleep(1800);
	await frames(2);
	add("the picture is redrawn after the page changed", q<HTMLImageElement>(".nb-minimap-img")!.src !== src0);

	// --- the picture for the screenshot: ink lower down, view in the middle ---
	const b = v.minimap.el.getBoundingClientRect();
	add("the controls are at least 32 px", [".nb-minimap-grip", ".nb-minimap-collapse"].every((s) => q<HTMLElement>(s)!.getBoundingClientRect().width >= 31.5 && q<HTMLElement>(s)!.getBoundingClientRect().height >= 31.5), `${Math.round(b.width)}x${Math.round(b.height)}`);
	await sleep(50);
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
