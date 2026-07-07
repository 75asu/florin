import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import type { Connection } from './store';

// The vault is a directory Florin owns INSIDE a Git repo the user controls.
// Everything except passwords lives here as plain files, so it doubles as a
// browsable, version-controlled backup that follows you across machines.
//
//   <repoRoot>/<subdir>/
//     manifest.json
//     connections/<slug>.<id8>.json   (metadata, never a password)
//     queries/<group>/<name>.sql
//
// Git is driven by shelling out to the user's own `git`, so it inherits the
// repo's existing auth and per-folder identity. No tokens are ever stored.

const MANIFEST = { name: 'florin-vault', schema: 1 };
const SYNC_DEBOUNCE_MS = 2500;

export interface SavedQuery {
  group: string;
  name: string;
  sql: string;
}

export class Vault {
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingMessage = 'florin: update vault';

  private cfg() {
    return vscode.workspace.getConfiguration('florin');
  }

  get repoRoot(): string | undefined {
    const p = this.cfg().get<string>('vault.path')?.trim();
    return p ? p : undefined;
  }

  get subdir(): string {
    return this.cfg().get<string>('vault.subdir')?.trim() || 'florin';
  }

  get autoSync(): boolean {
    return this.cfg().get<boolean>('vault.autoSync') ?? true;
  }

  get configured(): boolean {
    return !!this.repoRoot;
  }

  get dir(): string | undefined {
    return this.repoRoot ? path.join(this.repoRoot, this.subdir) : undefined;
  }

  async setPath(p: string): Promise<void> {
    await this.cfg().update('vault.path', p, vscode.ConfigurationTarget.Global);
  }

  // ---- git plumbing --------------------------------------------------------

