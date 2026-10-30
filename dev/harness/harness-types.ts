/**
 * What the harness checks (readonly-check, excerpt-check, nav-check, practice-check, reading-check) touch of the
 * notebook view and of the stand-in app. The view's own members are private to its class, so the checks are written
 * against these small interfaces and the harness lends the real view as a `HarnessView`.
 */

import type { Command } from "../../src/model/history";
import type { NotebookDocument } from "../../src/model/types";
import type { EditContext } from "../../src/view/edit-context";
import type { exportPngPages } from "../../src/view/export-png";

/** The settings the checks switch while they run. */
export interface HarnessSettings {
	fastScrollbar: boolean;
	snapHighlighter: boolean;
	fingerDrawing: boolean;
	dimBackground: boolean;
	dimStrength: number;
}

/** What `uiContext()` reports. */
export interface HarnessUiContext {
	editable: boolean;
	tool: string;
	toggles: { readOnly: boolean };
	selection?: { excerpts?: number } | null;
	nav?: { back: boolean; forward: boolean } | null;
}

export interface HarnessSheet {
	close(): void;
	isOpen: boolean;
}

export interface HarnessReadingTools {
	annotationsHidden: boolean;
	openSearch(): void;
	closeSearch(): void;
	step(delta: number): void;
	settingsChanged(): void;
	toggleAnnotations(): void;
	toggleDim(): void;
}

export interface HarnessViewport {
	offsetX: number;
	offsetY: number;
	scale: number;
}

/** A row of the go-to-page picker. */
export interface HarnessPickerRow {
	index: number;
	label: string;
}

/** The go-to-page picker (a `SuggestModal`) as the excerpt check drives it. */
export interface HarnessPicker {
	getSuggestions(query: string): HarnessPickerRow[];
	close(): void;
	onChooseSuggestion(row: HarnessPickerRow | undefined): void;
}

export interface HarnessView {
	document: NotebookDocument;
	session: { doc: NotebookDocument; isSaved(): boolean };
	history: { canUndo(): boolean; execute(command: Command): void };
	host: { settings: HarnessSettings };
	ui: { sheet: HarnessSheet };
	readOnlyMode: boolean;
	viewport: HarnessViewport;
	layout: { boxes: Array<{ x: number; y: number }> };
	readingTools: HarnessReadingTools;
	excerptTools: { armed: string | null; excerptToPage(): void };
	markerTools: { armed: string | null; arm(kind: string): void };
	renderer: { invalidate(): void };
	mediaCache: Parameters<typeof exportPngPages>[3];
	toolbar: { quickIds: string[] };
	pageNav: { open: boolean };
	scrollbar: { el: HTMLElement };
	/** Patched by the navigation check while it counts thumbnails. */
	thumbnail: (...args: unknown[]) => unknown;

	uiContext(): HarnessUiContext;
	currentPage(): number;
	flushNow(): Promise<void>;
	runAction(id: string): void;
	undo(): void;
	redo(): void;
	addPage(): void;
	removeSelection(): void;
	clearSelection(): void;
	applyCommand(command: Command): void;
	toggleNavigator(): void;
	setReadOnlyMode(on: boolean, notify: boolean): void;
	openExportDialog(first: undefined, format: string): void;
	refreshUi(): void;
	applySettings(settings: HarnessSettings): void;
	scrollToPage(index: number): void;
	jumpToPage(index: number): void;
	goToRelativePage(delta: number): void;
	afterHistoryChange(): void;
	editContext(): EditContext;
}

/** A file of the stand-in vault. */
export interface HarnessFile {
	path: string;
}

/** The part of the stand-in vault the checks read. */
export interface HarnessVault {
	getFiles(): HarnessFile[];
	getFileByPath(path: string): HarnessFile | null;
	readBinary(file: HarnessFile): Promise<ArrayBuffer>;
}

export interface HarnessApp {
	vault: HarnessVault;
}
