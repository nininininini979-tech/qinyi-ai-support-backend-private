import crypto from "node:crypto";
import Ajv from "ajv";

const PAGE_DEFINITIONS = [
  ["home", "index.html", "首页", "Home", "首页", "Home"],
  ["products", "products.html", "产品", "Products", "产品", "Products"],
  ["solutions", "solutions.html", "解决方案", "Solutions", "解决方案", "Solutions"],
  ["industries", "industries.html", "行业", "Industries", "行业", "Industries"],
  ["manufacturing", "manufacturing.html", "制造能力", "Manufacturing", "制造", "Manufacturing"],
  ["projects", "projects.html", "项目案例", "Projects", "案例", "Projects"],
  ["custom-quote", "quote.html", "定制化与索取报价", "Customize & request a quote", "定制与报价", "Customize & quote"],
  ["about", "about.html", "关于勤益", "About Qinyi", "关于", "About"],
  ["insights", "insights.html", "采购洞察", "Insights", "洞察", "Insights"],
  ["faq", "faq.html", "常见问题", "FAQ", "问答", "FAQ"],
  ["contact", "contact.html", "联系我们", "Contact", "联系", "Contact"],
  ["trade", "trade.html", "贸易支持", "Trade support", "贸易", "Trade"],
  ["privacy", "privacy.html", "隐私说明", "Privacy", "隐私", "Privacy"]
];

const localizedStatusSchema = { enum: ["pending_input", "verified"] };
const safeString = { type: "string", maxLength: 4000 };

const workspaceSchema = {
  $defs: {
    safeValue: {
      anyOf: [
        { type: "string", maxLength: 20_000 },
        { type: "number" },
        { type: "boolean" },
        { type: "null" },
        { type: "array", maxItems: 200, items: { $ref: "#/$defs/safeValue" } },
        { type: "object", maxProperties: 200, additionalProperties: { $ref: "#/$defs/safeValue" } }
      ]
    }
  },
  type: "object",
  required: ["schemaVersion", "revision", "status", "siteName", "primaryLocales", "navigation", "pages", "customizer", "media"],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    revision: { type: "integer", minimum: 1 },
    status: { enum: ["draft", "published"] },
    siteName: { type: "string", minLength: 1, maxLength: 80 },
    updatedAt: { type: "string", maxLength: 80 },
    updatedBy: { type: "string", maxLength: 160 },
    publishedAt: { type: "string", maxLength: 80 },
    publishedBy: { type: "string", maxLength: 160 },
    publishedVersionId: { type: "string", pattern: "^CONTENT-VERSION-" },
    rolledBackFrom: { type: "string", pattern: "^CONTENT-VERSION-" },
    primaryLocales: {
      type: "array", minItems: 2, maxItems: 2,
      items: { enum: ["zh-CN", "en"] }
    },
    navigation: {
      type: "array", maxItems: 40,
      items: {
        type: "object", required: ["id", "href", "labelZh", "labelEn", "visible", "order"],
        additionalProperties: false,
        properties: {
          id: { type: "string", pattern: "^[a-z0-9-]{1,50}$" },
          href: { type: "string", pattern: "^[a-z0-9-]+\\.html$" },
          labelZh: { type: "string", minLength: 1, maxLength: 80 },
          labelEn: { type: "string", minLength: 1, maxLength: 100 },
          visible: { type: "boolean" },
          order: { type: "integer", minimum: 0, maximum: 1000 }
        }
      }
    },
    pages: {
      type: "array", minItems: 1, maxItems: 80,
      items: {
        type: "object", required: ["id", "slug", "titleZh", "titleEn", "status", "template", "hero", "sections", "seo"],
        additionalProperties: false,
        properties: {
          id: { type: "string", pattern: "^[a-z0-9-]{1,60}$" },
          slug: { type: "string", pattern: "^[a-z0-9-]+\\.html$" },
          titleZh: { type: "string", minLength: 1, maxLength: 160 },
          titleEn: { type: "string", minLength: 1, maxLength: 180 },
          status: { enum: ["draft", "published", "retired"] },
          template: { enum: ["standard", "catalog", "article", "quote", "legal"] },
          order: { type: "integer", minimum: 0, maximum: 1000 },
          hero: {
            type: "object", required: ["titleZh", "titleEn", "bodyZh", "bodyEn"], additionalProperties: false,
            properties: {
              titleZh: { type: "string", minLength: 1, maxLength: 200 },
              titleEn: { type: "string", minLength: 1, maxLength: 220 },
              bodyZh: { type: "string", maxLength: 1600 },
              bodyEn: { type: "string", maxLength: 1800 },
              titleStatus: localizedStatusSchema,
              bodyStatus: localizedStatusSchema,
              imageAssetId: { type: ["string", "null"], maxLength: 160 }
            }
          },
          sections: {
            type: "array", maxItems: 60,
            items: {
              type: "object", required: ["id", "kind", "status"], additionalProperties: false,
              properties: {
                id: { type: "string", pattern: "^[a-z0-9-]{1,100}$" },
                kind: { enum: ["copy", "media", "image", "model", "feature", "gallery", "faq", "cta", "process", "custom"] },
                status: { enum: ["draft", "published", "retired"] },
                order: { type: "integer", minimum: 0, maximum: 1000 },
                layout: { enum: ["default", "media-left", "media-right", "grid", "full-width"] },
                eyebrowZh: { ...safeString, maxLength: 200 }, eyebrowEn: { ...safeString, maxLength: 220 },
                titleZh: { ...safeString, maxLength: 300 }, titleEn: { ...safeString, maxLength: 360 },
                bodyZh: safeString, bodyEn: safeString,
                altZh: { ...safeString, maxLength: 300 }, altEn: { ...safeString, maxLength: 360 },
                imageAssetId: { type: ["string", "null"], maxLength: 160 },
                modelAssetId: { type: ["string", "null"], maxLength: 160 },
                assetId: { type: ["string", "null"], maxLength: 160 },
                data: { $ref: "#/$defs/safeValue" }
              }
            }
          },
          seo: {
            type: "object", required: ["titleZh", "titleEn", "descriptionZh", "descriptionEn", "canonical", "indexable"], additionalProperties: false,
            properties: {
              titleZh: { type: "string", minLength: 1, maxLength: 200 },
              titleEn: { type: "string", minLength: 1, maxLength: 240 },
              descriptionZh: { type: "string", maxLength: 1000 },
              descriptionEn: { type: "string", maxLength: 1200 },
              descriptionStatus: localizedStatusSchema,
              canonical: { type: "string", minLength: 1, maxLength: 500 },
              indexable: { type: "boolean" }
            }
          }
        }
      }
    },
    customizer: {
      type: "object", required: ["enabled", "steps", "modelSlots"], additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        steps: {
          type: "array", minItems: 1, maxItems: 20,
          items: {
            type: "object", required: ["id", "order", "titleZh", "titleEn", "enabled"], additionalProperties: false,
            properties: {
              id: { type: "string", pattern: "^[a-z0-9-]{1,100}$" },
              order: { type: "integer", minimum: 0, maximum: 1000 },
              titleZh: { type: "string", minLength: 1, maxLength: 200 }, titleEn: { type: "string", minLength: 1, maxLength: 240 },
              descriptionZh: safeString, descriptionEn: safeString,
              enabled: { type: "boolean" }, optionCount: { type: "integer", minimum: 0, maximum: 100 },
              options: { type: "array", maxItems: 100, items: { $ref: "#/$defs/safeValue" } },
              data: { $ref: "#/$defs/safeValue" }
            }
          }
        },
        modelSlots: {
          type: "array", maxItems: 30,
          items: {
            type: "object", required: ["id", "labelZh", "labelEn", "status", "assetId"], additionalProperties: false,
            properties: {
              id: { type: "string", pattern: "^[a-z0-9-]{1,100}$" },
              labelZh: { type: "string", minLength: 1, maxLength: 200 }, labelEn: { type: "string", minLength: 1, maxLength: 240 },
              status: { enum: ["pending_input", "draft", "published", "retired"] },
              assetId: { type: ["string", "null"], maxLength: 160 },
              previewImageAssetId: { type: ["string", "null"], maxLength: 160 },
              data: { $ref: "#/$defs/safeValue" }
            }
          }
        }
      }
    },
    media: {
      type: "array", maxItems: 1000,
      items: {
        type: "object", required: ["id", "type", "filename", "mimeType", "status", "publicUrl"], additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1, maxLength: 160 }, type: { enum: ["image", "model"] },
          filename: { type: "string", minLength: 1, maxLength: 500 }, mimeType: { type: "string", minLength: 1, maxLength: 160 },
          status: { enum: ["draft", "published", "retired"] }, publicUrl: { type: "string", minLength: 1, maxLength: 1000 },
          thumbnailUrl: { type: ["string", "null"], maxLength: 1000 },
          altZh: { type: "string", maxLength: 300 }, altEn: { type: "string", maxLength: 360 },
          width: { type: "integer", minimum: 1, maximum: 100_000 }, height: { type: "integer", minimum: 1, maximum: 100_000 },
          data: { $ref: "#/$defs/safeValue" }
        }
      }
    }
  }
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validateWorkspace = ajv.compile(workspaceSchema);

