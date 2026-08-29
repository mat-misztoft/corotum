import { env } from "cloudflare:workers";
import { toNextJsHandler } from "better-auth/next-js";
import { type AuthEnvironment, createAuth } from "../../../../src/auth";

// vinext's generated `cloudflare:workers` type does not include app bindings.
const handlers = toNextJsHandler(createAuth(env as unknown as AuthEnvironment));

export const { GET, POST } = handlers;
