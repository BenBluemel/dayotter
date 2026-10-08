"use client";

import { BookingsCalendar } from "@/components/bookings-calendar";
import { EmptyState } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import type { HistoryStatus } from "@/lib/booking/booking-history";
import { eventColorVar } from "@/lib/booking/event-type-input";
import { cn } from "@/lib/cn";
import { DateTime } from "luxon";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export interface HistoryBooking {
  id: string;
  uid: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status: string;
  color: string | null;
  attendees: string[];
}

const STATUS_STYLES: Record<string, string> = {
  confirmed: "bg-[var(--color-success)]/15 text-[var(--color-success)]",
  pending: "bg-[var(--color-mint)]/15 text-[var(--color-mint)]",
  cancelled: "bg-[var(--color-danger)]/15 text-[var(--color-danger)]",
  rejected: "bg-[var(--color-danger)]/15 text-[var(--color-danger)]",
  no_show: "bg-[var(--color-amber)]/15 text-[var(--color-amber)]",
  completed: "bg-[var(--color-surface-2)] text-[var(--color-muted)]",
};
const STATUS_LABEL: Record<string, string> = { no_show: "no-show" };

type Tab = "calendar" | "history";

const FILTERS: { key: HistoryStatus; label: string }[] = [
  { key: "all", label: "All" },
  { key: "confirmed", label: "Confirmed" },
  { key: "completed", label: "Completed" },
  { key: "cancelled", label: "Cancelled" },
  { key: "no_show", label: "No-show" },
  { key: "pending", label: "Pending" },
];

/** Bookings surface: a colour-coded calendar (month/week/agenda) plus a full
 *  history list (including past + cancelled). */
