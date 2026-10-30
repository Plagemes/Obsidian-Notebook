import { describe, expect, it } from "vitest";
import { notebookUri } from "../src/integration/links";
import {
	companionContent, mergeCompanion, readRegionState, readTags, renderRegion, unreadTags, updateCompanionText, type CompanionTextDeps,
} from "../src/model/companion-content";
import { createDocument } from "../src/model/document";
import {
	addTypedTags, computeSharedTags, isObsidianTag, normalizeTag, normalizeTagList, parseTagInput, suggestTags, tagAncestors, tagIsWithin, tagsFromVault,
} from "../src/model/tags";
import { LibraryIndex, type LibraryEntry } from "../src/library/index";

describe("normalizeTag", () => {
	it("writes tags the way Obsidian does", () => {
		expect(normalizeTag("#exam")).toBe("exam");
		expect(normalizeTag("##exam")).toBe("exam");
		expect(normalizeTag("  linear algebra ")).toBe("linear-algebra");
		expect(normalizeTag("Physics/Optics")).toBe("Physics/Optics");
		expect(normalizeTag("física/ottica")).toBe("física/ottica");
		expect(normalizeTag("a b/c d")).toBe("a-b/c-d");
	});

	it("keeps nested levels clean", () => {
		expect(normalizeTag("a//b")).toBe("a/b");
		expect(normalizeTag("/a/b/")).toBe("a/b");
		expect(normalizeTag("a / b")).toBe("a-/-b");
		expect(normalizeTag("a/")).toBe("a");
	});

	it("drops characters that are not allowed and refuses what is not a tag", () => {
		expect(normalizeTag("C++")).toBe("C");
		expect(normalizeTag("what?!")).toBe("what");
		expect(normalizeTag("2026")).toBeNull();
		expect(normalizeTag("1/2")).toBeNull();
		expect(normalizeTag("2026/q1")).toBe("2026/q1");
		expect(normalizeTag("   ")).toBeNull();
		expect(normalizeTag("#")).toBeNull();
		expect(normalizeTag("???")).toBeNull();
	});

	it("keeps emoji, which Obsidian allows in tags", () => {
		expect(normalizeTag("#📚")).toBe("📚");
		expect(normalizeTag("study 📚")).toBe("study-📚");
	});
});

describe("normalizeTagList / parseTagInput", () => {
	it("merges duplicates ignoring case and reports what cannot be a tag", () => {
		expect(normalizeTagList(["Math", "#math", "linear algebra", "2026", "", "  ", "???"])).toEqual({
			tags: ["Math", "linear-algebra"],
			rejected: ["2026", "???"],
		});
	});

	it("splits what is typed in the field", () => {
		expect(parseTagInput("a, b;c\nd")).toEqual(["a", "b", "c", "d"]);
		expect(parseTagInput("#a #b")).toEqual(["#a", "#b"]);
		expect(parseTagInput("two words, x")).toEqual(["two words", "x"]);
		expect(parseTagInput("  ,, ")).toEqual([]);
	});
});

describe("tag editor: existing tags stay as they are", () => {
	it("flags tags Obsidian would not take, without changing them", () => {
		expect(isObsidianTag("physics/optics")).toBe(true);
		expect(isObsidianTag("2026")).toBe(false);
		expect(isObsidianTag("C++")).toBe(false);
		expect(isObsidianTag("big idea")).toBe(false);
	});

	it("adds only new typed tags; existing ones keep spelling, order and validity", () => {
		const current = ["2026", "C++", "Physics", "big idea"];
		expect(addTypedTags(current, [])).toEqual(current);
		expect(addTypedTags(current, ["exam"])).toEqual([...current, "exam"]);
		// Already there, ignoring case, or as the normalised form of an existing tag: not added twice.
		expect(addTypedTags(current, ["physics", "C", "big-idea"])).toEqual(current);
		expect(addTypedTags([], ["a", "A", "b"])).toEqual(["a", "b"]);
		// The typed text is normalised before it gets here (normalizeTagList), never the existing tags.
		expect(addTypedTags(current, normalizeTagList(["#Exam prep", "1999"]).tags)).toEqual([...current, "Exam-prep"]);
	});
});

