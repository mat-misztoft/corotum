import { expect, test } from "bun:test";
import {
  ensureDefaultWorkspace,
  requireWorkspaceAccess,
  type Workspace,
  WorkspaceAccessError,
} from "./workspaces";

function database() {
  const rows = new Map<string, Workspace>();
  return {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          const [first, second] = values as [string, string];
          const byOwner =
            query.includes("owner_user_id = ?") &&
            !query.includes("id = ? AND");
          return {
            async first<T>() {
              const value = byOwner
                ? [...rows.values()].find(
                    (workspace) => workspace.ownerUserId === first,
                  )
                : [...rows.values()].find(
                    (workspace) =>
                      workspace.id === first &&
                      workspace.ownerUserId === second,
                  );
              return (value ?? null) as T | null;
            },
            async run() {
              if (query.startsWith("INSERT")) {
                const [id, ownerUserId, name] = values as [
                  string,
                  string,
                  string,
                ];
                if (
                  ![...rows.values()].some(
                    (workspace) => workspace.ownerUserId === ownerUserId,
                  )
                )
                  rows.set(id, { id, ownerUserId, name });
              }
              return {};
            },
            async all<T>() {
              return { results: [] as T[] };
            },
          };
        },
      };
    },
  };
}

test("OAuth user provisioning creates exactly one reusable default workspace", async () => {
  const db = database();
  const first = await ensureDefaultWorkspace(db, "github-user");
  const second = await ensureDefaultWorkspace(db, "github-user");
  expect(first).toEqual(second);
  expect(first).toMatchObject({
    ownerUserId: "github-user",
    name: "My workspace",
  });
  expect(first.id).toStartWith("ws_");
});

test("workspace access is scoped to its owner", async () => {
  const db = database();
  const workspace = await ensureDefaultWorkspace(db, "google-user");
  await expect(
    requireWorkspaceAccess(db, "google-user", workspace.id),
  ).resolves.toEqual(workspace);
  await expect(
    requireWorkspaceAccess(db, "other-user", workspace.id),
  ).rejects.toBeInstanceOf(WorkspaceAccessError);
});
