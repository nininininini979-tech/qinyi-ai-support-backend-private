import { z } from "zod";

export const RUNTIME_RULE_SCHEMA_VERSION = 1;
export const RUNTIME_RULE_MODES = Object.freeze(["observe", "draft", "auto", "paused"]);

const HANDOFF_DEFINITIONS = Object.freeze([
  Object.freeze({ key: "price", label: "价格与正式报价", description: "涉及价格、费用或正式报价时优先交由人工确认。", pattern: /(?:价格|报价|单价|多少钱|费用|quote|price|cost)/i }),
  Object.freeze({ key: "delivery", label: "交期与出货安排", description: "涉及交期、出货时间或加急安排时优先交由人工确认。", pattern: /(?:交期|出货时间|多久(?:能|可以)?(?:做完|交付)|加急|lead\s*time|delivery\s*(?:date|time)?)/i }),
  Object.freeze({ key: "complaint", label: "投诉与重大不满", description: "投诉、重大不满和争议进入人工处理；底层安全规则仍独立生效。", pattern: /(?:投诉|严重不满|争议|complaint|dispute)/i }),
  Object.freeze({ key: "payment", label: "付款与订金尾款", description: "付款方式、订金、尾款和账期由人工确认。", pattern: /(?:付款|支付|订金|定金|尾款|账期|payment|deposit|balance\s*payment)/i }),
  Object.freeze({ key: "legal", label: "合同与法律事项", description: "合同、律师或法律事项进入人工处理；底层安全规则仍独立生效。", pattern: /(?:合同|律师|诉讼|法律|contract|legal|lawyer|litigation)/i }),
  Object.freeze({ key: "missing_knowledge", label: "连续缺少可靠资料", description: "连续三轮没有可靠依据时自动建立人工服务请求。", pattern: null })
]);

export const RUNTIME_HANDOFF_RULE_KEYS = Object.freeze(HANDOFF_DEFINITIONS.map((item) => item.key));
export const LOCKED_RUNTIME_HANDOFF_RULE_KEYS = Object.freeze(["complaint", "legal"]);
const LOCKED_HANDOFF_RULE_SET = new Set(LOCKED_RUNTIME_HANDOFF_RULE_KEYS);
const DEFINITION_BY_KEY = new Map(HANDOFF_DEFINITIONS.map((item) => [item.key, item]));

const handoffInputSchema = z.object({
  key: z.enum(RUNTIME_HANDOFF_RULE_KEYS),
  enabled: z.boolean()
}).strict();

export const runtimeRulesUpdateSchema = z.object({
  mode: z.enum(RUNTIME_RULE_MODES).optional(),
  handoff: z.array(handoffInputSchema).max(RUNTIME_HANDOFF_RULE_KEYS.length).optional(),
  note: z.string().trim().max(4000).optional(),
  expectedRevision: z.number().int().positive().optional()
}).strict().superRefine((value, context) => {
  if (value.mode === undefined && value.handoff === undefined && value.note === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "至少需要修改一项规则。" });
  }
  const keys = (value.handoff || []).map((item) => item.key);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "转人工规则不能重复。", path: ["handoff"] });
  }
  for (const [index, item] of (value.handoff || []).entries()) {
    if (LOCKED_HANDOFF_RULE_SET.has(item.key) && !item.enabled) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "投诉与法律安全规则不能关闭。", path: ["handoff", index, "enabled"] });
    }
  }
});

function validMode(value, fallback = "auto") {
  return RUNTIME_RULE_MODES.includes(value) ? value : fallback;
}

function enabledMap(value) {
  const result = new Map(RUNTIME_HANDOFF_RULE_KEYS.map((key) => [key, true]));
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && DEFINITION_BY_KEY.has(item)) result.set(item, true);
      if (item && typeof item === "object" && DEFINITION_BY_KEY.has(item.key) && typeof item.enabled === "boolean") {
        result.set(item.key, item.enabled);
      }
    }
  }
  for (const key of LOCKED_RUNTIME_HANDOFF_RULE_KEYS) result.set(key, true);
  return result;
}

