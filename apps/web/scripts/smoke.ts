const port = 8788;
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
    !landing.includes("RECONCILE")
  ) {
    throw new Error("landing state flow did not render through workerd");
  }
} finally {
  process.kill();
  await process.exited;
}
