import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { S3ObjectStore, safeStorageKey } from "../src/operations/object-store.js";

test("S3 object storage keeps private generated keys and requests encryption", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qinyi-object-store-"));
  const filename = path.join(directory, "asset.bin");
  await fs.writeFile(filename, "private-data");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const calls = [];
  const client = {
    async send(command) {
      calls.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === "GetObjectCommand") return { Body: Readable.from(["private-data"]) };
      return {};
    }
  };
  const store = new S3ObjectStore({ client, bucket: "private-bucket", prefix: "tenant/qinyi" });
  await store.init();
  await store.putFile("cms/images/item.webp", filename, { contentType: "image/webp", sha256: "abc" });
  assert.ok(await store.get("cms/images/item.webp"));
  await store.delete("cms/images/item.webp");

  assert.deepEqual(calls.map((item) => item.name), ["HeadBucketCommand", "PutObjectCommand", "GetObjectCommand", "DeleteObjectCommand"]);
  assert.equal(calls[1].input.Bucket, "private-bucket");
  assert.equal(calls[1].input.Key, "tenant/qinyi/cms/images/item.webp");
  assert.equal(calls[1].input.ServerSideEncryption, "AES256");
  assert.equal(calls[1].input.Metadata.sha256, "abc");
});

test("object keys reject traversal and empty path segments", () => {
  assert.equal(safeStorageKey("visitor/a/file.pdf"), "visitor/a/file.pdf");
  for (const value of ["", "../secret", "a/../secret", "a//secret", "a/./secret"]) {
    assert.throws(() => safeStorageKey(value), /对象存储键无效/);
  }
});
