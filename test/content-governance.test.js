import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContentGovernanceService, defaultWorkspace } from "../src/operations/content-governance.js";
import { FileOperationsStore } from "../src/operations/store.js";

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qinyi-content-governance-"));
  const store = await new FileOperationsStore({ directory }).init();
  t.after(async () => {
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, store, service: new ContentGovernanceService({ store }) };
}

function withHomeTitle(workspace, titleZh, titleEn) {
  const candidate = structuredClone(workspace);
  const home = candidate.pages.find((page) => page.id === "home");
  home.titleZh = titleZh;
  home.titleEn = titleEn;
  home.hero.titleZh = titleZh;
  home.hero.titleEn = titleEn;
  return candidate;
}

test("draft content stays private until an exact revision is published", async (t) => {
  const { service, store } = await fixture(t);
  const originalPublic = await service.publicContent();
  assert.equal(originalPublic.siteName, "勤益");
  assert.equal(originalPublic.pages.length, 13);

  const originalWorkspace = await service.getWorkspace();
  const saved = await service.saveWorkspace(withHomeTitle(originalWorkspace, "未发布首页", "Unpublished home"), "admin01");
  assert.equal(saved.status, "draft");
  assert.equal(saved.revision, originalWorkspace.revision + 1);
  assert.equal((await service.publicContent()).pages.find((page) => page.id === "home").titleZh, "首页");

  await assert.rejects(service.publishWorkspace({ expectedRevision: saved.revision - 1 }, "admin01"), (error) => error.statusCode === 409);
  const published = await service.publishWorkspace({ expectedRevision: saved.revision }, "admin01");
  assert.equal(published.workspace.status, "published");
  assert.equal(published.workspace.publishedVersionId, published.versionId);
  assert.equal((await service.publicContent()).pages.find((page) => page.id === "home").titleZh, "未发布首页");
  assert.equal((await service.publicContent()).publishedVersionId, published.versionId);
  assert.match((await service.publicContent()).contentHash, /^[a-f0-9]{64}$/);
  assert.equal((await service.listVersions()).length, 1);

  const events = await store.listEvents({ limit: 20 });
  assert.ok(events.some((item) => item.action === "content.workspace_saved" && item.actor === "admin01"));
  assert.ok(events.some((item) => item.action === "content.workspace_published" && item.actor === "admin01"));
});

test("default page placeholders remain marked pending through publication", async (t) => {
  const { service } = await fixture(t);
  const workspace = await service.getWorkspace();
  assert.equal(workspace.pages.length, 13);
  assert.ok(workspace.pages.every((page) => page.hero.titleStatus === "pending_input"));
  assert.ok(workspace.pages.every((page) => page.hero.bodyStatus === "pending_input"));
  assert.ok(workspace.pages.every((page) => page.seo.descriptionStatus === "pending_input"));

  const published = await service.publishWorkspace({ expectedRevision: workspace.revision }, "admin01");
  const publicContent = await service.publicContent();
  assert.equal(published.workspace.pages[0].hero.titleStatus, "pending_input");
  assert.equal(publicContent.pages[0].hero.titleStatus, "pending_input");
  assert.equal(publicContent.pages[0].seo.descriptionStatus, "pending_input");
});

test("rollback restores a published snapshot without exposing later drafts", async (t) => {
  const { service } = await fixture(t);
  let workspace = await service.getWorkspace();
  workspace = await service.saveWorkspace(withHomeTitle(workspace, "版本甲", "Version A"), "admin01");
  const versionA = await service.publishWorkspace({ expectedRevision: workspace.revision }, "admin01");

  workspace = await service.saveWorkspace(withHomeTitle(workspace, "版本乙", "Version B"), "admin02");
  await service.publishWorkspace({ expectedRevision: workspace.revision }, "admin02");
  const draft = await service.saveWorkspace(withHomeTitle(workspace, "不应公开", "Must stay private"), "admin03");
  assert.equal((await service.publicContent()).pages.find((page) => page.id === "home").titleZh, "版本乙");

  const restored = await service.rollback(versionA.versionId, "developer01");
  assert.equal(restored.revision, draft.revision + 1);
  assert.equal(restored.rolledBackFrom, versionA.versionId);
  assert.notEqual(restored.publishedVersionId, versionA.versionId);
  const versions = await service.listVersions();
  assert.ok(versions.some((item) => item.id === restored.publishedVersionId && item.source === "rollback" && item.rolledBackFrom === versionA.versionId));
  assert.equal((await service.publicContent()).pages.find((page) => page.id === "home").titleZh, "版本甲");
  assert.equal(await service.rollback("missing-version", "developer01"), null);
});

