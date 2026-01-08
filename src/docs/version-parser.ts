/**
 * Version Parser
 *
 * Parses version constraints from package manifests (npm, pip, go, cargo)
 * and extracts the major version for documentation API calls.
 */

import type { VersionConstraint } from "./types.js";

// ============================================================================
// Semver Parsing
// ============================================================================

/**
 * Parse a semver version string into components
 * Handles: "18.2.0", "v18.2.0", "^18.2.0", "~18.2.0", ">=18.2.0", etc.
 */
export function parseVersion(versionStr: string): VersionConstraint | null {
	if (!versionStr || versionStr === "*" || versionStr === "latest") {
		return null;
	}

	// Remove leading "v" if present
	let raw = versionStr.trim();

	// Extract operator (^, ~, >=, <=, >, <, =)
	const operatorMatch = raw.match(/^([~^<>=]+)/);
	const operator = operatorMatch?.[1];
	if (operator) {
		raw = raw.slice(operator.length);
	}

	// Remove leading "v" after operator
	if (raw.startsWith("v")) {
		raw = raw.slice(1);
	}

	// Parse version numbers
	const parts = raw.split(".");
	const major = Number.parseInt(parts[0], 10);

	if (Number.isNaN(major)) {
		return null;
	}

	const minor =
		parts.length > 1 && parts[1] !== "*"
			? Number.parseInt(parts[1], 10)
			: undefined;
	const patch =
		parts.length > 2 && parts[2] !== "*"
			? Number.parseInt(parts[2].split("-")[0], 10) // Handle prerelease: 18.2.0-beta
			: undefined;

	return {
		raw: versionStr,
		major,
		minor: Number.isNaN(minor as number) ? undefined : minor,
		patch: Number.isNaN(patch as number) ? undefined : patch,
		operator,
	};
}

/**
 * Extract major version string for API calls
 * e.g., "^18.2.0" → "v18", "~3.9.0" → "v3"
 */
export function extractMajorVersion(versionStr: string): string | undefined {
	const parsed = parseVersion(versionStr);
	if (!parsed) return undefined;
	return `v${parsed.major}`;
}

// ============================================================================
// NPM Version Parsing
// ============================================================================

/**
 * Parse npm-style version constraint
 * Handles: "^18.2.0", "~18.2.0", ">=18.0.0 <19.0.0", "18.x", etc.
 */
export function parseNpmVersion(constraint: string): VersionConstraint | null {
	// Handle ranges like ">=18.0.0 <19.0.0" - use the first part
	const parts = constraint.split(/\s+/);
	const first = parts[0];

	// Handle x-ranges: "18.x", "18.2.x"
	const xRange = first.replace(/\.x/g, ".0");

	return parseVersion(xRange);
}

// ============================================================================
// Python Version Parsing
// ============================================================================

/**
 * Parse Python-style version constraint
 * Handles: ">=3.9,<4.0", "~=3.9.0", "==3.9.*", etc.
 */
export function parsePythonVersion(
	constraint: string,
): VersionConstraint | null {
	// Handle multiple constraints: ">=3.9,<4.0" - use first part
	const parts = constraint.split(",");
	const first = parts[0].trim();

	// Handle ~= (compatible release)
	if (first.startsWith("~=")) {
		return parseVersion(first.slice(2));
	}

	// Handle ==X.Y.*
	if (first.includes("*")) {
		return parseVersion(first.replace("*", "0"));
	}

	return parseVersion(first);
}

// ============================================================================
// Go Version Parsing
// ============================================================================

/**
 * Parse Go module version
 * Handles: "v1.21.0", "v1.21", etc.
 */
export function parseGoVersion(version: string): VersionConstraint | null {
	return parseVersion(version);
}

// ============================================================================
// Cargo (Rust) Version Parsing
// ============================================================================

/**
 * Parse Cargo-style version constraint
 * Handles: "1.0", "^1.0", "~1.0", ">=1.0, <2.0", etc.
 */
export function parseCargoVersion(
	constraint: string,
): VersionConstraint | null {
	// Cargo defaults to ^ if no operator specified
	const parts = constraint.split(",");
	const first = parts[0].trim();

	// If no operator, treat as ^
	if (!/^[~^<>=]/.test(first)) {
		return parseVersion(`^${first}`);
	}

	return parseVersion(first);
}

// ============================================================================
// Unified Parser
// ============================================================================

export type PackageEcosystem = "npm" | "pypi" | "go" | "cargo";

/**
 * Parse version constraint based on ecosystem
 */
export function parseVersionForEcosystem(
	constraint: string,
	ecosystem: PackageEcosystem,
): VersionConstraint | null {
	switch (ecosystem) {
		case "npm":
			return parseNpmVersion(constraint);
		case "pypi":
			return parsePythonVersion(constraint);
		case "go":
			return parseGoVersion(constraint);
		case "cargo":
			return parseCargoVersion(constraint);
		default:
			return parseVersion(constraint);
	}
}
