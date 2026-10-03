import { randomUUID } from "node:crypto";
import { sha256hex } from "@dayotter/core";
import { type Database, and, eq, getDb, inArray, schema, sql } from "@dayotter/db";
import { BookingError } from "../booking/booking-logic";
import type { CreateBookingInput } from "../booking/create-booking";
import { appointmentRequestIdentity, canonicalJson } from "../payments/attempt-terms";

import { packageConfigurationSnapshot } from "./configuration-snapshot";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Reader = Pick<Database, "query" | "select">;

/** A session's internal user ID is supplied by the server. Contact email is never a credential. */
export async function requirePackageOwner(
  userId: string | undefined,
  email?: string,
  db: Reader = getDb(),
) {
  const user = userId
    ? await db.query.users.findFirst({ where: eq(schema.users.id, userId) })
    : null;
  if (!user?.emailVerified || (email && user.email.toLowerCase() !== email.toLowerCase()))
    throw new BookingError("Sign in with your verified account to use prepaid sessions", 403);
  return user;
}
export async function creditBalance(eventTypeId: string, ownerUserId: string, db = getDb()) {
  const [row] = await db
    .select({
      remaining: sql<number>`coalesce(sum(${schema.packageCredits.totalCredits} - ${schema.packageCredits.usedCredits}),0)`,
    })
    .from(schema.packageCredits)
    .where(
      and(
        eq(schema.packageCredits.eventTypeId, eventTypeId),
        eq(schema.packageCredits.ownerUserId, ownerUserId),
        eq(schema.packageCredits.integrityVersion, 1),
      ),
    );
  return Number(row?.remaining ?? 0);
}
export function creditBookingIdentity(input: CreateBookingInput) {
  if (!input.creditOwnerUserId)
    throw new BookingError("Prepaid session authorization is required", 403);
  const { creditOwnerUserId, creditRequestId, creditReturnPath, redeemCredit, ...intent } = input;
  // Shared with cash checkout so a concurrent balance/config change cannot settle one request twice.
  return appointmentRequestIdentity(intent, creditReturnPath ?? "/", creditRequestId);
}
export async function findCreditBooking(input: CreateBookingInput, db: Reader = getDb()) {
  const identity = creditBookingIdentity(input);
  const mutation = await db.query.packageCreditMutations.findFirst({
    where: eq(schema.packageCreditMutations.operationKey, identity.key),
  });
  if (!mutation) return null;
  if (
    mutation.kind !== "redemption" ||
    mutation.ownerUserId !== input.creditOwnerUserId ||
    mutation.requestFingerprint !== identity.fingerprint
  )
    throw new BookingError("Prepaid booking request was reused with different details", 409);
  const booking = await db.query.bookings.findFirst({
    where: eq(schema.bookings.id, mutation.bookingId!),
  });
  if (!booking) throw new BookingError("Prepaid booking requires reconciliation", 409);
  return booking;
}
/** Booking row and quote must already exist in this transaction. Ledger trigger owns counters. */
export async function redeemBookingCredit(
  tx: Transaction,
  input: CreateBookingInput,
  booking: typeof schema.bookings.$inferSelect,
) {
  const identity = creditBookingIdentity(input);
  const [credit] = await tx
    .select()
    .from(schema.packageCredits)
    .where(
      and(
        eq(schema.packageCredits.organizationId, booking.organizationId),
        eq(schema.packageCredits.eventTypeId, booking.eventTypeId),
        eq(schema.packageCredits.ownerUserId, input.creditOwnerUserId!),
        eq(schema.packageCredits.integrityVersion, 1),
        sql`${schema.packageCredits.usedCredits} < ${schema.packageCredits.totalCredits}`,
      ),
    )
    .orderBy(schema.packageCredits.createdAt, schema.packageCredits.id)
    .limit(1)
    .for("update");
  if (!credit) throw new BookingError("No prepaid session is available for this account", 402);
  await tx.insert(schema.packageCreditMutations).values({
    creditId: credit.id,
    ownerUserId: credit.ownerUserId!,
    organizationId: credit.organizationId,
    eventTypeId: credit.eventTypeId,
    kind: "redemption",
    quantity: 1,
    finalizationState: "pending",
    bookingId: booking.id,
    operationKey: identity.key,
    requestFingerprint: identity.fingerprint,
  });
  await tx
    .update(schema.bookings)
    .set({ paymentStatus: "paid" })
    .where(eq(schema.bookings.id, booking.id));
}
/** Runs inside the cancellation transaction after locking the booking. Never guesses a grant from attendees. */
export async function restoreBookingCredit(
  tx: Transaction,
  booking: typeof schema.bookings.$inferSelect,
) {
  const redemption = await tx.query.packageCreditMutations.findFirst({
    where: and(
      eq(schema.packageCreditMutations.bookingId, booking.id),
      eq(schema.packageCreditMutations.kind, "redemption"),
    ),
  });
  if (!redemption) return null; // Explicit legacy boundary; no historical provenance is invented.
  const existing = await tx.query.packageCreditMutations.findFirst({
    where: eq(schema.packageCreditMutations.reversesId, redemption.id),
  });
  if (redemption.finalizationState === "pending" || redemption.finalizationState === "running")
    await tx
      .update(schema.packageCreditMutations)
      .set({
        finalizationState: "requires_review",
        finalizationReviewCode: "cancelled_during_or_before_finalization",
      })
      .where(eq(schema.packageCreditMutations.id, redemption.id));
  if (!existing)
    await tx.insert(schema.packageCreditMutations).values({
      creditId: redemption.creditId,
      ownerUserId: redemption.ownerUserId,
      organizationId: redemption.organizationId,
      eventTypeId: redemption.eventTypeId,
      kind: "restoration",
      quantity: redemption.quantity,
      bookingId: booking.id,
      reversesId: redemption.id,
      operationKey: `package-restore:${redemption.id}`,
      requestFingerprint: redemption.requestFingerprint,
    });
  await tx
    .update(schema.bookings)
    .set({ paymentStatus: "refunded" })
    .where(eq(schema.bookings.id, booking.id));
  return redemption;
}
export interface CreditGrant {
  organizationId: string;
  eventTypeId: string;
  ownerUserId: string;
  clientEmail: string;
  totalCredits: number;
  packageId: string;
  operationKey: string;
  requestFingerprint?: string;
  actorUserId?: string;
  purchaseId?: string;
  stripePaymentIntentId?: string;
}
export async function grantCreditsInTransaction(input: CreditGrant, tx: Transaction) {
  const fingerprint = input.requestFingerprint ?? sha256hex(canonicalJson(input));
  const existing = await tx.query.packageCreditMutations.findFirst({
    where: eq(schema.packageCreditMutations.operationKey, input.operationKey),
  });
  if (existing) {
    if (existing.kind !== "grant" || existing.requestFingerprint !== fingerprint)
      throw new BookingError("Package grant requires reconciliation", 409);
    return existing.creditId;
  }
  const [credit] = await tx
    .insert(schema.packageCredits)
    .values({
      id: randomUUID(),
      organizationId: input.organizationId,
      eventTypeId: input.eventTypeId,
      ownerUserId: input.ownerUserId,
      integrityVersion: 1,
      clientEmail: input.clientEmail.toLowerCase(),
      totalCredits: 0,
      packageId: input.packageId,
      stripePaymentIntentId: input.stripePaymentIntentId,
    })
    .returning();
  await tx.insert(schema.packageCreditMutations).values({
    creditId: credit!.id,
    ownerUserId: input.ownerUserId,
    organizationId: input.organizationId,
    eventTypeId: input.eventTypeId,
    kind: "grant",
    quantity: input.totalCredits,
    operationKey: input.operationKey,
    requestFingerprint: fingerprint,
    actorUserId: input.actorUserId,
    purchaseId: input.purchaseId,
  });
  return credit!.id;
}
/** Trusted staff path: the service owner chooses a verified recipient, not an email-only entitlement. */
export async function grantPackageToCustomer(
  actorId: string,
  packageId: string,
  email: string,
  operationId: string,
  db: Database = getDb(),
) {
  const key = `package-manual:${actorId}:${operationId}`;
  const request = sha256hex(canonicalJson({ packageId, email: email.toLowerCase() }));
  return packageConfigurationSnapshot(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    const previous = await tx.query.packageCreditMutations.findFirst({
      where: eq(schema.packageCreditMutations.operationKey, key),
    });
    if (previous) {
      // Bind original caller input independently of today's package count/recipient email.
      if (previous.requestFingerprint !== request)
        throw new BookingError("Grant request was reused with different details", 409);
      return previous.creditId;
    }
    const [row] = await tx
      .select({ pkg: schema.sessionPackages, eventType: schema.eventTypes })
      .from(schema.sessionPackages)
      .innerJoin(schema.eventTypes, eq(schema.eventTypes.id, schema.sessionPackages.eventTypeId))
      .where(eq(schema.sessionPackages.id, packageId))
      .for("share");
    const pkg = row ? { ...row.pkg, eventType: row.eventType } : null;
    if (
      !pkg ||
      pkg.eventType.ownerId !== actorId ||
      pkg.eventType.organizationId !== pkg.organizationId
    )
      throw new BookingError("Package not found", 404);
    const recipients = await tx
      .select()
      .from(schema.users)
      .where(
        and(
          sql`lower(${schema.users.email}) = ${email.toLowerCase()}`,
          eq(schema.users.emailVerified, true),
        ),
      );
    if (recipients.length !== 1)
      throw new BookingError("Recipient needs a verified DayOtter account", 409);
    const creditId = await grantCreditsInTransaction(
      {
        organizationId: pkg.organizationId,
        eventTypeId: pkg.eventTypeId,
        ownerUserId: recipients[0]!.id,
        clientEmail: recipients[0]!.email,
        totalCredits: pkg.sessionCount,
        packageId: pkg.id,
        actorUserId: actorId,
        operationKey: key,
        requestFingerprint: request,
      },
      tx,
    );
    return creditId;
  });
}