function now() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function clone(value) {
  return structuredClone(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function digest(value) {
  const serialized = JSON.stringify(canonicalize(value));
  return crypto.createHash("sha256").update(serialized === undefined ? "__undefined__" : serialized).digest("hex");
}

function sameValue(left, right) {
  return digest(left) === digest(right);
}

const MANAGED_METADATA_KEYS = new Set([
  "schemaVersion", "revision", "status", "updatedAt", "updatedBy", "publishedAt", "publishedBy", "publishedVersionId", "rolledBackFrom"
]);

function changedPaths(before, after, path = "", result = []) {
  if (result.length >= 200 || sameValue(before, after)) return result;
  if (Array.isArray(before) || Array.isArray(after)) {
    if (!Array.isArray(before) || !Array.isArray(after)) {
      result.push(path || "/");
      return result;
    }
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length && result.length < 200; index += 1) {
      changedPaths(before[index], after[index], `${path}/${index}`, result);
    }
    return result;
  }
  if (!before || typeof before !== "object" || !after || typeof after !== "object") {
    result.push(path || "/");
    return result;
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    if (result.length >= 200) break;
    changedPaths(before[key], after[key], `${path}/${key}`, result);
  }
  return result;
}

function pageChanges(before, after) {
  const left = new Map((before.pages || []).map((page) => [page.id, page]));
  const right = new Map((after.pages || []).map((page) => [page.id, page]));
  return [...new Set([...left.keys(), ...right.keys()])].filter((pageId) => !sameValue(left.get(pageId), right.get(pageId)));
}

function validateAgentScope(scope, before, candidate, { allowEmpty = false, protectMetadata = true } = {}) {
  const paths = changedPaths(before, candidate);
  const dataPaths = paths.filter((path) => !MANAGED_METADATA_KEYS.has(path.split("/")[1]));
  const changedRoots = new Set(dataPaths.map((path) => path.split("/")[1]).filter(Boolean));
  const allowedRoots = {
    content: new Set(["siteName", "navigation", "pages", "media"]),
    navigation: new Set(["navigation", "pages"]),
    customizer: new Set(["customizer", "media", "pages"])
  }[scope];
  const issues = [];
  const protectedPaths = paths.filter((path) => MANAGED_METADATA_KEYS.has(path.split("/")[1]));
  if (protectMetadata && protectedPaths.length) issues.push(`Agent 不得修改版本、发布状态或审计元数据：${protectedPaths.slice(0, 8).join("、")}`);
  const forbiddenRoots = [...changedRoots].filter((root) => !allowedRoots?.has(root));
  if (forbiddenRoots.length) issues.push(`${scope} 任务越过字段白名单：${forbiddenRoots.join("、")}`);
  if (scope === "customizer") {
    const forbiddenPages = pageChanges(before, candidate).filter((pageId) => pageId !== "custom-quote");
    if (forbiddenPages.length) issues.push(`定制任务不能修改其他页面：${forbiddenPages.join("、")}`);
  }
  if (scope === "navigation") {
    const beforePages = new Map((before.pages || []).map((page) => [page.id, page]));
    const afterPages = new Map((candidate.pages || []).map((page) => [page.id, page]));
    const forbiddenPageFields = [];
    for (const pageId of pageChanges(before, candidate)) {
      const left = beforePages.get(pageId);
      const right = afterPages.get(pageId);
      if (!left || !right) { forbiddenPageFields.push(pageId); continue; }
      const withoutNavigationFields = (page) => Object.fromEntries(Object.entries(page).filter(([key]) => !["slug", "status", "order"].includes(key)));
      if (!sameValue(withoutNavigationFields(left), withoutNavigationFields(right))) forbiddenPageFields.push(pageId);
    }
    if (forbiddenPageFields.length) issues.push(`导航任务不能改写页面正文：${forbiddenPageFields.join("、")}`);
  }
  if (!allowEmpty && !dataPaths.length) issues.push("候选版本没有实际内容变化。");
  return { passed: issues.length === 0, issues, paths: dataPaths, changedRoots: [...changedRoots] };
}

function validateAgentCandidate(scope, current, published, candidate) {
  const generatedDelta = validateAgentScope(scope, current, candidate, { allowEmpty: true, protectMetadata: true });
  const publicationDelta = validateAgentScope(scope, published, candidate, { allowEmpty: false, protectMetadata: false });
  const issues = [...new Set([...generatedDelta.issues, ...publicationDelta.issues])];
  return {
    passed: issues.length === 0,
    issues,
    paths: publicationDelta.paths,
    changedRoots: publicationDelta.changedRoots
  };
}

function error(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function defaultWorkspace() {
  const pages = PAGE_DEFINITIONS.map(([pageId, slug, titleZh, titleEn, navZh, navEn], index) => ({
    id: pageId,
    slug,
    titleZh,
    titleEn,
    status: "published",
    template: pageId === "custom-quote" ? "quote" : pageId === "privacy" ? "legal" : "standard",
    hero: {
      titleZh,
      titleEn,
      titleStatus: "pending_input",
      bodyZh: "待补充",
      bodyEn: "Pending input",
      bodyStatus: "pending_input"
    },
    sections: [],
    seo: {
      titleZh,
      titleEn,
      descriptionZh: "待补充",
      descriptionEn: "Pending input",
      descriptionStatus: "pending_input",
      canonical: slug,
      indexable: !["privacy"].includes(pageId)
    },
    order: index
  }));
  return {
    schemaVersion: 1,
    revision: 1,
    status: "published",
    siteName: "勤益",
    primaryLocales: ["zh-CN", "en"],
    updatedAt: now(),
    publishedAt: now(),
    navigation: pages.filter((page) => !["privacy"].includes(page.id)).map((page, order) => ({
      id: page.id,
      href: page.slug,
      labelZh: PAGE_DEFINITIONS.find((item) => item[0] === page.id)[4],
      labelEn: PAGE_DEFINITIONS.find((item) => item[0] === page.id)[5],
      visible: true,
      order
    })),
    pages,
    media: [],
    customizer: {
      enabled: true,
      steps: [
        { id: "product", order: 1, titleZh: "产品方向", titleEn: "Product direction", enabled: true, optionCount: 4 },
        { id: "structure", order: 2, titleZh: "结构与形态", titleEn: "Structure & form", enabled: true, optionCount: 4 },
        { id: "material", order: 3, titleZh: "材料与工艺", titleEn: "Materials & finishes", enabled: true, optionCount: 8 },
        { id: "visual", order: 4, titleZh: "视觉风格", titleEn: "Visual direction", enabled: true, optionCount: 6 }
      ],
      modelSlots: [
        { id: "puzzle", labelZh: "拼图模型", labelEn: "Puzzle model", status: "pending_input", assetId: null },
        { id: "paper-3d", labelZh: "纸制3D模型", labelEn: "Paper 3D model", status: "pending_input", assetId: null },
        { id: "packaging", labelZh: "包装模型", labelEn: "Packaging model", status: "pending_input", assetId: null }
      ]
    }
  };
}

function defaultSeoGeo() {
  return {
    schemaVersion: 1,
    revision: 1,
    status: "draft",
    markets: ["中国大陆", "海外"],
    primaryLocales: ["zh-CN", "en"],
    siteHealth: { score: null, message: "待补充：等待配置站点巡检" },
    searchPerformance: { clicks: null, impressions: null, averagePosition: null, message: "待补充：等待配置 Search Console" },
    geoVisibility: { citations: null, answerCoverage: null, message: "待补充：等待配置 GEO 监测" },
    brandEntity: {
      nameZh: "勤益",
      nameEn: "Qinyi Printing",
      descriptionZh: "印刷、纸制品、拼图、礼品与包装定制服务",
      descriptionEn: "Printing, paper products, puzzles, gifts and packaging customization"
    },
    targetQuestions: [],
    connectors: [
      { id: "google-search-console", name: "Google Search Console", status: "waiting_configuration" },
      { id: "ga4", name: "Google Analytics 4", status: "waiting_configuration" },
      { id: "bing-webmaster", name: "Bing Webmaster Tools", status: "waiting_configuration" },
      { id: "geo-monitor", name: "GEO 引用监测", status: "waiting_configuration" }
    ],
    technical: { sitemap: true, robots: true, canonical: true, jsonLd: true, llmsTxt: true },
    updatedAt: now()
  };
}

function ensureState(state) {
  state.contentWorkspace ||= defaultWorkspace();
  state.contentVersions ||= {};
  state.agentChangeJobs ||= {};
  state.seoGeo ||= defaultSeoGeo();
  state.seoGeoVersions ||= {};
  state.seoGeoAgentJobs ||= {};
  state.publishedSeoGeo ||= state.seoGeo.status === "published" ? clone(state.seoGeo) : null;
  if (!state.publishedContentWorkspace) {
    const latestPublishedVersion = Object.values(state.contentVersions)
      .filter((item) => item?.workspace?.status === "published")
      .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))[0];
    state.publishedContentWorkspace = clone(
      latestPublishedVersion?.workspace
      || (state.contentWorkspace.status === "published" ? state.contentWorkspace : defaultWorkspace())
    );
  }
  return state;
}

