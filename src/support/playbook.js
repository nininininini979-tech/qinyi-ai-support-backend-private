import fs from "node:fs/promises";
import path from "node:path";

const SAMPLE_SIGNALS = {
  "custom-shape-batch": [
    [/(异形|特殊外形|特殊形状|轮廓|造型)/i, 4],
    [/(开模|刀模)/i, 3],
    [/模具/i, 1]
  ],
  "folding-insert-packing": [
    [/(包装|装袋)/i, 3],
    [/(防刮|刮花|划痕|表面保护)/i, 3],
    [/(折叠|插片)/i, 2],
    [/(运输|物流)/i, 1]
  ],
  "teen-audience-selection": [
    [/(青少年|少年|学生|年龄|\d{1,2}\s*岁)/i, 4],
    [/拼图/i, 1],
    [/(礼品|礼物|文创)/i, 1],
    [/(预算|便宜|高端|成本方向)/i, 1]
  ],
  "quote-preparation": [
    [/(报价|核价|询价)/i, 4],
    [/(含税|税费|税点)/i, 3],
    [/(装箱|外箱|箱规|重量)/i, 2],
    [/(运费|物流)/i, 1]
  ]
};

function selectSample(samples, message) {
  if (!message?.trim()) return null;
  let best = null;
  let bestScore = 0;
  for (const sample of samples) {
    const score = (SAMPLE_SIGNALS[sample.id] || []).reduce(
      (total, [pattern, weight]) => total + (pattern.test(message) ? weight : 0),
      0
    );
    if (score > bestScore) {
      best = sample;
      bestScore = score;
    }
  }
  return bestScore >= 3 ? best : null;
}

function samplePrompt(sample) {
  if (!sample) return "";
  const reply = sample.reply_structure;
  return `

当前问题匹配的脱敏客服结构范例（${sample.id}）：
- 场景：${sample.scenario}
- 目标确认：${reply.acknowledge}
- 主建议写法：${reply.main_recommendation}
- 推荐理由写法：${reply.reason}
- 一个备选及取舍：${reply.alternatives_tradeoffs}
- 必须确认：${reply.needs_confirmation.join("、")}
- 最少补充字段：${reply.minimum_missing_fields.join("、")}
- 下一步：${reply.next_action}

该范例只用于学习回复结构和判断方式，不是产品事实来源。范例中的数量、规格和经验判断必须同时得到本轮受信任知识片段支持；否则不得复述为事实。
`;
}

export async function loadAutonomyPrompt(playbookDir, message = "") {
  if (!playbookDir) return "";
  const [policyRaw, samplesRaw] = await Promise.all([
    fs.readFile(path.join(playbookDir, "permissions", "autonomy-policy.json"), "utf8"),
    fs.readFile(path.join(playbookDir, "samples", "2026-07-25-distilled-samples.jsonl"), "utf8")
  ]);
  const policy = JSON.parse(policyRaw);
  const samples = samplesRaw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const selectedSample = selectSample(samples, message);
  const allowed = policy.allowed_autonomous_actions.map((item) => `- ${item.description}`).join("\n");
  const confirm = policy.human_confirmation_required.map((item) => `- ${item.description}`).join("\n");
  const requirements = policy.response_requirements.map((item) => `- ${item}`).join("\n");
  return `
本地审核的自主权限策略（版本 ${policy.version}）：
允许自主完成：
${allowed}

必须由人工确认：
${confirm}

回复要求：
${requirements}
${samplePrompt(selectedSample)}`;
}
