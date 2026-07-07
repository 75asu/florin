import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { ConnectionStore, Connection } from './store';
import { ExplorerProvider } from './tree';
import { QueriesProvider } from './queriesTree';
import { QueryConsole } from './console';
import { Vault } from './vault';
import type { FlorinNode } from './drivers/types';

const PROMPTED_KEY = 'florin.vault.prompted';
const PULL_THROTTLE_MS = 60_000;

interface QueryItem {
  kind?: string;
  group?: string;
  name?: string;
}

export function activate(context: vscode.ExtensionContext) {
  const vault = new Vault();
  const store = new ConnectionStore(context, vault);
  const explorer = new ExplorerProvider(store);
  const queries = new QueriesProvider(vault);
  const queryConsole = QueryConsole.get(store, vault, context.extensionUri);

  const refreshFromVault = async () => {
    await store.loadFromVault();
    explorer.refresh();
    queries.refresh();
  };

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('florin.connections', explorer),
    vscode.window.registerTreeDataProvider('florin.queries', queries),
    vscode.commands.registerCommand('florin.addConnectionFromUrl', () => addConnectionFromUrl(store, explorer)),
    vscode.commands.registerCommand('florin.refresh', () => refreshFromVault()),
    vscode.commands.registerCommand('florin.refreshQueries', () => queries.refresh()),
    vscode.commands.registerCommand('florin.openQueryItem', (node: { sql?: string }) => queryConsole.openWithSql(node?.sql ?? '')),
    vscode.commands.registerCommand('florin.renameQueryItem', (node: QueryItem) => renameQueryItem(vault, queries, node)),
    vscode.commands.registerCommand('florin.deleteQueryItem', (node: QueryItem) => deleteQueryItem(vault, queries, node)),
    vscode.commands.registerCommand('florin.previewTable', (node: FlorinNode) => queryConsole.openPreview(node)),
    vscode.commands.registerCommand('florin.renameConnection', (node: FlorinNode) => renameConnection(store, explorer, node)),
    vscode.commands.registerCommand('florin.deleteConnection', (node: FlorinNode) => deleteConnection(store, explorer, node)),
    vscode.commands.registerCommand('florin.newQuery', (node?: FlorinNode) => queryConsole.openForNode(node)),
    vscode.commands.registerCommand('florin.openSavedQuery', () => queryConsole.openSaved()),
    vscode.commands.registerCommand('florin.configureVault', () => configureVault(context, store, explorer, vault)),
  );

  // Adopt the vault at startup; otherwise prompt once (ever) for setup.
  if (vault.configured) {
    void refreshFromVault();
  } else if (!context.globalState.get<boolean>(PROMPTED_KEY)) {
    void context.globalState.update(PROMPTED_KEY, true).then(() => configureVault(context, store, explorer, vault));
  }

  // Keep the tree fresh with the vault when the window regains focus.
  let lastPull = 0;
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((s) => {
      if (!s.focused || !vault.configured) {
        return;
      }
      const now = Date.now();
      if (now - lastPull < PULL_THROTTLE_MS) {
        return;
      }
      lastPull = now;
      void refreshFromVault();
    }),
  );
}

const VAULT_PROMPT =
  'Florin can sync your connections and saved queries to a Git repo you own (e.g. your notes repo), so they follow you to every machine. ' +
  'Passwords always stay in your OS keychain , they are never synced. ' +
  'Point Florin at a repo, or keep everything on this machine only.';

async function configureVault(
  context: vscode.ExtensionContext,
  store: ConnectionStore,
  explorer: ExplorerProvider,
  vault: Vault,
) {
  const choice = await vscode.window.showInformationMessage(
    VAULT_PROMPT,
    { modal: true },
    'Choose Folder,',
    'Clone GitHub Repo,',
    'Keep Local',
  );

  if (choice === 'Choose Folder,') {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      title: 'Select a Git repo folder for the Florin vault',
      openLabel: 'Use this folder',
    });
    if (!picked?.length) {
      return;
    }
    await vault.setPath(picked[0].fsPath);
    await finishVaultSetup(store, explorer, vault);
  } else if (choice === 'Clone GitHub Repo,') {
    const repo = await vscode.window.showInputBox({
      title: 'Clone GitHub Repo',
      prompt: 'owner/repo or a full clone URL',
      placeHolder: '75asu/fieldnotes',
      ignoreFocusOut: true,
    });
    if (!repo) {
      return;
    }
    const parent = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      title: 'Where should the repo be cloned?',
      openLabel: 'Clone here',
    });
    if (!parent?.length) {
      return;
    }
    const url = normalizeRepo(repo.trim());
    const repoName = url.replace(/\.git$/, '').split('/').pop() || 'florin-vault';
    try {
      const dir = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Florin: cloning ${repoName},` },
        () => vault.clone(url, parent[0].fsPath, repoName),
      );
      await vault.setPath(dir);
      await finishVaultSetup(store, explorer, vault);
    } catch (err) {
      vscode.window.showErrorMessage(`Florin: clone failed. ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (choice === 'Keep Local') {
    await context.globalState.update(PROMPTED_KEY, true);
    vscode.window.showInformationMessage('Florin: keeping connections and queries on this machine only.');
  }
}

