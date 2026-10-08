import { BookingsWorkspace, type HistoryBooking } from "@/components/bookings-workspace";
import { PageHeader } from "@/components/page-header";
import { getSession } from "@/lib/auth/session";
import { loadBookingHistory, normalizeHistoryStatus } from "@/lib/booking/booking-history";

export const dynamic = "force-dynamic";

export default async function BookingsPage({
  searchParams,
}: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const session = await getSession();
  const tz = (session!.user as { timezone?: string }).timezone ?? "UTC";

  const params = await searchParams;
  const { rows, query, status, hasMore } = await loadBookingHistory(
    session!.user.id,
    typeof params.q === "string" ? params.q : "",
    normalizeHistoryStatus(typeof params.status === "string" ? params.status : undefined),
  );

  const history: HistoryBooking[] = rows.map((b) => ({
    id: b.id,
    uid: b.uid,
    title: b.title,
    startsAt: b.startsAt.toISOString(),
    endsAt: b.endsAt.toISOString(),
    status: b.status,
    color: b.eventType?.color ?? null,
    attendees: b.attendees.map((a) => a.name ?? a.email),
  }));

  return (
    <>
      <PageHeader
        eyebrow="Your calendar"
        title="Bookings"
        description="Everything scheduled with you."
      />
      <BookingsWorkspace
        tz={tz}
        history={history}
        query={query}
        statusFilter={status}
        hasMore={hasMore}
      />
    </>
  );
}
