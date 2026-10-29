import { getFrontMatterInfo, normalizePath, Notice, parseYaml, stringifyYaml, TFile, type App, type Plugin, type TAbstractFile } from "obsidian";
import { t } from "../i18n";
import {
	COMPANION_ID_KEY, COMPANION_LINK_KEY, companionContent, mergeProperties, mergeRegion, newCompanionText, readRegionState, regionStatus,
	renderRegion, sameProperties, type CompanionContent,
} from "../model/companion-content";
import { parse } from "../model/serialize";
import type { NotebookDocument } from "../model/types";
import type { NotebookSettings } from "../settings";
import { companionCandidates, companionPath } from "../storage/companion-path";
import { isNotebookFile, readNotebookText } from "../storage/format";
import { ensureFolder } from "../storage/vault-io";
import { notebookUri } from "./links";
import { viewsOf } from "./open";

/**
 * Companion notes (O1): keeps a Markdown note per notebook in step with it. The content comes from the pure
 * generator in model/companion-content.ts, the location from storage/companion-path.ts; this class only
 * decides when to write, finds the note, and writes it through the Vault API.
 *
 * - Triggered by the notebook's own events (modify, file-open, create, rename, delete). Writes to `.md`
 *   files are never listened to, so the plugin's own writes (and the user's edits of the note) cannot start
 *   a regeneration, and the notebook file itself is never written here.
 * - Debounced per notebook, never while a pen (or finger, or mouse) is down in a notebook view or shortly
 *   after, and never when the result equals what the note already has.
 * - A note is "ours" only if its `notebook-id` property says so; a user's note with the same name is never
 *   taken over (the fallback name is used, or nothing is written).
 */

export interface CompanionHost extends Plugin {
	settings: NotebookSettings;
}

/** After a save of an open notebook. */
const LOCAL_DELAY_MS = 4_000;
/**
 * After a change to a notebook that is not open here (sync, library actions): long enough for the companion
 * written by the other device to arrive first, so the identical content found here causes no second write.
 */
const REMOTE_DELAY_MS = 30_000;
/** New notebook: lets "Duplicate" give the copy its own document id before the companion is made. */
const CREATE_DELAY_MS = 5_000;
/** Wait after the last pointer activity in a notebook view. */
const INPUT_QUIET_MS = 1_500;
const INPUT_POLL_MS = 1_000;
/** A pointer seen down this long without an up event is assumed lost. */
const STUCK_POINTER_MS = 15_000;

type UpdateResult = "created" | "updated" | "unchanged" | "skipped";

/** Pointer activity inside notebook views, from capture-phase listeners (passive: no effect on input). */
class InputWatch {
	private readonly down = new Map<number, number>();
	private last = 0;

	attach(plugin: Plugin, doc: Document): void {
		const inView = (e: Event) => e.target instanceof Element && e.target.closest(".notebook-view") !== null;
		const opts = { capture: true, passive: true };
		plugin.registerDomEvent(doc, "pointerdown", (e) => {
			if (!inView(e)) return;
			this.down.set(e.pointerId, Date.now());
			this.last = Date.now();
		}, opts);
		const up = (e: PointerEvent) => {
			if (this.down.delete(e.pointerId)) this.last = Date.now();
		};
		plugin.registerDomEvent(doc, "pointerup", up, opts);
		plugin.registerDomEvent(doc, "pointercancel", up, opts);
	}

	active(now = Date.now()): boolean {
		for (const [id, since] of this.down) if (now - since > STUCK_POINTER_MS) this.down.delete(id);
		return this.down.size > 0 || now - this.last < INPUT_QUIET_MS;
	}
}

export class CompanionService {
	private readonly timers = new Map<string, number>();
	private chain: Promise<unknown> = Promise.resolve();
	private readonly input = new InputWatch();
	/** Problems already reported this session (path + kind): one notice each. */
	private readonly reported = new Set<string>();
	private kept: string[] = [];
	private keptTimer: number | null = null;
	private disposed = false;

	constructor(private readonly plugin: CompanionHost) {}

	private get app(): App {
		return this.plugin.app;
	}

	private get enabled(): boolean {
		return this.plugin.settings.companionNotes && !this.disposed;
	}

