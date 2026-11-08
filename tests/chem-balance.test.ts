import { describe, expect, it } from "vitest";
import { balanceLatex, balanceReaction, balanceText, hasLatexReaction, hasReaction, parseReaction } from "../src/math/chem-balance";

const ok = (s: string): string => {
	const r = balanceReaction(s);
	if (!r.ok) throw new Error(`${s}: ${r.error.code} ${r.error.message}`);
	return r.text;
};
const code = (s: string): string => {
	const r = balanceReaction(s);
	return r.ok ? "ok" : r.error.code;
};

describe("parsing", () => {
	it("reads formulas, groups and brackets", () => {
		const r = parseReaction("Ca(OH)2 + [Fe(CN)6]^4- -> X");
		expect(r.ok).toBe(false); // X is not an element
		const p = parseReaction("Ca(OH)2 + K4[Fe(CN)6] -> Ca2[Fe(CN)6] + KOH");
		expect(p.ok).toBe(true);
		if (p.ok) {
			expect(p.reaction.species[0]!.counts).toEqual({ Ca: 1, O: 2, H: 2 });
			expect(p.reaction.species[1]!.counts).toEqual({ K: 4, Fe: 1, C: 6, N: 6 });
		}
	});
	it("reads hydrates with a dot or a middle dot", () => {
		for (const f of ["CuSO4·5H2O", "CuSO4.5H2O", "CuSO4 · 5 H2O", "CuSO4*5H2O"]) {
			const p = parseReaction(`${f} -> CuSO4 + H2O`);
			expect(p.ok).toBe(true);
			if (p.ok) expect(p.reaction.species[0]!.counts).toEqual({ Cu: 1, S: 1, O: 9, H: 10 });
		}
	});
	it("reads charges in every spelling", () => {
		const read = (s: string) => {
			const p = parseReaction(`${s} -> A`.replace("A", "H"));
			return p.ok ? p.reaction.species[0]!.charge : null;
		};
		expect(read("Fe^3+")).toBe(3);
		expect(read("Fe^+3")).toBe(3);
		expect(read("Fe^{3+}")).toBe(3);
		expect(read("Fe³⁺")).toBe(3);
		expect(read("SO4^2-")).toBe(-2);
		expect(read("SO₄²⁻")).toBe(-2);
		expect(read("Cl^-")).toBe(-1);
		expect(read("Na^+")).toBe(1);
		expect(read("Na+ ")).toBe(1);
		expect(read("e^-")).toBe(-1);
		expect(read("e-")).toBe(-1);
	});
	it("keeps the spelling of each species and the arrow", () => {
		const r = balanceReaction("H₂ + O₂ → H₂O");
		expect(r.ok && r.text).toBe("2 H₂ + O₂ → 2 H₂O");
		expect(ok("H2 + O2 = H2O")).toBe("2 H2 + O2 = 2 H2O");
		expect(ok("H2 + O2 ⇌ H2O")).toBe("2 H2 + O2 ⇌ 2 H2O");
		expect(ok("H2 + O2 => H2O")).toBe("2 H2 + O2 => 2 H2O");
	});
	it("replaces coefficients that were typed", () => {
		expect(ok("3 H2 + 7 O2 -> 1 H2O")).toBe("2 H2 + O2 -> 2 H2O");
		expect(ok("2H2 + O2 -> 2H2O")).toBe("2 H2 + O2 -> 2 H2O");
	});
	it("splits on + without spaces", () => {
		expect(ok("H2+O2->H2O")).toBe("2 H2 + O2 -> 2 H2O");
	});
	it("rejects what it cannot read", () => {
		expect(code("")).toBe("empty");
		expect(code("H2 + O2")).toBe("no-arrow");
		expect(code("A -> B -> C")).toBe("many-arrows");
		expect(code("H2 + -> H2O")).toBe("empty-side");
		expect(code("H2 + Xx -> H2O")).toBe("unknown-element");
		expect(code("h2 + o2 -> h2o")).toBe("bad-formula");
		expect(code("Ca(OH + O -> CaO")).toBe("bad-formula");
		expect(code("H2) -> H2")).toBe("bad-formula");
		expect(code("H2 + O2 -> H0")).toBe("too-large");
		expect(code("Fe^ + O2 -> Fe2O3")).toBe("bad-charge");
	});
	it("limits the length", () => {
		expect(code("H".repeat(2500) + " -> H")).toBe("too-large");
	});
});

