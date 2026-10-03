import { getSession } from "@/lib/auth/session";
import { BookingError, type CreateBookingInput, createBooking } from "@/lib/booking/create-booking";
import { findZeroCashBooking } from "@/lib/booking/zero-cash";
import { creditBalance, findCreditBooking, requirePackageOwner } from "@/lib/packages/credits";
import {
  appointmentCheckout,
  findAppointmentAttempt,
  prepareAppointmentAttempt,
} from "@/lib/payments/attempts";
import { PaymentRoutingError } from "@/lib/payments/routing";
import { clientIp, enforceRateLimit, verifyCaptcha } from "@/lib/server/rate-limit";
import { normalizeCouponCode } from "@dayotter/core";
import { schema as db, eq, getDb } from "@dayotter/db";
import { NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.object({
  eventTypeId: z.string().uuid(),
  start: z.string().datetime(),
  attendee: z.object({
    name: z.string().min(1).max(120),
    email: z.string().email(),
    timezone: z.string().min(1),
  }),
  guests: z.array(z.string().email()).max(10).optional(),
  /** Collective member-selection: chosen team host user ids (server re-validates). */
  selectedHostIds: z.array(z.string().uuid()).max(50).optional(),
  notes: z.string().max(2000).optional(),
  // Intake answers, keyed by question id. Bounded so an unauthenticated caller
  // can't persist a multi-MB blob into bookings.responses: at most 50 answers,
  // each a short string / boolean / small string[] (matches BookingQuestion types).
  responses: z
    .record(
      z.string().max(64),
      z.union([z.string().max(5000), z.boolean(), z.array(z.string().max(500)).max(50)]),
    )
    .refine((r) => Object.keys(r).length <= 50, { message: "Too many responses" })
    .optional(),
  durationMinutes: z.number().int().min(5).max(1440).optional(),
  /** Chosen location type for multi-location event types (validated server-side). */
  location: z.string().max(32).nullish(),
  captchaToken: z.string().max(4000).optional(),
  /** Single-use booking-link token, if the booker came through one. */
  linkToken: z.string().max(64).optional(),
  /** Access code for a password-protected event type. */
  accessCode: z.string().max(64).optional(),
  /** Where to send the booker if they abandon Stripe Checkout. */
  returnPath: z.string().max(400).optional(),
  /** Stable browser operation identity; its booking input is bound on first use. */
  redeemCredit: z.boolean().optional(),
  checkoutRequestId: z.string().uuid().optional(),
  couponCode: z.string().trim().min(1).max(64).optional(),
});

export async function POST(request: Request) {
  // Creating a booking is expensive (availability recompute, calendar write,
  // emails) - throttle hard per IP and require captcha when enabled.
  const limited = await enforceRateLimit(request, { name: "book", limit: 10, windowSec: 600 });
  if (limited) return limited;

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  if (!(await verifyCaptcha(parsed.data.captchaToken, clientIp(request)))) {
    return NextResponse.json({ error: "Captcha verification failed" }, { status: 400 });
  }

  // Extra per-attendee cooldown: block hammering the same event with one email.
  const cooldown = await enforceRateLimit(request, {
    name: "book-attendee",
    limit: 5,
    windowSec: 600,
    key: `${parsed.data.eventTypeId}:${parsed.data.attendee.email.toLowerCase()}`,
  });
  if (cooldown) return cooldown;

  const couponSession = parsed.data.couponCode ? await getSession() : null;
  if (parsed.data.couponCode && !couponSession?.user?.id)
    return NextResponse.json({ error: "Sign in to use a coupon" }, { status: 401 });
  if (parsed.data.couponCode && parsed.data.redeemCredit)
    return NextResponse.json(
      { error: "Choose either a coupon or a prepaid session" },
      { status: 400 },
    );
  const input: CreateBookingInput = {
    eventTypeId: parsed.data.eventTypeId,
    start: parsed.data.start,
    attendee: parsed.data.attendee,
    guests: parsed.data.guests,
    selectedHostIds: parsed.data.selectedHostIds,
    notes: parsed.data.notes,
    responses: parsed.data.responses,
    durationMinutes: parsed.data.durationMinutes,
    location: parsed.data.location ?? undefined,
    linkToken: parsed.data.linkToken,
    accessCode: parsed.data.accessCode,
    couponCode: parsed.data.couponCode ? normalizeCouponCode(parsed.data.couponCode) : undefined,
    couponCustomerUserId: parsed.data.couponCode ? couponSession!.user.id : undefined,
  };

  const requestedPath = parsed.data.returnPath;
  const returnPath =
    requestedPath?.startsWith("/") && !requestedPath.startsWith("//") ? requestedPath : "/";
  try {
    const zeroInput = {
      ...input,
      bookingRequestId: parsed.data.checkoutRequestId,
      bookingReturnPath: returnPath,
    };
    const previousZero = await findZeroCashBooking(zeroInput);
    if (previousZero)
      return NextResponse.json({
        uid: previousZero.uid,
        url: `/booking/${previousZero.uid}`,
        redirectUrl: null,
      });
    const session = couponSession ?? (await getSession());
    let ownerId: string | undefined;
    if (session?.user?.id) {
      try {
        ownerId = (await requirePackageOwner(session.user.id, input.attendee.email)).id;
      } catch (err) {
        if (parsed.data.redeemCredit) throw err;
      }
    }
    if (parsed.data.redeemCredit && !ownerId) await requirePackageOwner(undefined);
    const creditInput = {
      ...input,
      redeemCredit: true,
      creditOwnerUserId: ownerId,
      creditRequestId: parsed.data.checkoutRequestId,
      creditReturnPath: returnPath,
    };
    if (ownerId) {
      const previousCredit = await findCreditBooking(creditInput);
      if (previousCredit)
        return NextResponse.json({
          uid: previousCredit.uid,
          url: `/booking/${previousCredit.uid}`,
          redirectUrl: null,
        });
    }
    // Resume an existing cash operation before consulting mutable prices or credits.
    const previous = await findAppointmentAttempt(input, returnPath, parsed.data.checkoutRequestId);
    if (previous) return NextResponse.json(await appointmentCheckout(previous));
    const et = await getDb().query.eventTypes.findFirst({
      where: eq(db.eventTypes.id, input.eventTypeId),
      columns: { price: true, isActive: true },
    });
    if (
      !input.couponCode &&
      ownerId &&
      et?.isActive &&
      ((et.price ?? 0) > 0 || parsed.data.redeemCredit)
    ) {
      const credits = await creditBalance(input.eventTypeId, ownerId);
      if (credits > 0) {
        const { uid, redirectUrl } = await createBooking(creditInput);
        return NextResponse.json({ uid, url: `/booking/${uid}`, redirectUrl });
      }
    }
    if (parsed.data.redeemCredit)
      throw new BookingError("No prepaid session is available for this account", 402);
    const prepared = await prepareAppointmentAttempt(
      input,
      returnPath,
      parsed.data.checkoutRequestId,
    );
    if (prepared.attempt) {
      const checkout = await appointmentCheckout(prepared.attempt);
      await getDb()
        .insert(db.bookingPageViews)
        .values({ eventTypeId: input.eventTypeId, kind: "checkout" })
        .catch(() => {});
      return NextResponse.json(checkout);
    }
    // Zero-cash quotes do not create a Stripe Session. Preserve existing approval policy.
    const { uid, redirectUrl } = await createBooking({
      ...zeroInput,
      quotedDurationMinutes: prepared.durationMinutes,
    });
    return NextResponse.json({ uid, url: `/booking/${uid}`, redirectUrl });
  } catch (err) {
    if (err instanceof BookingError || err instanceof PaymentRoutingError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    console.error("[api/book] checkout error:", err);
    return NextResponse.json({ error: "Couldn't start booking checkout" }, { status: 502 });
  }
}
