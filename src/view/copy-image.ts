// 0.25 clipimage (#277): "Copy as image". The written area of the page (or the selection) is drawn by the same renderer as the area
// export (ink layer only, 2x, capped in size), painted onto white unless the setting says transparent, and put on the system clipboard as
// an image. Where the WebView has no image clipboard the PNG goes to the share sheet; where that is missing too a copy is saved next to
// the notebook (by the area export, recorded as plugin-written). Every outcome shows a notice: nothing fails silently. Document only read.
import { t } from "../i18n";
import type { AreaPlan, AreaScope } from "../ink/export-area";
import { afterFailure, CLIP_RETRY_MS, clipRoutes, clipScale, failureOf, failureOnRetry, needsWhite, type ClipBackground, type ClipCapabilities, type ClipFailure, type ClipRoute } from "../ink/clip-image";
import { scaleDpi } from "../model/export-pages";
import { canShareFiles, classifyShareError, shareMime } from "../model/share-page";
import { redacted, planWithRedaction, saveArea, type AreaHost } from "./export-area";
import { announceRedaction } from "./export-redact";
import { showNotice } from "./notice";
import { PageImageRenderer } from "./page-images";
import { pageSignature } from "./view-helpers";

/** Whether `navigator.clipboard.write` takes an image/png here. */
export function canCopyImage(): boolean {
	if (typeof navigator === "undefined" || !navigator.clipboard || typeof navigator.clipboard.write !== "function") return false;
	if (typeof ClipboardItem === "undefined") return false;
	const supports = (ClipboardItem as unknown as { supports?: (type: string) => boolean }).supports;
	try {
		return typeof supports === "function" ? supports.call(ClipboardItem, "image/png") !== false : true;
	} catch {
		return true;
	}
}

function shareProbe(): boolean {
	return canShareFiles(typeof navigator === "undefined" ? undefined : navigator, [new File([""], "a.png", { type: shareMime("png") })]);
}

/** What this device can do (probed). */
export function clipCapabilities(): ClipCapabilities {
	return { imageClipboard: canCopyImage(), shareFiles: shareProbe() };
}

/** Paints a transparent PNG onto white; returns the original when the canvas is not available. */
export async function onWhite(png: Blob): Promise<Blob> {
	if (typeof createImageBitmap !== "function") return png;
	const bitmap = await createImageBitmap(png);
	const canvas = createEl("canvas");
	canvas.width = bitmap.width;
	canvas.height = bitmap.height;
	try {
		const ctx = canvas.getContext("2d");
		if (!ctx) return png;
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(bitmap, 0, 0);
		const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
		return out ?? png;
	} finally {
		bitmap.close();
		canvas.width = 0;
		canvas.height = 0;
	}
}

/** The picture of a plan at the capped 2x, on the chosen background. Throws when it cannot be drawn. */
export async function drawClipPicture(host: AreaHost, plan: AreaPlan, background: ClipBackground): Promise<{ png: Blob; capped: boolean; skipped: number }> {
	await host.exportOptions.prepare?.([plan.page]);
	const { scale, capped } = clipScale(plan.rect.width, plan.rect.height);
	const renderer = new PageImageRenderer(host.media, { ...host.render, layers: "ink" });
	try {
		const drawn = await renderer.renderRegions(plan.page, scaleDpi(scale), [plan.rect]);
		const blob = drawn.blobs[0];
		if (!blob) throw new Error("could not encode PNG");
		return { png: needsWhite(background) ? await onWhite(blob) : blob, capped, skipped: drawn.skipped };
	} finally {
		renderer.close();
	}
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type ClipPicture = { png: Blob; capped: boolean; skipped: number };

/** The picture of a share that asked for a new tap, kept for that tap (see `failureOnRetry`). */
let ready: { key: string; picture: ClipPicture; at: number } | null = null;

/**
 * Copies the written area (or the selection) as an image. Tries the image clipboard, then the share sheet, then a saved copy, each
 * only where the device allows it. Never throws; returns the route that worked, or null.
 */
export async function copyAsImage(host: AreaHost, scope: AreaScope, background: ClipBackground, caps: ClipCapabilities = clipCapabilities()): Promise<ClipRoute | null> {
	// 0.26 (#285): the picture is made from the page with the redaction boxes applied.
	const plan = planWithRedaction(host, scope);
	if (!plan) {
		showNotice(t(scope === "selection" ? "exportArea.emptySelection" : "exportArea.empty"), 6000);
		return null;
	}
	if (redacted(plan)) announceRedaction([host.page], host.exportOptions);
	const routes = clipRoutes(caps);
	let route: ClipRoute | null = routes[0] ?? null;
	// The picture is drawn once. With an image clipboard it is handed over as a promise, so the tap's permission is still valid.
	let drawing: Promise<ClipPicture> | null = null;
	// A picture kept for a share that asked for a new tap is shared at once, inside this tap, if the page is the same and it is still fresh.
	const key = `${host.file.path}|${host.pageNumber}|${scope}|${background}|${JSON.stringify(plan.rect)}|${pageSignature(plan.page)}`;
	const retried = ready !== null && ready.key === key && Date.now() - ready.at < CLIP_RETRY_MS;
	if (retried && ready) drawing = Promise.resolve(ready.picture);
	ready = null;
	const picture = (): Promise<ClipPicture> => (drawing ??= drawClipPicture(host, plan, background).catch((e: unknown) => { drawing = null; throw e; }));
	const working = showNotice(t("export.working"), 0);
	try {
		while (route) {
			try {
				if (route === "clipboard") {
					const item = new ClipboardItem({ "image/png": picture().then((p) => p.png) });
					await navigator.clipboard.write([item]);
					const p = await picture();
					showNotice(t(p.capped ? "clipImage.copiedSmaller" : "clipImage.copied"), 4000);
					if (p.skipped > 0) showNotice(t("export.skipped", { n: String(p.skipped) }), 8000);
					return "clipboard";
				}
				if (route === "share") {
					const p = await picture();
					const file = new File([await p.png.arrayBuffer()], `notebook p${host.pageNumber}.png`, { type: shareMime("png") });
					await navigator.share({ files: [file], title: host.file.basename });
					showNotice(t("clipImage.shared"), 4000);
					return "share";
				}
				const path = await saveArea(host, { scope, format: "png", scale: 2 }, true);
				if (path) {
					showNotice(t("clipImage.saved", { path }), 9000);
					return "save";
				}
				return null; // saveArea already told why
			} catch (e) {
				console.warn("[notebook] copy as image", route, e);
				const failure: ClipFailure = route === "share" ? failureOnRetry(failureOf(classifyShareError(e)), retried) : "other";
				const next = afterFailure(routes, route, failure);
				// One notice per outcome. A share that needs a new tap keeps the vault clean: the picture is kept, and the next tap shares it at once.
				if (next.notice === "needsTap" && drawing) void drawing.then((p) => void (ready = { key, picture: p, at: Date.now() }), () => undefined);
				if (next.notice === "cancelled") showNotice(t("clipImage.cancelled"), 4000);
				else if (next.notice === "needsTap") showNotice(t("clipImage.needsTap"), 9000);
				else if (next.notice === "fallback") showNotice(t("clipImage.fallback", { error: errorText(e) }), 6000);
				else showNotice(t("clipImage.failed", { error: errorText(e) }), 9000);
				route = next.route;
			}
		}
		return null;
	} finally {
		working.hide();
	}
}
