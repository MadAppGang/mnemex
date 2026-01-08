/**
 * Version comparison utilities for semantic versioning
 */

/**
 * Compare two semantic versions
 * @returns -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
 */
export function compareVersions(v1: string, v2: string): number {
	const a = v1.split(".").map(Number);
	const b = v2.split(".").map(Number);

	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const na = a[i] || 0;
		const nb = b[i] || 0;
		if (na > nb) return 1;
		if (na < nb) return -1;
	}
	return 0;
}

/**
 * Check if latest version is newer than current version
 */
export function isNewerVersion(current: string, latest: string): boolean {
	return compareVersions(latest, current) > 0;
}
