import { decryptJson, encryptJson, logger } from "@dayotter/core";
import { type Database, and, eq, getDb, schema } from "@dayotter/db";
import { type FinalizeContext, finalizeConfirmedBooking } from "../booking/finalize-booking";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Booking truth and discoverable ancillary work commit together. */
export async function bindPaidBooking(
  tx: Transaction,
  attemptId: string,
  context: FinalizeContext,
) {
  await tx
    .update(schema.paymentAttempts)
    .set({
      state: "fulfilled",
      bookingId: context.booking.id,
      finalizationContext: encryptJson(context),
      finalizationState: "pending",
    })
    .where(eq(schema.paymentAttempts.id, attemptId));
}

/** The existing finalizer is best effort, not an exactly-once external-effects API.
 * Never replay an interrupted invocation blindly: the provider may have accepted it.
 * `attempted` records invocation, not proof of calendar/email/queue delivery. */
export async function finalizePaymentBooking(attemptId: string, db: Database = getDb()) {
  const attempt = await db.query.paymentAttempts.findFirst({
    where: eq(schema.paymentAttempts.id, attemptId),
  });
  if (!attempt?.bookingId || !attempt.finalizationContext || !attempt.finalizationState) return;
  if (["attempted", "requires_review"].includes(attempt.finalizationState)) return;
  const review = async (code: string) => {
    await db
      .update(schema.paymentAttempts)
      .set({ finalizationState: "requires_review", finalizationReviewCode: code })
      .where(
        and(
          eq(schema.paymentAttempts.id, attempt.id),
          eq(schema.paymentAttempts.finalizationState, attempt.finalizationState!),
        ),
      );
    logger.warn("paid booking finalization requires review", {
      event: "payment_finalization_review",
      attemptId,
      code,
    });
  };
  if (attempt.finalizationState === "running") {
    // A concurrent caller must not mistake an active invocation for a crash.
    if (
      !attempt.finalizationStartedAt ||
      Date.now() - attempt.finalizationStartedAt.getTime() < 10 * 60 * 1000
    )
      return;
    await review("interrupted_finalization_ambiguous");
    return;
  }
  let ownsInvocation = false;
  try {
    const context = decryptJson<FinalizeContext>(attempt.finalizationContext);
    context.booking.startsAt = new Date(context.booking.startsAt);
    context.booking.endsAt = new Date(context.booking.endsAt);
    const current = await db.query.bookings.findFirst({
      where: eq(schema.bookings.id, attempt.bookingId),
    });
    if (
      !current ||
      current.id !== context.booking.id ||
      current.paymentIntentId !== attempt.paymentIntentId ||
      current.status !== "confirmed" ||
      current.startsAt.getTime() !== context.booking.startsAt.getTime() ||
      current.endsAt.getTime() !== context.booking.endsAt.getTime()
    ) {
      await review("booking_changed_before_finalization");
      return;
    }
    const claimed = await db
      .update(schema.paymentAttempts)
      .set({ finalizationState: "running", finalizationStartedAt: new Date() })
      .where(
        and(
          eq(schema.paymentAttempts.id, attempt.id),
          eq(schema.paymentAttempts.finalizationState, "pending"),
        ),
      )
      .returning();
    if (!claimed.length) return;
    ownsInvocation = true;
    await finalizeConfirmedBooking(context);
    await db
      .update(schema.paymentAttempts)
      .set({ finalizationState: "attempted" })
      .where(
        and(
          eq(schema.paymentAttempts.id, attempt.id),
          eq(schema.paymentAttempts.finalizationState, "running"),
        ),
      );
  } catch {
    // No refund, booking deletion, or whole-finalizer retry on an uncertain effect.
    await db
      .update(schema.paymentAttempts)
      .set({
        finalizationState: "requires_review",
        finalizationReviewCode: "finalization_failed_or_ambiguous",
      })
      .where(
        and(
          eq(schema.paymentAttempts.id, attempt.id),
          eq(schema.paymentAttempts.finalizationState, ownsInvocation ? "running" : "pending"),
        ),
      );
  }
}
