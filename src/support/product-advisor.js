const PRODUCT_DISCOVERY_INTENT = /(介绍|推荐|选型|怎么选|选什么|不知道.{0,6}选|方案|适合|人群|年龄|预算|礼品|礼物|文创|景区|定制|做一款|规划|有什么产品|有哪些产品|产品有哪些|产品经理)/i;
const PUZZLE_INTENT = /(拼图|片数|儿童|成人|年龄|异形|圆形|开模)/i;
const COMMERCIAL_INTENT = /(数量|起订|预算|报价|成本|打样|交期|包装|运输|运费)/i;
const SHORT_FOLLOW_UP = /^(这个|那个|前者|后者|便宜一点|高端一点|详细说说|还有呢|为什么|怎么做|可以吗|适合吗|换一个|再推荐|继续)[？?。！!\s]*$/i;

function addFirst(chunks, selected, predicate) {
  const match = chunks.find(predicate);
  if (match) selected.set(`${match.filename}:${match.title}`, match);
}

function hasPieceCount(chunk, pieceCount) {
  if (chunk.filename !== "03-puzzle-mould-sizes.md") return false;
  if (chunk.title === `${pieceCount} 片`) return true;
  return new RegExp(`(?:^|\\n)\\s*-?\\s*${pieceCount}\\s*片\\s*[：:]`, "m").test(chunk.text);
}

export function isProductDiscoveryIntent(message) {
  return PRODUCT_DISCOVERY_INTENT.test(message);
}

export function buildRetrievalQuery(message, history = []) {
  const previous = history.at(-1)?.user;
  return previous && SHORT_FOLLOW_UP.test(message.trim()) ? `${previous}\n${message}` : message;
}

export function enrichProductContext(chunks, retrieved, message, limit = 5) {
  const pieceCount = message.match(/(\d{2,4})\s*片/i)?.[1];
  const preciseRetrieved = pieceCount
    ? retrieved.filter((chunk) => chunk.filename !== "03-puzzle-mould-sizes.md" || hasPieceCount(chunk, pieceCount))
    : retrieved;
  if (!isProductDiscoveryIntent(message)) return preciseRetrieved.slice(0, limit);
  const selected = new Map();

  addFirst(chunks, selected, (chunk) => chunk.category === "product_catalog" && chunk.approvalStatus === "source_verified" && chunk.title === "主要产品");
  if (/(礼品|礼物|文创|景区|企业|教育|纪念)/i.test(message)) {
    addFirst(chunks, selected, (chunk) => chunk.category === "product_catalog" && chunk.approvalStatus === "source_verified" && chunk.title === "支持的定制场景");
  }

  if (PUZZLE_INTENT.test(message)) {
    if (pieceCount) {
      addFirst(chunks, selected, (chunk) => hasPieceCount(chunk, pieceCount));
    } else {
      addFirst(chunks, selected, (chunk) => chunk.filename === "03-puzzle-mould-sizes.md" && chunk.title === "24-300 片");
    }
    addFirst(chunks, selected, (chunk) => chunk.filename === "04-materials-process-and-packaging.md" && /材质|工艺/.test(chunk.title));
  }

  if (COMMERCIAL_INTENT.test(message) || PUZZLE_INTENT.test(message)) {
    addFirst(chunks, selected, (chunk) => chunk.filename === "05-ordering-samples-lead-time-logistics.md" && /报价所需信息|起订量参考/.test(chunk.title));
  }

  for (const chunk of preciseRetrieved) {
    if (chunk.filename === "03-puzzle-mould-sizes.md") {
      // Order quantity such as "500套" must not be treated as a 500-piece product request.
      if (!pieceCount || !hasPieceCount(chunk, pieceCount)) continue;
    }
    selected.set(`${chunk.filename}:${chunk.title}`, chunk);
  }

  return [...selected.values()].slice(0, limit);
}
