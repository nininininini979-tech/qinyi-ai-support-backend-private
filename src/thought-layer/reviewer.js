import { reviewProductAnswer } from "../support/answer-guard.js";
import { riskAtLeast } from "./risk.js";

function issue(code, severity, reason, repairConstraint) {
  return { code, severity, reason, repairConstraint };
}

function importantRequirement(item) {
  return ["procurement_quantity", "piece_count", "dimensions", "budget", "delivery_date"].includes(item.kind);
}

function normalized(value) {
  return String(value).toLowerCase().replace(/[\s,，。]/g, "").replace(/[xX]/g, "×");
}

function isEvidenceBoundedFallback(answer) {
  return /(没有找到|暂无|无法确认|不能确认|不会猜测|需要人工|人工确认|not\s+(?:enough|available)|cannot confirm|human confirmation)/i.test(answer);
}

function requirementPreserved(answer, requirement, outputLanguage) {
  const normalizedAnswer = normalized(answer);
  const normalizedValue = normalized(requirement.value);
  if (normalizedAnswer.includes(normalizedValue)) return true;
  const numbers = requirement.value.match(/\d+(?:\.\d+)?/g) || [];
  if (!numbers.every((number) => normalizedAnswer.includes(number))) return false;
  if (requirement.kind === "procurement_quantity") return outputLanguage === "en" ? /\bsets?\b|\bunits?\b/i.test(answer) : /(套|件|副)/.test(answer);
  if (requirement.kind === "piece_count") return outputLanguage === "en" ? /\bpieces?\b/i.test(answer) : /(片|张)/.test(answer);
  if (requirement.kind === "dimensions") return /(?:×|x|X)/.test(answer);
  return numbers.length > 0;
}

export function reviewDeterministically({ candidate, contract, citations = [], grounded = citations.length > 0 }) {
  const answer = String(candidate || "");
  const maxChars = contract.b2.professionalConsultation ? 800 : 600;
  const issues = reviewProductAnswer(answer, maxChars).map((reason) => issue("unsupported_or_format_claim", "major", reason, "删除无依据断言或改为明确的待人工确认项。"));

  if (!grounded && !isEvidenceBoundedFallback(answer)) {
    issues.push(issue("ungrounded_response", "fatal", "候选没有受信任证据，也没有明确限制为无法确认的保守答复。", "删除无依据的公司事实，只说明当前无法确认并给出安全下一步。"));
  }

  if (riskAtLeast(contract.risk.level, "high") && citations.length === 0) {
    issues.push(issue("missing_evidence", "fatal", "高风险回复没有任何受信任来源或工具引用。", "只保留信息收集和转人工说明，不作事实性结论。"));
  }

  for (const requirement of contract.demand.requirements.filter((item) => item.status === "confirmed" && importantRequirement(item))) {
    if (!requirementPreserved(answer, requirement, contract.language.output)) {
      issues.push(issue("missing_confirmed_requirement", "major", `候选没有保持客户已确认条件：${requirement.value}`, `在不改变数字和单位的前提下明确保留“${requirement.value}”。`));
    }
  }

  for (const requirement of contract.demand.requirements.filter((item) => item.status === "superseded" && importantRequirement(item))) {
    if (requirementPreserved(answer, requirement, contract.language.output)) {
      issues.push(issue("uses_superseded_requirement", "fatal", `候选重新使用了已被替代的条件：${requirement.value}`, "删除旧值，只使用最新 confirmed 条件。"));
    }
  }

  if (contract.language.output === "en" && /[\u3400-\u9fff]{12,}/.test(answer)) {
    issues.push(issue("wrong_output_language", "major", "候选未遵循英文输出要求。", "保持品牌、SKU、数字和单位不变，以英文重新表达。"));
  }
  if (contract.language.output === "zh-CN" && !/[\u3400-\u9fff]/.test(answer)) {
    issues.push(issue("wrong_output_language", "major", "候选未遵循中文输出要求。", "以中文重新表达，必要专业术语可保留英文括注。"));
  }

  const penalty = issues.reduce((total, item) => total + (item.severity === "fatal" ? 45 : item.severity === "major" ? 20 : 5), 0);
  return { decision: issues.length ? "fail" : "pass", score: Math.max(0, 100 - penalty), issues };
}

export function parseModelReview(value) {
  if (value && typeof value === "object") return normalizeModelReview(value);
  const text = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return normalizeModelReview(JSON.parse(text));
  } catch {
    return {
      decision: "escalate",
      score: 0,
      issues: [issue("review_parse_failure", "fatal", "独立审核未返回有效结构。", "转人工或重新运行独立审核。")]
    };
  }
}

function normalizeModelReview(value) {
  const decision = ["pass", "fail", "escalate"].includes(value.decision) ? value.decision : "escalate";
  const score = Number.isFinite(Number(value.score)) ? Math.max(0, Math.min(100, Number(value.score))) : 0;
  const issues = Array.isArray(value.issues) ? value.issues.slice(0, 4).map((item) => issue(
    String(item.code || "review_issue"),
    ["fatal", "major", "minor"].includes(item.severity) ? item.severity : "major",
    String(item.reason || "审核未提供原因。"),
    String(item.repairConstraint || "根据合同修复，不得引入新事实。")
  )) : [];
  return { decision, score, issues };
}

export function combineReviews(deterministic, independent) {
  if (!independent) return deterministic;
  const issues = [...deterministic.issues, ...independent.issues];
  const decision = deterministic.decision === "pass" && independent.decision === "pass" ? "pass" : independent.decision === "escalate" ? "escalate" : "fail";
  return { decision, score: Math.min(deterministic.score, independent.score), issues };
}
