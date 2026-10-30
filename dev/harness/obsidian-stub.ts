/**
 * Minimal stand-in for the `obsidian` module, for the browser harness only (dev/harness). It is
 * aliased in place of `obsidian` by dev/harness/build.mjs and never ships in main.js.
 *
 * It implements just what the notebook view touches: views, an in-memory vault, notices, menus,
 * modals, settings rows, icons, and Obsidian's DOM helpers on HTMLElement.prototype.
 */
import { drawIcon } from "./icons";

// --- DOM helpers (Obsidian adds these to Node/HTMLElement/Document) ---

interface DomInfo {
	cls?: string | string[];
	text?: string;
	attr?: Record<string, string | number | boolean | null>;
	title?: string;
	type?: string;
	value?: string;
	placeholder?: string;
	href?: string;
	parent?: HTMLElement;
	prepend?: boolean;
}

function applyInfo(el: HTMLElement, o?: DomInfo | string): void {
	if (o === undefined) return;
	if (typeof o === "string") {
		el.className = o;
		return;
	}
	if (o.cls) el.classList.add(...(Array.isArray(o.cls) ? o.cls : o.cls.split(/\s+/)).filter(Boolean));
	if (o.text !== undefined) el.textContent = o.text;
	if (o.title !== undefined) el.title = o.title;
	if (o.attr) for (const [k, v] of Object.entries(o.attr)) if (v !== null && v !== false) el.setAttribute(k, String(v));
	if (o.type !== undefined) el.setAttribute("type", o.type);
	if (o.value !== undefined) (el as HTMLInputElement).value = o.value;
	if (o.placeholder !== undefined) el.setAttribute("placeholder", o.placeholder);
	if (o.href !== undefined) el.setAttribute("href", o.href);
}

/** The document API the DOM helpers are built on (the helpers themselves cannot use createEl). */
interface DomFactory {
	createElement(tag: string): HTMLElement;
	createElementNS(ns: "http://www.w3.org/2000/svg", tag: string): SVGElement;
	createDocumentFragment(): DocumentFragment;
}
const dom: DomFactory = window.document;

function createElIn(parent: Node | null, tag: string, o?: DomInfo | string, cb?: (el: HTMLElement) => void): HTMLElement {
	// This is the implementation of createEl: it builds the element with the document API.
	const el = dom.createElement(tag);
	applyInfo(el, o);
	if (typeof o === "object" && o.parent) o.parent.appendChild(el);
	else if (parent) {
		if (typeof o === "object" && o.prepend) parent.insertBefore(el, parent.firstChild);
		else parent.appendChild(el);
	}
	cb?.(el);
	return el;
}

function setAttr(el: Element, k: string, v: string | number | boolean | null): void {
	if (v === null) el.removeAttribute(k);
	else el.setAttribute(k, String(v));
}

/** A prototype that receives the helpers (they are not in the DOM typings of the harness build). */
type Proto = Record<string, unknown>;

