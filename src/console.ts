import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { ConnectionStore } from './store';
import { Vault } from './vault';
import { getDriver } from './drivers';
import { describeError } from './errors';
import { splitStatements } from './sql/split';
import type { FlorinNode, SchemaMap } from './drivers/types';

// Max rows rendered in the grid. The query still runs fully server-side (guarded
// by statement_timeout); this just bounds what we paint.
const DISPLAY_CAP = 1000;

interface Target {
  connectionId: string;
  connName: string;
  database: string;
}

// One open console panel bound to its own target. A new Session (and panel) is
// created per New Query / preview, so consoles don't clobber each other.
interface Session {
  panel: vscode.WebviewPanel;
  target: Target;
}

// A Beekeeper-style console: SQL editor on top, results grid below. Each New
// Query / preview opens its OWN webview panel bound to its own target, so you
// can work across connections and locations in parallel.
export class QueryConsole {
  private static instance: QueryConsole | undefined;
  // Cache the table/column map per connection+database so autocomplete is instant
  // after the first fetch, shared across panels.
  private schemaCache = new Map<string, SchemaMap>();

  private constructor(
    private readonly store: ConnectionStore,
    private readonly vault: Vault,
    private readonly extensionUri: vscode.Uri,
  ) {}

  static get(store: ConnectionStore, vault: Vault, extensionUri: vscode.Uri): QueryConsole {
    if (!QueryConsole.instance) {
      QueryConsole.instance = new QueryConsole(store, vault, extensionUri);
    }
    return QueryConsole.instance;
  }

  // Open a fresh console bound to a connection/database node with an empty editor.
  async openForNode(node?: FlorinNode): Promise<void> {
    const target = node ? this.targetFromNode(node) : await this.pickTarget();
    if (!target) {
      return;
    }
    this.open(target, { seedSql: '', autoRun: false });
  }

  // Preview a leaf node: a SQL table (seed + run a SELECT) or a Redis key (read
  // its value straight into the grid, no SQL). Each opens its own panel.
  async openPreview(node: FlorinNode): Promise<void> {
    const target = this.targetFromNode(node);
    if (!target) {
      return;
    }
    if (node.kind === 'table') {
      const sql = `SELECT * FROM ${quoteIdent(node.schema!)}.${quoteIdent(node.table!)} LIMIT 100;`;
      this.open(target, { seedSql: sql, autoRun: true });
    } else if (node.kind === 'key') {
      await this.previewKey(node, target);
    }
  }

  // Redis: open a console (empty editor, so the user can run raw commands) and
  // render the key's value into the results grid.
  private async previewKey(node: FlorinNode, target: Target): Promise<void> {
    const session = this.open(target, { seedSql: '', autoRun: false });
    const conn = this.store.get(target.connectionId);
    if (!conn) {
      return;
    }
    this.post(session, { type: 'running' });
    try {
      const driver = getDriver(conn, await this.store.password(conn.id));
      const result = await driver.preview(node, DISPLAY_CAP);
      this.post(session, {
        type: 'result',
        columns: result.columns,
        rows: result.rows.slice(0, DISPLAY_CAP),
        note: `${node.key} , ${result.rowCount} row(s)`,
      });
    } catch (err) {
      this.post(session, { type: 'error', ...describeError(err) });
    }
  }

  private targetFromNode(node: FlorinNode): Target | undefined {
    const conn = this.store.get(node.connectionId);
    if (!conn) {
      return undefined;
    }
    return { connectionId: conn.id, connName: conn.name, database: node.database ?? conn.database };
  }

