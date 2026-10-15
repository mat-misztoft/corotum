import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

const MAX_LIFETIME_MS = 60 * 60 * 1000;
const MAX_DEVICE_SOCKETS = 4;
const MAX_WORKSPACE_SOCKETS = 256;

/** An invalidation hint, never a source of workspace state or skill content. */
export interface WorkspaceEvent {
  workspaceId: string;
  revisionSequence: number;
  revisionId: string;
}

interface Env {
  WORKSPACES: DurableObjectNamespace<WorkspaceEvents>;
}

interface Attachment {
  version: 1;
  deviceId: string;
  tokenId?: string;
  expiresAt: number;
  sequence: number;
}

function identifier(value: string): void {
  if (typeof value !== "string" || !value.length || value.length > 128) {
    throw new TypeError("Invalid identifier");
  }
}

/** No public routes: only the authenticated web worker may bind this service. */
export default class Events extends WorkerEntrypoint<Env> {
  private workspace(workspaceId: string) {
    identifier(workspaceId);
    return this.env.WORKSPACES.get(this.env.WORKSPACES.idFromName(workspaceId));
  }

  fetch(request: Request): Promise<Response> | Response {
    const url = new URL(request.url);
    if (url.hostname !== "events.internal" || url.pathname !== "/subscribe") {
      return new Response("Not found", { status: 404 });
    }
    if (
      request.method !== "GET" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    ) {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const workspaceId = request.headers.get("x-corotum-workspace-id");
    if (!workspaceId) return new Response("Missing workspace", { status: 400 });
    try {
      return this.workspace(workspaceId).fetch(request);
    } catch {
      return new Response("Invalid workspace", { status: 400 });
    }
  }

  publish(event: WorkspaceEvent, authorizedTokenIds: string[]) {
    return this.workspace(event.workspaceId).publish(event, authorizedTokenIds);
  }

  invalidateWorkspace(workspaceId: string) {
    return this.workspace(workspaceId).invalidate();
  }

  invalidateDevice(workspaceId: string, deviceId: string) {
    identifier(deviceId);
    return this.workspace(workspaceId).invalidate(deviceId);
  }

  /** Web resolves user ownership; this worker deliberately has no auth database. */
  async invalidateUser(workspaceIds: string[]) {
    if (!Array.isArray(workspaceIds) || workspaceIds.length > 1000) {
      throw new TypeError("Invalid workspace batch (maximum 1000)");
    }
    workspaceIds.forEach(identifier);
    // Sequential calls bound outstanding work for account-wide revocations.
    for (const id of new Set(workspaceIds)) await this.invalidateWorkspace(id);
  }
}

export class WorkspaceEvents extends DurableObject<Env> {
  fetch(request: Request): Response {
    const deviceId = request.headers.get("x-corotum-device-id");
    const tokenId = request.headers.get("x-corotum-token-id");
    const expiry = request.headers.get("x-corotum-expires-at");
    if (!deviceId || !tokenId)
      return new Response("Missing authorization context", { status: 400 });
    try {
      return this.subscribe(
        deviceId,
        tokenId,
        expiry === null ? undefined : Number(expiry),
      );
    } catch {
      return new Response("Invalid authorization context", { status: 400 });
    }
  }

  private attachment(socket: WebSocket): Attachment | undefined {
    const data = socket.deserializeAttachment() as Attachment | null;
    if (
      data?.version !== 1 ||
      !Number.isFinite(data.expiresAt) ||
      data.expiresAt <= Date.now() ||
      data.expiresAt > Date.now() + MAX_LIFETIME_MS
    ) {
      socket.close(1008, "Reauthentication required");
      return;
    }
    return data;
  }

  subscribe(
    deviceId: string,
    tokenId?: string,
    expiresAt = Date.now() + MAX_LIFETIME_MS,
  ): Response {
    identifier(deviceId);
    if (tokenId !== undefined) identifier(tokenId);
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Date.now() ||
      expiresAt > Date.now() + MAX_LIFETIME_MS
    ) {
      return new Response("Invalid authorization expiry", { status: 403 });
    }
    const sockets = this.ctx.getWebSockets();
    const live = sockets.filter((socket) => this.attachment(socket));
    if (
      live.length >= MAX_WORKSPACE_SOCKETS ||
      live.filter(
        (socket) => socket.deserializeAttachment().deviceId === deviceId,
      ).length >= MAX_DEVICE_SOCKETS
    ) {
      return new Response("Connection limit exceeded", { status: 429 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      version: 1,
      deviceId,
      ...(tokenId === undefined ? {} : { tokenId }),
      expiresAt,
      sequence: -1,
    } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  publish(event: WorkspaceEvent, authorizedTokenIds: string[]): void {
    if (
      !Array.isArray(authorizedTokenIds) ||
      authorizedTokenIds.length > 10000
    ) {
      throw new TypeError("Authorized token list required (maximum 10000)");
    }
    authorizedTokenIds.forEach(identifier);
    const authorized = new Set(authorizedTokenIds);
    identifier(event.workspaceId);
    identifier(event.revisionId);
    if (
      !Number.isSafeInteger(event.revisionSequence) ||
      event.revisionSequence < 0
    ) {
      throw new TypeError("Invalid event sequence");
    }
    const message = JSON.stringify({
      type: "revision.updated",
      workspaceId: event.workspaceId,
      revisionSequence: event.revisionSequence,
      revisionId: event.revisionId,
    });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        const attachment = this.attachment(socket);
        if (!attachment) continue;
        if (!attachment.tokenId || !authorized.has(attachment.tokenId)) {
          socket.close(1008, "Authorization revoked");
          continue;
        }
        if (event.revisionSequence <= attachment.sequence) continue;
        socket.send(message);
        // Socket-local high-water mark survives DO hibernation, not authoritative state.
        socket.serializeAttachment({
          ...attachment,
          sequence: event.revisionSequence,
        });
      } catch {
        socket.close(1011, "Delivery failed");
      }
    }
  }

  invalidate(deviceId?: string): void {
    if (deviceId !== undefined) identifier(deviceId);
    for (const socket of this.ctx.getWebSockets()) {
      if (!deviceId || socket.deserializeAttachment()?.deviceId === deviceId) {
        socket.close(1008, "Authorization revoked");
      }
    }
  }

  webSocketMessage(socket: WebSocket, _message: string | ArrayBuffer): void {
    if (this.attachment(socket))
      socket.close(1008, "Client messages are not supported");
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(code, reason);
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, "WebSocket error");
  }
}
