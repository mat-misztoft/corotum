import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { skillId } from "../../../packages/core/src/index";
import { handleCreemWebhook } from "../src/billing-http";
import { CLI_VERSION_HEADER } from "../src/cli-compat";
import { handleDashboardGet } from "../src/dashboard-http";
import { approvePairing, createPairing } from "../src/pairings";
import { handlePutWorkspaceState } from "../src/state-http";
import { handlePostDeviceSyncReport } from "../src/sync-report-http";
import { issueDeviceToken } from "../src/tokens";
import {
  e2eDb,
  hostedEnv,
  selfHostedEnv,
  sign,
  startCloudServer,
  webhookSecret,
} from "./harness";

const evidencePath = fileURLToPath(
  new URL("./playwright-evidence.md", import.meta.url),
);

async function pairDevice(
  db: Awaited<ReturnType<typeof e2eDb>>["db"],
  name: string,
) {
  const pairing = await createPairing(db as never, {
    name,
    platform: "darwin",
    architecture: "arm64",
    cliVersion: "0.1.0",
  });
  await approvePairing(db as never, "user_1", pairing.id, pairing.userCode);
  return {
    pairing,
    ...(await issueDeviceToken(db, pairing.id, pairing.deviceCode)),
  };
}

async function withPlaywright<T>(
  run: (page: {
    goto: (url: string) => Promise<void>;
    text: () => Promise<string>;
    click: (selector: string) => Promise<void>;
    waitForText: (selector: string) => Promise<string>;
  }) => Promise<T>,
): Promise<T> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    return await run({
      goto: async (url) => {
        await page.goto(url, { waitUntil: "domcontentloaded" });
      },
      text: async () => page.locator("body").innerText(),
      click: async (selector) => {
        await page.click(selector);
      },
      waitForText: async (selector) => {
        await page.waitForFunction((target) => {
          const node = document.querySelector(target);
          return Boolean(node?.textContent?.trim());
        }, selector);
        return page.locator(selector).innerText();
      },
    });
  } finally {
    await browser.close();
  }
}

test("Playwright: pairing approval, hosted billing gate, and device status", async () => {
  const hosted = await e2eDb();
  const server = startCloudServer({
    db: hosted.db,
    hosted: true,
    env: hostedEnv,
  });
  const self = await e2eDb();
  const selfServer = startCloudServer({
    db: self.db,
    hosted: false,
    env: selfHostedEnv,
  });
  try {
    const pending = await createPairing(hosted.db as never, {
      name: "studio",
      platform: "darwin",
      architecture: "arm64",
      cliVersion: "0.1.0",
    });
    const approvedText = await withPlaywright(async (page) => {
      await page.goto(
        `${server.origin}/activate?pairing=${pending.id}&code=${pending.userCode}`,
      );
      await page.click("button");
      return page.waitForText("#status");
    });
    expect(approvedText).toContain("Device approved");

    const payload = JSON.stringify({
      id: "evt_playwright_paid",
      eventType: "subscription.paid",
      object: {
        id: "sub_pw",
        status: "active",
        customer: { id: "cus_ada" },
        metadata: { userId: "user_1", billingInterval: "month" },
      },
    });
    const webhook = await handleCreemWebhook(
      new Request("https://corotum.com/api/v1/webhooks/creem", {
        method: "POST",
        headers: { "creem-signature": await sign(payload, webhookSecret) },
        body: payload,
      }),
      hosted.db,
      hostedEnv,
    );
    expect(webhook.status).toBe(200);

    const laptop = await pairDevice(hosted.db, "laptop");
    const skill = skillId("sk_playwright");
    const created = await handlePutWorkspaceState(
      new Request(
        `https://corotum.com/api/v1/workspaces/${laptop.workspaceId}/state`,
        {
          method: "PUT",
          headers: {
            [CLI_VERSION_HEADER]: "0.1.0",
            "x-toolmirror-device-token": laptop.token,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            state: {
              manifest: {
                version: 1,
                skills: [
                  {
                    id: skill,
                    source: "https://github.com/example/skills.git",
                    skill: "review",
                    ref: "main",
                    targets: "all",
                    resolutionStatus: "RESOLVED",
                  },
                ],
              },
              lockfile: {
                version: 1,
                skills: [
                  {
                    id: skill,
                    source: "https://github.com/example/skills.git",
                    skill: "review",
                    ref: "main",
                    repository: "https://github.com/example/skills.git",
                    revision: "abc",
                    path: "review",
                    contentHash: "sha256:locked",
                  },
                ],
              },
            },
            baseRevision: null,
            idempotencyKey: "pw-add",
            transition: { type: "ADD", skillId: skill, metadata: {} },
          }),
        },
      ),
      hosted.db,
      laptop.workspaceId as string,
      true,
    );
    expect(created.status).toBe(200);
    const report = await handlePostDeviceSyncReport(
      new Request(
        `https://corotum.com/api/v1/devices/${laptop.deviceId}/sync-report`,
        {
          method: "POST",
          headers: {
            [CLI_VERSION_HEADER]: "0.1.0",
            "x-toolmirror-device-token": laptop.token,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            appliedRevisionId: null,
            syncStatus: "BEHIND",
          }),
        },
      ),
      hosted.db,
      laptop.deviceId,
      true,
    );
    expect(report.status).toBe(200);
    expect(
      await handleDashboardGet(hosted.db as never, "user_1"),
    ).toMatchObject({ status: 200 });

    const hostedDashboard = await withPlaywright(async (page) => {
      await page.goto(`${server.origin}/dashboard/billing`);
      await page.waitForText("#billing");
      return page.text();
    });
    expect(hostedDashboard).toContain("Current subscription: active");
    expect(hostedDashboard).toContain("NEVER_SYNCED");
    expect(hostedDashboard).toContain("BEHIND");

    await pairDevice(self.db, "studio");
    const selfDashboard = await withPlaywright(async (page) => {
      await page.goto(`${selfServer.origin}/dashboard/billing`);
      await page.waitForText("#billing");
      return page.text();
    });
    expect(selfDashboard).toContain(
      "This is a self-hosted Corotum Cloud instance. Cloud functionality is free and has no billing portal.",
    );
    expect(selfDashboard).not.toContain("Current subscription");

    await writeFile(
      evidencePath,
      `# Playwright critical browser flows

| Flow | Expected | Result |
| --- | --- | --- |
| Pairing approval | Browser submits user code and shows Device approved | PASS |
| Hosted billing | Dashboard shows Current subscription: active | PASS |
| Device status | Unsynced device stays NEVER_SYNCED; reporter without apply stays BEHIND | PASS |
| Self-hosted billing | Dashboard states Cloud is free and has no billing portal | PASS |
`,
    );
  } finally {
    server.stop();
    selfServer.stop();
  }
}, 30_000);
