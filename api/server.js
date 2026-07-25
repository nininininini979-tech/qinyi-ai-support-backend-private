import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";

const appPromise = buildApp(loadConfig()).then(async (app) => {
  await app.ready();
  return app;
});

export default async function handler(request, response) {
  const parsed = new URL(request.url, "http://localhost");
  const route = parsed.searchParams.get("route");
  if (!route) {
    response.statusCode = 404;
    response.end("Not found");
    return;
  }
  parsed.searchParams.delete("route");
  const query = parsed.searchParams.toString();
  request.url = `/api/support/${route}${query ? `?${query}` : ""}`;
  const app = await appPromise;
  app.server.emit("request", request, response);
}
