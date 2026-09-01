export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export async function smokeWorkerdEndpoints(
  origin: string,
  fetchImpl: FetchLike = fetch,
  options: { requireAuth?: boolean; requireCliGate?: boolean } = {},
): Promise<string[]> {
  const errors: string[] = [];
  const base = origin.replace(/\/$/, "");

  const health = await fetchImpl(`${base}/api/health`);
  if (!health.ok) {
    errors.push(`health endpoint returned ${health.status}`);
  } else {
    const body = (await health.json()) as { status?: string };
    if (body.status !== "ok")
      errors.push("health endpoint returned an invalid response");
  }

  const installSh = await fetchImpl(`${base}/install.sh`);
  const installShText = installSh.ok ? await installSh.text() : "";
  if (
    !installSh.ok ||
    !installShText.includes("Official Corotum installer") ||
    !installShText.includes("v0.1 binaries are unsigned")
  ) {
    errors.push("docs installer endpoint /install.sh failed");
  }

  const installPs1 = await fetchImpl(`${base}/install.ps1`);
  const installPs1Text = installPs1.ok ? await installPs1.text() : "";
  if (
    !installPs1.ok ||
    !installPs1Text.toLowerCase().includes("official") ||
    !installPs1Text.includes("unsigned")
  ) {
    errors.push("docs installer endpoint /install.ps1 failed");
  }

  const pairings = await fetchImpl(`${base}/api/v1/cli/pairings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (pairings.status >= 500) {
    errors.push(`API pairing endpoint returned ${pairings.status}`);
  } else if (options.requireCliGate && pairings.status !== 426) {
    errors.push(`API pairing gate returned ${pairings.status}, expected 426`);
  }

  if (options.requireAuth) {
    const session = await fetchImpl(`${base}/api/auth/get-session`);
    if (session.status >= 500) {
      errors.push(`auth session endpoint returned ${session.status}`);
    }
  }

  return errors;
}

export async function smokeReleaseManifest(
  releaseBase: string,
  fetchImpl: FetchLike = fetch,
): Promise<string[]> {
  const errors: string[] = [];
  const base = releaseBase.replace(/\/$/, "");
  const response = await fetchImpl(`${base}/releases/latest.json`);
  if (!response.ok) {
    return [`release endpoint latest.json returned ${response.status}`];
  }
  let latest: {
    channel?: string;
    unsigned?: boolean;
    final?: boolean;
    notes?: string;
    version?: string;
  };
  try {
    latest = (await response.json()) as typeof latest;
  } catch {
    return ["release endpoint latest.json is not valid JSON"];
  }
  if (
    latest.channel === "pipeline-proof" ||
    latest.notes?.includes("pipeline-proof")
  ) {
    errors.push("pipeline-proof artifacts must not be reused");
  }
  if (latest.final !== true) errors.push("latest.json must be marked final");
  if (latest.unsigned !== true) errors.push("latest.json must remain unsigned");
  if (typeof latest.version !== "string")
    errors.push("latest.json is missing version");
  return errors;
}

const origin = process.env.COROTUM_SMOKE_ORIGIN;
const releaseBase = process.env.COROTUM_RELEASE_BASE;
const isMain = import.meta.main;

if (isMain) {
  if (!origin) {
    console.error("COROTUM_SMOKE_ORIGIN is required");
    process.exitCode = 1;
  } else {
    const errors = [
      ...(await smokeWorkerdEndpoints(origin, fetch, {
        requireAuth: process.env.RELEASE_REQUIRE_AUTH_SMOKE === "1",
        requireCliGate: process.env.RELEASE_REQUIRE_AUTH_SMOKE === "1",
      })),
      ...(releaseBase ? await smokeReleaseManifest(releaseBase) : []),
    ];
    if (errors.length > 0) {
      console.error("Endpoint smoke failed:");
      for (const error of errors) console.error(`- ${error}`);
      process.exitCode = 1;
    } else {
      console.log(`Endpoint smoke: PASS (${origin})`);
    }
  }
}
