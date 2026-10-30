/**
 * Wave p1a, PDF features of an open notebook: expandable margins (#104), re-published slides (#235) and
 * the annotation export to Markdown (#155). The logic is in pure modules (model/margins.ts,
 * pdf/republish.ts, pdf/annotations.ts); this file is the Obsidian glue (menus, modals, files).
 */
import { loadPdfJs, Modal, normalizePath, Notice, Setting, type App, type TFile } from "obsidian";
import { t } from "../i18n";
import { notebookUri } from "../integration/links";
import { Batch, SetPageMargins, type Command } from "../model/history";
import { backgroundRect, MAX_MARGIN_RATIO, marginsEqual, marginsOf, normalizeMargins, pagesWithSameBackground } from "../model/margins";
import { MM, type NotebookDocument, type Page, type PageMargins } from "../model/types";
import { annotationsMarkdown, collectAnnotations, hasPdfAnnotations, pagesNeedingText, uniquePath } from "../pdf/annotations";
import { assetIdFromHash, sha256Hex } from "../pdf/hash";
import { PdfStore, type CanvasLike } from "../pdf/pdf-store";
import type { PdfLib } from "../pdf/pdfjs-types";
import {
	countMatches, differenceHash, makeFingerprint, matchRepublished, needsImageHash, normalizePageText, pdfSources, planRepublish,
	type MatchResult, type NewSource, type OldSource, type PageFingerprint,
} from "../pdf/republish";
import { boxesOnPage, type TextBox } from "../pdf/text-items";
import { storeAsset, type NotebookMedia } from "./media";
import { pickFile } from "./pick";

/** What the actions need from the notebook view (NotebookView.pdfActionHost). */
export interface PdfActionHost {
	app: App;
	file: TFile;
	doc: NotebookDocument;
	media: NotebookMedia;
	/** Notebooks folder (assets live in its `_assets`). */
	folder: string;
	/** True while the view still shows this document and it can be edited. */
	editable(): boolean;
	/** Runs `cmd` as one undo step and refreshes the view; false when the document can no longer be edited. */
	run(cmd: Command, scrollTo?: number): boolean;
}

// ------------------------------------------------------------------------------------------ margins

const toMm = (pt: number) => Math.round((pt / MM) * 10) / 10;
const toPt = (mm: number) => Math.round(mm * MM * 100) / 100;

/** Margins of `page` applied to `target`: one SetPageMargins, or null when nothing changes. */
function marginCommand(target: Page, after: PageMargins | undefined): Command | null {
	const next = normalizeMargins(after);
	if (marginsEqual(target.margins, next)) return null;
	return new SetPageMargins(target.id, target.margins, next);
}

