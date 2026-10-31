/**
 * The creation dialog's rules (view/create-dialog.ts), kept pure so they are tested in Node: names, page sizes, folder
 * lists and what a new notebook's document holds. No 'obsidian' import.
 */
import { createDocument } from "../model/document";
import {
	META_DESCRIPTION_MAX, MM, PAGE_SIZES, PAPER_SPACING, type CoverArt, type NotebookDocument, type PageSizeName,
	type PaperKind,
} from "../model/types";
import { COVER_FAMILIES, encodeCoverArt, type CoverFamily } from "../model/cover-family";
import { isReservedPath, RESERVED_FOLDERS } from "../library/folders";
import { hasTrailingDotOrSpace, isDeviceName, sanitizeName } from "../storage/names";

/** Characters Obsidian does not allow in file and folder names, plus those that break links (as storage/names.ts). */
export const FORBIDDEN_NAME_CHARS = /[\\/:*?"<>|#^[\]]/;
/** Longest name accepted, in characters (file systems allow 255 bytes; this leaves room for the extension and UTF-8). */
export const MAX_NAME = 120;

/**
 * Folders the plugin keeps its own files in, directly under the notebooks folder: the library's reserved folders and the
 * stamps folder (ink/stamps.ts STAMPS_DIRNAME). Compared ignoring case.
 */
export const STORE_FOLDERS: readonly string[] = [...RESERVED_FOLDERS, "_stamps"];

export type NameProblem = "empty" | "chars" | "dot" | "trailing" | "device" | "reserved" | "long" | "exists";

/**
 * Why `name` cannot be used for a new notebook or folder (null when it can). The checks run on the name as it will be
 * created (`sanitizeName`), so `exists` (whether that name is taken) asks about the real path. `atRoot`: the parent is the
 * notebooks folder, where the plugin's own store folders cannot be taken.
 */
export function nameProblem(name: string, exists: (clean: string) => boolean, atRoot = false): NameProblem | null {
	const clean = name.trim();
	if (clean === "") return "empty";
	if (FORBIDDEN_NAME_CHARS.test(clean)) return "chars";
	if (clean.startsWith(".")) return "dot";
	const created = sanitizeName(clean);
	if (hasTrailingDotOrSpace(created)) return "trailing";
	if (isDeviceName(created)) return "device";
	if (atRoot && STORE_FOLDERS.some((f) => f.toLowerCase() === created.toLowerCase())) return "reserved";
	if (created.length > MAX_NAME) return "long";
	if (exists(created)) return "exists";
	return null;
}

/** Whether `folder` is the notebooks folder `root` (vault paths; "" or "/" is the vault root). */
export function isRootFolder(folder: string, root: string): boolean {
	const norm = (p: string) => p.replace(/^\/+|\/+$/g, "");
	return norm(folder) === norm(root);
}

/** `parent/name` with "" or "/" as the vault root. */
export function joinPath(parent: string, name: string): string {
	const p = parent.replace(/^\/+|\/+$/g, "");
	return p ? `${p}/${name}` : name;
}

/** The page size presets in the order the dialog shows them. */
export const SIZE_CHOICES: readonly PageSizeName[] = ["a4", "a5", "b5", "letter"];
export type SizeChoice = PageSizeName | "custom";

/** Bounds of a custom page side, in mm. */
export const CUSTOM_MIN_MM = 50;
export const CUSTOM_MAX_MM = 1000;

/** A custom side in mm, or null when it is not a number within the bounds. */
export function customSide(text: string): number | null {
	const v = Number(text.replace(",", ".").trim());
	if (!Number.isFinite(v) || v < CUSTOM_MIN_MM || v > CUSTOM_MAX_MM) return null;
	return Math.round(v * 10) / 10;
}

/**
 * Page size in pt: a preset (portrait, swapped for landscape) or a custom width × height in mm exactly as typed (the
 * dialog keeps the orientation in step with the typed numbers: see customOrientation and orientCustom).
 */
export function pageSize(choice: SizeChoice, landscape: boolean, customMm: { width: number; height: number }): { width: number; height: number } {
	if (choice === "custom") return { width: Math.round(customMm.width * MM * 100) / 100, height: Math.round(customMm.height * MM * 100) / 100 };
	const base = PAGE_SIZES[choice];
	const short = Math.min(base.width, base.height);
	const long = Math.max(base.width, base.height);
	return landscape ? { width: long, height: short } : { width: short, height: long };
}

/** The orientation typed custom sides show: landscape when wider than tall, portrait when taller, else `current`. */
export function customOrientation(widthMm: number, heightMm: number, current: boolean): boolean {
	if (widthMm > heightMm) return true;
	if (widthMm < heightMm) return false;
	return current;
}

/**
 * The custom side fields (as typed) for `landscape`: swapped when the user picks the other orientation (`toggled`), or,
 * when the dialog switches to a custom size, swapped only if their numbers show the other orientation.
 */
export function orientCustom(fields: { width: string; height: string }, landscape: boolean, toggled: boolean): { width: string; height: string } {
	const swapped = { width: fields.height, height: fields.width };
	if (toggled) return swapped;
	const w = customSide(fields.width);
	const h = customSide(fields.height);
	if (w === null || h === null || w === h) return fields;
	return customOrientation(w, h, landscape) === landscape ? fields : swapped;
}

/** Folders a new notebook or folder can go in: the notebooks folder and every folder under it but the reserved ones, sorted. */
export function folderChoices(root: string, allFolders: readonly string[]): string[] {
	const r = root.replace(/^\/+|\/+$/g, "");
	const out = new Set<string>([r]);
	for (const p of allFolders) {
		if (p === "" || p === "/") continue;
		if (r !== "" && p !== r && !p.startsWith(`${r}/`)) continue;
		if (isReservedPath(p, r)) continue;
		out.add(p);
	}
	return [...out].sort((a, b) => (a === r ? -1 : b === r ? 1 : a.localeCompare(b)));
}

/** The folder the dialog starts in: the one asked for, else the last used, else the notebooks folder (each only if it is a choice). */
export function startFolder(choices: readonly string[], wanted: string | undefined, last: string | null): string {
	const norm = (p: string | null | undefined) => (p ?? "").replace(/^\/+|\/+$/g, "");
	if (wanted !== undefined && choices.includes(norm(wanted))) return norm(wanted);
	if (last !== null && choices.includes(norm(last))) return norm(last);
	return choices[0] ?? "";
}

/** Depth of `path` below `root` (0 for the root), for the indentation of the folder list. */
export function depthBelow(root: string, path: string): number {
	const r = root.replace(/^\/+|\/+$/g, "");
	if (path === r) return 0;
	const rel = r === "" ? path : path.slice(r.length + 1);
	return rel.split("/").length;
}

/** The next art style after `style` (the cover and folder previews cycle through them). */
export function nextArtStyle(style: CoverFamily): CoverFamily {
	const i = COVER_FAMILIES.indexOf(style);
	return COVER_FAMILIES[(i + 1) % COVER_FAMILIES.length]!;
}

/** What the dialog's Notebook tab decided. */
export interface NotebookSpec {
	name: string;
	description: string;
	folder: string;
	paper: PaperKind;
	size: SizeChoice;
	customMm: { width: number; height: number };
	landscape: boolean;
	/** Cover colour `#rrggbb` (meta.cover). */
	color: string;
	/** Generated art; an image cover is stored by the host (it needs the vault) and replaces it. */
	art: { style: CoverFamily; seed: string };
}

/** The document of a new notebook made from blank pages: one page of the chosen paper and size, with its metadata. */
export function notebookDocument(spec: NotebookSpec, now: Date = new Date()): NotebookDocument {
	const doc = createDocument(now, pageSize(spec.size, spec.landscape, spec.customMm), { kind: spec.paper, spacing: PAPER_SPACING[spec.paper] });
	applyNotebookMeta(doc, spec);
	return doc;
}

/** Sets the colour, description and generated cover of `spec` on `doc` (also for a document made from a template). */
export function applyNotebookMeta(doc: NotebookDocument, spec: Pick<NotebookSpec, "color" | "description" | "art">, cover?: CoverArt): void {
	const meta = doc.meta!;
	meta.cover = spec.color;
	const description = spec.description.trim().slice(0, META_DESCRIPTION_MAX);
	if (description) meta.description = description;
	else delete meta.description;
	meta.coverArt = cover ?? { kind: "art", ...encodeCoverArt(spec.art.style, spec.art.seed) };
}