  private git(args: string[]): Promise<{ code: number; out: string; err: string }> {
    const root = this.repoRoot!;
    return new Promise((resolve) => {
      execFile('git', ['-C', root, ...args], { timeout: 30000 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? ((err as unknown as { code: number }).code) : 1) : 0;
        resolve({ code, out: stdout?.toString() ?? '', err: stderr?.toString() ?? '' });
      });
    });
  }

  async isRepo(): Promise<boolean> {
    if (!this.repoRoot) {
      return false;
    }
    const r = await this.git(['rev-parse', '--is-inside-work-tree']);
    return r.code === 0 && r.out.trim() === 'true';
  }

  async clone(url: string, parentDir: string, repoName: string): Promise<string> {
    const target = path.join(parentDir, repoName);
    await new Promise<void>((resolve, reject) => {
      execFile('git', ['clone', url, target], { timeout: 120000 }, (err, _o, stderr) => {
        err ? reject(new Error(stderr?.toString() || err.message)) : resolve();
      });
    });
    return target;
  }

  async pull(): Promise<void> {
    if (!this.autoSync || !(await this.isRepo())) {
      return;
    }
    await this.git(['pull', '--rebase', '--autostash']);
  }

  scheduleSync(message: string): void {
    if (!this.autoSync) {
      return;
    }
    this.pendingMessage = message;
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }
    this.syncTimer = setTimeout(() => void this.syncNow(), SYNC_DEBOUNCE_MS);
  }

  async syncNow(): Promise<void> {
    if (!(await this.isRepo())) {
      return;
    }
    await this.git(['add', '--', this.subdir]);
    const status = await this.git(['status', '--porcelain', '--', this.subdir]);
    if (!status.out.trim()) {
      return; // nothing to commit
    }
    // Commit ONLY our subdir (pathspec), so we never sweep up unrelated staged
    // changes the user has elsewhere in the repo.
    await this.git(['commit', '-m', this.pendingMessage, '--', this.subdir]);
    const push = await this.git(['push']);
    if (push.code !== 0) {
      vscode.window.showWarningMessage(`Florin: vault saved locally but push failed. ${firstLine(push.err)}`);
    }
  }

  // ---- layout --------------------------------------------------------------

  async init(): Promise<void> {
    if (!this.dir) {
      return;
    }
    await fs.mkdir(path.join(this.dir, 'connections'), { recursive: true });
    await fs.mkdir(path.join(this.dir, 'queries'), { recursive: true });
    const manifest = path.join(this.dir, 'manifest.json');
    try {
      await fs.access(manifest);
    } catch {
      await fs.writeFile(manifest, JSON.stringify(MANIFEST, null, 2) + '\n');
    }
  }

  // ---- connections ---------------------------------------------------------

  private connectionsDir(): string {
    return path.join(this.dir!, 'connections');
  }

  async readConnections(): Promise<Connection[]> {
    if (!this.dir) {
      return [];
    }
    let files: string[];
    try {
      files = await fs.readdir(this.connectionsDir());
    } catch {
      return [];
    }
    const conns: Connection[] = [];
    for (const f of files.filter((n) => n.endsWith('.json'))) {
      try {
        const raw = await fs.readFile(path.join(this.connectionsDir(), f), 'utf8');
        const c = JSON.parse(raw) as Connection;
        if (c && c.id && c.name && c.driver) {
          conns.push(c);
        }
      } catch {
        /* skip malformed */
      }
    }
    conns.sort((a, b) => a.name.localeCompare(b.name));
    return conns;
  }

  // Write (or overwrite) a connection, deduping by id so renames don't orphan.
  async writeConnection(conn: Connection): Promise<void> {
    if (!this.dir) {
      return;
    }
    await this.init();
    await this.deleteConnection(conn.id);
    const file = `${slugify(conn.name) || 'connection'}.${conn.id.slice(0, 8)}.json`;
    await fs.writeFile(path.join(this.connectionsDir(), file), JSON.stringify(conn, null, 2) + '\n');
  }

  async deleteConnection(id: string): Promise<void> {
    if (!this.dir) {
      return;
    }
    const suffix = `.${id.slice(0, 8)}.json`;
    let files: string[];
    try {
      files = await fs.readdir(this.connectionsDir());
    } catch {
      return;
    }
    await Promise.all(
      files.filter((f) => f.endsWith(suffix)).map((f) => fs.rm(path.join(this.connectionsDir(), f), { force: true })),
    );
  }

  // ---- query library -------------------------------------------------------

  private queriesDir(): string {
    return path.join(this.dir!, 'queries');
  }

  async saveQuery(group: string, name: string, sql: string): Promise<void> {
    if (!this.dir) {
      return;
    }
    await this.init();
    const groupDir = path.join(this.queriesDir(), slugify(group) || 'scratch');
    await fs.mkdir(groupDir, { recursive: true });
    const file = `${slugify(name) || 'query'}.sql`;
    await fs.writeFile(path.join(groupDir, file), sql.endsWith('\n') ? sql : sql + '\n');
  }

  async renameQuery(group: string, oldName: string, newName: string): Promise<void> {
    if (!this.dir) {
      return;
    }
    const dir = path.join(this.queriesDir(), slugify(group) || 'scratch');
    const from = path.join(dir, `${slugify(oldName) || 'query'}.sql`);
    const to = path.join(dir, `${slugify(newName) || 'query'}.sql`);
    await fs.rename(from, to);
  }

  async deleteQuery(group: string, name: string): Promise<void> {
    if (!this.dir) {
      return;
    }
    const dir = path.join(this.queriesDir(), slugify(group) || 'scratch');
    await fs.rm(path.join(dir, `${slugify(name) || 'query'}.sql`), { force: true });
    // Drop the group folder if it's now empty.
    try {
      if ((await fs.readdir(dir)).length === 0) {
        await fs.rmdir(dir);
      }
    } catch {
      /* ignore */
    }
  }

  async listQueries(): Promise<SavedQuery[]> {
    if (!this.dir) {
      return [];
    }
    const out: SavedQuery[] = [];
    let groups: string[];
    try {
      groups = await fs.readdir(this.queriesDir());
    } catch {
      return [];
    }
    for (const group of groups) {
      const groupPath = path.join(this.queriesDir(), group);
      let files: string[];
      try {
        if (!(await fs.stat(groupPath)).isDirectory()) {
          continue;
        }
        files = await fs.readdir(groupPath);
      } catch {
        continue;
      }
      for (const f of files.filter((n) => n.endsWith('.sql'))) {
        try {
          const sql = await fs.readFile(path.join(groupPath, f), 'utf8');
          out.push({ group, name: f.replace(/\.sql$/, ''), sql });
        } catch {
          /* skip */
        }
      }
    }
    return out;
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function firstLine(s: string): string {
  return (s || '').split('\n').find((l) => l.trim()) ?? '';
}