test("workspace validation protects bilingual facts and structural identities", async (t) => {
  const { service } = await fixture(t);
  const cases = [
    ["duplicate primary locale", (value) => { value.primaryLocales = ["en", "en"]; }, /中文与英文/],
    ["missing paired section fact", (value) => { value.pages[0].sections = [{ id: "only-zh", kind: "copy", status: "draft", titleZh: "只有中文" }]; }, /必须成对/],
    ["duplicate page slug", (value) => { value.pages[1].slug = value.pages[0].slug; }, /页面编号或地址重复/],
    ["orphan navigation", (value) => { value.navigation[0].href = "missing.html"; }, /不存在的页面/],
    ["visible navigation to draft", (value) => { value.pages[0].status = "draft"; }, /只能指向已发布页面/],
    ["duplicate customizer step", (value) => { value.customizer.steps[1].id = value.customizer.steps[0].id; }, /定制步骤编号/],
    ["unknown code-like field", (value) => { value.runtimeScript = "alert(1)"; }, /内容结构校验失败/],
    ["orphan media reference", (value) => { value.pages[0].hero.imageAssetId = "MISSING"; }, /未登记素材/],
    ["missing media collection", (value) => { delete value.media; }, /内容结构校验失败/]
  ];
  for (const [name, mutate, pattern] of cases) {
    const candidate = defaultWorkspace();
    mutate(candidate);
    await assert.rejects(service.saveWorkspace(candidate, "admin01"), pattern, name);
  }
});

test("administrator-created pages save with explicit pending bilingual copy", async (t) => {
  const { service } = await fixture(t);
  const workspace = await service.getWorkspace();
  const id = "page-new";
  workspace.pages.push({
    id,
    slug: `${id}.html`,
    titleZh: "新页面",
    titleEn: "New page",
    status: "draft",
    template: "standard",
    hero: {
      titleZh: "新页面",
      titleEn: "New page",
      bodyZh: "待补充",
      bodyEn: "Pending input",
      bodyStatus: "pending_input"
    },
    sections: [],
    seo: {
      titleZh: "新页面",
      titleEn: "New page",
      descriptionZh: "待补充",
      descriptionEn: "Pending input",
      descriptionStatus: "pending_input",
      canonical: `${id}.html`,
      indexable: true
    }
  });
  workspace.navigation.push({
    id,
    href: `${id}.html`,
    labelZh: "新页面",
    labelEn: "New page",
    visible: false,
    order: workspace.navigation.length
  });

  const saved = await service.saveWorkspace(workspace, "admin01");
  const page = saved.pages.find((item) => item.id === id);
  const navigation = saved.navigation.find((item) => item.id === id);
  assert.equal(saved.status, "draft");
  assert.equal("titleStatus" in page.hero, false);
  assert.equal(page.hero.bodyStatus, "pending_input");
  assert.equal(page.seo.descriptionStatus, "pending_input");
  assert.equal(navigation.visible, false);
});

test("administrator-added images save without optional empty bilingual body fields", async (t) => {
  const { service } = await fixture(t);
  const workspace = await service.getWorkspace();
  const assetId = "ASSET-IMAGE-1";
  workspace.media.push({
    id: assetId,
    type: "image",
    filename: "hero.webp",
    mimeType: "image/webp",
    status: "published",
    publicUrl: `/api/public/site-assets/${assetId}`,
    thumbnailUrl: `/api/public/site-assets/${assetId}/thumbnail`
  });
  workspace.pages[0].sections.push({
    id: "media-asset-image-1",
    kind: "media",
    status: "published",
    titleZh: "hero.webp",
    titleEn: "hero.webp",
    imageAssetId: assetId
  });

  const saved = await service.saveWorkspace(workspace, "admin01");
  const section = saved.pages[0].sections.at(-1);
  assert.equal(saved.status, "draft");
  assert.equal(section.imageAssetId, assetId);
  assert.equal("bodyZh" in section, false);
  assert.equal("bodyEn" in section, false);
});

