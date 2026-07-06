import * as vscode from 'vscode';
import { randomUUID } from 'crypto';

// A stored connection holds everything EXCEPT the password.
// The password lives in the OS keychain (SecretStorage), which never syncs.
interface Connection {
  id: string;
  name: string;
  driver: string; // e.g. "postgresql"
  host: string;
  port: number;
  database: string;
  user: string;
}

// The globalState key we persist connections under. We opt this key into
// VS Code Settings Sync, so it rides your account to every machine.
const CONNECTIONS_KEY = 'florin.connections';

function getConnections(context: vscode.ExtensionContext): Connection[] {
  return context.globalState.get<Connection[]>(CONNECTIONS_KEY, []);
}

// Backs the "Connections" view in the Florin activity-bar container.
class ConnectionsProvider implements vscode.TreeDataProvider<Connection> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(c: Connection): vscode.TreeItem {
    const item = new vscode.TreeItem(c.name, vscode.TreeItemCollapsibleState.None);
    item.description = `${c.driver} ${c.host}:${c.port}/${c.database}`;
    item.tooltip = `${c.user}@${c.host}:${c.port}/${c.database}`;
    item.iconPath = new vscode.ThemeIcon('database');
    item.contextValue = 'florinConnection';
    return item;
  }

  getChildren(): Connection[] {
    return getConnections(this.context);
  }
}

export function activate(context: vscode.ExtensionContext) {
  // THE portability trick: mark this key to sync via your VS Code (GitHub) account.
  context.globalState.setKeysForSync([CONNECTIONS_KEY]);

  const provider = new ConnectionsProvider(context);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('florin.connections', provider),
    vscode.commands.registerCommand('florin.addConnectionFromUrl', () => addConnectionFromUrl(context, provider)),
    vscode.commands.registerCommand('florin.listConnections', () => listConnections(context)),
    vscode.commands.registerCommand('florin.refresh', () => provider.refresh()),
  );
}

async function addConnectionFromUrl(context: vscode.ExtensionContext, provider: ConnectionsProvider) {
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

  // Metadata -> synced globalState. Password -> OS keychain (never synced, never in git).
  const connections = getConnections(context);
  connections.push(conn);
  await context.globalState.update(CONNECTIONS_KEY, connections);
  if (password) {
    await context.secrets.store(`florin.pw.${conn.id}`, password);
  }

  provider.refresh();
  vscode.window.showInformationMessage(
    `Florin: saved "${conn.name}" (${conn.driver} ${conn.host}:${conn.port}/${conn.database}). Password kept in keychain.`,
  );
}

async function listConnections(context: vscode.ExtensionContext) {
  const connections = getConnections(context);
  if (connections.length === 0) {
    vscode.window.showInformationMessage('Florin: no connections yet. Run "Florin: Add Connection from URL".');
    return;
  }
  await vscode.window.showQuickPick(
    connections.map((c) => ({
      label: c.name,
      description: `${c.driver} ${c.host}:${c.port}/${c.database}`,
    })),
    { title: 'Florin: Connections' },
  );
}

export function deactivate() {}
