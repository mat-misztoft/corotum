import { type AuthEnvironment, createAuth } from "./auth";

export async function requireSession(request: Request, env: AuthEnvironment) {
  const session = await createAuth(env).api.getSession({
    headers: request.headers,
  });
  if (!session) return null;
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
  };
}

export async function requireUserId(request: Request, env: AuthEnvironment) {
  return (await requireSession(request, env))?.id ?? null;
}

/** Reject cross-origin browser POSTs while allowing CLI requests without an Origin header. */
export function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

export function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

export async function readJson(request: Request) {
  try {
    return (await request.json()) as unknown;
  } catch {
    return null;
  }
}
