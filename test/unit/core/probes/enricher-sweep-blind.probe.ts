/**
 * Does the caller-side SR-2 sweep SEE `enricher.ts`? Measured before trusting
 * it (CLAUDE.md #32, and the brief's "prove a sweep sees before trusting it
 * finds nothing").
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sweepIndexerLoops } from "../../../helpers/indexer-loop-sweep.js";
import { typescriptParser } from "../../../helpers/tracker-region-sweep.js";

const REPO = join(import.meta.dir, "..", "..", "..", "..");
const parser = await typescriptParser();

for (const rel of [
	["src", "core", "enrichment", "enricher.ts"],
	["src", "core", "indexer.ts"],
	["src", "core", "branch-membership.ts"],
]) {
	const path = join(REPO, ...rel);
	const result = sweepIndexerLoops(readFileSync(path, "utf8"), parser, []);
	console.log(
		`${rel.join("/")}: findings=${result.findings.length} census=${JSON.stringify(
			result.census,
		)}`,
	);
	for (const finding of result.findings.slice(0, 8)) {
		console.log(`   ${finding.rule} line ${finding.line} ${finding.callee}`);
	}
}
