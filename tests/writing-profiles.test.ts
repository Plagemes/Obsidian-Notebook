import { describe, expect, it } from "vitest";
import { ACTIONS, baseContext } from "../src/ui/actions";
import { contextBoost, forThisPage } from "../src/ui/context-rank";
import { ACTION_HELP } from "../src/ui/help-text";
import { en } from "../src/i18n/en";
import { it as itMessages } from "../src/i18n/it";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import { FAVOURITE_SLOTS } from "../src/view/favourites";
import { defaultPenSets, MAX_PEN_SETS, type PenSet } from "../src/view/pen-sets";
import {
	activeProfile, addProfile, allProfiles, applyPatch, BUILTIN_PROFILES, deleteProfile, ensureProfileSet, findProfile, isCurrent, MAX_PROFILES,
	nextProfileId, normaliseActive, normaliseProfiles, profilePens, profileSetId, switchOnLecture, updateProfile, type CurrentState, type WritingProfile,
} from "../src/view/writing-profiles";

const state = (over: Partial<CurrentState> = {}): CurrentState => ({
	pens: [{ tool: "pen", color: "#112233", width: 1.5 }], penSetId: null, stabilization: 4, paper: "dotted", ...over,
});

describe("built-in profiles", () => {
	it("are Lecture (fast) and Study (careful), valid and distinct", () => {
		const [lecture, study] = BUILTIN_PROFILES as readonly [WritingProfile, WritingProfile];
		expect(lecture.id).toBe("lecture");
		expect(study.id).toBe("study");
		expect(lecture.stabilization).toBeLessThan(study.stabilization);
		expect(lecture.paper).toBe("ruled");
		for (const p of BUILTIN_PROFILES) {
			expect(p.pens.length).toBeGreaterThan(0);
			expect(p.pens.length).toBeLessThanOrEqual(FAVOURITE_SLOTS);
			expect(normaliseProfiles([{ ...p, id: "x-" + p.id }])).toHaveLength(1); // the same shape survives the lenient reader
		}
	});

	it("always come first and are never stored", () => {
		const custom = addProfile([], "Mine", state())!.profiles;
		expect(allProfiles(custom).map((p) => p.id)).toEqual(["lecture", "study", "profile-1"]);
		expect(normaliseProfiles(BUILTIN_PROFILES)).toEqual([]);
	});
});

describe("apply", () => {
	it("gives the settings patch of a profile and marks it active", () => {
		const study = findProfile([], "study")!;
		expect(applyPatch(study)).toEqual({ stabilization: study.stabilization, defaultPaper: study.paper, writingProfileActive: "study" });
	});

	it("touches nothing but stabilization, paper and the active id", () => {
		const patch = applyPatch(findProfile([], "lecture")!);
		expect(Object.keys(patch).sort()).toEqual(["defaultPaper", "stabilization", "writingProfileActive"]);
	});

	it("shows the profile only while the settings still match it", () => {
		const lecture = findProfile([], "lecture")!;
		const s = applyPatch(lecture);
		expect(activeProfile([], s)?.id).toBe("lecture");
		expect(isCurrent(lecture, { ...s, stabilization: s.stabilization + 1 })).toBe(false);
		expect(activeProfile([], { ...s, stabilization: s.stabilization + 1 })).toBeNull();
		expect(activeProfile([], { ...s, writingProfileActive: "" })).toBeNull();
		expect(activeProfile([], { ...s, writingProfileActive: "gone" })).toBeNull();
	});

	it("takes the pens from the referenced pen set while it exists, else from its own list", () => {
		const sets = defaultPenSets();
		const p: WritingProfile = { id: "profile-1", name: "x", pens: [{ tool: "pen", color: "#000000", width: 1 }], penSetId: sets[0]!.id, stabilization: 2, paper: "grid" };
		expect(profilePens(p, sets)).toEqual(sets[0]!.pens);
		expect(profilePens(p, [])).toEqual(p.pens);
	});

	it("makes a pen set from the pen list once, then leaves a set the user edited alone", () => {
		const lecture = findProfile([], "lecture")!;
		const first = ensureProfileSet([], lecture, "Lecture")!;
		expect(first.id).toBe(profileSetId(lecture));
		expect(first.sets).toHaveLength(1);
		expect(first.sets[0]!.pens).toEqual(lecture.pens);
		const edited: PenSet[] = [{ ...first.sets[0]!, pens: [{ tool: "pen", color: "#abcdef", width: 3 }] }];
		const again = ensureProfileSet(edited, lecture, "Lecture")!;
		expect(again.sets).toHaveLength(1);
		expect(again.sets[0]!.pens[0]!.color).toBe("#abcdef");
	});

	it("uses the referenced pen set and creates nothing when it exists", () => {
		const sets = defaultPenSets();
		const p: WritingProfile = { id: "profile-1", name: "x", pens: state().pens.map((x) => ({ ...x })), penSetId: sets[1]!.id, stabilization: 2, paper: "grid" };
		const r = ensureProfileSet(sets, p, "x")!;
		expect(r.id).toBe(sets[1]!.id);
		expect(r.sets).toHaveLength(sets.length);
	});

	it("does not exceed the pen set limit", () => {
		const full: PenSet[] = Array.from({ length: MAX_PEN_SETS }, (_, i) => ({ id: `set-${i + 1}`, name: `S${i}`, pens: [{ tool: "pen", color: "#000000", width: 1 }] }));
		expect(ensureProfileSet(full, findProfile([], "study")!, "Study")).toBeNull();
	});
});

