import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkDocs,
  cliCommandsFromSource,
  documentedToolmirrorCommands,
  recommendsGlobalInitSource,
  REQUIRED_DOC_FILES,
  withoutUpgradeSection,
} from "./docs-check";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("docs-check", () => {
  test("extracts registered CLI commands including remove and unmanage", () => {
    const names = cliCommandsFromSource(`
      program.command("init <repository|cloud>")
      program.command("login")
      .command("cli-update")
    `);
    expect(names).toContain("init");
    expect(names).toContain("login");
    expect(names).toContain("cli-update");
    expect(names).toContain("remove");
    expect(names).toContain("unmanage");
  });

  test("does not treat global flags as commands", () => {
    expect(
      documentedToolmirrorCommands(
        "`corotum --json sync` and `corotum --non-interactive status`",
      ),
    ).toEqual(["status", "sync"]);
  });

  test("the product docs pass the public documentation gate", async () => {
    expect(await checkDocs(root)).toEqual([]);
  });

  test("new-format docs do not recommend legacy write formats or global init --source", () => {
    expect(recommendsGlobalInitSource("`corotum init --source owner/skills`")).toBe(
      true,
    );
    expect(
      recommendsGlobalInitSource(
        "`corotum adopt review --source owner/skills`",
      ),
    ).toBe(false);
    const upgradeOnly = `
# Migration
Use corotum.yaml.

## Upgrade from ToolMirror

Old toolmirror.yaml and toolmirror.lock remain readable.

## Next
Done.
`;
    expect(withoutUpgradeSection(upgradeOnly)).not.toContain("toolmirror.yaml");
    expect(withoutUpgradeSection(upgradeOnly)).toContain("corotum.yaml");
  });

  test("rejects invented CLI commands and self-host Creem requirements", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "corotum-docs-"));
    for (const relative of REQUIRED_DOC_FILES) {
      await mkdir(join(fixture, relative, ".."), { recursive: true });
      await writeFile(
        join(fixture, relative),
        await readFile(join(root, relative)),
      );
    }
    await mkdir(join(fixture, "apps/cli/src"), { recursive: true });
    await mkdir(join(fixture, "apps/web/src"), { recursive: true });
    await writeFile(
      join(fixture, "apps/cli/src/cli.ts"),
      await readFile(join(root, "apps/cli/src/cli.ts")),
    );
    for (const name of [
      "add-command.ts",
      "adopt-command.ts",
      "cli-update-command.ts",
      "cloud-auth-command.ts",
      "config-command.ts",
      "init-command.ts",
      "migrate-command.ts",
      "remove-command.ts",
      "restore-command.ts",
      "set-ref-command.ts",
      "sync-command.ts",
      "update-command.ts",
    ]) {
      await writeFile(
        join(fixture, "apps/cli/src", name),
        await readFile(join(root, "apps/cli/src", name)),
      );
    }
    await writeFile(
      join(fixture, "apps/web/src/webmcp.ts"),
      await readFile(join(root, "apps/web/src/webmcp.ts")),
    );

    await writeFile(
      join(fixture, "docs/cli.md"),
      `${await readFile(join(root, "docs/cli.md"))}\n\n\`corotum agents scan\`\n`,
    );
    await writeFile(
      join(fixture, "docs/self-hosting.md"),
      `${await readFile(join(root, "docs/self-hosting.md"))}\nCREEM_API_KEY=required\n`,
    );

    const findings = await checkDocs(fixture);
    expect(findings.some((finding) => finding.message.includes("agents"))).toBe(
      true,
    );
    expect(
      findings.some((finding) => finding.message.includes("CREEM_API_KEY")),
    ).toBe(true);

    await writeFile(
      join(fixture, "docs/cli.md"),
      `${await readFile(join(root, "docs/cli.md"))}\nWrite toolmirror.yaml\n\n\`corotum init --source owner/skills\`\n`,
    );
    const legacy = await checkDocs(fixture);
    expect(
      legacy.some((finding) => finding.message.includes("toolmirror.yaml")),
    ).toBe(true);
    expect(
      legacy.some((finding) => finding.message.includes("init --source")),
    ).toBe(true);
  });
});
