import { expect, test } from "bun:test";
import { umamiAssets } from "./umami";

test("umamiAssets builds tracker urls and skips empty env", () => {
  expect(umamiAssets()).toBeNull();
  expect(umamiAssets(" ", "id")).toBeNull();
  expect(umamiAssets("https://stats.example/", " site-id ")).toEqual({
    script: "https://stats.example/script.js",
    recorder: "https://stats.example/recorder.js",
    websiteId: "site-id",
  });
});