export function installDomHelpers(): void {
	const N = Node.prototype as unknown as Proto;
	const E = HTMLElement.prototype as unknown as Proto;
	const S = SVGElement.prototype as unknown as Proto;
	const D = Document.prototype as unknown as Proto;
	const F = DocumentFragment.prototype as unknown as Proto;
	const G = window as unknown as Record<string, unknown>;
	const create = function (this: Node, tag: string, o?: DomInfo | string, cb?: (el: HTMLElement) => void) {
		return createElIn(this, tag, o, cb);
	};
	for (const p of [N, D, F]) {
		p.createEl = create;
		p.createDiv = function (this: Node, o?: DomInfo | string, cb?: (el: HTMLElement) => void) {
			return createElIn(this, "div", o, cb);
		};
		p.createSpan = function (this: Node, o?: DomInfo | string, cb?: (el: HTMLElement) => void) {
			return createElIn(this, "span", o, cb);
		};
	}
	D.createEl = function (tag: string, o?: DomInfo | string, cb?: (el: HTMLElement) => void) {
		return createElIn(null, tag, o, cb);
	};
	N.createSvg = function (this: Node, tag: string, o?: DomInfo | string, cb?: (el: SVGElement) => void) {
		const el = dom.createElementNS("http://www.w3.org/2000/svg", tag);
		applyInfo(el as unknown as HTMLElement, o);
		this.appendChild(el);
		cb?.(el);
		return el;
	};
	N.empty = function (this: Node) {
		while (this.firstChild) this.removeChild(this.firstChild);
	};
	N.detach = function (this: Node) {
		this.parentNode?.removeChild(this);
	};
	N.appendText = function (this: Node, text: string) {
		this.appendChild(document.createTextNode(text));
	};
	N.instanceOf = function (this: Node, type: abstract new (...args: never[]) => object) {
		return type[Symbol.hasInstance](this);
	};
	N.doc = document;
	N.win = window;
	for (const p of [E, S].filter(Boolean)) {
		p.addClass = function (this: Element, ...c: string[]) {
			this.classList.add(...c);
		};
		p.addClasses = function (this: Element, c: string[]) {
			this.classList.add(...c);
		};
		p.removeClass = function (this: Element, ...c: string[]) {
			this.classList.remove(...c);
		};
		p.removeClasses = function (this: Element, c: string[]) {
			this.classList.remove(...c);
		};
		p.toggleClass = function (this: Element, c: string | string[], value: boolean) {
			for (const x of Array.isArray(c) ? c : [c]) this.classList.toggle(x, value);
		};
		p.hasClass = function (this: Element, c: string) {
			return this.classList.contains(c);
		};
		p.setAttr = function (this: Element, k: string, v: string | number | boolean | null) {
			setAttr(this, k, v);
		};
		p.setAttrs = function (this: Element, o: Record<string, string | number | boolean | null>) {
			for (const [k, v] of Object.entries(o)) setAttr(this, k, v);
		};
		p.getAttr = function (this: Element, k: string) {
			return this.getAttribute(k);
		};
		p.setText = function (this: Element, t: string) {
			this.textContent = t;
		};
		p.getText = function (this: Element) {
			return this.textContent ?? "";
		};
		p.find = function (this: Element, sel: string) {
			return this.querySelector(sel);
		};
		p.findAll = function (this: Element, sel: string) {
			return Array.from(this.querySelectorAll(sel));
		};
		p.setCssStyles = function (this: HTMLElement, styles: Record<string, string>) {
			Object.assign(this.style, styles);
		};
		p.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
			for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
		};
	}
	E.show = function (this: HTMLElement) {
		this.setCssStyles({ display: "" });
	};
	E.hide = function (this: HTMLElement) {
		this.setCssStyles({ display: "none" });
	};
	E.toggle = function (this: HTMLElement, show: boolean) {
		this.style.display = show ? "" : "none";
	};
	E.toggleVisibility = function (this: HTMLElement, show: boolean) {
		this.style.visibility = show ? "" : "hidden";
	};
	E.isShown = function (this: HTMLElement) {
		return this.offsetParent !== null;
	};
	E.onClickEvent = function (this: HTMLElement, fn: (e: MouseEvent) => void) {
		this.addEventListener("click", fn);
	};
	G.activeDocument = document;
	G.activeWindow = window;
	G.createEl = (tag: string, o?: DomInfo | string, cb?: (el: HTMLElement) => void) => createElIn(null, tag, o, cb);
	G.createDiv = (o?: DomInfo | string, cb?: (el: HTMLElement) => void) => createElIn(null, "div", o, cb);
	G.createSpan = (o?: DomInfo | string, cb?: (el: HTMLElement) => void) => createElIn(null, "span", o, cb);
	G.createFragment = (cb?: (f: DocumentFragment) => void) => {
		const f = dom.createDocumentFragment();
		cb?.(f);
		return f;
	};
	G.sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
}

// --- events ---

type Handler = (...args: never[]) => unknown;

export class Events {
	private handlers = new Map<string, Handler[]>();

	on(name: string, fn: Handler): { name: string; fn: Handler } {
		const list = this.handlers.get(name) ?? [];
		list.push(fn);
		this.handlers.set(name, list);
		return { name, fn };
	}

	offref(ref: { name: string; fn: Handler }): void {
		const list = this.handlers.get(ref.name);
		if (list) this.handlers.set(ref.name, list.filter((f) => f !== ref.fn));
	}

	trigger(name: string, ...args: unknown[]): void {
		for (const fn of this.handlers.get(name) ?? []) (fn as (...a: unknown[]) => unknown)(...args);
	}
}

// --- vault ---

export class TAbstractFile {
	vault!: Vault;
	path = "";
	name = "";
	parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
	basename = "";
	extension = "";
	stat = { ctime: Date.now(), mtime: Date.now(), size: 0 };
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
	isRoot(): boolean {
		return this.path === "";
	}
}

