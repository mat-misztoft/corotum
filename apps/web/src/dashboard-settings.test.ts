import { expect, test } from "bun:test";
import { handleDashboardSettingsGet, readDashboardSettings } from "./dashboard-settings";

const db = {
  prepare() {
    return {
      bind() {
        return {
          async first() {
            return { interval: "year", status: "active", currentPeriodEnd: 1_900_000_000_000 };
          },
        };
      },
    };
  },
};

test("dashboard settings exposes only the authenticated user's billing state", async () => {
  expect((await handleDashboardSettingsGet(db as never, null, true)).status).toBe(401);
  expect(await readDashboardSettings(db as never, "user_1", true)).toEqual({
    hosted: true,
    subscription: { interval: "year", status: "active", currentPeriodEnd: 1_900_000_000_000 },
  });
});

test("self-hosted settings expose no billing controls", async () => {
  expect(await readDashboardSettings(db as never, "user_1", false)).toEqual({
    hosted: false,
    subscription: null,
  });
});