	register(): void {
		const { plugin, app } = this;
		this.input.attach(plugin, document);
		plugin.registerEvent(app.workspace.on("window-open", (win) => this.input.attach(plugin, win.doc)));
		plugin.registerEvent(app.vault.on("modify", (f) => {
			if (f instanceof TFile && isNotebookFile(f)) this.schedule(f, viewsOf(app, f).length > 0 ? LOCAL_DELAY_MS : REMOTE_DELAY_MS);
		}));
		plugin.registerEvent(app.workspace.on("file-open", (f) => {
			if (f && isNotebookFile(f)) this.schedule(f, LOCAL_DELAY_MS);
		}));
		plugin.registerEvent(app.vault.on("rename", (f, oldPath) => {
			if (f instanceof TFile && isNotebookFile(f)) void this.enqueue(() => this.followRename(f, oldPath));
		}));
		plugin.registerEvent(app.vault.on("delete", (f) => this.onDelete(f)));
		// `create` also fires for every file while the vault loads: only listen once the layout is ready.
		app.workspace.onLayoutReady(() => {
			plugin.registerEvent(app.vault.on("create", (f) => {
				if (f instanceof TFile && isNotebookFile(f)) this.schedule(f, CREATE_DELAY_MS);
			}));
		});
		plugin.register(() => this.dispose());
	}

	dispose(): void {
		this.disposed = true;
		for (const handle of this.timers.values()) window.clearTimeout(handle);
		this.timers.clear();
		if (this.keptTimer !== null) window.clearTimeout(this.keptTimer);
	}

	/** (Re)starts the debounce of one notebook. */
	schedule(file: TFile, delayMs: number): void {
		if (!this.enabled) return;
		const path = file.path;
		const old = this.timers.get(path);
		if (old !== undefined) window.clearTimeout(old);
		this.timers.set(path, window.setTimeout(() => this.fire(path), delayMs));
	}

