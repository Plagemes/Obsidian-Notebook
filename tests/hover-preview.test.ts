import { describe, expect, it } from "vitest";
import {
	asHoverLinkEvent, hoverPage, hoverTarget, mayBeNotebookLink, readPagePreviewConfig, shouldShowPreview, splitLinktext,
} from "../src/view/hover-preview-logic";

const EXT = ["notebook", "nbk"];

describe("hover preview logic", () => {
	it("splits link texts", () => {
		expect(splitLinktext("Physics.notebook#p3&id=abc")).toEqual({ path: "Physics.notebook", subpath: "#p3&id=abc" });
		expect(splitLinktext(" Physics.notebook ")).toEqual({ path: "Physics.notebook", subpath: "" });
	});
	it("only notebook links are ours", () => {
		expect(mayBeNotebookLink("Physics.notebook#p3", EXT)).toBe(true);
		expect(mayBeNotebookLink("Physics.NOTEBOOK", EXT)).toBe(true);
		expect(mayBeNotebookLink("Note#Heading", EXT)).toBe(false);
		expect(mayBeNotebookLink("a.notebook.md", EXT)).toBe(false);
	});
	it("reads the page a subpath names", () => {
		expect(hoverTarget("#p3")).toEqual({ page: 3, pageId: null });
		expect(hoverTarget("")).toEqual({ page: 1, pageId: null });
		expect(hoverTarget("#Heading")).toEqual({ page: 1, pageId: null });
		expect(hoverTarget("#p3&id=pg_abc").pageId).toBe("pg_abc");
	});
	it("resolves by id, then by number, and reports deleted pages", () => {
		const pages = [{ id: "a" }, { id: "b" }, { id: "c" }];
		expect(hoverPage(pages, { page: 1, pageId: "c" })).toEqual({ index: 2 });
		expect(hoverPage(pages, { page: 2, pageId: null })).toEqual({ index: 1 });
		expect(hoverPage(pages, { page: 99, pageId: null })).toEqual({ index: 2 });
		expect(hoverPage(pages, { page: 1, pageId: "zz" })).toEqual({ missing: "deleted" });
		expect(hoverPage([], { page: 1, pageId: null })).toEqual({ missing: "deleted" });
	});
	it("follows the Page preview settings", () => {
		const on = readPagePreviewConfig({ plugins: { "page-preview": { enabled: true, instance: { overrides: { preview: false, notebook: true } } } } });
		expect(shouldShowPreview(on, "preview", false)).toBe(true);
		expect(shouldShowPreview(on, "notebook", false)).toBe(false);
		expect(shouldShowPreview(on, "notebook", true)).toBe(true);
		expect(shouldShowPreview(on, "unknown", false)).toBe(false);
		const off = readPagePreviewConfig({ plugins: { "page-preview": { enabled: false } } });
		expect(shouldShowPreview(off, "preview", true)).toBe(false);
		expect(readPagePreviewConfig(undefined).enabled).toBe(true);
		expect(readPagePreviewConfig({ plugins: { "page-preview": { instance: { overrides: { x: "no" } } } } }).overrides).toEqual({});
	});
	it("rejects incomplete events", () => {
		expect(asHoverLinkEvent(null)).toBeNull();
		expect(asHoverLinkEvent({ linktext: "a", source: "s" })).toBeNull();
	});
});
