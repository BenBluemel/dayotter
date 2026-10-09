import { randomUUID } from "node:crypto";
import { encryptJson, sha256hex } from "@dayotter/core";
import { type Database, and, classifyResourceError, eq, getDb, schema, sql } from "@dayotter/db";
import type Stripe from "stripe";
import { BookingError, mapInsertError } from "../booking/booking-logic";
import { reserveCouponUse } from "../booking/coupon-uses";
import { releaseTerminalCouponReservation } from "../booking/coupon-uses";
import type { CreateBookingInput } from "../booking/create-booking";
import { quoteAppointmentPrice } from "../booking/pricing";
import {
  captureSchedulingPlan,
  lockServiceAdmission,
  rejectManagedRecurrence,
} from "../booking/resource-acceptance";
import { env } from "../server/env";
import {
  CHECKOUT_LIFETIME_SECONDS,
  CREATION_RETRY_SECONDS,
  type PaymentAttempt,
  appointmentRequestIdentity,
  canonicalJson,
  decodeAttempt,
  mayCreateSession,
  validateAttemptSession,
} from "./attempt-terms";
import { checkoutRouteForOrganization } from "./connect";
import { PaymentRoutingError } from "./routing";
import { createCheckoutSession, retrieveSession } from "./stripe";

export async function findAppointmentAttempt(
  input: CreateBookingInput,
  returnPath: string,
  requestId?: string,
  db: Pick<Database, "query"> = getDb(),
) {
  const identity = appointmentRequestIdentity(input, returnPath, requestId);
  const attempt = await db.query.paymentAttempts.findFirst({
    where: eq(schema.paymentAttempts.requestKey, identity.key),
  });
  if (attempt && attempt.requestFingerprint !== identity.fingerprint)
    throw new BookingError(
      "Checkout request identity was reused with different booking input",
      409,
    );
  if (attempt) decodeAttempt(attempt);
  return attempt;
}

