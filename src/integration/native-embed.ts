import { Component, parseLinktext, type MarkdownPostProcessorContext, type Plugin, type TFile } from "obsidian";
import { NOTEBOOK_EXTENSIONS } from "../storage/format";
import { NotebookEmbed, type EmbedDeps } from "./embed";
import { embedSourceFromFile, embedSourceFromSrc, isNotebookEmbedSrc } from "./page-links";

/** What Obsidian passes when it creates an embed for a file (not part of the public typings). */
interface EmbedInfo {
	containerEl: HTMLElement;
	linktext?: string;
	sourcePath?: string;
}

type EmbedCreator = (info: EmbedInfo, file: TFile, subpath: string) => Component;

/** The embed registry of Obsidian's app, which the public typings do not declare. */
interface EmbedRegistryLike {
	registerExtensions(extensions: string[], creator: EmbedCreator): void;
	unregisterExtensions?(extensions: string[]): void;
}

function embedRegistryOf(app: unknown): EmbedRegistryLike | null {
	const registry = (app as { embedRegistry?: Partial<EmbedRegistryLike> }).embedRegistry;
	return registry && typeof registry.registerExtensions === "function" ? (registry as EmbedRegistryLike) : null;
}

/** One native embed (`![[Physics.notebook#p3]]`): the same page preview as the `notebook` code block. */
class NativeNotebookEmbed extends Component {
	constructor(
		private readonly info: EmbedInfo,
		private readonly file: TFile,
		private readonly subpath: string,
		private readonly deps: EmbedDeps,
	) {
		super();
	}

	/** Called by Obsidian once the embed is in the document. */
	loadFile(): Promise<void> {
		// Obsidian normally loads the component itself; loading twice is a no-op.
		this.load();
		const source = embedSourceFromFile(this.file.path, this.subpath);
		this.addChild(new NotebookEmbed(this.info.containerEl, source, this.info.sourcePath ?? "", this.deps));
		return Promise.resolve();
	}
}

export type NativeEmbedMode = "registry" | "postprocessor";

/**
 * Makes `![[Notebook.notebook#p3]]` render a page preview.
 *
 * Preferred: Obsidian's embed registry (reading view and live preview, like images and PDFs). That
 * registry is not part of the public API, so it is feature-detected. Without it (or if registering
 * fails) a Markdown post-processor handles reading view only; live preview then keeps showing the
 * plain embed and the `notebook` code block is the way to get a preview there.
 */
export function registerNativeEmbed(plugin: Plugin, deps: EmbedDeps): NativeEmbedMode {
	const registry = embedRegistryOf(plugin.app);
	if (registry) {
		const extensions = [...NOTEBOOK_EXTENSIONS];
		try {
			registry.registerExtensions(extensions, (info, file, subpath) => new NativeNotebookEmbed(info, file, subpath, deps));
			plugin.register(() => registry.unregisterExtensions?.(extensions));
			return "registry";
		} catch (e) {
			console.warn("[notebook] embed registry unavailable, using the reading-view fallback", e);
		}
	}
	plugin.registerMarkdownPostProcessor((el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
		for (const embedEl of Array.from(el.querySelectorAll<HTMLElement>(".internal-embed"))) {
			const src = embedEl.getAttribute("src") ?? "";
			if (!isNotebookEmbedSrc(parseLinktext(src).path, NOTEBOOK_EXTENSIONS) || embedEl.hasClass("notebook-embed-host")) continue;
			embedEl.empty();
			ctx.addChild(new NotebookEmbed(embedEl, embedSourceFromSrc(src), ctx.sourcePath, deps));
		}
	});
	return "postprocessor";
}
