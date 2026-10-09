import { BookingError } from "@/lib/booking/booking-logic";
import { grantPackageToCustomer } from "@/lib/packages/credits";
import { jsonError, withUser } from "@/lib/server/http";
import { NextResponse } from "next/server";
import { z } from "zod";
export const dynamic = "force-dynamic";
const bodySchema = z.object({
  packageId: z.string().uuid(),
  clientEmail: z.string().email(),
  operationId: z
    .string()
    .min(16)
    .max(100)
    .regex(/^[A-Za-z0-9:_-]+$/),
});
export const POST = withUser(async (user, request) => {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Check the details and grant request ID", 400);
  try {
    await grantPackageToCustomer(
      user.id,
      parsed.data.packageId,
      parsed.data.clientEmail,
      parsed.data.operationId,
    );
  } catch (err) {
    if (err instanceof BookingError) return jsonError(err.message, err.status);
    throw err;
  }
  return NextResponse.json({ ok: true });
});
