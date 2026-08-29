import { jsonError } from "./api";
import type { WorkspaceDatabase } from "./workspaces";

export type DashboardSettingsView = Readonly<{
  hosted: boolean;
  subscription: {
    interval: "month" | "year";
    status: string;
    currentPeriodEnd: number | null;
  } | null;
}>;

/** Telemetry stays local to the CLI. */
export async function readDashboardSettings(
  db: WorkspaceDatabase,
  userId: string,
  hosted: boolean,
): Promise<DashboardSettingsView> {
  if (!hosted) return { hosted: false, subscription: null };
  const subscription = await db
    .prepare(
      `SELECT billing_interval AS interval, status,
              current_period_end AS currentPeriodEnd
       FROM subscriptions WHERE user_id = ?`,
    )
    .bind(userId)
    .first<DashboardSettingsView["subscription"]>();
  return { hosted, subscription };
}

export async function handleDashboardSettingsGet(
  db: WorkspaceDatabase,
  userId: string | null,
  hosted: boolean,
) {
  if (!userId) return jsonError("Authentication required", 401);
  return Response.json(await readDashboardSettings(db, userId, hosted));
}
