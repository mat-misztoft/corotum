const portablePackages = ["packages/core", "packages/shared"] as const;

const bannedPackagePatterns: ReadonlyArray<readonly [RegExp, string]> = [
  [/^bun(?:$|:|\/)/, "Bun runtime"],
  [/^node:/, "Node.js builtin"],
  [
    /^(?:assert|buffer|child_process|cluster|console|constants|crypto|dgram|diagnostics_channel|dns|domain|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|sys|timers|tls|trace_events|tty|url|util|v8|vm|wasi|worker_threads|zlib)(?:$|\/)/,
    "Node.js builtin",
  ],
  [/^(?:git|simple-git)(?:$|\/)/, "Git infrastructure"],
  [
    /^@corotum\/(?:agent-targets|cli|git-provider|saas-provider|skills-adapter|web)(?:$|\/)/,
    "runtime-specific Corotum package",
  ],
  [
    /^(?:@cloudflare\/|cloudflare(?:$|\/)|workerd(?:$|\/)|workers(?:$|\/))/,
    "Cloudflare infrastructure",
  ],
  [
    /^(?:next|react|react-dom|preact|vue|svelte|@radix-ui\/)(?:$|\/)/,
    "UI infrastructure",
  ],
  [
    /^(?:better-auth|creem|drizzle-orm)(?:$|\/)/,
    "auth, billing, or database infrastructure",
  ],
];

export type BoundaryFinding = {
  file: string;
  source: string;
  reason: string;
};

const importPattern =
  /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;

export function isPortablePackageFile(file: string): boolean {
  return portablePackages.some((directory) => file.startsWith(`${directory}/`));
}

export function findBoundaryViolations(
  file: string,
  content: string,
): BoundaryFinding[] {
  if (!isPortablePackageFile(file)) return [];

  const findings: BoundaryFinding[] = [];
  for (const match of content.matchAll(importPattern)) {
    const source = match[1] ?? match[2] ?? match[3];
    const banned = bannedPackagePatterns.find(([pattern]) =>
      pattern.test(source),
    );
    if (banned) findings.push({ file, source, reason: banned[1] });
  }

  return findings;
}
