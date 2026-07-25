import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("Pages frontend uses relative assets and a configurable API base", async () => {
  const [html, app, runtimeConfig] = await Promise.all([
    fs.readFile("public/index.html", "utf8"),
    fs.readFile("public/app.js", "utf8"),
    fs.readFile("public/config.js", "utf8")
  ]);
  assert.match(html, /href="\.\/styles\.css"/);
  assert.match(html, /src="\.\/config\.js"/);
  assert.match(html, /src="\.\/app\.js"/);
  assert.match(app, /apiUrl\("\/api\/support\/chat"\)/);
  assert.match(app, /apiUrl\("\/api\/support\/status"\)/);
  assert.match(app, /X-Client-Id/);
  assert.match(runtimeConfig, /apiBaseUrl/);
  assert.doesNotMatch(runtimeConfig, /sk-[A-Za-z0-9_-]{12,}/);
});

test("deployment ignores raw extraction and packaged outputs", async () => {
  const gitignore = await fs.readFile(".gitignore", "utf8");
  assert.match(gitignore, /^work\/$/m);
  assert.match(gitignore, /^outputs\/$/m);
  assert.match(gitignore, /^\.env$/m);
});

test("Vercel routes support API calls and include private knowledge files", async () => {
  const config = JSON.parse(await fs.readFile("vercel.json", "utf8"));
  assert.equal(config.rewrites[0].source, "/api/support/:path*");
  assert.equal(config.rewrites[0].destination, "/api/server?route=:path*");
  assert.ok(config.functions["api/server.js"].includeFiles.includes("knowledge/curated/**"));
  assert.ok(config.functions["api/server.js"].includeFiles.includes("service-playbook/**"));
  assert.equal(config.functions["api/server.js"].maxDuration, 60);
});
