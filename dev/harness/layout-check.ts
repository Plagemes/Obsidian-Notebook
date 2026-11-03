/**
 * 0.14 layout (roadmap #430): the orientation / size classes in the browser harness. `checkLayout()` runs in the scenarios that
 * draw the notebook view or Home / the library, at phone and tablet, portrait and landscape, dark and light: the view's root
 * must carry the class the classifier gives for its own size, and the landscape rules must have taken effect.
 */
import { classifyViewport, viewportClasses, viewportKey } from "../../src/ui/viewport-class";

type Result = { name: string; ok: boolean; detail: string };

export function checkLayout(): { ok: boolean; results: Result[]; errors: string[] } {
	const results: Result[] = [];
	const root = document.querySelector<HTMLElement>(".nb-app") ?? document.querySelector<HTMLElement>(".view-content.notebook-view");
	const label = `${window.innerWidth}x${window.innerHeight}`;
	const add = (name: string, ok: boolean, detail = "") => results.push({ name: `layout ${label}: ${name}`, ok, detail });
	if (!root) {
		add("the view root exists", false, "no .nb-app or .notebook-view");
		return { ok: false, results, errors: [] };
	}
	const w = root.clientWidth, h = root.clientHeight;
	const coarse = window.matchMedia("(pointer: coarse)").matches;
	// The tracker is sticky; the harness loads fresh, so a plain classification of the view's own size must agree.
	const expected = classifyViewport(w, h, null, { coarse });
	add("the root carries the data attribute of its size class", root.dataset.nbViewport === viewportKey(expected), `${root.dataset.nbViewport} vs ${viewportKey(expected)} (${w}x${h})`);
	const missing = viewportClasses(expected).filter((c) => !root.classList.contains(c));
	add("the root carries the size classes", missing.length === 0, missing.join(" "));
	add("exactly one size and one orientation class", ["phone", "tablet", "desktop"].filter((n) => root.classList.contains(`nb-vp-${n}`)).length === 1 && ["portrait", "landscape"].filter((n) => root.classList.contains(`nb-vp-${n}`)).length === 1);
	const landscape = window.innerWidth > window.innerHeight;
	add("orientation follows the window", root.classList.contains(landscape ? "nb-vp-landscape" : "nb-vp-portrait"));
	if (window.innerHeight <= 400 && landscape) {
		add("a short landscape window is marked short", root.classList.contains("nb-vp-short"));
		const head = root.querySelector<HTMLElement>(".nb-page-header");
		if (head) add("the page header gives back vertical space", parseFloat(getComputedStyle(head).paddingTop) <= 12, getComputedStyle(head).paddingTop);
		const toolbar = root.querySelector<HTMLElement>(".notebook-toolbar");
		if (toolbar) add("the toolbar has no vertical padding", parseFloat(getComputedStyle(toolbar).paddingTop) === 0, getComputedStyle(toolbar).paddingTop);
	} else add("a tall window is not marked short", !root.classList.contains("nb-vp-short"));
	const modal = createDiv({ cls: "modal nb-modal nb-ui" });
	document.body.appendChild(modal);
	const maxH = getComputedStyle(modal).maxHeight;
	modal.remove();
	if (window.innerHeight <= 480 && landscape) add("a dialog uses the height of a short landscape window", parseFloat(maxH) >= window.innerHeight - 16 - 1, maxH);
	return { ok: results.every((r) => r.ok), results, errors: [] };
}
