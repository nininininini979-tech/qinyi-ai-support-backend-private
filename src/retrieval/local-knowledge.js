import fs from "node:fs/promises";
import path from "node:path";
import { toPlainText } from "../support/plain-text.js";

const stopWords = new Set(["什么", "可以", "怎么", "如何", "是否", "你们", "我们", "一个", "这个", "那个", "多少", "请问", "一下"]);

function normalizeUnits(text) {
  return String(text).toLowerCase().replace(/(\d+(?:\.\d+)?)\s*(片|套|件|副|张|厘米|cm|mm)/gi, "$1$2");
}

function terms(text) {
  const normalized = normalizeUnits(text);
  const latin = (normalized.match(/[a-z0-9]{2,}/g) || []).filter((term) => /[a-z]/.test(term));
  const quantities = normalized.match(/\d+(?:\.\d+)?(?:片|套|件|副|张|厘米|cm|mm)/g) || [];
  const chinese = [];
  const clean = normalized.replace(/[^\u4e00-\u9fff]/g, "");
  for (let size = 2; size <= 4; size += 1) {
    for (let index = 0; index <= clean.length - size; index += 1) {
      const term = clean.slice(index, index + size);
      if (!stopWords.has(term)) chinese.push(term);
    }
  }
  return new Set([...latin, ...quantities, ...chinese]);
}

function frontmatterValue(content, field) {
  return content.match(new RegExp(`^${field}:\\s*(.+)$`, "m"))?.[1]?.trim() || null;
}

function splitSections(content, filename) {
  const source = frontmatterValue(content, "source");
  const sourcePages = frontmatterValue(content, "source_pages");
  const category = frontmatterValue(content, "category");
  const approvalStatus = frontmatterValue(content, "approval_status");
  const bodyContent = content.replace(/^---\n[\s\S]*?\n---\n/, "");
  const sections = [];
  let title = filename;
  let body = [];
  for (const line of bodyContent.split(/\r?\n/)) {
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      if (body.join("\n").trim()) sections.push({ filename, title, text: body.join("\n").trim(), source, sourcePages, category, approvalStatus });
      title = heading[1].replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "").trim();
      body = [];
    } else {
      body.push(line);
    }
  }
  if (body.join("\n").trim()) sections.push({ filename, title, text: body.join("\n").trim(), source, sourcePages, category, approvalStatus });
  return sections;
}

export async function loadKnowledge(dir) {
  try {
    const names = (await fs.readdir(dir)).filter((name) => name.endsWith(".md"));
    const chunks = await Promise.all(names.map(async (name) => splitSections(await fs.readFile(path.join(dir, name), "utf8"), name)));
    return chunks.flat();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export function retrieveKnowledge(chunks, query, limit = 3) {
  const queryTerms = terms(query);
  const normalizedQuery = normalizeUnits(query);
  return chunks
    .map((chunk) => {
      const haystack = normalizeUnits(`${chunk.title}\n${chunk.text}`);
      let score = 0;
      for (const term of queryTerms) {
        if (haystack.includes(term)) score += /^\d+(?:\.\d+)?(?:片|套|件|副|张|厘米|cm|mm)$/.test(term) ? term.length + 8 : term.length;
      }
      if (haystack.includes(normalizedQuery)) score += 30;
      return { ...chunk, score };
    })
    .filter((chunk) => chunk.score >= 4)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function cleanExcerpt(text, maxChars = 1400) {
  const cleaned = toPlainText(text
    .replace(/^>.*$/gm, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => alias || target)
  );
  if (cleaned.length <= maxChars) return cleaned;
  const clipped = cleaned.slice(0, maxChars);
  const boundary = Math.max(clipped.lastIndexOf("\n"), clipped.lastIndexOf("。"), clipped.lastIndexOf("；"));
  return (boundary >= Math.floor(maxChars * 0.7) ? clipped.slice(0, boundary + 1) : clipped).trim();
}
