import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileTypeFromFile } from "file-type";
import sharp from "sharp";
import gltfValidator from "gltf-validator";
import { bearerToken } from "./auth.js";

const MB = 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const VISITOR_MIME_TYPES = new Set(["application/pdf", ...IMAGE_MIME_TYPES]);
const MANAGER_ROLES = new Set(["administrator", "developer", "system_owner"]);
const HUMAN_ROLES = new Set(["support", ...MANAGER_ROLES]);
const SAFE_FIELD_NAMES = new Set(["purpose", "sessionId"]);

export const UPLOAD_PROFILES = Object.freeze({
  visitor: Object.freeze({ scope: "visitor", kind: "attachment", maxBytes: 25 * MB }),
  cmsImage: Object.freeze({ scope: "cms", kind: "image", maxBytes: 50 * MB }),
  cmsModel: Object.freeze({ scope: "cms", kind: "model", maxBytes: 100 * MB })
});

function fail(message, statusCode = 400, code = "UPLOAD_REJECTED") {
  throw Object.assign(new Error(message), { statusCode, code });
}

function uploadId() {
  return `UPLOAD-${crypto.randomUUID()}`;
}

function cleanFilename(value) {
  const basename = String(value || "file")
    .replaceAll("\\", "/")
    .split("/")
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return (basename || "file").slice(0, 180);
}

function storageSegment(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
}

function relativeStorageKey(root, filename) {
  return path.relative(root, filename).split(path.sep).join("/");
}

function publicUpload(upload) {
  return {
    id: upload.id,
    scope: upload.scope,
    kind: upload.kind,
    purpose: upload.purpose,
    filename: upload.filename,
    mimeType: upload.mimeType,
    size: upload.size,
    width: upload.width,
    height: upload.height,
    validation: upload.validation,
    status: upload.status,
    createdAt: upload.createdAt,
    fileUrl: upload.scope === "cms" ? `/api/ops/content/assets/${upload.id}/file` : undefined,
    thumbnailUrl: upload.thumbnailStorageKey ? `/api/ops/content/assets/${upload.id}/thumbnail` : undefined
  };
}

function actualImageExtension(mimeType) {
  return mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1];
}

async function hashFile(filename) {
  const hash = crypto.createHash("sha256");
  await pipeline(createReadStream(filename), hash);
  return hash.digest("hex");
}

async function validateGltf(filename, originalFilename, detected) {
  const extension = path.extname(originalFilename).toLowerCase();
  let format;
  let parsed;
  if (detected?.mime === "model/gltf-binary" || detected?.ext === "glb") {
    format = "glb";
  } else if (extension === ".gltf" && !detected) {
    format = "gltf";
    try {
      parsed = JSON.parse(await fsp.readFile(filename, "utf8"));
    } catch {
      fail("glTF 文件不是有效的 JSON。", 400, "INVALID_GLTF_JSON");
    }
    if (!parsed?.asset || String(parsed.asset.version || "") !== "2.0") {
      fail("仅支持 glTF 2.0 模型。", 400, "INVALID_GLTF_VERSION");
    }
    const externalUris = [];
    for (const item of [...(parsed.buffers || []), ...(parsed.images || [])]) {
      if (item?.uri && !String(item.uri).startsWith("data:")) externalUris.push(String(item.uri));
    }
    if (externalUris.length) {
      fail("glTF 必须为单文件资源；请嵌入纹理和缓冲区，或改用 GLB。", 400, "EXTERNAL_GLTF_RESOURCE");
    }
  } else {
    fail("模型仅支持 GLB 或 glTF 文件。", 400, "MODEL_TYPE_MISMATCH");
  }

  let report;
  try {
    const bytes = new Uint8Array(await fsp.readFile(filename));
    report = await gltfValidator.validateBytes(bytes, {
      uri: `asset.${format}`,
      format,
      maxIssues: 100,
      writeTimestamp: false
    });
  } catch {
    fail("模型无法通过 glTF 结构验证。", 400, "MODEL_VALIDATION_FAILED");
  }
  if (Number(report?.issues?.numErrors || 0) > 0) {
    fail("模型包含阻止使用的 glTF 结构错误。", 400, "MODEL_VALIDATION_ERRORS");
  }
  return {
    mimeType: format === "glb" ? "model/gltf-binary" : "model/gltf+json",
    extension: format,
    validation: {
      validator: "Khronos glTF Validator",
      version: gltfValidator.version(),
      errors: Number(report?.issues?.numErrors || 0),
      warnings: Number(report?.issues?.numWarnings || 0),
      infos: Number(report?.issues?.numInfos || 0),
      hints: Number(report?.issues?.numHints || 0)
    }
  };
}

