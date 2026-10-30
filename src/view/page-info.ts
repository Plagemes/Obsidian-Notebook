import { getLanguage, Modal, type App } from "obsidian";
import { t, type MessageKey } from "../i18n";
import { markerKindsPresent, pageInfo, type PageInfo } from "../model/page-info";
import type { NotebookDocument } from "../model/types";
import { formatBytes } from "../storage/history";

/** What the panel needs from the notebook view. */
export interface PageInfoHost {
	app: App;
	doc(): NotebookDocument | null;
	/** When this device last edited the page (ms since epoch), if it has a record. */
	editedAt(pageId: string): number | null;
}

function when(value: string | number | null): string {
	if (value === null) return "";
	try {
		return new Date(value).toLocaleString(getLanguage());
	} catch {
		return new Date(value).toISOString();
	}
}

/** The rows of the panel as label and value text, in display order (pure given the info; the labels come from the language tables). */
export function infoRows(info: PageInfo): Array<[string, string]> {
	const size = info.preset ? t("info.size.preset", { name: t(`size.${info.preset}` as MessageKey), width: String(Math.round(info.width)), height: String(Math.round(info.height)) })
		: t("info.size.value", { width: String(Math.round(info.width)), height: String(Math.round(info.height)) });
	const rows: Array<[string, string]> = [
		[t("info.size"), info.infinite ? t("info.size.infinite", { size }) : size],
		[t("info.paper"), t(`paper.${info.paper}` as MessageKey)],
		[t("info.background"), t(`info.background.${info.background}` as MessageKey)],
	];
	if (info.strokes.total === 0) {
		rows.push([t("info.ink"), t("info.ink.none")]);
	} else {
		const tools = t("info.ink.tools", { pen: String(info.strokes.byTool.pen), highlighter: String(info.strokes.byTool.highlighter), shape: String(info.strokes.byTool.shape) });
		const hidden = info.strokes.hidden > 0 ? `; ${t("info.ink.hidden", { n: String(info.strokes.hidden) })}` : "";
		rows.push([t("info.ink"), `${t("info.ink.value", { strokes: String(info.strokes.total), points: String(info.points) })} (${tools})${hidden}`]);
	}
	const e = info.elements;
	rows.push([t("info.objects"), e.total === 0 ? t("info.objects.none") : t("info.objects.value", { text: String(e.text), images: String(e.image), boxes: String(e.box), markers: String(e.marker) })]);
	const a = info.assets;
	rows.push([t("info.files"), a.count === 0 ? t("info.files.none")
		: t(a.unknown > 0 ? "info.files.unknown" : "info.files.value", { count: String(a.count), size: formatBytes(a.bytes), unknown: String(a.unknown) })]);
	rows.push([t("info.tags"), info.tags.length === 0 ? t("info.tags.none") : info.tags.join(", ")]);
	const mark = info.bookmark;
	rows.push([t("info.bookmark"), mark === null ? t("info.bookmark.no") : [t("info.bookmark.yes"), mark.title, mark.category].filter(Boolean).join(" · ")]);
	const kinds = markerKindsPresent(info).map((k) => `${t(`markers.kind.${k}` as MessageKey)} ${info.markers.byKind[k]}`).join(", ");
	rows.push([t("info.markers"), info.markers.total === 0 ? t("info.markers.none") : `${t("info.markers.value", { open: String(info.markers.open), total: String(info.markers.total) })} (${kinds})`]);
	const d = info.dates;
	if (d.notebookCreated) rows.push([t("info.created"), when(d.notebookCreated)]);
	if (d.notebookSaved) rows.push([t("info.saved"), when(d.notebookSaved)]);
	rows.push([t("info.edited"), d.pageEditedHere === null ? t("info.edited.unknown") : when(d.pageEditedHere)]);
	return rows;
}

/** Roadmap 379: what the notebook file knows about one page. Read-only; nothing here is stored or changed. */
export class PageInfoModal extends Modal {
	constructor(private readonly host: PageInfoHost, private readonly index: number) {
		super(host.app);
	}

	onOpen(): void {
		this.modalEl.addClass("notebook-page-info");
		const doc = this.host.doc();
		this.contentEl.empty();
		const page = doc?.pages[this.index];
		const info = doc && page ? pageInfo(doc, this.index, this.host.editedAt(page.id)) : null;
		if (!info) {
			this.close();
			return;
		}
		this.setTitle(t("info.title", { n: String(info.number), total: String(info.total) }));
		const list = this.contentEl.createEl("dl", { cls: "notebook-info-list" });
		for (const [label, value] of infoRows(info)) {
			list.createEl("dt", { text: label });
			list.createEl("dd", { text: value });
		}
		this.contentEl.createDiv({ cls: "notebook-info-note", text: t("info.dates.note") });
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
