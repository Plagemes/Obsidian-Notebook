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
	activeProfile, addProfile, allProfiles, applyPatch, BUILTIN_PROFILES, deleteProfile, dropProfileSet, ensureProfileSet, findProfile, isCurrent, MAX_PROFILES,
	nextProfileId, newProfileId, normaliseActive, normaliseProfiles, profilePens, profileSetId, switchNoticeKey, switchOnLecture, updateProfile, type CurrentState, type WritingProfile,
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
		expect(allProfiles(custom).map((p) => p.id)).toEqual(["lecture", "study", custom[0]!.id]);
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
		expect(r.id).toMatch(/^profile-[0-9a-z]{8}$/);
		expect(normaliseProfiles(r.profiles).map((p) => p.id)).toEqual([r.id]); // the lenient reader keeps it
		expect(r.profiles[0]).toMatchObject({ name: "My class", stabilization: 4, paper: "dotted" });
		expect(addProfile(r.profiles, "Second", state())!.id).not.toBe(r.id);
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
		const a = addProfile([], "A", state())!;
		const b = addProfile(a.profiles, "B", state())!;
		const custom = b.profiles;
		const next = updateProfile(custom, b.id, state({ stabilization: 9, paper: "grid" }));
		expect(next[0]).toEqual(custom[0]);
		expect(next[1]).toMatchObject({ name: "B", stabilization: 9, paper: "grid" });
		expect(updateProfile(custom, "lecture", state({ stabilization: 9 }))).toEqual(custom);
	});

	it("deletes one profile", () => {
		const a = addProfile([], "A", state())!;
		const b = addProfile(a.profiles, "B", state())!;
		expect(deleteProfile(b.profiles, a.id).map((p) => p.id)).toEqual([b.id]);
		expect(deleteProfile(b.profiles, "nope")).toHaveLength(2);
	});
});

describe("profile ids are never reused (review fix)", () => {
	const seq = (...values: number[]): (() => number) => {
		let i = 0;
		return () => values[Math.min(i++, values.length - 1)]!;
	};
	const zeros = [0, 0, 0, 0, 0, 0, 0, 0];
	const halves = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];

	it("a profile saved after another was deleted gets its own id", () => {
		let custom: WritingProfile[] = [];
		const ids: string[] = [];
		for (const name of ["A", "B", "C"]) {
			const r = addProfile(custom, name, state())!;
			custom = r.profiles;
			ids.push(r.id);
		}
		custom = deleteProfile(custom, ids[1]!);
		const d = addProfile(custom, "D", state())!;
		expect(ids).not.toContain(d.id);
		expect(new Set([...ids, d.id]).size).toBe(4);
	});

	it("skips an id that is taken, and one whose wp- pen set is still there", () => {
		const first = newProfileId([], [], seq(...zeros));
		expect(first).toBe("profile-00000000");
		const taken: WritingProfile = { id: first, name: "x", pens: [{ tool: "pen", color: "#000000", width: 1 }], stabilization: 1, paper: "grid" };
		// The random source repeats itself for the first id, then moves on.
		expect(newProfileId([taken], [], seq(...zeros, ...halves))).toBe("profile-iiiiiiii");
		expect(newProfileId([], [profileSetId({ id: first })], seq(...zeros, ...halves))).toBe("profile-iiiiiiii");
	});

	it("still finds a free id when the random source is stuck", () => {
		const stuck = () => 0;
		const a = newProfileId([], [], stuck);
		const custom: WritingProfile[] = [{ id: a, name: "x", pens: [{ tool: "pen", color: "#000000", width: 1 }], stabilization: 1, paper: "grid" }];
		const b = newProfileId(custom, [], stuck);
		expect(b).not.toBe(a);
		expect(normaliseProfiles([{ ...custom[0]!, id: b }])).toHaveLength(1);
	});

	it("delete a profile, save a new one while no set is active: the new one shows its own pens", () => {
		const sets = defaultPenSets();
		const a = addProfile([], "A", state({ pens: [{ tool: "pen", color: "#111111", width: 1 }] }), sets.map((s) => s.id))!;
		const madeA = ensureProfileSet(sets, a.profiles[0]!, "A")!;
		// Delete A: its set goes with it.
		const dropped = dropProfileSet(a.profiles[0]!, [], madeA.sets, {}, {});
		expect(dropped.sets.some((s) => s.id === madeA.id)).toBe(false);
		const b = addProfile([], "B", state({ pens: [{ tool: "pen", color: "#222222", width: 1 }] }), dropped.sets.map((s) => s.id))!;
		const madeB = ensureProfileSet(dropped.sets, b.profiles[0]!, "B")!;
		expect(profilePens(b.profiles[0]!, madeB.sets)).toEqual([{ tool: "pen", color: "#222222", width: 1 }]);
		// Settings left behind by an older version: the orphan set is still there, and a new id does not meet it.
		const c = addProfile(a.profiles, "C", state({ pens: [{ tool: "pen", color: "#333333", width: 1 }] }), madeA.sets.map((s) => s.id))!;
		expect(profileSetId({ id: c.id })).not.toBe(madeA.id);
	});
});

