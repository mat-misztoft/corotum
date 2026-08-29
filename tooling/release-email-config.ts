import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

type WranglerSecret = Readonly<{ name?: string }>;

const workerDirectory = fileURLToPath(new URL("../apps/web", import.meta.url));
const workerName = "toolmirror-web";

export function emailReleaseConfigurationErrors(input: {
  authEmailFrom?: string;
  config: unknown;
  remoteSecrets: readonly WranglerSecret[];
}): string[] {
  const errors: string[] = [];
  const sender = input.authEmailFrom?.trim();
  if (!sender) {
    errors.push(
      "AUTH_EMAIL_FROM is required for the production email release.",
    );
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) {
    errors.push("AUTH_EMAIL_FROM must be a valid email address.");
  }

  if (!hasEmailBinding(input.config)) {
    errors.push(
      "EMAIL Worker binding is required for the production email release.",
    );
  }
  if (
    !input.remoteSecrets.some((secret) => secret.name === "AUTH_EMAIL_FROM")
  ) {
    errors.push("AUTH_EMAIL_FROM is not configured on the deployed Worker.");
  }
  return errors;
}

function hasEmailBinding(config: unknown) {
  if (!config || typeof config !== "object") return false;
  const bindings = (config as { send_email?: unknown }).send_email;
  return (
    Array.isArray(bindings) &&
    bindings.some(
      (binding) =>
        binding &&
        typeof binding === "object" &&
        (binding as { name?: unknown }).name === "EMAIL",
    )
  );
}

async function listRemoteSecrets(): Promise<WranglerSecret[]> {
  const proc = Bun.spawn(
    [
      "bunx",
      "wrangler",
      "secret",
      "list",
      "--name",
      workerName,
      "--format",
      "json",
    ],
    {
      cwd: workerDirectory,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
  ]);
  if (code !== 0) {
    throw new Error(
      "Could not validate AUTH_EMAIL_FROM on the deployed Worker.",
    );
  }
  try {
    const secrets: unknown = JSON.parse(stdout);
    if (!Array.isArray(secrets)) throw new Error();
    return secrets.filter(
      (secret): secret is WranglerSecret =>
        Boolean(secret) && typeof secret === "object",
    );
  } catch {
    throw new Error(
      "Could not validate AUTH_EMAIL_FROM on the deployed Worker.",
    );
  }
}

export async function validateEmailReleaseConfiguration() {
  const [configText, remoteSecrets] = await Promise.all([
    readFile(new URL("../apps/web/wrangler.jsonc", import.meta.url), "utf8"),
    listRemoteSecrets(),
  ]);
  const errors = emailReleaseConfigurationErrors({
    authEmailFrom: process.env.AUTH_EMAIL_FROM,
    config: JSON.parse(configText),
    remoteSecrets,
  });
  if (errors.length > 0) throw new Error(errors.join("\n"));
}

if (import.meta.main) {
  try {
    await validateEmailReleaseConfiguration();
    console.log("Production email configuration: PASS");
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Production email configuration failed.",
    );
    process.exitCode = 1;
  }
}
