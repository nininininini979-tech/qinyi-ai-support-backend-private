import crypto from "node:crypto";
import { z } from "zod";
import { classifyThoughtRisk } from "./risk.js";

export const CONTRACT_STATUSES = ["confirmed", "provisional", "unknown", "conflicting", "superseded"];

const requirementSchema = z.object({
  id: z.string(),
  kind: z.string(),
  value: z.string(),
  status: z.enum(CONTRACT_STATUSES),
  source: z.enum(["customer", "session", "tenant", "evidence"]),
  turn: z.number().int().nonnegative()
});

export const taskContractSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  hash: z.string().length(64),
  createdAt: z.string(),
  language: z.object({
    input: z.enum(["zh-CN", "en", "mixed"]),
    output: z.enum(["zh-CN", "en"]),
    bilingual: z.boolean()
  }),
  task: z.object({ kind: z.string(), purpose: z.string() }),
  demand: z.object({
    goal: z.string(),
    requirements: z.array(requirementSchema),
    unknowns: z.array(z.string())
  }),
  supply: z.object({
    status: z.enum(["unresolved", "partial", "matched", "conflict"]),
    rule: z.literal("evidence_only"),
    humanConfirmationTopics: z.array(z.string())
  }),
  risk: z.object({
    level: z.enum(["low", "medium", "high", "critical"]),
    flags: z.array(z.string()),
    securityFlags: z.array(z.string()),
    humanGate: z.boolean()
  }),
  b2: z.object({
    audienceLevel: z.enum(["lay", "informed", "expert"]),
    customerType: z.enum(["factory", "organization", "buyer", "unknown"]),
    country: z.string().max(80).optional(),
    channel: z.enum(["web", "sales", "email", "other"]),
    budgetBand: z.enum(["unknown", "value", "standard", "premium"]),
    urgency: z.enum(["normal", "urgent"]),
    returningCustomer: z.boolean(),
    professionalConsultation: z.boolean()
  }),
  c2: z.record(z.unknown()),
  runtimePolicy: z.object({
    schemaVersion: z.number().int().positive(),
    revision: z.number().int().positive(),
    note: z.string().max(4000),
    enabledHandoffKeys: z.array(z.string().max(80)).max(20)
  }).optional(),
  acceptance: z.array(z.object({ id: z.string(), severity: z.enum(["fatal", "major", "minor"]), criterion: z.string() })),
  provenance: z.object({ policyVersion: z.string(), aVersion: z.string(), b1Version: z.string(), c1Version: z.string(), dVersion: z.string() })
});

const UNKNOWN_FIELDS = ["use_case", "procurement_quantity", "dimensions", "material", "process", "packaging", "destination", "delivery_date"];

