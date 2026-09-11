/**
 * Test: Payment Webhook Bulk Replay (same envelope ×10)
 * Category: 09 - Webhook storm (#837 scenario 15)
 *
 * Razorpay redelivers aggressively. Ten deliveries of the same signed
 * envelope (5 concurrent + 5 sequential) must produce exactly ONE
 * WebhookEvent row — the route derives `eventId = event:entityId` from the
 * payload and logWebhookEvent's 3-state machine + P2002 catch dedupe — and
 * every delivery must be ACKed 2xx so the gateway stops retrying.
 *
 * Deliberately uses a nonexistent payment id: this exercises the
 * idempotency machinery, not the money cascade (the staging gate covers
 * cascades with sandbox payments).
 */
import "dotenv/config";
import crypto from "node:crypto";
import prisma from "../../../../../lib/prisma";
import {
  BASE_URL,
  check,
  finish,
  fireConcurrent,
  histogram,
  ensureServerOrSkip,
} from "../../utilities/api-client";

const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

async function run() {
  await ensureServerOrSkip();

  if (!SECRET) {
    console.log("⏭️  SKIP — RAZORPAY_WEBHOOK_SECRET not set");
    process.exit(0);
  }

  const paymentId = `pay_chaos_${process.pid}_${Date.now()}`;
  const expectedEventId = `payment.captured:${paymentId}`;
  const payload = JSON.stringify({
    entity: "event",
    account_id: "acc_chaos",
    event: "payment.captured",
    contains: ["payment"],
    payload: {
      payment: {
        entity: {
          id: paymentId,
          entity: "payment",
          order_id: `order_chaos_${process.pid}`,
          status: "captured",
          amount: 100,
          currency: "INR",
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  });
  const signature = crypto
    .createHmac("sha256", SECRET)
    .update(payload)
    .digest("hex");

  const post = () =>
    fetch(`${BASE_URL}/api/webhooks/razorpay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-razorpay-signature": signature,
      },
      body: payload,
    }).then(async (r) => ({
      status: r.status,
      body: await r.json().catch(() => null),
    }));

  const concurrent = await fireConcurrent(5, post);
  const sequential = [];
  for (let i = 0; i < 5; i++) sequential.push(await post());
  const all = [...concurrent, ...sequential];

  check(
    "all 10 deliveries ACKed (2xx — gateway must stop retrying)",
    all.every((r) => r.status >= 200 && r.status < 300),
    histogram(all),
  );

  const rows = await prisma.webhookEvent.findMany({
    where: { eventId: expectedEventId },
    select: { id: true },
  });
  check("exactly one WebhookEvent row for the envelope", rows.length === 1, {
    count: rows.length,
  });

  // Cleanup chaos rows for repeat runs.
  await prisma.webhookEvent.deleteMany({ where: { eventId: expectedEventId } });

  finish("webhook-bulk-replay");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
