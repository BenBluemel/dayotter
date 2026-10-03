import { getSession } from "@/lib/auth/session";
import { BookingError } from "@/lib/booking/booking-logic";
import { couponCapacityMessage } from "@/lib/booking/coupon-uses";
import { quoteAppointmentPrice } from "@/lib/booking/pricing";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { eq, getDb, schema } from "@dayotter/db";
import { NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
const requestSchema = z.object({
  eventTypeId: z.string().uuid(),
  start: z.string().datetime({ offset: true }),
  couponCode: z.string().trim().min(1).max(64).optional(),
});
export async function POST(request: Request) {
  const limited = await enforceRateLimit(request, {
    name: "coupon-preview",
    limit: 30,
    windowSec: 600,
  });
  if (limited) return limited;
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: "Choose an appointment and enter a valid code" },
      { status: 400 },
    );
  const session = await getSession();
  if (parsed.data.couponCode && !session?.user?.id)
    return NextResponse.json({ error: "Sign in to use a coupon" }, { status: 401 });
  const service = await getDb().query.eventTypes.findFirst({
    where: eq(schema.eventTypes.id, parsed.data.eventTypeId),
    columns: { id: true, organizationId: true, isActive: true },
  });
  if (!service?.isActive) return NextResponse.json({ error: "Service not found" }, { status: 404 });
  try {
    const quote = await quoteAppointmentPrice({
      organizationId: service.organizationId,
      eventTypeId: service.id,
      appointmentStartsAt: new Date(parsed.data.start),
      settlement: "cash",
      couponCode: parsed.data.couponCode,
      couponCustomerUserId: session?.user?.id,
    });
    if (quote.coupon && session?.user?.id) {
      const unavailable = await couponCapacityMessage(quote, session.user.id);
      if (unavailable) return NextResponse.json({ error: unavailable }, { status: 409 });
    }
    const couponResult = !parsed.data.couponCode
      ? "none"
      : quote.coupon
        ? "applied"
        : quote.promotion
          ? "promotion_preferred"
          : "none";
    return NextResponse.json({
      quote: {
        basePrice: quote.basePrice,
        effectivePrice: quote.effectivePrice,
        amountToCollect: quote.amountToCollect,
        currency: quote.currency,
        promotionLabel: quote.promotion?.label ?? null,
        couponCode: quote.coupon?.code ?? null,
        couponResult,
      },
    });
  } catch (error) {
    if (error instanceof BookingError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "Could not check this price" }, { status: 500 });
  }
}
