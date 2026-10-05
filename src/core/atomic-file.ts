/**
 * Replace a small file atomically AND durably.
 *
 * Writes a sibling temp file, fsyncs it, renames it over the target, then
 * fsyncs the directory (best effort). After this returns, a crash cannot roll
 * the file back to its previous contents.
 *
 * Atomic PER WRITER only. Two writers that each read, mutate and rename lose
 * one update, and no file primitive prevents that: serialising them is the
 * caller's job (REG-1, the store lock). Durability is a separate property, and
 * it is the one W-R1's allocation flush relies on (architecture §3.4, C1):
 * a branch id must be on disk before any row carries it.
 */

import { randomBytes } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";

export function writeFileAtomicallySync(path: string, contents: string): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	// pid + random: two processes, or two writes in one process, never share a
	// temp name, and `wx` refuses to reuse one that somehow exists.
	const tmp = `${path}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
	const bytes = Buffer.from(contents, "utf8");
	let fd: number | null = null;
	try {
		fd = openSync(tmp, "wx", 0o644);
		let offset = 0;
		while (offset < bytes.length) {
			offset += writeSync(fd, bytes, offset, bytes.length - offset);
		}
		fsyncSync(fd);
		closeSync(fd);
		fd = null;
		renameSync(tmp, path);
	} catch (error) {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				// Already failing; the original error is the one to report.
			}
		}
		rmSync(tmp, { force: true });
		throw error;
	}
	fsyncDirectory(dir);
}

/**
 * Persist the rename itself. Best effort: Windows cannot open a directory for
 * fsync, and some filesystems refuse it. The rename is atomic either way; only
 * its survival across power loss is at stake, which the registry's `nextId`
 * raise covers separately (§3.4 mechanism 2).
 */
function fsyncDirectory(dir: string): void {
	let fd: number | null = null;
	try {
		fd = openSync(dir, "r");
		fsyncSync(fd);
	} catch {
		// See above: not every platform can fsync a directory.
	} finally {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				// Nothing left to do.
			}
		}
	}
}
