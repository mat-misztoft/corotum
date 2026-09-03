import { expect, test } from "bun:test";
import { persistAccountDisplayLabel } from "./account-label";

test("successful GitHub lookup stores the login on the account row", async () => {
  const updates: string[] = [];
  const db = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              updates.push(`${query}:${values.join(",")}`);
            },
          };
        },
      };
    },
  };
  const get: typeof fetch = async () =>
    new Response(JSON.stringify({ login: "ada" }), {
      headers: { "content-type": "application/json" },
    });
  expect(
    await persistAccountDisplayLabel(
      db as never,
      {
        id: "acc_1",
        providerId: "github",
        accountId: "123",
      },
      get,
    ),
  ).toBe("ada");
  expect(updates).toEqual([
    "UPDATE account SET display_label = ? WHERE id = ?:ada,acc_1",
  ]);
});