describe("balancing", () => {
	it("balances combustion", () => {
		expect(ok("CH4 + O2 -> CO2 + H2O")).toBe("CH4 + 2 O2 -> CO2 + 2 H2O");
		expect(ok("C2H6 + O2 -> CO2 + H2O")).toBe("2 C2H6 + 7 O2 -> 4 CO2 + 6 H2O");
		expect(ok("C3H8 + O2 -> CO2 + H2O")).toBe("C3H8 + 5 O2 -> 3 CO2 + 4 H2O");
		expect(ok("C8H18 + O2 -> CO2 + H2O")).toBe("2 C8H18 + 25 O2 -> 16 CO2 + 18 H2O");
		expect(ok("C6H12O6 + O2 -> CO2 + H2O")).toBe("C6H12O6 + 6 O2 -> 6 CO2 + 6 H2O");
	});
	it("balances synthesis, decomposition and displacement", () => {
		expect(ok("N2 + H2 -> NH3")).toBe("N2 + 3 H2 -> 2 NH3");
		expect(ok("KClO3 -> KCl + O2")).toBe("2 KClO3 -> 2 KCl + 3 O2");
		expect(ok("Al + O2 -> Al2O3")).toBe("4 Al + 3 O2 -> 2 Al2O3");
		expect(ok("Fe + CuSO4 -> FeSO4 + Cu")).toBe("Fe + CuSO4 -> FeSO4 + Cu");
		expect(ok("Fe2O3 + CO -> Fe + CO2")).toBe("Fe2O3 + 3 CO -> 2 Fe + 3 CO2");
		expect(ok("Na + H2O -> NaOH + H2")).toBe("2 Na + 2 H2O -> 2 NaOH + H2");
	});
	it("balances with groups", () => {
		expect(ok("Ca(OH)2 + H3PO4 -> Ca3(PO4)2 + H2O")).toBe("3 Ca(OH)2 + 2 H3PO4 -> Ca3(PO4)2 + 6 H2O");
		expect(ok("Al2(SO4)3 + Ca(OH)2 -> Al(OH)3 + CaSO4")).toBe("Al2(SO4)3 + 3 Ca(OH)2 -> 2 Al(OH)3 + 3 CaSO4");
		expect(ok("K4[Fe(CN)6] + KMnO4 + H2SO4 -> KHSO4 + Fe2(SO4)3 + MnSO4 + HNO3 + CO2 + H2O")).toBe(
			"10 K4[Fe(CN)6] + 122 KMnO4 + 299 H2SO4 -> 162 KHSO4 + 5 Fe2(SO4)3 + 122 MnSO4 + 60 HNO3 + 60 CO2 + 188 H2O",
		);
	});
	it("balances hydrates", () => {
		expect(ok("CuSO4·5H2O -> CuSO4 + H2O")).toBe("CuSO4·5H2O -> CuSO4 + 5 H2O");
		expect(ok("Na2CO3.10H2O -> Na2CO3 + H2O")).toBe("Na2CO3.10H2O -> Na2CO3 + 10 H2O");
		expect(ok("CuSO4 + H2O -> CuSO4·5H2O")).toBe("CuSO4 + 5 H2O -> CuSO4·5H2O");
		expect(ok("MgSO4·7H2O + BaCl2 -> BaSO4 + MgCl2 + H2O")).toBe("MgSO4·7H2O + BaCl2 -> BaSO4 + MgCl2 + 7 H2O");
	});
	it("balances charges: ionic and redox", () => {
		expect(ok("Fe^3+ + e^- -> Fe^2+")).toBe("Fe^3+ + e^- -> Fe^2+");
		expect(ok("Fe^3+ + Sn^2+ -> Fe^2+ + Sn^4+")).toBe("2 Fe^3+ + Sn^2+ -> 2 Fe^2+ + Sn^4+");
		expect(ok("MnO4^- + Fe^2+ + H^+ -> Mn^2+ + Fe^3+ + H2O")).toBe("MnO4^- + 5 Fe^2+ + 8 H^+ -> Mn^2+ + 5 Fe^3+ + 4 H2O");
		expect(ok("Cr2O7^2- + Fe^2+ + H+ -> Cr^3+ + Fe^3+ + H2O")).toBe("Cr2O7^2- + 6 Fe^2+ + 14 H+ -> 2 Cr^3+ + 6 Fe^3+ + 7 H2O");
		expect(ok("Cu + NO3^- + H^+ -> Cu^2+ + NO + H2O")).toBe("3 Cu + 2 NO3^- + 8 H^+ -> 3 Cu^2+ + 2 NO + 4 H2O");
		expect(ok("Ag^+ + Cl^- -> AgCl")).toBe("Ag^+ + Cl^- -> AgCl");
		expect(ok("Ba^2+ + SO4^2- -> BaSO4")).toBe("Ba^2+ + SO4^2- -> BaSO4");
		expect(ok("Al^3+ + OH^- -> Al(OH)3")).toBe("Al^3+ + 3 OH^- -> Al(OH)3");
	});
	it("handles charges written as superscripts and bare signs", () => {
		expect(ok("MnO₄⁻ + Fe²⁺ + H⁺ → Mn²⁺ + Fe³⁺ + H₂O")).toBe("MnO₄⁻ + 5 Fe²⁺ + 8 H⁺ → Mn²⁺ + 5 Fe³⁺ + 4 H₂O");
		expect(ok("Na+ + Cl- -> NaCl")).toBe("Na+ + Cl- -> NaCl");
		expect(ok("Zn + Cu^2+ -> Zn^2+ + Cu")).toBe("Zn + Cu^2+ -> Zn^2+ + Cu");
	});
	it("uses the electron to balance charge", () => {
		expect(ok("Zn -> Zn^2+ + e^-")).toBe("Zn -> Zn^2+ + 2 e^-");
		expect(ok("Cl2 + e^- -> Cl^-")).toBe("Cl2 + 2 e^- -> 2 Cl^-");
		expect(ok("MnO4^- + H^+ + e^- -> Mn^2+ + H2O")).toBe("MnO4^- + 8 H^+ + 5 e^- -> Mn^2+ + 4 H2O");
	});
	it("reports a reaction that is already balanced", () => {
		const r = balanceReaction("2 H2 + O2 -> 2 H2O");
		expect(r.ok && r.changed).toBe(false);
		const s = balanceReaction("H2 + O2 -> H2O");
		expect(s.ok && s.changed).toBe(true);
		if (s.ok) expect(s.coefficients).toEqual([2, 1, 2]);
	});
	it("treats reactants and products the same in either order", () => {
		expect(ok("H2O -> H2 + O2")).toBe("2 H2O -> 2 H2 + O2");
	});
	it("reduces to the smallest whole numbers", () => {
		const r = balanceReaction("C4H10 + O2 -> CO2 + H2O");
		expect(r.ok && r.coefficients).toEqual([2, 13, 8, 10]);
	});
});

