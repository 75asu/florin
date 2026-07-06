import * as vscode from 'vscode';
import type { Vault } from './vault';

// A stored connection holds everything EXCEPT the password.
// The password lives in the OS keychain (SecretStorage), which never syncs.
export interface Connection {
  id: string;
  name: string;
  driver: string; // e.g. "postgresql"
  host: string;
  port: number;
  database: string;
  user: string;
}

// The globalState key we persist connections under. We opt this key into
// VS Code Settings Sync as a zero-config fallback; the git vault (when
// configured) is the real source of truth and browsable backup.
export const CONNECTIONS_KEY = 'florin.connections';

export class ConnectionStore {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly vault: Vault,
  ) {
    context.globalState.setKeysForSync([CONNECTIONS_KEY]);
  }

  all(): Connection[] {
    return this.context.globalState.get<Connection[]>(CONNECTIONS_KEY, []);
  }

  get(id: string): Connection | undefined {
    return this.all().find((c) => c.id === id);
  }

  async add(conn: Connection, password: string): Promise<void> {
    const conns = this.all();
    conns.push(conn);
    await this.context.globalState.update(CONNECTIONS_KEY, conns);
    if (password) {
      await this.context.secrets.store(this.pwKey(conn.id), password);
    }
    if (this.vault.configured) {
      await this.vault.writeConnection(conn);
      this.vault.scheduleSync(`florin: add connection ${conn.name}`);
    }
  }

  async rename(id: string, name: string): Promise<void> {
    const conns = this.all();
    const conn = conns.find((c) => c.id === id);
    if (!conn) {
      return;
    }
    conn.name = name;
    await this.context.globalState.update(CONNECTIONS_KEY, conns);
    if (this.vault.configured) {
      await this.vault.writeConnection(conn);
      this.vault.scheduleSync(`florin: rename connection ${name}`);
    }
  }

  async remove(id: string): Promise<void> {
    const removed = this.get(id);
    const conns = this.all().filter((c) => c.id !== id);
    await this.context.globalState.update(CONNECTIONS_KEY, conns);
    await this.context.secrets.delete(this.pwKey(id));
    if (this.vault.configured) {
      await this.vault.deleteConnection(id);
      this.vault.scheduleSync(`florin: remove connection ${removed?.name ?? id}`);
    }
  }

  password(id: string): Thenable<string | undefined> {
    return this.context.secrets.get(this.pwKey(id));
  }

  // Pull the vault and adopt its connections as the source of truth.
  async loadFromVault(): Promise<void> {
    if (!this.vault.configured) {
      return;
    }
    await this.vault.pull();
    const conns = await this.vault.readConnections();
    await this.context.globalState.update(CONNECTIONS_KEY, conns);
  }

  // First time a vault is chosen: push whatever is already on this machine
  // into it, then adopt the merged set.
  async migrateIntoVault(): Promise<void> {
    if (!this.vault.configured) {
      return;
    }
    await this.vault.init();
    for (const conn of this.all()) {
      await this.vault.writeConnection(conn);
    }
    await this.vault.syncNow();
    await this.loadFromVault();
  }

  private pwKey(id: string): string {
    return `florin.pw.${id}`;
  }
}
