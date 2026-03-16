/**
 * Migration utilities for mnemex
 *
 * Handles migration from old .claudemem/ directory to new .mnemex/ directory.
 * Called early in CLI startup to transparently migrate existing users.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ============================================================================
// Constants
// ============================================================================

const OLD_DIR_NAME = ".claudemem";
const NEW_DIR_NAME = ".mnemex";
const GITIGNORE_FILE = ".gitignore";

// ============================================================================
// Migration Functions
// ============================================================================

/**
 * Migrate project-level .claudemem/ directory to .mnemex/
 *
 * - If .claudemem/ exists and .mnemex/ does NOT: renames .claudemem/ → .mnemex/
 * - If both exist: warns and keeps .mnemex/ (no overwrite)
 * - Also updates .gitignore to use .mnemex/
 *
 * @param projectPath - Root directory of the project
 * @param silent - Suppress warning messages (default: false)
 */
export function migrateProjectDir(
	projectPath: string,
	silent = false,
): void {
	const oldDir = join(projectPath, OLD_DIR_NAME);
	const newDir = join(projectPath, NEW_DIR_NAME);

	if (existsSync(oldDir)) {
		if (!existsSync(newDir)) {
			try {
				renameSync(oldDir, newDir);
				if (!silent) {
					process.stderr.write(
						`[mnemex] Migrated ${OLD_DIR_NAME}/ → ${NEW_DIR_NAME}/ in ${projectPath}\n`,
					);
				}
			} catch (error) {
				if (!silent) {
					process.stderr.write(
						`[mnemex] Warning: Could not migrate ${OLD_DIR_NAME}/ to ${NEW_DIR_NAME}/: ${error}\n`,
					);
				}
			}
		} else if (!silent) {
			process.stderr.write(
				`[mnemex] Warning: Both ${OLD_DIR_NAME}/ and ${NEW_DIR_NAME}/ exist in ${projectPath}. Keeping ${NEW_DIR_NAME}/.\n`,
			);
		}
	}

	// Update .gitignore regardless (ensure .mnemex/ is ignored)
	updateGitignore(projectPath, silent);
}

/**
 * Migrate global ~/.claudemem/ directory to ~/.mnemex/
 *
 * - If ~/.claudemem/ exists and ~/.mnemex/ does NOT: renames it
 * - If both exist: warns and keeps ~/.mnemex/
 *
 * @param silent - Suppress warning messages (default: false)
 */
export function migrateGlobalDir(silent = false): void {
	const home = homedir();
	const oldDir = join(home, OLD_DIR_NAME);
	const newDir = join(home, NEW_DIR_NAME);

	if (existsSync(oldDir)) {
		if (!existsSync(newDir)) {
			try {
				renameSync(oldDir, newDir);
				if (!silent) {
					process.stderr.write(
						`[mnemex] Migrated ~/${OLD_DIR_NAME}/ → ~/${NEW_DIR_NAME}/\n`,
					);
				}
			} catch (error) {
				if (!silent) {
					process.stderr.write(
						`[mnemex] Warning: Could not migrate ~/${OLD_DIR_NAME}/ to ~/${NEW_DIR_NAME}/: ${error}\n`,
					);
				}
			}
		} else if (!silent) {
			process.stderr.write(
				`[mnemex] Warning: Both ~/${OLD_DIR_NAME}/ and ~/${NEW_DIR_NAME}/ exist. Keeping ~/${NEW_DIR_NAME}/.\n`,
			);
		}
	}
}

/**
 * Update .gitignore to use .mnemex/ instead of .claudemem/
 *
 * - Removes .claudemem entry if present
 * - Adds .mnemex/ entry if not already present
 *
 * @param projectPath - Root directory of the project
 * @param silent - Suppress messages (default: false)
 */
function updateGitignore(projectPath: string, silent = false): void {
	const gitignorePath = join(projectPath, GITIGNORE_FILE);

	let lines: string[] = [];
	if (existsSync(gitignorePath)) {
		try {
			lines = readFileSync(gitignorePath, "utf-8").split("\n");
		} catch {
			return; // Can't read .gitignore, skip
		}
	} else {
		return; // No .gitignore to update
	}

	const hasNewEntry = lines.some(
		(line) =>
			line.trim() === NEW_DIR_NAME ||
			line.trim() === `${NEW_DIR_NAME}/` ||
			line.trim() === `**/${NEW_DIR_NAME}/**`,
	);

	const hasOldEntry = lines.some(
		(line) =>
			line.trim() === OLD_DIR_NAME ||
			line.trim() === `${OLD_DIR_NAME}/` ||
			line.trim() === `**/${OLD_DIR_NAME}/**`,
	);

	if (!hasOldEntry && hasNewEntry) {
		// Already up-to-date
		return;
	}

	let changed = false;

	// Remove old .claudemem entries
	if (hasOldEntry) {
		lines = lines.filter(
			(line) =>
				line.trim() !== OLD_DIR_NAME &&
				line.trim() !== `${OLD_DIR_NAME}/` &&
				line.trim() !== `**/${OLD_DIR_NAME}/**`,
		);
		changed = true;
	}

	// Add new .mnemex/ entry if not present
	if (!hasNewEntry) {
		// Add before the last empty line or at the end
		lines.push(`${NEW_DIR_NAME}/`);
		changed = true;
	}

	if (changed) {
		try {
			// Ensure content ends with a single newline
			const content = lines.join("\n").replace(/\n+$/, "") + "\n";
			writeFileSync(gitignorePath, content, "utf-8");
			if (!silent) {
				process.stderr.write(`[mnemex] Updated .gitignore to use ${NEW_DIR_NAME}/\n`);
			}
		} catch (error) {
			if (!silent) {
				process.stderr.write(`[mnemex] Warning: Could not update .gitignore: ${error}\n`);
			}
		}
	}
}

/**
 * Run all migrations for a project.
 * Called early in CLI startup.
 *
 * @param projectPath - Root directory of the project (defaults to cwd)
 * @param silent - Suppress all output (default: true for clean CLI experience)
 */
export function runMigrations(
	projectPath: string = process.cwd(),
	silent = true,
): void {
	migrateGlobalDir(silent);
	migrateProjectDir(projectPath, silent);
}
