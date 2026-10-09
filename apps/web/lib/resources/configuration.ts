import {
  type Database,
  and,
  eq,
  inArray,
  schema,
  sql,
  withResourceTransaction,
} from "@dayotter/db";
import { z } from "zod";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const quantity = z.number().int().positive().max(2147483647);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:00)?$/);
const endTime = z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)(:00)?$/);
export const openingHoursInput = z
  .object({
    timezone: z.string().min(1).max(100),
    rules: z
      .array(
        z.object({ dayOfWeek: z.number().int().min(0).max(6), startTime: time, endTime }).strict(),
      )
      .max(100),
    overrides: z
      .array(
        z
          .object({
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            startTime: time.nullable(),
            endTime: endTime.nullable(),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export const createResourceInput = z
  .object({
    organizationId: z.string().uuid(),
    name: z.string().trim().min(1).max(200),
    capacity: quantity,
    enabled: z.boolean(),
  })
  .strict();
export const updateResourceInput = z
  .object({
    organizationId: z.string().uuid(),
    id: z.string().uuid(),
    version: z.number().int().nonnegative(),
    name: z.string().trim().min(1).max(200).optional(),
    capacity: quantity.optional(),
    enabled: z.boolean().optional(),
    openingHours: openingHoursInput.nullable().optional(),
  })
  .strict()
  .refine((d) => [d.name, d.capacity, d.enabled, d.openingHours].some((v) => v !== undefined));
export const requirementsInput = z
  .object({
    organizationId: z.string().uuid(),
    eventTypeId: z.string().uuid(),
    version: z.number().int().positive(),
    requiresHost: z.boolean().optional(),
    requirements: z
      .array(z.object({ id: z.string().uuid().toLowerCase(), quantity }).strict())
      .max(100),
  })
  .strict()
  .refine((d) => new Set(d.requirements.map((r) => r.id)).size === d.requirements.length);

export class ConfigurationError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}
/** Authorization remains valid until commit, including a concurrent role removal. */
async function authorize(tx: Transaction, userId: string, organizationId: string, lock = true) {
  const query = tx
    .select({ id: schema.memberships.id })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.userId, userId),
        eq(schema.memberships.organizationId, organizationId),
        inArray(schema.memberships.role, ["owner", "admin"]),
      ),
    );
  const [membership] = await (lock ? query.for("share") : query);
  if (!membership)
    throw new ConfigurationError("Only organization owners and admins can manage resources.", 403);
}
const resourceColumns = {
  id: schema.resources.id,
  organizationId: schema.resources.organizationId,
  name: schema.resources.name,
  capacity: schema.resources.capacity,
  enabled: schema.resources.enabled,
  openingHours: schema.resources.openingHours,
  version: schema.resources.allocationVersion,
};
export async function listResourceConfiguration(
  db: Database,
  userId: string,
  organizationId: string,
) {
  return db.transaction(
    async (tx) => {
      await authorize(tx, userId, organizationId, false);
      const resources = await tx
        .select(resourceColumns)
        .from(schema.resources)
        .where(eq(schema.resources.organizationId, organizationId))
        .orderBy(schema.resources.name, schema.resources.id);
      const services = await tx
        .select({
          id: schema.eventTypes.id,
          title: schema.eventTypes.title,
          slug: schema.eventTypes.slug,
          version: schema.eventTypes.resourceConfigurationRevision,
          requiresHost: schema.eventTypes.requiresHost,
          managed: sql<boolean>`${schema.eventTypes.resourceAdmissionEpoch} > 0`,
        })
        .from(schema.eventTypes)
        .where(
          and(
            eq(schema.eventTypes.organizationId, organizationId),
            sql`${schema.eventTypes.slug} <> '__personal'`,
          ),
        )
        .orderBy(schema.eventTypes.title, schema.eventTypes.id);
      const requirements = await tx
        .select({
          eventTypeId: schema.eventTypeResourceRequirements.eventTypeId,
          id: schema.eventTypeResourceRequirements.resourceId,
          quantity: schema.eventTypeResourceRequirements.quantity,
        })
        .from(schema.eventTypeResourceRequirements)
        .where(eq(schema.eventTypeResourceRequirements.organizationId, organizationId));
      const byService = new Map<string, { id: string; quantity: number }[]>();
      for (const r of requirements) {
        const list = byService.get(r.eventTypeId) ?? [];
        list.push({ id: r.id, quantity: r.quantity });
        byService.set(r.eventTypeId, list);
      }
      return {
        resources,
        services: services.map((s) => ({ ...s, requirements: byService.get(s.id) ?? [] })),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
export async function createResource(
  db: Database,
  userId: string,
  input: z.infer<typeof createResourceInput>,
) {
  const d = createResourceInput.parse(input);
  return withResourceTransaction(db, async (tx) => {
    await authorize(tx, userId, d.organizationId);
    const [resource] = await tx.insert(schema.resources).values(d).returning(resourceColumns);
    return resource;
  });
}
export async function updateResource(
  db: Database,
  userId: string,
  input: z.infer<typeof updateResourceInput>,
) {
  const { organizationId, id, version, ...values } = updateResourceInput.parse(input);
  return withResourceTransaction(db, async (tx) => {
    await authorize(tx, userId, organizationId);
    // Resource-global edits take only this fence; never acquire services/bookings afterward.
    const [resource] = await tx
      .select(resourceColumns)
      .from(schema.resources)
      .where(and(eq(schema.resources.id, id), eq(schema.resources.organizationId, organizationId)))
      .for("no key update");
    if (!resource) throw new ConfigurationError("Resource not found in this organization.", 404);
    if (resource.version !== version)
      throw new ConfigurationError(
        "This resource changed. Reload its details before saving again.",
        409,
      );
    const [saved] = await tx
      .update(schema.resources)
      .set(values)
      .where(eq(schema.resources.id, id))
      .returning(resourceColumns);
    return saved;
  });
}
export async function saveRequirements(
  db: Database,
  userId: string,
  input: z.infer<typeof requirementsInput>,
) {
  const d = requirementsInput.parse(input);
  return withResourceTransaction(db, async (tx) => {
    await authorize(tx, userId, d.organizationId);
    const [service] = await tx
      .select()
      .from(schema.eventTypes)
      .where(
        and(
          eq(schema.eventTypes.id, d.eventTypeId),
          eq(schema.eventTypes.organizationId, d.organizationId),
        ),
      )
      .for("update");
    if (!service) throw new ConfigurationError("Service not found in this organization.", 404);
    if (service.slug === "__personal")
      throw new ConfigurationError("Personal bookings cannot have resource requirements.", 400);
    if (service.resourceConfigurationRevision !== d.version)
      throw new ConfigurationError(
        "This service changed. Reload its requirements before saving again.",
        409,
      );
    if (!(d.requiresHost ?? service.requiresHost) && !d.requirements.length)
      throw new ConfigurationError("Resource-only services require at least one resource.", 400);
    const existing = await tx
      .select({
        id: schema.eventTypeResourceRequirements.resourceId,
        quantity: schema.eventTypeResourceRequirements.quantity,
      })
      .from(schema.eventTypeResourceRequirements)
      .where(eq(schema.eventTypeResourceRequirements.eventTypeId, d.eventTypeId));
    const canonical = (rows: { id: string; quantity: number }[]) =>
      JSON.stringify([...rows].sort((a, b) => a.id.localeCompare(b.id)));
    if (canonical(existing) !== canonical(d.requirements)) {
      // SQL takes the complete old+new sorted resource union and validates scope/state/quantities.
      await tx.execute(
        sql`select resource_set_requirements(${d.eventTypeId}::uuid, ${JSON.stringify(d.requirements)}::jsonb)`,
      );
    }
    if (d.requiresHost !== undefined && d.requiresHost !== service.requiresHost)
      await tx
        .update(schema.eventTypes)
        .set({ requiresHost: d.requiresHost })
        .where(eq(schema.eventTypes.id, d.eventTypeId));
    // Staging is not operational activation. This interface never changes admission epochs.
    const [saved] = await tx
      .select({
        version: schema.eventTypes.resourceConfigurationRevision,
        requiresHost: schema.eventTypes.requiresHost,
      })
      .from(schema.eventTypes)
      .where(eq(schema.eventTypes.id, d.eventTypeId));
    return {
      service: {
        id: service.id,
        title: service.title,
        version: saved!.version,
        managed: service.resourceAdmissionEpoch > 0,
        requiresHost: saved!.requiresHost,
        requirements: d.requirements,
      },
    };
  });
}