function validateBilingualPairs(value, path = "/") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateBilingualPairs(item, `${path}${index}/`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, field] of Object.entries(value)) {
    if (key.endsWith("Zh")) {
      const pairedKey = `${key.slice(0, -2)}En`;
      if (typeof field !== "string" || !field.trim() || typeof value[pairedKey] !== "string" || !value[pairedKey].trim()) {
        throw error(`中英文字段必须成对且非空：${path}${key} / ${pairedKey}`, 409);
      }
    }
    if (key.endsWith("En")) {
      const pairedKey = `${key.slice(0, -2)}Zh`;
      if (typeof field !== "string" || !field.trim() || typeof value[pairedKey] !== "string" || !value[pairedKey].trim()) {
        throw error(`中英文字段必须成对且非空：${path}${pairedKey} / ${key}`, 409);
      }
    }
    validateBilingualPairs(field, `${path}${key}/`);
  }
}

function validateOrThrow(workspace) {
  const serialized = JSON.stringify(workspace);
  if (serialized.length > 1_500_000) throw error("内容工作区超过 1.5MB 限制。");
  if (!validateWorkspace(workspace)) {
    const detail = validateWorkspace.errors?.slice(0, 4).map((item) => `${item.instancePath || "/"} ${item.message}`).join("；");
    throw error(`内容结构校验失败：${detail || "未知错误"}`);
  }
  if (new Set(workspace.primaryLocales).size !== 2 || !workspace.primaryLocales.includes("zh-CN") || !workspace.primaryLocales.includes("en")) {
    throw error("中文与英文必须同时作为事实主版本。", 409);
  }
  validateBilingualPairs(workspace);
  const ids = new Set();
  const slugs = new Set();
  const pagesBySlug = new Map();
  for (const page of workspace.pages) {
    if (ids.has(page.id) || slugs.has(page.slug)) throw error("页面编号或地址重复。", 409);
    ids.add(page.id);
    slugs.add(page.slug);
    pagesBySlug.set(page.slug, page);
    if (!page.titleZh.trim() || !page.titleEn.trim() || !page.hero.titleZh.trim() || !page.hero.titleEn.trim()) {
      throw error(`页面 ${page.id} 的中英文事实字段不完整。`, 409);
    }
  }
  const navigationIds = new Set();
  const navigationHrefs = new Set();
  for (const item of workspace.navigation) {
    if (!slugs.has(item.href)) throw error(`导航 ${item.id} 指向不存在的页面。`, 409);
    if (navigationIds.has(item.id) || navigationHrefs.has(item.href)) throw error("导航编号或目标地址重复。", 409);
    navigationIds.add(item.id);
    navigationHrefs.add(item.href);
    if (item.visible && pagesBySlug.get(item.href)?.status !== "published") throw error(`可见导航 ${item.id} 只能指向已发布页面。`, 409);
  }
  for (const [label, items] of [["定制步骤", workspace.customizer.steps], ["模型插槽", workspace.customizer.modelSlots]]) {
    const itemIds = new Set();
    for (const item of items) {
      if (!item?.id || itemIds.has(item.id)) throw error(`${label}编号缺失或重复。`, 409);
      itemIds.add(item.id);
    }
  }
  const mediaIds = new Set(workspace.media.map((item) => item.id));
  const references = [];
  for (const page of workspace.pages) {
    if (page.hero.imageAssetId) references.push([page.hero.imageAssetId, `页面 ${page.id} Hero`]);
    for (const section of page.sections) {
      for (const key of ["assetId", "imageAssetId", "modelAssetId"]) if (section[key]) references.push([section[key], `页面 ${page.id} 板块 ${section.id}`]);
    }
  }
  for (const slot of workspace.customizer.modelSlots) {
    if (slot.assetId) references.push([slot.assetId, `模型插槽 ${slot.id}`]);
    if (slot.previewImageAssetId) references.push([slot.previewImageAssetId, `模型插槽 ${slot.id} 预览图`]);
  }
  for (const [assetId, location] of references) if (!mediaIds.has(assetId)) throw error(`${location} 引用了未登记素材 ${assetId}。`, 409);
  for (const asset of workspace.media) {
    const expectedUrl = `/api/public/site-assets/${asset.id}`;
    const expectedThumbnail = asset.type === "image" ? `${expectedUrl}/thumbnail` : null;
    if (asset.publicUrl !== expectedUrl || (asset.thumbnailUrl ?? null) !== expectedThumbnail) {
      throw error(`素材 ${asset.id} 的公开地址必须由系统生成。`, 409);
    }
  }
  return workspace;
}

