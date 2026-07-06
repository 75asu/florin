import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { ConnectionStore } from './store';
import { Vault } from './vault';
import { getDriver } from './drivers';
import type { FlorinNode } from './drivers/types';

// Max rows rendered in the grid. The query still runs fully server-side (guarded
// by statement_timeout); this just bounds what we paint.
const DISPLAY_CAP = 1000;

interface Target {
  connectionId: string;
  connName: string;
  database: string;
}

// A single Beekeeper-style console: SQL editor on top, results grid below, in
// one webview. Preview and New Query both drive it.
export class QueryConsole {
  private static instance: QueryConsole | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private target: Target | undefined;

  private constructor(
    private readonly store: ConnectionStore,
    private readonly vault: Vault,
  ) {}

  static get(store: ConnectionStore, vault: Vault): QueryConsole {
    if (!QueryConsole.instance) {
      QueryConsole.instance = new QueryConsole(store, vault);
    }
    return QueryConsole.instance;
  }

  // Open bound to a connection/database node with an empty editor.
  async openForNode(node?: FlorinNode): Promise<void> {
    const target = node ? this.targetFromNode(node) : await this.pickTarget();
    if (!target) {
      return;
    }
    this.reveal(target, { seedSql: '', autoRun: false });
  }

  // Open pre-filled with a SELECT for a table node and run it immediately.
  async openPreview(node: FlorinNode): Promise<void> {
    if (node.kind !== 'table') {
      return;
    }
    const target = this.targetFromNode(node);
    if (!target) {
      return;
    }
    const sql = `SELECT * FROM ${quoteIdent(node.schema!)}.${quoteIdent(node.table!)} LIMIT 100;`;
    this.reveal(target, { seedSql: sql, autoRun: true });
  }

  private targetFromNode(node: FlorinNode): Target | undefined {
    const conn = this.store.get(node.connectionId);
    if (!conn) {
      return undefined;
    }
    return { connectionId: conn.id, connName: conn.name, database: node.database ?? conn.database };
  }

  private async pickTarget(): Promise<Target | undefined> {
    const conns = this.store.all();
    if (conns.length === 0) {
      vscode.window.showInformationMessage('Florin: add a connection first.');
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      conns.map((c) => ({ label: c.name, description: `${c.host}:${c.port}/${c.database}`, c })),
      { title: 'Florin: query against', placeHolder: 'Pick a connection' },
    );
    return pick ? { connectionId: pick.c.id, connName: pick.c.name, database: pick.c.database } : undefined;
  }

  private reveal(target: Target, opts: { seedSql: string; autoRun: boolean }): void {
    this.target = target;
    const panel = this.ensurePanel();
    panel.reveal(vscode.ViewColumn.Active, false);
    panel.webview.postMessage({
      type: 'setTarget',
      label: `${target.connName} · ${target.database}`,
      seedSql: opts.seedSql,
      autoRun: opts.autoRun,
    });
  }

