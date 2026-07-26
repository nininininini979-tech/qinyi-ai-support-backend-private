import { getOrderStatus } from "../adapters/orders.js";
import { cleanExcerpt, loadKnowledge, retrieveKnowledge } from "../retrieval/local-knowledge.js";
import { buildRetrievalQuery, enrichProductContext } from "../support/product-advisor.js";

export class MockSupportProvider {
  constructor({ knowledgeDir }) {
    this.knowledgeDir = knowledgeDir;
  }

  async answer({ message, identity, session = {} }) {
    const orderId = message.match(/ORD-[A-Za-z0-9-]+/i)?.[0]?.toUpperCase();
    if (orderId) {
      const result = await getOrderStatus({ orderId, ...identity });
      if (result.error) return { action: "answer", answer: result.error, grounded: true, citations: [] };
      const tracking = result.tracking_code ? `，${result.carrier}单号 ${result.tracking_code}` : "";
      return {
        action: "answer",
        answer: `订单 ${result.order_id} 当前状态：${result.status}${tracking}。更新时间：${result.updated_at}。`,
        grounded: true,
        citations: [{ filename: "trusted-tool:get_order_status", title: "订单系统" }]
      };
    }

    const chunks = await loadKnowledge(this.knowledgeDir);
    const retrievalQuery = buildRetrievalQuery(message, session.history || []);
    const retrieved = retrieveKnowledge(chunks, retrievalQuery, 5);
    const match = enrichProductContext(chunks, retrieved, retrievalQuery, 5)[0];
    if (!match) {
      return {
        action: "answer",
        answer: "现有知识库中没有找到足够明确的依据。我不会猜测这项信息，可以继续补充产品规格，或由人工客服确认。",
        grounded: false,
        citations: []
      };
    }
    return {
      action: "answer",
      answer: Array.from(`${match.title}\n\n${cleanExcerpt(match.text)}`).slice(0, 550).join(""),
      grounded: true,
      citations: [{ filename: match.filename, title: match.title }]
    };
  }

  async review() {
    return { decision: "pass", score: 100, issues: [] };
  }
}
