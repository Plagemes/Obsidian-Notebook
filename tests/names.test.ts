/** Names of new notebooks and folders: case-insensitive existence checks, so an existing file is never written over. */
import { describe, expect, it, vi } from "vitest";
import { existsInsensitive, hasTrailingDotOrSpace, isDeviceName, sanitizeName } from "../src/storage/names";
import { FakeVault } from "./fake-vault";

vi.mock("obsidian", async () => (await import("./fake-vault")).obsidianMock());

const { createNotebook } = await import("../src/storage/notebooks");

describe("case-insensitive existence", () => {
	it("finds files and folders whatever their case, along the whole path", () => {
		const v = new FakeVault({ "Notebooks/Bio/anatomy.notebook": "{}" });
		expect(existsInsensitive(v.vault, "Notebooks/Bio/anatomy.notebook")).toBe(true);
		expect(existsInsensitive(v.vault, "Notebooks/Bio/Anatomy.notebook")).toBe(true);
		expect(existsInsensitive(v.vault, "notebooks/BIO/ANATOMY.NOTEBOOK")).toBe(true);
		expect(existsInsensitive(v.vault, "NOTEBOOKS/bio")).toBe(true);
		expect(existsInsensitive(v.vault, "Notebooks/Bio/Anatomy 2.notebook")).toBe(false);
		expect(existsInsensitive(v.vault, "Notebooks/Chem")).toBe(false);
		expect(existsInsensitive(v.vault, "Other/anatomy.notebook")).toBe(false);
	});

	it("uses Obsidian's insensitive lookup when the vault has one", () => {
		const v = new FakeVault();
		const lookup = { ...v.vault, getAbstractFileByPathInsensitive: (p: string) => (p.toLowerCase() === "a/b.md" ? { name: "B.md" } : null) };
		expect(existsInsensitive(lookup, "A/b.md")).toBe(true);
		expect(existsInsensitive(lookup, "A/c.md")).toBe(false);
	});
});

describe("creating a notebook never writes over a file", () => {
	it("picks the next free name when only the case differs", async () => {
		const v = new FakeVault({ "Notebooks/anatomy.notebook": "OLD" });
		const file = await createNotebook(v.app, "Notebooks", "Anatomy");
		expect(file.path).toBe("Notebooks/Anatomy 2.notebook");
		expect(v.files.get("Notebooks/anatomy.notebook")).toBe("OLD");
		expect(v.log).toEqual(["create Notebooks/Anatomy 2.notebook"]);
	});

	it("skips every taken name, whatever its case", async () => {
		const v = new FakeVault({ "Notebooks/ANATOMY.notebook": "1", "Notebooks/anatomy 2.notebook": "2" });
		const file = await createNotebook(v.app, "notebooks", "Anatomy");
		expect(file.path).toBe("notebooks/Anatomy 3.notebook");
		expect(v.files.get("Notebooks/ANATOMY.notebook")).toBe("1");
		expect(v.files.get("Notebooks/anatomy 2.notebook")).toBe("2");
	});

	it("creates the name the dialog checked (sanitised)", async () => {
		const v = new FakeVault();
		const file = await createNotebook(v.app, "Notebooks", "  Anatomy   2024 ");
		expect(file.path).toBe(`Notebooks/${sanitizeName("  Anatomy   2024 ")}.notebook`);
		expect(file.path).toBe("Notebooks/Anatomy 2024.notebook");
	});
});

describe("name rules", () => {
	it("knows Windows device names and trailing dots or spaces", () => {
		expect(isDeviceName("LPT3.txt")).toBe(true);
		expect(isDeviceName("LPT")).toBe(false);
		expect(hasTrailingDotOrSpace("a.")).toBe(true);
		expect(hasTrailingDotOrSpace("a ")).toBe(true);
		expect(hasTrailingDotOrSpace("a.b")).toBe(false);
	});
});