describe("deleting a profile and its pen set (review fix)", () => {
	const mine = (): WritingProfile => ({ id: "profile-aaaaaaaa", name: "Mine", pens: [{ tool: "pen", color: "#112233", width: 1.5 }], stabilization: 3, paper: "grid" });
	const withSet = (p: WritingProfile) => ensureProfileSet(defaultPenSets(), p, "Mine")!.sets;

	it("removes the set the profile made", () => {
		const p = mine();
		const sets = withSet(p);
		const r = dropProfileSet(p, [], sets, {}, {});
		expect(r.kept).toBe(false);
		expect(r.sets.map((s) => s.id)).toEqual(defaultPenSets().map((s) => s.id));
	});

	it("keeps it, and says so, while a notebook or a folder is assigned to it or another profile points at it", () => {
		const p = mine();
		const sets = withSet(p);
		const id = profileSetId(p);
		const other: WritingProfile = { ...mine(), id: "profile-bbbbbbbb", penSetId: id };
		const cases: Array<[Record<string, string>, Record<string, string>, WritingProfile[]]> = [
			[{ Maths: id }, {}, []],
			[{}, { abc: id }, []],
			[{}, {}, [other]],
		];
		for (const [folders, notebooks, remaining] of cases) {
			const r = dropProfileSet(p, remaining, sets, folders, notebooks);
			expect(r.kept).toBe(true);
			expect(r.sets.map((s) => s.id)).toContain(id);
		}
	});

it("keeps the set while another open notebook shows it on its strip", () => {		const p = mine();		const sets = withSet(p);		const id = profileSetId(p);		const kept = dropProfileSet(p, [], sets, {}, {}, [id]);		expect(kept.kept).toBe(true);		expect(kept.sets.map((s) => s.id)).toContain(id);		expect(dropProfileSet(p, [], sets, {}, {}, ["some-other-set"]).kept).toBe(false);	});
	it("never touches a set the user made, nor any other set, and does nothing when the profile never made one", () => {
		const own = defaultPenSets()[0]!;
		const p = { ...mine(), penSetId: own.id };
		const sets = withSet(p);
		const r = dropProfileSet(p, [], sets, {}, {});
		expect(r.sets.some((s) => s.id === own.id)).toBe(true);
		expect(dropProfileSet(mine(), [], defaultPenSets(), {}, {})).toEqual({ sets: defaultPenSets(), kept: false });
	});

	it("frees a place for the limit: a full list that held profile sets can take a switch again", () => {
		let sets = defaultPenSets();
		const made: WritingProfile[] = [];
		for (let i = 0; sets.length < MAX_PEN_SETS; i++) {
			const p = { ...mine(), id: `profile-n${i}` };
			made.push(p);
			sets = ensureProfileSet(sets, p, `P${i}`)!.sets;
		}
		expect(sets.length).toBe(MAX_PEN_SETS);
		const fresh = { ...mine(), id: "profile-fresh000" };
		expect(ensureProfileSet(sets, fresh, "Fresh")).toBeNull();
		const dropped = dropProfileSet(made[0]!, made.slice(1), sets, {}, {});
		expect(ensureProfileSet(dropped.sets, fresh, "Fresh")).not.toBeNull();
	});
});

describe("the switch tells the truth (review fix)", () => {
	it("says the pens did not change when the list of pen sets is full", () => {
		let sets: PenSet[] = [];
		for (let i = 0; i < MAX_PEN_SETS; i++) sets.push({ id: `s${i}`, name: `S${i}`, pens: [{ tool: "pen", color: "#000000", width: 1 }] });
		const p = BUILTIN_PROFILES[0]!;
		const full = ensureProfileSet(sets, p, "Lecture");
		expect(full).toBeNull();
		expect(switchNoticeKey(full)).toBe("profiles.switchedNoPens");
		sets = sets.slice(1);
		const room = ensureProfileSet(sets, p, "Lecture");
		expect(switchNoticeKey(room)).toBe("profiles.switched");
		expect(profilePens(p, room!.sets)).toEqual(p.pens);
	});

	it("has both texts for the new notices", () => {
		for (const key of ["profiles.switchedNoPens", "profiles.deletedSetKept"] as const) {
			expect(en[key], key).toContain("{name}");
			expect(itMessages[key], key).toContain("{name}");
		}
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
		const id = custom[0]!.id;
		expect(normaliseActive("study", custom)).toBe("study");
		expect(normaliseActive(id, custom)).toBe(id);
		expect(normaliseActive("profile-9", custom)).toBe("");
		expect(normaliseActive(7, custom)).toBe("");
	});

	it("goes through the plugin settings reader and back", () => {
		const custom = addProfile([], "A", state())!.profiles;
		const id = custom[0]!.id;
		const s = readSettings({ writingProfiles: custom, writingProfileActive: id, writingProfileOnLecture: true });
		expect(s.writingProfiles).toEqual(custom);
		expect(s.writingProfileActive).toBe(id);
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
		const id = custom[0]!.id;
		expect(nextProfileId(custom, "")).toBe("lecture");
		expect(nextProfileId(custom, "lecture")).toBe("study");
		expect(nextProfileId(custom, "study")).toBe(id);
		expect(nextProfileId(custom, id)).toBe("lecture");
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
