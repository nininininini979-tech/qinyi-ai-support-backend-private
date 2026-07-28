const STATIC_PAGE_SLUGS = new Set([
  "index.html",
  "products.html",
  "solutions.html",
  "industries.html",
  "manufacturing.html",
  "projects.html",
  "quote.html",
  "about.html",
  "insights.html",
  "faq.html",
  "contact.html",
  "trade.html",
  "privacy.html"
]);

const DEFAULT_TECHNICAL = Object.freeze({
  sitemap: true,
  robots: true,
  canonical: true,
  jsonLd: true,
  llmsTxt: true
});

const RUNTIME_MESSAGES = Object.freeze({
  en: {
    "common.qinyi": "Qinyi Printing",
    "common.qinyi_home": "Qinyi Printing home",
    "common.nav.products": "Products",
    "common.nav.trade": "OEM & Trade Partnership",
    "common.nav.manufacturing": "Manufacturing & Quality",
    "common.nav.projects": "Case Studies",
    "common.nav.company": "Company",
    "common.nav.contact": "Contact",
    "common.nav.privacy": "Privacy & file security",
    "common.nav.custom_quote": "Customize & request a quote",
    "common.menu.open": "Open menu",
    "common.menu.close": "Close menu",
    "common.language.label": "Website language",
    "common.floating.quote": "Request a quote"
  },
  "zh-CN": {
    "common.qinyi": "勤益",
    "common.qinyi_home": "勤益首页",
    "common.nav.products": "产品",
    "common.nav.trade": "OEM 与贸易合作",
    "common.nav.manufacturing": "制造与质量",
    "common.nav.projects": "客户案例",
    "common.nav.company": "公司",
    "common.nav.contact": "联系我们",
    "common.nav.privacy": "隐私和文件安全",
    "common.nav.custom_quote": "定制化与索取报价",
    "common.menu.open": "打开菜单",
    "common.menu.close": "关闭菜单",
    "common.language.label": "网站语言",
    "common.floating.quote": "索取报价"
  }
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (token) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  })[token]);
}

function jsonScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function normalizedBaseUrl(value, fallback) {
  let parsed;
  try { parsed = new URL(String(value || fallback)); }
  catch (_error) { parsed = new URL(fallback); }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) parsed = new URL(fallback);
  parsed.hash = "";
  parsed.search = "";
  return parsed.href.replace(/\/+$/, "");
}

function localized(value, field, locale) {
  return String(value?.[`${field}${locale === "zh-CN" ? "Zh" : "En"}`] ?? "").trim();
}

