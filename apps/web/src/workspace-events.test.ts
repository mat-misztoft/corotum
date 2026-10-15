import { expect, test } from "bun:test";
import type { AuthEnvironment } from "./auth";
import { type EventsService, eventDatabase } from "./workspace-events";

test("publish revalidates entitlement and supplies active token membership before broadcasting metadata", async () => {
  const queries: string[] = [];
  const published: unknown[] = [];
  const db = {
    prepare(query: string) {
      queries.push(query);
      return {
        bind() {
          return {
            async first() {
              return { userId: "user_1" };
            },
            async all() {
              return { results: [{ tokenId: "tok_valid" }] };
            },
          };
        },
      };
    },
    batch() {},
  };
  const events = {
    async publish(...args: unknown[]) {
      published.push(args);
    },
  } as unknown as EventsService;
  const adapted = eventDatabase({
    DB: db,
    EVENTS: events,
  } as unknown as AuthEnvironment);
  const event = {
    workspaceId: "ws_1",
    revisionId: "rev_1",
    revisionSequence: 7,
  };
  await adapted.revisionCommitted(event);
  expect(published).toEqual([[event, ["tok_valid"]]]);
  expect(queries.join(" ")).toContain("dw.is_active = 1");
  expect(queries.join(" ")).toContain("t.revoked_at IS NULL");
  expect(queries.join(" ")).not.toMatch(
    /manifest_json|lockfile_json|workspace_artifacts/,
  );
});

test("native request protection performs no D1 reads or writes", async () => {
  const keys: string[] = [];
  const env = {
    DB: {
      prepare() {
        throw new Error("D1 must not be used");
      },
      batch() {},
    },
    CLOUD_READ_LIMITER: {
      async limit({ key }: { key: string }) {
        keys.push(key);
        return { success: true };
      },
    },
  };
  expect(
    await eventDatabase(env as unknown as AuthEnvironment).rateLimitRequest(
      "normal",
      "normal:ip:1",
    ),
  ).toEqual({ success: true });
  expect(keys).toEqual(["normal:ip:1"]);
});
