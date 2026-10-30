/**
 * Smoke check of anchored excerpts (v10, #105) on the `doc=excerpt` notebook (three fake PDF pages; npm run
 * harness:check): "Excerpt to page…" with nothing selected arms a region, a lasso drag outlines it, the go-to-page
 * picker puts it on a new page, the excerpt is drawn (live from its source page) with its badge, a pen tap on the badge
 * jumps back to the source page without writing, and undo takes the excerpt and the page away. Driven through the real
 * view, the excerpt tools, the renderer and the document format.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { SuggestModal } from "obsidian";
import { excerptBadgeRect } from "../../src/model/excerpts";
import { serializeChecked } from "../../src/model/serialize";
import type { CheckResult } from "./reading-check";

export interface ExcerptCheckApi {
	view: any;
	stage(): HTMLElement;
	penStroke(points: Array<[number, number]>, opts?: { pointerType?: string }): Promise<void>;
	setTool(tool: string): void;
	strokeCount(): number;
	staticPixel(fx: number, fy: number): number[];
	frames(n: number): Promise<void>;
	errors: string[];
	notices: string[];
}

export async function checkExcerpt(api: ExcerptCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { view: v, stage, penStroke, setTool, strokeCount, staticPixel, frames } = api;
	const results: CheckResult[] = [];
	const add = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	/** Fractions of the stage for a point (pt) of page `index`. */
	const at = (index: number, x: number, y: number): [number, number] => {
		const r = stage().getBoundingClientRect();
		const vp = v.viewport;
		const box = v.layout.boxes[index];
		return [(vp.offsetX + (box.x + x) * vp.scale) / r.width, (vp.offsetY + (box.y + y) * vp.scale) / r.height];
	};
	const doc = v.document;
	const source = doc.pages[0];
	const pagesBefore = doc.pages.length;

	// The picker is captured when it opens (the stub modal draws no rows).
	const opened: any[] = [];
	const open = SuggestModal.prototype.open;
	SuggestModal.prototype.open = function (this: any) {
		opened.push(this);
		open.call(this);
	};
	try {
		setTool("lasso");
		v.excerptTools.excerptToPage();
		add("nothing selected: the next drag outlines the region", v.excerptTools.armed === "page", String(v.excerptTools.armed));
		await penStroke([at(0, 80, 80), at(0, 200, 140), at(0, 320, 220)]);
		for (let i = 0; i < 60 && opened.length === 0; i++) await sleep(50);
		const picker = opened[0];
		add("the go-to-page picker opens", !!picker);
		if (!picker) return done();
		const rows = picker.getSuggestions("");
		const fresh = rows.find((r: any) => r.index < 0);
		add("the picker offers this page, the next one and a new page", rows.length >= 3 && !!fresh, rows.map((r: any) => r.label).join(" | "));
		picker.close();
		picker.onChooseSuggestion(fresh);
		await frames(4);
		add("a new page holds the excerpt", doc.pages.length === pagesBefore + 1, `${doc.pages.length} pages`);
		const page = doc.pages[1];
		const el = page?.elements?.find((e: any) => e.type === "excerpt");
		add("the excerpt points at the source page by id with the dragged region", !!el && el.source.page === source.id && el.source.doc === doc.id
			&& Math.abs(el.source.x - 80) < 2 && Math.abs(el.source.width - 240) < 2, JSON.stringify(el?.source ?? null));
		add("the snapshot is stored as an image asset", !!el?.asset && doc.assets?.[el.asset]?.kind === "image", String(el?.asset));
		add("the document with the excerpt passes the check before writing", serializeChecked(doc).ok);
		add("the new excerpt is selected and the view is on its page", v.currentPage() === 1 && (v.uiContext().selection?.excerpts ?? 0) === 1, `page ${v.currentPage() + 1}`);
		if (!el) return done();

		// Drawn: the live picture of its source and the badge.
		v.clearSelection();
		setTool("pen");
		await frames(2);
		v.renderer.invalidate();
		await sleep(300);
		await frames(3);
		const live = v.mediaCache?.excerpt(el, v.viewport.scale * window.devicePixelRatio);
		add("the excerpt of a page of this notebook is drawn live", !!live);
		const b = excerptBadgeRect(el);
		const [bx, by] = at(1, b.x + b.width / 2, b.y + b.height * 0.15);
		const px = staticPixel(bx, by);
		add("its badge is drawn (teal)", px[1]! > px[0]! + 40 && px[2]! > px[0]! + 40, `rgba(${px.join(",")})`);

		// A pen tap on the badge jumps to the source and writes nothing.
		const strokes = strokeCount();
		await penStroke([[bx, by]]);
		await frames(4);
		add("a tap on the badge jumps back to the source page", v.currentPage() === 0, `page ${v.currentPage() + 1}`);
		add("the tap wrote no ink", strokeCount() === strokes);

		// Undo: the excerpt and its page go away in one step.
		v.undo();
		await frames(2);
		add("undo removes the excerpt and its page", doc.pages.length === pagesBefore && !doc.pages.some((p: any) => p.elements?.some((e: any) => e.type === "excerpt")));
	} catch (e) {
		add("no exception", false, String((e as Error)?.stack ?? e));
	} finally {
		SuggestModal.prototype.open = open;
	}
	return done();

	function done() {
		return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: {} };
	}
}
