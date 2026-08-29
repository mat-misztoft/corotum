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

  const home = await fetch(`http://127.0.0.1:${port}/`);
  const landing = await home.text();
  if (
    !home.ok ||
    !landing.includes("Keep your agent skills in sync.") ||
    !landing.includes("One state. Everywhere.") ||
    !landing.includes("From skill to synced state.") ||
    !landing.includes("RECONCILE") ||
    !landing.includes("One ToolMirror. Two ways to sync.") ||
    !landing.includes("TOOLMIRROR CLI") ||
    !landing.includes("DESIRED STATE") ||
    !landing.includes("GIT SYNC / FREE") ||
    !landing.includes("$5.99/month · $59.90/year") ||
    !landing.includes("toolmirror migrate cloud") ||
    !landing.includes("toolmirror migrate git") ||
    !landing.includes("Your Git credentials stay local") ||
    !landing.includes("Hosted desired state") ||
    !landing.includes("No daemon, remote force-sync, or stored Git") ||
    !landing.includes("See every device at a glance.") ||
    !landing.includes("Mac Mini") ||
    !landing.includes("AUTH_REQUIRED") ||
    !landing.includes("DRIFTED") ||
    !landing.includes("One skill. Many agents.") ||
    !landing.includes("Claude Code") ||
    !landing.includes("desired state") ||
    !landing.includes("WebMCP") ||
    !landing.includes("Kiro CLI") ||
    !landing.includes("No remote force-sync.") ||
    landing.includes("sync_device") ||
    landing.includes("sync_all_devices")
  ) {
    throw new Error(
      "landing devices and agents sections did not render through workerd",
    );
  }
} finally {
  process.kill();
  await process.exited;
}