async function finishVaultSetup(store: ConnectionStore, explorer: ExplorerProvider, vault: Vault) {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Florin: setting up vault,' },
    async () => {
      await store.migrateIntoVault();
    },
  );
  explorer.refresh();
  const where = path.join(vault.repoRoot!, vault.subdir);
  if (await vault.isRepo()) {
    vscode.window.showInformationMessage(`Florin: vault ready at ${where}, syncing via Git.`);
  } else {
    vscode.window.showWarningMessage(
      `Florin: saving to ${where}, but it is not a Git repo, so nothing is pushed. Run "git init" and add a remote to enable sync.`,
    );
  }
}

function normalizeRepo(repo: string): string {
  if (/^(https?:\/\/|git@)/.test(repo)) {
    return repo;
  }
  return `https://github.com/${repo.replace(/\.git$/, '')}.git`;
}

async function renameQueryItem(vault: Vault, queries: QueriesProvider, node: QueryItem) {
  if (!node || node.kind !== 'query' || !node.group || !node.name) {
    return;
  }
  const name = await vscode.window.showInputBox({
    title: 'Florin: Rename Query',
    prompt: 'New name for this saved query',
    value: node.name,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Name cannot be empty'),
  });
  if (!name || name.trim() === node.name) {
    return;
  }
  await vault.renameQuery(node.group, node.name, name.trim());
  vault.scheduleSync(`florin: rename query ${node.group}/${node.name} -> ${name.trim()}`);
  queries.refresh();
}

async function deleteQueryItem(vault: Vault, queries: QueriesProvider, node: QueryItem) {
  if (!node || node.kind !== 'query' || !node.group || !node.name) {
    return;
  }
  const pick = await vscode.window.showWarningMessage(
    `Delete saved query "${node.name}"?`,
    { modal: true },
    'Delete',
  );
  if (pick !== 'Delete') {
    return;
  }
  await vault.deleteQuery(node.group, node.name);
  vault.scheduleSync(`florin: delete query ${node.group}/${node.name}`);
  queries.refresh();
}

async function renameConnection(store: ConnectionStore, explorer: ExplorerProvider, node: FlorinNode) {
  const conn = store.get(node.connectionId);
  if (!conn) {
    return;
  }
  const name = await vscode.window.showInputBox({
    title: 'Florin: Rename Connection',
    prompt: 'A friendly name for this connection',
    value: conn.name,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Name cannot be empty'),
  });
  if (!name || name.trim() === conn.name) {
    return;
  }
  await store.rename(conn.id, name.trim());
  explorer.refresh();
}

async function deleteConnection(store: ConnectionStore, explorer: ExplorerProvider, node: FlorinNode) {
  const conn = store.get(node.connectionId);
  if (!conn) {
    return;
  }
  const pick = await vscode.window.showWarningMessage(
    `Remove connection "${conn.name}"? Its saved password is deleted from the keychain too.`,
    { modal: true },
    'Remove',
  );
  if (pick !== 'Remove') {
    return;
  }
  await store.remove(conn.id);
  explorer.refresh();
}

async function addConnectionFromUrl(store: ConnectionStore, explorer: ExplorerProvider) {
  const raw = await vscode.window.showInputBox({
    title: 'Florin: Add Connection from URL',
    prompt: 'Paste a database connection URL',
    placeHolder: 'postgresql://user:password@host:5432/dbname?sslmode=disable',
    ignoreFocusOut: true,
  });
  if (!raw) {
    return;
  }

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    vscode.window.showErrorMessage('Florin: that does not look like a valid URL.');
    return;
  }

  const conn: Connection = {
    id: randomUUID(),
    name: `${url.username}@${url.hostname}/${url.pathname.slice(1)}`,
    driver: url.protocol.replace(':', ''),
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
  };
  const password = decodeURIComponent(url.password);

  // Metadata -> synced globalState + vault. Password -> OS keychain (never synced, never in git).
  await store.add(conn, password);
  explorer.refresh();
  vscode.window.showInformationMessage(
    `Florin: saved "${conn.name}" (${conn.driver} ${conn.host}:${conn.port}/${conn.database}). Password kept in keychain.`,
  );
}

export function deactivate() {}
