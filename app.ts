import { Hono } from "hono";
import {
  pathOnlyLogger,
  hostAllowlist,
  corsMiddleware,
} from "./app/middleware";
import setupRoutes from "./app/routes/setup";
import importRoutes from "./app/routes/import";
import watcherRoutes from "./app/routes/watcher";
import modelsRoutes from "./app/routes/models";
import configRoutes from "./app/routes/config";
import metaRoutes from "./app/routes/meta";

const app = new Hono();

// Middleware order — DO NOT REORDER. Host allowlist must run before CORS
// so we don't emit CORS headers to a DNS-rebinding attacker's origin.
// pathOnlyLogger runs after the host check so rebind attempts aren't
// logged as legitimate traffic. SSE_TOKEN minting is deferred to
// app/middleware.ts module load — single instance via ESM singleton.
app.use(hostAllowlist());
app.use(pathOnlyLogger());
app.use(corsMiddleware());

app.route("/setup", setupRoutes);
app.route("/watcher", watcherRoutes);
app.route("/models", modelsRoutes);
app.route("/config", configRoutes);
app.route("/", importRoutes);
app.route("/", metaRoutes);

export default app;
