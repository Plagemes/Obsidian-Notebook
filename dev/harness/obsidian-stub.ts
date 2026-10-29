/**
 * Minimal stand-in for the `obsidian` module, for the browser harness only (dev/harness). It is
 * aliased in place of `obsidian` by dev/harness/build.mjs and never ships in main.js.
 *
 * It implements just what the notebook view touches: views, an in-memory vault, notices, menus,
 * modals, settings rows, icons, and Obsidian's DOM helpers on HTMLElement.prototype.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

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

function createElIn(parent: Node | null, tag: string, o?: DomInfo | string, cb?: (el: HTMLElement) => void): HTMLElement {
	const el = document.createElement(tag);
	applyInfo(el, o);
	if (typeof o === "object" && o.parent) o.parent.appendChild(el);
	else if (parent) {
		if (typeof o === "object" && o.prepend) parent.insertBefore(el, parent.firstChild);
		else parent.appendChild(el);
	}
	cb?.(el);
	return el;
}

export function installDomHelpers(): void {
	const N = Node.prototype as any;
	const E = HTMLElement.prototype as any;
	const S = (globalThis as any).SVGElement?.prototype as any;
	const D = Document.prototype as any;
	const F = DocumentFragment.prototype as any;
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
	N.empty = function (this: Node) {
		while (this.firstChild) this.removeChild(this.firstChild);
	};
	N.detach = function (this: Node) {
		this.parentNode?.removeChild(this);
	};
	N.appendText = function (this: Node, text: string) {
		this.appendChild(document.createTextNode(text));
	};
	N.instanceOf = function (this: Node, type: any) {
		return this instanceof type;
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
			if (v === null) this.removeAttribute(k);
			else this.setAttribute(k, String(v));
		};
		p.setAttrs = function (this: Element, o: Record<string, string | number | boolean | null>) {
			for (const [k, v] of Object.entries(o)) (this as any).setAttr(k, v);
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
		this.style.display = "";
	};
	E.hide = function (this: HTMLElement) {
		this.style.display = "none";
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
	(globalThis as any).activeDocument = document;
	(globalThis as any).activeWindow = window;
	(globalThis as any).createEl = (tag: string, o?: DomInfo | string, cb?: (el: HTMLElement) => void) => createElIn(null, tag, o, cb);
	(globalThis as any).createDiv = (o?: DomInfo | string, cb?: (el: HTMLElement) => void) => createElIn(null, "div", o, cb);
	(globalThis as any).createSpan = (o?: DomInfo | string, cb?: (el: HTMLElement) => void) => createElIn(null, "span", o, cb);
	(globalThis as any).createFragment = (cb?: (f: DocumentFragment) => void) => {
		const f = document.createDocumentFragment();
		cb?.(f);
		return f;
	};
	(globalThis as any).sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
}

// --- events ---

export class Events {
	private handlers = new Map<string, Array<(...args: any[]) => any>>();

	on(name: string, fn: (...args: any[]) => any): { name: string; fn: (...args: any[]) => any } {
		const list = this.handlers.get(name) ?? [];
		list.push(fn);
		this.handlers.set(name, list);
		return { name, fn };
	}

	offref(ref: { name: string; fn: (...args: any[]) => any }): void {
		const list = this.handlers.get(ref.name);
		if (list) this.handlers.set(ref.name, list.filter((f) => f !== ref.fn));
	}

	trigger(name: string, ...args: any[]): void {
		for (const fn of this.handlers.get(name) ?? []) fn(...args);
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
	readonly configDir = ".obsidian";
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
		if (t !== undefined) return new TextEncoder().encode(t).buffer as ArrayBuffer;
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
		this.trigger("modify", f);
	}

	async process(f: TFile, fn: (data: string) => string): Promise<string> {
		const next = fn(await this.read(f));
		await this.modify(f, next);
		return next;
	}

	async trash(f: TAbstractFile): Promise<void> {
		await this.delete(f);
	}

	async delete(f: TAbstractFile): Promise<void> {
		this.entries.delete(f.path);
		this.text.delete(f.path);
		this.binary.delete(f.path);
		if (f.parent) f.parent.children = f.parent.children.filter((c) => c !== f);
		this.trigger("delete", f);
	}

	async rename(f: TAbstractFile, p: string): Promise<void> {
		const data = f instanceof TFile ? this.text.get(f.path) : undefined;
		await this.delete(f);
		if (data !== undefined) await this.create(p, data);
	}
}

export class FileManager {
	constructor(private readonly app: App) {}
	async renameFile(f: TAbstractFile, p: string): Promise<void> {
		await this.app.vault.rename(f, p);
	}
	async trashFile(f: TAbstractFile): Promise<void> {
		await this.app.vault.trash(f);
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
	getActiveViewOfType<T>(type: new (...args: any[]) => T): T | null {
		for (const l of this.leaves) if (l.view instanceof type) return l.view as T;
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
}

export class App {
	readonly vault = new Vault();
	readonly workspace = new Workspace();
	readonly fileManager = new FileManager(this);
	readonly metadataCache = new MetadataCache();
	readonly scope = new Scope();
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
	registerEvent(ref: { name: string; fn: (...args: any[]) => any } & { owner?: Events }): void {
		void ref;
	}
	registerDomEvent(el: EventTarget, type: string, fn: (e: any) => any, opts?: boolean | AddEventListenerOptions): void {
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

export class WorkspaceLeaf {
	view: any = null;
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

export class ItemView extends View {}

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
		return document.createElement("div");
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

export class Notice {
	readonly noticeEl: HTMLElement;
	constructor(message: string | DocumentFragment, duration?: number) {
		void duration;
		const text = typeof message === "string" ? message : message.textContent ?? "";
		notices.push(text);
		console.warn("[harness] Notice:", text);
		this.noticeEl = document.createElement("div");
	}
	setMessage(message: string): this {
		notices.push(message);
		return this;
	}
	hide(): void {
		/* nothing */
	}
}

