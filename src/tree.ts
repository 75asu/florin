import * as vscode from 'vscode';
import { ConnectionStore } from './store';
import { getDriver } from './drivers';
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

// The one tree behind the Connections view: connection -> database -> schema
// -> table -> column. Each level is fetched lazily from the driver on expand.
export class ExplorerProvider implements vscode.TreeDataProvider<FlorinNode> {
  private readonly _onDidChange = new vscode.EventEmitter<FlorinNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private readonly store: ConnectionStore) {}

  refresh(node?: FlorinNode): void {
    this._onDidChange.fire(node);
  }

  getTreeItem(node: FlorinNode): vscode.TreeItem {
    const state = EXPANDABLE.includes(node.kind)
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;

    const item = new vscode.TreeItem(node.label, state);
    item.iconPath = new vscode.ThemeIcon(ICONS[node.kind]);
    item.contextValue = `florin.${node.kind}`;

    if (node.kind === 'message') {
      item.tooltip = node.detail ?? node.label;
      // Click the error to re-query (invalidates the cached failure).
      item.command = { command: 'florin.refresh', title: 'Refresh' };
      return item;
    }

    if (node.kind === 'connection') {
      const c = this.store.get(node.connectionId);
      if (c) {
        item.description = `${c.driver} ${c.host}:${c.port}`;
        item.tooltip = `${c.user}@${c.host}:${c.port}/${c.database}`;
      }
    } else if (node.detail) {
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
      return await driver.children(node);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Surface the failure inline instead of a misleading empty node.
      return [
        {
          kind: 'message',
          label: 'Could not connect. Click to retry.',
          connectionId: node.connectionId,
          detail: msg,
        },
      ];
    }
  }
}
