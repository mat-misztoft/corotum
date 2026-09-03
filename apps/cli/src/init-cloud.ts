import type { CredentialsStore, CorotumConfig } from "./config";
import type { V2SaaSProvider } from "../../../packages/saas-provider/src/index";

export class CloudInitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudInitError";
  }
}

const HOSTED_SUBSCRIPTION_MESSAGE =
  "Hosted Cloud subscription required. Pairing succeeded; start a subscription before initializing Cloud Sync.";

export function hostedSubscriptionInitError(): CloudInitError {
  return new CloudInitError(HOSTED_SUBSCRIPTION_MESSAGE);
}

export function isHostedSubscriptionRequired(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message === "Hosted Cloud subscription required" ||
    /subscription required/i.test(message)
  );
}

export type CloudInitAuth = Readonly<{
  login: () => Promise<
    Readonly<{ deviceId: string; workspaceId: string | null }>
  >;
}>;

export type CloudInitDependencies = Readonly<{
  config: { load: () => Promise<CorotumConfig> };
  credentials: Pick<CredentialsStore, "load">;
  auth: CloudInitAuth;
  provider: (input: {
    deviceToken: string;
    workspaceId: string;
  }) => V2SaaSProvider;
}>;

/** Coordinates Cloud authentication and access before local adoption. */
export class CloudInitService {
  constructor(private readonly deps: CloudInitDependencies) {}

  async connect(): Promise<{ provider: V2SaaSProvider; workspaceId: string }> {
    const config = await this.deps.config.load();
    if (config.mode && config.mode !== "cloud") {
      throw new CloudInitError("Corotum is already configured for Git Sync.");
    }

    let token = (await this.deps.credentials.load()).cloudDeviceToken;
    let workspaceId = config.workspaceId;
    if (!token || !workspaceId || !config.deviceId) {
      await this.deps.auth.login();
      const paired = await this.deps.config.load();
      token = (await this.deps.credentials.load()).cloudDeviceToken;
      workspaceId = paired.workspaceId;
    }
    if (!token || !workspaceId) {
      throw new CloudInitError(
        "Cloud pairing did not provide a device workspace. Run corotum login and try again.",
      );
    }

    const provider = this.deps.provider({ deviceToken: token, workspaceId });
    try {
      await provider.pull();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Cloud desired state could not be loaded completely.";
      if (isHostedSubscriptionRequired(error) || isHostedSubscriptionRequired(message)) {
        throw hostedSubscriptionInitError();
      }
      throw new CloudInitError(message);
    }
    return { provider, workspaceId };
  }
}
