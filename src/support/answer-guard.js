const unsupportedClaims = [
  { label: "具体完成时长", test: (value) => /\d+(?:\.\d+)?(?:\s*[-~至到]\s*\d+(?:\.\d+)?)?\s*(?:小时|分钟)/i.test(value) },
  {
    label: "未经依据的年龄或体验表现",
    test: (value) => /(完成率|成功率|完成体验|适度挑战感|拼装门槛(?:更|较)?低|对.{0,12}年龄段.{0,20}(?:挑战|完成)|(?:\d{1,2}\s*岁|青少年|少年|学生).{0,40}(?:观察力|耐心|能力|专注力|挑战|完成|门槛|适合))/i.test(value)
  },
  {
    label: "未经依据的质量或展示效果",
    test: (value) => /((?:色彩还原度|印刷效果).{0,10}(?:更好|更佳|细腻|高)|视觉冲击力|(?:更|比较)体面|包装体积.{0,8}(?:更小|较小))/i.test(value)
  },
  {
    label: "未经确认的生产可行性",
    test: (value) => value.split(/[。！？；\n]/).some((sentence) => {
      const claim = /((?:数量|生产|模具|工艺).{0,12}(?:可行|没有问题|没问题|可以生产)|(?:达到|超过|满足).{0,40}(?:起订量|MOQ)|(?:起订量|MOQ).{0,30}(?:满足|达到|没有问题|没问题|可行)|数量上.{0,10}(?:没有问题|没问题|可行))/i.test(sentence);
      const confirmation = /((?:需|需要|待|由).{0,10}(?:业务|人工|技术).{0,10}(?:确认|评估)|(?:业务|人工|技术).{0,10}(?:确认|评估))/i.test(sentence);
      return claim && !confirmation;
    })
  },
  { label: "未经确认的精确金额", test: (value) => /(?:[¥￥$]\s*\d|\d+(?:\.\d+)?\s*(?:元|美元|人民币|USD|RMB))/i.test(value) }
];

export function reviewProductAnswer(value, maxChars = 600) {
  const answer = String(value);
  const issues = [];
  if (Array.from(answer).length > maxChars) issues.push(`超过${maxChars}字符`);
  for (const claim of unsupportedClaims) {
    if (claim.test(answer)) issues.push(claim.label);
  }
  return issues;
}

export const GUARDED_FALLBACK = "我可以继续为您整理产品方案，但当前草稿包含知识库未确认的判断，暂不直接发送。请补充使用场景、预算定位和包装要求；片数、材质和包装可先做条件化建议，精确价格、交期、起订量及生产可行性由业务确认。";
