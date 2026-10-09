-- Pending zero-cash coupon bookings can be declined without payment/refund.
-- Rejection must restore the coupon and release resources in the same transaction,
-- just as cancellation does. Existing accepted rows and history are not rewritten.
CREATE OR REPLACE FUNCTION guard_coupon_restoration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Coupon restoration history is immutable'; END IF;
 IF NOT EXISTS (SELECT 1 FROM appointment_coupon_uses u JOIN bookings b ON b.id=u.booking_id WHERE u.id=NEW.use_id AND u.booking_id=NEW.booking_id AND u.status='redeemed' AND b.status IN ('cancelled','rejected'))
   THEN RAISE EXCEPTION 'Coupon restoration must reference cancelled or rejected redemption'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION check_coupon_booking() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bid uuid; b bookings%ROWTYPE; u appointment_coupon_uses%ROWTYPE; has_coupon boolean; restored boolean;
BEGIN
 IF TG_TABLE_NAME='bookings' THEN bid:=NEW.id; ELSE bid:=NEW.booking_id; END IF;
 IF bid IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO b FROM bookings WHERE id=bid;
 SELECT * INTO u FROM appointment_coupon_uses WHERE booking_id=bid;
 SELECT EXISTS(SELECT 1 FROM booking_pricing_snapshots WHERE booking_id=bid AND coupon_id IS NOT NULL) INTO has_coupon;
 IF has_coupon OR u.id IS NOT NULL THEN
   SELECT EXISTS(SELECT 1 FROM appointment_coupon_restorations WHERE use_id=u.id AND booking_id=bid) INTO restored;
   IF b.id IS NULL OR u.id IS NULL OR NOT has_coupon
      OR u.organization_id<>b.organization_id OR u.event_type_id<>b.event_type_id
      OR EXISTS(SELECT 1 FROM booking_pricing_snapshots WHERE booking_id=bid AND coupon_id IS NOT NULL AND coupon_id<>u.coupon_id)
      OR u.status NOT IN ('redeemed','restored')
      OR (b.status IN ('cancelled','rejected'))<>(u.status='restored') OR (u.status='restored')<>restored THEN
     RAISE EXCEPTION 'Coupon booking, redemption and cancellation/decline restoration must commit together' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NULL;
END $$;