function normalizedLocale(value) {
  return String(value || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function technicalSettings(seoGeo) {
  return { ...DEFAULT_TECHNICAL, ...(seoGeo?.technical || {}) };
}

function localePath(locale, slug) {
  return slug === "index.html" ? `${locale}/` : `${locale}/${encodeURIComponent(slug)}`;
}

function pageDeliveryUrl(page, locale, { siteBaseUrl, apiBaseUrl } = {}) {
  const siteBase = normalizedBaseUrl(siteBaseUrl, "https://nininininini979-tech.github.io/qinyi-printing-website");
  const apiBase = normalizedBaseUrl(apiBaseUrl, siteBase);
  if (STATIC_PAGE_SLUGS.has(page.slug)) return `${siteBase}/${localePath(locale, page.slug)}`;
  return `${apiBase}/site/${encodeURIComponent(locale)}/${encodeURIComponent(page.slug)}`;
}

function explicitCanonical(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.href;
  } catch (_error) {
    // Relative canonical values use the controlled delivery URL.
  }
  return null;
}

function publicPages(content) {
  return Array.isArray(content?.pages) ? content.pages.filter((page) => page?.status === "published") : [];
}

function publicNavigation(content) {
  return Array.isArray(content?.navigation)
    ? content.navigation.filter((item) => item?.visible !== false).sort((left, right) => Number(left.order || 0) - Number(right.order || 0))
    : [];
}

function pageBySlug(content, slug, { preview = false } = {}) {
  const pages = Array.isArray(content?.pages) ? content.pages : [];
  return pages.find((page) => page?.slug === slug && (preview ? page.status !== "retired" : page.status === "published")) || null;
}

function pageMetadata({ content, page, seoGeo, locale, siteBaseUrl, apiBaseUrl, preview = false }) {
  const selectedLocale = normalizedLocale(locale);
  const technical = technicalSettings(seoGeo);
  const deliveryUrl = pageDeliveryUrl(page, selectedLocale, { siteBaseUrl, apiBaseUrl });
  const canonical = technical.canonical && !preview
    ? explicitCanonical(page.seo?.canonical) || deliveryUrl
    : null;
  const title = localized(page.seo, "title", selectedLocale) || localized(page, "title", selectedLocale);
  const pendingDescription = page.seo?.descriptionStatus === "pending_input";
  const description = pendingDescription ? "" : localized(page.seo, "description", selectedLocale);
  const entity = seoGeo?.brandEntity || {};
  const organizationName = localized(entity, "name", selectedLocale) || content.siteName || "Qinyi Printing";
  const organizationDescription = localized(entity, "description", selectedLocale);
  const organizationUrl = `${normalizedBaseUrl(siteBaseUrl, deliveryUrl)}/`;
  const jsonLd = technical.jsonLd && !preview ? {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": ["Organization", "ManufacturingBusiness"],
        "@id": `${organizationUrl}#organization`,
        name: organizationName,
        url: organizationUrl,
        ...(organizationDescription ? { description: organizationDescription } : {})
      },
      {
        "@type": "WebPage",
        "@id": `${canonical || deliveryUrl}#webpage`,
        url: canonical || deliveryUrl,
        name: title,
        inLanguage: selectedLocale,
        isPartOf: { "@id": `${organizationUrl}#organization` },
        ...(description ? { description } : {})
      }
    ]
  } : null;
  return {
    locale: selectedLocale,
    deliveryUrl,
    canonical,
    title,
    description,
    robots: preview || page.seo?.indexable === false ? "noindex,nofollow" : "index,follow",
    jsonLd,
    technical
  };
}

function bodyWithBreaks(value) {
  return escapeHtml(value).replace(/\r?\n/g, "<br>");
}

function flatText(value, fallback = "") {
  return String(value ?? fallback).replace(/[\r\n]+/g, " ").trim();
}

function renderData(value, locale) {
  if (value == null || value === "") return "";
  if (Array.isArray(value)) {
    const items = value.filter((item) => item != null && item !== "");
    if (!items.length) return "";
    return `<ul class="managed-data">${items.map((item) => `<li>${typeof item === "object" ? escapeHtml(JSON.stringify(item)) : escapeHtml(item)}</li>`).join("")}</ul>`;
  }
  if (typeof value === "object") {
    const items = Object.entries(value).filter(([, item]) => item != null && item !== "");
    if (!items.length) return "";
    return `<dl class="managed-data">${items.map(([key, item]) => `<div><dt>${escapeHtml(key)}</dt><dd>${typeof item === "object" ? escapeHtml(JSON.stringify(item)) : escapeHtml(item)}</dd></div>`).join("")}</dl>`;
  }
  return `<p class="lede">${bodyWithBreaks(value || (locale === "zh-CN" ? "待补充" : "Pending input"))}</p>`;
}

function renderSection(section, locale, { apiBaseUrl, preview }) {
  const eyebrow = localized(section, "eyebrow", locale);
  const title = localized(section, "title", locale);
  const body = localized(section, "body", locale);
  const alt = localized(section, "alt", locale) || title;
  const assetId = section.imageAssetId || (["image", "media"].includes(section.kind) ? section.assetId : null);
  const media = assetId && !preview
    ? `<figure class="qinyi-managed-media"><img src="${escapeHtml(`${normalizedBaseUrl(apiBaseUrl, "http://127.0.0.1")}/api/public/site-assets/${encodeURIComponent(assetId)}`)}" alt="${escapeHtml(alt)}" loading="lazy"></figure>`
    : assetId
      ? `<div class="feature"><strong>${locale === "zh-CN" ? "预览素材" : "Preview asset"}</strong><p>${escapeHtml(assetId)}</p></div>`
      : section.modelAssetId
        ? `<div class="feature"><strong>${locale === "zh-CN" ? "3D 模型位置" : "3D model slot"}</strong><p>${escapeHtml(section.modelAssetId)}</p></div>`
        : "";
  const copy = `<div class="qinyi-managed-copy">${eyebrow ? `<p class="eyebrow">${escapeHtml(eyebrow)}</p>` : ""}${title ? `<h2>${escapeHtml(title)}</h2>` : ""}${body ? `<p class="lede">${bodyWithBreaks(body)}</p>` : ""}${renderData(section.data, locale)}</div>`;
  return `<section class="section qinyi-managed-section" data-kind="${escapeHtml(section.kind || "copy")}"><div class="container qinyi-managed-grid">${section.layout === "media-left" ? `${media}${copy}` : `${copy}${media}`}</div></section>`;
}

