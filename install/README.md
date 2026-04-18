# install/

Contains the public installer shell script that bootstraps the
`syncengine` CLI from a GitHub Release tarball.

## What lives here

- `install.sh` — curl-friendly installer. Detects platform, pulls the
  matching binary from the `REPO` GitHub Release, drops it in
  `$HOME/.syncengine/bin/`, and prints a PATH update for the user's shell.

## How it's hosted

For the `curl | bash` flow to work, this script has to be reachable over
HTTPS at a stable URL. Two options:

1. **GitHub raw** (zero infra): point users at
   `https://raw.githubusercontent.com/<org>/<repo>/main/install/install.sh`.
   Works immediately but ties the URL to the repo path.
2. **Your domain** (CNAME to GitHub Pages or a CDN): e.g.
   `curl -fsSL https://syncengine.dev/install | bash`. Nicer URL,
   needs DNS.

The `REPO` placeholder in `install.sh` gets its value at release time —
see `.github/workflows/release.yml`.

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
