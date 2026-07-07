import * as vscode from 'vscode';
import { ConnectionStore } from './store';
import { getDriver } from './drivers';
import { describeError } from './errors';
import type { FlorinNode, NodeKind } from './drivers/types';

// Kinds that can be expanded further; a column is a leaf.
const EXPANDABLE: NodeKind[] = ['connection', 'database', 'schema', 'table'];

const ICONS: Record<NodeKind, string> = {
  connection: 'plug',
  database: 'database',
  schema: 'symbol-namespace',
  table: 'table',
  column: 'symbol-field',
  message: 'warning',
};

type ConnStatus = 'unknown' | 'ok' | 'error';

// The one tree behind the Connections view: connection -> database -> schema
// -> table -> column. Each level is fetched lazily from the driver on expand.
export class ExplorerProvider implements vscode.TreeDataProvider<FlorinNode> {
  private readonly _onDidChange = new vscode.EventEmitter<FlorinNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  // Last-known connectivity per connection, drives the plug icon colour.
  private readonly status = new Map<string, ConnStatus>();

  constructor(private readonly store: ConnectionStore) {}

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
      item.iconPath = this.connectionIcon(node.connectionId);
      const c = this.store.get(node.connectionId);
      if (c) {
        const st = this.status.get(node.connectionId);
        item.description = st === 'error' ? `${c.driver} , disconnected` : `${c.driver} ${c.host}:${c.port}`;
        item.tooltip = `${c.user}@${c.host}:${c.port}/${c.database}${st === 'error' ? '  (connection failed)' : ''}`;
      }
      return item;
    }

    item.iconPath = new vscode.ThemeIcon(ICONS[node.kind]);
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

  private connectionIcon(id: string): vscode.ThemeIcon {
    switch (this.status.get(id)) {
      case 'ok':
        return new vscode.ThemeIcon('plug', new vscode.ThemeColor('testing.iconPassed'));
      case 'error':
        return new vscode.ThemeIcon('debug-disconnect', new vscode.ThemeColor('testing.iconFailed'));
      default:
        return new vscode.ThemeIcon('plug');
    }
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
