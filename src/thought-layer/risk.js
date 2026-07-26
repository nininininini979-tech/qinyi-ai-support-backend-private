const LEVEL_WEIGHT = { low: 0, medium: 1, high: 2, critical: 3 };

const CRITICAL_RULES = [
  ["refund_or_compensation", /(退款|退钱|赔偿|补偿|chargeback)/i],
  ["legal_or_complaint", /(诉讼|律师|法律纠纷|投诉|起诉|仲裁|liability|lawsuit|complaint)/i],
  ["binding_contract", /(合同承诺|签订合同|法律结论|binding contract|legal conclusion)/i]
];

const HIGH_RULES = [
  ["price", /(价格|单价|报价|预算|金额|优惠|price|quote|budget|cost)/i],
  ["moq", /(起订量|最小起订|MOQ|minimum order)/i],
  ["lead_time", /(交期|工期|交货|多久出货|何时发货|lead\s*time|delivery date)/i],
  ["capacity", /(产能|日产|月产|生产能力|capacity)/i],
  ["production_feasibility", /(能否生产|可以生产|生产可行|做得了|可实现|feasib|manufactur)/i],
  ["mould_or_process", /(开模|模具|刀模|特殊工艺|工艺可行|mould|mold|tooling|die-cut)/i],
  ["certification", /(认证|证书|检测报告|合规|certif|compliance)/i],
  ["contract_terms", /(合同|条款|contract terms?|agreement)/i],
  ["payment", /(付款|账期|定金|尾款|payment|deposit)/i],
  ["order_privacy", /(订单隐私|客户信息|联系方式|地址|手机号|order privacy|personal data)/i],
  ["logistics", /(物流状态|快递状态|运单|追踪|tracking|shipment status)/i],
  ["regulation", /(法规|法令|监管要求|regulation|regulatory)/i],
  ["exact_performance", /(精确性能|性能指标|技术指标|防水|防火|阻燃|承重|耐温|耐磨|耐候|抗压|抗拉|IP\s*\d{2}|保证.{0,8}(效果|性能)|承诺.{0,8}(效果|性能)|guarantee.{0,20}performance|waterproof|load[- ]?bearing|temperature resistance|performance spec)/i]
];

const MEDIUM_RULES = [
  ["product_recommendation", /(推荐|选型|方案|比较|适合|建议|recommend|compare|solution)/i],
  ["audience_fit", /(儿童|青少年|学生|年龄|受众|audience|age group)/i],
  ["customization", /(定制|异形|特殊尺寸|custom|bespoke)/i],
  ["quality_claim", /(质量|耐用|质感|展示效果|印刷效果|quality|durab|visual)/i]
];

const SECURITY_RULES = [
  ["prompt_injection", /(忽略.{0,12}(之前|上述|系统).{0,12}(指令|提示)|显示.{0,12}(系统提示|system prompt)|ignore.{0,16}(previous|system).{0,16}(instruction|prompt))/i],
  ["pii", /(?<!\d)1[3-9]\d{9}(?!\d)|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?<!\d)\d{17}[\dXx](?!\w)/],
  ["tool_request", /(查询订单|订单号|物流|tracking|order status)/i]
];

function matchingFlags(message, rules) {
  return rules.filter(([, pattern]) => pattern.test(message)).map(([flag]) => flag);
}

export function classifyThoughtRisk(message, options = {}) {
  const value = String(message);
  const critical = matchingFlags(value, CRITICAL_RULES);
  const high = matchingFlags(value, HIGH_RULES);
  const medium = matchingFlags(value, MEDIUM_RULES);
  const securityFlags = matchingFlags(value, SECURITY_RULES);
  const explicitTranslation = (options.outputLanguage && options.outputLanguage !== "auto") || /(?:翻译|输出|回复).{0,8}(?:英文|英语|中文|汉语)|\btranslate\b|\bin\s+(?:English|Chinese)\b/i.test(value);
  const importantSpecification = /(\d|尺寸|材质|工艺|认证|规格|unit|size|material|process|certif)/i.test(value);
  if (explicitTranslation && importantSpecification) high.push("cross_language_specification");

  const level = critical.length ? "critical" : high.length ? "high" : medium.length ? "medium" : "low";
  return {
    level,
    flags: [...new Set([...critical, ...high, ...medium])],
    securityFlags,
    humanGate: level === "critical"
  };
}

export function riskAtLeast(level, minimum) {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[minimum];
}