/** Asks for the margins of a page (mm) and applies them, optionally to every page of the same PDF, as one undo step. */
export function openMarginsModal(host: PdfActionHost, page: Page): void {
	const modal = new Modal(host.app);
	const current = marginsOf(page);
	const hadMargins = !!page.margins;
	const box = backgroundRect(page);
	const maxSide = toMm(box.width * MAX_MARGIN_RATIO);
	const maxBottom = toMm(box.height * MAX_MARGIN_RATIO);
	// Without margins yet, suggest a right margin of half the PDF width: room for notes beside the slide.
	const values = hadMargins
		? { left: toMm(current.left), right: toMm(current.right), bottom: toMm(current.bottom) }
		: { left: 0, right: Math.round(toMm(box.width) / 2), bottom: 0 };
	const siblings = pagesWithSameBackground(host.doc.pages, page);
	let all = siblings.length > 1;

	modal.setTitle(t("pdf.margins.title"));
	modal.contentEl.createEl("p", { text: t("pdf.margins.desc"), cls: "setting-item-description" });
	const errorEl = modal.contentEl.createDiv({ cls: "notebook-modal-error notebook-hidden" });
	const field = (key: keyof typeof values, label: string, max: number) => {
		new Setting(modal.contentEl).setName(label).addText((tx) => {
			tx.inputEl.type = "number";
			tx.inputEl.min = "0";
			tx.inputEl.max = String(max);
			tx.inputEl.step = "1";
			tx.setValue(String(values[key])).onChange((v) => (values[key] = Number(v.replace(",", "."))));
		});
	};
	field("left", t("pdf.margins.left"), maxSide);
	field("right", t("pdf.margins.right"), maxSide);
	field("bottom", t("pdf.margins.bottom"), maxBottom);
	if (siblings.length > 1) {
		new Setting(modal.contentEl)
			.setName(t("pdf.margins.all", { n: String(siblings.length) }))
			.addToggle((tg) => tg.setValue(all).onChange((v) => (all = v)));
	}

	const apply = (margins: PageMargins | undefined) => {
		const targets = all ? siblings : [page];
		const commands: Command[] = [];
		for (const p of targets) {
			if (!host.doc.pages.includes(p)) continue;
			const cmd = marginCommand(p, margins);
			if (cmd) commands.push(cmd);
		}
		modal.close();
		if (commands.length === 0) return;
		host.run(commands.length === 1 ? commands[0]! : new Batch("Change page margins", commands), host.doc.pages.indexOf(page));
	};
	const submit = () => {
		const ok = (v: number, max: number) => Number.isFinite(v) && v >= 0 && v <= max;
		if (!ok(values.left, maxSide) || !ok(values.right, maxSide) || !ok(values.bottom, maxBottom)) {
			errorEl.setText(t("pdf.margins.invalid", { max: String(Math.floor(Math.min(maxSide, maxBottom))) }));
			errorEl.removeClass("notebook-hidden");
			return;
		}
		apply({ left: toPt(values.left), right: toPt(values.right), bottom: toPt(values.bottom) });
	};
	const buttons = new Setting(modal.contentEl);
	if (hadMargins || siblings.some((p) => p.margins)) {
		buttons.addButton((b) => b.setButtonText(t("pdf.margins.remove")).onClick(() => apply(undefined)));
	}
	buttons
		.addButton((b) => b.setButtonText(t("pdf.cancel")).onClick(() => modal.close()))
		.addButton((b) => b.setButtonText(t("pdf.margins.apply")).setCta().onClick(submit));
	modal.scope.register([], "Enter", () => {
		submit();
		return false;
	});
	modal.onClose = () => modal.contentEl.empty();
	modal.open();
}

// --------------------------------------------------------------------------- re-published slides

/** Key under which the temporary store reads the PDF being imported (not an asset id: never collides). */
const NEW_PDF = "new-version";
/** Longest side, in px, of the rendering whose image hash identifies a slide with little text. */
const HASH_RENDER_PX = 72;

function scratchStore(media: NotebookMedia, bytes: ArrayBuffer): PdfStore {
	return new PdfStore({
		loadPdfJs: () => loadPdfJs() as Promise<PdfLib>,
		// pdf.js may take ownership of the buffer it is given: always hand it a copy.
		readAsset: (id) => (id === NEW_PDF ? Promise.resolve(bytes.slice(0)) : media.readAsset(id)),
		createCanvas: (w, h) => {
			const c = activeDocument.createEl("canvas");
			c.width = w;
			c.height = h;
			return c;
		},
		memoryBudgetBytes: 8 * 1024 * 1024,
		maxOpenDocs: 2,
	});
}

async function imageHash(store: PdfStore, asset: string, page: number, size: { width: number; height: number }): Promise<string> {
	const canvas: CanvasLike = await store.render(asset, page, HASH_RENDER_PX / Math.max(size.width, size.height, 1));
	const ctx = (canvas as HTMLCanvasElement).getContext("2d");
	if (!ctx) throw new Error("Canvas 2D is not available");
	const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
	return differenceHash(data.data, data.width, data.height);
}

async function fingerprintOf(store: PdfStore, asset: string, page: number): Promise<PageFingerprint> {
	const content = await store.pageText(asset, page);
	const parts = content.items.map((i) => i.str);
	const image = needsImageHash(normalizePageText(parts)) ? await imageHash(store, asset, page, content) : undefined;
	return makeFingerprint(parts, image);
}

