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