export function BookingsWorkspace({
  tz,
  history,
  query,
  statusFilter,
  hasMore,
}: {
  tz: string;
  history: HistoryBooking[];
  query: string;
  statusFilter: HistoryStatus;
  hasMore: boolean;
}) {
  // Default to History so the server-loaded rows render immediately; the
  // calendar fetches its own range only when that tab is opened.
  const [tab, setTab] = useState<Tab>("history");
  const active = FILTERS.find((f) => f.key === statusFilter) ?? FILTERS[0]!;
  const historyUrl = (q: string, status: string) =>
    `/bookings?${new URLSearchParams({ q, status })}`;

  return (
    <>
      <div className="mb-5 flex rounded-md border border-[var(--color-border-strong)] p-0.5 w-fit">
        {(["history", "calendar"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "rounded-sm px-4 py-1.5 text-sm capitalize transition-colors",
              tab === t
                ? "bg-[var(--color-accent)] text-white"
                : "text-[var(--color-muted)] hover:text-[var(--color-text)]",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "calendar" ? (
        <BookingsCalendar tz={tz} />
      ) : (
        <>
          <form action="/bookings" method="get" className="mb-4 flex flex-wrap items-end gap-2">
            <input type="hidden" name="status" value={statusFilter} />
            <label className="flex flex-1 flex-col gap-1 text-sm">
              Search appointments
              <input
                key={query}
                name="q"
                defaultValue={query}
                type="search"
                placeholder="Client name, email, or appointment title"
                className="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2"
              />
            </label>
            <button
              type="submit"
              className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm text-white"
            >
              Search
            </button>
            {query ? (
              <Link
                href={historyUrl("", statusFilter)}
                className="px-3 py-2 text-sm text-[var(--color-accent)]"
              >
                Clear search
              </Link>
            ) : null}
          </form>
          <div className="mb-4 flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <Link
                key={f.key}
                href={historyUrl(query, f.key)}
                aria-current={statusFilter === f.key ? "page" : undefined}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  statusFilter === f.key
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                    : "border-[var(--color-border-strong)] text-[var(--color-muted)] hover:text-[var(--color-text)]",
                )}
              >
                {f.label}
              </Link>
            ))}
          </div>
          {hasMore ? (
            <p role="status" className="mb-4 text-sm text-[var(--color-muted)]">
              Showing 100 appointments. Narrow your search or choose a status to see fewer results.
            </p>
          ) : null}
          {history.length === 0 ? (
            <EmptyState
              title={
                query
                  ? "No matching appointments"
                  : statusFilter !== "all"
                    ? `No ${active.label.toLowerCase()} bookings`
                    : "No bookings yet"
              }
              description={
                query
                  ? "Try another name, email, or appointment title, or clear your search."
                  : "Appointments matching this view will appear here."
              }
            />
          ) : (
            <div className="space-y-2">
              {history.map((b) => (
                <HistoryRow key={b.id} b={b} tz={tz} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

function HistoryRow({ b, tz }: { b: HistoryBooking; tz: string }) {
  const router = useRouter();
  const [status, setStatus] = useState(b.status);
  const [reviewing, setReviewing] = useState(false);
  const open = () => router.push(`/booking/${b.uid}`);
  const isPast = new Date(b.endsAt).getTime() < Date.now();
  // Past meetings auto-complete, so the no-show toggle covers confirmed/completed/no_show.
  const canMark =
    isPast && (status === "confirmed" || status === "completed" || status === "no_show");
  // Opt-in bookings: the host approves or declines while the request is pending.
  const canReview = status === "pending" && !isPast;

  async function toggleNoShow() {
    const noShow = status !== "no_show";
    // Optimistic: undo on a past meeting returns to `completed`.
    setStatus(noShow ? "no_show" : "completed");
    const res = await fetch(`/api/bookings/${b.uid}/no-show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ noShow }),
    });
    if (!res.ok) setStatus(b.status);
  }

  async function review(action: "confirm" | "decline") {
    setReviewing(true);
    const res = await fetch(`/api/bookings/${b.uid}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    setReviewing(false);
    if (res.ok) setStatus(action === "confirm" ? "confirmed" : "rejected");
  }

  return (
    <Card
      interactive
      role="link"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      className="flex cursor-pointer items-center gap-4 px-4 py-3"
    >
      <span
        aria-hidden
        className="h-9 w-1 shrink-0 rounded-full"
        style={{ backgroundColor: eventColorVar(b.color) }}
      />
      <div className="w-28 shrink-0 text-sm">
        <p className="font-medium">{DateTime.fromISO(b.startsAt).setZone(tz).toFormat("LLL d")}</p>
        <p className="text-xs text-[var(--color-muted)]">
          {DateTime.fromISO(b.startsAt).setZone(tz).toFormat("h:mm a")}
        </p>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{b.title}</p>
        <p className="truncate text-xs text-[var(--color-muted)]">
          {b.attendees.join(", ") || "No attendees"}
        </p>
      </div>
      {canReview ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            disabled={reviewing}
            onClick={(e) => {
              e.stopPropagation();
              review("confirm");
            }}
            className="rounded-full bg-[var(--color-success)] px-3 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Approve
          </button>
          <button
            type="button"
            disabled={reviewing}
            onClick={(e) => {
              e.stopPropagation();
              review("decline");
            }}
            className="rounded-full border border-[var(--color-border-strong)] px-3 py-1 text-xs font-medium text-[var(--color-muted)] transition-colors hover:text-[var(--color-text)] disabled:opacity-50"
          >
            Decline
          </button>
        </div>
      ) : null}
      {canMark ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            toggleNoShow();
          }}
          className="shrink-0 text-xs text-[var(--color-muted)] hover:text-[var(--color-text)]"
        >
          {status === "no_show" ? "Undo" : "No-show"}
        </button>
      ) : null}
      <span
        className={cn(
          "shrink-0 rounded-full px-2.5 py-1 text-xs font-medium",
          STATUS_STYLES[status] ?? "bg-[var(--color-surface-2)] text-[var(--color-muted)]",
        )}
      >
        {STATUS_LABEL[status] ?? status}
      </span>
    </Card>
  );
}
