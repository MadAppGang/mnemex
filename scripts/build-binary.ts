#!/usr/bin/env bun
/**
 * Compile the mnemex binary. Every package script and workflow that produces a
 * binary runs this, so a release and a pull request build the same thing.
 *
 * Usage: bun scripts/build-binary.ts [--target <bun-target>] [--outfile <path>]
 *
 * With no --target the binary is native to this machine; --outfile defaults to
 * `mnemex`. Grammars must already be downloaded (`bun run download-grammars`).
 *
 * A darwin binary is re-signed ad hoc and its signature verified, so a bad
 * signature fails the build instead of the user's first command. Bun 1.4.0's
 * `bun build --compile` keeps the linker's ad hoc signature after it appends the
 * bundle, so the signature no longer matches the file and Apple Silicon kills
 * the binary at launch (exit 137). The GitHub macOS runner executes such a
 * binary without complaint, which is why running it there proves nothing about
 * the signature and `codesign --verify --strict` is the check.
 *
 * The externals are not interchangeable with the `@opentui/core` /
 * `@opentui/react` they replace. Externalising those packages themselves means
 * nothing embeds them, so the binary cannot resolve them and dies at startup
 * (#15).
 *
 *   `@opentui/core-*` — the eight per-platform native packages ONLY. The glob
 *   requires the hyphen, so it does not match `@opentui/core` itself. They must
 *   stay external: `bun install` on a glibc runner skips the musl optional
 *   dependency, while the bundler demands both libc branches.
 *
 *   `web-tree-sitter/tree-sitter.wasm` — OpenTUI 0.5.1 asks for the pre-0.26
 *   specifier; web-tree-sitter 0.26 exports `./web-tree-sitter.wasm`. The bad
 *   specifier is latent on the npm path too, reached only by OpenTUI's syntax
 *   highlighting.
 */

import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		target: { type: "string" },
		outfile: { type: "string", default: "mnemex" },
	},
});

const target = values.target;
const outfile = values.outfile as string;
const darwin = target
	? target.startsWith("bun-darwin-")
	: process.platform === "darwin";

function run(argv: string[]): void {
	const result = Bun.spawnSync(argv, { stdout: "inherit", stderr: "inherit" });
	if (result.exitCode !== 0) {
		console.error(`build-binary: ${argv.join(" ")} exited ${result.exitCode}`);
		process.exit(result.exitCode || 1);
	}
}

if (darwin && process.platform !== "darwin") {
	console.error(
		`build-binary: ${target} must be built on macOS, the only host that can sign it`,
	);
	process.exit(1);
}

run([
	process.execPath,
	"build",
	"src/index.ts",
	"--compile",
	"--compile-exec-argv=--env-file=/dev/null",
	...(target ? [`--target=${target}`] : []),
	"--external",
	"web-tree-sitter/tree-sitter.wasm",
	"--external",
	"@opentui/core-*",
	"--outfile",
	outfile,
]);

if (darwin) {
	run(["codesign", "--force", "--sign", "-", outfile]);
	run(["codesign", "--verify", "--strict", "--verbose=2", outfile]);
}