function navigationHref(item, content, locale, options) {
  const page = (content.pages || []).find((candidate) => candidate.slug === item.href);
  return page ? pageDeliveryUrl(page, locale, options) : `${normalizedBaseUrl(options.siteBaseUrl, "https://nininininini979-tech.github.io/qinyi-printing-website")}/${localePath(locale, item.href)}`;
}

function renderRuntimeScripts(locale, siteBaseUrl, apiBaseUrl, slug, nonce) {
  const siteBase = normalizedBaseUrl(siteBaseUrl, "https://nininininini979-tech.github.io/qinyi-printing-website");
  const payload = { locale, rootAlias: false, messages: RUNTIME_MESSAGES[locale] };
  const managedPage = { slug, apiBaseUrl: normalizedBaseUrl(apiBaseUrl, siteBase) };
  return `<script nonce="${escapeHtml(nonce)}">window.QINYI_I18N=${jsonScript(payload)};window.QINYI_MANAGED_PAGE=${jsonScript(managedPage)};</script>
  <script src="${escapeHtml(`${siteBase}/assets/support-config.js?v=20260728-platform-v1`)}"></script>
  <script src="${escapeHtml(`${siteBase}/assets/app.js?v=20260728-platform-v1`)}" defer></script>
  <script src="${escapeHtml(`${siteBase}/assets/site-content-runtime.js?v=20260728-platform-v1`)}" defer></script>`;
}

