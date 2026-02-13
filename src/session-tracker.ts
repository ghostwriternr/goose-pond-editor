import { DurableObject } from "cloudflare:workers";

const MAX_CONCURRENT = 20;
const LEASE_TTL_MS = 2 * 60 * 1000;

export class SessionTracker extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS leases (
					lease_id TEXT PRIMARY KEY,
					expires_at INTEGER NOT NULL
				)
			`);
    });
  }

  async acquire(
    leaseId: string,
  ): Promise<{ leaseId: string; expiresAt: number } | null> {
    this.evictExpired();

    const row = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) as count FROM leases")
      .one();

    if (row.count >= MAX_CONCURRENT) return null;

    const expiresAt = Date.now() + LEASE_TTL_MS;
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO leases (lease_id, expires_at) VALUES (?, ?)",
      leaseId,
      expiresAt,
    );

    this.scheduleNextAlarm();
    return { leaseId, expiresAt };
  }

  async release(leaseId: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM leases WHERE lease_id = ?", leaseId);
    this.scheduleNextAlarm();
  }

  async renew(leaseId: string): Promise<{ expiresAt: number } | null> {
    const expiresAt = Date.now() + LEASE_TTL_MS;
    const cursor = this.ctx.storage.sql.exec(
      "UPDATE leases SET expires_at = ? WHERE lease_id = ? RETURNING lease_id",
      expiresAt,
      leaseId,
    );

    if (cursor.toArray().length === 0) return null;

    this.scheduleNextAlarm();
    return { expiresAt };
  }

  async getActive(): Promise<number> {
    this.evictExpired();
    return this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) as count FROM leases")
      .one().count;
  }

  async alarm(): Promise<void> {
    this.evictExpired();
    this.scheduleNextAlarm();
  }

  private evictExpired(): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM leases WHERE expires_at < ?",
      Date.now(),
    );
  }

  private scheduleNextAlarm(): void {
    const row = this.ctx.storage.sql
      .exec<{
        next: number | null;
      }>("SELECT MIN(expires_at) as next FROM leases")
      .one();

    if (row.next) {
      this.ctx.storage.setAlarm(row.next);
    }
  }
}
