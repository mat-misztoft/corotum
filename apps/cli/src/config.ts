import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import type { CorotumPaths } from "./platform";
import { SkillsStorageMigrator } from "./skills-storage-migration";

const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.enum(["git", "cloud"]).nullable(),
    workspaceId: z.string().min(1).nullable(),
    deviceId: z.string().min(1).nullable(),
    skillsStoragePath: z.string().min(1).nullable(),
    gitStoragePath: z.string().min(1).nullable(),
    gitRepository: z.string().min(1).nullable().default(null),
    telemetry: z.boolean().nullable(),
    installationId: z.uuid().nullable(),
    agents: z.record(z.string(), z.object({ enabled: z.boolean() })),
  })
  .strict();

const credentialsSchema = z
  .object({
    schemaVersion: z.literal(1),
    cloudDeviceToken: z.string().min(1).optional(),
  })
  .strict();

export type CorotumConfig = z.infer<typeof configSchema>;
export type Credentials = z.infer<typeof credentialsSchema>;
export type ConfigKey = Exclude<keyof CorotumConfig, "schemaVersion">;

export const defaultConfig = (): CorotumConfig => ({
  schemaVersion: 1,
  mode: null,
  workspaceId: null,
  deviceId: null,
  skillsStoragePath: null,
  gitStoragePath: null,
  gitRepository: null,
  telemetry: null,
  installationId: null,
  agents: {},
});

export function effectiveStoragePaths(
  config: CorotumConfig,
  paths: CorotumPaths,
): Readonly<{ gitStoragePath: string; skillsStoragePath: string }> {
  return {
    gitStoragePath: config.gitStoragePath ?? paths.gitDir,
    skillsStoragePath: config.skillsStoragePath ?? paths.skillsDir,
  };
}

/** Local configuration, including transactional canonical-store relocation. */
export class ConfigStore {
  constructor(
    private readonly paths: CorotumPaths,
    private readonly skillsStorageMigrator = new SkillsStorageMigrator(),
  ) {}

  async list(): Promise<CorotumConfig> {
    return this.load();
  }

  async get<Key extends ConfigKey>(key: Key): Promise<CorotumConfig[Key]> {
    return (await this.load())[key];
  }

  async set(key: ConfigKey, value: unknown): Promise<CorotumConfig> {
    const current = await this.load();
    const candidate = configSchema.parse({ ...current, [key]: value });
    if (
      key === "skillsStoragePath" &&
      candidate.skillsStoragePath !== current.skillsStoragePath
    ) {
      await this.skillsStorageMigrator.migrate({
        from: current.skillsStoragePath ?? this.paths.skillsDir,
        to: candidate.skillsStoragePath ?? this.paths.skillsDir,
        persist: () => writeJson(this.paths.configFile, candidate, false),
      });
      return candidate;
    }
    await writeJson(this.paths.configFile, candidate, false);
    return candidate;
  }

  async load(): Promise<CorotumConfig> {
    return readJson(this.paths.configFile, configSchema, defaultConfig());
  }
}

export class CredentialsStore {
  constructor(private readonly paths: CorotumPaths) {}

  async load(): Promise<Credentials> {
    return readJson(this.paths.credentialsFile, credentialsSchema, {
      schemaVersion: 1,
    });
  }

  async save(credentials: Credentials): Promise<void> {
    await writeJson(
      this.paths.credentialsFile,
      credentialsSchema.parse(credentials),
      true,
    );
  }
}

async function readJson<Schema extends z.ZodType>(
  file: string,
  schema: Schema,
  fallback: z.infer<Schema>,
): Promise<z.infer<Schema>> {
  try {
    return schema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (isNotFound(error)) {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(
  file: string,
  value: unknown,
  privateFile: boolean,
): Promise<void> {
  const directory = dirname(file);
  await mkdir(directory, {
    recursive: true,
    mode: privateFile ? 0o700 : 0o755,
  });
  if (privateFile && process.platform !== "win32") {
    await chmod(directory, 0o700);
  }

  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: privateFile ? 0o600 : 0o644,
  });

  if (privateFile && process.platform !== "win32") {
    await chmod(temporary, 0o600);
  }

  await rename(temporary, file);

  if (privateFile && process.platform !== "win32") {
    await chmod(file, 0o600);
  }
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
