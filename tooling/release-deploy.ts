import { fileURLToPath } from "node:url";

function requiredEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

const requireDeploy = process.env.RELEASE_REQUIRE_DEPLOY === "1";
const token = requiredEnv("CLOUDFLARE_API_TOKEN");
const accountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID");

if (!token) {
  if (requireDeploy) {
    console.error(
      "CLOUDFLARE_API_TOKEN is required to deploy the workerd service.",
    );
    process.exit(1);
  }
  console.log("Workerd deploy skipped (no CLOUDFLARE_API_TOKEN).");
  process.exit(0);
}

const preflight = Bun.spawn(["bun", "./tooling/release-email-config.ts"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});
if ((await preflight.exited) !== 0) {
  console.error(
    "Production email configuration failed; deployment must not continue.",
  );
  process.exit(1);
}

const args = ["wrangler", "deploy"];
const env: Record<string, string> = {
  ...process.env,
  CLOUDFLARE_API_TOKEN: token,
};
if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;

const proc = Bun.spawn(["bunx", ...args], {
  cwd: fileURLToPath(new URL("../apps/web", import.meta.url)),
  stdout: "inherit",
  stderr: "inherit",
  env,
});
const code = await proc.exited;
if (code !== 0) {
  console.error(
    "Workerd deploy failed; release publication must not continue.",
  );
  process.exit(code);
}
console.log("Workerd deploy: PASS");
