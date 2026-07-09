import * as vscode from 'vscode';
import { ConnectionStore } from './store';
import { getDriver } from './drivers';
import { describeError } from './errors';
import type { FlorinNode, NodeKind } from './drivers/types';

// Kinds that can be expanded further; column and key are leaves.
const EXPANDABLE: NodeKind[] = ['connection', 'database', 'schema', 'table', 'keyspace', 'keyprefix'];

function color(id: string): vscode.ThemeColor {
  return new vscode.ThemeColor(id);
}

// Colour-coded, meaningful icon per node kind (connection + message are handled
// separately). charts.* colours are theme-aware, so this reads well in light and
// dark. Prefix folders are yellow like a file tree; columns get a type-aware
// glyph (string/number/date/bool) so the shape tells you the column's type.
function nodeIcon(node: FlorinNode): vscode.ThemeIcon {
  switch (node.kind) {
    case 'database':
      return new vscode.ThemeIcon('database', color('charts.blue'));
    case 'schema':
      return new vscode.ThemeIcon('symbol-namespace', color('charts.purple'));
    case 'table':
      return new vscode.ThemeIcon('table', color('charts.green'));
    case 'column':
      return columnIcon(node.detail);
    case 'keyspace':
      return new vscode.ThemeIcon('database', color('charts.red'));
    case 'keyprefix':
      return new vscode.ThemeIcon('folder', color('charts.yellow'));
    case 'key':
      return new vscode.ThemeIcon('key', color('charts.orange'));
    default:
      return new vscode.ThemeIcon('circle-outline');
  }
}

// Map a Postgres type string to a type-shaped glyph, the way a file-icon theme
// maps extensions. Falls back to a generic field icon.
function columnIcon(detail?: string): vscode.ThemeIcon {
  const t = (detail ?? '').toLowerCase();
  if (/\bbool/.test(t)) {
    return new vscode.ThemeIcon('symbol-boolean', color('charts.purple'));
  }
  if (/(date|time|timestamp|interval)/.test(t)) {
    return new vscode.ThemeIcon('calendar', color('charts.orange'));
  }
  if (/(int|numeric|decimal|real|double|serial|money|float)/.test(t)) {
    return new vscode.ThemeIcon('symbol-numeric', color('charts.green'));
  }
  if (/(char|text|string|uuid|json|xml|bytea|name|citext|enum)/.test(t)) {
    return new vscode.ThemeIcon('symbol-string', color('charts.blue'));
  }
  return new vscode.ThemeIcon('symbol-field', color('charts.foreground'));
}

// Distinguish engines at the connection row with the real engine logo.
function driverIconFile(driver?: string): string | undefined {
  switch (driver) {
    case 'postgres':
    case 'postgresql':
      return 'postgres.svg';
    case 'redis':
    case 'rediss':
      return 'redis.svg';
    default:
      return undefined;
  }
}

type ConnStatus = 'unknown' | 'ok' | 'error';

// The one tree behind the Connections view: connection -> database -> schema
// -> table -> column. Each level is fetched lazily from the driver on expand.
export class ExplorerProvider implements vscode.TreeDataProvider<FlorinNode> {
  private readonly _onDidChange = new vscode.EventEmitter<FlorinNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  // Last-known connectivity per connection, drives the plug icon colour.
  private readonly status = new Map<string, ConnStatus>();

  constructor(
    private readonly store: ConnectionStore,
    private readonly extensionUri: vscode.Uri,
  ) {}

  refresh(node?: FlorinNode): void {
    this._onDidChange.fire(node);
  }

  getTreeItem(node: FlorinNode): vscode.TreeItem {
    const state = EXPANDABLE.includes(node.kind)
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;

    const item = new vscode.TreeItem(node.label, state);
    item.contextValue = `florin.${node.kind}`;

    if (node.kind === 'message') {
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
      item.tooltip = node.detail ?? node.label;
      // Click the error to re-query (invalidates the cached failure).
      item.command = { command: 'florin.refresh', title: 'Refresh' };
      return item;
    }

    if (node.kind === 'connection') {
      const c = this.store.get(node.connectionId);
      item.iconPath = this.connectionIcon(node.connectionId, c?.driver);
      if (c) {
        const st = this.status.get(node.connectionId);
        item.description = st === 'error' ? `${c.driver} , disconnected` : `${c.driver} ${c.host}:${c.port}`;
        item.tooltip = `${c.user}@${c.host}:${c.port}/${c.database}${st === 'error' ? '  (connection failed)' : ''}`;
      }
      return item;
    }

    item.iconPath = nodeIcon(node);
    if (node.detail) {
      item.description = node.detail;
    }
    return item;
  }

  async getChildren(node?: FlorinNode): Promise<FlorinNode[]> {
    // Root level: the saved connections.
    if (!node) {
      return this.store.all().map((c) => ({
        kind: 'connection',
        label: c.name,
        connectionId: c.id,
      }));
    }

    const conn = this.store.get(node.connectionId);
    if (!conn) {
      return [];
    }

    try {
      const driver = getDriver(conn, await this.store.password(conn.id));
      const children = await driver.children(node);
      this.setStatus(node.connectionId, 'ok');
      return children;
    } catch (err) {
      this.setStatus(node.connectionId, 'error');
      const { message, kind } = describeError(err);
      return [
        {
          kind: 'message',
          label: kind === 'connection' ? 'Not connected. Click to retry.' : 'Could not load. Click to retry.',
          connectionId: node.connectionId,
          detail: message,
        },
      ];
    }
  }

  // A disconnected connection keeps the red broken-plug (status matters most
  // when it's down). Otherwise show the engine logo so Postgres vs Redis is
  // obvious at a glance; unknown engines fall back to a generic database icon.
  private connectionIcon(id: string, driver?: string): vscode.ThemeIcon | vscode.Uri {
    if (this.status.get(id) === 'error') {
      return new vscode.ThemeIcon('debug-disconnect', new vscode.ThemeColor('testing.iconFailed'));
    }
    const file = driverIconFile(driver);
    return file
      ? vscode.Uri.joinPath(this.extensionUri, 'media', file)
      : new vscode.ThemeIcon('database');
  }

  // Update connectivity and re-render the icon. Fires only on a real change, so
  // the follow-up getChildren (same status) does not loop.
  private setStatus(id: string, status: ConnStatus): void {
    if (this.status.get(id) === status) {
      return;
    }
    this.status.set(id, status);
    this._onDidChange.fire();
  }
}
