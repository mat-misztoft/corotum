import { describe, expect, test } from "bun:test";
import { findBoundaryViolations } from "./architecture-boundaries";

describe("portable package architecture boundaries", () => {
  test("rejects Bun, Node, filesystem, Git, Cloudflare, UI, auth, and billing imports", () => {
    const content = [
      'import { file } from "bun";',
      'import { readFile } from "node:fs";',
      'import path from "path";',
      'import git from "simple-git";',
      'import { pull } from "@corotum/git-provider";',
      'import { env } from "@cloudflare/workers-types";',
      'import React from "react";',
      'import { auth } from "better-auth";',
      'import { checkout } from "creem";',
    ].join("\n");

    expect(
      findBoundaryViolations("packages/core/src/domain.ts", content),
    ).toEqual([
      expect.objectContaining({ source: "bun", reason: "Bun runtime" }),
      expect.objectContaining({ source: "node:fs", reason: "Node.js builtin" }),
      expect.objectContaining({ source: "path", reason: "Node.js builtin" }),
      expect.objectContaining({
        source: "simple-git",
        reason: "Git infrastructure",
      }),
      expect.objectContaining({
        source: "@corotum/git-provider",
        reason: "runtime-specific Corotum package",
      }),
      expect.objectContaining({
        source: "@cloudflare/workers-types",
        reason: "Cloudflare infrastructure",
      }),
      expect.objectContaining({ source: "react", reason: "UI infrastructure" }),
      expect.objectContaining({
        source: "better-auth",
        reason: "auth, billing, or database infrastructure",
      }),
      expect.objectContaining({
        source: "creem",
        reason: "auth, billing, or database infrastructure",
      }),
    ]);
  });

  test("allows portable imports and ignores approved runtime-specific packages", () => {
    expect(
      findBoundaryViolations(
        "packages/shared/src/models.ts",
        'import { z } from "zod";\nexport { z } from "zod";',
      ),
    ).toEqual([]);
    expect(
      findBoundaryViolations(
        "apps/cli/src/index.ts",
        'import { file } from "bun";',
      ),
    ).toEqual([]);
    expect(
      findBoundaryViolations(
        "apps/web/src/app.tsx",
        'import React from "react";',
      ),
    ).toEqual([]);
  });
});