describe("impossible and ambiguous reactions", () => {
	it("names an element that is on one side only", () => {
		const r = balanceReaction("H2 + O2 -> H2O2 + N2");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.code).toBe("one-sided");
			expect(r.error.detail).toEqual(["N"]);
		}
		expect(code("NaCl -> Na")).toBe("one-sided");
	});
	it("reports the same elements that cannot be balanced", () => {
		expect(code("H2O -> H2O2")).toBe("unbalanceable");
		expect(code("CO2 -> CO")).toBe("unbalanceable");
		expect(code("Fe^3+ -> Fe^2+")).toBe("unbalanceable");
	});
	it("reports a charge that cannot be balanced", () => {
		expect(code("Na -> Na^+")).toBe("unbalanceable");
		expect(code("Ag^+ + Cl -> AgCl^-2")).toBe("unbalanceable");
	});
	it("reports ambiguous reactions with their number of independent answers", () => {
		const r = balanceReaction("H2 + O2 + H2O2 -> H2O");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.code).toBe("ambiguous");
			expect(r.error.detail.length).toBe(2);
		}
		expect(code("C + O2 -> CO + CO2")).toBe("ambiguous");
		expect(code("H2O -> H2 + O2 + H2O2")).toBe("ambiguous");
	});
	it("reports a species that cannot take part", () => {
		const r = balanceReaction("H2 + O2 + N2 + NH3 -> H2O + NH3 + N2");
		expect(r.ok).toBe(false);
		const s = balanceReaction("H2 + O2 + H2O -> H2O");
		expect(s.ok).toBe(false);
		if (!s.ok) expect(["unused-species", "ambiguous", "unbalanceable"]).toContain(s.error.code);
	});
	it("does not balance with a negative coefficient", () => {
		// With these species the only solution has the water on the wrong side.
		const r = balanceReaction("Fe2O3 + O2 -> Fe3O4");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe("unbalanceable");
	});
	it("handles one species twice", () => {
		expect(code("H2 + H2 + O2 -> H2O")).toBe("ambiguous");
	});
});

