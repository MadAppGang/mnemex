/** Shared fixtures for the step-3 black-box suite (plan H-11). */
import { fillerFiles, fSmall, letters } from "./harness";

const READERS = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"];

/** F-penalty (plan H-11), arrangement-symmetric: `get` live in a-*, dead in z-*; `fetchItem` the reverse. */
export function penaltyFixture(fillerCount = 160): Record<string, string> {
	const users: Record<string, string> = {};
	for (const r of READERS) {
		users[`src/users/${r.toLowerCase()}.ts`] = [
			'import { get } from "../a-cache";',
			'import { fetchItem } from "../z-store";',
			`export function read${r}Setting(): string {`,
			`  return get("${r.toLowerCase()}") ?? fetchItem("${r}");`,
			"}",
			"",
		].join("\n");
	}
	return {
		...fSmall(),
		"src/a-cache.ts": [
			"const shelfStore: Record<string, string> = {};",
			"export function get(key: string): string | undefined {",
			"  return shelfStore[key];",
			"}",
			"",
		].join("\n"),
		"src/z-cache.ts": [
			"const oldShelf: Record<string, string> = {};",
			"function get(key: string): string | undefined {",
			"  return oldShelf[key];",
			"}",
			"export function oldShelfSize(): number {",
			"  return Object.keys(oldShelf).length;",
			"}",
			"",
		].join("\n"),
		"src/z-store.ts": [
			"const stockItems: Record<string, string> = {};",
			"export function fetchItem(sku: string): string {",
			'  return stockItems[sku] ?? "";',
			"}",
			"",
		].join("\n"),
		"src/a-store.ts": [
			"const retiredItems: Record<string, string> = {};",
			"function fetchItem(sku: string): string {",
			'  return retiredItems[sku] ?? "";',
			"}",
			"export function retiredItemCount(): number {",
			"  return Object.keys(retiredItems).length;",
			"}",
			"",
		].join("\n"),
		...users,
		...fillerFiles("Pz", fillerCount),
	};
}

const TWIN_FNS: Record<string, [string, string][]> = {
	"src/geo.ts": [
		[
			"latitudeClamp",
			"const clampedLatitude = Math.max(-90, Math.min(90, value));\nreturn clampedLatitude;",
		],
		[
			"longitudeWrap",
			"const wrappedLongitude = ((value + 180) % 360) - 180;\nreturn wrappedLongitude;",
		],
		["bearingDelta", "const bearingSwing = value % 360;\nreturn bearingSwing;"],
		[
			"haversineSpan",
			"const haversineArc = Math.sin(value / 2) ** 2;\nreturn haversineArc;",
		],
		[
			"geohashEncode",
			"const geohashCell = Math.floor(value * 32);\nreturn geohashCell;",
		],
		[
			"polygonArea",
			"const polygonSurface = value * value * 0.5;\nreturn polygonSurface;",
		],
		[
			"routeSimplify",
			"const simplifiedRoute = Math.round(value / 10);\nreturn simplifiedRoute;",
		],
	],
	"src/text.ts": [
		["slugifyTitle", "const titleSlug = value * 3;\nreturn titleSlug;"],
		["truncateWords", "const wordCut = value - 1;\nreturn wordCut;"],
		[
			"capitalizeFirst",
			"const capitalLetter = value + 65;\nreturn capitalLetter;",
		],
		["stripAccents", "const accentFree = value & 127;\nreturn accentFree;"],
		[
			"wordFrequency",
			"const frequencyTally = value / 4;\nreturn frequencyTally;",
		],
		["levenshteinGap", "const editGap = Math.abs(value - 3);\nreturn editGap;"],
		["paddedNumeral", "const numeralPad = value + 1000;\nreturn numeralPad;"],
	],
};

/** F-twins: 14 small exported functions (each indexed as a code_chunk AND a code_unit at one span). */
export function twinsFixture(): Record<string, string> {
	const files: Record<string, string> = {};
	for (const [file, fns] of Object.entries(TWIN_FNS)) {
		files[file] = fns
			.map(
				([name, body]) =>
					`export function ${name}(value: number): number {\n${body
						.split("\n")
						.map((l) => `  ${l}`)
						.join("\n")}\n}\n`,
			)
			.join("\n");
	}
	return files;
}

export const TWIN_NAMES = Object.values(TWIN_FNS).flatMap((fns) =>
	fns.map(([n]) => n),
);

/** Rewrites one function body in the F-twins `src/geo.ts`. */
export function twinsGeoEdited(): string {
	return twinsFixture()["src/geo.ts"].replace(
		"const clampedLatitude = Math.max(-90, Math.min(90, value));",
		"const clampedLatitude = Math.max(-89, Math.min(89, value)) + 0;",
	);
}

// ─── F-small edits ───────────────────────────────────────────────────────

export const QUOKKA = [
	"export function quokkaLedgerReconcile(ledger: number): number {",
	"  const quokkaLedger = ledger * 2;",
	"  return quokkaLedger;",
	"}",
	"",
].join("\n");

export const TELEMETRY = [
	"export function wombatTelemetryFlush(batch: number): number {",
	"  const wombatTelemetry = batch + 9;",
	"  return wombatTelemetry;",
	"}",
	"",
].join("\n");

/** F-small billing.ts with the planted quokka function appended. */
export function billingWithQuokka(): string {
	return `${fSmall()["src/billing.ts"]}\n${QUOKKA}`;
}

/** F-small billing.ts with `legacyRefundPath` (lines 1-5) removed. */
export function billingWithoutLegacy(): string {
	return fSmall()["src/billing.ts"].split("\n").slice(5).join("\n");
}

