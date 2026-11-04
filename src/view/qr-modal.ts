import { Modal, type App, type TFile } from "obsidian";
import { t } from "../i18n";
import { notebookUri } from "../integration/links";
import { encodeQr, qrSvgPath, type QrMatrix } from "../model/qr";
import { modalShell, shellButton, shellNote } from "../ui/components/modal-shell";
import { showNotice } from "./notice";

/** The link a QR code of this page carries: `obsidian://notebook?vault=…&path=…&page=…&id=…` (handled in integration/protocol.ts). */
export function pageQrUri(vaultName: string, file: TFile, page: number, pageId: string): string {
	return notebookUri(vaultName, file.path, page, pageId);
}

/** Draws the code as one SVG path (crisp at any size and pixel ratio): dark modules on a white square with the quiet zone, in every theme. */
export function drawQr(parent: HTMLElement, matrix: QrMatrix, label: string): SVGSVGElement {
	const quiet = 4;
	const size = matrix.size + quiet * 2;
	const svg = parent.createSvg("svg", { cls: "nb-qr-svg", attr: { viewBox: `0 0 ${size} ${size}`, role: "img", "aria-label": label, "shape-rendering": "crispEdges" } });
	svg.createSvg("rect", { attr: { width: String(size), height: String(size), fill: "#ffffff" } });
	svg.createSvg("path", { attr: { d: qrSvgPath(matrix, quiet), fill: "#000000" } });
	return svg;
}

/** "Show QR code": a big code for this page that another device with the same vault can scan to open it. */
export class PageQrModal extends Modal {
	constructor(app: App, private readonly uri: string, private readonly pageNumber: number) {
		super(app);
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("qr.title"), subtitle: t("qr.subtitle", { page: String(this.pageNumber) }), icon: "qr-code", size: "narrow", cls: "nb-qr-modal" });
		const matrix = encodeQr(this.uri);
		if (matrix) {
			const box = shell.body.createDiv({ cls: "nb-qr-box" });
			drawQr(box, matrix, t("qr.label", { page: String(this.pageNumber) }));
			shellNote(shell.body, t("qr.hint"));
		} else {
			shellNote(shell.body, t("qr.tooLong"), "error");
		}
		shellButton(shell.foot, "secondary", t("qr.copy"), () => void this.copy(), { icon: "link" });
		shellButton(shell.foot, "primary", t("qr.done"), () => this.close());
	}

	private async copy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(this.uri);
			showNotice(t("qr.copied"));
		} catch (e) {
			showNotice(t("share.copyFailed", { error: e instanceof Error ? e.message : String(e) }));
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