export function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "") || "/";
}

class MemoryAdapter {
	readonly files = new Map<string, string>();
	readonly folders = new Set<string>();
	async exists(p: string): Promise<boolean> {
		return this.files.has(p) || this.folders.has(p);
	}
	async list(p: string): Promise<{ files: string[]; folders: string[] }> {
		const pre = p.replace(/\/$/, "") + "/";
		return {
			files: [...this.files.keys()].filter((f) => f.startsWith(pre) && !f.slice(pre.length).includes("/")),
			folders: [...this.folders].filter((f) => f.startsWith(pre) && !f.slice(pre.length).includes("/")),
		};
	}
	async read(p: string): Promise<string> {
		const v = this.files.get(p);
		if (v === undefined) throw new Error(`ENOENT ${p}`);
		return v;
	}
	async write(p: string, text: string): Promise<void> {
		this.files.set(p, text);
	}
	async mkdir(p: string): Promise<void> {
		this.folders.add(p);
	}
	async remove(p: string): Promise<void> {
		this.files.delete(p);
	}
	getName(): string {
		return "harness";
	}
}

export class Vault extends Events {
	readonly adapter = new MemoryAdapter();
	/** Obsidian's default config folder name. */
	readonly configDir = `.${"obsidian"}`;
	private readonly entries = new Map<string, TAbstractFile>();
	private readonly text = new Map<string, string>();
	private readonly binary = new Map<string, ArrayBuffer>();
	readonly root: TFolder;

	constructor() {
		super();
		this.root = new TFolder();
		this.root.vault = this;
		this.entries.set("", this.root);
	}

	static recurseChildren(root: TFolder, cb: (f: TAbstractFile) => void): void {
		cb(root);
		for (const c of root.children) {
			if (c instanceof TFolder) Vault.recurseChildren(c, cb);
			else cb(c);
		}
	}

	getName(): string {
		return "harness";
	}

	getRoot(): TFolder {
		return this.root;
	}

	getAbstractFileByPath(p: string): TAbstractFile | null {
		const n = normalizePath(p);
		return this.entries.get(n === "/" ? "" : n) ?? null;
	}

	getFileByPath(p: string): TFile | null {
		const f = this.getAbstractFileByPath(p);
		return f instanceof TFile ? f : null;
	}

	getFolderByPath(p: string): TFolder | null {
		const f = this.getAbstractFileByPath(p);
		return f instanceof TFolder ? f : null;
	}

	getFiles(): TFile[] {
		return [...this.entries.values()].filter((f): f is TFile => f instanceof TFile);
	}

	getAllLoadedFiles(): TAbstractFile[] {
		return [...this.entries.values()];
	}

	private parentOf(p: string): TFolder {
		const i = p.lastIndexOf("/");
		const dir = i < 0 ? "" : p.slice(0, i);
		return this.getFolderByPath(dir) ?? this.mkdirSync(dir);
	}

	private mkdirSync(p: string): TFolder {
		const existing = this.getFolderByPath(p);
		if (existing) return existing;
		const parent = this.parentOf(p);
		const f = new TFolder();
		f.vault = this;
		f.path = p;
		f.name = p.split("/").pop() ?? p;
		f.parent = parent;
		parent.children.push(f);
		this.entries.set(p, f);
		return f;
	}

	private addFile(p: string): TFile {
		p = normalizePath(p);
		if (this.entries.has(p)) throw new Error(`File already exists: ${p}`);
		const parent = this.parentOf(p);
		const f = new TFile();
		f.vault = this;
		f.path = p;
		f.name = p.split("/").pop() ?? p;
		const dot = f.name.lastIndexOf(".");
		f.basename = dot > 0 ? f.name.slice(0, dot) : f.name;
		f.extension = dot > 0 ? f.name.slice(dot + 1) : "";
		f.parent = parent;
		parent.children.push(f);
		this.entries.set(p, f);
		return f;
	}

	async createFolder(p: string): Promise<TFolder> {
		return this.mkdirSync(normalizePath(p));
	}

	async create(p: string, data: string): Promise<TFile> {
		const f = this.addFile(p);
		this.text.set(f.path, data);
		f.stat.size = data.length;
		this.trigger("create", f);
		return f;
	}