function publicWorkspace(workspace) {
  const publishedPages = workspace.pages.filter((item) => item.status === "published").map((page) => ({
    ...clone(page),
    sections: page.sections.filter((section) => section.status === "published")
  }));
  const value = {
    schemaVersion: workspace.schemaVersion,
    revision: workspace.revision,
    publishedVersionId: workspace.publishedVersionId || null,
    siteName: workspace.siteName,
    primaryLocales: workspace.primaryLocales,
    navigation: workspace.navigation.filter((item) => item.visible).sort((a, b) => a.order - b.order),
    pages: publishedPages,
    customizer: {
      ...clone(workspace.customizer),
      steps: workspace.customizer.steps.filter((item) => item.enabled),
      modelSlots: workspace.customizer.modelSlots.filter((item) => item.status === "published")
    },
    media: workspace.media.filter((item) => item.status === "published"),
    publishedAt: workspace.publishedAt
  };
  return { ...value, contentHash: digest(value) };
}

function publishSnapshot(state, workspace, { actor, source, agentJobId, rolledBackFrom, publishedAt = now() }) {
  const versionId = id("CONTENT-VERSION");
  const published = {
    ...clone(workspace),
    status: "published",
    updatedAt: publishedAt,
    publishedAt,
    publishedBy: actor,
    publishedVersionId: versionId,
    ...(rolledBackFrom ? { rolledBackFrom } : {})
  };
  state.contentWorkspace = clone(published);
  state.publishedContentWorkspace = clone(published);
  const publishedContent = publicWorkspace(published);
  state.contentVersions[versionId] = {
    id: versionId,
    revision: published.revision,
    contentHash: publishedContent.contentHash,
    workspace: clone(published),
    createdAt: publishedAt,
    actor,
    source,
    ...(agentJobId ? { agentJobId } : {}),
    ...(rolledBackFrom ? { rolledBackFrom } : {})
  };
  return { workspace: clone(published), versionId };
}

