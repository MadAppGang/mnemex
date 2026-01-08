/**
 * Scorer Utilities
 *
 * Shared utility functions for benchmark scorers.
 */

/**
 * Fuzzy match two strings, considering:
 * - Normalized string comparison (alphanumeric only)
 * - Substring containment
 * - Module path basename matching
 */
export function fuzzyMatch(mentioned: string, actual: string): boolean {
	const normalizedMentioned = mentioned.toLowerCase().replace(/[^a-z0-9]/g, "");
	const normalizedActual = actual.toLowerCase().replace(/[^a-z0-9]/g, "");

	// Exact match
	if (normalizedMentioned === normalizedActual) return true;

	// One contains the other
	if (normalizedMentioned.includes(normalizedActual)) return true;
	if (normalizedActual.includes(normalizedMentioned)) return true;

	// Match module paths (e.g., "./store" matches "store.js")
	const mentionedBase =
		mentioned
			.split("/")
			.pop()
			?.replace(/\.(js|ts|tsx|jsx)$/, "") || mentioned;
	const actualBase =
		actual
			.split("/")
			.pop()
			?.replace(/\.(js|ts|tsx|jsx)$/, "") || actual;
	if (mentionedBase.toLowerCase() === actualBase.toLowerCase()) return true;

	return false;
}
