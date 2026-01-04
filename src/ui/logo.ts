/**
 * Logo and Banner Utilities
 *
 * ASCII art and branding for CLI tools.
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, existsSync } from "fs";
import { colors as c } from "./colors.js";

/** Cached version */
let _version: string | null = null;

/**
 * Get package version
 */
function getVersion(): string {
	if (_version) return _version;

	try {
		// Try multiple paths to find package.json
		const paths = [
			join(process.cwd(), "package.json"),
			join(dirname(fileURLToPath(import.meta.url)), "../../package.json"),
		];

		for (const path of paths) {
			if (existsSync(path)) {
				const pkg = JSON.parse(readFileSync(path, "utf-8"));
				_version = pkg.version || "0.0.0";
				return _version!;
			}
		}
	} catch {
		// Ignore errors
	}

	_version = "0.0.0";
	return _version;
}

/**
 * ASCII logo for claudemem
 */
export function getLogo(): string {
	const version = getVersion();
	return `
${c.orange}   ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗${c.reset}${c.green}███╗   ███╗███████╗███╗   ███╗${c.reset}
${c.orange}  ██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝${c.reset}${c.green}████╗ ████║██╔════╝████╗ ████║${c.reset}
${c.orange}  ██║     ██║     ███████║██║   ██║██║  ██║█████╗  ${c.reset}${c.green}██╔████╔██║█████╗  ██╔████╔██║${c.reset}
${c.orange}  ██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝  ${c.reset}${c.green}██║╚██╔╝██║██╔══╝  ██║╚██╔╝██║${c.reset}
${c.orange}  ╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗${c.reset}${c.green}██║ ╚═╝ ██║███████╗██║ ╚═╝ ██║${c.reset}
${c.orange}   ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝${c.reset}${c.green}╚═╝     ╚═╝╚══════╝╚═╝     ╚═╝${c.reset}
${c.dim}  Semantic code search powered by embeddings          v${version}${c.reset}
`;
}

/**
 * Print logo to console
 */
export function printLogo(): void {
	console.log(getLogo());
}

/**
 * Print a benchmark header with emoji
 */
export function printBenchmarkHeader(emoji: string, title: string): void {
	console.log(`\n${c.orange}${emoji} ${c.bold}${title}${c.reset}\n`);
}

/**
 * Print a phase header
 */
export function printPhaseHeader(text: string): void {
	console.log(`${c.dim}${text}${c.reset}`);
}

/**
 * Print status with emoji
 */
export function printStatus(emoji: string, label: string, value: string): void {
	console.log(`${emoji} ${c.bold}${label}:${c.reset} ${value}`);
}
