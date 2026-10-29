import { FuzzySuggestModal, Modal, Setting, type App, type TFile } from "obsidian";
import { t } from "../i18n";

export interface PickedFile {
	name: string;
	bytes: ArrayBuffer;
}

const EXTENSIONS = {
	pdf: ["pdf"],
	image: ["png", "jpg", "jpeg", "webp", "gif"],
} as const;

const ACCEPT = { pdf: "application/pdf,.pdf", image: "image/*" } as const;

class VaultFileModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private readonly files: TFile[], private readonly done: (f: TFile | null) => void) {
		super(app);
		this.setPlaceholder(t("pick.search"));
	}

	private chosen = false;

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(f: TFile): string {
		return f.path;
	}

	onChooseItem(f: TFile): void {
		this.chosen = true;
		this.done(f);
	}

	onClose(): void {
		// onChooseItem runs after onClose: wait a tick before reporting a cancel.
		window.setTimeout(() => {
			if (!this.chosen) this.done(null);
		}, 0);
	}
}

/** Opens the device file picker (camera when `capture` is set). Resolves null if nothing is chosen. */
export function pickFromDevice(kind: keyof typeof ACCEPT, capture = false, multiple = false): Promise<PickedFile[]> {
	return new Promise((resolve) => {
		const input = activeDocument.body.createEl("input", { type: "file", cls: "notebook-hidden", attr: { accept: ACCEPT[kind] } });
		if (capture) input.setAttribute("capture", "environment");
		input.multiple = multiple;
		let settled = false;
		const finish = (files: PickedFile[]) => {
			if (settled) return;
			settled = true;
			input.remove();
			resolve(files);
		};
		input.addEventListener("change", () => {
			const list = Array.from(input.files ?? []);
			void Promise.all(list.map(async (f) => ({ name: f.name, bytes: await f.arrayBuffer() }))).then(finish, () => finish([]));
		});
		// Some WebViews fire "cancel"; others never tell us. The input is removed on the next pick anyway.
		input.addEventListener("cancel", () => finish([]));
		input.click();
	});
}

/** Lets the user choose a PDF or image from the vault or from the device. */
export function pickFile(app: App, kind: keyof typeof EXTENSIONS): Promise<PickedFile | null> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		let handled = false;
		const done = (v: PickedFile | null) => {
			if (handled) return;
			handled = true;
			resolve(v);
		};
		modal.setTitle(t(kind === "pdf" ? "pick.pdfTitle" : "pick.imageTitle"));
		new Setting(modal.contentEl)
			.setName(t("pick.fromVault"))
			.addButton((b) => b.setButtonText(t("pick.browse")).onClick(() => {
				handled = true;
				modal.close();
				const exts: readonly string[] = EXTENSIONS[kind];
				const files = app.vault.getFiles().filter((f) => exts.includes(f.extension.toLowerCase()) && !f.path.includes("/_assets/"));
				new VaultFileModal(app, files, (f) => {
					if (!f) return resolve(null);
					void app.vault.readBinary(f).then((bytes) => resolve({ name: f.name, bytes }), () => resolve(null));
				}).open();
			}));
		new Setting(modal.contentEl)
			.setName(t("pick.fromDevice"))
			.addButton((b) => b.setButtonText(t("pick.choose")).setCta().onClick(() => {
				handled = true;
				modal.close();
				void pickFromDevice(kind).then((files) => resolve(files[0] ?? null));
			}));
		modal.onClose = () => done(null);
		modal.open();
	});
}
