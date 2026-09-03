import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const REQUIRED_DOC_FILES = [
  "README.md",
  "apps/docs/src/content/docs/index.md",
  "apps/docs/src/content/docs/getting-started/install.md",
  "apps/docs/src/content/docs/cli/commands.md",
  "apps/docs/src/content/docs/concepts/skills.md",
  "apps/docs/src/content/docs/concepts/git-sync.md",
  "apps/docs/src/content/docs/cloud/self-hosting.md",
  "apps/docs/src/content/docs/cloud/hosted.md",
  "apps/docs/src/content/docs/webmcp/dashboard-and-webmcp.md",
  "apps/docs/src/content/docs/guides/migration.md",
] as const;

const LEGACY_WRITE_FORMATS = [
  "toolmirror.yaml",
  "toolmirror.lock",
] as const;

const SELF_HOST_FORBIDDEN_ENV = [
  "CREEM_API_KEY",
  "CREEM_WEBHOOK_SECRET",
  "CREEM_PRODUCT_MONTHLY",
  "CREEM_PRODUCT_ANNUAL",
  "CREEM_API_URL",
] as const;

const HOSTED_REQUIRED_ENV = [
  "CREEM_API_KEY",
  "CREEM_WEBHOOK_SECRET",
  "CREEM_PRODUCT_MONTHLY",
  "CREEM_PRODUCT_ANNUAL",
] as const;

const EXTRA_CLI_COMMANDS = ["remove", "unmanage"] as const;

export type DocsCheckFinding = Readonly<{
  file: string;
  message: string;
}>;

