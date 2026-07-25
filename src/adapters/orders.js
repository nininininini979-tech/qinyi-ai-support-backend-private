const demoOrders = [
  { tenantId: "demo-tenant", userId: "demo-user-1", orderId: "ORD-10292", status: "已发货", carrier: "顺丰速运", trackingCode: "SF-DEMO-8891", updatedAt: "2026-07-24T09:30:00+08:00" },
  { tenantId: "demo-tenant", userId: "demo-user-2", orderId: "ORD-998", status: "生产中", carrier: null, trackingCode: null, updatedAt: "2026-07-23T15:10:00+08:00" }
];

export async function getOrderStatus({ orderId, tenantId, userId }) {
  // Ownership is part of the lookup predicate; never fetch first and authorize later.
  const order = demoOrders.find((item) => item.orderId === orderId && item.tenantId === tenantId && item.userId === userId);
  if (!order) return { error: "未找到该订单，或您无权查看该订单信息。" };
  return {
    order_id: order.orderId,
    status: order.status,
    carrier: order.carrier,
    tracking_code: order.trackingCode,
    updated_at: order.updatedAt
  };
}