function renderPageDocument({ content, page, seoGeo, locale, siteBaseUrl, apiBaseUrl, preview = false, nonce = "qinyi-preview" }) {
  const metadata = pageMetadata({ content, page, seoGeo, locale, siteBaseUrl, apiBaseUrl, preview });
  const selectedLocale = metadata.locale;
  const siteBase = normalizedBaseUrl(siteBaseUrl, "https://nininininini979-tech.github.io/qinyi-printing-website");
  const heroTitle = localized(page.hero, "title", selectedLocale) || localized(page, "title", selectedLocale);
  const heroBody = page.hero?.bodyStatus === "pending_input"
    ? (selectedLocale === "zh-CN" ? "待补充" : "Pending input")
    : localized(page.hero, "body", selectedLocale) || (selectedLocale === "zh-CN" ? "待补充" : "Pending input");
  const sections = (Array.isArray(page.sections) ? page.sections : [])
    .filter((section) => preview ? section.status !== "retired" : section.status === "published")
    .sort((left, right) => Number(left.order || 0) - Number(right.order || 0));
  const nav = publicNavigation(content);
  const previewBanner = preview
    ? `<aside class="preview-banner" role="status"><strong>${selectedLocale === "zh-CN" ? "草稿预览" : "Draft preview"}</strong><span>${selectedLocale === "zh-CN" ? "此页面尚未向访客发布" : "This page has not been published to visitors"}</span></aside>`
    : "";
  const descriptionMeta = metadata.description ? `<meta name="description" content="${escapeHtml(metadata.description)}">` : "";
  const canonical = metadata.canonical ? `<link rel="canonical" href="${escapeHtml(metadata.canonical)}">` : "";
  const jsonLd = metadata.jsonLd ? `<script nonce="${escapeHtml(nonce)}" type="application/ld+json">${jsonScript(metadata.jsonLd)}</script>` : "";
  const runtime = preview ? "" : renderRuntimeScripts(selectedLocale, siteBase, apiBaseUrl, page.slug, nonce);
  const navigation = nav.map((item) => `<a href="${escapeHtml(navigationHref(item, content, selectedLocale, { siteBaseUrl: siteBase, apiBaseUrl }))}"${item.href === page.slug ? ' aria-current="page"' : ""}>${escapeHtml(selectedLocale === "zh-CN" ? item.labelZh : item.labelEn)}</a>`).join("");
  const direction = selectedLocale === "ar" ? "rtl" : "ltr";
  return `<!doctype html>
<html lang="${selectedLocale}" dir="${direction}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="${metadata.robots}">
  <title>${escapeHtml(metadata.title)} | ${escapeHtml(content.siteName || "勤益")}</title>
  ${descriptionMeta}
  ${canonical}
  <link rel="stylesheet" href="${escapeHtml(`${siteBase}/assets/styles.css?v=20260728-platform-v1`)}">
  ${jsonLd}
</head>
<body>
  <a class="skip-link" href="#main">${selectedLocale === "zh-CN" ? "跳至内容" : "Skip to content"}</a>
  ${previewBanner}
  <header class="site-header"><nav class="nav-shell" aria-label="${selectedLocale === "zh-CN" ? "主要导航" : "Primary navigation"}"><a class="brand" href="${escapeHtml(`${siteBase}/${selectedLocale}/`)}"><span class="brand-mark">Q</span><span class="brand-copy"><strong>${escapeHtml(content.siteName || "勤益")}</strong><span>Coinshin creative paper goods</span></span></a><div class="nav-links">${navigation}</div><div class="nav-actions"><select class="lang-select" data-language aria-label="Language"><option value="${selectedLocale}">${selectedLocale === "zh-CN" ? "中文" : "English"}</option></select><a class="btn orange" href="${escapeHtml(`${siteBase}/${selectedLocale}/quote.html`)}">${selectedLocale === "zh-CN" ? "定制化与索取报价" : "Customize & request a quote"}</a><button class="menu-toggle" type="button" aria-label="${selectedLocale === "zh-CN" ? "打开菜单" : "Open menu"}" aria-expanded="false"><span></span></button></div></nav></header>
  <main id="main">
    <section class="page-hero"><div class="container"><div class="breadcrumbs"><a href="${escapeHtml(`${siteBase}/${selectedLocale}/`)}">${selectedLocale === "zh-CN" ? "首页" : "Home"}</a> / <span>${escapeHtml(localized(page, "title", selectedLocale))}</span></div><div class="page-hero-grid"><div><p class="eyebrow">${selectedLocale === "zh-CN" ? "勤益网站内容" : "Qinyi managed content"}</p><h1 data-content-hero-title>${escapeHtml(heroTitle)}</h1></div><p class="page-hero-aside" data-content-hero-body>${bodyWithBreaks(heroBody)}</p></div></div></section>
    <div id="qinyiManagedContent">${sections.length ? sections.map((section) => renderSection(section, selectedLocale, { apiBaseUrl, preview })).join("") : `<section class="section"><div class="narrow"><p class="lede">${selectedLocale === "zh-CN" ? "待补充" : "Pending input"}</p></div></section>`}</div>
  </main>
  <footer class="site-footer"><div class="container footer-grid"><div class="footer-brand"><a class="brand" href="${escapeHtml(`${siteBase}/${selectedLocale}/`)}"><span class="brand-mark">Q</span><span class="brand-copy"><strong>${escapeHtml(content.siteName || "勤益")}</strong><span>Coinshin creative paper goods</span></span></a><p>${selectedLocale === "zh-CN" ? "定制印刷、纸制品、拼图、礼品与包装服务。" : "Custom printing, paper products, puzzles, gifts and packaging services."}</p></div><div class="footer-col"><h3>${selectedLocale === "zh-CN" ? "浏览" : "Explore"}</h3>${navigation}</div></div><div class="container footer-bottom"><span>&copy; <span data-year>${new Date().getUTCFullYear()}</span> ${escapeHtml(content.siteName || "勤益")}</span><span>${selectedLocale === "zh-CN" ? "规格与交期以项目评审为准。" : "Specifications and lead time are confirmed during project review."}</span></div></footer>
  ${runtime}
</body>
</html>`;
}

