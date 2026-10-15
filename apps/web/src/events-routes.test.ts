import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("actual Cloudflare route exports authenticate HTTP, publish writes and invalidate logout", async () => {
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      fileURLToPath(
        new URL("../scripts/events-route-check.ts", import.meta.url),
      ),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout).toContain("Actual route HTTP integration: PASS");
});