const SEO_GEO_EDITABLE_KEYS = new Set(["markets", "brandEntity", "targetQuestions", "technical"]);

function validateSeoGeoChanges(changes) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw error("SEO/GEO 修改必须为对象。");
  const serialized = JSON.stringify(changes);
  if (serialized.length > 500_000) throw error("SEO/GEO 配置过大。");
  const unsupported = Object.keys(changes).filter((key) => !SEO_GEO_EDITABLE_KEYS.has(key));
  if (unsupported.length) throw error(`SEO/GEO 字段不可由人工写入：${unsupported.join("、")}。外部指标必须等待真实连接器。`, 400);
  if (changes.markets !== undefined && (!Array.isArray(changes.markets) || changes.markets.length > 30 || changes.markets.some((item) => typeof item !== "string" || !item.trim() || item.length > 80))) {
    throw error("SEO/GEO 市场列表无效。");
  }
  if (changes.targetQuestions !== undefined && (!Array.isArray(changes.targetQuestions) || changes.targetQuestions.length > 100 || changes.targetQuestions.some((item) => typeof item !== "string" || !item.trim() || item.length > 500))) {
    throw error("SEO/GEO 目标问题列表无效。");
  }
  if (changes.brandEntity !== undefined) {
    if (!changes.brandEntity || typeof changes.brandEntity !== "object" || Array.isArray(changes.brandEntity)) throw error("SEO/GEO 品牌实体无效。");
    const keys = ["nameZh", "nameEn", "descriptionZh", "descriptionEn"];
    if (Object.keys(changes.brandEntity).some((key) => !keys.includes(key)) || keys.some((key) => typeof changes.brandEntity[key] !== "string" || !changes.brandEntity[key].trim())) {
      throw error("SEO/GEO 品牌实体的中英文名称与事实说明必须完整。", 409);
    }
  }
  if (changes.technical !== undefined) {
    const allowed = ["sitemap", "robots", "canonical", "jsonLd", "llmsTxt"];
    if (!changes.technical || typeof changes.technical !== "object" || Array.isArray(changes.technical)
      || Object.keys(changes.technical).some((key) => !allowed.includes(key))
      || Object.values(changes.technical).some((value) => typeof value !== "boolean")) {
      throw error("SEO/GEO 技术输出配置无效。");
    }
  }
  return clone(changes);
}

