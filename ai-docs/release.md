# Release playbook — mnemex

## Authority

- `.github/workflows/release.yml` — everything that happens after a `v*` tag is pushed:
  the four binary builds, the GitHub Release, the npm publish and the Homebrew formula.
- `scripts/build-binary.ts` — the one binary build. It compiles, re-signs every darwin
  binary ad hoc and fails unless `codesign --verify --strict` passes. The release workflow,
  the CI `binary` job and the `build:binary*` scripts all run it.
- `.github/workflows/ci.yml` — the pull-request gates, including the `binary` job, which
  builds and runs a native binary on Linux and macOS.
- `CHANGELOG.md` — the release notes, in Keep a Changelog shape, one `## [X.Y.Z] - date`
  section per release.
- `package.json` (`version`) and `package-lock.json` — where the version lives.

## Artifacts

One tag publishes three channels. "Released" means all three serve the new version:

- **GitHub Release** on MadAppGang/mnemex: the four `mnemex-{darwin,linux}-{arm64,x64}`
  binaries, plus `manifest.json` and `checksums.txt` (`scripts/generate-manifest.ts`).
- **npm** `mnemex`, published from `dist/` by OIDC trusted publishing (no token).
- **Homebrew** `madappgang/tap/mnemex`: the `update-homebrew` job rewrites
  `Formula/mnemex.rb` in MadAppGang/homebrew-tap from the release's `checksums.txt`.

## Stages

None. A tag publishes every channel at once, and there is no pre-release channel. A tag
containing `alpha` or `beta` marks the GitHub Release as a prerelease and does nothing else.

## Dependencies

1. **Lockfile:** `bun install --frozen-lockfile` (the `ci.yml` gate).
2. **Internal lockstep:** `package.json` and `package-lock.json` carry the version
   together. `npm version X.Y.Z --no-git-tag-version --ignore-scripts` moves both.
3. **External:** the magus `mnemex` plugin pins a release tag and its four digests, with
   `bun scripts/pin-release.ts --plugin mnemex --requirement mnemex --version X.Y.Z
   --checksums checksums.txt` in magus-src. A mnemex release reaches magus users only when
   that pin moves and the magus plugin is released. The workflows pin Bun's version, and
   the build re-signs darwin binaries because Bun 1.4.0 leaves `bun build --compile` output
   with a stale signature (measured 2026-10-07: a hello-world compile reproduces it).

## CI/CD

`release.yml`, on a pushed `v*` tag. Its soft-fail shapes:

- **`update-homebrew` skipped.** The job runs only when the repo variable
  `ENABLE_HOMEBREW` is `true`. When it is not, the run is green and Homebrew still serves
  the previous version. Check the job's conclusion: `skipped` is a failure here.
- **A macOS binary that cannot start.** The GitHub macOS runner executes a binary with an
  invalid signature, so the smoke test passing proves nothing about the signature. Only
  `scripts/build-binary.ts`'s `codesign --verify --strict` catches it. `bun-darwin-x64` is
  cross-built on an arm64 runner and is never executed.
- **The asset list lags.** Right after the release job, `gh release view` listed three of
  the four binaries (2026-10-07). Read the asset list again before treating one as missing.

## Deploy monitoring

None. mnemex is a CLI and a library. Nothing here runs as a service.

## Verification

- `git ls-remote --tags origin 'refs/tags/vX.Y.Z^{}'` → the merge commit.
- The `Release` run for the tag: every job `success`, `update-homebrew` and `publish-npm`
  included (not `skipped`).
- `gh release view vX.Y.Z --repo MadAppGang/mnemex`: not a draft, and six assets.
- `npm view mnemex version` → X.Y.Z.
- `Formula/mnemex.rb` in MadAppGang/homebrew-tap carries `version "X.Y.Z"`.
- On an Apple Silicon Mac: the published `mnemex-darwin-arm64` passes
  `codesign --verify --strict` and `--version` exits 0. This is the check that failed
  silently from v0.33.0 to v0.36.1.

## Rollback

- **Pushed tags and GitHub Release assets:** fix forward only. Never replace an asset
  under a published tag: the magus plugin pins each asset's digest, and Homebrew pins
  the formula's.
- **npm:** `npm deprecate mnemex@X.Y.Z "<reason>"`, then release X.Y.Z+1. Move
  `latest` back with `npm dist-tag add mnemex@<last-good> latest` if installs must stop now.
- **Homebrew formula:** the next release rewrites it. A hand edit to the tap is
  overwritten by the next `update-homebrew` run.

## Decisions

- Releases so far follow one shape: a `release/vX.Y.Z` branch whose last commit is
  `chore(release): X.Y.Z` (version plus CHANGELOG), a PR titled `release: vX.Y.Z …`, a
  merge commit, and an annotated `vX.Y.Z` tag on that merge commit, pushed as an explicit
  ref (PRs #17, #19).
- Who authorises a release: `unknown`. TODO: the owner records whether an agent may merge
  and tag on its own, as it did for v0.36.2 on 2026-10-07.

verified: 2026-10-07 @ 3f9cd85
