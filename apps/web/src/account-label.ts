import type { WorkspaceDatabase } from "./workspaces";

export type AccountLabelRow = {
  id: string;
  providerId: string;
  accountId: string;
  accessToken?: string | null;
  displayLabel?: string | null;
};

export async function persistAccountDisplayLabel(
  db: WorkspaceDatabase,
  row: AccountLabelRow,
  get: typeof fetch = fetch,
) {
  if (row.displayLabel) return row.displayLabel;
  const label = await lookupAccountLabel(row, get);
  if (label !== row.accountId) {
    await db
      .prepare("UPDATE account SET display_label = ? WHERE id = ?")
      .bind(label, row.id)
      .run();
  }
  return label;
}

export async function lookupAccountLabel(
  row: AccountLabelRow,
  get: typeof fetch = fetch,
) {
  try {
    if (row.providerId === "github") {
      const response = await get(
        `https://api.github.com/user/${encodeURIComponent(row.accountId)}`,
        {
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "corotum",
          },
        },
      );
      if (response.ok) {
        const body = (await response.json()) as {
          login?: unknown;
          name?: unknown;
        };
        if (typeof body.login === "string" && body.login) return body.login;
        if (typeof body.name === "string" && body.name) return body.name;
      }
    }
    if (row.providerId === "google" && row.accessToken) {
      const response = await get(
        "https://openidconnect.googleapis.com/v1/userinfo",
        { headers: { authorization: `Bearer ${row.accessToken}` } },
      );
      if (response.ok) {
        const body = (await response.json()) as {
          email?: unknown;
          name?: unknown;
        };
        if (typeof body.email === "string" && body.email) return body.email;
        if (typeof body.name === "string" && body.name) return body.name;
      }
    }
  } catch {
    // Keep the provider account id when the profile lookup fails.
  }
  return row.accountId;
}