export class SecureUploadService {
  constructor({ directory, store, objectStore = null }) {
    this.directory = path.resolve(directory);
    this.store = store;
    this.objectStore = objectStore;
    this.quarantineDirectory = path.join(this.directory, ".quarantine");
  }

  async init() {
    await fsp.mkdir(this.quarantineDirectory, { recursive: true, mode: 0o700 });
    await fsp.chmod(this.directory, 0o700);
    await fsp.chmod(this.quarantineDirectory, 0o700);
    return this;
  }

  async processPart(part, profile, { tenantId = "cms", visitorId = "manager" } = {}) {
    const id = uploadId();
    const originalFilename = cleanFilename(part.filename);
    const temporary = path.join(this.quarantineDirectory, `${id}.part`);
    const created = [];
    try {
      await pipeline(part.file, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
      if (part.file.truncated) fail(`文件不能超过 ${profile.maxBytes / MB}MB。`, 413, "FILE_TOO_LARGE");
      const input = await fsp.stat(temporary);
      if (!input.size) fail("不能上传空文件。", 400, "EMPTY_FILE");
      if (input.size > profile.maxBytes) fail(`文件不能超过 ${profile.maxBytes / MB}MB。`, 413, "FILE_TOO_LARGE");

      const detected = await fileTypeFromFile(temporary);
      let mimeType;
      let extension;
      let dimensions = {};
      let validation;
      if (profile.kind === "model") {
        const model = await validateGltf(temporary, originalFilename, detected);
        ({ mimeType, extension, validation } = model);
      } else {
        mimeType = detected?.mime;
        if (profile.kind === "image" && !IMAGE_MIME_TYPES.has(mimeType)) {
          fail("图片仅支持 JPG、PNG 或 WebP。", 400, "IMAGE_TYPE_MISMATCH");
        }
        if (profile.kind === "attachment" && !VISITOR_MIME_TYPES.has(mimeType)) {
          fail("附件仅支持 PDF、JPG、PNG 或 WebP。", 400, "ATTACHMENT_TYPE_MISMATCH");
        }
        extension = mimeType === "application/pdf" ? "pdf" : actualImageExtension(mimeType);
      }

      const ownerDirectory = profile.scope === "visitor"
        ? path.join(this.directory, "visitor", storageSegment(tenantId), storageSegment(visitorId))
        : path.join(this.directory, "cms", profile.kind === "image" ? "images" : "models");
      await fsp.mkdir(ownerDirectory, { recursive: true, mode: 0o700 });
      await fsp.chmod(ownerDirectory, 0o700);
      const finalPath = path.join(ownerDirectory, `${id}.${extension}`);
      let thumbnailPath;

      if (IMAGE_MIME_TYPES.has(mimeType)) {
        const image = sharp(temporary, { failOn: "error", limitInputPixels: 64_000_000 }).rotate();
        const metadata = await image.metadata();
        dimensions = { width: metadata.width, height: metadata.height };
        const sanitized = sharp(temporary, { failOn: "error", limitInputPixels: 64_000_000 }).rotate();
        if (mimeType === "image/jpeg") await sanitized.jpeg({ quality: 92, mozjpeg: true }).toFile(finalPath);
        if (mimeType === "image/png") await sanitized.png({ compressionLevel: 9 }).toFile(finalPath);
        if (mimeType === "image/webp") await sanitized.webp({ quality: 92 }).toFile(finalPath);
        await fsp.chmod(finalPath, 0o600);
        created.push(finalPath);
        thumbnailPath = path.join(ownerDirectory, `${id}.thumb.webp`);
        await sharp(finalPath, { failOn: "error", limitInputPixels: 64_000_000 })
          .resize({ width: 720, height: 720, fit: "inside", withoutEnlargement: true })
          .webp({ quality: 82 })
          .toFile(thumbnailPath);
        await fsp.chmod(thumbnailPath, 0o600);
        created.push(thumbnailPath);
        validation = { metadataStripped: true, thumbnailGenerated: true };
      } else {
        await fsp.rename(temporary, finalPath);
        await fsp.chmod(finalPath, 0o600);
        created.push(finalPath);
      }

      const output = await fsp.stat(finalPath);
      return {
        id,
        scope: profile.scope,
        kind: profile.kind,
        filename: originalFilename,
        declaredMimeType: String(part.mimetype || "").slice(0, 120),
        mimeType,
        size: output.size,
        sha256: await hashFile(finalPath),
        storageKey: relativeStorageKey(this.directory, finalPath),
        thumbnailStorageKey: thumbnailPath ? relativeStorageKey(this.directory, thumbnailPath) : undefined,
        ...dimensions,
        validation,
        status: "available",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    } catch (error) {
      await Promise.allSettled([fsp.rm(temporary, { force: true }), ...created.map((filename) => fsp.rm(filename, { force: true }))]);
      if (error?.code === "FST_REQ_FILE_TOO_LARGE") fail(`文件不能超过 ${profile.maxBytes / MB}MB。`, 413, "FILE_TOO_LARGE");
      throw error;
    } finally {
      await fsp.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async discard(processed) {
    if (!processed) return;
    await Promise.allSettled([
      this.#removeStorageKey(processed.storageKey),
      this.#removeStorageKey(processed.thumbnailStorageKey)
    ]);
  }

  async registerVisitorUpload(processed, { tenantId, visitorId, sessionId, purpose }) {
    const actor = `visitor:${storageSegment(`${tenantId}:${visitorId}`)}`;
    await this.#persistProcessed(processed);
    try {
      const upload = await this.store.transact((state) => {
        state.uploads ||= {};
        state.attachments ||= {};
        const record = {
          ...processed,
          purpose,
          owner: { tenantId, visitorId, ...(sessionId ? { sessionId } : {}) },
          actor
        };
        if (purpose === "support") {
          const conversation = Object.values(state.conversations || {}).find((item) =>
            item.tenantId === tenantId && item.visitorId === visitorId &&
            Array.isArray(item.externalSessionIds) && item.externalSessionIds.includes(sessionId)
          );
          if (!conversation) fail("客服会话不存在或不属于当前访客。", 404, "CONVERSATION_NOT_FOUND");
          record.conversationId = conversation.id;
          state.attachments[record.id] = record;
          conversation.attachmentIds ||= [];
          conversation.attachmentIds.push(record.id);
          conversation.updatedAt = record.createdAt;
        }
        state.uploads[record.id] = record;
        return record;
      }, { kind: "audit", action: `upload.visitor_${purpose}_accepted`, actor, entityId: processed.id, mimeType: processed.mimeType, size: processed.size });
      await this.#removeLocalProcessed(processed);
      return publicUpload(upload);
    } catch (error) {
      if (this.objectStore) await Promise.allSettled([
        this.objectStore.delete(processed.storageKey),
        this.objectStore.delete(processed.thumbnailStorageKey)
      ]);
      throw error;
    }
  }

  async registerContentAsset(processed, actor) {
    await this.#persistProcessed(processed);
    try {
      const upload = await this.store.transact((state) => {
        state.uploads ||= {};
        state.contentAssets ||= {};
        const record = { ...processed, purpose: "content", actor };
        state.uploads[record.id] = record;
        state.contentAssets[record.id] = record;
        return record;
      }, { kind: "audit", action: `upload.cms_${processed.kind}_accepted`, actor, entityId: processed.id, mimeType: processed.mimeType, size: processed.size });
      await this.#removeLocalProcessed(processed);
      return publicUpload(upload);
    } catch (error) {
      if (this.objectStore) await Promise.allSettled([
        this.objectStore.delete(processed.storageKey),
        this.objectStore.delete(processed.thumbnailStorageKey)
      ]);
      throw error;
    }
  }

  async listContentAssets({ kind } = {}) {
    return this.store.read((state) => ({
      items: Object.values(state.contentAssets || {})
        .filter((item) => !kind || item.kind === kind)
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
        .map(publicUpload)
    }));
  }

  async contentAsset(id) {
    return this.store.read((state) => state.contentAssets?.[id] || null);
  }

  async visitorAttachment(id) {
    return this.store.read((state) => {
      const attachment = state.attachments?.[id];
      return attachment?.scope === "visitor" ? attachment : null;
    });
  }

  async assetFile(id, thumbnail = false) {
    const asset = await this.contentAsset(id);
    if (!asset || asset.status !== "available") return null;
    const storageKey = thumbnail ? asset.thumbnailStorageKey : asset.storageKey;
    if (!storageKey) return null;
    return this.#storedFile(asset, storageKey, thumbnail ? "image/webp" : asset.mimeType);
  }

  async attachmentFile(id) {
    const attachment = await this.visitorAttachment(id);
    if (!attachment || attachment.status !== "available") return null;
    return this.#storedFile(attachment, attachment.storageKey, attachment.mimeType, "attachment");
  }

  async retireContentAsset(id, actor) {
    const asset = await this.store.transact((state) => {
      const record = state.contentAssets?.[id];
      if (!record) return null;
      record.status = "retired";
      record.updatedAt = new Date().toISOString();
      if (state.uploads?.[id]) state.uploads[id] = record;
      return record;
    }, { kind: "audit", action: "upload.cms_asset_retired", actor, entityId: id });
    if (!asset) return null;
    await this.discard(asset);
    return publicUpload(asset);
  }

  async auditRejection({ scope, kind, actor, error }) {
    await this.store.appendEvent({
      kind: "audit",
      action: `upload.${scope}_${kind}_rejected`,
      actor,
      reasonCode: String(error?.code || "UPLOAD_REJECTED").slice(0, 80)
    }).catch(() => {});
  }

  #storagePath(storageKey) {
    const candidate = path.resolve(this.directory, String(storageKey));
    if (candidate === this.directory || !candidate.startsWith(`${this.directory}${path.sep}`)) {
      fail("存储路径无效。", 500, "INVALID_STORAGE_PATH");
    }
    return candidate;
  }

  async #removeStorageKey(storageKey) {
    if (!storageKey) return;
    if (this.objectStore) await this.objectStore.delete(storageKey);
    await fsp.rm(this.#storagePath(storageKey), { force: true });
  }

  async #persistProcessed(processed) {
    if (!this.objectStore) return;
    try {
      await this.objectStore.putFile(processed.storageKey, this.#storagePath(processed.storageKey), {
        contentType: processed.mimeType,
        sha256: processed.sha256
      });
      if (processed.thumbnailStorageKey) {
        await this.objectStore.putFile(processed.thumbnailStorageKey, this.#storagePath(processed.thumbnailStorageKey), {
          contentType: "image/webp"
        });
      }
    } catch (error) {
      await Promise.allSettled([
        this.objectStore.delete(processed.storageKey),
        this.objectStore.delete(processed.thumbnailStorageKey)
      ]);
      throw Object.assign(new Error("对象存储暂时不可用，请稍后重试。"), { statusCode: 503, code: "OBJECT_STORE_UNAVAILABLE", cause: error });
    }
  }

