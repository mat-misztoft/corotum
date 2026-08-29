/// <reference path="./node_modules/@cloudflare/workers-types/index.d.ts" />

interface Env {
  DB: D1Database;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  TOOLMIRROR_HOSTED?: string;
  TOOLMIRROR_ENVIRONMENT?: "development" | "production";
  CREEM_API_KEY?: string;
  CREEM_WEBHOOK_SECRET?: string;
  CREEM_PRODUCT_MONTHLY?: string;
  CREEM_PRODUCT_ANNUAL?: string;
  CREEM_API_URL?: string;
}
