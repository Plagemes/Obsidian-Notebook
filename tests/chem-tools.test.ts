import { beforeEach, describe, expect, it, vi } from "vitest";

const notices: string[] = [];
const modals: Array<{ onApply: () => void; items: unknown[] }> = [];

vi.mock("obsidian", () => ({
	setIcon: () => undefined,
	getLanguage: () => "en",
	Notice: class {
		constructor(message: string) {
			notices.push(message);
		}
		hide(): void {}
		setMessage(): void {}
	},
	Modal: class {
		open(): void {
			modals.push(this as unknown as { onApply: () => void; items: unknown[] });
		}
	},
	Setting: class {},
}));

import { createDocument } from "../src/model/document";
import { lockCommand } from "../src/model/groups";
import { History, type Command } from "../src/model/history";
import { checkContent } from "../src/model/serialize";
import type { EquationElement, NotebookDocument, PageElement, TextElement } from "../src/model/types";
import { ChemTools, holdsReaction, planElement, type ChemHost } from "../src/view/chem-tools";

const text = (id: string, t: string): TextElement => ({ id, type: "text", x: 40, y: 40, width: 300, text: t, fontSize: 16, color: "#000000" });
const equation = (id: string, latex: string, outline?: string): EquationElement => ({ id, type: "equation", x: 40, y: 200, width: 120, height: 30, latex, fontSize: 18, color: "#000000", ...(outline ? { outline } : {}) });

function scene(els: PageElement[]) {
	const doc: NotebookDocument = createDocument(new Date(2026, 10, 8), { width: 595, height: 842 });
	doc.pages[0]!.elements = [...els];
	const history = new History(() => doc, 500, checkContent);
	let selected: PageElement[] = [...els];
	const steps: string[] = [];
	let refuseAll = false;
	const host: ChemHost = {
		app: {} as ChemHost["app"],
		doc: () => doc,
		editable: () => true,
		selection: () => ({ pageIndex: 0, elements: selected }),
		execute: (cmd: Command) => {
			steps.push(cmd.label);
			return refuseAll ? false : history.execute(cmd);
		},
		select: (_p, e) => (selected = e),
		refresh: () => undefined,
	};
	const tools = new ChemTools(host);
	const apply = () => modals[modals.length - 1]!.onApply();
	const refuse = (lock: boolean) => {
		if (lock) doc.pages[0]!.locked = true;
		else refuseAll = true;
	};
	return { doc, history, tools, steps, apply, refuse, page: () => doc.pages[0]! };
}

beforeEach(() => {
	notices.length = 0;
	modals.length = 0;
});

describe("which elements hold a reaction", () => {
	it("recognises text boxes and equations", () => {
		expect(holdsReaction(text("a", "H2 + O2 -> H2O"))).toBe(true);
		expect(holdsReaction(text("b", "just a note"))).toBe(false);
		expect(holdsReaction(equation("c", "\\ce{H2 + O2 -> H2O}"))).toBe(true);
		expect(holdsReaction(equation("d", "x^2 + y^2 = r^2"))).toBe(false);
		expect(holdsReaction({ id: "e", type: "box", kind: "definition", x: 0, y: 0, width: 10, height: 10 })).toBe(false);
	});
	it("plans the new text without changing the element", () => {
		const el = text("a", "H2 + O2 -> H2O");
		const plan = planElement(el);
		expect(plan.next?.type === "text" && plan.next.text).toBe("2 H2 + O2 -> 2 H2O");
		expect(el.text).toBe("H2 + O2 -> H2O");
		expect(planElement(text("b", "2 H2 + O2 -> 2 H2O")).next).toBeNull();
	});
	it("drops the cached outline of an equation", () => {
		const plan = planElement(equation("c", "\\ce{H2 + O2 -> H2O}", "M0 0L1 1Z"));
		expect(plan.next?.type === "equation" && plan.next.latex).toBe("\\ce{2 H2 + O2 -> 2 H2O}");
		expect(plan.next && "outline" in plan.next).toBe(false);
	});
});

