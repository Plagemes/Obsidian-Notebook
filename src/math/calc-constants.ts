/**
 * Named constants of the advanced calculator (#182): physical constants (CODATA 2018 values; the SI 2019 definitions are
 * exact) by name, with their unit. The reference sheets of #181 read from the same table when they arrive, so a
 * constant dragged from a sheet and a constant typed here are one value. Pure data.
 */

export interface PhysConstant {
	/** Names it answers to (the first one is the symbol shown on the key). */
	names: readonly string[];
	/** Value in the unit below. */
	value: number;
	/** A unit expression (calc-units), "" for a pure number. */
	unit: string;
	/** i18n key of the full name. */
	label: `calc.const.${string}`;
}

export const CONSTANTS: readonly PhysConstant[] = [
	{ names: ["c", "c0"], value: 299792458, unit: "m/s", label: "calc.const.c" },
	{ names: ["g", "gn"], value: 9.80665, unit: "m/s^2", label: "calc.const.g" },
	{ names: ["h"], value: 6.62607015e-34, unit: "J*s", label: "calc.const.h" },
	{ names: ["hbar", "ħ"], value: 1.054571817e-34, unit: "J*s", label: "calc.const.hbar" },
	{ names: ["G"], value: 6.6743e-11, unit: "m^3/(kg*s^2)", label: "calc.const.G" },
	{ names: ["NA"], value: 6.02214076e23, unit: "1/mol", label: "calc.const.NA" },
	{ names: ["kB", "k_B"], value: 1.380649e-23, unit: "J/K", label: "calc.const.kB" },
	{ names: ["R"], value: 8.314462618, unit: "J/(mol*K)", label: "calc.const.R" },
	{ names: ["qe", "e0"], value: 1.602176634e-19, unit: "C", label: "calc.const.qe" },
	{ names: ["me"], value: 9.1093837015e-31, unit: "kg", label: "calc.const.me" },
	{ names: ["mp"], value: 1.67262192369e-27, unit: "kg", label: "calc.const.mp" },
	{ names: ["mn"], value: 1.67492749804e-27, unit: "kg", label: "calc.const.mn" },
	{ names: ["eps0", "ε0"], value: 8.8541878128e-12, unit: "F/m", label: "calc.const.eps0" },
	{ names: ["mu0", "μ0"], value: 1.25663706212e-6, unit: "N/A^2", label: "calc.const.mu0" },
	{ names: ["sigma_sb", "σsb"], value: 5.670374419e-8, unit: "W/(m^2*K^4)", label: "calc.const.sigma" },
	{ names: ["Fa", "faraday"], value: 96485.33212, unit: "C/mol", label: "calc.const.F" },
	{ names: ["a0"], value: 5.29177210903e-11, unit: "m", label: "calc.const.a0" },
	{ names: ["alpha_fs", "αfs"], value: 7.2973525693e-3, unit: "", label: "calc.const.alpha" },
];

const BY_NAME = new Map<string, PhysConstant>();
for (const c of CONSTANTS) for (const n of c.names) BY_NAME.set(n, c);

export const lookupConstant = (name: string): PhysConstant | undefined => BY_NAME.get(name);

/** The names of all constants (for the editor's hints and the tests). */
export const constantNames = (): string[] => [...BY_NAME.keys()];
