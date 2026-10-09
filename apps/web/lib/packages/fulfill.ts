import type Stripe from "stripe";
import { PaymentRoutingError } from "../payments/routing";
import { receivePackageEvent } from "./purchases";
/** Explicit compatibility boundary. Old Sessions lack a durable owner and saved purchase terms. */
export async function fulfillPackagePurchase(_session: Stripe.Checkout.Session): Promise<void> {
  throw new PaymentRoutingError("Legacy package purchase needs manual reconciliation");
}
export { receivePackageEvent };
