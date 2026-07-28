import crypto from "node:crypto";
import { z } from "zod";
import { bearerToken } from "./auth.js";
import {
  deliveryCsp,
  normalizedLocale,
  pageBySlug,
  pageMetadata,
  renderLlmsTxt,
  renderPageDocument,
  renderRobots,
  renderSitemap,
  technicalSettings
} from "./site-delivery.js";

const workspaceEnvelope = z.object({ workspace: z.record(z.unknown()) }).strict();
const publishSchema = z.object({ expectedRevision: z.number().int().positive().optional() }).strict();
const rejectionSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();
const agentChangeSchema = z.object({
  scope: z.enum(["content", "rules", "seo_geo", "navigation", "customizer"]).default("content"),
  instruction: z.string().trim().min(1).max(4000),
  workspace: z.record(z.unknown()).optional()
}).strict();
const brandEntitySchema = z.object({
  nameZh: z.string().trim().min(1).max(120),
  nameEn: z.string().trim().min(1).max(160),
  descriptionZh: z.string().trim().min(1).max(2000),
  descriptionEn: z.string().trim().min(1).max(2400)
}).strict();
const technicalSchema = z.object({
  sitemap: z.boolean().optional(),
  robots: z.boolean().optional(),
  canonical: z.boolean().optional(),
  jsonLd: z.boolean().optional(),
  llmsTxt: z.boolean().optional()
}).strict();
const seoGeoChangesSchema = z.object({
  markets: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  brandEntity: brandEntitySchema.optional(),
  targetQuestions: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
  technical: technicalSchema.optional()
}).strict().refine((value) => Object.keys(value).length > 0);
const seoGeoSchema = z.object({ changes: seoGeoChangesSchema }).strict();
const seoGeoAgentSchema = z.object({ instruction: z.string().trim().min(1).max(4000) }).strict();
const pageSlugSchema = z.string().regex(/^[a-z0-9-]+\.html$/).max(100);
const pageQuerySchema = z.object({ locale: z.enum(["zh-CN", "en"]).default("en") }).strict();
const pageRouteSchema = z.object({ locale: z.enum(["zh-CN", "en"]), slug: pageSlugSchema }).strict();

const DEFAULT_SITE_BASE_URL = "https://nininininini979-tech.github.io/qinyi-printing-website";
const DEFAULT_API_BASE_URL = "http://127.0.0.1:3000";

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw Object.assign(new Error("请求参数无效。"), { statusCode: 400 });
}

function actor(session) {
  return session.username || session.displayName || "manager";
}