	private fire(path: string): void {
		this.timers.delete(path);
		if (!this.enabled) return;
		// Never while writing: the companion write (and the metadata indexing it starts) waits for a pause.
		if (this.input.active()) {
			this.timers.set(path, window.setTimeout(() => this.fire(path), INPUT_POLL_MS));
			return;
		}
		const file = this.app.vault.getFileByPath(path);
		if (file && isNotebookFile(file)) void this.enqueue(() => this.update(file));
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T | null> {
		const run = this.chain.then(fn, fn);
		this.chain = run.catch(() => undefined);
		return run.catch((e: unknown) => {
			console.error("[notebook] companion", e);
			this.report(`error:${String(e)}`, t("notice.companionFailed", { error: e instanceof Error ? e.message : String(e) }));
			return null;
		});
	}

	private report(key: string, message: string): void {
		if (this.reported.has(key)) return;
		this.reported.add(key);
		new Notice(message, 8000);
	}

	// ------------------------------------------------------------------- reading

	/** The document as the open view has it, else as saved; null if it cannot be read (never written then). */
	private async readDocument(file: TFile): Promise<NotebookDocument | null> {
		for (const { view } of viewsOf(this.app, file)) {
			if (view.document) return view.document;
		}
		const result = parse(readNotebookText(file.extension, await this.app.vault.cachedRead(file)));
		return result.ok ? result.doc : null;
	}

	private content(file: TFile, doc: NotebookDocument): CompanionContent {
		return companionContent(doc, { notebookPath: file.path, pageUri: (page) => notebookUri("", file.path, page) });
	}

	/** Frontmatter of a note's text; null when it is not valid YAML. */
	private frontmatter(text: string): Record<string, unknown> | null {
		const info = getFrontMatterInfo(text);
		if (!info.exists) return {};
		try {
			const data: unknown = parseYaml(info.frontmatter);
			if (data === null || data === undefined) return {};
			return typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
		} catch {
			return null;
		}
	}

	/** Frontmatter from the metadata cache (may lag behind the file by a moment). */
	private cachedFrontmatter(file: TFile | null): Record<string, unknown> | undefined {
		const fm: unknown = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
		return typeof fm === "object" && fm !== null ? (fm as Record<string, unknown>) : undefined;
	}

	/** Target of the companion's `notebook` link, when it resolves to a notebook file. */
	private linkedNotebook(fm: Record<string, unknown> | undefined, from: string): TFile | null {
		const link = fm?.[COMPANION_LINK_KEY];
		const m = typeof link === "string" ? /^\[\[([^\]|#]+)/.exec(link) : null;
		if (!m) return null;
		const f = this.app.metadataCache.getFirstLinkpathDest(m[1]!.trim(), from);
		return f && isNotebookFile(f) ? f : null;
	}

	/**
	 * The companion of `file`: the note at the configured path (or the fallback name) when it carries this
	 * notebook's id, or links to this notebook; else any note with this id (the user may have moved it, or the
	 * location setting changed) unless it belongs to another existing notebook (a copy with the same id).
	 * Otherwise the first free path to create it at, or null when both names are taken by the user's notes.
	 */
	private async locate(file: TFile, docId: string): Promise<{ file: TFile } | { create: string } | null> {
		const s = this.plugin.settings;
		let free: string | null = null;
		for (const raw of companionCandidates(file.path, s, s.folder)) {
			const path = normalizePath(raw);
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (!existing) {
				free ??= path;
				continue;
			}
			if (!(existing instanceof TFile)) continue;
			const fm = this.frontmatter(await this.app.vault.cachedRead(existing));
			const id = fm?.[COMPANION_ID_KEY];
			if (typeof id === "string" && (id === docId || this.linkedNotebook(fm ?? undefined, existing.path) === file)) return { file: existing };
		}
		for (const md of this.app.vault.getMarkdownFiles()) {
			const fm = this.cachedFrontmatter(md);
			if (fm?.[COMPANION_ID_KEY] !== docId) continue;
			const linked = this.linkedNotebook(fm, md.path);
			if (linked === null || linked === file) return { file: md };
		}
		return free === null ? null : { create: free };
	}

	// ------------------------------------------------------------------- writing

	/** Brings the companion of `file` up to date. Writes nothing when the note already matches. */
	async update(file: TFile): Promise<UpdateResult> {
		const doc = await this.readDocument(file);
		if (!doc) return "skipped";
		const content = this.content(file, doc);
		const region = renderRegion(content);
		const target = await this.locate(file, doc.id);
		if (!target) {
			const path = companionPath(file.path, this.plugin.settings, this.plugin.settings.folder);
			this.report(`taken:${path}`, t("notice.companionTaken", { path }));
			return "skipped";
		}

		if ("create" in target) {
			const dir = target.create.includes("/") ? target.create.slice(0, target.create.lastIndexOf("/")) : "";
			if (dir) await ensureFolder(this.app, dir);
			const yaml = stringifyYaml(mergeProperties({}, content, null));
			try {
				await this.app.vault.create(target.create, newCompanionText(yaml, region));
			} catch (e) {
				// Created in the meantime (sync, another trigger): the next change updates it.
				if (this.app.vault.getAbstractFileByPath(target.create)) return "skipped";
				throw e;
			}
			return "created";
		}

		const note = target.file;
		const text = await this.app.vault.read(note);
		const current = this.frontmatter(text);
		if (current === null) {
			this.report(`yaml:${note.path}`, t("notice.companionYaml", { path: note.path }));
			return "skipped";
		}
		if (regionStatus(text) === "broken") {
			this.report(`markers:${note.path}`, t("notice.companionBroken", { path: note.path }));
			return "skipped";
		}
		// What the last update owned: read before the region (which stores it) is rewritten.
		const previous = readRegionState(text);
		const nextProps = mergeProperties(current, content, previous);
		const propsChanged = !sameProperties(current, nextProps);
		const nextText = mergeRegion(text, region);
		const bodyChanged = nextText !== null && nextText !== text;
		if (!propsChanged && !bodyChanged) return "unchanged";

		if (bodyChanged) {
			await this.app.vault.process(note, (latest) => mergeRegion(latest, region) ?? latest);
		}
		if (propsChanged) {
			await this.app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
				const next = mergeProperties(fm, content, previous);
				if (sameProperties(fm, next)) return;
				for (const key of Object.keys(fm)) delete fm[key];
				Object.assign(fm, next);
			});
		}
		return "updated";
	}

	/** Renames the companion with its notebook when it sits at the configured place for the old path. */
	private async followRename(file: TFile, oldPath: string): Promise<void> {
		if (!this.enabled) return;
		const s = this.plugin.settings;
		const from = normalizePath(companionPath(oldPath, s, s.folder));
		const to = normalizePath(companionPath(file.path, s, s.folder));
		if (from !== to) {
			const note = this.app.vault.getFileByPath(from);
			const fm = this.cachedFrontmatter(note);
			const link = fm?.[COMPANION_LINK_KEY];
			// Obsidian may already have rewritten the link (in its own link format) when this runs.
			const oldName = oldPath.slice(oldPath.lastIndexOf("/") + 1);
			const ours = typeof fm?.[COMPANION_ID_KEY] === "string" && typeof link === "string"
				&& (link.includes(oldPath) || link.includes(oldName) || this.linkedNotebook(fm, from) === file);
			if (note && ours && !this.app.vault.getAbstractFileByPath(to)) {
				const dir = to.includes("/") ? to.slice(0, to.lastIndexOf("/")) : "";
				if (dir) await ensureFolder(this.app, dir);
				// fileManager: links to the companion in other notes follow the rename.
				await this.app.fileManager.renameFile(note, to);
			}
		}
		this.schedule(file, LOCAL_DELAY_MS);
	}

	/** The companion is never deleted with its notebook (it may hold the user's own writing): say where it is. */
	private onDelete(f: TAbstractFile): void {
		if (!this.enabled || !(f instanceof TFile) || !isNotebookFile(f)) return;
		const pending = this.timers.get(f.path);
		if (pending !== undefined) window.clearTimeout(pending);
		this.timers.delete(f.path);
		const s = this.plugin.settings;
		const path = companionCandidates(f.path, s, s.folder).map(normalizePath).find((p) => {
			return typeof this.cachedFrontmatter(this.app.vault.getFileByPath(p))?.[COMPANION_ID_KEY] === "string";
		});
		if (!path) return;
		this.kept.push(path);
		if (this.keptTimer !== null) window.clearTimeout(this.keptTimer);
		this.keptTimer = window.setTimeout(() => {
			this.keptTimer = null;
			const kept = this.kept;
			this.kept = [];
			new Notice(kept.length === 1 ? t("notice.companionKept", { path: kept[0]! }) : t("notice.companionKeptMany", { n: String(kept.length) }), 8000);
		}, 500);
	}

	// ------------------------------------------------------------------- commands

	/** Creates or updates the companion of every notebook in the vault, one at a time. */
	async updateAll(): Promise<void> {
		if (!this.plugin.settings.companionNotes) {
			new Notice(t("notice.companionOff"));
			return;
		}
		const files = this.app.vault.getFiles().filter((f) => isNotebookFile(f));
		const counts: Record<UpdateResult, number> = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
		for (const file of files) {
			while (this.input.active() && !this.disposed) await sleep(INPUT_POLL_MS);
			if (this.disposed) return;
			const result = await this.enqueue(() => this.update(file));
			counts[result ?? "skipped"]++;
		}
		new Notice(t("notice.companionDone", {
			created: String(counts.created), updated: String(counts.updated), unchanged: String(counts.unchanged), skipped: String(counts.skipped),
		}));
	}

	/** Brings the companion of `file` up to date now and opens it in a new tab. */
	async open(file: TFile): Promise<void> {
		if (!this.plugin.settings.companionNotes) {
			new Notice(t("notice.companionOff"));
			return;
		}
		const doc = await this.readDocument(file);
		if (!doc) return;
		await this.enqueue(() => this.update(file));
		const found = await this.locate(file, doc.id);
		if (found && "file" in found) await this.app.workspace.getLeaf("tab").openFile(found.file);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Registers the companion service, its events and commands. Called once from registerIntegration. */
export function registerCompanion(plugin: CompanionHost): CompanionService {
	const service = new CompanionService(plugin);
	service.register();
	services.set(plugin, service);
	plugin.addCommand({ id: "companion-update-all", name: t("command.companionUpdateAll"), callback: () => void service.updateAll() });
	plugin.addCommand({
		id: "companion-open",
		name: t("command.companionOpen"),
		checkCallback: (checking) => {
			const file = plugin.app.workspace.getActiveFile();
			if (!file || !isNotebookFile(file)) return false;
			if (!checking) void service.open(file);
			return true;
		},
	});
	return service;
}

const services = new WeakMap<Plugin, CompanionService>();

/** The service of a plugin, for the settings tab. */
export function companionService(plugin: Plugin): CompanionService | undefined {
	return services.get(plugin);
}