	async createBinary(p: string, data: ArrayBuffer): Promise<TFile> {
		const f = this.addFile(p);
		this.binary.set(f.path, data);
		f.stat.size = data.byteLength;
		this.trigger("create", f);
		return f;
	}

	async read(f: TFile): Promise<string> {
		const v = this.text.get(f.path);
		if (v === undefined) throw new Error(`ENOENT ${f.path}`);
		return v;
	}

	async cachedRead(f: TFile): Promise<string> {
		return this.read(f);
	}

	async readBinary(f: TFile): Promise<ArrayBuffer> {
		const v = this.binary.get(f.path);
		if (v) return v;
		const t = this.text.get(f.path);
		if (t !== undefined) return new TextEncoder().encode(t).buffer;
		throw new Error(`ENOENT ${f.path}`);
	}

	async modify(f: TFile, data: string): Promise<void> {
		this.text.set(f.path, data);
		f.stat.mtime = Date.now();
		f.stat.size = data.length;
		// Obsidian reports our own writes too.
		this.trigger("modify", f);
	}

	async modifyBinary(f: TFile, data: ArrayBuffer): Promise<void> {
		this.binary.set(f.path, data);
		f.stat.size = data.byteLength;
		this.trigger("modify", f);
	}

	async process(f: TFile, fn: (data: string) => string): Promise<string> {
		const next = fn(await this.read(f));
		await this.modify(f, next);
		return next;
	}

	async trash(f: TAbstractFile): Promise<void> {
		await this.removeEntry(f);
	}

	async delete(f: TAbstractFile): Promise<void> {
		await this.removeEntry(f);
	}

	/** What both delete() and trash() do in the in-memory vault (the plugin goes through FileManager.trashFile). */
	async removeEntry(f: TAbstractFile): Promise<void> {
		this.entries.delete(f.path);
		this.text.delete(f.path);
		this.binary.delete(f.path);
		if (f.parent) f.parent.children = f.parent.children.filter((c) => c !== f);
		this.trigger("delete", f);
	}

	async rename(f: TAbstractFile, p: string): Promise<void> {
		const data = f instanceof TFile ? this.text.get(f.path) : undefined;
		await this.removeEntry(f);
		if (data !== undefined) await this.create(p, data);
	}
}

export class FileManager {
	constructor(private readonly app: App) {}
	async renameFile(f: TAbstractFile, p: string): Promise<void> {
		await this.app.vault.rename(f, p);
	}
	async trashFile(f: TAbstractFile): Promise<void> {
		await this.app.vault.removeEntry(f);
	}
	async processFrontMatter(): Promise<void> {
		/* not used by the harness */
	}
}

export class Workspace extends Events {
	leaves: WorkspaceLeaf[] = [];
	getLeavesOfType(type: string): WorkspaceLeaf[] {
		return this.leaves.filter((l) => l.view?.getViewType?.() === type);
	}
	setActiveLeaf(): void {
		/* the harness shows one notebook */
	}
	getActiveViewOfType<T>(type: abstract new (...args: never[]) => T): T | null {
		for (const l of this.leaves) if (l.view instanceof type) return l.view;
		return null;
	}
	getLeaf(): WorkspaceLeaf {
		return this.leaves[0]!;
	}
	async revealLeaf(): Promise<void> {
		/* single leaf */
	}
	onLayoutReady(fn: () => void): void {
		fn();
	}
	getActiveFile(): TFile | null {
		return null;
	}
	/** Layout saves requested by views; counted so the harness can see that the page is saved with the layout. */
	layoutSaves = 0;
	requestSaveLayout(): void {
		this.layoutSaves++;
	}
}

export class Scope {
	constructor(readonly parent?: Scope) {}
	register(): unknown {
		return {};
	}
	unregister(): void {
		/* nothing */
	}
}

export class MetadataCache extends Events {
	getFileCache(): null {
		return null;
	}
	getFirstLinkpathDest(): null {
		return null;
	}
	fileToLinktext(file: { path: string }): string {
		return file.path.replace(/.md$/, "");
	}
}

export class App {
	readonly vault = new Vault();
	readonly workspace = new Workspace();
	readonly fileManager = new FileManager(this);
	readonly metadataCache = new MetadataCache();
	readonly scope = new Scope();
	/** Per-device local storage, as Obsidian's (kept in memory in the harness). */
	private readonly local = new Map<string, unknown>();
	loadLocalStorage(key: string): unknown {
		return this.local.has(key) ? JSON.parse(JSON.stringify(this.local.get(key))) : null;
	}
	saveLocalStorage(key: string, data: unknown): void {
		if (data === null) this.local.delete(key);
		else this.local.set(key, JSON.parse(JSON.stringify(data)));
	}
}