describe("text boxes", () => {
	it("balances a line with a label, a list marker and a final dot", () => {
		const r = balanceText("Combustion: CH4 + O2 -> CO2 + H2O.");
		expect(r.text).toBe("Combustion: CH4 + 2 O2 -> CO2 + 2 H2O.");
		expect(r.changed).toBe(1);
		expect(balanceText("1. N2 + H2 -> NH3").text).toBe("1. N2 + 3 H2 -> 2 NH3");
		expect(balanceText("- N2 + H2 -> NH3").text).toBe("- N2 + 3 H2 -> 2 NH3");
	});
	it("balances every reaction line and leaves other lines alone", () => {
		const r = balanceText("Synthesis\nN2 + H2 -> NH3\nsome notes here\nAl + O2 -> Al2O3\n");
		expect(r.text).toBe("Synthesis\nN2 + 3 H2 -> 2 NH3\nsome notes here\n4 Al + 3 O2 -> 2 Al2O3\n");
		expect(r.changed).toBe(2);
		expect(r.failed).toBe(0);
	});
	it("keeps going when one line fails, and says which", () => {
		const r = balanceText("H2 + O2 -> H2O\nNaCl -> Na\nCH4 + O2 -> CO2 + H2O");
		expect(r.changed).toBe(2);
		expect(r.failed).toBe(1);
		expect(r.lines.find((l) => l.error)?.line).toBe(1);
		expect(r.text.split("\n")[1]).toBe("NaCl -> Na");
	});
	it("counts lines that are balanced already and keeps carriage returns", () => {
		const r = balanceText("2 H2 + O2 -> 2 H2O\r\nN2 + H2 -> NH3\r\n");
		expect(r.same).toBe(1);
		expect(r.text).toBe("2 H2 + O2 -> 2 H2O\r\nN2 + 3 H2 -> 2 NH3\r\n");
	});
	it("ignores sentences that are not reactions", () => {
		const r = balanceText("x = 2 and y = 3\nThe answer is 5 -> done");
		expect(r.lines.length).toBe(0);
		expect(r.text).toBe("x = 2 and y = 3\nThe answer is 5 -> done");
		expect(hasReaction("x = 2")).toBe(false);
		expect(hasReaction("a -> b")).toBe(false);
		expect(hasReaction("just words")).toBe(false);
	});
	it("tells a reaction from other text", () => {
		expect(hasReaction("H2 + O2 -> H2O")).toBe(true);
		expect(hasReaction("note\nH2 + O2 → H2O")).toBe(true);
		expect(hasReaction("H2 + O2 = H2O")).toBe(true);
	});
});

describe("LaTeX and mhchem", () => {
	it("balances \\ce sources", () => {
		const r = balanceLatex("\\ce{H2 + O2 -> H2O}");
		expect(r.latex).toBe("\\ce{2 H2 + O2 -> 2 H2O}");
		expect(r.balance.changed).toBe(1);
	});
	it("balances plain LaTeX with subscripts and arrows", () => {
		const r = balanceLatex("CH_4 + O_2 \\rightarrow CO_2 + H_2O");
		expect(r.latex).toBe("\\ce{CH4 + 2 O2 → CO2 + 2 H2O}");
		const s = balanceLatex("MnO_4^{-} + Fe^{2+} + H^{+} \\to Mn^{2+} + Fe^{3+} + H_2O");
		expect(s.balance.failed).toBe(0);
		expect(s.latex).toContain("5 Fe^2+");
	});
	it("balances several lines", () => {
		const r = balanceLatex("\\ce{N2 + H2 -> NH3} \\\\ \\ce{Al + O2 -> Al2O3}");
		expect(r.latex).toBe("\\ce{N2 + 3 H2 -> 2 NH3} \\\\ \\ce{4 Al + 3 O2 -> 2 Al2O3}");
	});
	it("tells chemistry from other maths", () => {
		expect(hasLatexReaction("\\ce{H2 + O2 -> H2O}")).toBe(true);
		expect(hasLatexReaction("x^2 + y^2 = r^2")).toBe(false);
		expect(hasLatexReaction("\\frac{a}{b}")).toBe(false);
	});
});

