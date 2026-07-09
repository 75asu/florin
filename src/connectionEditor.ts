import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { ConnectionStore, Connection } from './store';
import { getDriver } from './drivers';
import { describeError } from './errors';
import type { FlorinNode } from './drivers/types';

// The connection editor: a proper webview form for add AND edit (host/port/db/
// user/password/ssl), replacing the native input-box popups. One reused panel;
// the password never leaves the keychain into the webview (edit shows a blank
// "unchanged" field). Mirrors the console.ts webview pattern (CSP + nonce,
// self-contained HTML + inline script, postMessage bus). Single Postgres driver,
// so the form is hand-written rather than schema-driven.
interface FormConn {
  id?: string;
  driver: string;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: boolean;
}

interface InMsg {
  type: 'test' | 'save' | 'cancel';
  conn?: FormConn;
  password?: string;
  passwordTouched?: boolean;
}

export class ConnectionEditor {
  private static instance: ConnectionEditor | undefined;
  private panel: vscode.WebviewPanel | undefined;

  private constructor(
    private readonly store: ConnectionStore,
    private readonly onChanged: () => void,
  ) {}

  static get(store: ConnectionStore, onChanged: () => void): ConnectionEditor {
    if (!ConnectionEditor.instance) {
      ConnectionEditor.instance = new ConnectionEditor(store, onChanged);
    }
    return ConnectionEditor.instance;
  }

  openAdd(): void {
    const panel = this.ensurePanel('Add Connection');
    this.post({
      type: 'load',
      mode: 'add',
      conn: { driver: 'postgresql', name: '', host: '', port: 5432, database: '', user: '', ssl: false },
    });
    panel.reveal(vscode.ViewColumn.Active, false);
  }

  openEdit(node?: FlorinNode): void {
    if (!node) {
      return;
    }
    const c = this.store.get(node.connectionId);
    if (!c) {
      return;
    }
    const panel = this.ensurePanel(`Edit , ${c.name}`);
    this.post({
      type: 'load',
      mode: 'edit',
      conn: { id: c.id, driver: c.driver, name: c.name, host: c.host, port: c.port, database: c.database, user: c.user, ssl: !!c.ssl },
    });
    panel.reveal(vscode.ViewColumn.Active, false);
  }