describe("tags of the vault and suggestions", () => {
	const vault = tagsFromVault({ "#physics": 5, "#physics/optics": 2, "#exam": 7, "#Exam": 1, "#2026": 3, "#math": 7 });

	it("reads metadataCache.getTags() most used first and merges case variants", () => {
		expect(vault.map((x) => x.tag)).toEqual(["exam", "math", "physics", "physics/optics"]);
		expect(vault[0]).toEqual({ tag: "exam", count: 8 });
		expect(tagsFromVault(undefined)).toEqual([]);
	});

	it("suggests by prefix, then nested level, then substring, without the tags already chosen", () => {
		expect(suggestTags("ph", vault)).toEqual(["physics", "physics/optics"]);
		expect(suggestTags("op", vault)).toEqual(["physics/optics"]);
		expect(suggestTags("ath", vault)).toEqual(["math"]);
		expect(suggestTags("#PHY", vault, { exclude: ["Physics"] })).toEqual(["physics/optics"]);
		expect(suggestTags("", vault, { limit: 2 })).toEqual(["exam", "math"]);
		expect(suggestTags("zzz", vault)).toEqual([]);
	});

	it("knows nesting like the Tags pane", () => {
		expect(tagAncestors("a/b/c")).toEqual(["a", "a/b"]);
		expect(tagAncestors("a")).toEqual([]);
		expect(tagIsWithin("physics/optics", "Physics")).toBe(true);
		expect(tagIsWithin("physics", "physics")).toBe(true);
		expect(tagIsWithin("physicsx", "physics")).toBe(false);
		expect(tagIsWithin("physics", "physics/optics")).toBe(false);
	});
});

describe("computeSharedTags: the merge rule", () => {
	it("adds the notebook's tags and keeps the person's, notebook tags first", () => {
		expect(computeSharedTags(["physics", "exam"], ["mine", "also-mine"], null)).toEqual({
			tags: ["physics", "exam", "mine", "also-mine"],
			owned: ["physics", "exam"],
		});
	});

	it("removes a tag the plugin added once the notebook drops it", () => {
		const r = computeSharedTags(["exam"], ["physics", "exam", "mine"], ["physics", "exam"]);
		expect(r.tags).toEqual(["exam", "mine"]);
		expect(r.owned).toEqual(["exam"]);
	});

	it("never removes a tag the person wrote by hand, also when the notebook later had the same tag", () => {
		// The person wrote #physics in the note first; the notebook gets the same tag: it is still the person's.
		const first = computeSharedTags(["physics"], ["physics", "x"], []);
		expect(first.owned).toEqual([]);
		// The notebook drops it: the person's tag stays.
		const second = computeSharedTags([], first.tags, first.owned);
		expect(second.tags).toEqual(["physics", "x"]);
	});

	it("never removes a tag the person added after the plugin's last update", () => {
		const first = computeSharedTags(["exam"], [], null);
		expect(first).toEqual({ tags: ["exam"], owned: ["exam"] });
		const typed = [...first.tags, "added-by-hand"];
		const second = computeSharedTags([], typed, first.owned);
		expect(second.tags).toEqual(["added-by-hand"]);
		const third = computeSharedTags(["new"], second.tags, second.owned);
		expect(third.tags).toEqual(["new", "added-by-hand"]);
	});

	it("keeps the person's spelling for their own tag and ignores case when matching", () => {
		const r = computeSharedTags(["physics"], ["Physics"], []);
		expect(r.tags).toEqual(["Physics"]);
		expect(computeSharedTags(["Physics"], ["physics"], ["physics"]).tags).toEqual(["Physics"]);
	});

	it("puts a tag back if the person deleted it from the note while the notebook still has it", () => {
		const r = computeSharedTags(["exam"], ["mine"], ["exam"]);
		expect(r.tags).toEqual(["exam", "mine"]);
		expect(r.owned).toEqual(["exam"]);
	});

	it("without a known state nothing is removed", () => {
		expect(computeSharedTags([], ["a", "b"], null).tags).toEqual(["a", "b"]);
	});

	it("has no duplicates", () => {
		expect(computeSharedTags(["a", "A"], ["a", "b", "B"], null).tags).toEqual(["a", "b"]);
	});
});

// A tiny frontmatter format for the tests: `key: <json>` per line.
const DEPS: CompanionTextDeps = {
	frontmatterInfo(text) {
		const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
		if (!m) return { exists: false, from: 0, to: 0 };
		return { exists: true, from: 4, to: 4 + m[1]!.length };
	},
	parseFrontmatter(yaml) {
		const out: Record<string, unknown> = {};
		for (const line of yaml.split(/\r?\n/)) {
			const i = line.indexOf(": ");
			if (i > 0) out[line.slice(0, i)] = JSON.parse(line.slice(i + 2));
		}
		return out;
	},
	stringify: (data) => Object.entries(data).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n"),
};

const PATH = "Notebooks/Physics.notebook";
function contentWith(tags: string[]) {
	const doc = createDocument(new Date("2026-10-29T10:00:00Z"));
	doc.id = "doc-1";
	doc.meta = { tags, favorite: false, cover: "#3b82f6", bookmarks: [] };
	return companionContent(doc, { notebookPath: PATH, pageUri: (p) => notebookUri("", PATH, p) });
}

/** The note after an update, as the service would write it. */
function update(text: string | null, tags: string[]): string {
	const content = contentWith(tags);
	if (text === null) {
		const region = renderRegion(content);
		return `---\n${DEPS.stringify({ ...content.properties, ...(tags.length > 0 ? { tags: content.tags } : {}) })}\n---\n${region}\n`;
	}
	const out = updateCompanionText(text, content, (owned) => renderRegion(content, owned), DEPS);
	return out.kind === "changed" ? out.text : text;
}

