import { DateTime, IANAZone } from "luxon";

/** Staff calendar dates become a saved half-open UTC window in the org's zone. */
export function couponCalendarWindow(startDate: string, endDate: string, businessTimezone: string) {
  if (!IANAZone.isValidZone(businessTimezone)) throw new RangeError("Invalid business timezone");
  const start = DateTime.fromISO(startDate, { zone: businessTimezone }).startOf("day");
  const end = DateTime.fromISO(endDate, { zone: businessTimezone })
    .plus({ days: 1 })
    .startOf("day");
  if (
    !start.isValid ||
    !end.isValid ||
    end <= start ||
    start.toISODate() !== startDate ||
    end.minus({ days: 1 }).toISODate() !== endDate
  )
    throw new RangeError("End date must be on or after start date");
  return { startsAt: start.toJSDate(), endsAt: end.toJSDate() };
}