/** Page menu / command: imports a new version of a PDF already in the notebook (see pdf/republish.ts). */
export async function updatePdfFromNewVersion(host: PdfActionHost, anchorIndex: number): Promise<void> {
	if (!host.editable()) return;
	const anchorBg = host.doc.pages[anchorIndex]?.background;
	const anchorAsset = anchorBg?.kind === "pdf" ? anchorBg.asset : null;
	const picked = await pickFile(host.app, "pdf");
	if (!picked || !host.editable()) return;
	const store = scratchStore(host.media, picked.bytes);
	const working = new Notice(t("pdf.update.reading"), 0);
	try {
		const assetId = assetIdFromHash(await sha256Hex(picked.bytes));
		const sizes = await store.pageSizes(NEW_PDF);
		if (sizes.length === 0) throw new Error("the PDF has no pages");
		const sources = pdfSources(host.doc);
		const total = sizes.length + sources.length;
		let done = 0;
		const tick = () => working.setMessage(t("pdf.update.working", { n: `${++done}/${total}` }));
		const fresh: NewSource[] = [];
		for (let n = 1; n <= sizes.length; n++) {
			fresh.push({ page: n, fp: await fingerprintOf(store, NEW_PDF, n) });
			tick();
		}
		const old: OldSource[] = [];
		let unreadable = 0;
		for (const s of sources) {
			try {
				old.push({ ...s, fp: await fingerprintOf(store, s.asset, s.page) });
			} catch (e) {
				console.error("[notebook] update PDF: cannot read", s.asset, s.page, e);
				unreadable++;
			}
			tick();
		}
		working.hide();
		const result = matchRepublished(old, fresh, anchorAsset);
		const counts = countMatches(result);
		if (counts.added === 0 && counts.updated === 0) {
			new Notice(t("pdf.update.nothing"), 6000);
			return;
		}
		const choice = await askRepublish(host, result, unreadable);
		if (!choice || !host.editable()) return;
		const asset = await storeAsset(host.app, host.folder, picked.bytes, picked.name, "pdf");
		if (asset.id !== assetId) throw new Error("the file changed while it was being read");
		host.media.addPending(asset);
		try {
			const plan = planRepublish(host.doc, result, asset, sizes, choice);
			if (!plan.command) {
				new Notice(t("pdf.update.nothing"), 6000);
				return;
			}
			if (!host.run(plan.command, plan.added > 0 ? plan.insertAt : undefined)) return;
			new Notice(t("pdf.update.done", { added: String(plan.added), switched: String(plan.switched) }));
		} finally {
			host.media.removePending(asset.id);
		}
	} catch (e) {
		console.error("[notebook] update PDF", e);
		new Notice(t("pdf.update.failed", { error: (e as Error).message }), 8000);
	} finally {
		working.hide();
		store.clear();
	}
}

/** Summary before applying: counts, and per updated slide whether to switch it. Resolves the pages to switch, or null. */
function askRepublish(host: PdfActionHost, result: MatchResult, unreadable: number): Promise<Set<number> | null> {
	return new Promise((resolve) => {
		const modal = new Modal(host.app);
		let settled = false;
		const finish = (v: Set<number> | null) => {
			if (settled) return;
			settled = true;
			resolve(v);
		};
		const counts = countMatches(result);
		const el = modal.contentEl;
		modal.setTitle(t("pdf.update.title"));
		el.createEl("p", { text: t("pdf.update.summary", { added: String(counts.added), updated: String(counts.updated), unchanged: String(counts.unchanged) }) });
		if (counts.added > 0) el.createEl("p", { text: t("pdf.update.added", { n: String(counts.added) }), cls: "setting-item-description" });
		const switchPages = new Set<number>();
		const updated = result.matches.filter((m) => m.status === "updated" && m.source);
		if (updated.length > 0) {
			new Setting(el).setName(t("pdf.update.updatedHeading")).setDesc(t("pdf.update.updatedDesc")).setHeading();
			for (const m of updated) {
				const src = m.source!;
				const at = host.doc.pages.findIndex((p) => p.background?.kind === "pdf" && p.background.asset === src.asset && p.background.page === src.page);
				// Only slides of the PDF the update is for start switched on; a look-alike slide of another PDF is opt-in.
				const main = src.asset === result.main;
				if (main) switchPages.add(m.page);
				const similarity = t("pdf.update.similarity", { pct: String(Math.round(m.similarity * 100)) });
				const from = t("pdf.update.from", { name: host.doc.assets?.[src.asset]?.name ?? src.asset, n: String(src.page) });
				new Setting(el)
					.setName(t("pdf.update.updatedItem", { page: String(at + 1), n: String(m.page) }))
					.setDesc(main ? `${similarity} · ${from}` : `${similarity} · ${from} · ${t("pdf.update.otherPdf")}`)
					.addToggle((tg) => tg.setTooltip(t("pdf.update.switch")).setValue(main).onChange((v) => {
						if (v) switchPages.add(m.page);
						else switchPages.delete(m.page);
					}));
			}
		}
		if (counts.missing > 0) el.createEl("p", { text: t("pdf.update.missing", { n: String(counts.missing) }), cls: "setting-item-description" });
		if (unreadable > 0) el.createEl("p", { text: t("pdf.update.unreadable", { n: String(unreadable) }), cls: "setting-item-description" });
		new Setting(el)
			.addButton((b) => b.setButtonText(t("pdf.cancel")).onClick(() => modal.close()))
			.addButton((b) => b.setButtonText(t("pdf.update.apply")).setCta().onClick(() => {
				finish(new Set(switchPages));
				modal.close();
			}));
		modal.onClose = () => {
			finish(null);
			el.empty();
		};
		modal.open();
	});
}