  private engineOf(target: Target): 'redis' | 'sql' {
    const conn = this.store.get(target.connectionId);
    return conn && isRedisDriver(conn.driver) ? 'redis' : 'sql';
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

  // Create a brand-new panel bound to `target` and return its Session. Each call
  // is independent, so many consoles can be open at once across connections.
  private open(target: Target, opts: { seedSql: string; autoRun: boolean }): Session {
    const panel = vscode.window.createWebviewPanel(
      'florin.console',
      `Florin · ${target.connName}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
      },
    );
    panel.webview.html = this.html(panel.webview);
    const session: Session = { panel, target };
    panel.webview.onDidReceiveMessage((msg: { type: string; sql?: string }) => this.onMessage(session, msg));
    panel.reveal(vscode.ViewColumn.Active, false);
    this.post(session, {
      type: 'setTarget',
      label: `${target.connName} · ${target.database}`,
      seedSql: opts.seedSql,
      autoRun: opts.autoRun,
      engine: this.engineOf(target),
    });
    void this.sendSchema(session);
    return session;
  }

  // Fetch (and cache) the DB's table/column map and hand it to this panel's editor
  // for autocomplete. Best-effort: failure just means keyword-only completion.
  private async sendSchema(session: Session): Promise<void> {
    const { target } = session;
    const key = `${target.connectionId}:${target.database}`;
    const cached = this.schemaCache.get(key);
    if (cached) {
      this.post(session, { type: 'schema', schema: cached });
      return;
    }
    const conn = this.store.get(target.connectionId);
    if (!conn) {
      return;
    }
    try {
      const driver = getDriver(conn, await this.store.password(conn.id));
      const schema = await driver.schema(target.database);
      this.schemaCache.set(key, schema);
      this.post(session, { type: 'schema', schema });
    } catch {
      /* keyword-only completion is fine */
    }
  }

  // Save the current editor SQL into the vault: overwrite an existing query, or
  // create a new one. saveQuery writes to the same path for the same group/name,
  // so picking an existing entry updates it in place.
  private async saveCurrent(session: Session, sql: string): Promise<void> {
    if (!sql.trim()) {
      return;
    }
    if (!this.vault.configured) {
      vscode.window.showInformationMessage('Florin: configure a vault to save queries (Florin: Configure Vault).');
      return;
    }

    interface SaveItem extends vscode.QuickPickItem {
      mode: 'new' | 'existing';
      group?: string;
      name?: string;
    }

    const newItem: SaveItem = { label: '$(add) New query,', mode: 'new' };
    const existing = await this.vault.listQueries();

    let choice: SaveItem | undefined = newItem;
    if (existing.length) {
      const items: SaveItem[] = [
        newItem,
        ...existing.map(
          (q): SaveItem => ({ label: `$(save) ${q.name}`, description: q.group, mode: 'existing', group: q.group, name: q.name }),
        ),
      ];
      choice = await vscode.window.showQuickPick(items, {
        title: 'Florin: Save Query',
        placeHolder: 'Overwrite an existing query, or create a new one',
      });
    }
    if (!choice) {
      return;
    }

    let group: string;
    let name: string;
    if (choice.mode === 'new' || !choice.group || !choice.name) {
      const g = await vscode.window.showInputBox({
        title: 'Save Query , group',
        value: session.target.connName ?? 'scratch',
        prompt: 'Folder to file this query under',
        ignoreFocusOut: true,
      });
      if (g === undefined) {
        return;
      }
      const n = await vscode.window.showInputBox({
        title: 'Save Query , name',
        placeHolder: 'users-by-tenant',
        ignoreFocusOut: true,
      });
      if (!n) {
        return;
      }
      group = g;
      name = n;
    } else {
      group = choice.group;
      name = choice.name;
    }

    const updating = choice.mode === 'existing';
    await this.vault.saveQuery(group, name, sql);
    this.vault.scheduleSync(`florin: ${updating ? 'update' : 'save'} query ${group}/${name}`);
    void vscode.commands.executeCommand('florin.refreshQueries');
    vscode.window.showInformationMessage(`Florin: ${updating ? 'updated' : 'saved'} query "${name}".`);
  }

  // Load a saved query's SQL into a new console (from the Saved Queries tree).
  async openWithSql(sql: string): Promise<void> {
    const target = await this.pickTarget();
    if (!target) {
      return;
    }
    this.open(target, { seedSql: sql, autoRun: false });
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
    const target = await this.pickTarget();
    if (!target) {
      return;
    }
    this.open(target, { seedSql: pick.q.sql, autoRun: false });
  }

  private async onMessage(session: Session, msg: { type: string; sql?: string }): Promise<void> {
    if (msg.type === 'save') {
      await this.saveCurrent(session, (msg.sql ?? '').trim());
      return;
    }
    if (msg.type !== 'run') {
      return;
    }
    const sql = (msg.sql ?? '').trim();
    const target = session.target;
    if (!sql) {
      return;
    }
    const conn = this.store.get(target.connectionId);
    if (!conn) {
      this.post(session, { type: 'error', message: 'Connection no longer exists.' });
      return;
    }
    // Redis commands are one-per-line (no ';'); SQL splits on statement boundaries.
    const statements = isRedisDriver(conn.driver) ? splitCommands(sql) : splitStatements(sql);
    if (statements.length === 0) {
      return;
    }

    this.post(session, { type: 'running' });
    try {
      const driver = getDriver(conn, await this.store.password(conn.id));
      const result = await driver.runScript(target.database, statements);
      const capped = result.rows.length > DISPLAY_CAP;
      const prefix = statements.length > 1 ? `ran ${statements.length} statements , ` : '';
      const tail =
        result.columns.length === 0
          ? `${result.rowCount} row(s) affected`
          : capped
            ? `showing first ${DISPLAY_CAP} of ${result.rowCount} rows`
            : `${result.rowCount} row(s)`;
      this.post(session, {
        type: 'result',
        columns: result.columns,
        rows: capped ? result.rows.slice(0, DISPLAY_CAP) : result.rows,
        note: prefix + tail,
      });
    } catch (err) {
      this.post(session, { type: 'error', ...describeError(err) });
    }
  }

  private post(session: Session, message: unknown): void {
    session.panel.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomUUID().replace(/-/g, '');
    const editorUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'editor.js'));
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
  .stmts { font-size: 11px; color: var(--vscode-descriptionForeground); margin-right: 2px; white-space: nowrap; }
  .editor { padding: 10px 12px 0; height: 200px; box-sizing: border-box; flex: 0 0 auto; }
  .cm-editor { height: 100%; }
  .cm-scroller { overflow: auto; }
  .splitter { flex: 0 0 auto; height: 8px; cursor: row-resize; position: relative; }
  .splitter::before { content: ''; position: absolute; left: 12px; right: 12px; top: 3px; height: 2px;
    border-radius: 2px; background: var(--vscode-panel-border); transition: background .1s; }
  .splitter:hover::before, .splitter.dragging::before { background: var(--vscode-focusBorder); }
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
  .error { margin: 4px 14px 0; padding: 12px; border-radius: 6px; white-space: pre-wrap; font-size: 12px;
    color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground));
    background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,.08));
    border: 1px solid var(--vscode-inputValidation-errorBorder, #b00); }
  .error.conn { color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
    background: var(--vscode-inputValidation-warningBackground, rgba(255,170,0,.10));
    border-color: var(--vscode-inputValidation-warningBorder, #b98900); }
  .etitle { font-weight: 600; margin-bottom: 5px; display: flex; align-items: center; gap: 6px; }
  .ehint { margin-top: 8px; opacity: .85; font-size: 11px; }
  .hint { color: var(--vscode-descriptionForeground); padding: 20px 4px; }
</style>
</head>
<body>
  <div class="bar">
    <div class="target">Running on <b id="target">, no connection</b></div>
    <span id="stmts" class="stmts"></span>
    <button id="format" class="secondary">Format</button>
    <button id="save" class="secondary">Save</button>
    <button id="run">Run<span class="kbd">&#8984;&#9166;</span></button>
  </div>
  <div class="editor" id="editor"></div>
  <div class="splitter" id="splitter" title="Drag to resize"></div>
  <div class="status" id="status"></div>
  <div class="results" id="results"><div class="hint">Run a query to see results.</div></div>

<script nonce="${nonce}" src="${editorUri}"></script>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const runBtn = $('run'), saveBtn = $('save'), formatBtn = $('format'), results = $('results'), status = $('status'), target = $('target');
  const editorEl = $('editor'), splitter = $('splitter');
  let engine = 'sql'; // 'sql' | 'redis' , set per connection on setTarget

  // CodeMirror editor (schema-aware SQL). Falls back gracefully if it fails to load.
  const stmtsEl = $('stmts');
  const ed = window.FlorinEditor.create(editorEl, {
    doc: '',
    onRun: run,
    onStats: (n) => { stmtsEl.textContent = n >= 1 ? (n + (n === 1 ? ' statement' : ' statements')) : ''; },
  });

  function run() {
    const text = (ed.getSelection().trim() || ed.getValue()).trim();
    if (!text) return;
    vscode.postMessage({ type: 'run', sql: text });
  }
  runBtn.addEventListener('click', run);
  saveBtn.addEventListener('click', () => vscode.postMessage({ type: 'save', sql: ed.getValue() }));
  // Redis commands don't have a grammar to pretty-print; "format" means tidy each
  // line , uppercase the command verb, trim, drop blank lines , keeping args verbatim.
  function formatRedis() {
    const out = ed.getValue()
      .split(/\\r?\\n/)
      .map((line) => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return t;
        const i = t.indexOf(' ');
        return i === -1 ? t.toUpperCase() : t.slice(0, i).toUpperCase() + ' ' + t.slice(i + 1).trim();
      })
      .filter((l, idx, arr) => l !== '' || (idx > 0 && arr[idx - 1] !== ''))
      .join('\\n');
    ed.setValue(out);
  }

  formatBtn.addEventListener('click', () => {
    if (engine === 'redis') {
      formatRedis();
      status.textContent = 'Formatted';
      return;
    }
    try {
      ed.format();
      status.textContent = 'Formatted';
    } catch (e) {
      // sql-formatter's parser can't handle every Postgres construct; degrade
      // gracefully instead of dumping its grammar.
      const m = String((e && e.message) ? e.message : e).match(/line (\d+) column (\d+)/);
      status.textContent = m
        ? 'Could not format , unsupported syntax near line ' + m[1] + '. Query left unchanged.'
        : 'Could not format , unsupported syntax. Query left unchanged.';
    }
  });

  // Restore persisted editor height, then wire the drag-to-resize splitter.
  try { const s = vscode.getState(); if (s && s.editorHeight) editorEl.style.height = s.editorHeight; } catch (e) {}
  let dragging = false, startY = 0, startH = 0;
  splitter.addEventListener('mousedown', (e) => {
    dragging = true; startY = e.clientY; startH = editorEl.getBoundingClientRect().height;
    splitter.classList.add('dragging'); document.body.style.cursor = 'row-resize'; e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const h = Math.max(80, Math.min(window.innerHeight - 160, startH + (e.clientY - startY)));
    editorEl.style.height = h + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; splitter.classList.remove('dragging'); document.body.style.cursor = '';
    try { vscode.setState({ editorHeight: editorEl.style.height }); } catch (e) {}
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
      engine = m.engine || 'sql';
      if (m.seedSql) ed.setValue(m.seedSql);
      if (m.autoRun) run();
      ed.focus();
    } else if (m.type === 'schema') {
      ed.setSchema(m.schema);
    } else if (m.type === 'running') {
      runBtn.disabled = true; status.textContent = 'Running,';
    } else if (m.type === 'error') {
      runBtn.disabled = false;
      const conn = m.kind === 'connection';
      status.textContent = conn ? 'Not connected' : 'Query failed';
      const title = conn ? 'Not connected' : 'Query error';
      const hint = conn ? '<div class="ehint">The database connection is down. Check the connection or tunnel, then Run again.</div>' : '';
      results.innerHTML = '<div class="error' + (conn ? ' conn' : '') + '"><div class="etitle">' + esc(title) + '</div>' + esc(m.message || 'Unknown error') + hint + '</div>';
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

function isRedisDriver(driver?: string): boolean {
  return driver === 'redis' || driver === 'rediss';
}

// Redis: one command per line, dropping blanks and '#' comments. No ';' splitting.
function splitCommands(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}
