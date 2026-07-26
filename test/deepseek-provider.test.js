import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DeepSeekSupportProvider } from "../src/providers/deepseek-provider.js";

test("DeepSeek compiles a message-specific playbook prompt on every turn", async () => {
  const provider = new DeepSeekSupportProvider({
    DEEPSEEK_API_KEY: "test-key",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    DEEPSEEK_MODEL: "test-model",
    REQUEST_TIMEOUT_MS: 1000,
    USER_HASH_SECRET: "0123456789abcdef0123456789abcdef"
  }, {
    knowledgeDir: path.resolve("knowledge/prepared"),
    playbookDir: path.resolve("service-playbook")
  });
  const systemPrompts = [];
  provider.client = {
    chat: {
      completions: {
        create: async ({ messages }) => {
          systemPrompts.push(messages[0].content);
          return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "已根据资料给出初步建议。" } }] };
        }
      }
    }
  };
  const shared = {
    identity: { tenantId: "tenant", userId: "user" },
    session: { history: [] }
  };

  await provider.answer({ ...shared, message: "给15岁左右用户推荐礼品拼图" });
  await provider.answer({ ...shared, message: "我想做特殊轮廓的异形拼图，需要开模吗" });

  assert.match(systemPrompts[0], /teen-audience-selection/);
  assert.doesNotMatch(systemPrompts[0], /custom-shape-batch/);
  assert.match(systemPrompts[1], /custom-shape-batch/);
  assert.doesNotMatch(systemPrompts[1], /teen-audience-selection/);
});

test("DeepSeek accepts a provider-neutral thought-layer prompt and exposes an isolated reviewer", async () => {
  const provider = new DeepSeekSupportProvider({
    DEEPSEEK_API_KEY: "test-key",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    DEEPSEEK_MODEL: "test-model",
    REQUEST_TIMEOUT_MS: 1000,
    USER_HASH_SECRET: "0123456789abcdef0123456789abcdef",
    AUTH_MODE: "public"
  }, {
    knowledgeDir: path.resolve("knowledge/prepared"),
    playbookDir: path.resolve("service-playbook")
  });
  const requests = [];
  provider.client = {
    chat: { completions: { create: async (request) => {
      requests.push(request);
      if (request.response_format) return { choices: [{ message: { content: '{"decision":"pass","score":98,"issues":[]}' } }] };
      return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "共享思想层生成的客户答复。" } }] };
    } } }
  };

  await provider.answer({
    message: "介绍产品",
    identity: { tenantId: "tenant", userId: "user" },
    session: { history: [] },
    thoughtContext: { generationPrompt: "SHARED-THOUGHT-PROMPT", externalReview: true }
  });
  const review = await provider.review({ reviewPrompt: "ISOLATED-C-REVIEW" });
  assert.equal(requests[0].messages[0].content, "SHARED-THOUGHT-PROMPT");
  assert.equal(requests[1].messages[0].content, "ISOLATED-C-REVIEW");
  assert.doesNotMatch(requests[1].messages[0].content, /SHARED-THOUGHT-PROMPT/);
  assert.match(review, /"decision":"pass"/);
});

test("DeepSeek does not trust a failed order lookup", async () => {
  const provider = new DeepSeekSupportProvider({
    DEEPSEEK_API_KEY: "test-key",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    DEEPSEEK_MODEL: "test-model",
    REQUEST_TIMEOUT_MS: 1000,
    USER_HASH_SECRET: "0123456789abcdef0123456789abcdef",
    AUTH_MODE: "demo"
  }, {
    knowledgeDir: path.resolve("knowledge/prepared"),
    playbookDir: path.resolve("service-playbook")
  });
  let call = 0;
  provider.client = {
    chat: { completions: { create: async () => {
      call += 1;
      if (call === 1) {
        return { choices: [{ message: { role: "assistant", tool_calls: [{ id: "tool-1", function: { name: "get_order_status", arguments: '{"order_id":"ORD-DEMO-1001"}' } }] } }] };
      }
      return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "订单已经发货。" } }] };
    } } }
  };

  const result = await provider.answer({
    message: "查询订单 ORD-DEMO-1001",
    identity: { tenantId: "wrong-tenant", userId: "wrong-user" },
    session: { history: [] },
    thoughtContext: { generationPrompt: "SHARED", externalReview: true }
  });
  assert.equal(result.grounded, false);
  assert.deepEqual(result.citations, []);
  assert.match(result.answer, /工具未能完成调用/);
});