// --- views ---

export class Component {
	private readonly cleanups: Array<() => void> = [];
	load(): void {
		this.onload();
	}
	onload(): void {
		/* override */
	}
	unload(): void {
		for (const c of this.cleanups.splice(0)) c();
		this.onunload();
	}
	onunload(): void {
		/* override */
	}
	register(cb: () => void): void {
		this.cleanups.push(cb);
	}
	registerEvent(ref: { name: string; fn: Handler } & { owner?: Events }): void {
		void ref;
	}
	registerDomEvent(el: EventTarget, type: string, fn: (e: Event) => unknown, opts?: boolean | AddEventListenerOptions): void {
		el.addEventListener(type, fn, opts);
		this.cleanups.push(() => el.removeEventListener(type, fn, opts));
	}
	registerInterval(id: number): number {
		this.cleanups.push(() => window.clearInterval(id));
		return id;
	}
	addChild<T extends Component>(c: T): T {
		c.load();
		return c;
	}
	removeChild<T extends Component>(c: T): T {
		c.unload();
		return c;
	}
}

/** What the leaf asks of its view. */
interface LeafView {
	getViewType?(): string;
	getDisplayText?(): string;
	loadFile?(file: TFile): Promise<void>;
}

export class WorkspaceLeaf {
	view: LeafView | null = null;
	readonly containerEl: HTMLElement;
	constructor(readonly app: App, parent: HTMLElement) {
		this.containerEl = parent.createDiv({ cls: "workspace-leaf" });
		app.workspace.leaves.push(this);
	}
	async openFile(file: TFile): Promise<void> {
		await this.view?.loadFile?.(file);
	}
	async setViewState(): Promise<void> {
		/* single view */
	}
	getDisplayText(): string {
		return this.view?.getDisplayText?.() ?? "";
	}
	getViewState(): { type: string; state: Record<string, unknown> } {
		return { type: this.view?.getViewType?.() ?? "empty", state: {} };
	}
	detach(): void {
		/* nothing */
	}
}

export class View extends Component {
	readonly app: App;
	readonly containerEl: HTMLElement;
	readonly contentEl: HTMLElement;
	scope: Scope | null = null;
	navigation = false;
	icon = "";
	constructor(readonly leaf: WorkspaceLeaf) {
		super();
		this.app = leaf.app;
		this.containerEl = leaf.containerEl.createDiv({ cls: "workspace-leaf-content" });
		this.containerEl.createDiv({ cls: "view-header" });
		this.contentEl = this.containerEl.createDiv({ cls: "view-content" });
		leaf.view = this;
	}
	getViewType(): string {
		return "";
	}
	getDisplayText(): string {
		return "";
	}
	getIcon(): string {
		return this.icon;
	}
	async onOpen(): Promise<void> {
		/* override */
	}
	async onClose(): Promise<void> {
		/* override */
	}
	onResize(): void {
		/* override */
	}
	setEphemeralState(state: unknown): void {
		void state;
	}
	getState(): Record<string, unknown> {
		return {};
	}
	async setState(state: unknown, result: unknown): Promise<void> {
		void state;
		void result;
	}
	addAction(icon: string, title: string, cb: () => void): HTMLElement {
		const el = this.containerEl.createEl("button", { title });
		el.addEventListener("click", cb);
		return el;
	}
}

export class ItemView extends View {
	/** Obsidian adds its own entries to the tab menu here. */
	onPaneMenu(): void {
		return;
	}
}

export class FileView extends ItemView {
	file: TFile | null = null;
	allowNoFile = false;
	async loadFile(file: TFile): Promise<void> {
		if (this.file) await this.onUnloadFile(this.file);
		this.file = file;
		await this.onLoadFile(file);
	}
	async onLoadFile(file: TFile): Promise<void> {
		void file;
	}
	async onUnloadFile(file: TFile): Promise<void> {
		void file;
	}
	canAcceptExtension(extension: string): boolean {
		void extension;
		return true;
	}
}

export class MarkdownRenderChild extends Component {
	constructor(readonly containerEl: HTMLElement) {
		super();
	}
}