describe("custom profiles (save, update, delete)", () => {
	it("saves the current state under a fresh id", () => {
		const r = addProfile([], "  My   class  ", state())!;
		expect(r.id).toBe("profile-1");
		expect(r.profiles[0]).toMatchObject({ name: "My class", stabilization: 4, paper: "dotted" });
		expect(addProfile(r.profiles, "Second", state())!.id).toBe("profile-2");
	});

	it("keeps a pen set reference", () => {
		expect(addProfile([], "Ref", state({ penSetId: "set-2" }))!.profiles[0]!.penSetId).toBe("set-2");
	});

	it("refuses an empty name, no pens, and more than the limit", () => {
		expect(addProfile([], "   ", state())).toBeNull();
		expect(addProfile([], "x", state({ pens: [] }))).toBeNull();
		let custom: WritingProfile[] = [];
		for (let i = 0; i < MAX_PROFILES; i++) custom = addProfile(custom, `P${i}`, state())!.profiles;
		expect(addProfile(custom, "one more", state())).toBeNull();
	});

	it("updates only the chosen profile, and the built-in ones are not in the stored list to change", () => {
		let custom = addProfile([], "A", state())!.profiles;
		custom = addProfile(custom, "B", state())!.profiles;
		const next = updateProfile(custom, "profile-2", state({ stabilization: 9, paper: "grid" }));
		expect(next[0]).toEqual(custom[0]);
		expect(next[1]).toMatchObject({ name: "B", stabilization: 9, paper: "grid" });
		expect(updateProfile(custom, "lecture", state({ stabilization: 9 }))).toEqual(custom);
	});

	it("deletes one profile", () => {
		const custom = addProfile(addProfile([], "A", state())!.profiles, "B", state())!.profiles;
		expect(deleteProfile(custom, "profile-1").map((p) => p.id)).toEqual(["profile-2"]);
		expect(deleteProfile(custom, "nope")).toHaveLength(2);
	});

	it("reuses a freed id only when nothing uses it", () => {
		let custom = addProfile([], "A", state())!.profiles;
		custom = addProfile(custom, "B", state())!.profiles;
		custom = deleteProfile(custom, "profile-1");
		expect(addProfile(custom, "C", state())!.id).toBe("profile-3");
	});
});