function boundedText(value, max = 4000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function normalizeRuntimeRules(value = {}, { mode, revision } = {}) {
  const source = value && typeof value === "object" ? value : {};
  const enabled = enabledMap(source.handoff);
  return {
    schemaVersion: RUNTIME_RULE_SCHEMA_VERSION,
    revision: Number.isInteger(Number(source.revision)) && Number(source.revision) > 0
      ? Number(source.revision)
      : Number.isInteger(Number(revision)) && Number(revision) > 0 ? Number(revision) : 1,
    mode: validMode(mode, validMode(source.mode)),
    handoff: HANDOFF_DEFINITIONS.map(({ key, label, description }) => ({ key, label, description, enabled: enabled.get(key), locked: LOCKED_HANDOFF_RULE_SET.has(key) })),
    note: boundedText(source.note),
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null,
    updatedBy: boundedText(source.updatedBy, 120) || null
  };
}

export function storedRuntimeRules(value) {
  const rules = normalizeRuntimeRules(value);
  return {
    schemaVersion: rules.schemaVersion,
    revision: rules.revision,
    mode: rules.mode,
    handoff: rules.handoff.map(({ key, enabled }) => ({ key, enabled })),
    note: rules.note,
    updatedAt: rules.updatedAt,
    updatedBy: rules.updatedBy
  };
}

export function parseRuntimeRulesUpdate(value) {
  const result = runtimeRulesUpdateSchema.safeParse(value);
  if (result.success) return result.data;
  throw Object.assign(new Error("客服规则参数无效。"), {
    statusCode: 400,
    errorCode: "INVALID_RUNTIME_RULES"
  });
}

export function createRuntimeRulesRevision(currentValue, updateValue, actor, updatedAt = new Date().toISOString()) {
  const current = normalizeRuntimeRules(currentValue);
  const update = parseRuntimeRulesUpdate(updateValue);
  const enabled = new Map(current.handoff.map((item) => [item.key, item.enabled]));
  for (const item of update.handoff || []) enabled.set(item.key, item.enabled);
  return normalizeRuntimeRules({
    revision: current.revision + 1,
    mode: update.mode ?? current.mode,
    handoff: RUNTIME_HANDOFF_RULE_KEYS.map((key) => ({ key, enabled: enabled.get(key) })),
    note: update.note ?? current.note,
    updatedAt,
    updatedBy: String(actor || "system").slice(0, 120)
  });
}

export function evaluateRuntimeRules(message, value) {
  const rules = normalizeRuntimeRules(value);
  const source = String(message || "");
  for (const item of rules.handoff) {
    const definition = DEFINITION_BY_KEY.get(item.key);
    if (!item.enabled || !definition?.pattern || !definition.pattern.test(source)) continue;
    return {
      matched: true,
      action: "handoff",
      reason: `runtime_rule_${item.key}`,
      rule: { key: item.key, label: item.label },
      revision: rules.revision
    };
  }
  return { matched: false, action: "ai", reason: "no_runtime_rule_match", revision: rules.revision };
}

export class RuntimeRulesControl {
  constructor(value) {
    this.rules = normalizeRuntimeRules(value);
  }

  set(value, options) {
    this.rules = normalizeRuntimeRules(value, options);
    return this.snapshot();
  }

  snapshot() {
    return structuredClone(this.rules);
  }

  mode() {
    return this.rules.mode;
  }

  evaluate(message) {
    return evaluateRuntimeRules(message, this.rules);
  }

  enabled(key) {
    return Boolean(this.rules.handoff.find((item) => item.key === key)?.enabled);
  }

  generationContext() {
    return {
      schemaVersion: this.rules.schemaVersion,
      revision: this.rules.revision,
      note: this.rules.note,
      enabledHandoffKeys: this.rules.handoff.filter((item) => item.enabled).map((item) => item.key)
    };
  }
}

export class OperationsRuntimeRulesSource {
  constructor(service) {
    this.service = service;
  }

  async snapshot() {
    return this.service.getRuntimeRules();
  }
}
