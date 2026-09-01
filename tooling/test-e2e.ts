export {};

const pattern = Bun.argv.slice(2).join(" ");
const command = ["bun", "test", "apps/web/e2e"];
if (pattern) command.push("--test-name-pattern", pattern);

const child = Bun.spawn(command, {
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env, COROTUM_EMAIL_AUTH_E2E: "1" },
});
process.exitCode = await child.exited;
