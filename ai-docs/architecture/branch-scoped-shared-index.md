# Branch-scoped shared index — architecture decisions

**Status:** Built and measured on `worktree-mutlilayer-support` (23 commits from `ec43ed8`). Not merged to `main`.
**Date:** 2026-09-28
**Amends:** NFR-5 (see D-8). **Corrects:** the feature's design document, §6.1 and §4.4.3 (see "Corrections owed").
**Traceability:** each entry names the implementation decision (`I-n`) it comes from, in
`ai-docs/sessions/dev-feature-repo-stable-dataset-20260911-233750-2f49f045/decisions-implementation.md`.
That file is gitignored and is the full record, with the rejected options and the raw measurements.
This document holds only what changes the architecture or the project state.

---

## Why this exists

One index store per repository, shared by every git worktree, with per-branch row membership.
The problem, in the user's words: *"I don't want 10 developers on the same team reindexing
everything every time for every change."*

Roadmap: **step 1** persistent embedding cache (shipped), **step 2** repo-stable dataset path
(this document), **step 3** local dirty overlay plus the ranking fixes (scoped, not built),
**step 4** cloud authorization (not started).

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

## Open — must be settled before this merges

### Release blocker: symbol paths are relative, chunk paths are absolute

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

**The fix:** symbols leave the tracker in the same spelling chunks leave the store — absolute —
so no caller can get it wrong. Every `SymbolDefinition.filePath` consumer changes with it. The
hedge at `src/mcp/tools/context.ts:51` and `:86`
(`s.filePath === file || s.filePath.endsWith("/" + file)`) is a caller coping with this exact
ambiguity and should become unnecessary and be removed.

**The `?? syms[0]` fallback must go regardless.** A lookup that cannot find its subject must do
**nothing**, not act on a different subject. It converted a path mismatch into a wrong ranking
rather than a missing penalty, which is why it stayed invisible. *(I-23.)*

### Decisions owed to the user

1. **Session observations are destroyed by the upgrade rebuild**, and this release makes every
   user go through that rebuild once. Pre-existing — every whole-store rebuild already did this
   — but the `documents` schema calls observations "cannot be re-derived from source". Options:
   carry them across the rebuild, or accept it with a release-note line. This is authored user
   data, so the choice is the user's.
2. **`mnemex hooks uninstall` reports success while leaving the hook live** when another tool's
   `post-commit` already existed. Pre-existing, on `main`.
3. **Something re-embeds this worktree through Voyage on every commit.** The evidence collected
   during the build points at the MCP server's auto-reindexer (`mnemex --mcp` →
   `mnemex index --quiet`), matched on the lock's `startedAt` to the second — not the post-commit
   hook, which an earlier note blamed. Both may run.
4. **`resolveReferencesByName` froze the heartbeat past 10 s** on mid-size repositories, on
   `main`, since v0.3.0. Fixed here in `4b08837`; reported because it affects the released
   version.

### Carried to step 3

- **The twin `code_chunk` / `code_unit` pair** consumes two of the user's 20 result slots for one
  span — 49 of 400 slots, 12.3 %. Dedup must key on **span**, not content hash: only 528 of
  2 788 twins are byte-identical.
- **The local dirty overlay** is cloud-only today; local search never reaches it.
- **The "two ranking defects"** are cited in four documents and defined in none. The phrase
  traces to a layering report that is on no disk in either checkout. **Step 3 must establish its
  own scope by measurement, not by looking for the lost report** — and the roadmap's "two" is an
  unsourced number, so finding one, three or none are all valid outcomes. D-8's corpus-global
  BM25 leak is a measured candidate with a rig and a falsifier already attached.

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

**Where work must survive an interruption, put it somewhere git owns.** A snapshot in a
session-scoped scratch directory is exactly as durable as the session. When the scratch
directory was cleared mid-build, the git index was the only holder that survived — it kept a
finished phase byte-for-byte separable across a locked signing key and a session resume.

---

## What stayed in the session record, and why

Kept in `decisions-implementation.md` because it informs that session only:

| Entry | Why it stays |
|---|---|
| I-1, I-10, I-12 Ruling 4, I-15's phase assignments | Phase sequencing. The substance shipped; the ordering is history. |
| I-2, I-3 | Implementation detail of the path memo. Its user-visible consequence is limit 1 above. |
| I-7 PROVISIONAL | Superseded by I-7 FINAL (D-4). |
| I-11 and I-11 REVERSED | Resolved into CLAUDE.md #17. The round trip is history. |
| I-18 | Two test files held raw NUL bytes. Deliberate uses, wrong spelling, fixed. Not a correctness or security finding. |
| I-19 | Two phases share one commit because the signing key locked for hours. History, recorded so the commit log is not read as carelessness. |
| I-21 | A liveness test sat at 92 % of its default timeout and was misfiled as load-sensitive. The fix and its reasoning are in the test file's own header. |

The full record, the rejected options and the raw measurements live in
`ai-docs/sessions/dev-feature-repo-stable-dataset-20260911-233750-2f49f045/` — 682 lines of
decisions, a 6 811-line implementation log, and two validation documents. That directory is
gitignored by `.gitignore:75`.
