# Release playbook — mnemex

## Authority
- `.github/workflows/release.yml` — owns everything after the tag: binary builds and their smoke test, the GitHub Release, the npm publish, the Homebrew formula.
- `.github/workflows/ci.yml` — owns the pre-merge gates (typecheck, test, lint, build, compiled-binary start check) on every PR and on `main`.
- `package.json` `version` — the version. `package-lock.json` carries it too; the build embeds it, nothing else stores it.
- `CHANGELOG.md` — the release-intent record (Keep a Changelog). A release without an entry is not a release.
- `CLAUDE.md` gotcha #12 — the Homebrew tap's location.

## Artifacts
"Released" means all four of these serve the new version:
1. An annotated `vX.Y.Z` tag on `origin`.
2. A GitHub Release (not a draft) with the four platform binaries, `manifest.json` and `checksums.txt`.
3. The `mnemex` package on npm, with `latest` moved to it.
4. The Homebrew formula in `MadAppGang/homebrew-tap`, updated by CI while the repo variable `ENABLE_HOMEBREW` is `true`.

## Stages
none — one tag fires one workflow that publishes every channel. There is no prerelease channel in use; `release.yml` marks a tag containing `alpha`/`beta` as a GitHub prerelease, but npm still publishes it to `latest`, so do not use those suffixes without changing the npm step first.

## Dependencies
1. Lockfile: `bun install --frozen-lockfile` (CI runs it; a drift fails CI).
2. Internal lockstep: none — a single package. `landingpage/` and `vscode-extension/` version separately and are not released by this flow.
3. External prerequisites: none routine. Check open PRs that the release notes claim to include.

## CI/CD
Publisher: `release.yml`, on `push` of a `v*` tag. Order: `build` (4-target matrix) → `release` → `publish-npm` and `update-homebrew` in parallel.
Soft-fails this project can produce while the run shows green:
- `update-homebrew` is SKIPPED, not failed, when `vars.ENABLE_HOMEBREW` is not `true`. Check the job's conclusion, not the run's.
- The `bun-darwin-x64` artifact is built but never executed (the smoke test is skipped for that target by design).
Distinguish a real publish with `npm view mnemex version` and the tap's formula version, not the run colour.

## Deploy monitoring
none — mnemex is a CLI and MCP server installed by users; nothing is deployed to run as a service. Watching `release.yml` to completion is part of Verification.

## Verification
- Tag: `git ls-remote --tags origin refs/tags/vX.Y.Z` → one ref at the merge commit.
- Workflow: the `release.yml` run for the tag concluded `success`, and every job — including `update-homebrew` — concluded `success`, not `skipped`.
- GitHub Release: `gh release view vX.Y.Z` → not a draft, 4 binaries + `manifest.json` + `checksums.txt`.
- npm: `npm view mnemex@X.Y.Z version`, and `npm view mnemex dist-tags.latest` moved to X.Y.Z.
- Clean install: `npx -y mnemex@X.Y.Z --version` prints X.Y.Z.
- Homebrew: the tap's `Formula/mnemex.rb` declares X.Y.Z.

## Rollback
- Tag and GitHub Release: immutable once pushed — forward fix with a new version; never delete or move a pushed tag.
- npm: forward fix. To stop new installs of a bad version: `npm dist-tag add mnemex@<last-good> latest`, `npm deprecate mnemex@X.Y.Z "<reason>"`, then release X.Y.Z+1. Never unpublish without an explicit instruction.
- Homebrew: forward fix — the next release rewrites the formula; a manual revert commit to the tap is possible but unknown whether it has ever been done. TODO: confirm with the maintainer.

## Decisions
- Authorisation: the maintainer authorises each release, once, up front; after that the release command may merge, tag and let CI publish without stopping.
- Process observed in v0.36.0 and v0.36.1: a `release/vX.Y.Z` branch with one `chore(release): X.Y.Z` commit (`CHANGELOG.md`, `package.json`, `package-lock.json`), a PR, a merge commit on `main`, then an annotated tag on that merge commit.
- Commits are signed through 1Password's SSH agent (`commit.gpgsign`); a signing failure stops the release — never bypass it with `--no-gpg-sign`. Release tags are annotated but not signed (as `v0.36.1` is); `tag.gpgsign` is unset.

verified: 2026-10-05 @ 5064cae
