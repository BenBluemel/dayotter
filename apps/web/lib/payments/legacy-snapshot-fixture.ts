import type { AppointmentPrice } from "@dayotter/core";
import { type Database, sql } from "@dayotter/db";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Historical migration fixtures must insert only the columns that existed in 0063. */
export async function insertHistoricalPricingSnapshot(
  tx: Transaction,
  bookingId: string,
  quote: AppointmentPrice,
) {
  const promotion = quote.promotion;
  await tx.execute(sql`INSERT INTO booking_pricing_snapshots
    (booking_id, organization_id, event_type_id, version, appointment_starts_at, settlement,
     base_price, effective_price, currency, amount_to_collect, promotion_id, promotion_label,
     promotion_starts_at, promotion_ends_at, promotion_discount_kind, promotion_discount_value, promotion_currency)
    VALUES (${bookingId}::uuid, ${quote.organizationId}::uuid, ${quote.eventTypeId}::uuid, 1,
      ${new Date(quote.appointmentStartsAt)}, ${quote.settlement}, ${quote.basePrice},
      ${quote.effectivePrice}, ${quote.currency}, ${quote.amountToCollect},
      ${promotion?.id ?? null}::uuid, ${promotion?.label ?? null},
      ${promotion ? new Date(promotion.startsAt) : null},
      ${promotion ? new Date(promotion.endsAt) : null}, ${promotion?.discount.kind ?? null},
      ${promotion ? (promotion.discount.kind === "percentage" ? promotion.discount.basisPoints : promotion.discount.amount) : null},
      ${promotion?.discount.kind === "fixed" ? promotion.discount.currency : null})`);
}