function validateSeoGeoForPublish(value) {
  if (!value || typeof value !== "object") throw error("SEO/GEO 配置不存在。", 409);
  if (new Set(value.primaryLocales || []).size !== 2 || !value.primaryLocales.includes("zh-CN") || !value.primaryLocales.includes("en")) {
    throw error("SEO/GEO 必须保留中文与英文事实主版本。", 409);
  }
  validateBilingualPairs(value.brandEntity, "/brandEntity/");
  if (!Array.isArray(value.connectors) || value.connectors.some((item) => !item?.id || !item?.name || !item?.status)) {
    throw error("SEO/GEO 连接器配置不完整。", 409);
  }
  return value;
}

export class ContentGovernanceService {
  constructor({ store }) {
    this.store = store;
  }

  async getWorkspace() {
    return this.store.read((state) => clone(ensureState(state).contentWorkspace));
  }

  async saveWorkspace(input, actor = "admin") {
    const candidate = validateOrThrow(clone(input));
    const updatedAt = now();
    return this.store.transact((state) => {
      ensureState(state);
      const revision = Number(state.contentWorkspace.revision || 0) + 1;
      const editable = clone(candidate);
      for (const key of ["revision", "status", "updatedAt", "updatedBy", "publishedAt", "publishedBy", "publishedVersionId", "rolledBackFrom"]) delete editable[key];
      const publication = Object.fromEntries(["publishedAt", "publishedBy", "publishedVersionId", "rolledBackFrom"]
        .filter((key) => state.contentWorkspace[key] !== undefined)
        .map((key) => [key, state.contentWorkspace[key]]));
      state.contentWorkspace = { ...editable, ...publication, revision, status: "draft", updatedAt, updatedBy: actor };
      return clone(state.contentWorkspace);
    }, { kind: "audit", action: "content.workspace_saved", actor });
  }

  async publishWorkspace({ expectedRevision } = {}, actor = "admin") {
    const publishedAt = now();
    return this.store.transact((state) => {
      ensureState(state);
      const workspace = validateOrThrow(state.contentWorkspace);
      if (expectedRevision != null && Number(expectedRevision) !== Number(workspace.revision)) {
        throw Object.assign(new Error("内容版本已经变化，请刷新后重新发布。"), { statusCode: 409 });
      }
      return publishSnapshot(state, workspace, { actor, source: "manual_publish", publishedAt });
    }, { kind: "audit", action: "content.workspace_published", actor });
  }

  async listVersions() {
    return this.store.read((state) => Object.values(ensureState(state).contentVersions).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(({ workspace, ...item }) => ({ ...item, pageCount: workspace.pages.length })));
  }

  async getVersion(versionId) {
    return this.store.read((state) => {
      const version = ensureState(state).contentVersions[versionId];
      return version ? clone(version) : null;
    });
  }

  async rollback(versionId, actor = "developer") {
    const restoredAt = now();
    return this.store.transact((state) => {
      ensureState(state);
      const version = state.contentVersions[versionId];
      if (!version) return null;
      const revision = Number(state.contentWorkspace.revision || 0) + 1;
      const restored = { ...clone(version.workspace), revision };
      delete restored.publishedVersionId;
      const result = publishSnapshot(state, restored, { actor, source: "rollback", rolledBackFrom: versionId, publishedAt: restoredAt });
      return result.workspace;
    }, { kind: "audit", action: "content.workspace_rolled_back", actor, entityId: versionId });
  }

  async publicContent() {
    return this.store.read((state) => publicWorkspace(ensureState(state).publishedContentWorkspace));
  }

  async publicSeoGeo() {
    return this.store.read((state) => {
      const published = ensureState(state).publishedSeoGeo;
      if (!published) return null;
      const value = {
        schemaVersion: published.schemaVersion,
        revision: published.revision,
        status: "published",
        publishedVersionId: published.publishedVersionId || null,
        publishedAt: published.publishedAt || null,
        markets: clone(published.markets || []),
        primaryLocales: clone(published.primaryLocales || ["zh-CN", "en"]),
        brandEntity: clone(published.brandEntity || {}),
        targetQuestions: clone(published.targetQuestions || []),
        technical: clone(published.technical || {})
      };
      return { ...value, contentHash: digest(value) };
    });
  }

  async createAgentChange({ scope = "content", instruction, workspace }, actor = "admin") {
    const createdAt = now();
    const jobId = id("AGENT-JOB");
    let validation = { passed: true, issues: [] };
    if (!["content", "navigation", "customizer"].includes(scope)) {
      validation = { passed: false, issues: [scope === "rules"
        ? "客服规则使用独立的受控运行时规则服务，请在客服规则页面修改。"
        : `${scope} 使用独立的结构化审批服务，请在对应页面提交。`] };
    } else if (!workspace) {
      validation = { passed: false, issues: ["没有可审核的结构化候选版本。"] };
    } else {
      try { validateOrThrow(workspace); } catch (error) { validation = { passed: false, issues: [error.message] }; }
    }
    return this.store.transact((state) => {
      ensureState(state);
      const currentRevision = Number(state.contentWorkspace.revision || 0);
      if (workspace && Number(workspace.revision) !== currentRevision) {
        validation = { passed: false, issues: ["候选版本基于过期的内容版本，请重新生成。"] };
      } else if (workspace && validation.passed) {
        validation = validateAgentCandidate(scope, state.contentWorkspace, state.publishedContentWorkspace, workspace);
      }
      const job = {
        id: jobId, scope, instruction: String(instruction || "").slice(0, 4000),
        status: validation.passed ? "ready_for_approval" : "blocked",
        agents: {
          B: { status: "complete", output: workspace ? "已生成结构化候选版本" : "未生成候选版本" },
          C: { status: validation.passed ? "passed" : "rejected", issues: validation.issues },
          A: { status: validation.passed ? "waiting_admin_approval" : "blocked" },
          D: { status: "recorded", suggestion: "保留本次差异用于后续改良评估" }
        },
        baseRevision: currentRevision,
        baseContentHash: digest(state.contentWorkspace),
        candidateWorkspace: workspace ? clone(workspace) : null,
        candidateContentHash: workspace ? digest(workspace) : null,
        changePaths: validation.paths || [],
        risk: validation.passed ? "review_required" : "blocked",
        uncertainty: workspace ? "结构已验证，业务事实仍需管理员确认" : "等待 Agent 生成结构化候选版本",
        createdAt, updatedAt: createdAt, actor
      };
      state.agentChangeJobs[job.id] = job;
      return clone(job);
    }, { kind: "agent", action: "content.agent_change_created", actor, entityId: jobId });
  }

