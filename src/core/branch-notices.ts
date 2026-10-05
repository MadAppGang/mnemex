/**
 * The two branch-state sentences, and NOTHING ELSE.
 *
 * ── WHY THIS IS ITS OWN FILE, WITH ZERO IMPORTS ──────────────────────────────
 * Four surfaces render these: the nine graph commands and `status` through
 * `reportBranchState` (`src/cli.ts`), the CLI `search`, `src/output/agent.ts`,
 * and the two MCP search tools. They must say ONE thing, because the remedy in
 * them is a command name and a copy left behind after that changes sends a user
 * somewhere that does not help.
 *
 * The obvious home was `./branch-state.ts`, beside the predicate. That file
 * imports `./tracker.js`, so putting the strings there would have pulled SQLite,
 * the whole tracker and its schema DDL into `src/output/agent.ts` — a module on
 * the `--agent` render path of EVERY command — to obtain three template
 * literals. A leaf with no imports costs nothing to depend on, and it cannot
 * take part in an import cycle.
 *
 * `branchUnknown` and `branchEmpty` are the two states and they are NOT the
 * same: "the registry has never seen this branch" versus "the registry knows
 * this branch and the store holds no row for it". A user told "not indexed"
 * about a branch they indexed yesterday goes looking for a bug in the registry
 * instead of re-indexing, which is why the second sentence names the causes.
 */

// 3b-3 built `reportBranchState` (`src/cli.ts`) for the nine graph commands and
// `status`, with the sentences written inline. 3c has to say the same two things
// on `search` as well, in the CLI and in TWO MCP tools. The brief's instruction
// was to reuse that seam rather than add a second message path, so the wording
// moved HERE and every surface renders these — `reportBranchState` included.
//
// Why it matters that this is one declaration and not four copies that happen to
// agree today: the remedy in these sentences is `mnemex index`, and the day that
// changes (to a new flag, say, or a new subcommand) a copy left behind sends a
// user to a command that does not fix their problem. It is the same argument the
// emptiness PREDICATE is shared for, one level up.

/**
 * "This branch is registered and the store holds nothing for it."
 *
 * `command` names the command the user actually ran, because the sentence has to
 * distinguish this from "nothing found", and "nothing found" is phrased by the
 * command. Human copy goes to STDERR at every call site: on `search` it must not
 * land inside a result list something is parsing.
 */
export function branchEmptyNotice(
	label: string | null,
	command: string,
	/**
	 * V1.7: `store.json.storeRebuildAt` is newer than this branch's
	 * `lastIndexedAt`, so the cause is KNOWN rather than one of several.
	 *
	 * Optional and defaulting to `false`, because the rows-based signal must
	 * stand on its own: a caller that cannot compute the marker still gets a
	 * correct, actionable message, which is decision I-17 item 3's condition for
	 * building the marker at all. The marker only ever narrows the sentence.
	 */
	storeRebuiltElsewhere = false,
): string {
	const cause = storeRebuiltElsewhere
		? "    This index was REBUILT WHOLE after your branch was last indexed — by another\n" +
			"    worktree, or by `--force-all` / `clear --all` / a model change / a version\n" +
			"    upgrade. Every branch has to index itself again.\n"
		: "    The store was rebuilt (`mnemex index --force-all`, `mnemex clear --all`, a model\n" +
			"    change or a version upgrade), or a run was interrupted — every branch has to\n" +
			"    index itself again.\n";
	return (
		`\n⚠️  Branch '${label ?? "?"}' is in this index, but the index holds no rows for it, so\n` +
		`    \`${command}\` has nothing to answer from. This is NOT the same as 'nothing found'.\n` +
		cause +
		"    Run: mnemex index\n"
	);
}

/** "The registry has never seen this branch." The other half of the pair. */
export function branchUnknownNotice(
	label: string | null,
	command: string,
): string {
	return (
		`\n⚠️  Branch '${label ?? "?"}' has not been indexed, so \`${command}\` has nothing to answer from.\n` +
		"    This is NOT the same as 'nothing found' — no symbol of this branch is in the index yet.\n" +
		"    Run: mnemex index\n"
	);
}

/**
 * The `branch_hint=` value for `--agent`, or `null` when neither state holds.
 *
 * ONE line, never a newline: `--agent` output is `key=value` per line and a
 * multi-line value would split into keys a consumer cannot parse. That is the
 * only reason the agent and human forms differ at all.
 */
export function branchHintForAgent(
	state: { readonly branchUnknown: boolean; readonly branchEmpty: boolean },
	label: string | null,
	command: string,
): string | null {
	if (state.branchUnknown) {
		return `branch '${label ?? "?"}' is not indexed; ${command} answers for this branch only. Run: mnemex index`;
	}
	if (state.branchEmpty) {
		return `branch '${label ?? "?"}' is known but the index holds no rows for it; ${command} answers for this branch only. Run: mnemex index`;
	}
	return null;
}
