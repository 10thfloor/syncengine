# Releasing

Two artifacts ship on every release tag:

1. **The CLI binary** — cross-compiled for macOS/Linux/Windows, attached
   to the GitHub Release. Fetched by `install/install.sh`.
2. **The framework source tarball** (`syncengine-source-<version>.tar.gz`)
   — a curated snapshot of `packages/{core,client,server,vite-plugin,http-core,gateway-core,observe,dbsp-engine/pkg}`.
   Downloaded by the CLI on first `syncengine dev` (or eagerly by
   `syncengine init`) into `~/.syncengine/source/<version>/`.

We don't publish to npm or JSR — the framework is distributed with the
binary.

## Cutting a release

1. Bump `VERSION` in `packages/cli/src/version.ts`.
2. Update `CHANGELOG.md`: move entries from `[Unreleased]` under a new
   version heading dated today.
3. Commit: `chore(release): vX.Y.Z`.
4. Tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.

The tag push triggers `.github/workflows/release.yml`, which:

- Builds the DBSP WASM once (for the source tarball)
- Packages the source tarball and uploads it as an artifact
- Cross-compiles the CLI binary for 5 platforms in parallel
- Creates the GitHub Release and attaches every artifact plus a
  `SHA256SUMS` file covering all of them

The binary's compiled-in `VERSION` must match the tag — the CLI uses
it to locate the correct source tarball when bootstrapping a project
or syncing the cache.

## Consumer experience after release

**Install the CLI:**
```bash
curl -fsSL https://raw.githubusercontent.com/10thfloor/syncengine/main/install/install.sh | bash
```

The installer always fetches `latest`. Pin to a specific tag with
`SYNCENGINE_VERSION=vX.Y.Z ... | bash`.

**Scaffold a project:**
```bash
syncengine init my-app
cd my-app
pnpm install
pnpm dev
```

`syncengine init` writes `.syncengine/release` with the CLI's version,
downloads the source tarball if it isn't cached, and creates
`node_modules/@syncengine/*` symlinks into the cached source. Every
subsequent `syncengine dev` / `build` verifies those symlinks.

## Versioning

Pre-1.0: breaking changes can land on minor versions. They're called out
as `BREAKING:` lines in the `CHANGELOG`.

Post-1.0: SemVer. CLI version and source-tarball version are always
identical — a tagged release bundles one of each.

## What lives where

| Artifact | Storage | Produced by |
|---|---|---|
| CLI binary | GitHub Release asset | `.github/workflows/release.yml` `build` job |
| Source tarball | GitHub Release asset | `.github/workflows/release.yml` `source` job |
| SHA256SUMS | GitHub Release asset | publish job, over all artifacts |

Nothing else. No JSR, no npm, no Docker Hub.

## Troubleshooting

**Release workflow fails on one platform.** The matrix uses
`fail-fast: false`, so the other platforms still publish their
artifacts. Re-run the failing leg from the workflow UI; since the tag
already exists, the re-run just re-uploads the missing asset onto the
existing Release.

**`syncengine dev` can't find the cached source.** The CLI falls back
to downloading from the matching GitHub Release. If the release
doesn't exist yet for that version, the hint points you at the
Releases page.

**Installer can't find the binary.** Confirm the Release is marked
"Latest" on GitHub — pre-release tags don't resolve via the
`/releases/latest/` URL that `install.sh` uses. Toggle the flag on the
Release page, or pin `SYNCENGINE_VERSION` explicitly.
