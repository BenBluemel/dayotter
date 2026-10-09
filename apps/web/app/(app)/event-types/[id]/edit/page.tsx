import { EventTypeForm } from "@/components/event-type-form";
import { PageHeader } from "@/components/page-header";
import { ResourceRequirementsEditor } from "@/components/resource-requirements-editor";
import { getSession } from "@/lib/auth/session";
import { paymentsEnabled } from "@/lib/payments/stripe";
import { listResourceConfiguration } from "@/lib/resources/configuration";
import { and, eq, getDb, inArray, schema } from "@dayotter/db";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function EditEventTypePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSession();

  const eventType = await getDb().query.eventTypes.findFirst({
    where: and(eq(schema.eventTypes.id, id), eq(schema.eventTypes.ownerId, session!.user.id)),
  });
  if (!eventType) notFound();

  const administrator = await getDb().query.memberships.findFirst({
    where: and(
      eq(schema.memberships.userId, session!.user.id),
      eq(schema.memberships.organizationId, eventType.organizationId),
      inArray(schema.memberships.role, ["owner", "admin"]),
    ),
  });
  const resources = administrator
    ? await listResourceConfiguration(getDb(), session!.user.id, eventType.organizationId)
    : null;
  const service = resources?.services.find((s) => s.id === eventType.id);

  return (
    <>
      <PageHeader title="Edit booking type" description="Update how this meeting is booked." />
      <EventTypeForm
        mode="edit"
        paymentsEnabled={paymentsEnabled}
        initial={{
          id: eventType.id,
          title: eventType.title,
          slug: eventType.slug,
          durationMinutes: eventType.durationMinutes,
          description: eventType.description,
          location: eventType.location,
          locationDetail: eventType.locationDetail,
          locations: eventType.locations,
          bufferBeforeMinutes: eventType.bufferBeforeMinutes,
          bufferAfterMinutes: eventType.bufferAfterMinutes,
          minimumNoticeMinutes: eventType.minimumNoticeMinutes,
          slotIntervalMinutes: eventType.slotIntervalMinutes,
          offsetStartMinutes: eventType.offsetStartMinutes,
          minimumGapMinutes: eventType.minimumGapMinutes,
          durationOptions: eventType.durationOptions,
          bookingWindowDays: eventType.bookingWindowDays ?? undefined,
          dailyBookingLimit: eventType.dailyBookingLimit,
          weeklyBookingLimit: eventType.weeklyBookingLimit,
          monthlyBookingLimit: eventType.monthlyBookingLimit,
          yearlyBookingLimit: eventType.yearlyBookingLimit,
          maxAttendees: eventType.maxAttendees,
          recurringCount: eventType.recurringCount,
          recurringFrequency: eventType.recurringFrequency as "weekly" | "biweekly" | "monthly",
          hasAccessCode: eventType.accessCodeHash != null,
          isPrivate: eventType.isPrivate,
          requiresConfirmation: eventType.requiresConfirmation,
          redirectUrl: eventType.redirectUrl,
          color: eventType.color,
          price: eventType.price,
          currency: eventType.currency,
          depositAmount: eventType.depositAmount,
          questions: eventType.questions,
          scheduleId: eventType.scheduleId,
        }}
      />
      {resources && service && (
        <div className="mt-6">
          <ResourceRequirementsEditor
            organizationId={eventType.organizationId}
            service={service}
            resources={resources.resources}
          />
        </div>
      )}
    </>
  );
}
