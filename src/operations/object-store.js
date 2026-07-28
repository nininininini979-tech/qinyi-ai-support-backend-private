import { createReadStream } from "node:fs";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";

function normalizedPrefix(value) {
  return String(value || "").trim().replace(/^\/+|\/+$/g, "");
}

function safeStorageKey(value) {
  const key = String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!key || key.includes("\0") || key.split("/").some((part) => !part || part === "." || part === "..")) {
    throw Object.assign(new Error("对象存储键无效。"), { statusCode: 500, code: "INVALID_OBJECT_KEY" });
  }
  return key;
}

function credentials(config) {
  if (!config.S3_ACCESS_KEY_ID && !config.S3_SECRET_ACCESS_KEY) return undefined;
  return {
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY
  };
}

export class S3ObjectStore {
  constructor({
    client,
    bucket,
    prefix = "qinyi",
    serverSideEncryption = "AES256",
    kmsKeyId
  } = {}) {
    if (!client) throw new Error("S3ObjectStore requires a client");
    if (!bucket) throw new Error("S3ObjectStore requires a bucket");
    this.client = client;
    this.bucket = bucket;
    this.prefix = normalizedPrefix(prefix);
    this.serverSideEncryption = serverSideEncryption === "none" ? undefined : serverSideEncryption;
    this.kmsKeyId = kmsKeyId || undefined;
  }

  key(storageKey) {
    const safe = safeStorageKey(storageKey);
    return this.prefix ? `${this.prefix}/${safe}` : safe;
  }

  async init({ verify = true } = {}) {
    if (verify) await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    return this;
  }

  async health() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    return true;
  }

  async putFile(storageKey, filename, { contentType, sha256 } = {}) {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.key(storageKey),
      Body: createReadStream(filename),
      ContentType: contentType,
      Metadata: sha256 ? { sha256 } : undefined,
      ServerSideEncryption: this.serverSideEncryption,
      SSEKMSKeyId: this.serverSideEncryption === "aws:kms" ? this.kmsKeyId : undefined
    }));
  }

  async get(storageKey) {
    const result = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.key(storageKey)
    }));
    if (!result.Body) return null;
    return result.Body;
  }

  async delete(storageKey) {
    if (!storageKey) return;
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: this.key(storageKey)
    }));
  }
}

export function createObjectStore(config) {
  if (config.UPLOAD_STORE !== "s3") return null;
  const client = new S3Client({
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT || undefined,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials: credentials(config)
  });
  return new S3ObjectStore({
    client,
    bucket: config.S3_BUCKET,
    prefix: config.S3_KEY_PREFIX,
    serverSideEncryption: config.S3_SERVER_SIDE_ENCRYPTION,
    kmsKeyId: config.S3_KMS_KEY_ID
  });
}

export { safeStorageKey };
