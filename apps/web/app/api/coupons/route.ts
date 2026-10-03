import { couponCalendarWindow } from "@/lib/booking/coupon-dates";
import { jsonError, withUser } from "@/lib/server/http";
import { normalizeCouponCode } from "@dayotter/core";
import { and, eq, getDb, inArray, schema } from "@dayotter/db";
import { NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
const payload = z.object({
  id: z.string().uuid().optional(),
  organizationId: z.string().uuid(),
  code: z.string().min(1).max(64),
  label: z.string().trim().max(120).nullable(),
  isActive: z.boolean(),
  discountKind: z.enum(["percentage", "fixed"]),
  discountValue: z.number().int().positive(),
  currency: z
    .string()
    .regex(/^[a-z]{3}$/)
    .nullable(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  minimumBasePrice: z.number().int().nonnegative().nullable(),
  globalLimit: z.number().int().positive().nullable(),
  perCustomerLimit: z.number().int().positive().nullable(),
  eventTypeIds: z.array(z.string().uuid()).min(1).max(100),
});

async function manageable(userId: string, organizationId: string) {
  return getDb().query.memberships.findFirst({
    where: and(
      eq(schema.memberships.userId, userId),
      eq(schema.memberships.organizationId, organizationId),
      inArray(schema.memberships.role, ["owner", "admin"]),
    ),
  });
}

export const GET = withUser(async (user, request) => {
  const organizationId = new URL(request.url).searchParams.get("organizationId");
  if (!organizationId || !z.string().uuid().safeParse(organizationId).success)
    return jsonError("Choose an organization", 400);
  if (!(await manageable(user.id, organizationId)))
    return jsonError("Not allowed to manage coupons", 403);
  const db = getDb();
  const [coupons, uses] = await Promise.all([
    db.query.appointmentCoupons.findMany({
      where: eq(schema.appointmentCoupons.organizationId, organizationId),
      orderBy: (c, { desc }) => desc(c.createdAt),
    }),
    db.query.appointmentCouponUses.findMany({
      where: eq(schema.appointmentCouponUses.organizationId, organizationId),
      columns: { couponId: true, status: true },
    }),
  ]);
  const links = await db.query.appointmentCouponEventTypes.findMany({
    where: eq(schema.appointmentCouponEventTypes.organizationId, organizationId),
  });
  return NextResponse.json({
    coupons: coupons.map((c) => ({
      ...c,
      eventTypeIds: links.filter((l) => l.couponId === c.id).map((l) => l.eventTypeId),
      consumed: uses.filter((u) => u.couponId === c.id && u.status === "redeemed").length,
      reserved: uses.filter((u) => u.couponId === c.id && u.status === "reserved").length,
    })),
  });
});

async function save(userId: string, request: Request, edit: boolean) {
  const parsed = payload.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Check the coupon details and limits", 400);
  const d = parsed.data;
  if ((edit && !d.id) || (!edit && d.id)) return jsonError("Invalid coupon operation", 400);
  const code = normalizeCouponCode(d.code);
  if (!/^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(code))
    return jsonError("Use letters, numbers, dashes or underscores for the code", 400);
  if (d.discountKind === "percentage" && (d.discountValue > 10000 || d.currency))
    return jsonError("Percentage must be between 0.01% and 100%", 400);
  if (d.discountKind === "fixed" && (!d.currency || d.discountValue > 2147483647))
    return jsonError("Enter a fixed amount and currency", 400);
  if (d.minimumBasePrice != null && d.minimumBasePrice > 2147483647)
    return jsonError("Minimum purchase is too large", 400);
  if (!(await manageable(userId, d.organizationId)))
    return jsonError("Not allowed to manage coupons", 403);
  const db = getDb();
  const org = await db.query.organizations.findFirst({
    where: eq(schema.organizations.id, d.organizationId),
  });
  if (!org) return jsonError("Organization not found", 404);
  let window: ReturnType<typeof couponCalendarWindow>;
  try {
    window = couponCalendarWindow(d.startDate, d.endDate, org.businessTimezone);
  } catch {
    return jsonError("Check the appointment dates and business timezone", 400);
  }
  const ids = [...new Set(d.eventTypeIds)];
  const services = await db.query.eventTypes.findMany({
    where: and(
      inArray(schema.eventTypes.id, ids),
      eq(schema.eventTypes.organizationId, d.organizationId),
    ),
  });
  if (services.length !== ids.length) return jsonError("Choose services in this organization", 400);
  if (d.discountKind === "fixed" && services.some((s) => (s.currency ?? "usd") !== d.currency))
    return jsonError("Selected services must use the coupon currency", 400);
  if (d.minimumBasePrice != null && new Set(services.map((s) => s.currency ?? "usd")).size > 1)
    return jsonError("Choose services with one currency for a minimum purchase", 400);
  try {
    const coupon = await db.transaction(async (tx) => {
      let saved: typeof schema.appointmentCoupons.$inferSelect | undefined;
      const values = {
        code,
        label: d.label || null,
        isActive: d.isActive,
        discountKind: d.discountKind,
        discountValue: d.discountValue,
        currency: d.currency,
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        validityTimezone: org.businessTimezone,
        minimumBasePrice: d.minimumBasePrice,
        globalLimit: d.globalLimit,
        perCustomerLimit: d.perCustomerLimit,
        updatedAt: new Date(),
      };
      if (edit) {
        [saved] = await tx
          .update(schema.appointmentCoupons)
          .set(values)
          .where(
            and(
              eq(schema.appointmentCoupons.id, d.id!),
              eq(schema.appointmentCoupons.organizationId, d.organizationId),
            ),
          )
          .returning();
        if (!saved) return null;
        await tx
          .delete(schema.appointmentCouponEventTypes)
          .where(eq(schema.appointmentCouponEventTypes.couponId, saved.id));
      } else {
        [saved] = await tx
          .insert(schema.appointmentCoupons)
          .values({ ...values, organizationId: d.organizationId })
          .returning();
      }
      await tx.insert(schema.appointmentCouponEventTypes).values(
        ids.map((eventTypeId) => ({
          couponId: saved!.id,
          eventTypeId,
          organizationId: d.organizationId,
        })),
      );
      return saved;
    });
    return coupon
      ? NextResponse.json({ coupon }, { status: edit ? 200 : 201 })
      : jsonError("Coupon not found", 404);
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "23505")
      return jsonError("That coupon code is already in use", 409);
    return jsonError("Could not save coupon; check its details", 400);
  }
}
export const POST = withUser((u, req) => save(u.id, req, false));
export const PATCH = withUser((u, req) => save(u.id, req, true));
