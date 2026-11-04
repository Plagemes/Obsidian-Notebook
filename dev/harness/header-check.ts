/**
 * 0.15 page header (#75) on the `doc=header` notebook (the v3 notebook: grid page, ruled page; npm run harness:check). The real
 * view paints the automatic header or footer into the static layer: the check turns it on through the settings, counts the
 * grey text pixels in the top and bottom strips of page 1, moves a text element into the top strip of page 2 (as a lecture
 * header placed too high would) and expects the line to shift to the footer, then turns it off again. The final state (a
 * header with title, date and page number, centred) is left for the screenshot.
 */
import { headerLayout } from "../../src/ink/page-header";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface HeaderCheckApi {
	view: unknown;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

export async function checkHeader(api: HeaderCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { frames } = api;
	const v = api.view as HarnessView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });
	const settings = v.host.settings as unknown as Record<string, unknown>;
	const set = async (o: Record<string, unknown>): Promise<void> => {
		Object.assign(settings, o);
		v.applySettings(v.host.settings);
		await frames(3);
	};
	const canvas = (): HTMLCanvasElement => document.querySelector<HTMLCanvasElement>("canvas.notebook-canvas-static")!;
	/** Grey text pixels of page `i` in the strip of 24 pt at its top (or bottom), counted on the static canvas. */
	const greyIn = (i: number, bottom: boolean, side?: "left" | "right" | "centre"): number => {
		const c = canvas();
		const ctx = c.getContext("2d")!;
		const dpr = c.width / c.getBoundingClientRect().width;
		const { scale, offsetX, offsetY } = v.viewport;
		const box = v.layout.boxes[i] as { x: number; y: number; width?: number; height?: number };
		const page = v.document.pages[i]!;
		const x0 = Math.floor((offsetX + box.x * scale) * dpr), w = Math.floor(page.width * scale * dpr);
		const y0 = Math.floor((offsetY + (box.y + (bottom ? page.height - 24 : 0)) * scale) * dpr), h = Math.floor(24 * scale * dpr);
		if (y0 < 0 || y0 + h > c.height) return -1;
		const sx = side === "left" ? x0 : side === "right" ? x0 + Math.floor(w * 0.66) : side === "centre" ? x0 + Math.floor(w * 0.33) : x0;
		const sw = side ? Math.floor(w * 0.34) : w;
		const d = ctx.getImageData(sx, y0, sw, h).data;
		let n = 0;
		for (let k = 0; k < d.length; k += 4) if (d[k + 3]! > 200 && d[k]! < 175 && d[k]! > 90 && Math.abs(d[k]! - d[k + 2]!) < 40) n++;
		return n;
	};

	v.scrollToPage(0);
	await set({ headerMode: "off" });
	const offTop = greyIn(0, false);
	add("off: nothing in the top strip", offTop === 0, `${offTop}`);

	await set({ headerMode: "header", headerPageNumber: true, headerPageTotal: true, headerDate: false, headerTitle: false, headerAlign: "centre" });
	const top = greyIn(0, false);
	add("header: the page number is drawn at the top", top > 20, `${top}`);
	add("header: nothing at the bottom of the page", greyIn(0, true) === 0);
	add("header centred, not at the left or right", greyIn(0, false, "centre") > 20 && greyIn(0, false, "left") === 0 && greyIn(0, false, "right") === 0);

	await set({ headerAlign: "left" });
	add("left: drawn in the left third only", greyIn(0, false, "left") > 20 && greyIn(0, false, "right") === 0);
	await set({ headerAlign: "right" });
	add("right: drawn in the right third only", greyIn(0, false, "right") > 20 && greyIn(0, false, "left") === 0);

	await set({ headerMode: "footer", headerAlign: "centre" });
	const strokesBefore = v.document.pages.reduce((n, p) => n + p.strokes.length, 0);
	const footerSeen = greyIn(0, true);
	// The footer of page 1 may be off screen on a short viewport: then it is checked after a scroll to the page end.
	add("footer: not at the top", greyIn(0, false) === 0);
	if (footerSeen >= 0) add("footer: drawn at the bottom when in view", footerSeen > 20, `${footerSeen}`);

	// A text element in the top strip (a lecture header placed too high) takes the place: the line goes to the other edge.
	await set({ headerMode: "header" });
	const p1 = v.document.pages[1]!;
	p1.elements = [{ id: "harness-top", type: "text", x: 28, y: 6, width: 400, text: "Lecture header", fontSize: 16, color: "#1e1e1e" }];
	v.renderer.invalidate();
	await frames(3);
	const shifted = headerLayout(p1, 1, v.document.pages.length, settings as never, { title: "t", createdAt: v.document.createdAt, locale: "en" });
	add("an element in the top strip pushes the line to the footer", shifted?.footer === true, JSON.stringify(shifted));
	v.scrollToPage(1);
	await frames(3);
	const shiftedBottom = greyIn(1, true);
	if (shiftedBottom >= 0) add("and the footer of that page is drawn", shiftedBottom > 20, `${shiftedBottom}`);
	delete p1.elements;
	v.renderer.invalidate();

	add("the header never changes the document", v.document.pages.reduce((n, p) => n + p.strokes.length, 0) === strokesBefore && !JSON.stringify(v.document).includes("headerMode"));

	await set({ headerMode: "header", headerTitle: true, headerDate: true, headerPageNumber: true, headerAlign: "centre" });
	v.scrollToPage(0);
	await frames(3);
	add("title, date and number make a longer line", greyIn(0, false) > top, `${greyIn(0, false)} vs ${top}`);

	await set({ headerMode: "off" });
	add("off again: the strip is clean", greyIn(0, false) === 0);
	await set({ headerMode: "header" });
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: {} };
}
