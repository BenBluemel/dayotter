import { BookingError } from "@/lib/booking/booking-logic";
import { listPaidReview, resolvePaidReview } from "@/lib/payments/paid-review";
import { jsonError, withUser } from "@/lib/server/http";
import { NextResponse } from "next/server";
import { z } from "zod";
export const GET = withUser(async (user, request) => {
  const org = z.string().uuid().safeParse(new URL(request.url).searchParams.get("organizationId"));
  if (!org.success) return jsonError("Choose an organization", 400);
  try {
    return NextResponse.json({ obligations: await listPaidReview(org.data, user.id) });
  } catch (error) {
    if (error instanceof BookingError) return jsonError(error.message, error.status);
    throw error;
  }
});
export const POST = withUser(async (user, request) => {
  const input = z
    .object({
      id: z.string().uuid(),
      attemptId: z.string().uuid(),
      method: z.enum(["retry", "refund"]),
      evidence: z.string().trim().min(10).max(2000),
    })
    .strict()
    .safeParse(await request.json().catch(() => null));
  if (!input.success)
    return jsonError(
      "Provide the original payment, resolution request and customer contact/consent",
      400,
    );
  try {
    return NextResponse.json(await resolvePaidReview({ ...input.data, actorUserId: user.id }));
  } catch (error) {
    if (error instanceof BookingError) return jsonError(error.message, error.status);
    throw error;
  }
});
