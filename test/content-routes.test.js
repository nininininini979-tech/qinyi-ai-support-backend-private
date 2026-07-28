import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { ContentGovernanceService } from "../src/operations/content-governance.js";
import { registerContentGovernanceRoutes } from "../src/operations/content-routes.js";
import { FileOperationsStore } from "../src/operations/store.js";

const SESSIONS = {
  "admin-token": { username: "admin01", role: "administrator", displayName: "管理员1" },
  "developer-token": { username: "developer01", role: "developer", displayName: "开发者1" },
  "owner-token": { username: "owner", role: "system_owner", displayName: "负责人" },
  "support-token": { username: "support", role: "support", displayName: "客服" }
};

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qinyi-content-routes-"));
  const store = await new FileOperationsStore({ directory }).init();
  const service = new ContentGovernanceService({ store });
  const auth = { async authenticate(token) { return SESSIONS[token] || null; } };
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => reply.code(error.statusCode || 500).send({ error: error.message, requestId: request.id }));
  await registerContentGovernanceRoutes(app, {
    service,
    auth,
    siteBaseUrl: "https://site.example.com/qinyi",
    apiBaseUrl: "https://api.example.com"
  });
  t.after(async () => {
    await app.close();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { app, service };
}

function headers(token) {
  return { authorization: `Bearer ${token}` };
}

async function expect(app, statusCode, method, url, token, payload) {
  const response = await app.inject({ method, url, ...(token ? { headers: headers(token) } : {}), ...(payload === undefined ? {} : { payload }) });
  assert.equal(response.statusCode, statusCode, `${method} ${url}: ${response.body}`);
  return response;
}

function addManagedPage(workspace, { status = "draft", visible = false, titleZh = "动态页面", titleEn = "Managed page" } = {}) {
  const page = {
    id: "managed-page",
    slug: "managed-page.html",
    titleZh,
    titleEn,
    status,
    template: "article",
    hero: {
      titleZh,
      titleEn,
      bodyZh: "由已批准的结构化内容生成。",
      bodyEn: "Generated from approved structured content."
    },
    sections: [{
      id: "managed-copy",
      kind: "copy",
      status: "published",
      titleZh: "受控板块",
      titleEn: "Managed section",
      bodyZh: "不执行管理员输入的 HTML。",
      bodyEn: "Administrator-supplied <script>alert(1)</script> HTML is never executed."
    }],
    seo: {
      titleZh,
      titleEn,
      descriptionZh: "勤益动态内容页面",
      descriptionEn: "Qinyi managed content page",
      canonical: "managed-page.html",
      indexable: true
    }
  };
  workspace.pages.push(page);
  workspace.navigation.push({
    id: page.id,
    href: page.slug,
    labelZh: titleZh,
    labelEn: titleEn,
    visible,
    order: workspace.navigation.length
  });
  return page;
}

test("content routes enforce role boundaries and expose only published visitor data", async (t) => {
  const { app } = await fixture(t);
  const publicResponse = await expect(app, 200, "GET", "/api/public/site-content");
  assert.equal(publicResponse.headers["cache-control"], "public, max-age=60, stale-while-revalidate=300");
  assert.match(publicResponse.headers.etag, /^\"[a-f0-9]{64}\"$/);
  assert.equal(publicResponse.json().siteName, "勤益");
  await expect(app, 401, "GET", "/api/ops/content/workspace");
  await expect(app, 403, "GET", "/api/ops/content/workspace", "support-token");

  const workspace = (await expect(app, 200, "GET", "/api/ops/content/workspace", "developer-token")).json();
  workspace.siteName = "未发布站名";
  await expect(app, 403, "PUT", "/api/ops/content/workspace", "developer-token", { workspace });
  const saved = (await expect(app, 200, "PUT", "/api/ops/content/workspace", "admin-token", { workspace })).json();
  assert.equal((await expect(app, 200, "GET", "/api/public/site-content")).json().siteName, "勤益");
  await expect(app, 403, "POST", "/api/ops/content/publish", "admin-token", { expectedRevision: saved.revision });
  await expect(app, 409, "POST", "/api/ops/content/publish", "owner-token", { expectedRevision: saved.revision - 1 });
  await expect(app, 200, "POST", "/api/ops/content/publish", "owner-token", { expectedRevision: saved.revision });
  assert.equal((await expect(app, 200, "GET", "/api/public/site-content")).json().siteName, "未发布站名");

  const versions = (await expect(app, 200, "GET", "/api/ops/content/versions", "developer-token")).json();
  const versionDetail = (await expect(app, 200, "GET", `/api/ops/content/versions/${versions[0].id}`, "developer-token")).json();
  assert.equal(versionDetail.workspace.siteName, "未发布站名");
  await expect(app, 404, "GET", "/api/ops/content/versions/missing", "developer-token");
  await expect(app, 403, "POST", `/api/ops/content/versions/${versions[0].id}/rollback`, "admin-token", {});
  await expect(app, 200, "POST", `/api/ops/content/versions/${versions[0].id}/rollback`, "developer-token", {});
  await expect(app, 404, "POST", "/api/ops/content/versions/missing/rollback", "developer-token", {});
});

test("Agent and SEO/GEO routes validate payloads, approval state, and roles", async (t) => {
  const { app } = await fixture(t);
  const workspace = (await expect(app, 200, "GET", "/api/ops/content/workspace", "admin-token")).json();
  workspace.navigation[0].labelZh = "勤益首页";
  const job = (await expect(app, 201, "POST", "/api/ops/agent-changes", "admin-token", {
    scope: "navigation",
    instruction: "审核导航结构",
    workspace
  })).json();
  assert.equal(job.status, "ready_for_approval");
  await expect(app, 403, "POST", `/api/ops/agent-changes/${job.id}/approve`, "developer-token", {});
  const approved = (await expect(app, 200, "POST", `/api/ops/agent-changes/${job.id}/approve`, "admin-token", {})).json();
  assert.equal(approved.status, "published");
  await expect(app, 409, "POST", `/api/ops/agent-changes/${job.id}/approve`, "admin-token", {});
  await expect(app, 404, "POST", "/api/ops/agent-changes/missing/approve", "admin-token", {});
  const rejectWorkspace = (await expect(app, 200, "GET", "/api/ops/content/workspace", "admin-token")).json();
  rejectWorkspace.pages[0].titleZh = "待驳回";
  rejectWorkspace.pages[0].titleEn = "To reject";
  const rejectJob = (await expect(app, 201, "POST", "/api/ops/agent-changes", "admin-token", {
    scope: "content", instruction: "待驳回任务", workspace: rejectWorkspace
  })).json();
  await expect(app, 403, "POST", `/api/ops/agent-changes/${rejectJob.id}/reject`, "developer-token", { reason: "无权限" });
  const rejected = (await expect(app, 200, "POST", `/api/ops/agent-changes/${rejectJob.id}/reject`, "admin-token", { reason: "事实来源不足" })).json();
  assert.equal(rejected.status, "rejected");
  await expect(app, 400, "POST", `/api/ops/agent-changes/${rejectJob.id}/reject`, "admin-token", { reason: "" });
  await expect(app, 404, "POST", "/api/ops/agent-changes/missing/reject", "admin-token", { reason: "不存在" });
  await expect(app, 400, "POST", "/api/ops/agent-changes", "admin-token", { scope: "content", instruction: "" });

  const initialSeo = (await expect(app, 200, "GET", "/api/ops/developer/seo-geo", "developer-token")).json();
  assert.equal(initialSeo.siteHealth.score, null);
  await expect(app, 403, "PUT", "/api/ops/seo-geo", "developer-token", { changes: { targetQuestions: ["Q"] } });
  await expect(app, 400, "PUT", "/api/ops/seo-geo", "admin-token", { changes: { siteHealth: { score: 100 } } });
  await expect(app, 400, "PUT", "/api/ops/seo-geo", "admin-token", { changes: {} });
  const draft = (await expect(app, 200, "PUT", "/api/ops/seo-geo", "admin-token", {
    changes: {
      brandEntity: {
        nameZh: "勤益",
        nameEn: "Qinyi",
        descriptionZh: "印刷定制服务",
        descriptionEn: "Custom printing services"
      },
      targetQuestions: ["勤益提供什么服务？", "What services does Qinyi provide?"]
    }
  })).json();
  assert.equal(draft.status, "draft");
  assert.equal(draft.searchPerformance.clicks, null);
  await expect(app, 403, "POST", "/api/ops/seo-geo/publish", "admin-token", {});
  const seoJob = (await expect(app, 201, "POST", "/api/ops/seo-geo/agent-changes", "admin-token", { instruction: "发布 SEO/GEO 草稿" })).json();
  assert.equal(seoJob.status, "ready_for_approval");
  await expect(app, 403, "POST", `/api/ops/seo-geo/agent-changes/${seoJob.id}/approve`, "developer-token", {});
  const seoApproved = (await expect(app, 200, "POST", `/api/ops/seo-geo/agent-changes/${seoJob.id}/approve`, "admin-token", {})).json();
  assert.equal(seoApproved.status, "published");
  const versions = (await expect(app, 200, "GET", "/api/ops/seo-geo/versions", "developer-token")).json();
  await expect(app, 403, "POST", `/api/ops/seo-geo/versions/${versions[0].id}/rollback`, "admin-token", {});
  await expect(app, 200, "POST", `/api/ops/seo-geo/versions/${versions[0].id}/rollback`, "developer-token", {});
});

test("managed pages have authenticated draft previews and follow publication rollback", async (t) => {
  const { app } = await fixture(t);
  const initial = (await expect(app, 200, "GET", "/api/ops/content/workspace", "owner-token")).json();
  const baseline = (await expect(app, 200, "POST", "/api/ops/content/publish", "owner-token", { expectedRevision: initial.revision })).json();

  const draft = structuredClone(initial);
  addManagedPage(draft);
  const saved = (await expect(app, 200, "PUT", "/api/ops/content/workspace", "admin-token", { workspace: draft })).json();
  await expect(app, 401, "GET", "/api/ops/content/pages/managed-page.html/preview?locale=zh-CN");
  const preview = await expect(app, 200, "GET", "/api/ops/content/pages/managed-page.html/preview?locale=zh-CN", "admin-token");
  assert.match(preview.headers["content-type"], /^text\/html/);
  assert.equal(preview.headers["x-robots-tag"], "noindex, nofollow, noarchive");
  assert.match(preview.body, /草稿预览/);
  assert.match(preview.body, /动态页面/);
  await expect(app, 404, "GET", "/site/zh-CN/managed-page.html");

  const candidate = structuredClone(saved);
  candidate.pages.find((page) => page.id === "managed-page").status = "published";
  candidate.navigation.find((item) => item.id === "managed-page").visible = true;
  const job = (await expect(app, 201, "POST", "/api/ops/agent-changes", "admin-token", {
    scope: "content",
    instruction: "发布新增页面",
    workspace: candidate
  })).json();
  await expect(app, 200, "POST", `/api/ops/agent-changes/${job.id}/approve`, "admin-token", {});

  const published = await expect(app, 200, "GET", "/site/zh-CN/managed-page.html");
  assert.match(published.headers.etag, /^\"[a-f0-9]{64}\"$/);
  assert.match(published.body, /受控板块/);
  assert.match(published.body, /https:\/\/api\.example\.com\/site\/zh-CN\/managed-page\.html/);
  assert.match(published.body, /application\/ld\+json/);
  const alias = await expect(app, 200, "GET", "/api/public/site-pages/managed-page.html?locale=en");
  assert.match(alias.body, /Managed section/);
  assert.doesNotMatch(alias.body, /<script>alert\(1\)<\/script>/);
  assert.match(alias.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  const metadata = (await expect(app, 200, "GET", "/api/public/seo/pages/managed-page.html?locale=en")).json();
  assert.equal(metadata.canonical, "https://api.example.com/site/en/managed-page.html");
  assert.equal(metadata.jsonLd["@graph"][1].inLanguage, "en");
  const sitemap = await expect(app, 200, "GET", "/sitemap.xml");
  assert.match(sitemap.body, /https:\/\/api\.example\.com\/site\/zh-CN\/managed-page\.html/);
  assert.match((await expect(app, 200, "GET", "/llms.txt")).body, /Managed page/);

  await expect(app, 200, "POST", `/api/ops/content/versions/${baseline.versionId}/rollback`, "developer-token", {});
  await expect(app, 404, "GET", "/site/zh-CN/managed-page.html");
  assert.doesNotMatch((await expect(app, 200, "GET", "/sitemap.xml")).body, /managed-page/);
});

test("published SEO technical switches govern generated files and page metadata", async (t) => {
  const { app } = await fixture(t);
  const baseline = (await expect(app, 200, "POST", "/api/ops/seo-geo/publish", "owner-token", {})).json();
  await expect(app, 200, "GET", "/sitemap.xml");
  await expect(app, 200, "GET", "/robots.txt");
  await expect(app, 200, "GET", "/llms.txt");

  await expect(app, 200, "PUT", "/api/ops/seo-geo", "admin-token", {
    changes: { technical: { sitemap: false, robots: false, canonical: false, jsonLd: false, llmsTxt: false } }
  });
  // A saved draft cannot alter visitor-facing technical output.
  await expect(app, 200, "GET", "/sitemap.xml");
  const job = (await expect(app, 201, "POST", "/api/ops/seo-geo/agent-changes", "admin-token", { instruction: "停用技术输出" })).json();
  await expect(app, 200, "POST", `/api/ops/seo-geo/agent-changes/${job.id}/approve`, "admin-token", {});

  await expect(app, 404, "GET", "/sitemap.xml");
  await expect(app, 404, "GET", "/robots.txt");
  await expect(app, 404, "GET", "/llms.txt");
  const metadata = (await expect(app, 200, "GET", "/api/public/seo/pages/index.html?locale=zh-CN")).json();
  assert.equal(metadata.canonical, null);
  assert.equal(metadata.jsonLd, null);
  const page = await expect(app, 200, "GET", "/site/zh-CN/index.html");
  assert.doesNotMatch(page.body, /rel="canonical"/);
  assert.doesNotMatch(page.body, /application\/ld\+json/);

  await expect(app, 200, "POST", `/api/ops/seo-geo/versions/${baseline.publishedVersionId}/rollback`, "developer-token", {});
  await expect(app, 200, "GET", "/sitemap.xml");
  await expect(app, 200, "GET", "/robots.txt");
  await expect(app, 200, "GET", "/llms.txt");
});