  private ensurePanel(title: string): vscode.WebviewPanel {
    if (this.panel) {
      this.panel.title = title;
      return this.panel;
    }
    const panel = vscode.window.createWebviewPanel('florin.connectionEditor', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((msg: InMsg) => this.onMessage(msg));
    panel.onDidDispose(() => {
      this.panel = undefined;
    });
    this.panel = panel;
    return panel;
  }

  private async onMessage(msg: InMsg): Promise<void> {
    if (!this.panel || !msg) {
      return;
    }
    if (msg.type === 'cancel') {
      this.panel.dispose();
      return;
    }
    if (!msg.conn) {
      return;
    }
    if (msg.type === 'test') {
      await this.test(msg.conn, msg.password ?? '');
    } else if (msg.type === 'save') {
      await this.save(msg.conn, msg.password ?? '', !!msg.passwordTouched);
    }
  }

  // Resolve the password to actually connect with: what the user typed, else
  // (when editing) the one already in the keychain, else empty.
  private async resolvePassword(form: FormConn, typed: string): Promise<string> {
    if (typed) {
      return typed;
    }
    if (form.id) {
      return (await this.store.password(form.id)) ?? '';
    }
    return '';
  }

  private toConnection(form: FormConn): Connection {
    const driver = form.driver || 'postgresql';
    const redis = driver === 'redis' || driver === 'rediss';
    return {
      id: form.id ?? randomUUID(),
      name: form.name.trim() || `${form.user}@${form.host}/${form.database}`,
      driver,
      host: form.host.trim(),
      port: Number(form.port) || (redis ? 6379 : 5432),
      database: form.database.trim(),
      user: form.user.trim(),
      ssl: !!form.ssl,
    };
  }

  // Postgres needs host+database+user; Redis needs only a host (user optional,
  // DB index defaults to 0).
  private validate(form: FormConn): string | undefined {
    const redis = form.driver === 'redis' || form.driver === 'rediss';
    if (!form.host) {
      return 'Host is required.';
    }
    if (!redis && (!form.database || !form.user)) {
      return 'Host, database and user are required.';
    }
    return undefined;
  }

  private async test(form: FormConn, typed: string): Promise<void> {
    const invalid = this.validate(form);
    if (invalid) {
      this.post({ type: 'testResult', ok: false, message: invalid });
      return;
    }
    this.post({ type: 'testing' });
    try {
      const pw = await this.resolvePassword(form, typed);
      await getDriver(this.toConnection(form), pw).test();
      this.post({ type: 'testResult', ok: true, message: `Connected to ${form.host}:${form.port}/${form.database}.` });
    } catch (err) {
      this.post({ type: 'testResult', ok: false, message: describeError(err).message });
    }
  }

  private async save(form: FormConn, typed: string, touched: boolean): Promise<void> {
    const invalid = this.validate(form);
    if (invalid) {
      this.post({ type: 'testResult', ok: false, message: invalid });
      return;
    }
    const conn = this.toConnection(form);
    if (form.id) {
      // Edit: keep the stored password when the field was left blank.
      await this.store.update(conn, touched ? typed : undefined);
    } else {
      await this.store.add(conn, typed);
    }
    this.onChanged();
    vscode.window.showInformationMessage(`Florin: saved connection "${conn.name}".`);
    this.panel?.dispose();
  }

  private post(m: unknown): void {
    this.panel?.webview.postMessage(m);
  }

  private html(_webview: vscode.Webview): string {
    const nonce = randomUUID().replace(/-/g, '');
    const csp = ["default-src 'none'", "style-src 'unsafe-inline'", `script-src 'nonce-${nonce}'`].join('; ');

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  html, body { height: 100%; margin: 0; }
  body {
    font-family: var(--vscode-font-family); color: var(--vscode-foreground);
    background: var(--vscode-editor-background); font-size: 13px;
  }
  .wrap { max-width: 560px; margin: 0 auto; padding: 22px 24px 32px; }
  h2 { font-size: 15px; font-weight: 600; margin: 0 0 4px; }
  .sub { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 0 0 18px; }
  .field { margin-bottom: 14px; }
  .field label { display: block; font-size: 12px; margin-bottom: 4px; color: var(--vscode-foreground); }
  .field .hint { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 3px; }
  input[type=text], input[type=number], input[type=password], select {
    width: 100%; box-sizing: border-box; padding: 6px 8px; font-family: inherit; font-size: 13px;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px;
  }
  select {
    color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
    background: var(--vscode-dropdown-background, var(--vscode-input-background));
  }
  input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
  .row { display: flex; gap: 12px; }
  .row .field.host { flex: 3; } .row .field.port { flex: 1; }
  .checkbox { display: flex; align-items: center; gap: 8px; }
  .checkbox input { width: auto; }
  .url { display: flex; gap: 8px; margin-bottom: 18px; }
  .url input { flex: 1; }
  .actions { display: flex; gap: 10px; margin-top: 22px; align-items: center; }
  .actions .spacer { flex: 1; }
  button {
    font-family: inherit; font-size: 13px; cursor: pointer; padding: 6px 14px; border-radius: 4px; border: none;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background);
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .5; cursor: default; }
  button.secondary {
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, transparent);
    border: 1px solid var(--vscode-panel-border);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
  .status { margin-top: 16px; padding: 10px 12px; border-radius: 6px; font-size: 12px; white-space: pre-wrap; display: none; }
  .status.ok { display: block; color: var(--vscode-testing-iconPassed, #3fb950);
    background: rgba(63,185,80,.10); border: 1px solid rgba(63,185,80,.4); }
  .status.err { display: block; color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground));
    background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,.08));
    border: 1px solid var(--vscode-inputValidation-errorBorder, #b00); }
  hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 4px 0 18px; }
