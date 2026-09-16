/**
 * `mnemex branches` — what this store holds, and `branches prune` to reclaim it.
 *
 * ── WHY THE LISTING EXISTS AT ALL ───────────────────────────────────────────
 * Before this command, "which branches does this store hold?" was unanswerable
 * without opening `branches.json` by hand. Everything else in the branch model
 * — the ids, the tombstones, the widen backlog, D1's unknown-branch fallback —
 * is invisible from the outside, so a user seeing a surprising search result had
 * no way to find out which branch answered it.
 *
 * ── TWO COMMANDS, TWO LOCK POSTURES (REG-1, W-R7) ───────────────────────────
 * `branches` is READ-ONLY: it parses `branches.json` and counts rows, takes no
 * lock, and mutates nothing. `branches prune` is the manual, immediate form of
 * the confirmation pass plus rule C, and it takes THE STORE LOCK across its
 * whole read-modify-write — §3.4's W-R7.
 *
 * ── WHAT `prune` DOES AND DOES NOT SHORTCUT ─────────────────────────────────
 * IMMEDIATE means "now, rather than on the 20th index run". It does NOT mean
 * "skip the grace". A branch whose ref vanished is marked `unconfirmedSince` on
 * the first prune and tombstoned by a later one, exactly as the automatic pass
 * does, because the 24 h grace exists for a state that is real: a mid-rebase or
 * mid-`pack-refs` instant, where destroying the index would be wrong no matter
 * who asked. What `prune` adds is that the sweep then runs TO COMPLETION rather
 * than to `ORPHAN_SWEEP_BUDGET`, so rule C can actually finalise in one command,
 * and that it PRINTS what it is waiting for — otherwise a first prune looks like
 * it did nothing.
 *
 * ── STRICT FLAGS (CLAUDE.md #30) ────────────────────────────────────────────
 * An unrecognised dash-argument aborts before the lock and before any write.
 * `mnemex keychain migrate --dry-runDD` ran a REAL migration on a real machine
 * one day after shipping, because the flag was parsed by `includes()` and a typo
 * therefore meant the destructive default. `prune --dry-run` has the same shape
 * and gets the same guard.
 */

import {
	BRANCH_DELETE_GRACE_MS,
	BRANCH_SOFT_LIMIT,
	type BranchDecision,
	confirmScan,
} from "../../core/branch-lifecycle.js";
import {
	combineBranchIdSources,
	openRegistry,
	readBranchRegistry,
} from "../../core/branch-registry.js";
import { sweepTombstonedBranches } from "../../core/branch-sweep.js";
import { readCurrentHead } from "../../core/git-layout.js";
import { createVectorStore } from "../../core/store.js";
import {
	getIndexDbPathFor,
	getVectorStorePathFor,
	resolveStoreLocation,
	type StoreLocation,
} from "../../core/store-location.js";
import {
	describeStoreLockRefusal,
	STORE_WRITER_LOCK_WAIT_MS,
	withStoreLock,
} from "../../core/store-lock-policy.js";
import { readStoreState, writeStoreState } from "../../core/store-meta.js";
import { createFileTracker } from "../../core/tracker.js";

const USAGE = `
Usage: mnemex branches [prune] [--dry-run]

  branches             List every branch this store holds: id, label, state and
                       how many rows it accounts for. Read-only, takes no lock.
  branches prune       Run the branch-confirmation pass now, then reclaim the
                       rows of every branch whose tombstone has matured. Takes
                       the store lock. Honours the same 24 h grace the automatic
                       pass does: a branch whose ref has just vanished is marked
                       unconfirmed first and tombstoned by a later prune.
  branches prune --dry-run
                       Report what a prune would do. Writes nothing.
`;

/** Every flag each subcommand accepts. `--agent` is filtered out by `runCli`. */
const ACCEPTED_FLAGS: Record<string, readonly string[]> = {
	list: [],
	prune: ["--dry-run"],
};

export interface BranchesCommandOptions {
	/** `--agent`: `key=value` lines only. */
	agent?: boolean;
}

/** One row of the listing. */
interface BranchRow {
	id: number;
	label: string;
	kind: string;
	ephemeral: boolean;
	state: "live" | "unconfirmed" | "deleted";
	current: boolean;
	lastSeen: string;
	lastIndexedAt: string | null;
	needsReindex: boolean;
	chunkRows: number;
	fileRows: number;
}

/**
 * Returns the exit code rather than calling `process.exit`: exiting mid-render
 * truncates buffered stdout, which is how an agent consumer parses half a line.
 */
