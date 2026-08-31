const listener = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(),
});
const port = listener.port;
listener.stop();

const process = Bun.spawn(
  ["bunx", "wrangler", "dev", "--port", `${port}`, "--ip", "127.0.0.1"],
  {
    cwd: `${import.meta.dir}/..`,
    stderr: "pipe",
    stdout: "pipe",
  },
);

const url = `http://127.0.0.1:${port}/api/health`;
let failure: unknown;
let healthy = false;

try {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok)
        throw new Error(`health endpoint returned ${response.status}`);
      const body = (await response.json()) as { status?: string };
      if (body.status !== "ok")
        throw new Error("health endpoint returned an invalid response");
      healthy = true;
      break;
    } catch (error) {
      failure = error;
      await Bun.sleep(100);
    }
  }

  if (!healthy) throw failure;

  const { smokeWorkerdEndpoints } = await import(
    "../../../tooling/release-endpoints"
  );
  const endpointErrors = await smokeWorkerdEndpoints(
    `http://127.0.0.1:${port}`,
  );
  if (endpointErrors.length > 0) {
    throw new Error(endpointErrors.join("; "));
  }

  const home = await fetch(`http://127.0.0.1:${port}/`);
  const landing = await home.text();
  const sectionOrder = [
    "Keep your agent skills in sync.",
    "One state. Everywhere.",
    "From skill to synced state.",
    "One Corotum. Two ways to sync.",
    "Choose your sync.",
    "See every device at a glance.",
    "One skill. Many agents.",
    "Set it once. Keep it in sync.",
  ];
  const sectionPositions = sectionOrder.map((copy) => landing.indexOf(copy));
  const ordered =
    sectionPositions.every((position) => position >= 0) &&
    sectionPositions.every(
      (position, index) =>
        index === 0 || position > (sectionPositions[index - 1] ?? -1),
    );
  if (
    !home.ok ||
    !ordered ||
    !landing.includes("RECONCILE") ||
    !landing.includes("GIT SYNC") ||
    !landing.includes("Hosted desired state") ||
    !landing.includes("Self-hosted Corotum Cloud is free under AGPLv3.") ||
    !landing.includes("hosted corotum.com service.") ||
    !landing.includes("Desktop") ||
    !landing.includes("AUTH_REQUIRED") ||
    !landing.includes("DRIFTED") ||
    !landing.includes("Claude Code") ||
    !landing.includes("desired state") ||
    !landing.includes("WebMCP") ||
    !landing.includes("Kiro CLI") ||
    !landing.includes("No remote force-sync.") ||
    !landing.includes(
      "Start with Corotum Cloud, or use your own Git repository for free.",
    ) ||
    !landing.includes("Start with Corotum Cloud") ||
    !landing.includes("View on GitHub") ||
    !landing.includes("curl -fsSL https://corotum.com/install.sh | sh") ||
    landing.includes("sync_device") ||
    landing.includes("sync_all_devices")
  ) {
    throw new Error(
      "landing pricing and section order did not render through workerd",
    );
  }
} finally {
  process.kill();
  await process.exited;
}