export async function registerContentGovernanceRoutes(app, {
  service,
  auth,
  siteBaseUrl = DEFAULT_SITE_BASE_URL,
  apiBaseUrl = DEFAULT_API_BASE_URL
}) {
  async function requireRole(request, roles) {
    const session = await auth.authenticate(bearerToken(request));
    if (!session) throw Object.assign(new Error("后台会话无效或已过期。"), { statusCode: 401 });
    if (!roles.includes(session.role)) throw Object.assign(new Error("当前账号没有执行此操作的权限。"), { statusCode: 403 });
    request.contentSession = session;
  }

  const requireManager = (request) => requireRole(request, ["administrator", "system_owner", "developer"]);
  const requireAdministrator = (request) => requireRole(request, ["administrator", "system_owner"]);
  const requireDeveloper = (request) => requireRole(request, ["developer", "system_owner"]);

  async function deliveryState({ draft = false } = {}) {
    const [content, seoGeo] = await Promise.all([
      draft ? service.getWorkspace() : service.publicContent(),
      draft ? service.getSeoGeo() : service.publicSeoGeo()
    ]);
    return { content, seoGeo };
  }

  function deliveryTag(content, seoGeo, suffix) {
    return crypto.createHash("sha256")
      .update(`${content?.contentHash || content?.revision || "none"}:${seoGeo?.contentHash || seoGeo?.publishedVersionId || "default"}:${suffix}`)
      .digest("hex");
  }

  function sendHtml(reply, html, { cache = false, nonce, preview = false, robots = "index, follow" } = {}) {
    reply.type("text/html; charset=utf-8");
    reply.header("Cache-Control", cache ? "public, max-age=60, stale-while-revalidate=300" : "private, no-store");
    reply.header("X-Robots-Tag", preview ? "noindex, nofollow, noarchive" : robots);
    reply.header("Content-Security-Policy", deliveryCsp({ siteBaseUrl, apiBaseUrl, nonce, preview }));
    return reply.send(html);
  }

  async function publicPage(request, reply, routeValues) {
    const values = routeValues || parse(pageRouteSchema, request.params);
    const { content, seoGeo } = await deliveryState();
    const page = pageBySlug(content, values.slug);
    if (!page) return reply.code(404).send({ error: "页面不存在或尚未发布。", requestId: request.id });
    const nonce = crypto.randomBytes(18).toString("base64url");
    const html = renderPageDocument({ content, page, seoGeo, locale: values.locale, siteBaseUrl, apiBaseUrl, nonce });
    reply.header("ETag", `\"${deliveryTag(content, seoGeo, `${values.locale}:${values.slug}`)}\"`);
    return sendHtml(reply, html, { cache: true, nonce, robots: page.seo?.indexable === false ? "noindex, nofollow, noarchive" : "index, follow" });
  }

  async function publicTechnical(request, reply, kind) {
    const { content, seoGeo } = await deliveryState();
    const technical = technicalSettings(seoGeo);
    const setting = { sitemap: "sitemap", robots: "robots", llms: "llmsTxt" }[kind];
    if (!technical[setting]) return reply.code(404).send({ error: "该技术输出当前未发布。", requestId: request.id });
    const output = kind === "sitemap"
      ? renderSitemap({ content, seoGeo, siteBaseUrl, apiBaseUrl })
      : kind === "robots"
        ? renderRobots({ siteBaseUrl })
        : renderLlmsTxt({ content, seoGeo, siteBaseUrl, apiBaseUrl });
    const contentType = kind === "sitemap" ? "application/xml; charset=utf-8" : "text/plain; charset=utf-8";
    reply.type(contentType).header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    reply.header("ETag", `\"${deliveryTag(content, seoGeo, kind)}\"`);
    return reply.send(output);
  }

  app.get("/api/public/site-content", async (_, reply) => {
    const content = await service.publicContent();
    reply.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    reply.header("ETag", `\"${content.contentHash}\"`);
    return content;
  });

  app.get("/site/:locale/:slug", (request, reply) => publicPage(request, reply));
  app.get("/api/public/site-pages/:slug", async (request, reply) => {
    const slug = parse(pageSlugSchema, request.params.slug);
    const query = parse(pageQuerySchema, request.query || {});
    return publicPage(request, reply, { slug, locale: query.locale });
  });
  app.get("/api/public/seo/pages/:slug", async (request, reply) => {
    const slug = parse(pageSlugSchema, request.params.slug);
    const query = parse(pageQuerySchema, request.query || {});
    const { content, seoGeo } = await deliveryState();
    const page = pageBySlug(content, slug);
    if (!page) return reply.code(404).send({ error: "页面不存在或尚未发布。", requestId: request.id });
    const metadata = pageMetadata({ content, page, seoGeo, locale: query.locale, siteBaseUrl, apiBaseUrl });
    reply.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    reply.header("ETag", `\"${deliveryTag(content, seoGeo, `metadata:${query.locale}:${slug}`)}\"`);
    return metadata;
  });
  for (const [url, kind] of [
    ["/sitemap.xml", "sitemap"],
    ["/robots.txt", "robots"],
    ["/llms.txt", "llms"],
    ["/api/public/seo/sitemap.xml", "sitemap"],
    ["/api/public/seo/robots.txt", "robots"],
    ["/api/public/seo/llms.txt", "llms"]
  ]) app.get(url, (request, reply) => publicTechnical(request, reply, kind));

  app.get("/api/ops/content/workspace", { preHandler: requireManager }, () => service.getWorkspace());
  app.get("/api/ops/content/pages/:slug/preview", { preHandler: requireManager }, async (request, reply) => {
    const slug = parse(pageSlugSchema, request.params.slug);
    const query = parse(pageQuerySchema, request.query || {});
    const { content, seoGeo } = await deliveryState({ draft: true });
    const page = pageBySlug(content, slug, { preview: true });
    if (!page) return reply.code(404).send({ error: "草稿页面不存在或已经下架。", requestId: request.id });
    const nonce = crypto.randomBytes(18).toString("base64url");
    const html = renderPageDocument({ content, page, seoGeo, locale: normalizedLocale(query.locale), siteBaseUrl, apiBaseUrl, preview: true, nonce });
    return sendHtml(reply, html, { nonce, preview: true });
  });
  app.put("/api/ops/content/workspace", { preHandler: requireAdministrator }, (request) => {
    const body = parse(workspaceEnvelope, request.body);
    return service.saveWorkspace(body.workspace, actor(request.contentSession));
  });
  // Direct publication is a system-owner recovery path. Administrators publish normal work
  // by approving a validated Agent candidate, which preserves the review chain.
  app.post("/api/ops/content/publish", { preHandler: (request) => requireRole(request, ["system_owner"]) }, (request) => {
    const body = parse(publishSchema, request.body || {});
    return service.publishWorkspace(body, actor(request.contentSession));
  });
  app.get("/api/ops/content/versions", { preHandler: requireManager }, () => service.listVersions());
  app.get("/api/ops/content/versions/:versionId", { preHandler: requireManager }, async (request, reply) => {
    const result = await service.getVersion(String(request.params.versionId));
    return result || reply.code(404).send({ error: "内容版本不存在。", requestId: request.id });
  });
  app.post("/api/ops/content/versions/:versionId/rollback", { preHandler: requireDeveloper }, async (request, reply) => {
    const result = await service.rollback(String(request.params.versionId), actor(request.contentSession));
    return result || reply.code(404).send({ error: "内容版本不存在。", requestId: request.id });
  });

  app.get("/api/ops/agent-changes", { preHandler: requireManager }, () => service.listAgentChanges());
  app.post("/api/ops/agent-changes", { preHandler: requireAdministrator }, async (request, reply) => {
    const body = parse(agentChangeSchema, request.body);
    return reply.code(201).send(await service.createAgentChange(body, actor(request.contentSession)));
  });
  app.post("/api/ops/agent-changes/:jobId/approve", { preHandler: requireAdministrator }, async (request, reply) => {
    const result = await service.approveAgentChange(String(request.params.jobId), actor(request.contentSession));
    return result || reply.code(404).send({ error: "Agent 修改任务不存在。", requestId: request.id });
  });
  app.post("/api/ops/agent-changes/:jobId/reject", { preHandler: requireAdministrator }, async (request, reply) => {
    const body = parse(rejectionSchema, request.body);
    const result = await service.rejectAgentChange(String(request.params.jobId), body.reason, actor(request.contentSession));
    return result || reply.code(404).send({ error: "Agent 修改任务不存在。", requestId: request.id });
  });

  app.get("/api/ops/seo-geo", { preHandler: requireManager }, () => service.getSeoGeo());
  app.put("/api/ops/seo-geo", { preHandler: requireAdministrator }, (request) => {
    const body = parse(seoGeoSchema, request.body);
    return service.updateSeoGeo(body.changes, actor(request.contentSession));
  });
  app.post("/api/ops/seo-geo/publish", { preHandler: (request) => requireRole(request, ["system_owner"]) }, (request) => service.publishSeoGeo(actor(request.contentSession)));
  app.get("/api/ops/seo-geo/agent-changes", { preHandler: requireManager }, () => service.listSeoGeoAgentChanges());
  app.post("/api/ops/seo-geo/agent-changes", { preHandler: requireAdministrator }, async (request, reply) => {
    const body = parse(seoGeoAgentSchema, request.body);
    return reply.code(201).send(await service.createSeoGeoAgentChange(body, actor(request.contentSession)));
  });
  app.post("/api/ops/seo-geo/agent-changes/:jobId/approve", { preHandler: requireAdministrator }, async (request, reply) => {
    const result = await service.approveSeoGeoAgentChange(String(request.params.jobId), actor(request.contentSession));
    return result || reply.code(404).send({ error: "SEO/GEO Agent 任务不存在。", requestId: request.id });
  });
  app.post("/api/ops/seo-geo/agent-changes/:jobId/reject", { preHandler: requireAdministrator }, async (request, reply) => {
    const body = parse(rejectionSchema, request.body);
    const result = await service.rejectSeoGeoAgentChange(String(request.params.jobId), body.reason, actor(request.contentSession));
    return result || reply.code(404).send({ error: "SEO/GEO Agent 任务不存在。", requestId: request.id });
  });
  app.get("/api/ops/seo-geo/versions", { preHandler: requireManager }, () => service.listSeoGeoVersions());
  app.post("/api/ops/seo-geo/versions/:versionId/rollback", { preHandler: requireDeveloper }, async (request, reply) => {
    const result = await service.rollbackSeoGeo(String(request.params.versionId), actor(request.contentSession));
    return result || reply.code(404).send({ error: "SEO/GEO 版本不存在。", requestId: request.id });
  });
  app.get("/api/ops/developer/seo-geo", { preHandler: requireDeveloper }, () => service.getSeoGeo());
}