export async function handleBranchesCommand(
	args: string[],
	options?: BranchesCommandOptions,
): Promise<number> {
	const agent = options?.agent === true;
	const first = args[0];

	if (first === "help" || first === "--help" || first === "-h") {
		if (agent) {
			console.log("command=branches");
			console.log("subcommands=prune");
			return 0;
		}
		console.log(USAGE);
		return 0;
	}

	const subcommand = first === "prune" ? "prune" : "list";
	if (subcommand === "list" && first !== undefined && !first.startsWith("-")) {
		console.error(`error=unknown_subcommand value=${first}`);
		console.error("Usage: mnemex branches [prune] [--dry-run]");
		return 1;
	}

	// STRICT FLAGS, before the lock and before any write (CLAUDE.md #30). A
	// boolean flag parsed by membership makes every TYPO of it mean the
	// destructive default.
	const flagArgs = subcommand === "prune" ? args.slice(1) : args;
	const accepted = ACCEPTED_FLAGS[subcommand];
	const unknownFlag = flagArgs.find(
		(a) => a.startsWith("-") && !accepted.includes(a),
	);
	if (unknownFlag !== undefined) {
		const meant = accepted.find(
			(f) => unknownFlag.startsWith(f) || f.startsWith(unknownFlag),
		);
		console.error(
			`error=unknown_flag subcommand=${subcommand} value=${unknownFlag}`,
		);
		if (meant) console.error(`Did you mean ${meant}?`);
		console.error(
			accepted.length > 0
				? `Accepted for '${subcommand}': ${accepted.join(", ")}. Nothing was changed.`
				: `'branches' takes no flags. Nothing was changed.`,
		);
		return 1;
	}

	return subcommand === "prune"
		? await pruneBranches(flagArgs.includes("--dry-run"), agent)
		: listBranches(agent);
}

// ════════════════════════════════════════════════════════════════════════════
// LIST — read-only, no lock
// ════════════════════════════════════════════════════════════════════════════

function listBranches(agent: boolean): number {
	const loc = resolveStoreLocation(process.cwd());
	let rows: BranchRow[];
	let currentLabel: string | null = null;
	try {
		currentLabel =
			loc.gitLayout === null ? null : readCurrentHead(loc.gitLayout).label;
		rows = collectRows(loc, currentLabel);
	} catch (error) {
		console.error(
			`error=${error instanceof Error ? error.message : String(error)}`,
		);
		return 1;
	}

	if (agent) {
		console.log(`store_dir=${loc.storeDir}`);
		console.log(
			`branch_count=${rows.filter((r) => r.state !== "deleted").length}`,
		);
		if (currentLabel !== null) console.log(`branch=${currentLabel}`);
		// D1 again, in the one command whose job is to answer "which branches
		// does this store hold?": a HEAD with no live entry is exactly the state
		// that makes every graph command answer empty.
		console.log(
			`branch_unknown=${currentLabel !== null && !rows.some((r) => r.current) ? 1 : 0}`,
		);
		for (const row of rows) {
			console.log(
				`branch id=${row.id} label=${row.label} kind=${row.kind} state=${row.state} ` +
					`ephemeral=${row.ephemeral ? 1 : 0} current=${row.current ? 1 : 0} ` +
					`chunk_rows=${row.chunkRows} file_rows=${row.fileRows} ` +
					`last_seen=${row.lastSeen} last_indexed=${row.lastIndexedAt ?? ""} ` +
					`needs_reindex=${row.needsReindex ? 1 : 0}`,
			);
		}
		return 0;
	}

	if (rows.length === 0) {
		console.log(
			"\nThis store holds no branch entries yet. Run `mnemex index` to create one.\n",
		);
		return 0;
	}
	console.log(`\nBranches in ${loc.storeDir}\n`);
	for (const row of rows) {
		const marker = row.current ? "*" : " ";
		const state =
			row.state === "live"
				? row.ephemeral
					? "ephemeral"
					: "live"
				: row.state === "unconfirmed"
					? "unconfirmed (ref not found)"
					: "deleted (being reclaimed)";
		console.log(
			`${marker} ${String(row.id).padStart(3)}  ${row.label.padEnd(32)} ${state}`,
		);
		console.log(
			`       ${row.chunkRows} chunk row(s), ${row.fileRows} file(s)` +
				`${row.lastIndexedAt === null ? ", never indexed" : `, last indexed ${row.lastIndexedAt}`}` +
				`${row.needsReindex ? ", NEEDS REINDEX" : ""}`,
		);
	}
	const live = rows.filter((r) => r.state !== "deleted").length;
	console.log("");
	if (currentLabel !== null && !rows.some((r) => r.current)) {
		console.log(
			`The current branch '${currentLabel}' has no entry: it has never been indexed.`,
		);
		console.log("Run: mnemex index\n");
	}
	if (live > BRANCH_SOFT_LIMIT) {
		console.log(
			`${live} live branches is above the soft limit of ${BRANCH_SOFT_LIMIT}. Run \`mnemex branches prune\`.\n`,
		);
	}
	return 0;
}

