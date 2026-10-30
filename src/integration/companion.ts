import { getFrontMatterInfo, normalizePath, Notice, parseYaml, stringifyYaml, TFile, type App, type Plugin, type TAbstractFile } from "obsidian";
import { t } from "../i18n";
import {
	COMPANION_ID_KEY, COMPANION_LINK_KEY, companionClaim, companionContent, mergeProperties, newCompanionText, renderRegion, updateCompanionText,
	type CompanionContent, type CompanionTextDeps,
} from "../model/companion-content";
import { parse } from "../model/serialize";
import type { NotebookDocument } from "../model/types";
import type { NotebookSettings } from "../settings";
import { companionCandidates, companionPath } from "../storage/companion-path";
import { isNotebookFile, readNotebookText } from "../storage/format";
import { quickDocId } from "../storage/history";
import { isInTrash, isWithin, templatesFolderPath } from "../storage/trash-paths";
import { ensureFolder } from "../storage/vault-io";
import { isCardFrontmatter } from "../zettel/card-content";
import { notebookUri } from "./links";
import { viewsOf } from "./open";
import { isOpenInSafeMode } from "../storage/safe-mode";

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

/** After this device's own save of an open notebook. */
const LOCAL_DELAY_MS = 4_000;
/**
 * After any other change (sync, another app, library actions) and after opening a notebook: long enough for the
 * companion written by the other device to arrive first, so the identical content found here causes no second write
 * (two devices writing the same note make the sync client create conflicted copies).
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
export class InputWatch {
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
			if (f instanceof TFile && isNotebookFile(f)) void this.afterModify(f);
		}));
		plugin.registerEvent(app.workspace.on("file-open", (f) => {
			// Opening is no change: wait as for a remote one (a synced version may be arriving with its companion);
			// update() then writes only if the note really differs.
			if (f && isNotebookFile(f)) this.schedule(f, REMOTE_DELAY_MS);
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

	/** A notebook file changed: the short delay only for the echo of this device's own save. */
	private async afterModify(file: TFile): Promise<void> {
		if (!this.enabled) return;
		this.schedule(file, (await this.isOwnSave(file)) ? LOCAL_DELAY_MS : REMOTE_DELAY_MS);
	}

	/** Whether the file now holds what a view of it on this device wrote (not a change from sync or another app). */
	private async isOwnSave(file: TFile): Promise<boolean> {
		const views = viewsOf(this.app, file);
		if (views.length === 0) return false;
		try {
			const text = readNotebookText(file.extension, await this.app.vault.cachedRead(file));
			return views.some(({ view }) => view.isOwnWrite(text));
		} catch {
			return false;
		}
	}

	private fire(path: string): void {
		this.timers.delete(path);
		// wave 0.7: resilience (#346): no companion note while the notebook is shown in safe mode.
		if (!this.enabled || isOpenInSafeMode(path)) return;
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
		return info.exists ? parseFrontmatterYaml(info.frontmatter) : {};
	}

	/** Frontmatter from the metadata cache (may lag behind the file by a moment). */
	private cachedFrontmatter(file: TFile | null): Record<string, unknown> | undefined {
		const fm: unknown = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
		return typeof fm === "object" && fm !== null ? (fm as Record<string, unknown>) : undefined;
	}

	/** Where a note's `notebook` link points, seen from `file`. */
	private linkState(fm: Record<string, unknown> | undefined, from: string, file: TFile): "this" | "other" | "none" {
		const linked = this.linkedNotebook(fm, from);
		return linked === null ? "none" : linked === file ? "this" : "other";
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
	 * Whether a notebook other than `file` holds the document id `docId` (a file copy keeps the id). Looks at the
	 * start of each file, where the serializer puts the id, and parses the whole file only when it is not there.
	 */
	private async otherNotebookHasId(file: TFile, docId: string): Promise<boolean> {
		for (const f of this.app.vault.getFiles()) {
			if (f === file || !isNotebookFile(f) || this.isInternal(f.path)) continue;
			try {
				if (quickDocId(readNotebookText(f.extension, await this.app.vault.cachedRead(f))) === docId) return true;
			} catch {
				// Unreadable here: it cannot claim the note either.
			}
		}
		return false;
	}

	/**
	 * The companion of `file`: the note at the configured path (or the fallback name) when it links to this notebook,
	 * or carries this notebook's id and its link resolves to no notebook (the configured path is derived from this
	 * notebook's own path); else any note whose link resolves to this notebook, or (only when no other notebook in
	 * the vault has the same id) a note with this id whose link resolves to nothing: the user moved the note, or the
	 * notebook was renamed outside Obsidian. A file copy of a notebook (same id) therefore never takes over the
	 * original's note. Otherwise the first free path to create it at, or null when both names are taken by the user's notes.
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
			if (typeof id !== "string" || isCardFrontmatter(fm)) continue;
			// At this notebook's own path: "if-unique" cannot come back.
			if (companionClaim(this.linkState(fm ?? undefined, existing.path, file), id === docId, true) === "yes") return { file: existing };
		}
		let others: boolean | null = null;
		for (const md of this.app.vault.getMarkdownFiles()) {
			const fm = this.cachedFrontmatter(md);
			if (fm?.[COMPANION_ID_KEY] !== docId || isCardFrontmatter(fm)) continue;
			const claim = companionClaim(this.linkState(fm, md.path, file), true, false);
			if (claim === "yes") return { file: md };
			if (claim === "no") continue;
			others ??= await this.otherNotebookHasId(file, docId);
			if (!others) return { file: md };
		}
		return free === null ? null : { create: free };
	}

	/** Trashed notebooks and templates (roadmap #160, #74) get no companion note, and never claim one. */
	private isInternal(path: string): boolean {
		const s = this.plugin.settings;
		return isInTrash(path) || isWithin(path, templatesFolderPath(s.templatesFolder, s.folder));
	}

	/** Brings the companion of `file` up to date. Writes nothing when the note already matches. */
	async update(file: TFile): Promise<UpdateResult> {
		if (this.isInternal(file.path)) return "skipped";
		const doc = await this.readDocument(file);
		if (!doc) return "skipped";
		const content = this.content(file, doc);
		// A new note owns every tag it gets; an existing one records which tags the plugin added (model/tags.ts).
		const region = (owned: readonly string[]) => renderRegion(content, owned);
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
				await this.app.vault.create(target.create, newCompanionText(yaml, region(content.tags)));
			} catch (e) {
				// Created in the meantime (sync, another trigger): the next change updates it.
				if (this.app.vault.getAbstractFileByPath(target.create)) return "skipped";
				throw e;
			}
			return "created";
		}

		const note = target.file;
		const text = await this.app.vault.read(note);
		const planned = updateCompanionText(text, content, region, TEXT_DEPS);
		if (planned.kind === "yaml") {
			this.report(`yaml:${note.path}`, t("notice.companionYaml", { path: note.path }));
			return "skipped";
		}
		if (planned.kind === "markers") {
			this.report(`markers:${note.path}`, t("notice.companionBroken", { path: note.path }));
			return "skipped";
		}
		if (planned.kind === "unchanged") return "unchanged";

		// One write for frontmatter and region, on the note as it is at that moment (the user may have just typed in it).
		let written = false;
		await this.app.vault.process(note, (latest) => {
			const next = latest === text ? planned : updateCompanionText(latest, content, region, TEXT_DEPS);
			if (next.kind !== "changed") return latest;
			written = true;
			return next.text;
		});
		return written ? "updated" : "unchanged";
	}

	/** Renames the companion with its notebook when it sits at the configured place for the old path. */
	private async followRename(file: TFile, oldPath: string): Promise<void> {
		if (this.isInternal(file.path)) return;
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
		const files = this.app.vault.getFiles().filter((f) => isNotebookFile(f) && !this.isInternal(f.path));
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

/** A frontmatter block as an object; null when it is not valid YAML or not a mapping. */
function parseFrontmatterYaml(yaml: string): Record<string, unknown> | null {
	try {
		const data: unknown = parseYaml(yaml);
		if (data === null || data === undefined) return {};
		return typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

const TEXT_DEPS: CompanionTextDeps = {
	frontmatterInfo: (text) => getFrontMatterInfo(text),
	parseFrontmatter: parseFrontmatterYaml,
	stringify: (data) => stringifyYaml(data),
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Registers the companion service, its events and commands. Called once from registerIntegration. */
export function registerCompanion(plugin: CompanionHost): CompanionService {
	const service = new CompanionService(plugin);
	service.register();
	services.set(plugin, service);
	current = service;
	plugin.register(() => {
		if (current === service) current = undefined;
	});
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
let current: CompanionService | undefined;

/** The running companion service (there is one plugin instance), for the tag editor; undefined before onload or after unload. */
export function activeCompanion(): CompanionService | undefined {
	return current;
}

/** The service of a plugin, for the settings tab. */
export function companionService(plugin: Plugin): CompanionService | undefined {
	return services.get(plugin);
}
