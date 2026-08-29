import { findBoundaryViolations } from "../tooling/architecture-boundaries.ts";

const root = `${process.cwd()}/`;
const extensions = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const findings = [];

for (const directory of ["packages/core", "packages/shared"]) {
  for await (const file of new Bun.Glob("**/*").scan({
    absolute: true,
    cwd: `${root}${directory}`,
  })) {
    if (!extensions.has(file.slice(file.lastIndexOf(".")))) continue;
    findings.push(
      ...findBoundaryViolations(
        file.slice(root.length),
        await Bun.file(file).text(),
      ),
    );
  }
}

if (findings.length > 0) {
  console.error("Portable package architecture boundary violations:");
  for (const finding of findings) {
    console.error(`- ${finding.file}: ${finding.source} (${finding.reason})`);
  }
  process.exit(1);
}

console.log("Architecture boundaries: PASS");