/**
 * The listing's rows.
 *
 * The row counts come from the tracker, which is opened read-only-ish and closed
 * at once. No lock: this is a read, and §3.4's REG-1 governs writes.
 */
function collectRows(
	loc: StoreLocation,
	currentLabel: string | null,
): BranchRow[] {
	const registry = readBranchRegistry(loc);
	let chunkCounts = new Map<number, number>();
	const fileCounts = new Map<number, number>();
	const tracker = tryOpenTracker(loc);
	try {
		if (tracker !== null) {
			chunkCounts = tracker.membershipCounts();
			for (const entry of registry.branches) {
				fileCounts.set(entry.id, tracker.countBranchTreeRows(entry.id).files);
			}
		}
	} finally {
		tracker?.close();
	}
	return registry.branches.map((entry) => ({
		id: entry.id,
		label: entry.label,
		kind: entry.kind,
		ephemeral: entry.ephemeral,
		state:
			entry.deletedAt !== null
				? ("deleted" as const)
				: entry.unconfirmedSince !== null
					? ("unconfirmed" as const)
					: ("live" as const),
		current: entry.label === currentLabel && entry.deletedAt === null,
		lastSeen: entry.lastSeen,
		lastIndexedAt: entry.lastIndexedAt,
		needsReindex: entry.needsReindex,
		chunkRows: chunkCounts.get(entry.id) ?? 0,
		fileRows: fileCounts.get(entry.id) ?? 0,
	}));
}

/** `null` when there is no `index.db` yet; the listing then reports zeros. */
function tryOpenTracker(
	loc: StoreLocation,
): ReturnType<typeof createFileTracker> | null {
	try {
		return createFileTracker(getIndexDbPathFor(loc), loc.pathRoot);
	} catch {
		return null;
	}
}

// ════════════════════════════════════════════════════════════════════════════
// PRUNE — W-R7: the store lock across the whole read-modify-write
// ════════════════════════════════════════════════════════════════════════════

