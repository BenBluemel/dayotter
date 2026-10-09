ALTER TABLE "booking_settlement_claims" DROP CONSTRAINT "booking_settlement_claim_shape";--> statement-breakpoint
ALTER TABLE "booking_settlement_claims" ADD CONSTRAINT "booking_settlement_claim_shape" CHECK ("booking_settlement_claims"."settlement" IN ('cash','package_credit','zero_cash') AND "booking_settlement_claims"."request_fingerprint" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
-- No legacy free booking is inferred/backfilled into an operation identity.
CREATE FUNCTION valid_zero_cash_booking(source uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM bookings b JOIN booking_pricing_snapshots p ON p.booking_id=b.id
    WHERE b.id=source AND p.organization_id=b.organization_id AND p.event_type_id=b.event_type_id
      AND p.settlement='cash' AND p.effective_price=0 AND p.amount_to_collect=0
      AND b.payment_status='none' AND b.payment_intent_id IS NULL
      AND b.destination_account_id IS NULL AND coalesce(b.amount_paid,0)=0
      AND (SELECT count(*) FROM booking_pricing_snapshots WHERE booking_id=source)=1
  );
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION check_booking_settlement_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.settlement='cash' AND NOT EXISTS(SELECT 1 FROM payment_attempts WHERE id=NEW.source_id AND request_key=NEW.operation_key AND request_fingerprint=NEW.request_fingerprint))
    OR (NEW.settlement='package_credit' AND NOT EXISTS(SELECT 1 FROM package_credit_mutations WHERE booking_id=NEW.source_id AND kind='redemption' AND operation_key=NEW.operation_key AND request_fingerprint=NEW.request_fingerprint))
    OR (NEW.settlement='zero_cash' AND NOT valid_zero_cash_booking(NEW.source_id)) THEN
    RAISE EXCEPTION 'Settlement claim must commit with its durable source' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END; $$;
--> statement-breakpoint
CREATE FUNCTION check_zero_cash_booking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM booking_settlement_claims WHERE settlement='zero_cash' AND source_id=OLD.id)
    AND NOT valid_zero_cash_booking(OLD.id) THEN
    RAISE EXCEPTION 'Zero-cash booking settlement must retain its quote and booking' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END; $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER zero_cash_booking_binding AFTER UPDATE OR DELETE ON bookings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_zero_cash_booking();

--> statement-breakpoint
-- Legacy uncollected revisions remain readable. A newly claimed zero-cash
-- booking has accepted one quote and may not append a replacement after commit.
CREATE FUNCTION guard_zero_cash_quote() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM booking_settlement_claims WHERE settlement='zero_cash' AND source_id=NEW.booking_id) THEN
    RAISE EXCEPTION 'Accepted zero-cash pricing cannot be replaced' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER zero_cash_quote_guard BEFORE INSERT ON booking_pricing_snapshots
  FOR EACH ROW EXECUTE FUNCTION guard_zero_cash_quote();
