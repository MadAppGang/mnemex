# Branch-scoped shared index — architecture decisions

**Status:** Released in 0.37.0 (steps 1-3 of the multi-layer memory roadmap). Step 4 (cloud) not started.
**Date:** 2026-09-28, updated 2026-10-05 for step 3 and the release.
**Amends:** NFR-5 (see D-8). **Corrects:** the feature's design document, §6.1 and §4.4.3 (see "Corrections owed").
**Traceability:** the `I-n` tags name implementation decisions from the build's session record,
which was never committed. **This document is the durable record**: everything that changes the
architecture or the project state is restated here in full, with the measurement behind it.

---

## Why this exists

One index store per repository, shared by every git worktree, with per-branch row membership.
The problem, in the user's words: *"I don't want 10 developers on the same team reindexing
everything every time for every change."*

Roadmap: **step 1** persistent embedding cache (shipped), **step 2** repo-stable dataset path
(this document), **step 3** local dirty overlay plus the ranking fixes (built on this branch: R1 →
D-13, R2 twin collapse, R3 → D-12; not yet committed), **step 4** cloud authorization (not started;
owns the cloud D-MERGE item).

## What shipped

| Commit | What |
|---|---|
| `160e0d3`, `b8e5fd2` | Step 1: machine-global persistent embedding cache |
| `b3b50b8`, `2a6dc7e`, `5e12a4d`, `c0317b8` | One atomic store lock derived from the store it guards; bounded sync regions; one path resolver |
| `4b08837` | `resolveReferencesByName` no longer freezes the heartbeat (a v0.3.0 defect on `main`) |
| `01f4e2d` | v4 schema: repo-relative paths, durable branch registry |
| `f761c62` | Every read answers for the current branch |
| `52956ee` | Branch membership written, narrowed, recovered |
| `553e454` | A code-unit id carries its content; a parent link does not |
| `11221e9` | Branch lifecycle, `mnemex branches`, unindexed-branch signalling |
| `3c029de` | `--force` scoped to one branch; each summary bought once |
| `451012c` | `STORE_SCOPE_DEFAULT` flipped to `git-common-dir` |
| `a47f763`, `1e034a7` | Four liveness-test deadlines recalibrated |
| `ae6fde2` | Tie-stable ranking, full backlog drain, version pruning |

---

## D-1 — The store lives in the git common directory, shared by every worktree

`STORE_SCOPE_DEFAULT: StoreScope = "git-common-dir"` (`src/core/store-location.ts:116`).
One store per clone; every linked worktree of that clone resolves to it.

Chosen by the user over a machine-global store keyed by repo identity, and over the main
worktree's root.

**Not in scope:** sharing an index between two different *clones* of one repository. The store
is scoped to one clone's git directory.

**Per-worktree state stays per-worktree.** `edit-history/` and its `sessions.json` are *not*
shared — they hold un-rebuildable edit backups, and one `sessions.json` across every worktree
would collide (`src/mcp/config.ts:41-45`). MCP memories also stay per-worktree.
*(I-20; the `edit-history/` hazard was found after the orchestrator's own precondition list
missed it.)*

## D-2 — One resolver for the lock and the data it protects

`getIndexDir`, `getIndexDbPath`, `getVectorStorePath`, `ensureProjectDir`, `getDocsCachePath`
and the three formerly hardcoded resolvers all route through `resolveStoreLocation`. A sweep
asserts every entry point resolves one directory.

**Why it is an invariant, not a tidiness measure.** A lock whose path comes from one resolver
and data whose path comes from another means two processes that disagree about
`MNEMEX_INDEX_DIR` write **one store under two different locks** — the exact failure the lock
exists to prevent, through a different door. `docs refresh` was a fourth unlocked LanceDB writer
that the original inventory missed.

**Rule for new code:** anything that opens the store resolves its path from the seam. A new
resolver is a defect even when it returns the right answer today. *(I-8)*

## D-3 — Branch membership is a `Utf8` column matched with `LIKE`

`branchIds` holds comma-sentinelled registry ids (`,1,7,`). The bitmask and `List<Int32>`
encodings were rejected **on measured data**, not on taste.

| Rows | bigint mask vs `LIKE` | `array_has` vs `LIKE` |
|---|---|---|
| 1 027 (live dataset) | 1.03 — tie within noise | 1.04 — tie |
| 20 000 | 0.97 vector / 0.92 FTS | tie |
| 50 000 | 0.95 vector / 0.88 FTS | tie |