export class Plugin extends Component {
	constructor(readonly app: App, readonly manifest: { id: string; dir?: string; version: string }) {
		super();
	}
	async loadData(): Promise<unknown> {
		return null;
	}
	async saveData(): Promise<void> {
		/* in memory */
	}
	registerView(): void {
		/* harness creates the view itself */
	}
	registerExtensions(): void {
		/* nothing */
	}
	addRibbonIcon(): HTMLElement {
		return createDiv();
	}
	addCommand(): void {
		/* nothing */
	}
	addSettingTab(): void {
		/* nothing */
	}
	registerMarkdownCodeBlockProcessor(): void {
		/* nothing */
	}
	registerObsidianProtocolHandler(): void {
		/* nothing */
	}
}

// --- UI ---

export const notices: string[] = [];
/** The DOM of notices created with a fragment (buttons inside a notice), newest last. */
export const noticeEls: HTMLElement[] = [];

export class Notice {
	readonly noticeEl: HTMLElement;
	constructor(message: string | DocumentFragment, duration?: number) {
		void duration;
		const text = typeof message === "string" ? message : message.textContent ?? "";
		notices.push(text);
		console.warn("[harness] Notice:", text);
		this.noticeEl = createDiv();
		if (typeof message !== "string") {
			this.noticeEl.appendChild(message);
			noticeEls.push(this.noticeEl);
		}
	}
	setMessage(message: string): this {
		notices.push(message);
		return this;
	}
	hide(): void {
		/* nothing */
	}
}

/** The menu item the plugin configures (every setter returns the item). */
interface MenuItemStub {
	setTitle(t: string): MenuItemStub;
	setIcon(): MenuItemStub;
	setChecked(): MenuItemStub;
	setDisabled(): MenuItemStub;
	setSection(): MenuItemStub;
	setWarning(): MenuItemStub;
	onClick(cb: () => void): MenuItemStub;
}

export class Menu {
	private items: Array<{ title: string; cb: (() => void) | null }> = [];
	addItem(fn: (item: MenuItemStub) => void): this {
		const entry = { title: "", cb: null as (() => void) | null };
		const item: MenuItemStub = {
			setTitle: (t: string) => ((entry.title = t), item),
			setIcon: () => item,
			setChecked: () => item,
			setDisabled: () => item,
			setSection: () => item,
			setWarning: () => item,
			onClick: (cb: () => void) => ((entry.cb = cb), item),
		};
		fn(item);
		this.items.push(entry);
		return this;
	}
	addSeparator(): this {
		return this;
	}
	showAtMouseEvent(): this {
		console.warn("[harness] menu:", this.items.map((i) => i.title).join(" | "));
		// The last menu can be driven from the console: harnessMenu.run("Page tags…").
		(window as unknown as { harnessMenu?: unknown }).harnessMenu = { titles: this.items.map((i) => i.title), run: (title: string) => this.items.find((i) => i.title === title)?.cb?.() };
		return this;
	}
	showAtPosition(): this {
		return this.showAtMouseEvent();
	}
	hide(): this {
		return this;
	}
	onHide(): void {
		/* nothing */
	}
}

export class Modal {
	readonly modalEl: HTMLElement;
	readonly contentEl: HTMLElement;
	readonly titleEl: HTMLElement;
	readonly scope = new Scope();
	constructor(readonly app: App) {
		this.modalEl = createDiv();
		this.modalEl.className = "modal";
		this.titleEl = this.modalEl.createDiv({ cls: "modal-title" });
		this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
	}
	open(): void {
		document.body.appendChild(this.modalEl);
		this.onOpen();
	}
	close(): void {
		this.onClose();
		this.modalEl.remove();
	}
	onOpen(): void {
		/* override */
	}
	onClose(): void {
		/* override */
	}
	setTitle(t: string): this {
		this.titleEl.textContent = t;
		return this;
	}
}

export class FuzzySuggestModal<T> extends Modal {
	setPlaceholder(): void {
		/* nothing */
	}
	getItems(): T[] {
		return [];
	}
	getItemText(item: T): string {
		return String(item);
	}
	onChooseItem(item: T): void {
		void item;
	}
}

