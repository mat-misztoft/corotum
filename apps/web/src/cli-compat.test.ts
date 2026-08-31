import { expect, test } from "bun:test";
import {
  CLI_VERSION_HEADER,
  cliVersionFrom,
  incompatibleCliResponse,
  isCompatibleCliVersion,
  MIN_CLOUD_CLI_VERSION,
} from "./cli-compat";

test("Cloud accepts the current minimum CLI version and newer releases", () => {
  expect(MIN_CLOUD_CLI_VERSION).toBe("0.1.0");
  expect(isCompatibleCliVersion("0.1.0")).toBe(true);
  expect(isCompatibleCliVersion("0.1.1")).toBe(true);
  expect(isCompatibleCliVersion("1.0.0")).toBe(true);
});

test("Cloud rejects missing, invalid, and older CLI versions", () => {
  expect(isCompatibleCliVersion(null)).toBe(false);
  expect(isCompatibleCliVersion("")).toBe(false);
  expect(isCompatibleCliVersion("latest")).toBe(false);
  expect(isCompatibleCliVersion("0.0.9")).toBe(false);
  expect(isCompatibleCliVersion("0.0.1")).toBe(false);
});

test("incompatible CLIs receive HTTP 426 before any other Cloud payload", async () => {
  const request = new Request("https://corotum.com/api/v1/cli/pairings");
  expect(cliVersionFrom(request)).toBeNull();
  expect(CLI_VERSION_HEADER).toBe("x-toolmirror-cli-version");
  const response = incompatibleCliResponse();
  expect(response.status).toBe(426);
  expect(await response.json()).toEqual({
    error: "CLI upgrade required",
    minVersion: "0.1.0",
  });
});