/** Only database work is retried here, never a Stripe request with newly computed parameters. */
export async function prepareAppointmentAttempt(
  input: CreateBookingInput,
  returnPath: string,
  requestId?: string,
  db: Database = getDb(),
) {
  const identity = appointmentRequestIdentity(input, returnPath, requestId);
  for (let retry = 0; ; retry++) {
    try {
      return await db.transaction(
        async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${identity.key}))`);
          const existing = await findAppointmentAttempt(input, returnPath, requestId, tx);
          if (existing)
            return {
              attempt: existing,
              quote: decodeAttempt(existing).quote,
              durationMinutes: decodeAttempt(existing).resolvedDurationMinutes,
            };
          // Coupon capacity uses a locked definition row and READ COMMITTED count.
          // Hold the service row too so its price/owner cannot change mid-prepare.
          const event = await lockServiceAdmission(tx, input.eventTypeId);
          rejectManagedRecurrence(event, event.recurringCount > 1);
          if (!event?.isActive) throw new BookingError("Event type not found", 404);
          const quote = await quoteAppointmentPrice(
            {
              organizationId: event.organizationId,
              eventTypeId: event.id,
              appointmentStartsAt: new Date(input.start),
              settlement: "cash",
              couponCode: input.couponCode,
              couponCustomerUserId: input.couponCustomerUserId,
            },
            tx,
          );
          if (
            (event.recurringCount ?? 1) > 1 &&
            ((event.maxAttendees ?? 1) <= 1 || !event.ownerId) &&
            quote.basePrice > 0
          )
            throw new BookingError("Commercial recurring checkout is not supported yet", 409);
          const options = event.durationOptions ?? [];
          const durationMinutes =
            input.durationMinutes &&
            (options.length
              ? options.includes(input.durationMinutes)
              : input.durationMinutes === event.durationMinutes)
              ? input.durationMinutes
              : event.durationMinutes;
          const schedulingPlan = await captureSchedulingPlan(
            tx,
            event,
            durationMinutes,
            event.ownerId!,
          );
          if (quote.amountToCollect === 0) return { quote, attempt: null, durationMinutes };
          const route = await checkoutRouteForOrganization(
            event.organizationId,
            event.ownerId,
            quote.amountToCollect,
            tx,
          );
          const createdAt = new Date(Math.floor(Date.now() / 1000) * 1000);
          const [attempt] = await tx
            .insert(schema.paymentAttempts)
            .values({
              id: randomUUID(),
              requestKey: identity.key,
              requestFingerprint: identity.fingerprint,
              organizationId: quote.organizationId,
              eventTypeId: quote.eventTypeId,
              bookingIntent: encryptJson({
                input,
                returnPath,
                resolvedDurationMinutes: durationMinutes,
              }),
              quote,
              quoteHash: sha256hex(canonicalJson(quote)),
              schedulingPlan,
              schedulingDurationMinutes: schedulingPlan ? durationMinutes : null,
              amount: quote.amountToCollect,
              currency: quote.currency,
              paymentMode: route.mode,
              environment: route.environment,
              chargeAccountId: route.chargeAccountId,
              credentialContext: route.credentialContext,
              destinationAccountId: route.mode === "connect" ? route.destinationAccountId : null,
              applicationFeeAmount: route.mode === "connect" ? route.applicationFeeAmount : 0,
              productName: event.title,
              successUrl: `${env.APP_URL}/booking/paid?session_id={CHECKOUT_SESSION_ID}`,
              cancelUrl: `${env.APP_URL}${returnPath}`,
              createdAt,
              expiresAt: new Date(createdAt.getTime() + CHECKOUT_LIFETIME_SECONDS * 1000),
              creationDeadline: new Date(createdAt.getTime() + CREATION_RETRY_SECONDS * 1000),
            })
            .returning();
          if (!attempt) throw new PaymentRoutingError("Could not save checkout intent");
          if (quote.coupon)
            await reserveCouponUse(
              tx,
              quote,
              input.couponCustomerUserId!,
              identity.key,
              identity.fingerprint,
              { attemptId: attempt.id, expiresAt: attempt.expiresAt },
            );
          decodeAttempt(attempt);
          return { attempt, quote, durationMinutes };
        },
        { isolationLevel: input.couponCode ? "read committed" : "repeatable read" },
      );
    } catch (err) {
      const failure = err as {
        code?: string;
        constraint?: string;
        cause?: { code?: string; constraint?: string };
      };
      const detail = failure.cause ?? failure;
      if (detail.constraint === "booking_settlement_claim_conflict")
        throw new BookingError(
          "This booking request already has a settlement; retry the original request",
          409,
        );
      if (
        retry < 2 &&
        (classifyResourceError(err)?.category === "transient" ||
          (detail.code === "23505" && detail.constraint === "payment_attempt_request_key_idx"))
      )
        continue;
      if (classifyResourceError(err)) mapInsertError(err);
      throw err;
    }
  }
}

/** Allows response-loss recovery, including a webhook racing the creation response. */
export async function bindAttemptSession(
  attempt: PaymentAttempt,
  session: Stripe.Checkout.Session,
  db = getDb(),
) {
  validateAttemptSession(attempt, session);
  const updated = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(schema.paymentAttempts)
      .where(eq(schema.paymentAttempts.id, attempt.id))
      .for("update");
    if (!current) throw new PaymentRoutingError("Checkout intent is missing");
    const pi = validateAttemptSession(current, session);
    const state = !["prepared", "open"].includes(current.state)
      ? current.state
      : session.status === "expired"
        ? "expired"
        : "open";
    const [updated] = await tx
      .update(schema.paymentAttempts)
      .set({
        checkoutSessionId: session.id,
        checkoutUrl: current.checkoutUrl ?? session.url,
        paymentIntentId: pi,
        state,
      })
      .where(eq(schema.paymentAttempts.id, current.id))
      .returning();
    return updated!;
  });
  if (updated.state === "expired") await releaseTerminalCouponReservation(updated.id, db);
  return updated;
}

export async function appointmentCheckout(attempt: PaymentAttempt) {
  const terms = decodeAttempt(attempt);
  if (attempt.state === "requires_review")
    throw new BookingError("This checkout requires payment reconciliation", 409);
  if (attempt.state === "fulfilled" && attempt.bookingId) {
    const booking = await getDb().query.bookings.findFirst({
      where: eq(schema.bookings.id, attempt.bookingId),
    });
    if (!booking) throw new PaymentRoutingError("Paid booking reference is missing");
    return { uid: booking.uid, url: `/booking/${booking.uid}`, redirectUrl: null };
  }
  if (attempt.state === "expired")
    throw new BookingError("Checkout expired; start a new booking operation", 410);
  if (attempt.checkoutSessionId) {
    const session = await retrieveSession(attempt.checkoutSessionId, terms.route);
    await bindAttemptSession(attempt, session);
    if (session.status === "expired")
      throw new BookingError("Checkout expired; start a new booking operation", 410);
    if (session.status !== "open" || !session.url)
      throw new BookingError("Payment processing is already in progress", 409);
    return { checkoutUrl: session.url };
  }
  if (!mayCreateSession(attempt)) {
    await getDb()
      .update(schema.paymentAttempts)
      .set({ state: "requires_review", reviewCode: "creation_ambiguous" })
      .where(
        and(
          eq(schema.paymentAttempts.id, attempt.id),
          eq(schema.paymentAttempts.state, "prepared"),
        ),
      )
      .returning();
    throw new BookingError("Checkout creation is ambiguous; reconciliation is required", 409);
  }
  // New/replayed creation must still pass Slice 1's current configuration check.
  // A mode/account/fee change rejects creation rather than rewriting saved terms.
  const response = await createCheckoutSession({
    amount: attempt.amount,
    currency: attempt.currency,
    productName: attempt.productName,
    successUrl: attempt.successUrl,
    cancelUrl: attempt.cancelUrl,
    customerEmail: terms.input.attendee.email,
    route: terms.route,
    metadata: { attemptId: attempt.id, quoteHash: attempt.quoteHash },
    idempotencyKey: `appointment-checkout:${attempt.id}:v1`,
    expiresAt: Math.floor(attempt.expiresAt.getTime() / 1000),
    clientReferenceId: attempt.id,
  });
  const saved = await bindAttemptSession(attempt, response.session);
  if (saved.state === "fulfilled") return appointmentCheckout(saved);
  if (!response.url) throw new PaymentRoutingError("Stripe returned no checkout URL");
  return { checkoutUrl: response.url };
}
