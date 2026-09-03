import { expect, test } from "bun:test";
import {
  handleDashboardSettingsGet,
  readDashboardSettings,
} from "./dashboard-settings";

function db(displayLabel: string | null) {
  return {
    prepare(query: string) {
      return {
        bind() {
          return {
            async first() {
              if (query.includes("FROM user"))
                return { email: "ada@example.com" };
              return {
                interval: "year",
                status: "active",
                currentPeriodEnd: 1_900_000_000_000,
              };
            },
            async all() {
              return {
                results: [
                  {
                    providerId: "github",
                    accountId: "123",
                    displayLabel,
                  },
                ],
              };
            },
          };
        },
      };
    },
  };
}

test("dashboard settings exposes only the authenticated user's billing state", async () => {
  expect(
    (await handleDashboardSettingsGet(db(null) as never, null, true)).status,
  ).toBe(401);
  expect(await readDashboardSettings(db("octocat") as never, "user_1", true)).toEqual({
    hosted: true,
    launchFreePeriod: true,
    email: "ada@example.com",
    accounts: [
      { providerId: "github", accountId: "123", label: "octocat" },
    ],
    subscription: {
      interval: "year",
      status: "active",
      currentPeriodEnd: 1_900_000_000_000,
    },
  });
});

test("self-hosted settings expose no billing controls", async () => {
  expect(await readDashboardSettings(db(null) as never, "user_1", false)).toEqual({
    hosted: false,
    launchFreePeriod: false,
    email: "ada@example.com",
    accounts: [{ providerId: "github", accountId: "123", label: "123" }],
    subscription: null,
  });
});
