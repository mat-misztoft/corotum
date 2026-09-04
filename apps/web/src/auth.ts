import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins/magic-link";
import { drizzle } from "drizzle-orm/d1";
import { persistAccountDisplayLabel } from "./account-label";
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
  COROTUM_HOSTED?: string;
  COROTUM_ENVIRONMENT?: "development" | "production";
};

type OAuthProvider = { clientId: string; clientSecret: string };

function text(env: object, key: string) {
  const value = (env as Record<string, unknown>)[key];
  if (typeof value === "string" && value) return value;
  const fallback = process.env[key];
  return fallback || undefined;
}

function configuredProvider(
  clientId?: string,
  clientSecret?: string,
): OAuthProvider | undefined {
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret };
}

function authSecret(env: AuthEnvironment) {
  return (
    text(env, "BETTER_AUTH_SECRET") ??
    (text(env, "COROTUM_ENVIRONMENT") === "development"
      ? "development-only-secret-change-before-deploy"
      : "")
  );
}

export function validateAuthConfiguration(env: Omit<AuthEnvironment, "DB">) {
  return {
    secret: authSecret(env as AuthEnvironment),
    github: configuredProvider(
      text(env, "GITHUB_CLIENT_ID"),
      text(env, "GITHUB_CLIENT_SECRET"),
    ),
    google: configuredProvider(
      text(env, "GOOGLE_CLIENT_ID"),
      text(env, "GOOGLE_CLIENT_SECRET"),
    ),
    origin: text(env, "BETTER_AUTH_URL"),
  };
}

/** Better Auth consumes tokens atomically and hashes them before persistence. */
export function createMagicLinkPlugin(emailService: EmailService) {
  return magicLink({
    storeToken: "hashed",
    rateLimit: { window: 60, max: 10 },
    async sendMagicLink({ email, url }) {
      await emailService.sendAuthenticationEmail({
        to: email,
        subject: "Sign in to Corotum",
        link: url,
      });
    },
  });
}

/** Creates request-runtime auth because D1 is supplied by the Cloudflare Worker binding. */
export function createAuth(
  env: AuthEnvironment,
  emailService?: EmailService,
  origin?: string,
) {
  if (!env.DB) throw new Error("Cloudflare D1 binding DB is required");
  const {
    secret,
    github,
    google,
    origin: configuredOrigin,
  } = validateAuthConfiguration(env);

  return betterAuth({
    appName: "Corotum",
    baseURL: configuredOrigin || origin,
    trustedOrigins: ["https://corotum.com", "https://dev.corotum.com"],
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
        allowDifferentEmails: true,
        allowUnlinkingAll: true,
        trustedProviders: ["github", "google"],
      },
    },
    user: {
      changeEmail: { enabled: true },
      deleteUser: { enabled: true },
    },
    emailVerification: emailService
      ? {
          async sendVerificationEmail({ user, url }) {
            await emailService.sendAuthenticationEmail({
              to: user.email,
              subject: "Confirm your Corotum email",
              link: url,
            });
          },
        }
      : undefined,
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
      account: {
        create: {
          after: async (account) => {
            if (
              account.providerId !== "github" &&
              account.providerId !== "google"
            )
              return;
            await persistAccountDisplayLabel(
              env.DB as unknown as WorkspaceDatabase,
              {
                id: account.id,
                providerId: account.providerId,
                accountId: account.accountId,
                accessToken: account.accessToken,
              },
            );
          },
        },
      },
    },
  });
}