  private ensurePanel(): vscode.WebviewPanel {
    if (this.panel) {
      return this.panel;
    }
    const panel = vscode.window.createWebviewPanel('florin.console', 'Florin Query', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((msg: { type: string; sql?: string }) => this.onMessage(msg));
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.target = undefined;
    });
    this.panel = panel;
    return panel;
  }

  // Save the current editor SQL into the vault's query library.
  private async saveCurrent(sql: string): Promise<void> {
    if (!sql.trim()) {
      return;
    }
    if (!this.vault.configured) {
      vscode.window.showInformationMessage('Florin: configure a vault to save queries (Florin: Configure Vault).');
      return;
    }
    const group = await vscode.window.showInputBox({
      title: 'Save Query , group',
      value: this.target?.connName ?? 'scratch',
      prompt: 'Folder to file this query under',
    });
    if (group === undefined) {
      return;
    }
    const name = await vscode.window.showInputBox({ title: 'Save Query , name', placeHolder: 'users-by-tenant' });
    if (!name) {
      return;
    }
    await this.vault.saveQuery(group, name, sql);
    this.vault.scheduleSync(`florin: save query ${group}/${name}`);
    vscode.window.showInformationMessage(`Florin: saved query "${name}".`);
  }

  // Pick a saved query from the vault and load it into the console editor.
  async openSaved(): Promise<void> {
    if (!this.vault.configured) {
      vscode.window.showInformationMessage('Florin: configure a vault first (Florin: Configure Vault).');
      return;
    }
    const queries = await this.vault.listQueries();
    if (queries.length === 0) {
      vscode.window.showInformationMessage('Florin: no saved queries yet.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      queries.map((q) => ({ label: q.name, description: q.group, q })),
      { title: 'Florin: open saved query', matchOnDescription: true },
    );
    if (!pick) {
      return;
    }
    if (!this.target) {
      const t = await this.pickTarget();
      if (!t) {
        return;
      }
      this.target = t;
    }
    const panel = this.ensurePanel();
    panel.reveal(vscode.ViewColumn.Active, false);
    panel.webview.postMessage({
      type: 'setTarget',
      label: `${this.target.connName} · ${this.target.database}`,
      seedSql: pick.q.sql,
      autoRun: false,
    });
  }

  private async onMessage(msg: { type: string; sql?: string }): Promise<void> {
    if (!this.panel) {
      return;
    }
    if (msg.type === 'save') {
      await this.saveCurrent((msg.sql ?? '').trim());
      return;
    }
    if (msg.type !== 'run') {
      return;
    }
    const sql = (msg.sql ?? '').trim();
    const target = this.target;
    if (!sql || !target) {
      return;
    }
    const conn = this.store.get(target.connectionId);
    if (!conn) {
      this.post({ type: 'error', message: 'Connection no longer exists.' });
      return;
    }

    this.post({ type: 'running' });
    try {
      const driver = getDriver(conn, await this.store.password(conn.id));
      const result = await driver.query(target.database, sql);
      const capped = result.rows.length > DISPLAY_CAP;
      const note =
        result.columns.length === 0
          ? `${result.rowCount} row(s) affected`
          : capped
            ? `showing first ${DISPLAY_CAP} of ${result.rowCount} rows`
            : `${result.rowCount} row(s)`;
      this.post({
        type: 'result',
        columns: result.columns,
        rows: capped ? result.rows.slice(0, DISPLAY_CAP) : result.rows,
        note,
      });
    } catch (err) {
      this.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  private post(message: unknown): void {
    this.panel?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomUUID().replace(/-/g, '');
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  :root { --gap: 10px; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column;
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  .bar {
    display: flex; align-items: center; gap: var(--gap);
    padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border);
  }
  .bar .target { font-size: 12px; color: var(--vscode-descriptionForeground); flex: 1;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar .target b { color: var(--vscode-foreground); font-weight: 600; }
  button {
    font-family: inherit; font-size: 12px; cursor: pointer;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background);
    border: none; padding: 5px 12px; border-radius: 4px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .5; cursor: default; }
  button.secondary { color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, transparent);
    border: 1px solid var(--vscode-panel-border); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
  .kbd { font-size: 10px; opacity: .8; margin-left: 6px; }
  .editor { padding: 10px 12px; }
  textarea {
    width: 100%; box-sizing: border-box; min-height: 120px; resize: vertical;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 6px; padding: 10px; line-height: 1.5; tab-size: 2;
  }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
  .status { padding: 2px 14px 8px; font-size: 11px; color: var(--vscode-descriptionForeground); min-height: 14px; }
  .results { flex: 1; overflow: auto; padding: 0; }
  table { border-collapse: separate; border-spacing: 0; font-size: 12px; width: max-content; min-width: 100%; }
  thead th {
    position: sticky; top: 0; z-index: 2; text-align: left; font-weight: 600;
    padding: 5px 14px; background: var(--vscode-editorWidget-background);
    border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap;
    font-family: var(--vscode-font-family);
  }
  tbody td {
    padding: 3px 14px; border-bottom: 1px solid var(--vscode-editorGroup-border, rgba(128,128,128,.10));
    max-width: 440px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: top;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  tbody tr:nth-child(even) td { background: rgba(128,128,128,.045); }
  tbody tr:hover td { background: var(--vscode-list-hoverBackground); }
  th.n, td.n {
    text-align: right; color: var(--vscode-descriptionForeground); user-select: none;
    position: sticky; left: 0; z-index: 1; min-width: 30px; padding-right: 12px; padding-left: 10px;
    border-right: 1px solid var(--vscode-panel-border);
  }
  td.n { background: var(--vscode-editor-background); }
  tbody tr:hover td.n { background: var(--vscode-list-hoverBackground); }
  thead th.n { z-index: 3; }
  .null { color: var(--vscode-descriptionForeground); font-style: italic; }
  .error { margin-top: 4px; padding: 12px; border-radius: 6px; white-space: pre-wrap; font-size: 12px;
    color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground));
    background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,.08));
    border: 1px solid var(--vscode-inputValidation-errorBorder, #b00); }
  .hint { color: var(--vscode-descriptionForeground); padding: 20px 4px; }
</style>
</head>
<body>
  <div class="bar">
    <div class="target">Running on <b id="target">, no connection</b></div>
    <button id="save" class="secondary">Save</button>
    <button id="run">Run<span class="kbd">&#8984;&#9166;</span></button>
  </div>
  <div class="editor"><textarea id="sql" spellcheck="false" placeholder="Write SQL, then press Cmd+Enter"></textarea></div>
  <div class="status" id="status"></div>
  <div class="results" id="results"><div class="hint">Run a query to see results.</div></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const sql = $('sql'), runBtn = $('run'), saveBtn = $('save'), results = $('results'), status = $('status'), target = $('target');

  function run() {
    const text = (window.getSelection && String(window.getSelection()).trim()) ? String(window.getSelection()).trim() : sql.value;
    if (!text.trim()) return;
    vscode.postMessage({ type: 'run', sql: text });
  }
  runBtn.addEventListener('click', run);
  saveBtn.addEventListener('click', () => vscode.postMessage({ type: 'save', sql: sql.value }));
  sql.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
  });

  function esc(s) { return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
  function attr(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
  function raw(v) { if (v === null || v === undefined) return ''; if (typeof v === 'object') return JSON.stringify(v); return String(v); }
  function cell(v) {
    if (v === null || v === undefined) return '<span class="null">NULL</span>';
    if (typeof v === 'object') return esc(JSON.stringify(v));
    return esc(v);
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'setTarget') {
      target.textContent = m.label;
      if (m.seedSql) sql.value = m.seedSql;
      if (m.autoRun) run();
      sql.focus();
    } else if (m.type === 'running') {
      runBtn.disabled = true; status.textContent = 'Running,';
    } else if (m.type === 'error') {
      runBtn.disabled = false; status.textContent = '';
      results.innerHTML = '<div class="error">' + esc(m.message) + '</div>';
    } else if (m.type === 'result') {
      runBtn.disabled = false; status.textContent = m.note;
      if (!m.columns.length) { results.innerHTML = '<div class="hint">' + esc(m.note) + '</div>'; return; }
      let h = '<table><thead><tr><th class="n">#</th>';
      for (const c of m.columns) h += '<th>' + esc(c) + '</th>';
      h += '</tr></thead><tbody>';
      m.rows.forEach((row, i) => {
        h += '<tr><td class="n">' + (i + 1) + '</td>';
        for (const v of row) h += '<td title="' + attr(raw(v)) + '">' + cell(v) + '</td>';
        h += '</tr>';
      });
      h += '</tbody></table>';
      results.innerHTML = h;
    }
  });
</script>
</body>
</html>`;
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
