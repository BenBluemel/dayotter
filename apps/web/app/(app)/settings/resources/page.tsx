import { ResourcesManager } from "@/components/resources-manager";
import { getSession } from "@/lib/auth/session";
import { listResourceConfiguration } from "@/lib/resources/configuration";
import { and, eq, getDb, inArray, schema } from "@dayotter/db";
export const dynamic = "force-dynamic";
export default async function ResourcesSettingsPage() {
  const session = await getSession();
  if (!session?.user.id) return <p>Sign in to manage resources.</p>;
  const db = getDb();
  const memberships = await db
    .select({ organizationId: schema.memberships.organizationId })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.userId, session.user.id),
        inArray(schema.memberships.role, ["owner", "admin"]),
      ),
    );
  if (!memberships.length) return <p>Only organization owners and admins can manage resources.</p>;
  const organizations = await db
    .select({
      id: schema.organizations.id,
      name: schema.organizations.name,
      businessTimezone: schema.organizations.businessTimezone,
    })
    .from(schema.organizations)
    .where(
      inArray(
        schema.organizations.id,
        memberships.map((m) => m.organizationId),
      ),
    )
    .orderBy(schema.organizations.name, schema.organizations.id);
  return (
    <ResourcesManager
      organizations={organizations}
      initial={await listResourceConfiguration(db, session.user.id, organizations[0]!.id)}
    />
  );
}
