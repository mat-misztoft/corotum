import { PairingNotFoundError } from "./pairings";
import type { WorkspaceDatabase } from "./workspaces";

type RunResult = { meta?: { changes?: number } };
type BoundStatement = ReturnType<
  ReturnType<WorkspaceDatabase["prepare"]>["bind"]
>;
export type TokenDatabase = WorkspaceDatabase & {
  batch(statements: readonly BoundStatement[]): Promise<readonly RunResult[]>;
};

type PairingRow = Readonly<{
  deviceCodeHash: string;
  status: string;
  deviceId: string | null;
}>;

export class PairingNotApprovedError extends Error {
  constructor() {
    super("Pairing is not approved");
    this.name = "PairingNotApprovedError";
  }
}

export class TokenAlreadyIssuedError extends Error {
  constructor() {
    super("Device token has already been issued");
    this.name = "TokenAlreadyIssuedError";
  }
}

export class DeviceUnauthorizedError extends Error {
  constructor() {
    super("Device authentication failed");
    this.name = "DeviceUnauthorizedError";
  }
}

export class DeviceNotFoundError extends Error {
  constructor() {
    super("Device not found");
    this.name = "DeviceNotFoundError";
  }
}

function tokenId() {
  return `tok_${crypto.randomUUID()}`;
}

function randomToken() {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hash(value: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hashesMatch(left: string, right: string) {
  if (left.length !== right.length) return false;
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

/** Issues the long-lived device token once after browser approval. */
export async function issueDeviceToken(
  db: TokenDatabase,
  pairingId: string,
  deviceCode: string,
  now = Date.now(),
) {
  const pairing = await db
    .prepare(
      "SELECT device_code_hash AS deviceCodeHash, status, device_id AS deviceId FROM cli_pairings WHERE id = ?",
    )
    .bind(pairingId)
    .first<PairingRow>();
  if (!pairing || !hashesMatch(await hash(deviceCode), pairing.deviceCodeHash))
    throw new PairingNotFoundError();
  if (pairing.status === "PENDING") throw new PairingNotApprovedError();
  if (pairing.status === "CONSUMED") throw new TokenAlreadyIssuedError();
  if (pairing.status !== "APPROVED" || !pairing.deviceId)
    throw new PairingNotFoundError();

  const issued = {
    id: tokenId(),
    token: randomToken(),
    deviceId: pairing.deviceId,
  };
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO device_tokens (id, device_id, token_hash, created_at)
         SELECT ?, cli_pairings.device_id, ?, ?
         FROM cli_pairings
         JOIN devices ON devices.id = cli_pairings.device_id AND devices.revoked_at IS NULL
         WHERE cli_pairings.id = ? AND cli_pairings.status = 'APPROVED' AND cli_pairings.device_id = ?`,
      )
      .bind(
        issued.id,
        await hash(issued.token),
        now,
        pairingId,
        pairing.deviceId,
      ),
    db
      .prepare(
        `UPDATE cli_pairings
         SET status = 'CONSUMED'
         WHERE id = ? AND status = 'APPROVED' AND device_id = ?
           AND EXISTS (SELECT 1 FROM device_tokens WHERE id = ? AND device_id = ?)`,
      )
      .bind(pairingId, pairing.deviceId, issued.id, pairing.deviceId),
    db
      .prepare(
        `DELETE FROM device_tokens
         WHERE id = ?
           AND NOT EXISTS (
             SELECT 1 FROM cli_pairings
             WHERE id = ? AND device_id = ? AND status = 'CONSUMED'
           )`,
      )
      .bind(issued.id, pairingId, pairing.deviceId),
  ]);
  if ((results[1]?.meta?.changes ?? 0) === 1) {
    const membership = await db
      .prepare(
        "SELECT workspace_id AS workspaceId FROM device_workspaces WHERE device_id = ? AND is_active = 1",
      )
      .bind(pairing.deviceId)
      .first<{ workspaceId: string }>();
    return {
      token: issued.token,
      deviceId: pairing.deviceId,
      workspaceId: membership?.workspaceId ?? null,
    };
  }

  const consumed = await db
    .prepare("SELECT status FROM cli_pairings WHERE id = ?")
    .bind(pairingId)
    .first<{ status: string }>();
  if (consumed?.status === "CONSUMED") throw new TokenAlreadyIssuedError();
  const revoked = await db
    .prepare("SELECT revoked_at AS revokedAt FROM devices WHERE id = ?")
    .bind(pairing.deviceId)
    .first<{ revokedAt: number | null }>();
  if (revoked?.revokedAt) throw new DeviceNotFoundError();
  throw new PairingNotApprovedError();
}

/** Resolves a plaintext device token to its device without persisting the secret. */
export async function authenticateDeviceToken(
  db: TokenDatabase,
  token: string,
  now = Date.now(),
) {
  if (!token) throw new DeviceUnauthorizedError();
  const row = await db
    .prepare(
      `SELECT device_tokens.id AS tokenId,
              device_tokens.device_id AS deviceId,
              devices.user_id AS userId
       FROM device_tokens
       JOIN devices ON devices.id = device_tokens.device_id
       WHERE device_tokens.token_hash = ?
         AND device_tokens.revoked_at IS NULL
         AND devices.revoked_at IS NULL`,
    )
    .bind(await hash(token))
    .first<{ tokenId: string; deviceId: string; userId: string }>();
  if (!row) throw new DeviceUnauthorizedError();

  await db.batch([
    db
      .prepare(
        "UPDATE device_tokens SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL",
      )
      .bind(now, row.tokenId),
    db
      .prepare(
        "UPDATE devices SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL",
      )
      .bind(now, row.deviceId),
  ]);
  return { deviceId: row.deviceId, userId: row.userId };
}

/** Invalidates the presented token and leaves remote device rows in place. */
export async function logoutDeviceToken(
  db: TokenDatabase,
  token: string,
  now = Date.now(),
) {
  const authenticated = await authenticateDeviceToken(db, token, now);
  const result = await db
    .prepare(
      `UPDATE device_tokens
       SET revoked_at = ?
       WHERE token_hash = ? AND revoked_at IS NULL`,
    )
    .bind(now, await hash(token))
    .run();
  if ((result as RunResult).meta?.changes !== 1)
    throw new DeviceUnauthorizedError();
  return authenticated;
}

/** User revoke invalidates access for one device without deleting its remote data. */
export async function revokeDevice(
  db: TokenDatabase,
  userId: string,
  deviceId: string,
  now = Date.now(),
) {
  const device = await db
    .prepare("SELECT id, user_id AS userId FROM devices WHERE id = ?")
    .bind(deviceId)
    .first<{ id: string; userId: string }>();
  if (!device || device.userId !== userId) throw new DeviceNotFoundError();

  await db.batch([
    db
      .prepare(
        "UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
      )
      .bind(now, deviceId, userId),
    db
      .prepare(
        "UPDATE device_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL",
      )
      .bind(now, deviceId),
  ]);
  return { deviceId };
}