test("public snapshot excludes drafts and only exposes published managed records", async (t) => {
  const { service } = await fixture(t);
  const workspace = await service.getWorkspace();
  workspace.pages[0].sections.push(
    { id: "draft-copy", kind: "copy", status: "draft", titleZh: "草稿", titleEn: "Draft" },
    { id: "public-copy", kind: "copy", status: "published", titleZh: "公开", titleEn: "Public" }
  );
  workspace.customizer.steps.push({ id: "disabled", order: 5, titleZh: "停用", titleEn: "Disabled", enabled: false });
  workspace.customizer.modelSlots[0].status = "draft";
  const saved = await service.saveWorkspace(workspace, "admin01");
  await service.publishWorkspace({ expectedRevision: saved.revision }, "admin01");
  const publicContent = await service.publicContent();
  assert.deepEqual(publicContent.pages[0].sections.map((item) => item.id), ["public-copy"]);
  assert.ok(publicContent.customizer.steps.every((item) => item.enabled));
  assert.ok(publicContent.customizer.modelSlots.every((item) => item.status === "published"));
});

test("Agent governance blocks invalid or stale candidates and versions approved work", async (t) => {
  const { service } = await fixture(t);
  const noCandidate = await service.createAgentChange({ scope: "content", instruction: "调整首页" }, "admin01");
  assert.equal(noCandidate.status, "blocked");
  assert.match(noCandidate.agents.C.issues[0], /没有可审核/);
  await assert.rejects(service.approveAgentChange(noCandidate.id, "admin01"), (error) => error.statusCode === 409);

  const unsupported = await service.createAgentChange({ scope: "seo_geo", instruction: "生成 SEO", workspace: await service.getWorkspace() }, "admin01");
  assert.equal(unsupported.status, "blocked");
  assert.match(unsupported.agents.C.issues[0], /独立的结构化审批服务/);

  const unchanged = await service.createAgentChange({ scope: "content", instruction: "不产生变化", workspace: await service.getWorkspace() }, "admin01");
  assert.equal(unchanged.status, "blocked");
  assert.match(unchanged.agents.C.issues[0], /没有实际内容变化/);

  const crossScope = structuredClone(await service.getWorkspace());
  crossScope.siteName = "越权站名";
  const crossScopeJob = await service.createAgentChange({ scope: "navigation", instruction: "只改导航", workspace: crossScope }, "admin01");
  assert.equal(crossScopeJob.status, "blocked");
  assert.match(crossScopeJob.agents.C.issues.join(" "), /字段白名单/);

  const metadataCandidate = withHomeTitle(await service.getWorkspace(), "元数据候选", "Metadata candidate");
  metadataCandidate.publishedBy = "agent-self-publish";
  const metadataJob = await service.createAgentChange({ scope: "content", instruction: "试图自行发布", workspace: metadataCandidate }, "admin01");
  assert.equal(metadataJob.status, "blocked");
  assert.match(metadataJob.agents.C.issues.join(" "), /不得修改/);

  const base = await service.getWorkspace();
  const firstCandidate = withHomeTitle(base, "Agent 旧候选", "Stale agent candidate");
  const staleJob = await service.createAgentChange({ scope: "content", instruction: "修改首页", workspace: firstCandidate }, "admin01");
  assert.equal(staleJob.status, "ready_for_approval");
  await service.saveWorkspace(withHomeTitle(base, "管理员新草稿", "New administrator draft"), "admin02");
  await assert.rejects(service.approveAgentChange(staleJob.id, "admin01"), /必须重新生成/);

  const current = await service.getWorkspace();
  const currentCandidate = withHomeTitle(current, "Agent 已审批", "Approved agent revision");
  const currentJob = await service.createAgentChange({ scope: "content", instruction: "修改首页", workspace: currentCandidate }, "admin03");
  const approved = await service.approveAgentChange(currentJob.id, "admin04");
  assert.equal(approved.status, "published");
  assert.match(approved.publishedVersionId, /^CONTENT-VERSION-/);
  assert.equal((await service.publicContent()).pages.find((page) => page.id === "home").titleZh, "Agent 已审批");
  assert.ok((await service.listVersions()).some((item) => item.source === "agent_approval" && item.agentJobId === currentJob.id));

  const retirementBase = await service.getWorkspace();
  const retirement = structuredClone(retirementBase);
  retirement.pages[1].status = "retired";
  retirement.navigation.find((item) => item.href === retirement.pages[1].slug).visible = false;
  const retirementJob = await service.createAgentChange({ scope: "content", instruction: "下架产品页面", workspace: retirement }, "admin05");
  assert.equal(retirementJob.status, "ready_for_approval");
});

test("Agent candidate can be explicitly rejected and never reaches visitors", async (t) => {
  const { service } = await fixture(t);
  const workspace = await service.getWorkspace();
  const candidate = withHomeTitle(workspace, "拒绝候选", "Rejected candidate");
  const job = await service.createAgentChange({ scope: "content", instruction: "修改首页", workspace: candidate }, "admin01");
  const rejected = await service.rejectAgentChange(job.id, "事实来源不足", "admin02");
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.agents.A.rejectedBy, "admin02");
  assert.equal((await service.publicContent()).pages[0].titleZh, "首页");
  await assert.rejects(service.approveAgentChange(job.id, "admin03"), (error) => error.statusCode === 409);
});

