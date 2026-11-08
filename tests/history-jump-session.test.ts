/**
 * A long jump in the history panel is a change of the document like an Undo (review fix): every slice marks the session changed, the session is
 * busy while the jump lasts, a file change meanwhile is kept against and backed up, a close saves the steps already taken, a jump that is
 * stopped or replaced touches nothing else, and the edit lock is always released.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddStroke, History } from "../src/model/history";
import { continueLongJump, JumpRunner, type LongJumpHost } from "../src/model/history-jump";
import { checkContent, parse, serialize } from "../src/model/serialize";
import { DocumentSession, type BackupReason, type DocumentIO, type Timers } from "../src/storage/session";
import { line, sampleDocument } from "./helpers";
import { nodeClearTimeout, nodeSetTimeout } from "./node-env";

const timers: Timers = { set: (fn, ms) => nodeSetTimeout(fn, ms), clear: (h) => nodeClearTimeout(h) };

class FakeIO implements DocumentIO {
	writes: string[] = [];
	backups: Array<{ content: string; reason: BackupReason }> = [];
	constructor(public content: string) {}
	async read(): Promise<string> {
		return this.content;
	}
	async process(fn: (current: string) => string): Promise<void> {
		const next = fn(this.content);
		if (next !== this.content) {
			this.content = next;
			this.writes.push(next);
		}
	}
	async backup(content: string, reason: BackupReason): Promise<string | null> {
		if (this.backups.some((b) => b.content === content)) return null;
		this.backups.push({ content, reason });
		return `backup-${this.backups.length}.bak`;
	}
}

const STEPS = 30;

/** A saved notebook with STEPS strokes written through the history, so the jump to the start undoes them one by one. */
async function setup(guard: ((d: ReturnType<typeof sampleDocument>) => string | null) | null = checkContent) {
	const io = new FakeIO(serialize(sampleDocument(1)));
	let jumping = false;
	const session = new DocumentSession(io, timers, {}, { busy: () => jumping });
	await session.load();
	const doc = session.doc!;
	const page = doc.pages[0]!;
	const history = new History(() => doc, 500, guard);
	for (let i = 0; i < STEPS; i++) history.execute(new AddStroke(page.id, line(0, i, 50, i), page.strokes.length));
	session.markChanged();
	await session.flush();
	io.writes.length = 0;
	const runner = new JumpRunner(history, { kind: "start" });
	const base = (clock: { t: number }) => ({ budgetMs: 3, now: () => clock.t++ });
	return { io, session, doc, page, history, runner, base, setJumping: (v: boolean) => void (jumping = v) };
}

describe("a long jump and the session", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("marks the session changed after every slice, so a file change meanwhile is kept against and backed up", async () => {
		const t = await setup();
		const clock = { t: 0 };
		t.runner.advance(3, () => clock.t++); // the first slice, as the view takes it
		t.setJumping(true);
		const external = serialize(sampleDocument(4));
		let externalAnswer = "";
		let slices = 0;
		const changed = vi.spyOn(t.session, "markChanged");
		const host: LongJumpHost = {
			...t.base(clock),
			yieldToUi: async () => {
				if (++slices === 2) {
					t.io.content = external; // Sync from another device, mid-jump
					externalAnswer = await t.session.handleExternalChange();
				}
			},
			alive: () => true,
			changed: () => t.session.markChanged(),
			release: () => {
				t.setJumping(false);
				t.session.gestureEnded();
			},
		};
		const result = await continueLongJump(t.runner, host);
		expect(result.done).toBe(STEPS);
		expect(externalAnswer).toBe("kept-local");
		expect(changed.mock.calls.length).toBeGreaterThanOrEqual(slices);
		expect(t.page.strokes).toHaveLength(1); // the stroke the notebook began with
		await t.session.flush();
		// The other version is backed up, and what is on disk is the jumped state, not a reload over it.
		expect(t.io.backups).toEqual([{ content: external, reason: "conflict" }]);
		const saved = parse(t.io.content);
		expect(saved.ok && saved.doc.pages[0]!.strokes.length).toBe(1);
	});

	it("saves the steps already taken when the view closes mid-jump, and says it was stopped, not refused", async () => {
		const t = await setup();
		const clock = { t: 0 };
		t.runner.advance(3, () => clock.t++);
		t.setJumping(true);
		let open = true;
		let slices = 0;
		let released: boolean | null = null;
		const host: LongJumpHost = {
			...t.base(clock),
			yieldToUi: async () => {
				if (++slices === 3) open = false; // onClose: the jump is dropped
			},
			alive: () => open,
			changed: () => t.session.markChanged(),
			release: (alive) => void (released = alive),
		};
		const result = await continueLongJump(t.runner, host);
		expect(result.stopped).toBe(true);
		expect(result.done).toBeGreaterThan(0);
		expect(result.done).toBeLessThan(STEPS);
		expect(released).toBe(false);
		expect(t.session.dirty).toBe(true);
		await t.session.flushForClose();
		const saved = parse(t.io.content);
		expect(saved.ok && saved.doc.pages[0]!.strokes.length).toBe(1 + STEPS - result.done);
	});

	it("a jump whose notebook was replaced touches nothing of the new one", async () => {
		const t = await setup();
		const clock = { t: 0 };
		t.runner.advance(3, () => clock.t++);
		const other = await setup();
		const otherChanged = vi.spyOn(other.session, "markChanged");
		let current: DocumentSession = t.session;
		let slices = 0;
		const host: LongJumpHost = {
			...t.base(clock),
			yieldToUi: async () => {
				if (++slices === 2) current = other.session; // the view now shows another notebook
			},
			alive: () => current === t.session,
			changed: () => current.markChanged(),
			release: () => undefined,
		};
		const result = await continueLongJump(t.runner, host);
		expect(result.stopped).toBe(true);
		expect(otherChanged).not.toHaveBeenCalled();
		expect(other.session.dirty).toBe(false);
	});

	it("releases the lock and saves what was taken when a slice throws", async () => {
		let explode = false;
		const t = await setup((d) => {
			if (explode) throw new Error("guard broke");
			return checkContent(d);
		});
		const clock = { t: 0 };
		t.runner.advance(3, () => clock.t++);
		let slices = 0;
		let locked = true;
		let marked = 0;
		const host: LongJumpHost = {
			...t.base(clock),
			yieldToUi: async () => void (++slices === 2 && (explode = true)),
			alive: () => true,
			changed: () => void marked++,
			release: () => void (locked = false),
		};
		await expect(continueLongJump(t.runner, host)).rejects.toThrow("guard broke");
		expect(locked).toBe(false);
		expect(marked).toBeGreaterThan(0);
	});
});
