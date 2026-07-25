import test from "node:test";
import assert from "node:assert/strict";
import { getOrderStatus } from "../src/adapters/orders.js";

test("order lookup enforces tenant and user ownership in the predicate", async () => {
  const own = await getOrderStatus({ orderId: "ORD-10292", tenantId: "demo-tenant", userId: "demo-user-1" });
  assert.equal(own.status, "已发货");

  const otherUser = await getOrderStatus({ orderId: "ORD-998", tenantId: "demo-tenant", userId: "demo-user-1" });
  assert.equal(otherUser.error, "未找到该订单，或您无权查看该订单信息。");

  const otherTenant = await getOrderStatus({ orderId: "ORD-10292", tenantId: "other-tenant", userId: "demo-user-1" });
  assert.ok(otherTenant.error);
});