function renderSitemap({ content, seoGeo, siteBaseUrl, apiBaseUrl }) {
  const locales = Array.isArray(content?.primaryLocales) ? content.primaryLocales.map(normalizedLocale) : ["zh-CN", "en"];
  const uniqueLocales = [...new Set(locales)];
  const urls = [];
  for (const page of publicPages(content).filter((item) => item.seo?.indexable !== false)) {
    for (const locale of uniqueLocales) urls.push(pageMetadata({ content, page, seoGeo, locale, siteBaseUrl, apiBaseUrl }).canonical || pageDeliveryUrl(page, locale, { siteBaseUrl, apiBaseUrl }));
  }
  const lastmod = content?.publishedAt ? String(content.publishedAt).slice(0, 10) : null;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `  <url><loc>${escapeHtml(url)}</loc>${lastmod ? `<lastmod>${escapeHtml(lastmod)}</lastmod>` : ""}</url>`).join("\n")}\n</urlset>\n`;
}

function renderRobots({ siteBaseUrl }) {
  const siteBase = normalizedBaseUrl(siteBaseUrl, "https://nininininini979-tech.github.io/qinyi-printing-website");
  return `User-agent: *\nAllow: /\n\nSitemap: ${siteBase}/sitemap.xml\n`;
}

function renderLlmsTxt({ content, seoGeo, siteBaseUrl, apiBaseUrl }) {
  const entity = seoGeo?.brandEntity || {};
  const nameEn = flatText(entity.nameEn || content?.siteName || "Qinyi Printing");
  const nameZh = flatText(entity.nameZh || content?.siteName || "勤益");
  const descriptionEn = flatText(entity.descriptionEn || "Pending input");
  const descriptionZh = flatText(entity.descriptionZh || "待补充");
  const pages = publicPages(content).filter((page) => page.seo?.indexable !== false);
  const lines = [
    `# ${nameEn} / ${nameZh}`,
    "",
    `> ${descriptionEn}`,
    `> ${descriptionZh}`,
    "",
    "## Verified published pages",
    ""
  ];
  for (const page of pages) {
    const enUrl = pageMetadata({ content, page, seoGeo, locale: "en", siteBaseUrl, apiBaseUrl }).canonical || pageDeliveryUrl(page, "en", { siteBaseUrl, apiBaseUrl });
    const zhUrl = pageMetadata({ content, page, seoGeo, locale: "zh-CN", siteBaseUrl, apiBaseUrl }).canonical || pageDeliveryUrl(page, "zh-CN", { siteBaseUrl, apiBaseUrl });
    lines.push(`- [${flatText(page.titleEn)}](${enUrl}) / [${flatText(page.titleZh)}](${zhUrl})`);
  }
  const questions = Array.isArray(seoGeo?.targetQuestions) ? seoGeo.targetQuestions : [];
  if (questions.length) {
    lines.push("", "## Target customer questions", "", ...questions.map((question) => `- ${flatText(question)}`));
  }
  lines.push("", `Published content version: ${content?.publishedVersionId || "pending"}`, "");
  return lines.join("\n");
}

function deliveryCsp({ siteBaseUrl, apiBaseUrl, nonce, preview = false }) {
  const origins = [...new Set([siteBaseUrl, apiBaseUrl].map((value) => {
    try { return new URL(value).origin; } catch (_error) { return null; }
  }).filter(Boolean))];
  const sourceList = origins.join(" ");
  return `default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors ${preview ? "'self'" : "'none'"}; script-src 'self' 'nonce-${nonce}' ${sourceList}; style-src 'self' ${sourceList}; img-src 'self' data: https:; connect-src 'self' ${sourceList}; frame-src ${sourceList}; form-action 'self'`;
}

export {
  DEFAULT_TECHNICAL,
  STATIC_PAGE_SLUGS,
  deliveryCsp,
  normalizedLocale,
  pageBySlug,
  pageDeliveryUrl,
  pageMetadata,
  renderLlmsTxt,
  renderPageDocument,
  renderRobots,
  renderSitemap,
  technicalSettings
};