/** wave 0.7: quick nav. */
export class SuggestModal<T> extends Modal {
	inputEl = createEl("input");
	emptyStateText = "";
	setPlaceholder(): void {
		/* nothing */
	}
	setInstructions(): void {
		/* nothing */
	}
	getSuggestions(query: string): T[] {
		void query;
		return [];
	}
	renderSuggestion(value: T, el: HTMLElement): void {
		void value;
		void el;
	}
	onChooseSuggestion(value: T): void {
		void value;
	}
}

export class PluginSettingTab {
	readonly containerEl = createDiv();
	constructor(readonly app: App, readonly plugin: unknown) {}
}

/**
 * Settings rows with working text fields, dropdowns and buttons (enough to try the plugin's modals in the
 * harness); toggles and sliders are inert.
 */
/** Builders handed to the callbacks of Setting; every setter returns the builder. */
interface ButtonStub {
	buttonEl: HTMLButtonElement;
	setButtonText(s: string): ButtonStub;
	setCta(): ButtonStub;
	setWarning(): ButtonStub;
	setDestructive(): ButtonStub;
	setIcon(): ButtonStub;
	setTooltip(): ButtonStub;
	setDisabled(d: boolean): ButtonStub;
	onClick(f: () => void): ButtonStub;
}

interface TextStub {
	inputEl: HTMLInputElement;
	getValue(): string;
	setValue(v: string): TextStub;
	setPlaceholder(v: string): TextStub;
	setDisabled(d: boolean): TextStub;
	onChange(f: (v: string) => void): TextStub;
}

interface DropdownStub {
	selectEl: HTMLSelectElement;
	addOption(value: string, text: string): DropdownStub;
	addOptions(o: Record<string, string>): DropdownStub;
	getValue(): string;
	setValue(v: string): DropdownStub;
	setDisabled(d: boolean): DropdownStub;
	onChange(f: (v: string) => void): DropdownStub;
}

/** The inert builder of toggles and sliders: any call returns it. */
type InertStub = { [method: string]: (...args: unknown[]) => InertStub };

export class Setting {
	readonly settingEl: HTMLElement;
	readonly infoEl: HTMLElement;
	readonly nameEl: HTMLElement;
	readonly descEl: HTMLElement;
	readonly controlEl: HTMLElement;
	constructor(containerEl: HTMLElement) {
		this.settingEl = containerEl.createDiv({ cls: "setting-item" });
		this.infoEl = this.settingEl.createDiv({ cls: "setting-item-info" });
		this.nameEl = this.infoEl.createDiv({ cls: "setting-item-name" });
		this.descEl = this.infoEl.createDiv({ cls: "setting-item-description" });
		this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
	}
	setName(name?: string): this {
		this.nameEl.textContent = name ?? "";
		return this;
	}
	setDesc(desc?: string): this {
		this.descEl.textContent = desc ?? "";
		return this;
	}
	setHeading(): this {
		return this;
	}
	setClass(): this {
		return this;
	}
	addButton(fn: (b: ButtonStub) => void): this {
		const buttonEl = this.controlEl.createEl("button");
		const b: ButtonStub = {
			buttonEl,
			setButtonText: (s: string) => ((buttonEl.textContent = s), b),
			setCta: () => (buttonEl.classList.add("mod-cta"), b),
			setWarning: () => (buttonEl.classList.add("mod-warning"), b),
			setDestructive: () => (buttonEl.classList.add("mod-destructive"), b),
			setIcon: () => b,
			setTooltip: () => b,
			setDisabled: (d: boolean) => ((buttonEl.disabled = d), b),
			onClick: (f: () => void) => (buttonEl.addEventListener("click", f), b),
		};
		fn(b);
		return this;
	}
	addText(fn: (b: TextStub) => void): this {
		const inputEl = this.controlEl.createEl("input", { attr: { type: "text" } });
		const b: TextStub = {
			inputEl,
			getValue: () => inputEl.value,
			setValue: (v: string) => ((inputEl.value = v), b),
			setPlaceholder: (v: string) => ((inputEl.placeholder = v), b),
			setDisabled: (d: boolean) => ((inputEl.disabled = d), b),
			onChange: (f: (v: string) => void) => (inputEl.addEventListener("input", () => f(inputEl.value)), b),
		};
		fn(b);
		return this;
	}
	addToggle(fn: (b: InertStub) => void): this {
		fn(chain());
		return this;
	}
	addDropdown(fn: (b: DropdownStub) => void): this {
		const selectEl = this.controlEl.createEl("select", { cls: "dropdown" });
		const b: DropdownStub = {
			selectEl,
			addOption: (value: string, text: string) => (selectEl.createEl("option", { text, value }), b),
			addOptions: (o: Record<string, string>) => {
				for (const [value, text] of Object.entries(o)) selectEl.createEl("option", { text, value });
				return b;
			},
			getValue: () => selectEl.value,
			setValue: (v: string) => ((selectEl.value = v), b),
			setDisabled: (d: boolean) => ((selectEl.disabled = d), b),
			onChange: (f: (v: string) => void) => (selectEl.addEventListener("change", () => f(selectEl.value)), b),
		};
		fn(b);
		return this;
	}
	addSlider(fn: (b: InertStub) => void): this {
		fn(chain());
		return this;
	}
}

