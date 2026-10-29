import type { PressureMode } from "./ink/pressure";
import { DEFAULT_ERASER_SIZE, DEFAULT_FAVOURITES, normaliseEraserSize, normaliseFavourites, type FavouritePen } from "./view/favourites";
import { PAGE_SIZES, PAPER_KINDS, type PageSizeName, type PaperKind } from "./model/types";

export interface NotebookSettings {
	folder: string;
	fingerDrawing: boolean;
	palmRejectionMs: number;
	pressureMode: PressureMode;
	/**
	 * Draw the browser's predicted pen samples at the tip of the wet ink (never stored). Replaces the
	 * old `prediction` key (default on), so the new default (off) applies to everyone.
	 */
	inkPrediction: boolean;
	/**
	 * Experimental low-latency ink: the pen's wet canvas asks for a `desynchronized` context and
	 * `pointerrawupdate` is listened to. Off by default: on some Android GPUs a desynchronized canvas
	 * is composited as an opaque layer. Ink is painted in the input handler either way.
	 */
	lowLatencyInk: boolean;
	/** 0–10: strength of the adaptive position filter (one-euro.ts); 0 turns it off. */
	stabilization: number;
	/** Touch contacts larger than this (CSS px) are ignored as palms; 0 = off. */
	palmContactPx: number;
	perfOverlay: boolean;
	/** Defaults for new notebooks; the "New notebook" dialog remembers the last choice. */
	defaultPaper: PaperKind;
	defaultPageSize: PageSizeName;
	defaultLandscape: boolean;
	/** Version history: at most one snapshot per notebook per this many hours; 0 turns snapshots off. */
	snapshotIntervalHours: number;
	/** Version history: how many snapshots to keep per notebook. */
	snapshotsToKeep: number;
	/** Writing near the bottom of the last page appends a page (same size and paper). Not for infinite pages. */
	autoNextPage: boolean;
	/** The eraser's Area mode also removes the text boxes and images inside the outline. */
	eraseAreaElements: boolean;
	/** Favourite pens (six slots: tool, colour, width). */
	favouritePens: FavouritePen[];
	/** Eraser radius, CSS px. */
	eraserSize: number;
	/** Vault path of the loose sheet (quick notes) notebook; empty = `<notebooks folder>/Quick notes.notebook`. */
	looseSheetPath: string;
}

export const DEFAULT_SETTINGS: NotebookSettings = {
	folder: "Notebooks",
	fingerDrawing: false,
	palmRejectionMs: 500,
	pressureMode: "auto",
	inkPrediction: false,
	lowLatencyInk: false,
	stabilization: 2,
	palmContactPx: 0,
	perfOverlay: false,
	defaultPaper: "grid",
	defaultPageSize: "a4",
	defaultLandscape: false,
	snapshotIntervalHours: 24,
	snapshotsToKeep: 10,
	autoNextPage: true,
	eraseAreaElements: false,
	favouritePens: DEFAULT_FAVOURITES.map((f) => ({ ...f })),
	eraserSize: DEFAULT_ERASER_SIZE,
	looseSheetPath: "",
};

/** Merges saved data over the defaults, ignoring values of the wrong type. */
export function readSettings(data: unknown): NotebookSettings {
	const s = { ...DEFAULT_SETTINGS };
	if (typeof data !== "object" || data === null) return s;
	const d = data as Record<string, unknown>;
	if (typeof d.folder === "string" && d.folder.trim()) s.folder = d.folder.trim();
	if (typeof d.fingerDrawing === "boolean") s.fingerDrawing = d.fingerDrawing;
	if (typeof d.palmRejectionMs === "number" && d.palmRejectionMs >= 0 && d.palmRejectionMs <= 5000) s.palmRejectionMs = d.palmRejectionMs;
	if (d.pressureMode === "auto" || d.pressureMode === "simulated") s.pressureMode = d.pressureMode;
	if (typeof d.inkPrediction === "boolean") s.inkPrediction = d.inkPrediction;
	if (typeof d.lowLatencyInk === "boolean") s.lowLatencyInk = d.lowLatencyInk;
	if (typeof d.stabilization === "number" && d.stabilization >= 0 && d.stabilization <= 10) s.stabilization = d.stabilization;
	if (typeof d.palmContactPx === "number" && d.palmContactPx >= 0 && d.palmContactPx <= 200) s.palmContactPx = d.palmContactPx;
	if (typeof d.perfOverlay === "boolean") s.perfOverlay = d.perfOverlay;
	if (PAPER_KINDS.includes(d.defaultPaper as PaperKind)) s.defaultPaper = d.defaultPaper as PaperKind;
	if (typeof d.defaultPageSize === "string" && Object.prototype.hasOwnProperty.call(PAGE_SIZES, d.defaultPageSize)) s.defaultPageSize = d.defaultPageSize as PageSizeName;
	if (typeof d.defaultLandscape === "boolean") s.defaultLandscape = d.defaultLandscape;
	if (typeof d.snapshotIntervalHours === "number" && d.snapshotIntervalHours >= 0 && d.snapshotIntervalHours <= 720) s.snapshotIntervalHours = d.snapshotIntervalHours;
	if (typeof d.snapshotsToKeep === "number" && Number.isInteger(d.snapshotsToKeep) && d.snapshotsToKeep >= 1 && d.snapshotsToKeep <= 100) s.snapshotsToKeep = d.snapshotsToKeep;
	if (typeof d.autoNextPage === "boolean") s.autoNextPage = d.autoNextPage;
	if (typeof d.eraseAreaElements === "boolean") s.eraseAreaElements = d.eraseAreaElements;
	s.favouritePens = normaliseFavourites(d.favouritePens);
	s.eraserSize = normaliseEraserSize(d.eraserSize);
	if (typeof d.looseSheetPath === "string") s.looseSheetPath = d.looseSheetPath.trim();
	return s;
}

export function backupFolder(settings: NotebookSettings): string {
	return `${settings.folder.replace(/\/+$/, "")}/_backup`;
}