function noteTags(text: string): string[] {
	const info = DEPS.frontmatterInfo(text);
	const fm = DEPS.parseFrontmatter(text.slice(info.from, info.to)) ?? {};
	return (fm.tags as string[] | undefined) ?? [];
}

describe("companion note: tags across updates", () => {
	it("a new note owns every tag it gets", () => {
		const note = update(null, ["physics", "exam"]);
		expect(readRegionState(note)?.tags).toEqual(["physics", "exam"]);
	});

	it("tags the person adds by hand survive every notebook change", () => {
		let note = update(null, ["physics"]);
		note = note.replace('"tags": ["physics"]', '"tags": ["physics"]').replace(/tags: \["physics"\]/, 'tags: ["physics","mine"]');
		expect(noteTags(note)).toEqual(["physics", "mine"]);

		note = update(note, ["physics", "exam"]);
		expect(noteTags(note)).toEqual(["physics", "exam", "mine"]);

		note = update(note, []);
		expect(noteTags(note)).toEqual(["mine"]);
		// The plugin owns none of them now.
		expect(readRegionState(note)?.tags).toEqual([]);
	});

	it("a tag written by hand before the notebook got it is not removed when the notebook drops it", () => {
		let note = update(null, []);
		// The person writes #exam in the note.
		note = note.replace(/\n---\n/, '\ntags: ["exam"]\n---\n');
		expect(noteTags(note)).toEqual(["exam"]);
		note = update(note, ["exam"]);
		expect(readRegionState(note)?.tags).toEqual([]);
		note = update(note, []);
		expect(noteTags(note)).toEqual(["exam"]);
	});

	it("removes only the tags the plugin added", () => {
		let note = update(null, ["a", "b"]);
		note = update(note, ["b"]);
		expect(noteTags(note)).toEqual(["b"]);
		note = update(note, []);
		expect(noteTags(note)).toEqual([]);
	});

	it("an update with nothing new does not rewrite the note", () => {
		const note = update(null, ["a"]);
		expect(updateCompanionText(note, contentWith(["a"]), (owned) => renderRegion(contentWith(["a"]), owned), DEPS)).toEqual({ kind: "unchanged" });
	});

	it("keeps tag entries it does not read (numbers, empty items) as they are", () => {
		expect(readTags([2026, "physics"])).toEqual(["physics"]);
		expect(unreadTags([2026, "physics", null, " "])).toEqual([2026, null, " "]);
		expect(unreadTags(2026)).toEqual([2026]);
		expect(unreadTags("2026, physics")).toEqual([]);
		// `tags: [2026, physics]` in the note, the notebook gets `exam`: 2026 is not lost.
		const r = mergeCompanion({ tags: [2026, "physics"] }, contentWith(["exam"]), null);
		expect(r.properties.tags).toEqual(["exam", "physics", 2026]);
		// Nothing else changes: the note's own order stays and nothing is rewritten.
		const same = mergeCompanion({ tags: [2026, "exam"] }, contentWith(["exam"]), { keys: [], tags: ["exam"] });
		expect(same.properties.tags).toEqual([2026, "exam"]);
		// Every plugin tag gone: the entries it does not read stay, the property is not dropped.
		const gone = mergeCompanion({ tags: ["exam", 2026] }, contentWith([]), { keys: [], tags: ["exam"] });
		expect(gone.properties.tags).toEqual([2026]);
		expect(mergeCompanion({ tags: 2026 }, contentWith([]), null).properties.tags).toBe(2026);
		expect(mergeCompanion({ tags: 2026 }, contentWith(["exam"]), null).properties.tags).toEqual(["exam", 2026]);
	});

	it("mergeCompanion reports the owned tags", () => {
		const r = mergeCompanion({ tags: ["mine"] }, contentWith(["a"]), null);
		expect(r.ownedTags).toEqual(["a"]);
		expect(r.properties.tags).toEqual(["a", "mine"]);
	});
});

describe("library: tag filter follows nesting", () => {
	function entry(path: string, tags: string[]): LibraryEntry {
		return { path, folder: "", name: path, mtime: 1, size: 1, created: 1, modified: 1, pages: 1, tags, favorite: false, cover: "#3b82f6" };
	}

	it("a parent tag finds notebooks tagged with its children and counts them", () => {
		const idx = new LibraryIndex();
		idx.upsert(entry("A", ["physics/optics"]));
		idx.upsert(entry("B", ["physics"]));
		idx.upsert(entry("C", ["physicsx"]));
		const found = idx.query({ scope: { tag: "Physics" }, sort: "name" }).map((e) => e.path).sort();
		expect(found).toEqual(["A", "B"]);
		const tags = Object.fromEntries(idx.tags().map((t) => [t.tag, t.count]));
		expect(tags).toEqual({ physics: 2, "physics/optics": 1, physicsx: 1 });
	});
});
