/**
 * Saved collections, the UI (roadmap #120): the editor dialog (name and rules, with a live count of the notebooks that match)
 * and the words that describe a collection's rules. The rules and the files are in collections.ts / collections-store.ts.
 */
import { Modal, Notice, type App } from "obsidian";
import { t } from "../i18n";
import { confirmDestructive } from "../ui/destructive";
import { modalShell, shellButton, shellField, shellNote } from "../ui/components/modal-shell";
import {
	cleanName, COLLECTION_NAME_MAX, countMatches, dayBounds, hasRules, PERIOD_DAYS, ymdOf,
	type CollectionPeriod, type CollectionRules, type PeriodField, type RuleContext, type SavedCollection,
} from "./collections";
import type { CollectionsStore } from "./collections-store";
import { CollectionsBlockedError } from "./collections-store";
import { flattenTree, type FolderNode } from "./folders";
import type { LibraryEntry } from "./index";

export interface CollectionEditorHost {
	app: App;
	store: CollectionsStore;
	/** The notebooks the live count is made from (not the archived ones). */
	entries(): readonly LibraryEntry[];
	context(): RuleContext;
	tree(): FolderNode;
	rootPath: string;
	rootLabel: string;
	/** Tags in the library, for suggestions. */
	tags(): string[];
	/** A collection was saved (its id) or deleted. */
	saved(id: string): void;
	deleted(id: string): void;
}

type PeriodMode = "any" | "7" | "30" | "range";

/** The rules in words, one short phrase each (the line under a collection's title). */
export function describeRules(r: CollectionRules, folderLabel: (path: string) => string, lang?: string): string[] {
	const out: string[] = [];
	if (r.tags && r.tags.length > 0) out.push(t(r.tagMode === "all" ? "coll.sum.tagsAll" : "coll.sum.tagsAny", { tags: r.tags.map((x) => `#${x}`).join(", ") }));
	if (r.folder) out.push(t("coll.sum.folder", { folder: folderLabel(r.folder) }));
	const p = r.period;
	if (p) {
		const what = p.field === "created" ? "created" : "modified";
		if (p.kind === "days") out.push(t(what === "created" ? "coll.sum.createdDays" : "coll.sum.modifiedDays", { n: String(p.days) }));
		else {
			const fmt = (ms: number) => new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(ms);
			const from = p.from !== undefined ? fmt(p.from) : "…";
			const to = p.to !== undefined ? fmt(p.to) : "…";
			out.push(t(what === "created" ? "coll.sum.createdRange" : "coll.sum.modifiedRange", { from, to }));
		}
	}
	if (r.favourite !== undefined) out.push(t(r.favourite ? "coll.sum.fav" : "coll.sum.notFav"));
	if (r.pdf) out.push(t(r.pdf === "yes" ? "coll.sum.pdf" : "coll.sum.noPdf"));
	return out;
}

/** The dialog that makes or edits a collection. Every change is counted at once; nothing is saved until Save. */
export class CollectionEditor extends Modal {
	private draftName = "";
	private tagText = "";
	private tagMode: "any" | "all" = "any";
	private folder = "";
	private field: PeriodField = "modified";
	private mode: PeriodMode = "any";
	private from = "";
	private to = "";
	private favourite: "any" | "yes" | "no" = "any";
	private pdf: "any" | "yes" | "no" = "any";
	private countEl!: HTMLElement;
	private saveBtn!: HTMLButtonElement;
	private errorEl!: HTMLElement;
	private rangeRow!: HTMLElement;
	private busy = false;

	constructor(private readonly host: CollectionEditorHost, private readonly existing: SavedCollection | null = null) {
		super(host.app);
		if (existing) {
			const r = existing.rules;
			this.draftName = existing.name;
			this.tagText = (r.tags ?? []).join(", ");
			this.tagMode = r.tagMode === "all" ? "all" : "any";
			this.folder = r.folder ?? "";
			this.favourite = r.favourite === undefined ? "any" : r.favourite ? "yes" : "no";
			this.pdf = r.pdf ?? "any";
			const p = r.period;
			if (p) {
				this.field = p.field;
				if (p.kind === "days") this.mode = p.days === 7 ? "7" : p.days === 30 ? "30" : "range";
				else this.mode = "range";
				if (p.kind === "range") {
					this.from = p.from !== undefined ? ymdOf(p.from) : "";
					this.to = p.to !== undefined ? ymdOf(p.to) : "";
				} else if (this.mode === "range") {
					this.to = ymdOf(host.context().now);
					this.from = ymdOf(host.context().now - p.days * 86_400_000);
				}
			}
		}
	}

