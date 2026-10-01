import { checkoutRouteForOrganization } from "@/lib/payments/connect";
import { createCheckoutSession, paymentsEnabled } from "@/lib/payments/stripe";
import { PaymentRoutingError } from "@/lib/payments/routing";
import { env } from "@/lib/server/env";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { eq, getDb, schema } from "@dayotter/db";
import { NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ clientEmail: z.string().email() });

/**
 * Buy a session package. Creates a Stripe Checkout session; on payment the
 * webhook grants the client their credits (see webhooks/stripe). Public - a
 * client purchases against a host's public package.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!paymentsEnabled) return jsonError("Payments aren't enabled on this server.", 503);
  const { id } = await params;
  // Public + creates a Stripe Checkout object per call - throttle per IP+package.
  const limited = await enforceRateLimit(request, {
    name: "package-buy",
    limit: 10,
    windowSec: 600,
    key: `${id}`,
  });
  if (limited) return limited;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("A valid email is required", 400);

  const pkg = await getDb().query.sessionPackages.findFirst({
    where: eq(schema.sessionPackages.id, id),
  });
  if (!pkg || !pkg.isActive) return jsonError("Package not available", 404);
  if (pkg.priceAmount <= 0) return jsonError("This package isn't for sale", 400);

  // The service's actual organization selects the merchant; Connect uses its owner.
  const et = await getDb().query.eventTypes.findFirst({
    where: eq(schema.eventTypes.id, pkg.eventTypeId),
    columns: { ownerId: true, organizationId: true },
  });
  if (!et || et.organizationId !== pkg.organizationId) return jsonError("Package merchant is invalid", 403);

  try {
    const route = await checkoutRouteForOrganization(et.organizationId, et.ownerId, pkg.priceAmount);

    const appUrl = env.APP_URL;
    const session = await createCheckoutSession({
      amount: pkg.priceAmount,
      currency: pkg.currency,
      productName: `${pkg.name} - ${pkg.sessionCount} sessions`,
      successUrl: `${appUrl}/packages/thanks`,
      cancelUrl: `${appUrl}`,
      customerEmail: parsed.data.clientEmail,
      route,
      metadata: {
        kind: "package",
        packageId: pkg.id,
        organizationId: pkg.organizationId,
        eventTypeId: pkg.eventTypeId,
        clientEmail: parsed.data.clientEmail.toLowerCase(),
        totalCredits: String(pkg.sessionCount),
      },
    });

    return NextResponse.json({ checkoutUrl: session.url });
  } catch (err) {
    if (err instanceof PaymentRoutingError) return jsonError(err.message, err.status);
    throw err;
  }
}
