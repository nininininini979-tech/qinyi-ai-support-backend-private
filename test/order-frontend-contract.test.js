import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("administrator and developer order surfaces match the order API", async () => {
  const [admin, developer] = await Promise.all([
    fs.readFile("public/admin.js", "utf8"),
    fs.readFile("public/developer.js", "utf8")
  ]);
  assert.match(admin, /\/api\/admin\/orders/);
  assert.match(admin, /\/api\/admin\/quotes\?status=new/);
  assert.match(admin, /data-order-use-quote/);
  assert.match(admin, /newOrderForm/);
  assert.match(admin, /data-order-advance/);
  assert.match(admin, /data-production-advance/);
  assert.match(developer, /\/api\/developer\/order-system/);
  assert.match(developer, /\/api\/developer\/order-system\/settings/);
});
