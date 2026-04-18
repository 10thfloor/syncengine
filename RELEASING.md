# Releasing

Two artifacts ship on every release tag:

1. **The CLI binary** — cross-compiled for macOS/Linux/Windows, attached
   to the GitHub Release. Fetched by `install/install.sh`.
2. **The library packages** (`@syncengine/core`, `client`, `server`,
   `vite-plugin`) — published to **JSR only**. No npm.

Both are driven by the same tag push.

## One-time setup

- [ ] Claim the `@syncengine` scope on [jsr.io](https://jsr.io) under
      the maintainer account.
- [ ] Link the GitHub repo to that scope (JSR UI → Scope settings →
      Link GitHub). This enables the OIDC flow used by
      `.github/workflows/publish-jsr.yml` — no long-lived token needed.
- [ ] Confirm each `packages/{core,client,server,vite-plugin}/jsr.json`
      has the correct `name` and a `version` you're ready to publish.

## Cutting a release

1. Bump versions in the four `jsr.json` files (all four should match).
2. Update `CHANGELOG.md`: move entries from `[Unreleased]` under a new
   version heading dated today.
3. Commit: `chore(release): v0.X.Y`.
4. Tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.

The tag push triggers two workflows in parallel:

- **`release.yml`** — compiles the CLI for 5 platforms, packages each
  into a tarball/zip, attaches to the auto-created GitHub Release
  with a `SHA256SUMS` file.
- **`publish-jsr.yml`** — publishes each library package to JSR via
  OIDC.

## Consumer experience after release

- **CLI install:**
  ```bash
  curl -fsSL https://raw.githubusercontent.com/10thfloor/syncengine/main/install/install.sh | bash
  ```
  The script always fetches `latest`. Pin to a specific tag with
  `SYNCENGINE_VERSION=vX.Y.Z ... | bash`.

- **Library deps** (scaffolded by `syncengine init`):
  ```jsonc
  // package.json — JSR via npm-compat specifier, works on every
  // package manager.
  "@syncengine/core": "npm:@jsr/syncengine__core@^0.1.0"
  ```
  Deno / Bun users can swap in the native `jsr:@syncengine/core@^0.1.0`
  specifier by hand.

## Versioning

Pre-1.0: breaking changes can land on minor versions. We tag them in
the `CHANGELOG` as `BREAKING:` on the line so it's obvious.

Post-1.0: SemVer. CLI and libraries version together — a new CLI
release always implies new library versions, even when the diffs are
one-sided, so the whole stack stays in lockstep.

## What lives where

| Artifact | Registry | Driven by |
|---|---|---|
| CLI binary | GitHub Releases | `.github/workflows/release.yml` |
| `@syncengine/core` | JSR | `.github/workflows/publish-jsr.yml` |
| `@syncengine/client` | JSR | same |
| `@syncengine/server` | JSR | same |
| `@syncengine/vite-plugin` | JSR | same |
| `@syncengine/cli` (source) | nowhere — compiled into the binary | — |
| `@syncengine/*-bin`, `bin-utils`, `gateway-core`, `http-core`, `serve*`, `dbsp-engine`, `test`, `test-utils`, `observe` | nowhere — internal to the monorepo | — |

Internal packages are bundled into the CLI binary at compile time.
They aren't independently published because users never import them.

## Troubleshooting

**JSR publish fails with "slow types" errors.** `pnpx jsr publish`
enforces that every exported type is explicit — no inference-only
signatures at the public boundary. The workflow passes
`--allow-slow-types` to ship anyway; audit the warnings after
publish and add explicit return types over time. Slow types degrade
JSR's hosted type-doc browsing but don't affect runtime correctness.

**Release workflow fails on one platform.** The matrix uses
`fail-fast: false`, so other platforms still upload their artifacts.
Re-run the failing matrix leg from the workflow UI; the tag already
exists, so the re-run attaches the missing asset to the same Release.

**Installer can't find the binary.** Check that the Release is marked
as "Latest" on GitHub — pre-release tags won't resolve via the
`/releases/latest/` URL that `install.sh` uses. Flip the toggle in
the Release settings, or pin `SYNCENGINE_VERSION` explicitly.
