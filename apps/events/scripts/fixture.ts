import Events, { WorkspaceEvents } from "../src/index";

export default Events;

// Test-only RPC: never included in the production entrypoint.
export class TestWorkspaceEvents extends WorkspaceEvents {
  private readonly instanceId = crypto.randomUUID();
  instance() {
    return this.instanceId;
  }
  inspect() {
    return this.ctx.getWebSockets().map((socket) => ({
      ...socket.deserializeAttachment(),
      readyState: socket.readyState,
    }));
  }

  expire() {
    for (const socket of this.ctx.getWebSockets()) {
      socket.serializeAttachment({
        ...socket.deserializeAttachment(),
        expiresAt: 0,
      });
    }
  }
}
