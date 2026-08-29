import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins/magic-link";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";
import type { EmailEnvironment, EmailService } from "./email";
import { ensureDefaultWorkspace, type WorkspaceDatabase } from "./workspaces";

export type AuthEnvironment = EmailEnvironment & {
  DB: D1Database;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  TOOLMIRROR_HOSTED?: string;
  TOOLMIRROR_ENVIRONMENT?: "development" | "production";
};

type OAuthProvider = { clientId: string; clientSecret: string };

function configuredProvider(
  name: string,
  clientId?: string,
  clientSecret?: string,
): OAuthProvider | undefined {
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret)
    throw new Error(
      `${name} OAuth credentials must include both client ID and client secret`,
    );
  return { clientId, clientSecret };
}

function authSecret(env: AuthEnvironment) {
  if (env.BETTER_AUTH_SECRET && env.BETTER_AUTH_SECRET.length >= 32)
    return env.BETTER_AUTH_SECRET;
  if (env.TOOLMIRROR_ENVIRONMENT === "development")
    return "development-only-secret-change-before-deploy";
  throw new Error(
    "BETTER_AUTH_SECRET must be at least 32 characters outside local development",
  );
}

/** Reject partial OAuth and production deployments that cannot authenticate safely. */
export function validateAuthConfiguration(env: Omit<AuthEnvironment, "DB">) {
  const github = configuredProvider(
    "GitHub",
    env.GITHUB_CLIENT_ID,
    env.GITHUB_CLIENT_SECRET,
  );
  const google = configuredProvider(
    "Google",
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
  );
  const secret = authSecret(env as AuthEnvironment);

  if (env.TOOLMIRROR_ENVIRONMENT !== "development") {
    if (!env.BETTER_AUTH_URL)
      throw new Error("BETTER_AUTH_URL is required outside local development");
    if (!github || !google)
      throw new Error(
        "GitHub and Google OAuth must be configured outside local development",
      );
  }

  return { secret, github, google };
}

/** Better Auth consumes tokens atomically and hashes them before persistence. */
export function createMagicLinkPlugin(emailService: EmailService) {
  return magicLink({
    storeToken: "hashed",
    rateLimit: { window: 60, max: 10 },
    async sendMagicLink({ email, url }) {
      await emailService.sendAuthenticationEmail({
        to: email,
        subject: "Sign in to ToolMirror",
        link: url,
      });
    },
  });
}

/** Creates request-runtime auth because D1 is supplied by the Cloudflare Worker binding. */
export function createAuth(env: AuthEnvironment, emailService?: EmailService) {
  if (!env.DB) throw new Error("Cloudflare D1 binding DB is required");
  const { secret, github, google } = validateAuthConfiguration(env);

  return betterAuth({
    appName: "ToolMirror",
    baseURL: env.BETTER_AUTH_URL,
    secret,
    advanced: { disableOriginCheck: false },
    database: drizzleAdapter(drizzle(env.DB, { schema }), {
      provider: "sqlite",
      schema,
      camelCase: true,
    }),
    socialProviders: {
      ...(github ? { github } : {}),
      ...(google ? { google } : {}),
    },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["github", "google"],
      },
    },
    plugins: emailService ? [createMagicLinkPlugin(emailService)] : [],
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await ensureDefaultWorkspace(
              env.DB as unknown as WorkspaceDatabase,
              user.id,
            );
          },
        },
      },
    },
  });
}