test("an administrator can submit an already-saved draft for Agent approval", async (t) => {
  const { service } = await fixture(t);
  const workspace = await service.getWorkspace();
  const saved = await service.saveWorkspace(withHomeTitle(workspace, "已保存草稿", "Saved draft"), "admin01");
  const job = await service.createAgentChange({ scope: "content", instruction: "发布已保存草稿", workspace: saved }, "admin01");
  assert.equal(job.status, "ready_for_approval");
  assert.ok(job.changePaths.some((path) => path.includes("/pages/0")));
  await service.approveAgentChange(job.id, "admin02");
  assert.equal((await service.publicContent()).pages[0].titleZh, "已保存草稿");
});

test("SEO/GEO accepts managed facts while rejecting fabricated external metrics", async (t) => {
  const { service, store } = await fixture(t);
  const initial = await service.getSeoGeo();
  assert.equal(initial.siteHealth.score, null);
  assert.equal(initial.searchPerformance.clicks, null);
  assert.ok(initial.connectors.every((item) => item.status === "waiting_configuration"));

  const updated = await service.updateSeoGeo({
    brandEntity: {
      nameZh: "勤益",
      nameEn: "Qinyi",
      descriptionZh: "印刷与定制服务",
      descriptionEn: "Printing and customization services"
    },
    targetQuestions: ["勤益可以定制哪些印刷品？", "What printing products can Qinyi customize?"],
    technical: { sitemap: false }
  }, "admin01");
  assert.equal(updated.status, "draft");
  assert.equal(updated.technical.sitemap, false);
  assert.equal(updated.technical.robots, true);
  assert.equal(updated.siteHealth.score, null);
  assert.equal(await service.publicSeoGeo(), null);

  await assert.rejects(service.updateSeoGeo({ siteHealth: { score: 100 } }, "admin01"), /外部指标必须等待真实连接器/);
  await assert.rejects(service.updateSeoGeo({ brandEntity: { nameZh: "勤益" } }, "admin01"), /中英文名称与事实说明必须完整/);
  const job = await service.createSeoGeoAgentChange({ instruction: "发布事实参数" }, "admin01");
  const approved = await service.approveSeoGeoAgentChange(job.id, "admin02");
  assert.equal(approved.status, "published");
  assert.equal((await service.getSeoGeo()).publishedBy, "admin02");
  assert.equal((await service.getSeoGeo()).searchPerformance.clicks, null);
  assert.equal((await service.publicSeoGeo()).technical.sitemap, false);

  const events = await store.listEvents({ limit: 20 });
  assert.ok(events.some((item) => item.action === "seo_geo.draft_saved"));
  assert.ok(events.some((item) => item.action === "seo_geo.agent_change_approved"));
});

test("SEO/GEO uses an Agent candidate, explicit approval, versioning and rollback", async (t) => {
  const { service } = await fixture(t);
  await service.publishSeoGeo("owner");
  await service.updateSeoGeo({ targetQuestions: ["勤益支持哪些定制？", "What customization does Qinyi support?"] }, "admin01");
  const job = await service.createSeoGeoAgentChange({ instruction: "更新目标问题" }, "admin01");
  assert.equal(job.status, "ready_for_approval");
  const approved = await service.approveSeoGeoAgentChange(job.id, "admin02");
  assert.equal(approved.status, "published");
  assert.match(approved.publishedVersionId, /^SEO-GEO-VERSION-/);
  const versions = await service.listSeoGeoVersions();
  assert.ok(versions.some((item) => item.source === "agent_approval" && item.agentJobId === job.id));

  await service.updateSeoGeo({ targetQuestions: ["第二版", "Version two"] }, "admin03");
  const second = await service.createSeoGeoAgentChange({ instruction: "第二版" }, "admin03");
  const rejected = await service.rejectSeoGeoAgentChange(second.id, "事实不足", "admin04");
  assert.equal(rejected.status, "rejected");
  await assert.rejects(service.approveSeoGeoAgentChange(second.id, "admin05"), (error) => error.statusCode === 409);

  const restored = await service.rollbackSeoGeo(approved.publishedVersionId, "developer01");
  assert.equal(restored.rolledBackFrom, approved.publishedVersionId);
  assert.notEqual(restored.publishedVersionId, approved.publishedVersionId);
});
