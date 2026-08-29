import { expect, test } from "bun:test";
import { isSameOrigin, jsonError, readJson } from "./api";

test("browser POSTs must match the request origin while CLI requests without Origin pass", () => {
  const url = "https://toolmirror.com/api/v1/cli/pairings/pair_1/approve";
  expect(
    isSameOrigin(
      new Request(url, { headers: { origin: "https://toolmirror.com" } }),
    ),
  ).toBe(true);
  expect(
    isSameOrigin(
      new Request(url, { headers: { origin: "https://evil.example" } }),
    ),
  ).toBe(false);
  expect(isSameOrigin(new Request(url))).toBe(true);
});

test("JSON helpers return parsed bodies or compact API errors", async () => {
  expect(
    await readJson(
      new Request("https://toolmirror.com", {
        method: "POST",
        body: '{"userCode":"ABCD-EFGH"}',
      }),
    ),
  ).toEqual({ userCode: "ABCD-EFGH" });
  expect(
    await readJson(
      new Request("https://toolmirror.com", { method: "POST", body: "{" }),
    ),
  ).toBeNull();

  const response = jsonError("Pairing not found", 404);
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "Pairing not found" });
});