function detectLanguage(message) {
  const value = String(message);
  const chinese = (value.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = (value.match(/[A-Za-z]/g) || []).length;
  if (chinese && latin > chinese) return "mixed";
  if (chinese) return "zh-CN";
  return "en";
}

function resolveOutputLanguage(input, options, previous, message) {
  if (options.outputLanguage === "zh-CN" || options.outputLanguage === "en") return options.outputLanguage;
  if (/(?:翻译|输出|回复).{0,8}(?:英文|英语)|\bin\s+English\b|English\s+version/i.test(message)) return "en";
  if (/(?:翻译|输出|回复).{0,8}(?:中文|汉语)|\bin\s+Chinese\b|Chinese\s+version/i.test(message)) return "zh-CN";
  if (input === "zh-CN" || input === "en") return input;
  return previous === "en" ? "en" : "zh-CN";
}

function collectMatches(message, kind, pattern) {
  const source = String(message);
  const values = [...source.matchAll(pattern)].map((match) => ({
    value: match[0].trim(),
    provisional: /(?:大约|大概|约|预计|可能|暂定|around|about|approximately|maybe)\s*$/i.test(source.slice(Math.max(0, match.index - 16), match.index))
  }));
  return [...new Map(values.map((item) => [item.value, item])).values()].map((item) => ({ kind, ...item }));
}

function extractRequirements(message) {
  return [
    ...collectMatches(message, "procurement_quantity", /\d+(?:\.\d+)?\s*(?:套|件|副|sets?\b|pieces?\s+ordered\b)/gi),
    ...collectMatches(message, "piece_count", /\d+(?:\.\d+)?\s*(?:片|张|pieces?\b)/gi),
    ...collectMatches(message, "dimensions", /\d+(?:\.\d+)?\s*(?:×|x|X)\s*\d+(?:\.\d+)?\s*(?:mm|cm|毫米|厘米)?/g),
    ...collectMatches(message, "budget", /(?:预算|单价|价格|budget|price).{0,16}(?:[¥￥$]\s*)?\d+(?:\.\d+)?(?:\s*(?:元|美元|USD|RMB))?/gi),
    ...collectMatches(message, "delivery_date", /(?:交期|出货|送达|delivery|ship).{0,20}(?:\d{1,4}[年\-/]\d{1,2}(?:[月\-/]\d{1,2}日?)?|\d+\s*(?:天|周|days?|weeks?))/gi)
  ];
}

function mergeRequirements(previous = [], extracted = [], turn = 0) {
  const next = previous.map((item) => ({ ...item, source: item.source === "customer" ? "session" : item.source }));
  for (const kind of new Set(extracted.map((item) => item.kind))) {
    const values = extracted.filter((item) => item.kind === kind);
    for (const item of next) {
      if (item.kind === kind && item.status === "confirmed") item.status = "superseded";
    }
    const status = values.length > 1 ? "conflicting" : values[0].provisional ? "provisional" : "confirmed";
    for (const [index, item] of values.entries()) {
      next.push({ id: `${kind}-${turn}-${index}`, ...item, status, source: "customer", turn });
    }
  }
  return next.slice(-24);
}

function taskKind(message) {
  if (/(翻译|英文|中文|translate)/i.test(message)) return "translate";
  if (/(比较|区别|compare)/i.test(message)) return "compare";
  if (/(报价|价格|预算|quote|price)/i.test(message)) return "quote_prepare";
  if (/(推荐|选型|方案|定制|recommend|solution)/i.test(message)) return "recommend";
  return "explain";
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function contractHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function compileTaskContract({ message, session = {}, options = {}, runtimePolicy, now = new Date() }) {
  const input = detectLanguage(message);
  const previous = session.thought || {};
  const turn = Number(previous.turn || 0) + 1;
  const language = {
    input,
    output: resolveOutputLanguage(input, options, previous.language?.output, message),
    bilingual: Boolean(options.bilingual)
  };
  const requirements = mergeRequirements(previous.requirements || [], extractRequirements(message), turn);
  const presentKinds = new Set(requirements.filter((item) => item.status === "confirmed").map((item) => item.kind));
  const risk = classifyThoughtRisk(message, options);
  const body = {
    version: Number(previous.version || 0) + 1,
    createdAt: now.toISOString(),
    language,
    task: { kind: taskKind(message), purpose: "clarify_customer_demand_and_match_verified_supply" },
    demand: {
      goal: String(message),
      requirements,
      unknowns: UNKNOWN_FIELDS.filter((field) => !presentKinds.has(field))
    },
    supply: {
      status: "unresolved",
      rule: "evidence_only",
      humanConfirmationTopics: risk.flags.filter((flag) => ["price", "moq", "lead_time", "capacity", "production_feasibility", "mould_or_process", "certification", "payment", "regulation"].includes(flag))
    },
    risk,
    b2: {
      audienceLevel: options.audienceLevel || "informed",
      customerType: options.customerType || "organization",
      country: options.country,
      channel: options.channel || "web",
      budgetBand: options.budgetBand || "unknown",
      urgency: options.urgency || "normal",
      returningCustomer: Boolean(options.returningCustomer),
      professionalConsultation: Boolean(options.professionalConsultation)
    },
    c2: {},
    ...(runtimePolicy ? { runtimePolicy: {
      schemaVersion: Number(runtimePolicy.schemaVersion || 1),
      revision: Number(runtimePolicy.revision || 1),
      note: String(runtimePolicy.note || "").trim().slice(0, 4000),
      enabledHandoffKeys: Array.isArray(runtimePolicy.enabledHandoffKeys) ? runtimePolicy.enabledHandoffKeys.slice(0, 20).map((item) => String(item).slice(0, 80)) : []
    } } : {}),
    acceptance: [
      { id: "semantic-fidelity", severity: "fatal", criterion: "Preserve confirmed requirements, quantities, units, conditions, and uncertainty." },
      { id: "evidence-boundary", severity: "fatal", criterion: "Do not add company facts or feasibility claims without trusted evidence." },
      { id: "status-discipline", severity: "major", criterion: "Keep confirmed, provisional, unknown, conflicting, and superseded information distinct." },
      { id: "demand-supply-interface", severity: "major", criterion: "Connect demand and supply only at evidence-supported interface points." },
      { id: "customer-utility", severity: "minor", criterion: "Provide a clear primary direction, at most one alternative, and the smallest useful next step." }
    ],
    provenance: { policyVersion: "company-policy-v1", aVersion: "a-charter-v1", b1Version: "b-charter-v1", c1Version: "c-charter-v1", dVersion: "d-charter-v1" }
  };
  const hash = contractHash({ ...body, createdAt: undefined });
  return taskContractSchema.parse({ id: `contract-${hash.slice(0, 16)}`, hash, ...body });
}

export function sessionThoughtState(contract, reviewFailures = 0) {
  return {
    contractId: contract.id,
    hash: contract.hash,
    version: contract.version,
    turn: contract.demand.requirements.reduce((max, item) => Math.max(max, item.turn), 0),
    language: contract.language,
    requirements: contract.demand.requirements,
    risk: contract.risk,
    reviewFailures
  };
}
