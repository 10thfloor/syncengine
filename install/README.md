# install/

Contains the public installer shell script that bootstraps the
`syncengine` CLI from a GitHub Release tarball.

## What lives here

- `install.sh` — curl-friendly installer. Detects platform, pulls the
  matching binary from the `REPO` GitHub Release, drops it in
  `$HOME/.syncengine/bin/`, and prints a PATH update for the user's shell.

## How it's hosted

Served via GitHub Raw, zero infra:

```bash
curl -fsSL https://raw.githubusercontent.com/10thfloor/syncengine/main/install/install.sh | bash
```

We can front this with a CNAME (`install.syncengine.dev` → GitHub Pages
or a CDN) later if we want a nicer URL; for now the raw URL is the
public install endpoint.

## Testing locally

```bash
bash -n install/install.sh                 # syntax check
SYNCENGINE_INSTALL=/tmp/se bash install/install.sh   # dry run into /tmp
```

## Related

- `packages/cli/scripts/compile-all.ts` — cross-compiles the binary the
  installer downloads.
- `.github/workflows/release.yml` — on tag push, attaches the
  per-platform tarballs to a GitHub Release.
