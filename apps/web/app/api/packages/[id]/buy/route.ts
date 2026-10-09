import { BookingError } from "@/lib/booking/booking-logic";
import { requirePackageOwner } from "@/lib/packages/credits";
import { packageCheckout, preparePackagePurchase } from "@/lib/packages/purchases";
import { PaymentRoutingError } from "@/lib/payments/routing";
import { paymentsEnabled } from "@/lib/payments/stripe";
import { jsonError, withUser } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { NextResponse } from "next/server";
import { z } from "zod";
export const dynamic = "force-dynamic";
const bodySchema = z.object({
  requestId: z.string().uuid(),
  clientEmail: z.string().email().optional(),
});
/** Package ownership is established before payment, using authenticated internal identity. */
export const POST = withUser<{ params: Promise<{ id: string }> }>(
  async (user, request, { params }) => {
    if (!paymentsEnabled) return jsonError("Payments aren't enabled on this server.", 503);
    const { id } = await params;
    const limited = await enforceRateLimit(request, {
      name: "package-buy",
      limit: 10,
      windowSec: 600,
      key: id,
    });
    if (limited) return limited;
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("A stable purchase request ID is required", 400);
    try {
      await requirePackageOwner(user.id, parsed.data.clientEmail);
      const purchase = await preparePackagePurchase(id, user.id, parsed.data.requestId);
      return NextResponse.json(await packageCheckout(purchase));
    } catch (err) {
      if (err instanceof BookingError || err instanceof PaymentRoutingError)
        return jsonError(err.message, err.status);
      return jsonError("Package checkout is temporarily unavailable; retry this request", 502);
    }
  },
);
