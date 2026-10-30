import { t } from "../i18n";
import { AddAsset, AddElement, Batch, SetPageSize, type Command } from "../model/history";
import { createId } from "../model/document";
import { autoSheet } from "../scan/auto-sheet";
import { takePhotos } from "../scan/camera";
import { PhotoDecodeError } from "../scan/decode";
import { boardShotElements, boardTime, contentBottom, planBoardShot } from "./board-shot-logic";
import type { EditContext } from "./edit-context";
import { storeAsset } from "./media";
import { showNotice, type NoticeHandle } from "./notice";

function failure(e: unknown): string {
	if (e instanceof PhotoDecodeError && e.reason === "heic") return t("scan.heic");
	return t("boardShot.failed", { error: e instanceof Error ? e.message : String(e) });
}

/**
 * Instant board shot: the in-app camera, then — with no further question — automatic crop (the whole photo when no
 * outline is found), the whiteboard filter, and the photo placed on the page in view under the last ink, with a
 * small time label above it. The asset, the photo, the label and (on an infinite page) the extra height are one undo step.
 */
export async function runBoardShot(ctx: EditContext): Promise<void> {
	const anchor = ctx.doc.pages[ctx.currentPage()];
	if (!anchor) return;
	let asset: Awaited<ReturnType<typeof storeAsset>> | null = null;
	let working: NoticeHandle | null = null;
	try {
		const photo = (await takePhotos(ctx.app, false))[0];
		if (!photo || !ctx.alive() || !ctx.doc.pages.includes(anchor)) return;
		working = showNotice(t("boardShot.working"), 0);
		const sheet = await autoSheet(photo, "whiteboard");
		asset = await storeAsset(ctx.app, ctx.folder, sheet.jpeg, sheet.name, "image");
		ctx.addPending(asset);
		const index = ctx.doc.pages.indexOf(anchor);
		if (index < 0 || !ctx.alive()) return;

		const plan = planBoardShot({
			page: anchor,
			contentBottom: contentBottom(anchor, ctx.measure),
			visible: ctx.visibleLocal(index),
			imageWidth: sheet.width,
			imageHeight: sheet.height,
		});
		const { image, label } = boardShotElements(plan, asset.id, t("boardShot.label", { time: boardTime(new Date()) }), createId);
		const at = anchor.elements?.length ?? 0;
		const commands: Command[] = [new AddAsset(asset)];
		if (plan.pageHeight !== undefined) {
			commands.push(new SetPageSize(anchor.id, { width: anchor.width, height: anchor.height }, { width: anchor.width, height: plan.pageHeight }));
		}
		commands.push(new AddElement(anchor.id, image, at), new AddElement(anchor.id, label, at + 1));
		ctx.execute(new Batch("Board shot", commands));

		if (plan.placement === "over-content") showNotice(t("boardShot.overContent"), 8000);
		else if (!sheet.cropped) showNotice(t("boardShot.uncropped"), 6000);
		else showNotice(t("boardShot.done"));
	} catch (e) {
		console.error("[notebook] board shot", e);
		showNotice(failure(e), 8000);
	} finally {
		working?.hide();
		if (asset) ctx.removePending(asset.id);
	}
}