function chain(): InertStub {
	const p: InertStub = new Proxy((() => p) as unknown as InertStub, { get: () => () => p });
	return p;
}

/** Icons: a harness stand-in of the Lucide icon (icons.ts), or a tiny glyph with the icon name as title. */
export function setIcon(el: HTMLElement, name: string): void {
	el.textContent = "";
	if (drawIcon(el, name)) return;
	const s = el.createSpan({ cls: "harness-icon", text: name.slice(0, 2) });
	s.title = name;
}

/** wave 0.12: the icon ids the "More icons…" search lists (a sample of Lucide's names, as Obsidian prefixes them). */
export function getIconIds(): string[] {
	return ["lucide-folder", "lucide-graduation-cap", "lucide-heart-pulse", "lucide-flask-conical", "lucide-sigma", "lucide-brain", "lucide-atom", "lucide-book-open", "lucide-palette", "lucide-star"];
}

export function getLanguage(): string {
	return "en";
}

// This stub implements Obsidian's own Platform for the browser harness, so reading the user agent here is the point.
const { userAgent } = window.navigator;
const MOBILE_UA = /Android|iPhone|iPad/i.test(userAgent);

export const Platform = {
	isMobile: MOBILE_UA,
	isMobileApp: false,
	isDesktop: !MOBILE_UA,
	isDesktopApp: false,
	isAndroidApp: false,
	isIosApp: false,
	isPhone: false,
	isTablet: false,
};

export async function loadPdfJs(): Promise<never> {
	// `doc=pdf` installs a fake library (fake-pdf.ts); otherwise there is no pdf.js in the harness.
	const fake = (window as unknown as { __harnessPdfJs?: unknown }).__harnessPdfJs;
	if (fake) return fake as never;
	throw new Error("pdf.js is not available in the harness");
}

export function debounce<T extends (...args: never[]) => unknown>(fn: T, ms: number): T {
	let h: number | null = null;
	return ((...args: Parameters<T>) => {
		if (h !== null) window.clearTimeout(h);
		h = window.setTimeout(() => fn(...args), ms);
	}) as T;
}

export async function requestUrl(): Promise<never> {
	throw new Error("network is not available in the harness");
}

/**
 * MathJax stand-in (wave 0.9: math): Obsidian ships MathJax; the harness has none. `renderMath` returns a container
 * with a small SVG that writes the source in italic serif, so the editor preview and the typesetter (its SVG branch)
 * run end to end. It is not TeX: the harness checks the plumbing, not the typesetting.
 */
export async function loadMathJax(): Promise<void> {}

export async function finishRenderMath(): Promise<void> {}

export function renderMath(source: string, display: boolean): HTMLElement {
	// createEl is typed for the standard tags only; the harness helper takes any tag name
	const el = createEl("mjx-container" as "div");
	el.setAttribute("display", String(display));
	const text = source.replace(/\\[a-zA-Z]+/g, (m) => m.slice(1)).replace(/[{}]/g, "") || " ";
	const w = Math.max(1, text.length) * 6;
	const ns = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(ns, "svg");
	svg.setAttribute("xmlns", ns);
	svg.setAttribute("viewBox", `0 0 ${w} 14`);
	svg.setAttribute("width", `${w / 10}em`);
	svg.setAttribute("height", "1.4em");
	const t = document.createElementNS(ns, "text");
	t.setAttribute("x", "0");
	t.setAttribute("y", "11");
	t.setAttribute("font-family", "serif");
	t.setAttribute("font-style", "italic");
	t.setAttribute("font-size", "10");
	t.setAttribute("fill", "currentColor");
	t.textContent = text;
	svg.appendChild(t);
	el.appendChild(svg);
	return el;
}