Recall is exact for every encoding at every size. So `LIKE` ties at the size that exists and
loses by 3–12 % at 20–50k rows. Against that the mask costs a **hard ceiling of 63 branches**
(Zoekt's 64-branch cap, the constraint the design deliberately steered away from), a
silent-corruption path above 2^53, and an extra column rather than a replacement.

**Consequences that bind callers:** the predicate must use `escapeFilterValue`
(CLAUDE.md #22), and the sentinel commas are what make `,1,` never match `,11,`.

**Reversal cost:** a schema change and a second version bump.
**Revisit only if:** a real store exceeds ~20k rows **and** a filtered search is measured as a
user-visible bottleneck. *(I-6)*

## D-4 — Widening uses update-only `mergeInsert`, under five required mechanisms

Grouped `update` was the design's mechanism and is **rejected**. LanceDB 0.38 rejects `CASE`
inside `update`, so a grouped update costs one call — one version, one fragment — per distinct
membership value:

| Distinct memberships per 256-id batch | grouped `update` | `mergeInsert` |
|---|---|---|
| 3 | 924 ms · 113 versions · 118 fragments | 917 ms · 38 · 43 |
| 114 | **390 s · 4 198 versions · +1.2 GB** | 975 ms · 38 · 43 |

The count of distinct memberships grows with the number of branches and how far they have
diverged, so **the cliff is reached by exactly the users this feature exists for.**

Grouped `update` is also the *less correct* option: given a crash duplicate it leaves the two
copies divergent, while `mergeInsert` makes them converge. Read-modify-write is rejected as
delete-then-add — the non-atomic shape that silently lost rows in `updateUnitSummary`.

**The five mechanisms, each catching exactly one fault:**

| # | Mechanism | Catches |
|---|---|---|
| M1 | Build each source batch from DISTINCT ids, one row per id | the livelock: 256 ids read back as 257 rows put a duplicate in the source, and every retry throws |
| M2 | Compare rows read against distinct ids before merging | crash residue. Record it in DATA; never repair inline with delete-then-add |
| M3 | Per-batch existence check; a missing id is demoted to INSERT | a row that should exist and does not |
| M4 | `numUpdatedRows` must equal the rows that NEEDED changing, from the same read | anything the first three missed. A mismatch is an integrity error, never ignored |
| M5 | One `optimize()` at the end of the drain | FTS coverage: rewritten rows leave the index and filtered FTS slows from 0.7 ms to 60–72 ms |

**Two facts that bind other code:**
- Rows outside the FTS index *are* still returned by `fullTextSearch` (982/982). But
  **`fastSearch` returns 0 of them, so `fastSearch` must never be used on a path that must see
  widened rows.**
- Vectors stay bit-identical through `mergeInsert` (0 of 20 000 differ, including −0 and
  subnormals). A raw Arrow `Vector` must pass through `toPlainVector` before write-back.

*(I-7 FINAL, superseding the provisional I-7.)*

## D-5 — Four cases decide whether a table carries `branch_id`

This is the most reusable rule in the build. **Any new table must be placed in one of these four
cases, and the DDL comment must say which.**

| Case | Key | `branch_id` | Example |
|---|---|---|---|
| Content-derived id that repeats across branches | `(branch_id, id)` composite | yes, caller-supplied | `symbols.id = sha256(path:name:kind:line)` |
| Surrogate id, already unique table-wide | unchanged, single-column | yes, plus branch-**leading** secondary indexes | `symbol_references.id AUTOINCREMENT` |
| Rows not tree-scoped at all | unchanged | yes, always the literal `BRANCH_ID_SHARED` | `indexed_docs` — a package's docs do not differ by branch |
| Rows that describe **rows**, not trees | unchanged | **none**, and the DDL comment must say why | `chunk_index` |

Two traps behind the table:

- **A composite key on a surrogate id breaks it silently.** SQLite assigns `AUTOINCREMENT`
  values only to a *single-column* INTEGER PRIMARY KEY. The design's literal DDL for
  `symbol_references` gave every row `id NULL`, and `resolveReference(refId)` then matched nothing.
- **Re-keying without scoping every statement in the same change turns `WHERE id = ?` into a
  scan.** Two such statements were measured running N times inside one `BEGIN IMMEDIATE` — a
  heartbeat hazard, not just a slow query. An unscoped `WHERE path = ?` under the
  `(branch_id, path)` key costs 2.5 ms at 20 000 rows against 0.003 ms scoped, which is why
  `idx_files_path` exists.

**An exclusion with no stated reason is indistinguishable from an oversight**, which is why
case four carries a documentation requirement rather than just an exemption.
*(I-12 Ruling 1, I-13, I-15.)*

## D-6 — On an unknown branch, search returns a flagged superset; the graph returns empty

The two halves of the tool answer different kinds of question, so they fail differently.

- **`search` RETRIEVES.** A superset is a wider net over the same kind of answer. Every row is a
  real chunk of real code and the caller can still judge it. So: drop the filter, return
  everything, set `branchUnknown`.
- **`symbol`, `callers`, `callees`, `context`, `map`, `dead-code`, `test-gaps`, `impact`
  ANALYSE.** Their answers are computed *over* a row set. Pooling rows from several branches
  does not widen those answers, it **falsifies** them — the result describes a graph that exists
  on no branch. A symbol dead on every branch separately can have callers in the union; a symbol
  dead in the union can have callers on yours.

So the unknown-branch answer for the graph is the **empty graph**, which is the truthful one.

**An empty result fails invisibly, so emptiness must always be narrated.** An empty
`mnemex dead-code` on a fresh branch looks exactly like a clean repository. Every command in
that list must, when the branch is unknown or empty, say so and name the command that fixes it
— in human output **and** as a field under `--agent`. Pinned as V3.21, with the falsifier:
neuter the surfacing and a fresh-branch `dead-code` must become indistinguishable from a clean
one.

Two states are distinguished, because they have different causes and different remedies:
`branchUnknown` (the registry has never seen this branch) and `branchEmpty` (registered, holds
no rows — what a `--force` or a partial sweep creates). *(I-13, I-16, I-17.)*

## D-7 — A row id and a reference live in different namespaces

`code-unit-extractor.ts` built a unit id from `filePath:unitType:name:startRow` and hashed **no
content**. §4.1.1 licenses widening on an id match because "chunk ids are content+position
addressed" — true of chunks, false of code units.

**The consequence was a violation of the feature's core criterion.** Two branches with different
bodies for the same function at the same start line produced ONE id, therefore one row,
therefore one body. The branch that indexed last decided what every other branch saw.

| Key | Carries | Why |
|---|---|---|
| The unit's **row id** | path, type, name, start row, **content hash** | Identity. Two revisions must coexist as two rows so each branch points at its own. |
| The **parent link** | path, type, name, start row — no content | Reference. It must stay stable under an edit inside the parent. |

**The general rule, which is stronger than the specific fix:** once a row id carries content,
anything that stores a row id as a *link* decays the moment the content changes. This rot
already existed — on the pre-change tree a fresh index gave `dangling=0` and one in-place body
edit gave `dangling=2 of 6`. The id change did not create it; it made it visible and forced the
fix. The split must be applied to the **file unit** as well, not only to AST units: the file
unit's id hashes `fileHash` and it is the parent of every top-level unit in the file.
Omitting it gave 3 of 6 dangling links in a *fresh* index.

`CURRENT_INDEX_VERSION = 5` (`src/core/index-version.ts:124`) rather than 4, so a pre-change v4
store cannot meet the new ids as tier-1 misses and strand the old rows. Cost to users: zero —
everyone rebuilds once on upgrade regardless of the target number.

**A caveat for whoever builds on the unit hierarchy.** It is dead machinery. `getChildUnits` is
called only from `enhanced-retriever.ts` inside `getUnitChildren`, whose only occurrence in the
tree is its own definition; `BottomUpSummarizer` is constructed nowhere outside its own module.
Using it is *reviving code that has never run in production*, not using existing infrastructure.
*(I-14 and I-14 CORRECTED — the ruling stands, both of the orchestrator's stated reasons for it
were wrong, and the corrected reason is the one above.)*

## D-8 — NFR-5 is corrected, not met: order can change across branches, the result set cannot

**The original promise:** *"search results must not change for a single-worktree, single-branch
user, beyond the branch filter."*

**Measured at repository scale** — 26 288 rows, three real worktrees, the shipped binary:

| Case | Result |
|---|---|
| Single-branch store — NFR-5's literal subject | `mean=0.000 max=0`, 20/20 lists identical |
| A second branch adding **no** rows | `mean=0.000 max=0`, 20/20 identical |
| A second branch adding **350** rows | branch 1's BM25 scores change in **1 098 of 1 098 cells, up to 37.2 %**; 14/20 lists identical, 5/20 sets changed |

**No amount of pre-filter work closes this.** BM25 is corpus-**global**: term frequency and
average document length are properties of the whole index. A branch pre-filter governs which
rows are RETURNED; it cannot govern which rows the STATISTICS come from. The trigger is the
INSERT of another branch's rows, not the widening rewrite — proven by the falsified FTS-rebuild
hypothesis (a bit-identical reading) and by 0 of 1 200 score cells moving when all 26 288 rows
were rewritten.

**Accepted, for three reasons in order of weight:**

1. The ordinary user is untouched, and that is measured, not assumed.
2. It is the trade already chosen one layer down. "Record branch per row, filter at query time"
   means one shared store, therefore one shared corpus, therefore shared corpus statistics.
3. The alternative undoes the feature. Branch-local statistics need N FTS indexes at N times the
   build cost and storage — reintroducing exactly the per-branch cost this work removes, to fix
   an effect on result ORDER while result SET correctness is already guaranteed.

**NFR-5's replacement text:** *a single-branch store's ranking is unchanged; in a store shared by
several branches, another branch's content participates in corpus statistics, so result ORDER
can change while the result SET remains branch-correct.*

**What must NOT ship:** the design's pre-written carve-out at §4.4.3. Its clause "no result is
added or removed by this effect" is **false as measured** — `max=20` is a result leaving the top
20 and another entering. Filling a number into that drafted wording would put a false statement
in the release notes.

**Reversible, and the cheapest thing in the build to revisit** — it is a promise and a release
note, not a mechanism. *(I-22.)*

## D-9 — Destructive commands are branch-scoped by construction

`--force` destroyed **every** branch's rows: `clear()` is a `DELETE FROM` over seven tables and
drops the whole LanceDB table. The failure was silent — the destroyed branches are still in
`branches.json`, so a real id resolves and `branchUnknown` never fires. The user switches back
and gets an empty search with no signal.

It was live **before** the store moved: one worktree that has indexed two branches already holds
both.

- `--force` → `narrowBranch`: drops only this branch's membership, leaving rows other branches
  still hold.
- `--force-all` → the deliberate whole-store case.
- `mnemex clear` had the same gap **and took no store lock** — a local mistake on a per-worktree
  store, an unlocked destructive command on a store another worktree may be indexing once the
  store is shared. It resolves through the seam and takes the lock.

**`clear()` also left a split-brain symbol graph:** `symbols`, `symbol_references` and
`graph_metadata` are not among the seven tables it empties, so `map` could answer from rows
`search` could not see.

**Flags are parsed against a strict table, never by membership.** `--force` / `--force-all` is a
destructive pair with a shared prefix — the worst possible shape for a membership test
(CLAUDE.md #30). The near-miss suggester must use longest-shared-prefix: `--force-alll`
originally suggested `--force`, which is *the other destructive command*, not the one being
typed. Note the flag table was built **by search over `src/`, not from the help text** — three
internal callers pass `--quiet`, `--if-idle` and `--files`, and a table derived from the
documentation would have killed every background reindex on day one. *(I-16, I-17, I-20.)*

## D-10 — Each summary is bought once per content, not once per branch

Before this, the first index of every branch re-enriched the whole tree — a real LLM bill,
invisible to any criterion that counts embeddings only. `enrichment_by_content`
(`src/core/tracker.ts:841`) keys summaries on content, so a second worktree makes **zero** LLM
calls for content the team has already summarised. That assertion is the falsifier for the
mechanism.

This is the user's stated problem in the most expensive currency the tool spends. Sharing
embeddings while re-buying every summary per branch would have answered only the cheap half.
*(I-15.)*

## D-11 — MCP memories: the double-join is fixed, stranded memories are reported and never moved

At `HEAD` the MCP directory was built as `join(workspaceRoot, MNEMEX_INDEX_DIR ?? ".mnemex")`.
For an **absolute** value that double-joins: `join("/ws", "/abs")` is `/ws/abs`. So a user with
an absolute `MNEMEX_INDEX_DIR` has always had memories written to `/ws/abs/memories`, and now
reads them from `/abs/memories`. Relative values, no value, and `ProjectConfig.indexDir` users
are unaffected.

Memories are "authored and cannot be rebuilt", so: at MCP startup, if the legacy double-joined
directory exists, differs, and holds memories, **warn once**, naming both paths and the single
recovery command. **No data is moved or deleted.**

An automatic migration was rejected: migration code is new machinery, and new machinery produced
a CRITICAL in every review round of this build. Keeping the double-join for memories only was
also rejected — preserving a known bug to avoid a visible one.

**The warning goes through the MCP logger, never stdout.** Stdout is the MCP protocol channel
(CLAUDE.md #14). *(I-9.)*

## D-12 — Local search includes uncommitted work through a per-worktree overlay, merged before fusion

*(Step 3, R3. Session `dev-feature-step3-ranking-overlay-20261001-115855-a33fe887`, architecture
§5 and revision 1; CLAUDE.md #33.)*

Before step 3 the overlay existed only behind the cloud gate (cloud + team + auth), and local
search never saw uncommitted work. Now every local search surface — CLI `search`, MCP
`search_code`, MCP `search` (its `SemanticBackend` switched to `searchScoped`), the TUI — runs one
overlay pass inside `Indexer.searchScoped`, after the query is embedded. User decisions: automatic
when the worktree is dirty; off with `--no-dirty` or `dirtyOverlay: false` (project over global);
dirty = modified tracked + untracked-not-ignored, deleted files suppress only.

**Where it lives.** `<worktreeDir>/dirty-overlay` (`getDirtyOverlayDirFor`), its own LanceDB store,
manifest and lock. Per worktree by construction and never inside the shared git-common-dir store
(D-1, R3.6/R3.7); one resolver for the data and its lock (D-2), swept by S-L.

**"Dirty" is relative to the index, decided by content hash.** Candidates are git's porcelain
listing (run with `--no-optional-locks`, so a search never competes for `index.lock`) plus the
overlay's watch set plus tracker rows indexed after its high-water mark, restricted to the
indexer's own file selection. Each is classified against the tracker by SHA-256 of the disk bytes.
Tracker `mtime` is never consulted, and the indexer now hashes the bytes it chunks (P-E1), because
the hash is the only currency proof.

**One suppression rule.** An index row of a path is pre-filtered out (`NOT (pathKind = 'repo' AND
filePath IN …)`, in the same `filters` array as the branch predicate, so it is a PRE-filter on both
retrievers, D-6's reasoning) only when the overlay serves that path or the file is gone. Session
observations (`pathKind: 'synthetic'`) are never suppressed. Every overlay failure — git, lock busy
or lost, embedding refused after the query, corrupt overlay table, budget, file too large — leaves
the index rows visible and is reported (`overlay=skipped`, `overlay_reason`, `overlay_gaps`,
`overlay_gap_details`).

**Merged before fusion, never after.** The cloud's `OverlayMerger` min-max-normalises each list
separately and put 34 dirty chunks into 57.5 % of a top-10 (D-MERGE). Locally, overlay vector rows
join the index's vector list by raw `_distance` (same metric, same model as the index AND the query
— the overlay embeds with the raw client that embedded the query, identity = what that client was
built with); unchanged overlay chunks borrow their index twin's BM25 score through one calibrated
FTS query on the index, paired one-to-one; then `typeAwareRRFFusion` runs unchanged. A sweep (M-5)
keeps `OverlayMerger` off every local path.

**Gated at the index list's edge (iteration 2, F2; amends §5 Merge).** "Concatenated with the
index's vector list, ordered `(_distance asc, id asc)`, cut at `fetchLimit`" became: overlay rows
STRICTLY better than the index channel's edge, concatenated, ordered, cut at `fetchLimit`, tie
tail trimmed — on both the vector and the calibrated BM25 channel. The edge (`retrieverEdge`) is
the last score of an engine list the engine filled, `null` when it came back short. Cause: each
index list is trimmed by THRESHOLD (`trimIncompleteTieTail` drops the tie group straddling
`fetchLimit`), so a full list ends shorter than `fetchLimit`, and the count cut refilled the freed
slots with the overlay's best rows however distant — compared against index rows the engine never
fetched. Measured on a real store: an unchanged chunk whose index twin sat at vector rank 1742 took
rank 29, result #8 of 10; across 40 lists, 5 overlay rows were admitted past the edge, and all 5
were "poor" ones. The argument "both sides cut at the same depth" held in COUNT, not in COVERAGE.
With the gate, an unchanged overlay chunk sits exactly at its twin's clean position (5/5 on the
rig; MG-3/MG-4 in `overlay-merge-gate.test.ts`). Index rows are never gated, so the index
channel's membership equals the suppressed index list. A rank comparison against the index must
use a reference at the SAME `--limit`: channel depth is `3 × limit`.

**Cost.** Rebuilt per file through the machine-global embed cache (only changed text reaches the
provider), under its own lock (never the store or global lock), budgeted (8 s rebuild, 512 KiB per
file, 2 000 candidate files), `optimize({ retentionMs: 0 })` after a writing pass so versions do not
accumulate. A clean worktree costs one `git status` and takes today's code path statement for
statement (NFR-2, pinned by a snapshot frozen before the refactor).

**Contracts.** `BranchScopedSearch.overlay` is always present. `--agent` always emits the 15
`overlay*` header keys and ` source=dirty` per overlay row (before ` summary=`); MCP responses carry
an `overlay` block and `source: "dirty"` rows. `overlay_gaps` / MCP `overlay.gaps` is a CLOSED set
of machine tokens (`OVERLAY_GAP_TOKENS`, `[a-z0-9-]+`, each once); every path, count, error
message and provider JSON body goes to `overlay_gap_details` / MCP `overlay.gapDetails`
(`{token, path?, message}`, one per event) — iteration 2, O4, which narrowed the VALUES of
`overlay_gaps` and added one key (none renamed). `overlay_embedded` counts provider-accepted texts
on every pass, budget-cut ones included (iteration 2, O3: the answered prefix of an aborted call is
counted and cached); overlay ids are kept out of feedback hints and the
`search_code` learning record. `mnemex rg` passes `overlay: "off"` (CLAUDE.md #14). Search flags
are strict (`--no-dirtyy` exits 1 and runs nothing), with the accepted set derived by search over
every real caller (CLAUDE.md #30).

**Reversal cost:** low. `--no-dirty`/`dirtyOverlay: false` turn it off; deleting
`<worktreeDir>/dirty-overlay` costs one rebuild of the changed files (cache hits).

## D-13 — A symbol is compared with a result in STORED spelling, inside the tracker (the R1 seam)

*(Step 3, R1; orchestrator ruling 1 in the step-3 architecture. Fixes I-23 — see "Open" below.)*

The dead-code penalty must find a result's symbol in the result's OWN file. Chunk paths leave the
store absolute (search output is a contract); symbol paths are stored repo-relative and leave the
tracker that way. The fix keeps BOTH output spellings and moves the comparison to the one place
that knows both: `BranchScopedGraph.getSymbolsByNameInFiles(keys)` converts each `filePath` with the
handle's own `storedPath` mapper and matches `(file_path, name)` in SQL, `branch_id = ?` on the
statement, ≤ 64 pairs per statement, one region. `applyDeadCodePenalty` picks the same-file symbol
by line overlap and applies **no** penalty when there is none; the `?? syms[0]` fallback is gone.

**Rejected: "symbols leave the tracker absolute"** (the text this document's release-blocker entry
originally proposed). The consumer census found 13 groups of `SymbolDefinition.filePath` consumers;
going absolute would change the `--agent` output of 8 commands (`symbol`, `callers`, `callees`,
`context`, `map`, `dead-code`, `test-gaps`, `impact` print repo-relative today, pinned through the
built binary) and flip `dead-code`/`test-gaps` verdicts (`test-detector.ts` matches `/test/` in
absolute paths), for ~25 compensating edits. The seam changes no output spelling anywhere.

**The rule it follows** (`repo-path.ts`'s contract): convert where a stored path is COMPARED, never
by changing what a reader returns. MCP `context` follows it too: an absolute argument now answers
(it returned nothing before); a bare filename falls back to a suffix match only when it is
unambiguous, and an ambiguous one answers nothing and names the candidates.

**Surfaced:** `penalty_lookups` / `penalty_same_file` / `penalty_applied` on every `--agent` search,
and ` penalty=dead` per demoted row — the penalty that matched 0 of 217 printed nothing.

**Label names (validation iteration 2).** A large type or function is chunked under a LABEL —
`X (fields)`, `X (part n/m)` — and after the twin collapse that label is often the only name a
result carries. The penalty resolves a label to `X` through the chunker's own label grammar (one
definition, `src/core/chunker.ts`), and still requires the symbol to overlap the chunk. The displayed
`name=` is unchanged. Measured on a real clone: 17 of 17 label-named dead symbols penalised, 0 before.

---

## D-14 — A symbol is never its own caller

*(Step 3, found by black-box test TEST-54, not by any white-box test.)*

The reference extractor captured every `type_identifier`, including the name in a type's own
declaration, so every type declaration — interface, type alias, class, Rust struct; exported or
not — was recorded as a reference to itself.
`in_degree` was therefore ≥ 1 for every type, and the dead-code rule (`inDegree === 0 &&
pagerank < 0.001`) could never fire for one. The self-edge also made a PageRank self-loop: an
unreferenced type scored 6.7× an unreferenced function. Two changes, each needed:

- `updateDegreeCounts` (`src/core/tracker.ts`) excludes self-edges from `in_degree`, branch-scoped
  as before.
- `extractReferences` (`src/core/symbol-extractor.ts`) skips a name only when it re-derives to a
  symbol extracted from the same file — an IDENTITY test, not a position test. A first version that
  matched on the declaration's line span dropped real references on one-line declarations
  (`export type User = api.User;`), which would have made `api.User` falsely dead; the identity
  test keeps them, pinned by TS, Go, Rust and C++ fixtures.

**User-visible:** `dead-code` can report unreferenced non-exported types and `--include-exported`
adds exported ones (119 more exported on this repository); the MCP dead-code tool and the search
penalty follow; `callers <Type>` no longer lists
the type itself; exported types lose inflated PageRank after the next rebuild, which shifts `map`
and search ranking. No index-version bump: the change rides the v5 rebuild every user already gets.

**Not changed, by decision:** a self-recursive function, or a type naming itself inside its body,
still is not reported dead — `dead-code` reads the callers list and the genuine self-loop keeps
PageRank high. Fixing that re-ranks every recursive symbol.

---

## Known limits — these belong in the release note

1. **Changing `indexDir` requires restarting any running MCP server.** The path memo does not
   watch config files on disk. This is deliberate: a running server holds open LanceDB tables, a
   SQLite connection and an index lock, all bound to the old path. Silently re-resolving
   underneath live handles would split reads and writes across two stores within one process —
   more dangerous than requiring a restart. Reversal: add the config files' mtimes to the memo
   key, at one stat per file per call. *(I-5.)*
2. **Layout changes under a long-lived process** (`git init`, `git worktree add/prune`) are not
   picked up until restart, for the same reason.
3. **Repository-discovery edge cases**, implemented to spec and listed so they are not
   rediscovered as surprises: a SHA-256 object-format repo's detached HEAD is 64 hex where 40 is
   expected, so it is classified `unknown` (a per-worktree bucket rather than a per-commit
   label); an empty `.git/` directory stops the walk where git's own discovery would continue;
   resolving from inside `<repo>/.git/...` classifies `<repo>/.git` as bare. *(I-4.)*
4. **Ranking order across branches** — see D-8.
5. **`optimize()` does not run after an ordinary file change**, so both the FTS fold-in cost and
   D-8's corpus shift land on the user's next **search**, not on their index run. Unchanged by
   this build; deserves its own decision. *(I-22.)*

**Step 3 (D-12, D-13) adds these:**

6. **Changed or new overlay chunks are vector-only in BM25.** An unchanged chunk of a dirty file
   borrows its index twin's BM25 score (one calibrated FTS query, paired one-to-one); a chunk whose
   text the index does not hold has no commensurable BM25 score (the overlay's own FTS index has
   its own IDF, ~4.5× inflated on common words — D-MERGE again), so it competes on vector distance
   alone. It can be under-ranked, never flattered. Index-statistics BM25 for overlay text is a
   follow-up, not built (step-3 ruling 4).
7. **Git-clean staleness that predates a worktree's first overlay pass is not detected (H9
   residual).** The overlay's candidates are git's dirty set plus its own watch set and the
   tracker's high-water mark, so content indexed before the first pass that git now calls clean —
   e.g. a `git pull` with no reindex — is not seen as stale. That is index-behind-working-tree,
   owned by `mnemex index`, `watch` and the hooks. Closing it needs a full-tree hash on the first
   pass, which would re-embed through the overlay after every pull. Not built, by decision.
8. **R3.11 was re-scoped: a QUERY-embedding failure still fails the search.** R3.11 covers failures
   of the overlay. With the endpoint fully down, the query cannot be embedded, and the index's own
   vector retriever needs that vector, so search fails exactly as it did before step 3 (pinned,
   I-2: exit 1, the provider's own "failed for all 1 texts" error). Degrading every search to
   keyword-only on a query-embedding failure would change the non-overlay path — a user decision,
   not taken. An endpoint that fails AFTER the query was embedded is covered: index results,
   `overlay=skipped overlay_reason=embed-failed` when the failure is provider-wide, or a per-file
   `failed(embed)` when one file's chunks were refused. "Provider-wide" (Phase 6, TEST-31): a
   file failed `embed`, the provider accepted zero texts in the pass, nothing was left pending,
   and the pass has nothing else to contribute — no file served from cache hits or an earlier
   build, no deletion to suppress. When it still has something, it stays `on` and lists each
   refused file, so a skip never discards a working overlay. `overlay_embedded` counts accepted
   texts only, and R3.8's gaps ride in `overlay_gaps`/MCP `overlay.gaps` as the tokens
   `no-symbol-graph`, `no-code-units`, `no-summaries`, `bm25-unchanged-chunks-only`. The overlay's embed calls make ONE attempt
   and are cancelled at the 8 s rebuild budget (code review 1, HIGH 1), so the client's retry
   ladder — still used by indexing and by the query embedding — cannot hold a search: a stalled
   provider costs the budget, measured 8.7 s end to end through `dist/index.js` (CLAUDE.md #33 d).
9. **Overlay rows carry no symbol graph, code units or summaries (R3.8).** The dead-code penalty
   does not judge them, and MCP `search`'s symbol-graph backend still returns the INDEXED lines of
   a dirty file's symbols (neither suppressed nor marked — dropping them would also drop symbols
   that still exist).
10. **Reference resolution attributes every same-named reference to ONE symbol.** Measured on a
    real clone of this repository: all 63 references to `SearchResult` resolve to the copy in
    `eval/`, although 12 `src/` files import the one in `src/types.ts`. So `src/types.ts`'s
    `SearchResult` is dead by the graph, and live functions such as `handleSearch` can be
    penalised. D-13 makes the penalty judge the right FILE; the graph's caller attribution is the
    next defect in the same family (resolve a reference to the symbol it actually imports).
    Pre-existing: identical in every build measured.

## Open items

### ~~Release blocker: symbol paths are relative, chunk paths are absolute~~ — FIXED in step 3 (D-13)

*Status (step 3, phase 1): **I-23 FIXED.** The text below is kept as the record of the defect;
"The fix" paragraph is corrected to what was built. Verified by an absolute check through the
built binary (`penalty_same_file` > 0, the live `get` unpenalised, a dead namesake penalised) and
by mutation falsifiers (the old comparison, the `?? syms[0]` fallback, a dropped branch
predicate, an absolute `rowToSymbol`).*

`src/core/indexer.ts:3382-3383`:

```ts
const sym = syms.find((s) => s.filePath === r.chunk.filePath) ?? syms[0];
```

The comparison succeeds **0 of 217 times**. The `?? syms[0]` fallback then penalises a result
using **a different file's** same-named symbol. Measured: 7 verdicts flip, 6 of 20 result lists
reorder, by up to 14 of 20 positions. Through the shipped binary, `get` in `embed-cache.ts`
(371 callers) is demoted from rank 9 to 16, and `SearchResult`, genuinely dead, escapes the
penalty entirely.

**This is a step 2 regression, not a step 3 feature.** The comparison is byte-identical at the
base commit `ec43ed8` — the code did not change, what each side *stores* did.
`storedPath()` (`src/core/tracker.ts:1897`) relativises on write; `rowToSymbol`
(`src/core/tracker.ts:4773`) returns `row.file_path` **verbatim** on read. Chunks got the
read-side conversion because search output must stay absolute; symbols did not.

**The fix, as built (D-13) — corrected from the text first written here.** This entry originally
proposed that symbols leave the tracker absolute. That was NOT built: the census showed it would
change the `--agent` output of 8 commands and flip `dead-code`/`test-gaps` verdicts. Instead the
comparison moved INTO the tracker: `BranchScopedGraph.getSymbolsByNameInFiles` converts the
result's path to stored spelling with the handle's own mapper and matches `(file_path, name)` in
SQL, branch-scoped. No output spelling changed anywhere. The hedge at `src/mcp/tools/context.ts`
(`s.filePath === file || s.filePath.endsWith("/" + file)`) is gone: `context` resolves its argument
through `getSymbolsByFile` (which converts), falls back to a suffix match only when exactly one
indexed file matches, and answers nothing — naming the candidates — when several do.

**The `?? syms[0]` fallback must go regardless.** A lookup that cannot find its subject must do
**nothing**, not act on a different subject. It converted a path mismatch into a wrong ranking
rather than a missing penalty, which is why it stayed invisible. *(I-23.)*

### Decisions owed to the user

1. **Session observations are destroyed by the upgrade rebuild**, and this release makes every
   user go through that rebuild once. Pre-existing — every whole-store rebuild already did this
   — but the `documents` schema calls observations "cannot be re-derived from source". Options:
   carry them across the rebuild, or accept it with a release-note line. **Shipped in 0.37.0
   without a carry-over; the loss is stated in the 0.37.0 upgrade notes in `CHANGELOG.md`.** A
   carry-over remains possible for a later release, but it can no longer save what 0.37.0 rebuilt.
2. **`mnemex hooks uninstall` reports success while leaving the hook live** when another tool's
   `post-commit` already existed. Pre-existing, on `main`.
3. **Something re-embeds this worktree through Voyage on every commit.** The evidence collected
   during the build points at the MCP server's auto-reindexer (`mnemex --mcp` →
   `mnemex index --quiet`), matched on the lock's `startedAt` to the second — not the post-commit
   hook, which an earlier note blamed. Both may run.
4. **`resolveReferencesByName` froze the heartbeat past 10 s** on mid-size repositories, on
   `main`, since v0.3.0. Fixed here in `4b08837`; reported because it affects the released
   version.

### Carried to step 3 — status

- **The twin `code_chunk` / `code_unit` pair** consumes two of the user's 20 result slots for one
  span — 49 of 400 slots, 12.3 %. Dedup must key on **span**, not content hash: only 528 of
  2 788 twins are byte-identical. *Step 3: built (R2) — span collapse before the `limit` cut on
  all three ranked paths, back-filled, `code_unit` in `DocumentType` with an explicit 0.1 weight;
  a nameless kept chunk carries its named twin's identity (ruling R2-A).*
- **The local dirty overlay** is cloud-only today; local search never reaches it. *Step 3: built
  for LOCAL search (D-12). The cloud path is unchanged — see D-MERGE below.*

### Open — owned by step 4: D-MERGE on the CLOUD path

The cloud search (`CloudAwareSearch`, reachable with cloud + team + auth) still merges its dirty
overlay with `OverlayMerger`'s independent min-max normalisation: measured, 34 dirty chunks took
**57.5 %** of the merged top-10 against 25 614 indexed rows and evicted 48 % of the index's own
top-10. Step 3 fixed this only on the local path (D-12), because cloud results arrive
**server-fused**: a candidate-level merge needs the server to return pre-fusion candidate lists,
which is a wire change (and CLAUDE.md #11's dual-header discipline applies). Step 4 (cloud
authorization) owns it. Until then `--agent` on the cloud path prints `overlay=unreported`, and a
sweep (M-5) keeps `OverlayMerger` out of every local search path.

### Resolved by step 3: the "two ranking defects"

They were cited in four documents and defined in none. Step 3 established its scope by
measurement instead: the two worth building were the dead-code path comparison (D-13) and the twin
dedup, both shipped. D-8's corpus-global BM25 leak stays accepted; the `limit * 3` candidate cut and
penalty-before-cut go to an eval in `../mnemex-bench/` before any `src/` change.

## Corrections owed to the design document

These are code-fixed but the **design text is still wrong**, and someone building from it would
reintroduce the defect.

- **§6.1 conflates abandonment with upgrade.** Store-relocation detection is gated on
  `isUpgrade`, so a store already at the current version **relocates silently** — no report, no
  `abandoned_store_dir`. §6.1's own expression needs no such gate. *(I-20.)*
- **§4.4.3's pre-written carve-out must not ship.** See D-8.
- **`store.ts` said `parentId` is "CONTENT-derived".** It never was. The comment's conclusion
  (scope the read) is right; its stated reason misleads anyone reasoning about identity. *(I-14.)*

---

## Rules this build established that outlive the feature

Three are already in `CLAUDE.md` (#31 the embedding cache, #32 parameter bivariance and blind
sweeps, #17 the Arrow trap). Two are not, and belong here:

**A differential measurement cannot see a constant error.** This build measured ranking three
ways and all three compare a list against another list *from the same instrument*. A defect
present in both readings cancels out. **Nothing in the build measured whether the ranking was
RIGHT, only whether it CHANGED** — which is how an always-false comparison survived a release
gate. Any ranking work needs at least one **absolute** check.

**Re-derive a list by searching the design; never inherit a summary's table.** Four times a list
the orchestrator wrote lost something the design already contained — §4.6 enrichment reuse, §4.5
`--force` scoping, §6.1's silent-relocation case, and `edit-history/`. Three of the four were
real defects that would have shipped owned by no phase. Every one was caught by the same
instruction. It is not a courtesy to the implementer; it is the control that compensates for a
summariser who cannot see what the summary dropped.

**Black-box tests written from the requirements alone find what white-box tests cannot.** Step 3's
56 black-box tests drove the built binary against real git repositories and never read `src/`.
They found four defects a green white-box suite had missed: prose where the `--agent` contract
promised tokens, a provider-wide refusal reported as a working overlay, an overlay counter that
over-reported, and D-14's self-caller. A real-provider rig on a real clone then found two more that
both suites missed (label-named twins escaping the penalty; a count-based merge cut admitting
distant overlay rows into slots the index's tie trim had left empty). Each layer of evidence
caught what the one before could not.

**Where work must survive an interruption, put it somewhere git owns.** A snapshot in a
session-scoped scratch directory is exactly as durable as the session. When the scratch
directory was cleared mid-build, the git index was the only holder that survived — it kept a
finished phase byte-for-byte separable across a locked signing key and a session resume.

---

## What stayed in the session record, and why

Left out of this document because it informed that session only:

| Entry | Why it stays |
|---|---|
| I-1, I-10, I-12 Ruling 4, I-15's phase assignments | Phase sequencing. The substance shipped; the ordering is history. |
| I-2, I-3 | Implementation detail of the path memo. Its user-visible consequence is limit 1 above. |
| I-7 PROVISIONAL | Superseded by I-7 FINAL (D-4). |
| I-11 and I-11 REVERSED | Resolved into CLAUDE.md #17. The round trip is history. |
| I-18 | Two test files held raw NUL bytes. Deliberate uses, wrong spelling, fixed. Not a correctness or security finding. |
| I-19 | Two phases share one commit because the signing key locked for hours. History, recorded so the commit log is not read as carelessness. |
| I-21 | A liveness test sat at 92 % of its default timeout and was misfiled as load-sensitive. The fix and its reasoning are in the test file's own header. |

The build's full session record (the rejected options, the raw measurements, the per-phase logs)
was gitignored by `.gitignore:75` and was not carried into the repository. It is not needed to
read this document: every entry above states its decision and the measurement that decided it.