/** External delivery is explicitly reviewable, never a reason to repeat financial settlement. */
export async function markCreditFinalization(
  bookingId: string,
  state: "running" | "complete" | "requires_review",
  db: Database = getDb(),
) {
  return db.transaction(async (tx) => {
    const [booking] = await tx
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.id, bookingId))
      .for("update");
    const mutation = await tx.query.packageCreditMutations.findFirst({
      where: and(
        eq(schema.packageCreditMutations.bookingId, bookingId),
        eq(schema.packageCreditMutations.kind, "redemption"),
      ),
    });
    if (
      !mutation ||
      mutation.finalizationState === "requires_review" ||
      mutation.finalizationState === "complete"
    )
      return false;
    const permitted =
      state === "running"
        ? mutation.finalizationState === "pending" && booking?.status === "confirmed"
        : state === "requires_review"
          ? ["pending", "running"].includes(mutation.finalizationState ?? "")
          : mutation.finalizationState === "running";
    if (!permitted) return false;
    await tx
      .update(schema.packageCreditMutations)
      .set({
        finalizationState: state,
        ...(state === "running" ? { finalizationStartedAt: new Date() } : {}),
        ...(state === "requires_review"
          ? { finalizationReviewCode: "external_finalization_incomplete" }
          : {}),
      })
      .where(eq(schema.packageCreditMutations.id, mutation.id));
    return true;
  });
}

