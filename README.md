# Florin

Portable database **connections + query library** for VS Code, synced across your machines via your VS Code (GitHub) account. Passwords stay in the OS keychain, never synced, never in git.

## Why
Beekeeper's connection sync is a paid feature; SQLTools has no "import from URL" and its config is not cleanly portable. Florin keeps *your* connections and queries with *your* account, so they follow you across machines, environments, and jobs, owned by you.

## How the sync works
- Connection metadata + the query library are stored in the extension's `globalState`, opted into **VS Code Settings Sync** (`setKeysForSync`), so they ride your account.
- Passwords are stored in the OS keychain via `SecretStorage`, which deliberately does not sync.

## v0 (current)
- `Florin: Add Connection from URL` , paste a `postgresql://user:pass@host:port/db` URL; the connection is stored (metadata synced, password in keychain).
- `Florin: List Connections`.

## Roadmap
- Query library organized by connection / environment (synced).
- Run queries (delegate to SQLTools first, then an optional bundled driver).
- Additional drivers (MySQL, etc.).

## Develop
```bash
npm install
# then press F5 in VS Code to launch the Extension Development Host
```

## License
MIT