async function pruneBranches(dryRun: boolean, agent: boolean): Promise<number> {
	const loc = resolveStoreLocation(process.cwd());
	if (loc.gitLayout === null) {
		const message =
			"this directory is not inside a git repository, so the store has no branches to prune";
		if (agent) console.error(`error=${message}`);
		else console.error(`\n${message}\n`);
		return 1;
	}

	// PHASE A, hoisted exactly as the automatic pass hoists it: the capped
	// `packed-refs` stream is the one part that must not run inside the lock.
	const entries = readBranchRegistry(loc).branches;
	const scan = await confirmScan(loc.gitLayout, entries);
	if (scan.deferred) {
		const message = `branch confirmation deferred: ${scan.deferredReason ?? "a ref source was over its cap"}`;
		if (agent) console.error(`error=${message}`);
		else console.error(`\n${message}\nNothing was changed.\n`);
		return 1;
	}

	if (dryRun) {
		return reportDryRun(loc, scan.decisions, scan.missingRefs, agent);
	}

	const outcome = await withStoreLock(
		loc,
		{ waitTimeout: STORE_WRITER_LOCK_WAIT_MS, phase: "branches-prune" },
		async (lock) => {
			const tracker = createFileTracker(getIndexDbPathFor(loc), loc.pathRoot);
			const store = createVectorStore({
				vectorsDir: getVectorStorePathFor(loc),
				pathRoot: loc.pathRoot,
			});
			try {
				await store.initialize();
				// C1 mechanism 2, over EVERY store that carries a branch id (3a-2's
				// finding 4), exactly as `Indexer.indexInternal` does it. `prune`
				// allocates no id, so the raise can only matter if a row already
				// carries one above `nextId` — but assembling the source the same
				// way in both writers is what stops the two drifting apart.
				const rowSources = combineBranchIdSources(
					tracker,
					await store.highestBranchId(),
				);
				const registry = openRegistry(loc, lock, rowSources);
				const applied = registry.applyBranchDecisions(scan.decisions);
				const state = readStoreState(loc);
				// TO COMPLETION, not to `ORPHAN_SWEEP_BUDGET`: this is the explicit
				// form, and a user who typed `prune` is asking for the reclamation
				// to finish. Same regions and same yields, more iterations (§4.5's
				// "budget = infinity with the same region sizes").
				const sweep = await sweepTombstonedBranches(tracker, store, registry, {
					budget: Number.POSITIVE_INFINITY,
					cursor: state.sweep,
					onProgress: () => lock.recordProgress(),
				});
				if (sweep.rowsNarrowed + sweep.rowsDeleted > 0) await store.optimize();
				registry.flush();
				writeStoreState(loc, {
					confirmRunCounter: state.confirmRunCounter,
					sweep: sweep.cursor,
				});
				return { applied, sweep };
			} finally {
				tracker.close();
				await store.close();
			}
		},
	);

	if (!outcome.acquired) {
		const message = describeStoreLockRefusal(outcome.refusal, loc.storeDir);
		if (agent) console.error(`error=${message}`);
		else console.error(`\nNothing was changed: ${message}\n`);
		return 1;
	}

	const { applied, sweep } = outcome.value;
	const unconfirmed = applied.applied.filter(
		(d) => d.set === "unconfirmedSince",
	);
	const tombstoned = applied.applied.filter((d) => d.set === "deletedAt");

	if (agent) {
		console.log(`branches_unconfirmed=${unconfirmed.length}`);
		console.log(`branches_tombstoned=${tombstoned.length}`);
		console.log(`branches_finalized=${sweep.branchesFinalized.length}`);
		console.log(`rows_deleted=${sweep.rowsDeleted}`);
		console.log(`rows_narrowed=${sweep.rowsNarrowed}`);
		console.log(`membership_rows_removed=${sweep.membershipRowsRemoved}`);
		console.log(`sweep_remaining=${sweep.remaining}`);
		console.log(`decisions_dropped=${applied.dropped.length}`);
		for (const decision of unconfirmed) {
			console.log(`unconfirmed label=${decision.label} id=${decision.id}`);
		}
		for (const decision of tombstoned) {
			console.log(
				`tombstoned label=${decision.label} id=${decision.id} reason=${decision.reason}`,
			);
		}
		for (const id of sweep.branchesFinalized) console.log(`finalized id=${id}`);
		return 0;
	}

	console.log("");
	if (unconfirmed.length > 0) {
		console.log(
			`${unconfirmed.length} branch(es) no longer have a git ref and were marked unconfirmed:`,
		);
		for (const d of unconfirmed) console.log(`  ${d.label} (id ${d.id})`);
		console.log(
			`They are tombstoned by a later prune, once ${Math.round(BRANCH_DELETE_GRACE_MS / 3_600_000)}h have passed —`,
		);
		console.log(
			"the wait is deliberate: a mid-rebase instant is a real state, and it must not destroy an index.",
		);
	}
	if (tombstoned.length > 0) {
		console.log(`${tombstoned.length} branch(es) were tombstoned:`);
		for (const d of tombstoned) console.log(`  ${d.label} (${d.reason})`);
	}
	console.log(
		`Reclaimed ${sweep.rowsDeleted} row(s); ${sweep.rowsNarrowed} row(s) another branch still holds were narrowed.`,
	);
	if (sweep.branchesFinalized.length > 0) {
		console.log(
			`${sweep.branchesFinalized.length} branch record(s) were dropped from the registry.`,
		);
	}
	if (
		unconfirmed.length + tombstoned.length + sweep.rowsDeleted === 0 &&
		sweep.branchesFinalized.length === 0
	) {
		console.log("Nothing to reclaim: every branch in the store still exists.");
	}
	console.log("");
	return 0;
}

function reportDryRun(
	loc: StoreLocation,
	decisions: readonly BranchDecision[],
	missingRefs: readonly string[],
	agent: boolean,
): number {
	const entries = readBranchRegistry(loc).branches;
	const tombstoned = entries.filter((e) => e.deletedAt !== null);
	if (agent) {
		console.log("dry_run=1");
		console.log(
			`would_unconfirm=${decisions.filter((d) => d.set === "unconfirmedSince").length}`,
		);
		console.log(
			`would_tombstone=${decisions.filter((d) => d.set === "deletedAt").length}`,
		);
		console.log(`already_tombstoned=${tombstoned.length}`);
		for (const decision of decisions) {
			console.log(
				`would label=${decision.label} id=${decision.id} set=${decision.set} reason=${decision.reason}`,
			);
		}
		for (const label of missingRefs) console.log(`missing_branch_ref=${label}`);
		for (const entry of tombstoned) {
			console.log(`would_sweep id=${entry.id} label=${entry.label}`);
		}
		return 0;
	}
	console.log("\nDry run — nothing was changed.\n");
	if (decisions.length === 0 && tombstoned.length === 0) {
		console.log(
			"Nothing to reclaim: every branch in the store still exists.\n",
		);
		return 0;
	}
	for (const decision of decisions) {
		console.log(
			decision.set === "unconfirmedSince"
				? `  ${decision.label} (id ${decision.id}) would be marked unconfirmed (${decision.reason})`
				: `  ${decision.label} (id ${decision.id}) would be tombstoned (${decision.reason})`,
		);
	}
	for (const entry of tombstoned) {
		console.log(
			`  ${entry.label} (id ${entry.id}) is already tombstoned; its rows would be reclaimed`,
		);
	}
	console.log("");
	return 0;
}
