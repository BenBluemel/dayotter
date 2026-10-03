import { jsonError, withUser } from "@/lib/server/http";
import { and, eq, getDb, inArray, schema } from "@dayotter/db";
import { IANAZone } from "luxon";
import { NextResponse } from "next/server";
import { z } from "zod";

export const PATCH = withUser(async (user, request) => {
  const parsed = z
    .object({ organizationId: z.string().uuid(), businessTimezone: z.string().max(100) })
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success || !IANAZone.isValidZone(parsed.data.businessTimezone))
    return jsonError("Enter a valid timezone, such as America/Boise", 400);
  const member = await getDb().query.memberships.findFirst({
    where: and(
      eq(schema.memberships.userId, user.id),
      eq(schema.memberships.organizationId, parsed.data.organizationId),
      inArray(schema.memberships.role, ["owner", "admin"]),
    ),
  });
  if (!member) return jsonError("Not allowed to change this organization", 403);
  await getDb()
    .update(schema.organizations)
    .set({ businessTimezone: parsed.data.businessTimezone })
    .where(eq(schema.organizations.id, parsed.data.organizationId));
  return NextResponse.json({ businessTimezone: parsed.data.businessTimezone });
});