  async listAgentChanges() {
    return this.store.read((state) => Object.values(ensureState(state).agentChangeJobs).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }

  async approveAgentChange(jobId, actor = "admin") {
    const approvedAt = now();
    return this.store.transact((state) => {
      ensureState(state);
      const job = state.agentChangeJobs[jobId];
      if (!job) return null;
      if (job.status !== "ready_for_approval") throw error("该任务当前不能批准。", 409);
      if (Number(state.contentWorkspace.revision || 0) !== Number(job.baseRevision)) {
        throw error("内容版本已经变化，该 Agent 候选必须重新生成。", 409);
      }
      if (digest(state.contentWorkspace) !== job.baseContentHash) throw error("基础内容校验失败，该 Agent 候选必须重新生成。", 409);
      if (!job.candidateWorkspace || digest(job.candidateWorkspace) !== job.candidateContentHash) throw error("Agent 候选完整性校验失败。", 409);
      if (job.candidateWorkspace) {
        const candidate = validateOrThrow(job.candidateWorkspace);
        const scopeValidation = validateAgentCandidate(job.scope, state.contentWorkspace, state.publishedContentWorkspace, candidate);
        if (!scopeValidation.passed) throw error(`Agent 候选不再满足字段白名单：${scopeValidation.issues.join("；")}`, 409);
        const next = { ...clone(candidate), revision: Number(state.contentWorkspace.revision || 0) + 1 };
        const published = publishSnapshot(state, next, { actor, source: "agent_approval", agentJobId: jobId, publishedAt: approvedAt });
        job.publishedVersionId = published.versionId;
      }
      job.status = "published";
      job.agents.A = { status: "published", approvedBy: actor, approvedAt };
      job.updatedAt = approvedAt;
      return clone(job);
    }, { kind: "audit", action: "content.agent_change_approved", actor, entityId: jobId });
  }

  async rejectAgentChange(jobId, reason, actor = "admin") {
    const rejectedAt = now();
    return this.store.transact((state) => {
      ensureState(state);
      const job = state.agentChangeJobs[jobId];
      if (!job) return null;
      if (job.status !== "ready_for_approval") throw error("该任务当前不能驳回。", 409);
      job.status = "rejected";
      job.agents.A = { status: "rejected", rejectedBy: actor, rejectedAt, reason };
      job.updatedAt = rejectedAt;
      return clone(job);
    }, { kind: "audit", action: "content.agent_change_rejected", actor, entityId: jobId });
  }

  async getSeoGeo() {
    return this.store.read((state) => clone(ensureState(state).seoGeo));
  }

  async updateSeoGeo(changes, actor = "admin") {
    const validatedChanges = validateSeoGeoChanges(changes);
    return this.store.transact((state) => {
      ensureState(state);
      const revision = Number(state.seoGeo.revision || 0) + 1;
      state.seoGeo = {
        ...state.seoGeo,
        ...validatedChanges,
        ...(validatedChanges.brandEntity ? { brandEntity: { ...state.seoGeo.brandEntity, ...validatedChanges.brandEntity } } : {}),
        ...(validatedChanges.technical ? { technical: { ...state.seoGeo.technical, ...validatedChanges.technical } } : {}),
        revision,
        status: "draft",
        updatedAt: now(),
        updatedBy: actor
      };
      return clone(state.seoGeo);
    }, { kind: "audit", action: "seo_geo.draft_saved", actor });
  }

  async publishSeoGeo(actor = "admin") {
    return this.store.transact((state) => {
      ensureState(state);
      validateSeoGeoForPublish(state.seoGeo);
      const versionId = id("SEO-GEO-VERSION");
      state.seoGeo.status = "published";
      state.seoGeo.publishedAt = now();
      state.seoGeo.publishedBy = actor;
      state.seoGeo.publishedVersionId = versionId;
      state.publishedSeoGeo = clone(state.seoGeo);
      state.seoGeoVersions[versionId] = { id: versionId, revision: state.seoGeo.revision, value: clone(state.seoGeo), createdAt: state.seoGeo.publishedAt, actor, source: "system_owner_recovery" };
      return clone(state.seoGeo);
    }, { kind: "audit", action: "seo_geo.published", actor });
  }

  async createSeoGeoAgentChange({ instruction }, actor = "admin") {
    const createdAt = now();
    const jobId = id("SEO-GEO-JOB");
    return this.store.transact((state) => {
      ensureState(state);
      validateSeoGeoForPublish(state.seoGeo);
      const published = state.publishedSeoGeo || defaultSeoGeo();
      const editable = (value) => Object.fromEntries([...SEO_GEO_EDITABLE_KEYS].map((key) => [key, value[key]]));
      const changed = !sameValue(editable(published), editable(state.seoGeo));
      const basePublishedVersionId = state.publishedSeoGeo?.publishedVersionId || null;
      const job = {
        id: jobId,
        scope: "seo_geo",
        instruction: String(instruction || "").slice(0, 4000),
        status: changed ? "ready_for_approval" : "blocked",
        baseRevision: Number(state.seoGeo.revision || 0),
        basePublishedVersionId,
        baseContentHash: digest(state.seoGeo),
        candidateContentHash: digest(editable(state.seoGeo)),
        candidate: clone(state.seoGeo),
        agents: {
          B: { status: "complete", output: "已生成 SEO/GEO 结构化候选" },
          C: { status: changed ? "passed" : "rejected", issues: changed ? [] : ["候选版本没有实际参数变化。"] },
          A: { status: changed ? "waiting_admin_approval" : "blocked" },
          D: { status: "recorded", suggestion: "真实外部指标只能由已验证连接器写入" }
        },
        risk: changed ? "review_required" : "blocked",
        uncertainty: "外部点击、排名与引用指标仍等待真实连接器",
        createdAt,
        updatedAt: createdAt,
        actor
      };
      state.seoGeoAgentJobs[jobId] = job;
      return clone(job);
    }, { kind: "agent", action: "seo_geo.agent_change_created", actor, entityId: jobId });
  }

  async listSeoGeoAgentChanges() {
    return this.store.read((state) => Object.values(ensureState(state).seoGeoAgentJobs).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }

  async approveSeoGeoAgentChange(jobId, actor = "admin") {
    const approvedAt = now();
    return this.store.transact((state) => {
      ensureState(state);
      const job = state.seoGeoAgentJobs[jobId];
      if (!job) return null;
      if (job.status !== "ready_for_approval") throw error("该 SEO/GEO 候选当前不能批准。", 409);
      if (Number(state.seoGeo.revision || 0) !== job.baseRevision || digest(state.seoGeo) !== job.baseContentHash) throw error("SEO/GEO 草稿已经变化，请重新提交审核。", 409);
      if ((state.publishedSeoGeo?.publishedVersionId || null) !== job.basePublishedVersionId) throw error("SEO/GEO 已发布版本已经变化，请重新提交审核。", 409);
      if (digest(Object.fromEntries([...SEO_GEO_EDITABLE_KEYS].map((key) => [key, job.candidate[key]]))) !== job.candidateContentHash) throw error("SEO/GEO 候选完整性校验失败。", 409);
      validateSeoGeoForPublish(job.candidate);
      const versionId = id("SEO-GEO-VERSION");
      state.seoGeo = { ...clone(job.candidate), status: "published", publishedAt: approvedAt, publishedBy: actor, publishedVersionId: versionId };
      state.publishedSeoGeo = clone(state.seoGeo);
      state.seoGeoVersions[versionId] = { id: versionId, revision: state.seoGeo.revision, value: clone(state.seoGeo), createdAt: approvedAt, actor, source: "agent_approval", agentJobId: jobId };
      job.status = "published";
      job.publishedVersionId = versionId;
      job.agents.A = { status: "published", approvedBy: actor, approvedAt };
      job.updatedAt = approvedAt;
      return clone(job);
    }, { kind: "audit", action: "seo_geo.agent_change_approved", actor, entityId: jobId });
  }

  async rejectSeoGeoAgentChange(jobId, reason, actor = "admin") {
    return this.store.transact((state) => {
      ensureState(state);
      const job = state.seoGeoAgentJobs[jobId];
      if (!job) return null;
      if (job.status !== "ready_for_approval") throw error("该 SEO/GEO 候选当前不能驳回。", 409);
      job.status = "rejected";
      job.updatedAt = now();
      job.agents.A = { status: "rejected", rejectedBy: actor, rejectedAt: job.updatedAt, reason };
      return clone(job);
    }, { kind: "audit", action: "seo_geo.agent_change_rejected", actor, entityId: jobId });
  }

  async listSeoGeoVersions() {
    return this.store.read((state) => Object.values(ensureState(state).seoGeoVersions).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(({ value, ...item }) => item));
  }

  async rollbackSeoGeo(versionId, actor = "developer") {
    return this.store.transact((state) => {
      ensureState(state);
      const version = state.seoGeoVersions[versionId];
      if (!version) return null;
      const restoredAt = now();
      const newVersionId = id("SEO-GEO-VERSION");
      state.seoGeo = { ...clone(version.value), revision: Number(state.seoGeo.revision || 0) + 1, status: "published", publishedAt: restoredAt, publishedBy: actor, publishedVersionId: newVersionId, rolledBackFrom: versionId };
      state.publishedSeoGeo = clone(state.seoGeo);
      state.seoGeoVersions[newVersionId] = { id: newVersionId, revision: state.seoGeo.revision, value: clone(state.seoGeo), createdAt: restoredAt, actor, source: "rollback", rolledBackFrom: versionId };
      return clone(state.seoGeo);
    }, { kind: "audit", action: "seo_geo.rolled_back", actor, entityId: versionId });
  }
}

export { defaultSeoGeo, defaultWorkspace, validateSeoGeoChanges, validateWorkspace };
