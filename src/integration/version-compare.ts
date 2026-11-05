/**
 * Entry points of the visual version diff (0.20, #121): choose the version (or two) to compare, read and parse only those, and
 * open the read-only diff dialog (view/version-diff-dialog.ts). Nothing is written here; the dialog's one writing action goes
 * through the open notebook's undo history.
 */
import { FuzzySuggestModal, type App, type FuzzyMatch, type TFile } from "obsidian";
import { t } from "../i18n";
import { parse } from "../model/serialize";
import type { NotebookDocument } from "../model/types";
import { formatSnapshotDate } from "../storage/history";
import { showNotice } from "../view/notice";
import { VersionDiffModal, type DiffRestoreTarget, type DiffSide } from "../view/version-diff-dialog";

/** One previous version of the open notebook (a version-history snapshot or a backup copy), not read yet. */
export interface CompareVersion {
	file: TFile;
	label: string;
	date: Date | null;
}

/** What the flow needs from the open notebook (NotebookView implements it, see ReliabilityView). */
export interface CompareView extends DiffRestoreTarget {
	readonly file: TFile | null;
	currentPage(): number;
}

class ComparePick extends FuzzySuggestModal<CompareVersion> {
	constructor(app: App, private readonly items: CompareVersion[], placeholder: string, private readonly onChoose: (item: CompareVersion) => void) {
		super(app);
		this.setPlaceholder(placeholder);
		this.emptyStateText = t("pageRestore.none");
	}

	getItems(): CompareVersion[] {
		return this.items;
	}

	getItemText(item: CompareVersion): string {
		return item.label;
	}

	renderSuggestion(match: FuzzyMatch<CompareVersion>, el: HTMLElement): void {
		el.createDiv({ text: match.item.label });
	}

	onChooseItem(item: CompareVersion): void {
		this.onChoose(item);
	}
}

/** Reads and parses one version; says why and gives null when it cannot be used for this notebook. */
async function readVersion(app: App, item: CompareVersion, docId: string): Promise<NotebookDocument | null> {
	const r = parse(await app.vault.read(item.file));
	if (!r.ok) {
		showNotice(t("pageRestore.unreadable"));
		return null;
	}
	if (r.doc.id !== docId) {
		showNotice(t("pageRestore.otherNotebook"));
		return null;
	}
	return r.doc;
}

const side = (item: CompareVersion, doc: NotebookDocument): DiffSide => ({ doc, label: item.date ? formatSnapshotDate(item.date) : item.label, date: item.date });

/**
 * "Compare with current" (`two` false): choose one version and see it against the open notebook. "Compare two versions": choose
 * two and see the earlier against the later. The open notebook, when it can be edited, is where "Restore this page" writes.
 */
export function openVersionCompare(app: App, view: CompareView, versions: CompareVersion[], two: boolean): void {
	const current = view.editableDocument();
	if (!view.file || !current) {
		showNotice(t("merge.notEditable"));
		return;
	}
	if (versions.length === 0 || (two && versions.length < 2)) {
		showNotice(t("pageRestore.none"));
		return;
	}
	const startPageId = current.pages[view.currentPage()]?.id ?? null;
	const fallbackIndex = view.currentPage();
	const run = async (first: CompareVersion, second: CompareVersion | null): Promise<void> => {
		try {
			showNotice(t("vdiff.reading"), 1500);
			const a = await readVersion(app, first, current.id);
			if (!a) return;
			if (!second) {
				new VersionDiffModal(app, {
					before: side(first, a), after: { doc: current, label: t("vdiff.current"), date: null }, afterIsCurrent: true, restore: view, startPageId, fallbackIndex,
				}).open();
				return;
			}
			const b = await readVersion(app, second, current.id);
			if (!b) return;
			// The earlier one is "before"; versions with no date keep the order they were chosen in.
			const swap = !!first.date && !!second.date && first.date.getTime() > second.date.getTime();
			const [x, y] = swap ? [side(second, b), side(first, a)] : [side(first, a), side(second, b)];
			new VersionDiffModal(app, { before: x, after: y, afterIsCurrent: false, restore: view, startPageId, fallbackIndex }).open();
		} catch (e) {
			showNotice(t("vdiff.failed", { error: (e as Error).message }));
		}
	};
	new ComparePick(app, versions, t("vdiff.pick.first"), (first) => {
		if (!two) {
			void run(first, null);
			return;
		}
		// Open the second list on the next turn: this modal is still closing.
		window.setTimeout(() => new ComparePick(app, versions.filter((v) => v !== first), t("vdiff.pick.second"), (second) => void run(first, second)).open(), 0);
	}).open();
}
