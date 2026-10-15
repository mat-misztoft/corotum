import type { AuthEnvironment } from "./auth";
import { hasHostedCloudAccess, isHostedCloud } from "./billing";
import type { RateLimitKind } from "./rate-limit";

export type RevisionEvent = {
  workspaceId: string;
  revisionId: string;
  revisionSequence: number;
};
export type EventsService = {
  fetch(request: Request): Promise<Response>;
  publish(event: RevisionEvent, authorizedTokenIds: string[]): Promise<void>;
  invalidateWorkspace(workspaceId: string): Promise<void>;
  invalidateDevice(workspaceId: string, deviceId: string): Promise<void>;
  invalidateUser(workspaceIds: string[]): Promise<void>;
};
export type RequestRateLimiter = {
  limit(input: { key: string }): Promise<{ success: boolean }>;
};

/** Request-scoped adapter: plain/fake databases keep working without runtime bindings. */
export function eventDatabase(env: AuthEnvironment) {
  const db = env.DB;
  return {
    prepare: db.prepare.bind(db),
    batch: db.batch.bind(db),
    async rateLimitRequest(kind: RateLimitKind, key: string) {
      const limiter = {
        normal: env.CLOUD_READ_LIMITER,
        mutation: env.CLOUD_WRITE_LIMITER,
        pairingAuth: env.CLOUD_AUTH_LIMITER,
      }[kind];
      if (!limiter) throw new Error("Cloud rate limiting binding is required");
      return limiter.limit({ key });
    },
    async revisionCommitted(event: RevisionEvent) {
      if (!env.EVENTS) return;
      const workspace = await db
        .prepare("SELECT owner_user_id AS userId FROM workspaces WHERE id = ?")
        .bind(event.workspaceId)
        .first<{ userId: string }>();
      if (
        !workspace ||
        !(await hasHostedCloudAccess(
          db as never,
          workspace.userId,
          isHostedCloud(env),
        ))
      ) {
        await env.EVENTS.invalidateWorkspace(event.workspaceId);
        return;
      }
      const { results } = await db
        .prepare(`SELECT t.id AS tokenId FROM device_tokens t
        JOIN devices d ON d.id = t.device_id
        JOIN device_workspaces dw ON dw.device_id = d.id
        WHERE dw.workspace_id = ? AND dw.is_active = 1 AND d.user_id = ? AND d.revoked_at IS NULL
          AND t.revoked_at IS NULL`)
        .bind(event.workspaceId, workspace.userId)
        .all<{ tokenId: string }>();
      await env.EVENTS.publish(
        event,
        results.map((row) => row.tokenId),
      );
    },
    async invalidateEvents(scope: { deviceId?: string; userId?: string }) {
      if (!env.EVENTS) return;
      if (scope.deviceId) {
        const { results } = await db
          .prepare(
            "SELECT workspace_id AS workspaceId FROM device_workspaces WHERE device_id = ?",
          )
          .bind(scope.deviceId)
          .all<{ workspaceId: string }>();
        for (const row of results)
          await env.EVENTS.invalidateDevice(row.workspaceId, scope.deviceId);
      } else if (scope.userId) {
        const { results } = await db
          .prepare("SELECT id FROM workspaces WHERE owner_user_id = ?")
          .bind(scope.userId)
          .all<{ id: string }>();
        for (const row of results) await env.EVENTS.invalidateWorkspace(row.id);
      }
    },
  };
}
