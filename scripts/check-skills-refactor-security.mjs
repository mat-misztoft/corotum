#!/usr/bin/env bun

const files = [
  "packages/skills-adapter/src/artifact-archive.test.ts",
  "packages/skills-adapter/src/normalized-content.test.ts",
  "packages/skills-adapter/src/git-source.test.ts",
  "packages/skills-adapter/src/exact-materializer.test.ts",
  "packages/core/src/index.test.ts",
  "apps/cli/src/local-state.test.ts",
  "apps/cli/src/logs.test.ts",
  "apps/web/src/artifacts.test.ts",
  "apps/web/e2e/security.test.ts",
  "tooling/architecture-boundaries.test.ts",
];

const test = Bun.spawn(["bun", "test", ...files], {
  stdout: "inherit",
  stderr: "inherit",
});
const testCode = await test.exited;
if (testCode !== 0) process.exit(testCode);

const boundaries = Bun.spawn(["bun", "./scripts/check-architecture-boundaries.mjs"], {
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await boundaries.exited);
