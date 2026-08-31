import type { CredentialsStore, CorotumConfig } from "./config";
import {
  type InitCandidate,
  type InitResolver,
  type InitSelection,
  InitService,
  type InitStateProvider,
} from "./init";
import type { LocalOperationalState } from "./local-state";
import type {
  ExecuteReconcileInput,
  LocalReconcileExecutor,
} from "./reconcile-executor";

export class CloudInitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudInitError";
  }
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
  }) => InitStateProvider;
  resolver: InitResolver;
  executor: Pick<LocalReconcileExecutor, "execute">;
}>;

/** Coordinates Cloud authentication and access before reusing safe local adoption. */
export class CloudInitService {
  constructor(private readonly deps: CloudInitDependencies) {}

  async initialize(input: {
    candidates: readonly InitCandidate[];
    selected: readonly InitSelection[];
    nonInteractive: boolean;
    execution: Omit<
      ExecuteReconcileInput,
      "desired" | "plan" | "revision" | "state"
    > & { state: LocalOperationalState };
  }) {
    const config = await this.deps.config.load();
    if (config.mode && config.mode !== "cloud") {
      throw new CloudInitError(
        "Corotum is already configured for Git Sync.",
      );
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
    // This checks both workspace access and hosted entitlement before resolving,
    // saving desired state, or taking ownership of any local skill.
    const access = await provider.pull();
    if (access.kind !== "success") {
      const message =
        access.kind === "failure"
          ? access.error.message
          : (access.errors[0]?.message ??
            "Cloud desired state could not be loaded completely.");
      if (message === "Hosted Cloud subscription required") {
        throw new CloudInitError(
          "Hosted Cloud subscription required. Pairing succeeded; start a subscription before initializing Cloud Sync.",
        );
      }
      throw new CloudInitError(message);
    }

    return new InitService(
      provider,
      this.deps.resolver,
      this.deps.executor,
    ).initialize(input);
  }
}
