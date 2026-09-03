"use client";

import { useEffect } from "react";

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint: boolean };
  execute: (
    input: Record<string, unknown>,
    options: { signal: AbortSignal },
  ) => Promise<string>;
};

type ModelContext = {
  registerTool: (
    tool: Tool,
    options?: { signal: AbortSignal },
  ) => Promise<void>;
};

const readOnlyTools = [
  "list_skills",
  "list_devices",
  "get_sync_status",
  "check_skill_updates",
] as const;

async function callTool(
  tool: string,
  arguments_: Record<string, unknown>,
  signal: AbortSignal,
) {
  const body: Record<string, unknown> = { tool };
  if (!readOnlyTools.includes(tool as (typeof readOnlyTools)[number])) {
    const dashboard = await fetch("/api/v1/dashboard", { signal });
    const state = (await dashboard.json()) as {
      revision?: { id: string | null };
      error?: string;
    };
    if (!dashboard.ok) return JSON.stringify(state);
    body.baseRevisionId = state.revision?.id ?? null;
    body.idempotencyKey = crypto.randomUUID();
    body.arguments = arguments_;
  }
  const response = await fetch("/api/v1/webmcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  return JSON.stringify(await response.json());
}

const schema = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const dashboardTools: Omit<Tool, "execute">[] = [
  ...readOnlyTools.map((name) => ({
    name,
    description: {
      list_skills:
        "Use to list, show, inspect, or summarize skills in the current workspace.",
      list_devices:
        "Use to list, show, or inspect paired devices in the current workspace.",
      get_sync_status:
        "Use to inspect the device-reported sync status of the current workspace.",
      check_skill_updates:
        "Use to inspect device-reported skill update checks without contacting Git.",
    }[name],
    inputSchema: schema({}),
    annotations: { readOnlyHint: true },
  })),
  {
    name: "add_skill",
    description:
      "Add a skill to Cloud desired state. Devices apply it only after their local corotum sync.",
    inputSchema: schema(
      {
        source: {
          type: "string",
          description: "Git source, for example owner/repository.",
        },
        skill: { type: "string", description: "Skill name." },
        ref: { type: "string", description: "Optional Git ref." },
        path: {
          type: "string",
          description: "Optional path in the source repository.",
        },
        targets: {
          oneOf: [
            { const: "all" },
            { type: "array", items: { type: "string" } },
          ],
        },
      },
      ["source", "skill"],
    ),
  },
  {
    name: "remove_skill",
    description:
      "Remove a skill from Cloud desired state. This does not remotely run sync on a device.",
    inputSchema: schema(
      { skillId: { type: "string", description: "The skill id to remove." } },
      ["skillId"],
    ),
  },
  {
    name: "update_skill",
    description:
      "Request an update of a skill in Cloud desired state. Devices reconcile only during local sync.",
    inputSchema: schema(
      { skillId: { type: "string", description: "The skill id to update." } },
      ["skillId"],
    ),
  },
  {
    name: "set_skill_ref",
    description:
      "Set a skill Git ref in Cloud desired state. The result can be pending resolution.",
    inputSchema: schema(
      {
        skillId: { type: "string", description: "The skill id to retarget." },
        ref: { type: "string", description: "The Git ref to use." },
      },
      ["skillId", "ref"],
    ),
  },
];

/** Registers browser-local WebMCP tools; authorization remains enforced by the existing API. */
export function WebMcpTools() {
  useEffect(() => {
    const modelContext = (
      document as Document & { modelContext?: ModelContext }
    ).modelContext;
    if (!modelContext) return;
    const controller = new AbortController();
    const registered = dashboardTools.map((tool) => ({
      ...tool,
      execute: (
        input: Record<string, unknown>,
        { signal }: { signal: AbortSignal },
      ) => callTool(tool.name, input, signal),
    }));
    void Promise.all(
      registered.map((tool) =>
        modelContext.registerTool(tool, { signal: controller.signal }),
      ),
    ).catch((error: unknown) => {
      if (!controller.signal.aborted)
        console.warn("WebMCP tool registration failed", error);
    });
    return () => controller.abort();
  }, []);
  return null;
}
