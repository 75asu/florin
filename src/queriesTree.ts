import * as vscode from 'vscode';
import { Vault } from './vault';

// Nodes in the Saved Queries view: a group is a folder under queries/, a query
// is a single .sql file. Postman-style: folders on top, click a query to load it.
type QueryNode =
  | { kind: 'group'; group: string }
  | { kind: 'query'; group: string; name: string; sql: string };

export class QueriesProvider implements vscode.TreeDataProvider<QueryNode> {
  private readonly _onDidChange = new vscode.EventEmitter<QueryNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private readonly vault: Vault) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(node: QueryNode): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.group, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('folder');
      item.contextValue = 'florin.queryGroup';
      return item;
    }
    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('file-code');
    item.contextValue = 'florin.queryItem';
    item.tooltip = node.sql;
    // Leaf: a single click reliably fires the command (loads it into the console).
    item.command = { command: 'florin.openQueryItem', title: 'Open Query', arguments: [node] };
    return item;
  }

  async getChildren(node?: QueryNode): Promise<QueryNode[]> {
    if (!this.vault.configured) {
      return [];
    }
    const all = await this.vault.listQueries();
    if (!node) {
      const groups = [...new Set(all.map((q) => q.group))].sort((a, b) => a.localeCompare(b));
      return groups.map((group) => ({ kind: 'group', group }));
    }
    if (node.kind === 'group') {
      return all
        .filter((q) => q.group === node.group)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((q) => ({ kind: 'query', group: q.group, name: q.name, sql: q.sql }));
    }
    return [];
  }
}