export class Menu {
	private items: Array<{ title: string; cb: (() => void) | null }> = [];
	addItem(fn: (item: any) => void): this {
		const entry = { title: "", cb: null as (() => void) | null };
		const item: any = {
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
		this.modalEl = document.createElement("div");
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

export class PluginSettingTab {
	readonly containerEl = document.createElement("div");
	constructor(readonly app: App, readonly plugin: unknown) {}
}

export class Setting {
	readonly settingEl: HTMLElement;
	constructor(containerEl: HTMLElement) {
		this.settingEl = containerEl.createDiv({ cls: "setting-item" });
	}
	setName(): this {
		return this;
	}
	setDesc(): this {
		return this;
	}
	setHeading(): this {
		return this;
	}
	setClass(): this {
		return this;
	}
	addButton(fn: (b: any) => void): this {
		fn(chain());
		return this;
	}
	addText(fn: (b: any) => void): this {
		fn(chain());
		return this;
	}
	addToggle(fn: (b: any) => void): this {
		fn(chain());
		return this;
	}
	addDropdown(fn: (b: any) => void): this {
		fn(chain());
		return this;
	}
	addSlider(fn: (b: any) => void): this {
		fn(chain());
		return this;
	}
}

function chain(): any {
	const p: any = new Proxy(() => p, { get: () => () => p });
	return p;
}

/** Icons: a tiny inline glyph with the icon name as title, so buttons are visible and identifiable. */
export function setIcon(el: HTMLElement, name: string): void {
	el.textContent = "";
	const s = el.createSpan({ cls: "harness-icon", text: name.slice(0, 2) });
	s.title = name;
}

export function getLanguage(): string {
	return "en";
}

export const Platform = {
	isMobile: /Android|iPhone|iPad/i.test(navigator.userAgent),
	isMobileApp: false,
	isDesktop: !/Android|iPhone|iPad/i.test(navigator.userAgent),
	isDesktopApp: false,
	isAndroidApp: false,
	isIosApp: false,
	isPhone: false,
	isTablet: false,
};

export async function loadPdfJs(): Promise<never> {
	// `doc=pdf` installs a fake library (fake-pdf.ts); otherwise there is no pdf.js in the harness.
	const fake = (globalThis as { __harnessPdfJs?: unknown }).__harnessPdfJs;
	if (fake) return fake as never;
	throw new Error("pdf.js is not available in the harness");
}

export function debounce<T extends (...args: any[]) => any>(fn: T, ms: number): T {
	let h: number | null = null;
	return ((...args: any[]) => {
		if (h !== null) window.clearTimeout(h);
		h = window.setTimeout(() => fn(...args), ms);
	}) as T;
}

export async function requestUrl(): Promise<never> {
	throw new Error("network is not available in the harness");
}