/** Collects Commander command names actually registered by the CLI. */
export function cliCommandsFromSource(source: string): readonly string[] {
  const names = new Set<string>(EXTRA_CLI_COMMANDS);
  for (const match of source.matchAll(/\.command\(\s*["'`]([a-z][\w-]*)/g)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

export function webMcpToolsFromSource(source: string): readonly string[] {
  return [
    ...source.matchAll(
      /"(list_skills|list_devices|get_sync_status|check_skill_updates|add_skill|remove_skill|update_skill|set_skill_ref)"/g,
    ),
  ].map((match) => match[1]);
}

function markdownCode(markdown: string): string {
  return [...markdown.matchAll(/```[\s\S]*?```|`[^`]+`/g)]
    .map((match) => match[0])
    .join("\n");
}

/** Drops the ToolMirror upgrade section so legacy filenames may appear only there. */
export function withoutUpgradeSection(markdown: string): string {
  return markdown.replace(
    /## Upgrade from ToolMirror[\s\S]*?(?=\n## |$)/,
    "",
  );
}

/** True when docs show init with a global `--source` flag. */
export function recommendsGlobalInitSource(markdown: string): boolean {
  return /(?:^|\s)(?:corotum\s+)?init\b[^\n`]*--source\b/m.test(
    markdownCode(markdown),
  );
}

export function documentedToolmirrorCommands(
  markdown: string,
): readonly string[] {
  const names = new Set<string>();
  for (const match of markdownCode(markdown).matchAll(
    /corotum(?:\s+(?:--json|--non-interactive))*\s+([a-z][\w-]*)/g,
  )) {
    names.add(match[1]);
  }
  return [...names].sort();
}

export function documentedWebMcpTools(markdown: string): readonly string[] {
  return [
    ...new Set(
      [...markdown.matchAll(/`([a-z_]+)`/g)]
        .map((match) => match[1])
        .filter((name) =>
          /^(list_skills|list_devices|get_sync_status|check_skill_updates|add_skill|remove_skill|update_skill|set_skill_ref)$/.test(
            name,
          ),
        ),
    ),
  ].sort();
}

function includesAll(haystack: string, needles: readonly string[]): string[] {
  const plain = haystack.replaceAll(/[`*]/g, "").toLowerCase();
  return needles.filter(
    (needle) => !plain.includes(needle.replaceAll(/[`*]/g, "").toLowerCase()),
  );
}

/** Returns human-readable findings. Empty means the public docs gate passed. */
export async function checkDocs(
  root: string,
): Promise<readonly DocsCheckFinding[]> {
  const findings: DocsCheckFinding[] = [];
  const files = new Map<string, string>();

  for (const relative of REQUIRED_DOC_FILES) {
    try {
      files.set(relative, await readFile(join(root, relative), "utf8"));
    } catch {
      findings.push({
        file: relative,
        message: "Required documentation file is missing.",
      });
    }
  }
  if (findings.length > 0) return findings;

  const cliSource = [
    await readFile(join(root, "apps/cli/src/cli.ts"), "utf8"),
    ...(await readCommandSources(join(root, "apps/cli/src"))),
  ].join("\n");
  const registered = new Set(cliCommandsFromSource(cliSource));
  const webmcpSource = await readFile(
    join(root, "apps/web/src/webmcp.ts"),
    "utf8",
  );
  const webmcpTools = new Set(webMcpToolsFromSource(webmcpSource));

  const corpus = [...files.values()].join("\n");
  for (const phrase of [
    "binaries are unsigned",
    "no daemon",
    "remote forced sync",
    "official installer",
    "Cloud Sync is the current workstream",
    "full product surface",
  ]) {
    if (!corpus.toLowerCase().includes(phrase.toLowerCase())) {
      findings.push({
        file: "docs/",
        message: `Documentation must state: ${phrase}.`,
      });
    }
  }

  const cliDocs = files.get("apps/docs/src/content/docs/cli/commands.md") ?? "";
  for (const missing of includesAll(cliDocs, [
    "reports the applied revision",
    "PENDING_RESOLUTION",
    "add",
    "adopt",
    "remove",
    "unmanage",
    "restore",
    "update",
    "set-ref",
  ])) {
    findings.push({
      file: "apps/docs/src/content/docs/cli/commands.md",
      message: `Missing Cloud Sync CLI coverage: ${missing}.`,
    });
  }

  const dashboard = files.get("apps/docs/src/content/docs/webmcp/dashboard-and-webmcp.md") ?? "";
  for (const missing of includesAll(dashboard, [
    "full product surface",
    "reports the applied revision",
    "PENDING_RESOLUTION",
  ])) {
    findings.push({
      file: "apps/docs/src/content/docs/webmcp/dashboard-and-webmcp.md",
      message: `Missing Cloud dashboard coverage: ${missing}.`,
    });
  }

  const selfHost = files.get("apps/docs/src/content/docs/cloud/self-hosting.md") ?? "";
  for (const missing of includesAll(selfHost, [
    "Creem is not required",
    "hosted Corotum billing is not required",
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "wrangler d1",
    "AGPL",
    "GitHub OAuth",
    "Google OAuth",
  ])) {
    findings.push({
      file: "apps/docs/src/content/docs/cloud/self-hosting.md",
      message: `Missing required self-hosting coverage: ${missing}.`,
    });
  }
  for (const env of SELF_HOST_FORBIDDEN_ENV) {
    if (selfHost.includes(env)) {
      findings.push({
        file: "apps/docs/src/content/docs/cloud/self-hosting.md",
        message: `Self-hosting docs must not require ${env}. Creem is hosted-only.`,
      });
    }
  }
  if (/COROTUM_HOSTED["']?\s*[:=]\s*["']true["']/.test(selfHost)) {
    findings.push({
      file: "apps/docs/src/content/docs/cloud/self-hosting.md",
      message: "Self-hosting docs must not set COROTUM_HOSTED to true.",
    });
  }

  const hosted = files.get("apps/docs/src/content/docs/cloud/hosted.md") ?? "";
  for (const missing of includesAll(hosted, [
    "Creem",
    "checkout",
    "$5.99",
    "$59.90",
    "billing portal",
    "entitlement",
    "month",
    "year",
  ])) {
    findings.push({
      file: "apps/docs/src/content/docs/cloud/hosted.md",
      message: `Missing hosted billing coverage: ${missing}.`,
    });
  }
  for (const env of HOSTED_REQUIRED_ENV) {
    if (!hosted.includes(env)) {
      findings.push({
        file: "apps/docs/src/content/docs/cloud/hosted.md",
        message: `Hosted docs must document ${env}.`,
      });
    }
  }

  for (const [file, markdown, required] of [
    [
      "apps/docs/src/content/docs/cloud/hosted.md",
      hosted,
      [
        "Email Sending",
        "sending domain",
        "DNS",
        "AUTH_EMAIL_FROM=auth@corotum.com",
        "send_email",
        "EMAIL",
        "does not need a separate email API key",
        "beta",
      ],
    ],
    [
      "apps/docs/src/content/docs/cloud/self-hosting.md",
      selfHost,
      [
        "own email-delivery configuration",
        "Corotum-owned Cloudflare Email Service resources",
        "AUTH_EMAIL_FROM=auth@corotum.com",
        "EMAIL is not a `.dev.vars` secret",
        "does not require an email API key",
        "Creem",
      ],
    ],
  ] as const) {
    for (const missing of includesAll(markdown, required)) {
      findings.push({
        file,
        message: `Missing email authentication documentation: ${missing}.`,
      });
    }
  }

  const install = files.get("apps/docs/src/content/docs/getting-started/install.md") ?? "";
  for (const missing of includesAll(install, [
    "curl -fsSL https://corotum.com/install.sh | sh",
    "irm https://corotum.com/install.ps1 | iex",
    "corotum cli-update",
    "corotum cli-update --check",
    "SHA-256",
  ])) {
    findings.push({
      file: "apps/docs/src/content/docs/getting-started/install.md",
      message: `Missing installer coverage: ${missing}.`,
    });
  }

  const migrate = files.get("apps/docs/src/content/docs/guides/migration.md") ?? "";
  for (const missing of includesAll(migrate, [
    "corotum migrate cloud",
    "corotum migrate git",
    "--strategy",
    "corotum migrate legacy",
    "corotum migrate legacy-cleanup",
  ])) {
    findings.push({
      file: "apps/docs/src/content/docs/guides/migration.md",
      message: `Missing migration coverage: ${missing}.`,
    });
  }

  const skills = files.get("apps/docs/src/content/docs/concepts/skills.md") ?? "";
  for (const missing of includesAll(skills, [
    "~/.agents/skills",
    ".skill-lock.json",
    "source: null",
    "--allow-artifacts",
    ".corotumignore",
    "CONFIRMATION_REQUIRED",
    "DENYLISTED_PATH",
    "corotum.yaml",
    "corotum.lock",
  ])) {
    findings.push({
      file: "apps/docs/src/content/docs/concepts/skills.md",
      message: `Missing v2 contract coverage: ${missing}.`,
    });
  }

  for (const [relative, markdown] of files) {
    const searchable =
      relative === "apps/docs/src/content/docs/guides/migration.md"
        ? withoutUpgradeSection(markdown)
        : markdown;
    for (const phrase of LEGACY_WRITE_FORMATS) {
      if (searchable.includes(phrase)) {
        findings.push({
          file: relative,
          message: `New-format docs must not recommend ${phrase}.`,
        });
      }
    }
    if (recommendsGlobalInitSource(searchable)) {
      findings.push({
        file: relative,
        message: "New-format docs must not recommend global init --source.",
      });
    }
  }

  for (const [relative, markdown] of files) {
    for (const command of documentedToolmirrorCommands(markdown)) {
      if (!registered.has(command)) {
        findings.push({
          file: relative,
          message: `Documented command \`corotum ${command}\` is not registered in the CLI.`,
        });
      }
    }
    for (const tool of documentedWebMcpTools(markdown)) {
      if (!webmcpTools.has(tool)) {
        findings.push({
          file: relative,
          message: `Documented WebMCP tool \`${tool}\` is not implemented.`,
        });
      }
    }
  }

  return findings;
}

async function readCommandSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory);
  const files = entries.filter((name) => name.endsWith("-command.ts"));
  return Promise.all(
    files.map((name) => readFile(join(directory, name), "utf8")),
  );
}

async function main(): Promise<void> {
  const root = join(import.meta.dir, "..");
  const findings = await checkDocs(root);
  if (findings.length === 0) {
    console.log("docs:check passed");
    return;
  }
  for (const finding of findings) {
    console.error(`${finding.file}: ${finding.message}`);
  }
  process.exitCode = 1;
}

if (import.meta.main) {
  await main();
}
