import { jsonError, withUser } from "@/lib/server/http";
import { logger } from "@dayotter/core";
import { and, eq, getDb, inArray, schema, withResourceTransaction } from "@dayotter/db";
import { NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

const body = z.object({ noShow: z.boolean().default(true) });

/** Host marks a booking as a no-show (or reverts it to confirmed). Host-only. */
export const POST = withUser(async (u, request, ctx: { params: Promise<{ uid: string }> }) => {
  const { uid } = await ctx.params;
  const parsed = body.safeParse(await request.json().catch(() => ({})));
  const noShow = parsed.success ? parsed.data.noShow : true;

  const booking = await getDb().query.bookings.findFirst({
    where: eq(schema.bookings.uid, uid),
    columns: { id: true, hostId: true, status: true, endsAt: true },
  });
  if (!booking) return jsonError("Booking not found", 404);
  if (booking.hostId !== u.id) return jsonError("Not your booking", 403);
  if (booking.status === "cancelled") return jsonError("Booking was cancelled", 409);

  const changed = await withResourceTransaction(getDb(), async (tx) => {
    const candidate = await tx.query.bookings.findFirst({
      where: eq(schema.bookings.id, booking.id),
    });
    if (!candidate) return [];
    await tx
      .select()
      .from(schema.eventTypes)
      .where(eq(schema.eventTypes.id, candidate.eventTypeId))
      .for("share");
    const [current] = await tx
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.id, booking.id))
      .for("update");
    if (!current || current.hostId !== u.id) return [];
    // Compute revert from locked scheduling terms, including a concurrent move.
    const revertTo = current.endsAt < new Date() ? "completed" : "confirmed";
    // Conditional UPDATE cannot revive a concurrently cancelled/rejected row.
    return tx
      .update(schema.bookings)
      .set({ status: noShow ? "no_show" : revertTo })
      .where(
        and(
          eq(schema.bookings.id, booking.id),
          inArray(schema.bookings.status, ["confirmed", "completed", "no_show"]),
        ),
      )
      .returning({ id: schema.bookings.id });
  });
  if (!changed.length) return jsonError("Booking is no longer available", 409);

  logger.info("booking no-show updated", {
    event: "booking_no_show",
    bookingId: booking.id,
    noShow,
  });
  return NextResponse.json({ ok: true });
});
