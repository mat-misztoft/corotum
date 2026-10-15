// Local integration harness only; this file is never deployed.

import type { AuthEnvironment } from "../../web/src/auth";
import {
  type DesiredStateMutation,
  mutateDesiredState,
} from "../../web/src/revisions";
import {
  handleGetWorkspaceRevision,
  handleGetWorkspaceState,
  handleWorkspaceEvents,
} from "../../web/src/state-http";
import { handlePostDeviceSyncReport } from "../../web/src/sync-report-http";
import {
  type EventsService,
  eventDatabase,
} from "../../web/src/workspace-events";

export const counts = { state: 0, revision: 0, reports: 0 };
export default {
  async fetch(
    request: Request,
    env: AuthEnvironment & { EVENTS: EventsService },
  ): Promise<Response> {
    const path = new URL(request.url).pathname;
    const db = eventDatabase(env);
    if (path.endsWith("/events"))
      return handleWorkspaceEvents(request, db, "ws_test", false, env.EVENTS);
    if (path.endsWith("/revision")) {
      counts.revision++;
      return handleGetWorkspaceRevision(request, db, "ws_test");
    }
    if (path.endsWith("/state")) {
      counts.state++;
      return handleGetWorkspaceState(request, db, "ws_test");
    }
    const device = path.match(/\/devices\/([^/]+)\/sync-report$/);
    if (device) {
      counts.reports++;
      return handlePostDeviceSyncReport(request, db, device[1]);
    }
    if (path === "/test/metrics") return Response.json(counts);
    if (path === "/test/disconnect") {
      await env.EVENTS.invalidateDevice("ws_test", "dev_a");
      return new Response("ok");
    }
    if (path === "/test/commit") {
      const input = (await request.json()) as DesiredStateMutation;
      const result = await mutateDesiredState(db, {
        ...input,
        workspaceId: "ws_test",
        userId: "user_test",
        actor: { type: "system", id: "integration" },
      });
      return Response.json(result);
    }
    return new Response("Not found", { status: 404 });
  },
};