  async #removeLocalProcessed(processed) {
    if (!this.objectStore) return;
    await Promise.allSettled([
      fsp.rm(this.#storagePath(processed.storageKey), { force: true }),
      processed.thumbnailStorageKey ? fsp.rm(this.#storagePath(processed.thumbnailStorageKey), { force: true }) : Promise.resolve()
    ]);
  }

  async #storedFile(record, storageKey, mimeType, recordKey = "asset") {
    if (this.objectStore) {
      try {
        const stream = await this.objectStore.get(storageKey);
        return stream ? { [recordKey]: record, stream, mimeType } : null;
      } catch (error) {
        if (error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    }
    return { [recordKey]: record, filename: this.#storagePath(storageKey), mimeType };
  }
}

async function readUpload(request, uploader, profile, owner) {
  if (!request.isMultipart()) fail("请使用 multipart/form-data 上传文件。", 415, "MULTIPART_REQUIRED");
  const fields = {};
  let processed;
  const parts = request.parts({
    limits: { fileSize: profile.maxBytes, files: 1, fields: 8, parts: 9, fieldSize: 20_000 }
  });
  try {
    for await (const part of parts) {
      if (part.type === "file") {
        if (processed) fail("每次只能上传一个文件。", 400, "TOO_MANY_FILES");
        processed = await uploader.processPart(part, profile, owner);
      } else {
        if (!SAFE_FIELD_NAMES.has(part.fieldname)) fail("上传字段无效。", 400, "INVALID_UPLOAD_FIELD");
        if (Object.hasOwn(fields, part.fieldname)) fail("上传字段不能重复。", 400, "DUPLICATE_UPLOAD_FIELD");
        fields[part.fieldname] = String(part.value || "");
      }
    }
    if (!processed) fail("没有收到上传文件。", 400, "FILE_REQUIRED");
    return { processed, fields };
  } catch (error) {
    await uploader.discard(processed);
    if (error?.code === "FST_FILES_LIMIT") fail("每次只能上传一个文件。", 400, "TOO_MANY_FILES");
    if (error?.code === "FST_REQ_FILE_TOO_LARGE") fail(`文件不能超过 ${profile.maxBytes / MB}MB。`, 413, "FILE_TOO_LARGE");
    throw error;
  }
}

function referencedPublishedAssetIds(content) {
  const result = new Set();
  const walk = (value, key = "") => {
    if (Array.isArray(value)) return value.forEach((item) => walk(item, key));
    if (!value || typeof value !== "object") {
      if ((key === "assetId" || key.endsWith("AssetId")) && typeof value === "string") result.add(value);
      return;
    }
    for (const [childKey, child] of Object.entries(value)) walk(child, childKey);
  };
  for (const item of content?.media || []) if (item?.id && item.status === "published") result.add(item.id);
  walk(content?.pages || []);
  walk(content?.customizer || {});
  return result;
}

export async function registerSecureUploadRoutes(app, { uploader, auth, identityFor, sessionStore, contentService }) {
  async function requireRole(request, roles) {
    const session = await auth.authenticate(bearerToken(request));
    if (!session) fail("后台会话无效或已过期。", 401, "UNAUTHENTICATED");
    if (!roles.has(session.role)) fail("当前账号没有执行此操作的权限。", 403, "FORBIDDEN");
    request.uploadSession = session;
  }
  const requireManager = (request) => requireRole(request, MANAGER_ROLES);
  const requireHuman = (request) => requireRole(request, HUMAN_ROLES);

  app.post("/api/support/uploads", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const identity = identityFor(request);
    const actor = `visitor:${storageSegment(`${identity.tenantId}:${identity.userId}`)}`;
    let processed;
    try {
      const upload = await readUpload(request, uploader, UPLOAD_PROFILES.visitor, {
        tenantId: identity.tenantId,
        visitorId: identity.userId
      });
      processed = upload.processed;
      const purpose = upload.fields.purpose === "chat" ? "support" : upload.fields.purpose;
      if (!new Set(["quote", "support"]).has(purpose)) fail("上传用途必须为 quote 或 support。", 400, "INVALID_UPLOAD_PURPOSE");
      const sessionId = upload.fields.sessionId?.trim();
      if (purpose === "support" && !sessionId) fail("客服附件必须关联会话。", 400, "SESSION_REQUIRED");
      if (sessionId) {
        if (sessionId.length > 16_000) fail("会话标识无效。", 400, "INVALID_SESSION");
        const session = await sessionStore.get(identity.tenantId, identity.userId, sessionId);
        if (!session) fail("会话不存在、已过期或不属于当前访客。", 404, "SESSION_NOT_FOUND");
      }
      const result = await uploader.registerVisitorUpload(processed, {
        tenantId: identity.tenantId,
        visitorId: identity.userId,
        sessionId,
        purpose
      });
      return reply.code(201).send(result);
    } catch (error) {
      await uploader.discard(processed);
      await uploader.auditRejection({ scope: "visitor", kind: "attachment", actor, error });
      throw error;
    }
  });

  async function uploadCmsAsset(request, reply, profile) {
    const actor = request.uploadSession.username || request.uploadSession.displayName || "manager";
    let processed;
    try {
      ({ processed } = await readUpload(request, uploader, profile, {}));
      const result = await uploader.registerContentAsset(processed, actor);
      return reply.code(201).send(result);
    } catch (error) {
      await uploader.discard(processed);
      await uploader.auditRejection({ scope: "cms", kind: profile.kind, actor, error });
      throw error;
    }
  }

  app.post("/api/ops/content/assets/images", { preHandler: requireManager }, (request, reply) =>
    uploadCmsAsset(request, reply, UPLOAD_PROFILES.cmsImage)
  );
  app.post("/api/ops/content/assets/models", { preHandler: requireManager }, (request, reply) =>
    uploadCmsAsset(request, reply, UPLOAD_PROFILES.cmsModel)
  );
  app.get("/api/ops/content/assets", { preHandler: requireManager }, (request) => {
    const kind = request.query?.kind;
    if (kind && !new Set(["image", "model"]).has(kind)) fail("素材类型无效。", 400, "INVALID_ASSET_KIND");
    return uploader.listContentAssets({ kind });
  });
  app.get("/api/ops/content/assets/:assetId/file", { preHandler: requireManager }, async (request, reply) => {
    const result = await uploader.assetFile(String(request.params.assetId));
    if (!result) return reply.code(404).send({ error: "素材不存在或已下架。", requestId: request.id });
    return reply.type(result.mimeType).header("Cache-Control", "private, no-store").header("X-Content-Type-Options", "nosniff").send(result.stream || createReadStream(result.filename));
  });
  app.get("/api/ops/content/assets/:assetId/thumbnail", { preHandler: requireManager }, async (request, reply) => {
    const result = await uploader.assetFile(String(request.params.assetId), true);
    if (!result) return reply.code(404).send({ error: "素材缩略图不存在。", requestId: request.id });
    return reply.type("image/webp").header("Cache-Control", "private, no-store").header("X-Content-Type-Options", "nosniff").send(result.stream || createReadStream(result.filename));
  });
  app.get("/api/public/site-assets/:assetId", async (request, reply) => {
    const published = await contentService?.publicContent();
    const assetId = String(request.params.assetId);
    if (!published || !referencedPublishedAssetIds(published).has(assetId)) {
      return reply.code(404).send({ error: "素材不存在或尚未发布。", requestId: request.id });
    }
    const result = await uploader.assetFile(assetId);
    if (!result) return reply.code(404).send({ error: "素材不存在或已下架。", requestId: request.id });
    return reply.type(result.mimeType).header("Cache-Control", "public, max-age=300").header("X-Content-Type-Options", "nosniff").send(result.stream || createReadStream(result.filename));
  });
  app.get("/api/public/site-assets/:assetId/thumbnail", async (request, reply) => {
    const published = await contentService?.publicContent();
    const assetId = String(request.params.assetId);
    if (!published || !referencedPublishedAssetIds(published).has(assetId)) {
      return reply.code(404).send({ error: "素材不存在或尚未发布。", requestId: request.id });
    }
    const result = await uploader.assetFile(assetId, true);
    if (!result) return reply.code(404).send({ error: "素材缩略图不存在。", requestId: request.id });
    return reply.type("image/webp").header("Cache-Control", "public, max-age=300").header("X-Content-Type-Options", "nosniff").send(result.stream || createReadStream(result.filename));
  });
  app.delete("/api/ops/content/assets/:assetId", { preHandler: requireManager }, async (request, reply) => {
    const actor = request.uploadSession.username || request.uploadSession.displayName || "manager";
    const result = await uploader.retireContentAsset(String(request.params.assetId), actor);
    return result || reply.code(404).send({ error: "素材不存在。", requestId: request.id });
  });
  app.get("/api/admin/attachments/:attachmentId/file", { preHandler: requireHuman }, async (request, reply) => {
    const result = await uploader.attachmentFile(String(request.params.attachmentId));
    if (!result) return reply.code(404).send({ error: "附件不存在。", requestId: request.id });
    const filename = encodeURIComponent(result.attachment.filename || "attachment")
      .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    return reply.type(result.mimeType)
      .header("Cache-Control", "private, no-store")
      .header("Content-Disposition", `attachment; filename*=UTF-8''${filename}`)
      .header("X-Content-Type-Options", "nosniff")
      .send(result.stream || createReadStream(result.filename));
  });
}