</style>
</head>
<body>
  <div class="wrap">
    <h2 id="title">Connection</h2>
    <p class="sub" id="sub">Fill the fields, or paste a connection URL to prefill them.</p>

    <div class="url">
      <input type="text" id="url" placeholder="postgresql://user:pass@host:5432/db?sslmode=require" />
      <button class="secondary" id="fill">Fill from URL</button>
    </div>
    <hr />

    <div class="field">
      <label for="driver">Type</label>
      <select id="driver">
        <option value="postgresql">PostgreSQL</option>
        <option value="redis">Redis</option>
      </select>
    </div>
    <div class="field">
      <label for="name">Name</label>
      <input type="text" id="name" placeholder="my sandbox db" />
    </div>
    <div class="row">
      <div class="field host">
        <label for="host">Host</label>
        <input type="text" id="host" placeholder="10.207.0.3" />
      </div>
      <div class="field port">
        <label for="port">Port</label>
        <input type="number" id="port" value="5432" />
      </div>
    </div>
    <div class="field">
      <label for="database" id="dbLabel">Database</label>
      <input type="text" id="database" placeholder="fravity-app-dev" />
    </div>
    <div class="field">
      <label for="user" id="userLabel">User</label>
      <input type="text" id="user" placeholder="postgres" />
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input type="password" id="password" />
      <div class="hint" id="pwhint">Stored in the OS keychain, never synced.</div>
    </div>
    <div class="field checkbox">
      <input type="checkbox" id="ssl" />
      <label for="ssl" style="margin:0">Require SSL/TLS (needed for ENCRYPTED_ONLY servers)</label>
    </div>

    <div class="status" id="status"></div>

    <div class="actions">
      <button class="secondary" id="test">Test Connection</button>
      <div class="spacer"></div>
      <button class="secondary" id="cancel">Cancel</button>
      <button id="save">Save</button>
    </div>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const F = { driver: $('driver'), name: $('name'), host: $('host'), port: $('port'), database: $('database'), user: $('user'), password: $('password'), ssl: $('ssl') };
  let editId = undefined;
  let passwordTouched = false;

  function isRedis(v) { return v === 'redis' || v === 'rediss'; }

  // Adjust field labels/placeholders for the engine. When not keepPort, also
  // swap the port between the engines' defaults (unless the user set a custom one).
  function applyDriver(driver, keepPort) {
    const redis = isRedis(driver);
    $('dbLabel').textContent = redis ? 'DB index' : 'Database';
    F.database.placeholder = redis ? '0' : 'fravity-app-dev';
    $('userLabel').textContent = redis ? 'User (optional)' : 'User';
    F.user.placeholder = redis ? 'default (leave blank)' : 'postgres';
    if (!keepPort) {
      const p = F.port.value.trim();
      if (redis && (p === '' || p === '5432')) F.port.value = '6379';
      if (!redis && (p === '' || p === '6379')) F.port.value = '5432';
    }
  }

  function gather() {
    const redis = isRedis(F.driver.value);
    return {
      id: editId,
      driver: F.driver.value,
      name: F.name.value,
      host: F.host.value.trim(),
      port: Number(F.port.value) || (redis ? 6379 : 5432),
      database: F.database.value.trim(),
      user: F.user.value.trim(),
      ssl: F.ssl.checked,
    };
  }
  function setStatus(cls, msg) {
    const s = $('status'); s.className = 'status ' + cls; s.textContent = msg;
  }
  function clearStatus() { const s = $('status'); s.className = 'status'; s.textContent = ''; }

  F.password.addEventListener('input', () => { passwordTouched = true; });
  F.driver.addEventListener('change', () => applyDriver(F.driver.value, false));

  $('fill').addEventListener('click', () => {
    const raw = $('url').value.trim();
    if (!raw) return;
    let u;
    try { u = new URL(raw); } catch { setStatus('err', 'That is not a valid URL.'); return; }
    const proto = u.protocol.replace(':', '');
    const redis = proto === 'redis' || proto === 'rediss';
    F.driver.value = redis ? 'redis' : 'postgresql';
    applyDriver(F.driver.value, false);
    if (u.hostname) F.host.value = u.hostname;
    if (u.port) F.port.value = u.port; // explicit port wins over the default
    const db = decodeURIComponent(u.pathname.replace(/^\\//, ''));
    if (db) F.database.value = db;
    if (u.username) F.user.value = decodeURIComponent(u.username);
    if (u.password) { F.password.value = decodeURIComponent(u.password); passwordTouched = true; }
    const mode = u.searchParams.get('sslmode');
    F.ssl.checked = proto === 'rediss' ? true : (!!mode && mode !== 'disable');
    if (!F.name.value) F.name.value = (F.user.value ? F.user.value + '@' : '') + F.host.value + (db ? '/' + db : '');
    $('url').value = '';
    clearStatus();
  });

  $('test').addEventListener('click', () => {
    clearStatus();
    vscode.postMessage({ type: 'test', conn: gather(), password: F.password.value });
  });
  $('save').addEventListener('click', () => {
    vscode.postMessage({ type: 'save', conn: gather(), password: F.password.value, passwordTouched });
  });
  $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'load') {
      const c = m.conn || {};
      editId = c.id;
      F.driver.value = isRedis(c.driver) ? 'redis' : 'postgresql';
      F.name.value = c.name || '';
      F.host.value = c.host || '';
      F.port.value = c.port || (isRedis(c.driver) ? 6379 : 5432);
      F.database.value = c.database || '';
      F.user.value = c.user || '';
      F.password.value = '';
      F.ssl.checked = !!c.ssl;
      applyDriver(F.driver.value, true);
      passwordTouched = false;
      clearStatus();
      const editing = m.mode === 'edit';
      $('title').textContent = editing ? 'Edit connection' : 'Add connection';
      $('pwhint').textContent = editing
        ? 'Leave blank to keep the existing password. Stored in the OS keychain, never synced.'
        : 'Stored in the OS keychain, never synced.';
      F.password.placeholder = editing ? 'unchanged' : '';
      F.host.focus();
    } else if (m.type === 'testing') {
      setStatus('ok', 'Testing,');
      $('status').className = 'status ok';
    } else if (m.type === 'testResult') {
      setStatus(m.ok ? 'ok' : 'err', m.message);
    }
  });
</script>
</body>
</html>`;
  }
}