	onOpen(): void {
		const shell = modalShell(this, {
			title: this.existing ? t("coll.edit.title") : t("coll.new.title"), subtitle: t("coll.edit.subtitle"), icon: "filter", size: "medium", cls: "nb-coll-editor",
		});
		const body = shell.body;

		const nameF = shellField(body, t("coll.name"), "nb-coll-name");
		const name = nameF.createEl("input", { cls: "nb-modal-input", attr: { id: "nb-coll-name", type: "text", maxlength: String(COLLECTION_NAME_MAX), placeholder: t("coll.name.placeholder"), "data-key": "coll-name" } });
		name.value = this.draftName;
		name.addEventListener("input", () => {
			this.draftName = name.value;
			this.refresh();
		});

		const tagsF = shellField(body, t("coll.tags"), "nb-coll-tags");
		const list = tagsF.createEl("datalist", { attr: { id: "nb-coll-taglist" } });
		for (const tag of this.host.tags().slice(0, 200)) list.createEl("option", { attr: { value: tag } });
		const tags = tagsF.createEl("input", { cls: "nb-modal-input", attr: { id: "nb-coll-tags", type: "text", list: "nb-coll-taglist", placeholder: t("coll.tags.placeholder"), "data-key": "coll-tags" } });
		tags.value = this.tagText;
		tags.addEventListener("input", () => {
			this.tagText = tags.value;
			this.refresh();
		});
		const modeRow = tagsF.createDiv({ cls: "nb-coll-seg", attr: { role: "radiogroup", "aria-label": t("coll.tags.mode") } });
		const seg = (parent: HTMLElement, label: string, on: boolean, pick: () => void, key: string): void => {
			const b = parent.createEl("button", { cls: "nb-coll-seg-btn", text: label, attr: { type: "button", role: "radio", "aria-checked": String(on), "data-key": key } });
			b.toggleClass("is-on", on);
			b.addEventListener("click", () => {
				pick();
				for (const x of Array.from(parent.children)) {
					x.toggleClass("is-on", x === b);
					x.setAttribute("aria-checked", String(x === b));
				}
				this.refresh();
			});
		};
		seg(modeRow, t("coll.tags.any"), this.tagMode === "any", () => (this.tagMode = "any"), "coll-tags-any");
		seg(modeRow, t("coll.tags.all"), this.tagMode === "all", () => (this.tagMode = "all"), "coll-tags-all");

		const folderF = shellField(body, t("coll.folder"), "nb-coll-folder");
		const folder = folderF.createEl("select", { cls: "nb-modal-input", attr: { id: "nb-coll-folder", "data-key": "coll-folder" } });
		folder.createEl("option", { text: t("coll.folder.any"), attr: { value: "" } });
		const nodes = flattenTree(this.host.tree());
		const known = nodes.some((n) => n.path === this.folder);
		if (this.folder && !known) folder.createEl("option", { text: this.folder, attr: { value: this.folder } });
		for (const n of nodes) folder.createEl("option", { text: n.path === this.host.rootPath ? this.host.rootLabel : n.path.slice(this.host.rootPath.length ? this.host.rootPath.length + 1 : 0), attr: { value: n.path } });
		folder.value = this.folder;
		folder.addEventListener("change", () => {
			this.folder = folder.value;
			this.refresh();
		});
		folderF.createDiv({ cls: "nb-modal-note", text: t("coll.folder.hint") });

		const periodF = shellField(body, t("coll.period"), "nb-coll-period");
		const prow = periodF.createDiv({ cls: "nb-modal-inputrow" });
		const field = prow.createEl("select", { cls: "nb-modal-input", attr: { "aria-label": t("coll.period.field"), "data-key": "coll-period-field" } });
		field.createEl("option", { text: t("coll.period.modified"), attr: { value: "modified" } });
		field.createEl("option", { text: t("coll.period.created"), attr: { value: "created" } });
		field.value = this.field;
		field.addEventListener("change", () => {
			this.field = field.value === "created" ? "created" : "modified";
			this.refresh();
		});
		const mode = prow.createEl("select", { cls: "nb-modal-input", attr: { id: "nb-coll-period", "data-key": "coll-period-mode" } });
		for (const [value, label] of [["any", t("coll.period.any")], ["7", t("coll.period.7")], ["30", t("coll.period.30")], ["range", t("coll.period.range")]] as const) mode.createEl("option", { text: label, attr: { value } });
		mode.value = this.mode;
		this.rangeRow = periodF.createDiv({ cls: "nb-modal-inputrow nb-coll-range" });
		const date = (label: string, value: string, set: (v: string) => void, key: string): void => {
			this.rangeRow.createSpan({ text: label });
			const d = this.rangeRow.createEl("input", { cls: "nb-modal-input", attr: { type: "date", "aria-label": label, "data-key": key } });
			d.value = value;
			d.addEventListener("change", () => {
				set(d.value);
				this.refresh();
			});
		};
		date(t("coll.period.from"), this.from, (v) => (this.from = v), "coll-from");
		date(t("coll.period.to"), this.to, (v) => (this.to = v), "coll-to");
		mode.addEventListener("change", () => {
			this.mode = mode.value as PeriodMode;
			this.refresh();
		});

		const favF = shellField(body, t("coll.favourite"), "nb-coll-fav");
		const fav = favF.createEl("select", { cls: "nb-modal-input", attr: { id: "nb-coll-fav", "data-key": "coll-fav" } });
		for (const [value, label] of [["any", t("coll.any")], ["yes", t("coll.fav.yes")], ["no", t("coll.fav.no")]] as const) fav.createEl("option", { text: label, attr: { value } });
		fav.value = this.favourite;
		fav.addEventListener("change", () => {
			this.favourite = fav.value as "any" | "yes" | "no";
			this.refresh();
		});

		const pdfF = shellField(body, t("coll.pdf"), "nb-coll-pdf");
		const pdf = pdfF.createEl("select", { cls: "nb-modal-input", attr: { id: "nb-coll-pdf", "data-key": "coll-pdf" } });
		for (const [value, label] of [["any", t("coll.any")], ["yes", t("coll.pdf.yes")], ["no", t("coll.pdf.no")]] as const) pdf.createEl("option", { text: label, attr: { value } });
		pdf.value = this.pdf;
		pdf.addEventListener("change", () => {
			this.pdf = pdf.value as "any" | "yes" | "no";
			this.refresh();
		});

		this.countEl = body.createDiv({ cls: "nb-coll-count", attr: { role: "status", "aria-live": "polite" } });
		this.errorEl = shellNote(body, "", "error");
		this.errorEl.addClass("is-hidden");

		if (this.existing) {
			const id = this.existing.id;
			shellButton(shell.foot, "danger", t("coll.delete"), () => this.confirmDelete(id), { icon: "trash-2" });
		}
		shellButton(shell.foot, "secondary", t("ui.modal.cancel"), () => this.close());
		this.saveBtn = shellButton(shell.foot, "primary", t("coll.save"), () => void this.save(), { icon: "check" });
		this.refresh();
		window.setTimeout(() => name.focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/** The rules as the fields say now. */
	private rules(): CollectionRules {
		const r: CollectionRules = {};
		const tags = this.tagText.split(/[,;\n]+/).map((x) => x.trim().replace(/^#/, "")).filter(Boolean);
		if (tags.length > 0) {
			r.tags = tags;
			r.tagMode = this.tagMode;
		}
		if (this.folder) r.folder = this.folder;
		const p = this.period();
		if (p) r.period = p;
		if (this.favourite !== "any") r.favourite = this.favourite === "yes";
		if (this.pdf !== "any") r.pdf = this.pdf;
		return r;
	}

	private period(): CollectionPeriod | null {
		if (this.mode === "7" || this.mode === "30") return { field: this.field, kind: "days", days: this.mode === "7" ? PERIOD_DAYS[0] : PERIOD_DAYS[1] };
		if (this.mode !== "range") return null;
		const from = dayBounds(this.from)?.start;
		const to = dayBounds(this.to)?.end;
		if (from === undefined && to === undefined) return null;
		return { field: this.field, kind: "range", ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
	}

	private refresh(): void {
		this.rangeRow.toggleClass("is-hidden", this.mode !== "range");
		const rules = this.rules();
		const n = countMatches(rules, this.host.entries(), this.host.context());
		this.countEl.setText(hasRules(rules) ? t("coll.count", { n: String(n) }) : t("coll.count.all", { n: String(n) }));
		const named = cleanName(this.draftName) !== "";
		const rangeBad = this.mode === "range" && this.period() === null;
		this.saveBtn.disabled = this.busy || !named || rangeBad;
		this.errorEl.toggleClass("is-hidden", !rangeBad);
		this.errorEl.setText(rangeBad ? t("coll.period.rangeEmpty") : "");
	}

	private async save(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.refresh();
		try {
			const id = await this.host.store.save({ id: this.existing?.id, name: this.draftName, rules: this.rules() });
			this.host.saved(id);
			this.close();
		} catch (e) {
			this.busy = false;
			this.refresh();
			this.errorEl.removeClass("is-hidden");
			this.errorEl.setText(e instanceof CollectionsBlockedError ? t(e.reason === "limit" ? "coll.err.limit" : "coll.err.blocked") : t("coll.err.save"));
			console.error("[notebook] collection not saved", e);
		}
	}

	private confirmDelete(id: string): void {
		confirmDestructive(this.app, { title: t("coll.delete.title"), body: t("coll.delete.body", { name: this.existing?.name ?? "" }), confirm: t("coll.delete") }, () => {
			void this.host.store.remove(id).then(() => {
				this.host.deleted(id);
				this.close();
			}).catch((e) => {
				console.error("[notebook] collection not deleted", e);
				new Notice(t("coll.err.save"));
			});
		});
	}
}
