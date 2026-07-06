# Florin

A portable database workbench for VS Code. Browse your databases, run queries, and keep your **connections + saved queries** in a Git repo *you* own, so they follow you across machines, environments, and jobs. Passwords stay in the OS keychain, never synced, never in Git.

## Install (one command)

```bash
curl -fsSL https://github.com/75asu/florin/releases/latest/download/florin.vsix -o /tmp/florin.vsix && code --install-extension /tmp/florin.vsix
```

Reload VS Code. On first launch Florin asks where to sync (see below). Florin is distributed via GitHub Releases, not a marketplace, so there is no auto-update, re-run the command to upgrade.

## First run , pick your sync

A dialog offers three choices:
- **Choose Folder** , point Florin at a Git repo you already have (e.g. your notes repo). Florin writes into a `florin/` subfolder so it never litters the root.
- **Clone GitHub Repo** , give `owner/repo`; Florin clones it and uses it as the vault.
- **Keep Local** , skip syncing; connections and queries live only on this machine.

You can change this anytime with **Florin: Configure Vault (Sync)**.

## How sync works

Everything except passwords is stored as plain, browsable files in your repo:

```
<your-repo>/florin/
  manifest.json
  connections/<name>.<id>.json     # driver/host/port/user/db  ,  NO password
  queries/<group>/<name>.sql       # your saved query library
```

- On change (add/rename/remove a connection, save a query) Florin commits and pushes automatically.
- On window focus and startup it pulls the latest, so the vault is always the source of truth.
- It shells out to your own `git`, inheriting the repo's auth and identity. No tokens are stored.
- **Passwords** live in the OS keychain via `SecretStorage`. On a new machine the connection appears from the vault; you enter its password once and it is cached locally. Passwords are never written to Git or synced.

## What you can do

- **Add Connection from URL** , paste `postgresql://user:pass@host:port/db`; metadata is saved, password goes to the keychain.
- **Browse** connection , database , schema , table , columns (via `pg_catalog`, so it works regardless of grants).
- **Preview Rows** , right-click a table (or the eye icon) for a data grid.
- **Query console** , New Query opens a SQL editor with a results grid below; `Cmd/Ctrl+Enter` runs. **Save** files the query into your vault; **Open Saved Query** loads one back.
- **Rename / Remove** connections; give each a friendly name.

Postgres today; the driver layer is engine-agnostic so more engines can follow.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `florin.vault.path` | `""` | Git repo folder to sync to. Empty = local only. |
| `florin.vault.subdir` | `florin` | Subfolder inside the repo where Florin writes. |
| `florin.vault.autoSync` | `true` | Auto pull on focus and commit+push on change. |

## Develop

```bash
npm install
# press F5 in VS Code to launch the Extension Development Host
```

## License
MIT
