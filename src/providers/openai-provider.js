import OpenAI from "openai";
import { getOrderStatus } from "../adapters/orders.js";
import { SUPPORT_INSTRUCTIONS } from "../support/policy.js";
import { safetyIdentifier } from "../security.js";
import { toPlainText } from "../support/plain-text.js";
import { loadAutonomyPrompt } from "../support/playbook.js";
import { buildRetrievalQuery } from "../support/product-advisor.js";

const orderTool = {
  type: "function",
  name: "get_order_status",
  description: "查询当前已登录用户自己的订单生产、发货和物流状态。只读。",
  strict: true,
  parameters: {
    type: "object",
    properties: {
      order_id: { type: "string", description: "订单号，例如 ORD-10292" }
    },
    required: ["order_id"],
    additionalProperties: false
  }
};

function citationsFrom(response) {
  const citations = [];
  for (const item of response.output || []) {
    if (item.type !== "message") continue;
    for (const part of item.content || []) {
      for (const annotation of part.annotations || []) {
        if (annotation.type === "file_citation") citations.push({ filename: annotation.filename || annotation.file_id, title: annotation.filename || "知识库来源" });
      }
    }
  }
  return [...new Map(citations.map((item) => [item.filename, item])).values()];
}

function moderationFlagged(response) {
  const input = response.moderation?.input;
  const output = response.moderation?.output;
  return (input?.type !== "error" && input?.flagged) || (output?.type !== "error" && output?.flagged);
}

export class OpenAISupportProvider {
  constructor(config, { playbookDir } = {}) {
    this.config = config;
    this.playbookDir = playbookDir;
    this.client = new OpenAI({ apiKey: config.OPENAI_API_KEY, timeout: config.REQUEST_TIMEOUT_MS, maxRetries: 1 });
    this.tools = [
      { type: "file_search", vector_store_ids: [config.OPENAI_VECTOR_STORE_ID], max_num_results: 5 },
      ...(config.AUTH_MODE === "public" ? [] : [orderTool])
    ];
  }

  async answer({ message, identity, session, thoughtContext, timeoutMs, maxTokens = 900, signal }) {
    const playbookPrompt = thoughtContext?.generationPrompt ? "" : await loadAutonomyPrompt(this.playbookDir, buildRetrievalQuery(message, session.history || []));
    const instructions = thoughtContext?.generationPrompt || `${SUPPORT_INSTRUCTIONS}\n${playbookPrompt}`;
    const safetyId = safetyIdentifier(this.config.USER_HASH_SECRET, identity.tenantId, identity.userId);
    const history = (session.history || []).slice(-8).flatMap((turn) => [
      { role: "user", content: turn.user },
      { role: "assistant", content: turn.assistant }
    ]);
    let input = [...history, { role: "user", content: message }];
    let previousResponseId = this.config.OPENAI_STORE ? session.lastResponseId : undefined;
    let response;
    let usedTrustedTool = false;

    for (let toolRound = 0; toolRound < 4; toolRound += 1) {
      response = await this.client.responses.create({
        model: this.config.OPENAI_MODEL,
        instructions,
        input,
        previous_response_id: previousResponseId || undefined,
        tools: this.tools,
        max_output_tokens: maxTokens,
        reasoning: { effort: this.config.OPENAI_REASONING_EFFORT },
        text: { verbosity: "low" },
        safety_identifier: safetyId,
        moderation: { model: "omni-moderation-latest" },
        store: this.config.OPENAI_STORE
      }, { timeout: timeoutMs, maxRetries: 0, signal });

      if (moderationFlagged(response)) {
        return { action: "refuse", answer: "这项内容无法由在线助手处理。如有现实安全风险，请立即联系当地紧急服务或人工客服。", grounded: true, citations: [], responseId: response.id };
      }

      const calls = (response.output || []).filter((item) => item.type === "function_call");
      if (!calls.length) break;

      const outputs = await Promise.all(calls.map(async (call) => {
        let result;
        try {
          const args = JSON.parse(call.arguments);
          result = call.name === "get_order_status"
            ? await getOrderStatus({ orderId: args.order_id, ...identity })
            : { error: "不支持的工具。" };
          if (call.name === "get_order_status" && !result.error) usedTrustedTool = true;
        } catch {
          result = { error: "工具参数无效。" };
        }
        return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) };
      }));

      if (this.config.OPENAI_STORE) {
        previousResponseId = response.id;
        input = outputs;
      } else {
        input = [...input, ...response.output, ...outputs];
      }
    }

    if (!response?.output_text) throw new Error("Model returned no final answer");
    const citations = citationsFrom(response);
    if (usedTrustedTool) citations.push({ filename: "trusted-tool:get_order_status", title: "订单系统" });
    return {
      action: "answer",
      answer: toPlainText(response.output_text),
      grounded: citations.length > 0 || /订单|物流|快递|配送|发货/.test(message),
      citations,
      responseId: response.id
    };
  }

  async review({ reviewPrompt, timeoutMs, maxTokens = 900, signal }) {
    const response = await this.client.responses.create({
      model: this.config.OPENAI_MODEL,
      instructions: reviewPrompt,
      input: "请执行独立审核并只返回规定的 JSON。",
      tools: this.tools.filter((tool) => tool.type === "file_search"),
      max_output_tokens: maxTokens,
      reasoning: { effort: this.config.OPENAI_REASONING_EFFORT },
      text: { verbosity: "low" },
      store: false
    }, { timeout: timeoutMs, maxRetries: 0, signal });
    return response.output_text || "";
  }
}
