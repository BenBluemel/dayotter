import { CouponsManager } from "@/components/coupons-manager";
import { getSession } from "@/lib/auth/session";
import { eq, getDb, inArray, schema } from "@dayotter/db";

export const dynamic = "force-dynamic";
export default async function CouponsSettingsPage() {
  const session = await getSession();
  const db = getDb();
  const memberships = await db.query.memberships.findMany({
    where: eq(schema.memberships.userId, session!.user.id),
  });
  const ids = memberships
    .filter((m) => m.role === "owner" || m.role === "admin")
    .map((m) => m.organizationId);
  if (!ids.length) return <p>Only organization owners and admins can manage coupons.</p>;
  const [orgs, services] = await Promise.all([
    db.query.organizations.findMany({
      where: inArray(schema.organizations.id, ids),
      columns: { id: true, name: true, businessTimezone: true },
    }),
    db.query.eventTypes.findMany({
      where: inArray(schema.eventTypes.organizationId, ids),
      columns: { id: true, organizationId: true, title: true, currency: true, isActive: true },
    }),
  ]);
  return <CouponsManager organizations={orgs} services={services} />;
}
