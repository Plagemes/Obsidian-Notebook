import type { PressureMode } from "./ink/pressure";
import { PAGE_SIZES, PAPER_KINDS, type PageSizeName, type PaperKind } from "./model/types";

export interface NotebookSettings {
	folder: string;
	fingerDrawing: boolean;
	palmRejectionMs: number;
	pressureMode: PressureMode;
	prediction: boolean;
	/** 0–10, see Stabilizer. */
	stabilization: number;
	/** Touch contacts larger than this (CSS px) are ignored as palms; 0 = off. */
	palmContactPx: number;
	perfOverlay: boolean;
	/** Defaults for new notebooks; the "New notebook" dialog remembers the last choice. */
	defaultPaper: PaperKind;
	defaultPageSize: PageSizeName;
	defaultLandscape: boolean;
}

export const DEFAULT_SETTINGS: NotebookSettings = {
	folder: "Notebooks",
	fingerDrawing: false,
	palmRejectionMs: 500,
	pressureMode: "auto",
	prediction: true,
	stabilization: 2,
	palmContactPx: 0,
	perfOverlay: false,
	defaultPaper: "grid",
	defaultPageSize: "a4",
	defaultLandscape: false,
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
	if (typeof d.prediction === "boolean") s.prediction = d.prediction;
	if (typeof d.stabilization === "number" && d.stabilization >= 0 && d.stabilization <= 10) s.stabilization = d.stabilization;
	if (typeof d.palmContactPx === "number" && d.palmContactPx >= 0 && d.palmContactPx <= 200) s.palmContactPx = d.palmContactPx;
	if (typeof d.perfOverlay === "boolean") s.perfOverlay = d.perfOverlay;
	if (PAPER_KINDS.includes(d.defaultPaper as PaperKind)) s.defaultPaper = d.defaultPaper as PaperKind;
	if (typeof d.defaultPageSize === "string" && d.defaultPageSize in PAGE_SIZES) s.defaultPageSize = d.defaultPageSize as PageSizeName;
	if (typeof d.defaultLandscape === "boolean") s.defaultLandscape = d.defaultLandscape;
	return s;
}

export function backupFolder(settings: NotebookSettings): string {
	return `${settings.folder.replace(/\/+$/, "")}/_backup`;
}
