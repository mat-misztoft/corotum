import { expect, test } from "bun:test";
import { validateAuthConfiguration } from "./auth";

const productionConfig = {
  BETTER_AUTH_SECRET: "a-secure-secret-with-at-least-thirty-two-characters",
  BETTER_AUTH_URL: "https://toolmirror.example",
  GITHUB_CLIENT_ID: "github-id",
  GITHUB_CLIENT_SECRET: "github-secret",
  GOOGLE_CLIENT_ID: "google-id",
  GOOGLE_CLIENT_SECRET: "google-secret",
  TOOLMIRROR_ENVIRONMENT: "production" as const,
};

test("hosted and self-hosted production require a secret, URL, and both OAuth providers", () => {
  expect(validateAuthConfiguration(productionConfig)).toMatchObject({
    github: { clientId: "github-id" },
    google: { clientId: "google-id" },
  });
  expect(() =>
    validateAuthConfiguration({
      ...productionConfig,
      BETTER_AUTH_SECRET: "short",
    }),
  ).toThrow("BETTER_AUTH_SECRET");
  expect(() =>
    validateAuthConfiguration({
      ...productionConfig,
      GITHUB_CLIENT_SECRET: undefined,
    }),
  ).toThrow("GitHub OAuth");
  expect(() =>
    validateAuthConfiguration({
      ...productionConfig,
      BETTER_AUTH_URL: undefined,
    }),
  ).toThrow("BETTER_AUTH_URL");
});

test("local development can use an ephemeral development-only auth secret", () => {
  expect(
    validateAuthConfiguration({ TOOLMIRROR_ENVIRONMENT: "development" }),
  ).toMatchObject({
    github: undefined,
    google: undefined,
  });
});