describe("review V1: only the reaction lines of an equation are rewritten", () => {
	it("keeps other maths byte for byte next to a balanced reaction", () => {
		const src = "\\ce{H2 + O2 -> H2O} \\\\ T_{max} = 300\\,\\text{K}";
		const r = balanceLatex(src);
		expect(r.latex).toBe("\\ce{2 H2 + O2 -> 2 H2O} \\\\ T_{max} = 300\\,\\text{K}");
		expect(r.balance.changed).toBe(1);
		expect(r.balance.text).toBe(r.latex);
		expect(r.balance.lines).toHaveLength(1);
	});
	it("keeps the maths in front, in between and after, and line ends", () => {
		const src = "E = mc^2 \\\\\n  N_2 + H_2 \\to NH_3 \\\\ \\frac{a}{b}\\quad x\r\n\\ce{Al + O2 -> Al2O3}";
		const r = balanceLatex(src);
		expect(r.latex).toBe("E = mc^2 \\\\\n  \\ce{N2 + 3 H2 → 2 NH3} \\\\ \\frac{a}{b}\\quad x\r\n\\ce{4 Al + 3 O2 -> 2 Al2O3}");
		expect(r.balance.changed).toBe(2);
	});
	it("leaves a reaction that is balanced already, or cannot be balanced, exactly as written", () => {
		const src = "\\ce{2H2 + O2 -> 2H2O} \\\\ \\ce{H2 + Xx3 -> H2O} \\\\ \\ce{CH4 + O2 -> CO2 + H2O}";
		const r = balanceLatex(src);
		expect(r.latex).toBe("\\ce{2H2 + O2 -> 2H2O} \\\\ \\ce{H2 + Xx3 -> H2O} \\\\ \\ce{CH4 + 2 O2 -> CO2 + 2 H2O}");
		expect(r.balance.same).toBe(1);
		expect(r.balance.failed).toBe(1);
		expect(r.balance.changed).toBe(1);
	});
	it("returns the very same source when nothing changes", () => {
		for (const src of ["\\ce{2H2 + O2 -> 2H2O}", "x^2 + y^2 = r^2", "T_{max} = 300\\,\\text{K} \\\\ \\frac{a}{b}", ""]) {
			const r = balanceLatex(src);
			expect(r.latex).toBe(src);
			expect(r.balance.changed).toBe(0);
		}
	});
	it("does not rewrite a part that has words before the reaction", () => {
		const src = "\\text{Step 1: } H_2 + O_2 \\to H_2O \\\\ H_2 + O_2 \\to H_2O";
		const r = balanceLatex(src);
		expect(r.latex.endsWith("\\\\ \\ce{2 H2 + O2 → 2 H2O}")).toBe(true);
		expect(r.latex.startsWith("\\text{Step 1: } H_2 + O_2 \\to H_2O \\\\")).toBe(true);
		expect(r.balance.changed).toBe(1);
	});
});

describe("review R4: a row of an aligned environment keeps its alignment point", () => {
	it("keeps the & before the arrow and the environment around it", () => {
		const src = "\\begin{aligned}\n N_2 + H_2 &\\to NH_3 \\\\\n Al + O_2 &\\ce{-> Al2O3}\n\\end{aligned}";
		const r = balanceLatex(src);
		expect(r.latex).toBe("\\begin{aligned}\n \\ce{N2 + 3 H2} &\\ce{→ 2 NH3} \\\\\n \\ce{4 Al + 3 O2} &\\ce{-> 2 Al2O3}\n\\end{aligned}");
		expect(r.balance.changed).toBe(2);
		expect(balanceLatex(r.latex).latex).toBe(r.latex);
	});
	it("leaves a row whose & is not right before the arrow, or that has several, exactly as written", () => {
		for (const src of ["& N_2 + H_2 \\to NH_3", "N_2 & + H_2 \\to NH_3", "N_2 + H_2 & \\to & NH_3"]) {
			const r = balanceLatex(src);
			expect(r.latex).toBe(src);
			expect(r.balance.changed).toBe(0);
		}
	});
	it("an escaped ampersand is not an alignment point", () => {
		const r = balanceLatex("H_2 + O_2 \\to H_2O \\text{ R\\&D}");
		expect(r.balance.changed).toBe(0);
	});
});
