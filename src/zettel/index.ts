import type { Menu, Plugin } from "obsidian";
import { t, type MessageKey } from "../i18n";
import { isNotebookFile } from "../storage/format";
import { NotebookView } from "../view/notebook-view";
import { openHygiene } from "./hygiene-view";
import { registerInbox } from "./inbox";
import type { InboxService } from "./inbox-service";
import type { SequenceKind } from "./sequence";
import { ZettelService, type ZettelHost } from "./service";

export type { ZettelHost } from "./service";

const services = new WeakMap<Plugin, ZettelService>();
const inboxes = new WeakMap<Plugin, InboxService>();

/** 0.12: the Inbox service of a plugin (the inbox bell of Home and the library). */
export function inboxService(plugin: Plugin): InboxService | undefined {
	return inboxes.get(plugin);
}

/** The service of a plugin, for the settings tab. */
export function zettelService(plugin: Plugin): ZettelService | undefined {
	return services.get(plugin);
}

/** Registers the Zettelkasten core (M15 wave 0.6): card index, region overlay, commands and the notebook menu entries. Called once from onload. */
export function registerZettel(plugin: ZettelHost): ZettelService {
	const service = new ZettelService(plugin);
	service.register();
	services.set(plugin, service);
	const { app } = plugin;

	const withView = (checking: boolean, run: (view: NotebookView) => void, when: (view: NotebookView) => boolean = () => true): boolean => {
		const view = app.workspace.getActiveViewOfType(NotebookView);
		if (!view?.document || !when(view)) return false;
		if (!checking) run(view);
		return true;
	};
	const viewCommand = (id: string, name: MessageKey, run: (view: NotebookView) => void, when?: (view: NotebookView) => boolean) => {
		plugin.addCommand({ id, name: t(name), checkCallback: (checking) => withView(checking, run, when) });
	};

	viewCommand("zettel-card-from-selection", "zettel.command.fromSelection", (v) => service.cardFromSelection(v), (v) => v.selectionRegion() !== null);
	viewCommand("zettel-card-from-page", "zettel.command.fromPage", (v) => service.cardFromPage(v));
	viewCommand("zettel-card-title", "zettel.command.title", (v) => service.setCardTitle(v));
	viewCommand("zettel-link-arrows", "zettel.command.linkArrows", (v) => service.linkArrowsOnPage(v));
	viewCommand("zettel-show-cards", "zettel.command.showCards", (v) => service.showCards(v));
	viewCommand("zettel-toggle-slip-box", "zettel.command.toggleSlipBox", (v) => service.toggleSlipBox(v));
	plugin.addCommand({ id: "zettel-new-slip-box", name: t("zettel.command.newSlipBox"), callback: () => void service.newSlipBox() });
	plugin.addCommand({ id: "zettel-orphans", name: t("zettel.command.orphans"), callback: () => service.showOrphans() });
	plugin.addCommand({ id: "zettel-hygiene", name: t("hygiene.command"), callback: () => openHygiene(app, service) }); // 0.29 hygiene (Z10)
	plugin.addCommand({ id: "zettel-toggle-regions", name: t("zettel.command.toggleRegions"), callback: () => void service.toggleRegions() });

	// 0.30 zsequence (Z7): follow-up and branch cards and walking the numbering; they exist only with Luhmann numbering.
	const sequenceCommand = (id: string, name: MessageKey, needs: "card" | "notebook", run: () => void) => {
		plugin.addCommand({
			id, name: t(name),
			checkCallback: (checking) => {
				if (!service.sequenceAvailable(needs)) return false;
				if (!checking) run();
				return true;
			},
		});
	};
	const newSequenceCard = (kind: SequenceKind) => {
		const view = app.workspace.getActiveViewOfType(NotebookView);
		if (view?.document) service.newSequenceCard(view, kind);
	};
	sequenceCommand("zettel-sequence-follow-up", "sequence.command.followUp", "notebook", () => newSequenceCard("follow-up"));
	sequenceCommand("zettel-sequence-branch", "sequence.command.branch", "notebook", () => newSequenceCard("branch"));
	sequenceCommand("zettel-sequence-show", "sequence.command.show", "card", () => service.showSequence());
	sequenceCommand("zettel-sequence-previous", "sequence.command.previous", "card", () => service.goSequence("previous"));
	sequenceCommand("zettel-sequence-next", "sequence.command.next", "card", () => service.goSequence("next"));
	sequenceCommand("zettel-sequence-parent", "sequence.command.parent", "card", () => service.goSequence("parent"));
	sequenceCommand("zettel-sequence-children", "sequence.command.children", "card", () => service.goSequence("children"));

	// The notebook tab's "More options" menu (and the file menu of the notebook in that tab).
	plugin.registerEvent(app.workspace.on("file-menu", (menu: Menu, file, _source, leaf) => {
		const view = leaf?.view;
		if (!(view instanceof NotebookView) || !view.document || !view.file || view.file !== file || !isNotebookFile(view.file)) return;
		menu.addSeparator();
		if (view.selectionRegion()) {
			menu.addItem((i) => i.setTitle(t("zettel.command.fromSelection")).setIcon("square-dashed").onClick(() => service.cardFromSelection(view)));
		}
		menu.addItem((i) => i.setTitle(t("zettel.command.fromPage")).setIcon("id-card").onClick(() => service.cardFromPage(view)));
		menu.addItem((i) => i.setTitle(t("zettel.command.title")).setIcon("heading").onClick(() => service.setCardTitle(view)));
		menu.addItem((i) => i.setTitle(t("zettel.command.showCards")).setIcon("layout-list").onClick(() => service.showCards(view)));
		if (service.sequenceAvailable("card")) menu.addItem((i) => i.setTitle(t("sequence.command.show")).setIcon("git-fork").onClick(() => service.showSequence()));
		menu.addItem((i) => i.setTitle(t(service.isSlipBox(view) ? "zettel.menu.slipBoxOff" : "zettel.menu.slipBoxOn")).setIcon("archive")
			.onClick(() => service.toggleSlipBox(view)));
	}));
	// wave 0.8: processing flow (Z4): the Inbox view and its commands
	inboxes.set(plugin, registerInbox(plugin, service));
	return service;
}