describe("Balance reaction", () => {
	it("previews first and changes nothing until Balance", () => {
		const s = scene([text("a", "CH4 + O2 -> CO2 + H2O")]);
		s.tools.balanceSelected();
		expect(modals.length).toBe(1);
		expect(s.steps.length).toBe(0);
		expect((s.page().elements![0] as TextElement).text).toBe("CH4 + O2 -> CO2 + H2O");
	});
	it("replaces the text in one undo step, and undo and redo restore it", () => {
		const s = scene([text("a", "CH4 + O2 -> CO2 + H2O"), text("b", "N2 + H2 -> NH3"), equation("c", "\\ce{Al + O2 -> Al2O3}")]);
		s.tools.balanceSelected();
		s.apply();
		expect(s.steps.length).toBe(1);
		const els = s.page().elements!;
		expect((els[0] as TextElement).text).toBe("CH4 + 2 O2 -> CO2 + 2 H2O");
		expect((els[1] as TextElement).text).toBe("N2 + 3 H2 -> 2 NH3");
		expect((els[2] as EquationElement).latex).toBe("\\ce{4 Al + 3 O2 -> 2 Al2O3}");
		s.history.undo();
		const back = s.page().elements!;
		expect((back[0] as TextElement).text).toBe("CH4 + O2 -> CO2 + H2O");
		expect((back[1] as TextElement).text).toBe("N2 + H2 -> NH3");
		expect((back[2] as EquationElement).latex).toBe("\\ce{Al + O2 -> Al2O3}");
		s.history.redo();
		expect((s.page().elements![0] as TextElement).text).toBe("CH4 + 2 O2 -> CO2 + 2 H2O");
	});
	it("says so when the selection holds no reaction", () => {
		const s = scene([text("a", "hello")]);
		s.tools.balanceSelected();
		expect(modals.length).toBe(0);
		expect(notices).toEqual(["No chemical reaction found in the selection."]);
	});
	it("never touches a locked element", () => {
		const s = scene([text("a", "CH4 + O2 -> CO2 + H2O")]);
		const lock = lockCommand(s.page(), s.page().elements!);
		s.history.execute(lock!);
		const locked = s.page().elements![0]!;
		const sel = s.tools;
		// The selection holds the locked element as it is on the page now.
		const host = scene([locked]);
		host.tools.balanceSelected();
		expect(host.steps.length).toBe(0);
		expect(modals.length).toBe(0);
		expect(notices).toEqual(["These elements are locked. Unlock them first."]);
		expect(sel).toBeDefined();
	});
	it("leaves the locked ones out when only some are locked", () => {
		const s = scene([text("a", "CH4 + O2 -> CO2 + H2O"), text("b", "N2 + H2 -> NH3")]);
		s.history.execute(lockCommand(s.page(), [s.page().elements![1]!])!);
		const free = s.page().elements![0]!;
		const locked = s.page().elements![1]!;
		const sel = [free, locked];
		const doc = s.doc;
		const host: ChemHost = {
			app: {} as ChemHost["app"], doc: () => doc, editable: () => true, selection: () => ({ pageIndex: 0, elements: sel }),
			execute: (c) => s.history.execute(c), select: () => undefined, refresh: () => undefined,
		};
		new ChemTools(host).balanceSelected();
		modals[modals.length - 1]!.onApply();
		expect((s.page().elements![0] as TextElement).text).toBe("CH4 + 2 O2 -> CO2 + 2 H2O");
		expect((s.page().elements![1] as TextElement).text).toBe("N2 + H2 -> NH3");
	});
	it("refuses a locked page", () => {
		const s = scene([text("a", "CH4 + O2 -> CO2 + H2O")]);
		s.page().locked = true;
		s.tools.balanceSelected();
		expect(modals.length).toBe(0);
		expect(notices[0]).toBe("Page 1 is locked. Unlock it first.");
		expect((s.page().elements![0] as TextElement).text).toBe("CH4 + O2 -> CO2 + H2O");
	});
	it("does not apply when the page is locked while the preview is open", () => {
		const s = scene([text("a", "CH4 + O2 -> CO2 + H2O")]);
		s.tools.balanceSelected();
		s.page().locked = true;
		s.apply();
		expect(s.steps.length).toBe(0);
		expect((s.page().elements![0] as TextElement).text).toBe("CH4 + O2 -> CO2 + H2O");
	});
	it("does not apply to an element that changed while the preview was open", () => {
		const s = scene([text("a", "CH4 + O2 -> CO2 + H2O")]);
		s.tools.balanceSelected();
		s.page().elements = [text("a", "CH4 + O2 -> CO2 + H2O")];
		s.apply();
		expect(s.steps.length).toBe(0);
	});
});

describe("review V1: an equation with other maths keeps it, and the preview shows the whole result", () => {
	it("plans the whole new source and keeps the unrelated part", () => {
		const eq = equation("e", "\\ce{H2 + O2 -> H2O} \\\\ T_{max} = 300\\,\\text{K}", "<svg/>");
		const item = planElement(eq);
		expect(item.result).toBe("\\ce{2 H2 + O2 -> 2 H2O} \\\\ T_{max} = 300\\,\\text{K}");
		expect((item.next as EquationElement).latex).toBe(item.result);
		expect(item.lines).toHaveLength(1);
		expect(planElement(text("t", "H2 + O2 -> H2O")).result).toBeNull();
	});
	it("applies the mixed equation unchanged outside the reaction, in one undo step", () => {
		const s = scene([equation("e", "\\ce{H2 + O2 -> H2O} \\\\ T_{max} = 300\\,\\text{K}")]);
		s.tools.balanceSelected();
		s.apply();
		expect((s.page().elements![0] as EquationElement).latex).toBe("\\ce{2 H2 + O2 -> 2 H2O} \\\\ T_{max} = 300\\,\\text{K}");
		s.history.undo();
		expect((s.page().elements![0] as EquationElement).latex).toBe("\\ce{H2 + O2 -> H2O} \\\\ T_{max} = 300\\,\\text{K}");
	});
});

describe("review V8: the notice names the real refusal", () => {
	function refusing(locked: boolean) {
		const s = scene([text("a", "CH4 + O2 -> CO2 + H2O")]);
		s.tools.balanceSelected();
		// The history refuses the step (for any reason) after the preview was confirmed.
		s.refuse(locked);
		notices.length = 0;
		s.apply();
		return s;
	}
	it("says nothing about a lock when the step was refused for another reason (the history's own message stands)", () => {
		const s = refusing(false);
		expect(notices).toEqual([]);
		expect((s.page().elements![0] as TextElement).text).toBe("CH4 + O2 -> CO2 + H2O");
	});
	it("names the lock when the page is locked", () => {
		refusing(true);
		expect(notices).toEqual(["Page 1 is locked. Unlock it first."]);
	});
});