// ------------------------------------------------------------------------------ annotation export

function localDate(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Page menu / command: writes the highlights and text boxes of the PDF pages to a new Markdown note and opens it. */
export async function exportPdfAnnotations(host: PdfActionHost): Promise<void> {
	const { app, file, doc, media } = host;
	if (!hasPdfAnnotations(doc)) {
		new Notice(t("pdf.annotations.none"), 6000);
		return;
	}
	const working = new Notice(t("pdf.annotations.working"), 0);
	try {
		const texts = new Map<Page, TextBox[] | null>();
		const contents = new Map<string, Promise<Awaited<ReturnType<PdfStore["pageText"]>> | null>>();
		for (const page of pagesNeedingText(doc)) {
			const bg = page.background;
			if (bg?.kind !== "pdf") continue;
			const key = `${bg.asset}#${bg.page}`;
			let content = contents.get(key);
			if (!content) {
				content = media.pdf.pageText(bg.asset, bg.page).catch((e) => {
					console.error("[notebook] annotations: PDF text", key, e);
					return null;
				});
				contents.set(key, content);
			}
			const c = await content;
			texts.set(page, c ? boxesOnPage(c, backgroundRect(page)) : null);
		}
		const items = collectAnnotations(doc, (p) => texts.get(p) ?? null);
		const vault = app.vault.getName();
		const markdown = annotationsMarkdown({
			items,
			notebookLink: app.fileManager.generateMarkdownLink(file, "", undefined, file.basename),
			date: localDate(new Date()),
			pdfName: (id) => doc.assets?.[id]?.name ?? id,
			pageUrl: (n) => notebookUri(vault, file.path, n),
			labels: {
				title: t("pdf.annotations.title", { name: file.basename }),
				source: t("pdf.annotations.source"),
				exported: t("pdf.annotations.exported"),
				pageHeading: (pdf, pdfPage, page) => t("pdf.annotations.pageHeading", { page: String(page), n: String(pdfPage), pdf }),
				highlight: t("pdf.annotations.highlight"),
				comment: t("pdf.annotations.comment"),
				noText: t("pdf.annotations.noText"),
				openPage: (page) => t("pdf.annotations.openPage", { page: String(page) }),
			},
		});
		const dir = file.parent && file.parent.path !== "/" ? file.parent.path : "";
		const path = normalizePath(uniquePath((p) => !!app.vault.getAbstractFileByPath(normalizePath(p)), dir, `${file.basename} ${t("pdf.annotations.fileSuffix")}`, "md"));
		const note = await app.vault.create(path, markdown);
		working.hide();
		new Notice(t("pdf.annotations.done", { path, n: String(items.length) }));
		await app.workspace.getLeaf("tab").openFile(note);
	} catch (e) {
		console.error("[notebook] annotations", e);
		new Notice(t("pdf.annotations.failed", { error: (e as Error).message }), 8000);
	} finally {
		working.hide();
	}
}