export async function recoverCreditFinalizations(limit = 25, db: Database = getDb()) {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000);
  const rows = await db
    .select()
    .from(schema.packageCreditMutations)
    .where(
      and(
        eq(schema.packageCreditMutations.kind, "redemption"),
        inArray(schema.packageCreditMutations.finalizationState, ["pending", "running"]),
        sql`coalesce(${schema.packageCreditMutations.finalizationStartedAt},${schema.packageCreditMutations.createdAt}) < ${cutoff}`,
      ),
    )
    .orderBy(schema.packageCreditMutations.createdAt)
    .limit(Math.max(1, Math.min(100, limit)));
  for (const row of rows)
    await db.transaction(async (tx) => {
      await tx
        .select()
        .from(schema.bookings)
        .where(eq(schema.bookings.id, row.bookingId!))
        .for("update");
      await tx
        .update(schema.packageCreditMutations)
        .set({
          finalizationState: "requires_review",
          finalizationReviewCode: "interrupted_credit_finalization",
        })
        .where(
          and(
            eq(schema.packageCreditMutations.id, row.id),
            inArray(schema.packageCreditMutations.finalizationState, ["pending", "running"]),
            sql`coalesce(${schema.packageCreditMutations.finalizationStartedAt},${schema.packageCreditMutations.createdAt}) < ${cutoff}`,
          ),
        );
    });
  return { creditFinalizations: rows.length };
}
