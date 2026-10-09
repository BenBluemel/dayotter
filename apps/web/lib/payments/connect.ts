import { type Database, eq, getDb, schema } from "@dayotter/db";
import type Stripe from "stripe";
import { env } from "../server/env";
import { PaymentRoutingError, paymentRoutingConfig, resolvePaymentRoute } from "./routing";
import { retrieveConnectStatus } from "./stripe";

/**
 * The host's connected account to route a charge to - but only once they can
 * actually accept charges. Missing/unready ownership is a routing error.
 */
export async function hostDestinationAccount(
  userId: string | null | undefined,
  db: Pick<Database, "query"> = getDb(),
): Promise<string> {
  if (!userId) throw new PaymentRoutingError("A Connect event owner is required");
  const u = await db.query.users.findFirst({
    where: eq(schema.users.id, userId),
    columns: { stripeAccountId: true, stripeChargesEnabled: true },
  });
  if (
    !u?.stripeChargesEnabled ||
    !u.stripeAccountId ||
    !/^acct_[A-Za-z0-9]+$/.test(u.stripeAccountId)
  ) {
    throw new PaymentRoutingError("The event owner has no ready Connect account");
  }
  return u.stripeAccountId;
}

/** Inputs come from the server-loaded service/package, never a caller-chosen merchant. */
export async function checkoutRouteForOrganization(
  organizationId: string,
  ownerId: string | null,
  amount: number,
  db: Pick<Database, "query"> = getDb(),
) {
  const config = paymentRoutingConfig(env);
  if (config.mode !== "connect") return resolvePaymentRoute(config, { organizationId, amount });
  const accountId = await hostDestinationAccount(ownerId, db);
  const status = await retrieveConnectStatus(accountId);
  return resolvePaymentRoute(config, {
    organizationId,
    amount,
    destination: {
      accountId,
      chargesEnabled: status.chargesEnabled,
      transfersEnabled: status.transfersEnabled,
    },
  });
}

/**
 * Mirror a Stripe Connect account's capability flags onto the host user (matched
 * by stripeAccountId). Called from the `account.updated` webhook and after the
 * host returns from onboarding, so the settings UI reflects reality.
 */
export async function syncConnectAccountStatus(account: Stripe.Account): Promise<void> {
  await getDb()
    .update(schema.users)
    .set({
      stripeChargesEnabled: Boolean(account.charges_enabled),
      stripePayoutsEnabled: Boolean(account.payouts_enabled),
    })
    .where(eq(schema.users.stripeAccountId, account.id));
}
