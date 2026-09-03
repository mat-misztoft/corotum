import { jsonError } from "./api";
import { isLaunchFreePeriod } from "./billing";
import type { WorkspaceDatabase } from "./workspaces";

export type LinkedSignIn = Readonly<{
  providerId: string;
  label: string;
}>;

export type DashboardSettingsView = Readonly<{
  hosted: boolean;
  launchFreePeriod: boolean;
  email: string | null;
  accounts: LinkedSignIn[];
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
  const email =
    (
      await db
        .prepare("SELECT email FROM user WHERE id = ?")
        .bind(userId)
        .first<{ email: string }>()
    )?.email ?? null;
  const listed = await db
    .prepare(
      `SELECT provider_id AS providerId, account_id AS accountId,
              display_label AS displayLabel
       FROM account
       WHERE user_id = ? AND provider_id IN ('github', 'google')`,
    )
    .bind(userId)
    .all<{
      providerId: string;
      accountId: string;
      displayLabel: string | null;
    }>();
  const accounts = (listed.results ?? []).map((row) => ({
    providerId: row.providerId,
    label: row.displayLabel || row.accountId,
  }));
  if (!hosted) {
    return {
      hosted: false,
      launchFreePeriod: false,
      email,
      accounts,
      subscription: null,
    };
  }
  const subscription = await db
    .prepare(
      `SELECT billing_interval AS interval, status,
              current_period_end AS currentPeriodEnd
       FROM subscriptions WHERE user_id = ?`,
    )
    .bind(userId)
    .first<DashboardSettingsView["subscription"]>();
  return {
    hosted,
    launchFreePeriod: isLaunchFreePeriod(),
    email,
    accounts,
    subscription,
  };
}

export async function handleDashboardSettingsGet(
  db: WorkspaceDatabase,
  userId: string | null,
  hosted: boolean,
) {
  if (!userId) return jsonError("Authentication required", 401);
  return Response.json(await readDashboardSettings(db, userId, hosted));
}
