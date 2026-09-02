import { ensureDefaultWorkspace, type WorkspaceDatabase } from "./workspaces";

const pairingLifetimeMs = 10 * 60 * 1000;
const userCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type PairingDevice = Readonly<{
  name: string;
  platform: string;
  architecture: string;
  cliVersion: string;
}>;

export type PairingStatus = "PENDING" | "APPROVED" | "EXPIRED" | "CONSUMED";

type PairingRow = Readonly<{
  id: string;
  deviceCodeHash: string;
  userCode: string;
  status: PairingStatus;
  expiresAt: number;
}>;

type RunResult = { meta?: { changes?: number } };
type BoundStatement = ReturnType<
  ReturnType<WorkspaceDatabase["prepare"]>["bind"]
>;
export type PairingDatabase = WorkspaceDatabase & {
  batch(statements: readonly BoundStatement[]): Promise<readonly RunResult[]>;
};

export class PairingNotFoundError extends Error {
  constructor() {
    super("Pairing not found");
    this.name = "PairingNotFoundError";
  }
}

export class PairingExpiredError extends Error {
  constructor() {
    super("Pairing has expired");
    this.name = "PairingExpiredError";
  }
}

export class PairingAlreadyApprovedError extends Error {
  constructor() {
    super("Pairing has already been approved");
    this.name = "PairingAlreadyApprovedError";
  }
}

export class InvalidPairingInputError extends Error {
  constructor() {
    super("Invalid pairing device details");
    this.name = "InvalidPairingInputError";
  }
}

function pairingId() {
  return `pair_${crypto.randomUUID()}`;
}

function deviceId() {
  return `dev_${crypto.randomUUID()}`;
}

function randomCode(length: number) {
  const values = crypto.getRandomValues(new Uint8Array(length));
  return [...values]
    .map((value) => userCodeAlphabet[value % userCodeAlphabet.length])
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

function validDevice(device: PairingDevice) {
  return [
    device.name,
    device.platform,
    device.architecture,
    device.cliVersion,
  ].every((value) => value.trim().length > 0 && value.length <= 128);
}

function normalizeUserCode(userCode: string) {
  return userCode.trim().toUpperCase();
}

export async function pairingIdForUserCode(
  db: PairingDatabase,
  userCode: string,
) {
  const row = await db
    .prepare("SELECT id FROM cli_pairings WHERE user_code = ?")
    .bind(normalizeUserCode(userCode))
    .first<{ id: string }>();
  return row?.id ?? null;
}

function isUniqueConstraint(error: unknown) {
  return error instanceof Error && /unique/i.test(error.message);
}

async function insertPairing(
  db: PairingDatabase,
  pairing: {
    id: string;
    deviceCodeHash: string;
    userCode: string;
    device: PairingDevice;
    expiresAt: number;
    createdAt: number;
  },
) {
  await db
    .prepare(
      "INSERT INTO cli_pairings (id, device_code_hash, user_code, status, device_name, platform, architecture, cli_version, expires_at, created_at) VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      pairing.id,
      pairing.deviceCodeHash,
      pairing.userCode,
      pairing.device.name.trim(),
      pairing.device.platform.trim(),
      pairing.device.architecture.trim(),
      pairing.device.cliVersion.trim(),
      pairing.expiresAt,
      pairing.createdAt,
    )
    .run();
}

export async function createPairing(
  db: PairingDatabase,
  device: PairingDevice,
  now = Date.now(),
) {
  if (!validDevice(device)) throw new InvalidPairingInputError();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const created = {
      id: pairingId(),
      deviceCode: `${randomCode(32)}${randomCode(32)}`,
      userCode: `${randomCode(4)}-${randomCode(4)}`,
      expiresAt: now + pairingLifetimeMs,
    };
    try {
      await insertPairing(db, {
        id: created.id,
        deviceCodeHash: await hash(created.deviceCode),
        userCode: created.userCode,
        device,
        expiresAt: created.expiresAt,
        createdAt: now,
      });
      return created;
    } catch (error) {
      if (!isUniqueConstraint(error) || attempt === 4) throw error;
    }
  }

  throw new Error("Unable to create pairing");
}

/** Approves a pending code and atomically creates its device and active workspace membership. */
export async function approvePairing(
  db: PairingDatabase,
  userId: string,
  pairingId: string,
  userCode: string,
  now = Date.now(),
) {
  const workspace = await ensureDefaultWorkspace(db, userId);
  const device = deviceId();
  const code = normalizeUserCode(userCode);
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO devices (id, user_id, name, platform, architecture, cli_version, created_at)
         SELECT ?, ?, device_name, platform, architecture, cli_version, ?
         FROM cli_pairings
         WHERE id = ? AND user_code = ? AND status = 'PENDING' AND expires_at > ?`,
      )
      .bind(device, userId, now, pairingId, code, now),
    db
      .prepare(
        `INSERT INTO device_workspaces (device_id, workspace_id, is_active, applied_revision_sequence, sync_status)
         SELECT ?, ?, 1, 0, 'NEVER_SYNCED'
         WHERE EXISTS (SELECT 1 FROM devices WHERE id = ? AND user_id = ?)`,
      )
      .bind(device, workspace.id, device, userId),
    db
      .prepare(
        `UPDATE cli_pairings
         SET status = 'APPROVED', user_id = ?, device_id = ?, approved_at = ?
         WHERE id = ? AND user_code = ? AND status = 'PENDING' AND expires_at > ?
           AND EXISTS (SELECT 1 FROM devices WHERE id = ? AND user_id = ?)`,
      )
      .bind(userId, device, now, pairingId, code, now, device, userId),
    db
      .prepare(
        `DELETE FROM devices
         WHERE id = ?
           AND NOT EXISTS (
             SELECT 1 FROM cli_pairings
             WHERE id = ? AND device_id = ? AND status = 'APPROVED'
           )`,
      )
      .bind(device, pairingId, device),
  ]);
  if ((results[2]?.meta?.changes ?? 0) === 1)
    return { deviceId: device, workspaceId: workspace.id };

  const pairing = await db
    .prepare(
      "SELECT id, status, expires_at AS expiresAt FROM cli_pairings WHERE id = ? AND user_code = ?",
    )
    .bind(pairingId, code)
    .first<Pick<PairingRow, "id" | "status" | "expiresAt">>();
  if (!pairing) throw new PairingNotFoundError();
  if (pairing.expiresAt <= now || pairing.status === "EXPIRED")
    throw new PairingExpiredError();
  if (pairing.status === "APPROVED" || pairing.status === "CONSUMED")
    throw new PairingAlreadyApprovedError();
  throw new PairingNotFoundError();
}

/** The CLI may poll only with its secret code; the secret itself is never persisted. */
export async function getPairingStatus(
  db: PairingDatabase,
  id: string,
  deviceCode: string,
  now = Date.now(),
) {
  const pairing = await db
    .prepare(
      "SELECT id, device_code_hash AS deviceCodeHash, user_code AS userCode, status, expires_at AS expiresAt FROM cli_pairings WHERE id = ?",
    )
    .bind(id)
    .first<PairingRow>();
  if (!pairing || !hashesMatch(await hash(deviceCode), pairing.deviceCodeHash))
    throw new PairingNotFoundError();
  if (pairing.expiresAt <= now && pairing.status === "PENDING") {
    await db
      .prepare(
        "UPDATE cli_pairings SET status = 'EXPIRED' WHERE id = ? AND status = 'PENDING'",
      )
      .bind(id)
      .run();
    return { status: "EXPIRED" as const };
  }
  return { status: pairing.status };
}
