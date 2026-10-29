import { getLanguage } from "obsidian";

const en = {
	"plugin.name": "Notebook",
	"ribbon.open": "Open notebooks",
	"command.new": "New notebook",
	"command.open": "Open notebooks",
	"command.undo": "Undo (notebook)",
	"command.redo": "Redo (notebook)",
	"command.fit": "Fit page to width",

	"modal.new.title": "New notebook",
	"modal.new.name": "Name",
	"modal.new.create": "Create",
	"modal.open.placeholder": "Search notebooks…",
	"modal.open.new": "+ New notebook",
	"modal.open.empty": "No notebooks yet",

	"tool.pen": "Pen",
	"tool.eraser": "Eraser (whole stroke)",
	"tool.color": "Colour",
	"tool.width.fine": "Fine",
	"tool.width.medium": "Medium",
	"tool.width.thick": "Thick",
	"tool.undo": "Undo",
	"tool.redo": "Redo",
	"tool.fit": "Fit to width",

	"status.saved": "Saved",
	"status.pending": "Unsaved changes",
	"status.saving": "Saving…",
	"status.error": "Save failed",
	"status.readonly": "Read-only",

	"view.broken.title": "This notebook cannot be opened",
	"view.broken.body": "The file is not modified and will not be overwritten.",
	"view.readonly.title": "Created by a newer version of Notebook",
	"view.readonly.body": "Update the plugin to edit it. The file will not be modified.",
	"view.backup": "Backup copy",

	"notice.backup": "Notebook: backup saved to {path}",
	"notice.conflict": "Notebook: the file was changed elsewhere; the other version was saved to {path}",
	"notice.created": "Notebook created: {path}",
	"notice.createFailed": "Could not create the notebook: {error}",

	"settings.folder": "Notebooks folder",
	"settings.folder.desc": "New notebooks are created here. Backups go to the _backup subfolder.",
	"settings.finger": "Draw with finger",
	"settings.finger.desc": "When off, touch only scrolls and zooms (recommended with a stylus).",
	"settings.palm": "Palm rejection (ms)",
	"settings.palm.desc": "After the pen is seen, touch does not draw for this long.",
	"settings.pressure": "Pressure",
	"settings.pressure.desc": "Auto uses the stylus pressure when the device reports it, and simulates it from speed otherwise.",
	"settings.pressure.auto": "Auto",
	"settings.pressure.simulated": "Always simulated",
	"settings.prediction": "Predicted points",
	"settings.prediction.desc": "Draws the browser's predicted points ahead of the pen to reduce perceived latency. They are never saved. Experimental.",
} as const;

export type MessageKey = keyof typeof en;

const it: Partial<Record<MessageKey, string>> = {
	"plugin.name": "Notebook",
	"ribbon.open": "Apri quaderni",
	"command.new": "Nuovo quaderno",
	"command.open": "Apri quaderni",
	"command.undo": "Annulla (quaderno)",
	"command.redo": "Ripeti (quaderno)",
	"command.fit": "Adatta la pagina alla larghezza",

	"modal.new.title": "Nuovo quaderno",
	"modal.new.name": "Nome",
	"modal.new.create": "Crea",
	"modal.open.placeholder": "Cerca quaderni…",
	"modal.open.new": "+ Nuovo quaderno",
	"modal.open.empty": "Ancora nessun quaderno",

	"tool.pen": "Penna",
	"tool.eraser": "Gomma (tratto intero)",
	"tool.color": "Colore",
	"tool.width.fine": "Fine",
	"tool.width.medium": "Medio",
	"tool.width.thick": "Spesso",
	"tool.undo": "Annulla",
	"tool.redo": "Ripeti",
	"tool.fit": "Adatta alla larghezza",

	"status.saved": "Salvato",
	"status.pending": "Modifiche non salvate",
	"status.saving": "Salvataggio…",
	"status.error": "Salvataggio non riuscito",
	"status.readonly": "Sola lettura",

	"view.broken.title": "Questo quaderno non si può aprire",
	"view.broken.body": "Il file non è stato modificato e non verrà sovrascritto.",
	"view.readonly.title": "Creato con una versione più recente di Notebook",
	"view.readonly.body": "Aggiorna il plugin per modificarlo. Il file non verrà modificato.",
	"view.backup": "Copia di backup",

	"notice.backup": "Notebook: copia di backup salvata in {path}",
	"notice.conflict": "Notebook: il file è stato modificato altrove; l'altra versione è stata salvata in {path}",
	"notice.created": "Quaderno creato: {path}",
	"notice.createFailed": "Impossibile creare il quaderno: {error}",

	"settings.folder": "Cartella dei quaderni",
	"settings.folder.desc": "I nuovi quaderni vengono creati qui. I backup vanno nella sottocartella _backup.",
	"settings.finger": "Scrivi con il dito",
	"settings.finger.desc": "Se disattivato, il dito serve solo a scorrere e zoomare (consigliato con il pennino).",
	"settings.palm": "Palm rejection (ms)",
	"settings.palm.desc": "Dopo che la penna è stata vista, il dito non disegna per questo tempo.",
	"settings.pressure": "Pressione",
	"settings.pressure.desc": "Automatica usa la pressione del pennino se il dispositivo la fornisce, altrimenti la simula dalla velocità.",
	"settings.pressure.auto": "Automatica",
	"settings.pressure.simulated": "Sempre simulata",
	"settings.prediction": "Punti predetti",
	"settings.prediction.desc": "Disegna i punti predetti dal browser davanti alla penna per ridurre la latenza percepita. Non vengono mai salvati. Sperimentale.",
};

let table: Partial<Record<MessageKey, string>> | null = null;

export function t(key: MessageKey, vars?: Record<string, string>): string {
	table ??= getLanguage().startsWith("it") ? it : {};
	let text = table[key] ?? en[key];
	if (vars) for (const [k, v] of Object.entries(vars)) text = text.replace(`{${k}}`, v);
	return text;
}
