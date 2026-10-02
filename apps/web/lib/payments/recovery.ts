import { type Database, and, eq, getDb, inArray, lte, schema } from "@dayotter/db";
import { decodeAttempt } from "./attempt-terms";
import { appointmentCheckout } from "./attempts";
import { processAppointmentEvent, reconcileSession } from "./payment-events";
import { finalizePaymentBooking } from "./payment-finalization";
import { fulfillObservedPayment, requirePaymentReview } from "./payment-work";
import { retryAt } from "./recovery-backoff";
import { PaymentContradictionError } from "./routing";
import { retrieveSession } from "./stripe";

/** Bounded database recovery pass. Run from verified webhooks/browser reconciliation
 * or the operator CLI. Operational periodic scheduling is deliberately separate. */
export async function recoverAppointmentPayments(limit = 25, db: Database = getDb()) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Recovery limit must be 1..100");
  const now = new Date();
  const events = await db.query.paymentEvents.findMany({
    where: and(
      eq(schema.paymentEvents.state, "pending"),
      lte(schema.paymentEvents.nextRecoveryAt, now),
    ),
    limit,
    orderBy: (t, { asc }) => [asc(t.nextRecoveryAt)],
  });
  for (const event of events) await processAppointmentEvent(event.id, db);
  const attempts = await db.query.paymentAttempts.findMany({
    where: and(
      inArray(schema.paymentAttempts.state, [
        "prepared",
        "open",
        "payment_succeeded",
        "fulfilling",
      ]),
      lte(schema.paymentAttempts.nextRecoveryAt, now),
    ),
    limit,
    orderBy: (t, { asc }) => [asc(t.nextRecoveryAt)],
  });
  for (const attempt of attempts) {
    if (attempt.successFacts) {
      await fulfillObservedPayment(attempt.id, db);
      continue;
    }

    try {
      let current = await db.query.paymentAttempts.findFirst({
        where: eq(schema.paymentAttempts.id, attempt.id),
      });
      if (!current || current.bookingId || current.state === "requires_review") continue;
      if (current.successFacts) {
        await fulfillObservedPayment(current.id, db);
        continue;
      }
      if (!current.checkoutSessionId) {
        if (now >= current.creationDeadline) {
          await requirePaymentReview(current.id, "creation_ambiguous", db);
          continue;
        }
        // Same application attempt, Stripe key and frozen parameters; never a replacement intent.
        await appointmentCheckout(current);
        current = await db.query.paymentAttempts.findFirst({
          where: eq(schema.paymentAttempts.id, current.id),
        });
      }
      if (!current?.checkoutSessionId)
        throw new Error("Checkout Session binding is not yet available");
      const session = await retrieveSession(
        current.checkoutSessionId,
        decodeAttempt(current).route,
      );
      const result = await reconcileSession(current, session, db);
      if (result === "waiting_payment")
        await db
          .update(schema.paymentAttempts)
          .set({ nextRecoveryAt: new Date(Date.now() + 60000) })
          .where(eq(schema.paymentAttempts.id, current.id));
    } catch (err) {
      if (err instanceof PaymentContradictionError)
        await requirePaymentReview(attempt.id, "stripe_terms_contradiction", db);
      else
        await db
          .update(schema.paymentAttempts)
          .set({
            recoveryFailures: attempt.recoveryFailures + 1,
            nextRecoveryAt: retryAt(attempt.recoveryFailures + 1),
          })
          .where(eq(schema.paymentAttempts.id, attempt.id));
    }
  }
  const finalizations = await db.query.paymentAttempts.findMany({
    where: and(
      eq(schema.paymentAttempts.state, "fulfilled"),
      inArray(schema.paymentAttempts.finalizationState, ["pending", "running"]),
    ),
    limit,
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });
  for (const attempt of finalizations) await finalizePaymentBooking(attempt.id, db);
  return { events: events.length, attempts: attempts.length, finalizations: finalizations.length };
}