describe("reading saved data", () => {
	it("drops bad entries, repeated ids and clamps the level", () => {
		const good = { id: "profile-1", name: "Good", pens: [{ tool: "pen", color: "#000000", width: 1 }], stabilization: 99, paper: "grid" };
		const out = normaliseProfiles([
			good, good, null, 5, { ...good, id: "profile-2", name: "" }, { ...good, id: "profile-3", pens: [] }, { ...good, id: "profile-4", paper: "nope" },
			{ ...good, id: "profile-5", stabilization: "x" }, { ...good, id: "bad id!" }, { ...good, id: "lecture" },
		]);
		expect(out.map((p) => p.id)).toEqual(["profile-1"]);
		expect(out[0]!.stabilization).toBe(10);
	});

	it("gives none for anything that is not a list", () => {
		for (const v of [undefined, null, "x", 3, {}]) expect(normaliseProfiles(v)).toEqual([]);
	});

	it("keeps an active id only if it names a profile", () => {
		const custom = addProfile([], "A", state())!.profiles;
		expect(normaliseActive("study", custom)).toBe("study");
		expect(normaliseActive("profile-1", custom)).toBe("profile-1");
		expect(normaliseActive("profile-9", custom)).toBe("");
		expect(normaliseActive(7, custom)).toBe("");
	});

	it("goes through the plugin settings reader and back", () => {
		const custom = addProfile([], "A", state())!.profiles;
		const s = readSettings({ writingProfiles: custom, writingProfileActive: "profile-1", writingProfileOnLecture: true });
		expect(s.writingProfiles).toEqual(custom);
		expect(s.writingProfileActive).toBe("profile-1");
		expect(s.writingProfileOnLecture).toBe(true);
		const d = readSettings({});
		expect(d.writingProfiles).toEqual([]);
		expect(d.writingProfileActive).toBe("");
		expect(d.writingProfileOnLecture).toBe(false);
		expect(DEFAULT_SETTINGS.writingProfileOnLecture).toBe(false);
	});
});

describe("cycling and lecture mode", () => {
	it("cycles Lecture, Study, custom, round", () => {
		const custom = addProfile([], "A", state())!.profiles;
		expect(nextProfileId(custom, "")).toBe("lecture");
		expect(nextProfileId(custom, "lecture")).toBe("study");
		expect(nextProfileId(custom, "study")).toBe("profile-1");
		expect(nextProfileId(custom, "profile-1")).toBe("lecture");
	});

	it("switches to Lecture on lecture start only when the setting is on and it is not in use already", () => {
		const lecture = applyPatch(findProfile([], "lecture")!);
		const study = applyPatch(findProfile([], "study")!);
		expect(switchOnLecture(false, study)).toBe(false);
		expect(switchOnLecture(true, study)).toBe(true);
		expect(switchOnLecture(true, lecture)).toBe(false);
		expect(switchOnLecture(true, { ...lecture, stabilization: 7 })).toBe(true);
	});
});

describe("actions, ranking and help", () => {
	const ids = ["profile-lecture", "profile-study", "profile-next"];
	const find = (id: string) => ACTIONS.find((a) => a.id === id)!;

	it("have a label, a command and a long-press help in both languages", () => {
		for (const id of ids) {
			const a = find(id);
			expect(a, id).toBeDefined();
			expect(typeof a.command, id).toBe("string");
			for (const key of [a.label, a.command as string, ACTION_HELP[id]!]) {
				expect((en as Record<string, string>)[key], key).toBeTruthy();
				expect((itMessages as Record<string, string>)[key], key).toBeTruthy();
			}
			expect((en as Record<string, string>)[ACTION_HELP[id]!]!.length).toBeLessThanOrEqual(200);
		}
		for (const key of ["help.profileChip", "profiles.chip", "profiles.none", "settings.profileOnLecture", "settings.profileOnLecture.desc"]) {
			expect((en as Record<string, string>)[key], key).toBeTruthy();
			expect((itMessages as Record<string, string>)[key], key).toBeTruthy();
		}
	});

	it("rank the Lecture profile first during a class, until it is the one in use", () => {
		const lecture = find("profile-lecture");
		const inClass = baseContext({ lecture: true });
		expect(contextBoost(lecture, inClass)).toBeGreaterThanOrEqual(20);
		expect(forThisPage(ACTIONS, inClass, {}, 0, new Set(), 100).map((a) => a.id)).toContain("profile-lecture");
		expect(contextBoost(lecture, baseContext({ lecture: true, profile: "lecture" }))).toBeLessThan(20);
		expect(contextBoost(lecture, baseContext())).toBeLessThan(20);
		expect(contextBoost(lecture, baseContext({ open: false, editable: false, lecture: true }))).toBe(0);
	});

	it("mark the profile in use as checked and work on a read-only notebook", () => {
		expect(find("profile-study").checked?.(baseContext({ profile: "study" }))).toBe(true);
		expect(find("profile-study").checked?.(baseContext())).toBe(false);
		for (const id of ids) expect(find(id).readOnly).toBe(true);
	});
});