/** As above, and `computeInvoiceTotal`'s body changed, so the file needs at least one new embedding. */
export function billingWithoutLegacyEdited(): string {
	return billingWithoutLegacy().replace(
		"invoiceTotal += item;",
		"invoiceTotal += item * 1;",
	);
}

/** Lexically unrelated dirty files (plan TEST-29). */
export const UNRELATED: Record<string, string> = {
	"src/splash.ts":
		"export function renderSplashBanner(width: number): number {\n  const splashBannerGlyphs = width * 2;\n  return splashBannerGlyphs;\n}\n",
	"src/midi.ts":
		"export function parseMidiTempo(ticks: number): number {\n  const midiTempoBeats = ticks / 96;\n  return midiTempoBeats;\n}\n",
	"src/guitar.ts":
		"export function tuneGuitarString(hertz: number): number {\n  const guitarStringPitch = hertz * 1.5;\n  return guitarStringPitch;\n}\n",
	"src/espresso.ts":
		"export function brewEspressoShot(grams: number): number {\n  const espressoShotYield = grams * 2;\n  return espressoShotYield;\n}\n",
};

// ─── F-labels (iteration 2, F1): symbols big enough to be chunked under a LABEL name ──
// Observed through the built binary (20:36): an 80-field documented interface is
// indexed as `type=module name=<Name> (fields)`; a 160-line function as
// `type=function name=<name> (part k/6)`.

const DOC_FIELDS = 80;
const ROUTINE_LINES = 160;

function docInterface(name: string, stem: string): string {
	const fields: string[] = [];
	for (let i = 0; i < DOC_FIELDS; i++) {
		fields.push(
			`\t/** The ${stem} value number ${letters(i)} for the record. */\n\t${stem}Field${letters(i)}: number;`,
		);
	}
	return `export interface ${name} {\n${fields.join("\n")}\n}\n`;
}

function bigRoutine(name: string, stem: string): string {
	const lines: string[] = [];
	for (let i = 0; i < ROUTINE_LINES; i++)
		lines.push(`\tconst ${stem}Step${letters(i)} = seed * ${i + 2} + ${i};`);
	lines.push(`\treturn ${stem}Step${letters(ROUTINE_LINES - 1)};`);
	return `export function ${name}(seed: number): number {\n${lines.join("\n")}\n}\n`;
}

/**
 * F-labels: a dead and a live exported documented interface (80 fields), and a
 * dead and a live exported function (160 lines). The live ones are used from 5
 * files. Carries the penalty fixture's 1 600 fillers (PageRank of an unused symbol < 0.001).
 */
export function labelsFixture(): Record<string, string> {
	const users: Record<string, string> = {};
	for (const r of ["Ash", "Birch", "Cedar", "Dogwood", "Elm"]) {
		users[`src/consumers/${r.toLowerCase()}.ts`] = [
			'import type { LiveDocShape } from "../live-doc";',
			'import { liveMegaRoutine } from "../live-routine";',
			`export function consume${r}(shape: LiveDocShape): number {`,
			`  return liveMegaRoutine(shape.liveDocField${letters(0)});`,
			"}",
			"",
		].join("\n");
	}
	return {
		...penaltyFixture(),
		"src/dead-doc.ts": docInterface("DeadDocShape", "deadDoc"),
		"src/live-doc.ts": docInterface("LiveDocShape", "liveDoc"),
		"src/dead-routine.ts": bigRoutine("deadMegaRoutine", "deadMega"),
		"src/live-routine.ts": bigRoutine("liveMegaRoutine", "liveMega"),
		...users,
	};
}

// ─── F-depth (iteration 2, F2): a dirty file of distant chunks under a short channel ──

const DOCK_WORDS = [
	"quilt marmot sorrel",
	"anvil plover thistle",
	"basalt wren juniper",
	"cobalt heron sedge",
	"dune ibis fennel",
	"ember stoat yarrow",
	"flint vole tansy",
	"garnet shrike nettle",
	"hazel lark mallow",
	"indigo newt sorrel",
];

function dockFn(i: number, k: number): string {
	const id = letters(i + 40);
	return [
		`// harbor ${DOCK_WORDS[i]} cargo manifest crate pallet tally ${id}`,
		`export function dockLedger${id}(value: number): number {`,
		`  const dockTally${id} = value + ${k};`,
		`  return dockTally${id};`,
		"}",
		"",
	].join("\n");
}

/** src/dock.ts: 10 weakly related chunks (one "harbor" each among many other words). */
export function dockFile(editedLastConstant = 0): string {
	return Array.from({ length: 10 }, (_, i) =>
		dockFn(i, i === 9 ? 900 + editedLastConstant : i + 1),
	).join("\n");
}

/**
 * F-depth: 80 vector-strong rows (camelCase `harborBeacon…` — split by the fake
 * embedder, one token to BM25), 80 BM25-strong rows (prose "harbor beacon"),
 * and src/dock.ts whose chunks are distant in BOTH channels.
 */
export function depthFixture(): Record<string, string> {
	const files: Record<string, string> = { "src/dock.ts": dockFile() };
	for (let f = 0; f < 8; f++) {
		const v: string[] = [];
		const b: string[] = [];
		for (let i = 0; i < 10; i++) {
			const id = letters(f * 10 + i);
			v.push(
				`export function harborBeacon${id}(value: number): number {\n  const harborBeacon${id}Slot = value * ${i + 3};\n  return harborBeacon${id}Slot;\n}\n`,
			);
			b.push(
				`// harbor beacon log for tide gauge ${id}\nexport function tideGauge${id}(value: number): number {\n  return value - ${i + 1};\n}\n`,
			);
		}
		files[`src/vector/v${f}.ts`] = v.join("\n");
		files[`src/prose/p${f}.ts`] = b.join("\n");
	}
	return files;
}
