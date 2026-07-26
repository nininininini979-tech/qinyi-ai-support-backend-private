import { buildRetrievalQuery, enrichProductContext } from "../support/product-advisor.js";
import { cleanExcerpt, loadKnowledge, retrieveKnowledge } from "../retrieval/local-knowledge.js";
import { getOrderStatus } from "../adapters/orders.js";

export class LocalEvidenceResolver {
  constructor({ knowledgeDir }) {
    this.knowledgeDir = knowledgeDir;
  }

  async resolve({ message, session = {}, identity }) {
    const chunks = await loadKnowledge(this.knowledgeDir);
    const query = buildRetrievalQuery(message, session.history || []);
    const matches = enrichProductContext(chunks, retrieveKnowledge(chunks, query, 5), query, 5);
    const citations = matches.map((item) => ({ filename: item.filename, title: item.title, source: item.source, sourcePages: item.sourcePages }));
    const evidence = matches.map((item) => ({ filename: item.filename, title: item.title, source: item.source, sourcePages: item.sourcePages, text: cleanExcerpt(item.text) }));
    const orderId = String(message).match(/ORD-[A-Za-z0-9-]+/i)?.[0]?.toUpperCase();
    if (orderId && identity) {
      const order = await getOrderStatus({ orderId, ...identity });
      if (!order.error) {
        citations.push({ filename: "trusted-tool:get_order_status", title: "订单系统" });
        evidence.push({
          filename: "trusted-tool:get_order_status",
          title: "订单系统",
          text: JSON.stringify({ order_id: order.order_id, status: order.status, carrier: order.carrier, tracking_code: order.tracking_code, updated_at: order.updated_at })
        });
      }
    }
    return { citations, evidence };
  }
}
