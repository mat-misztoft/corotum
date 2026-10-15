// Exercise vinext's production response pipeline, including WebSocket upgrades.
import application from "../../web/dist/server/index.js";
import fixture, { counts } from "./client-fixture";
export default {
  fetch(
    request: Request,
    env: Parameters<typeof fixture.fetch>[1],
    context: ExecutionContext,
  ) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/test/")) return fixture.fetch(request, env);
    if (path.endsWith("/revision")) counts.revision++;
    if (path.endsWith("/state")) counts.state++;
    if (path.endsWith("/sync-report")) counts.reports++;
    return application.fetch(request, env, context);
  },
};
