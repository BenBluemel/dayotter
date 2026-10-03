import { randomUUID } from "node:crypto";
import { sha256hex } from "@dayotter/core";
import { type Database, and, eq, getDb, inArray, lte, schema, sql } from "@dayotter/db";
import type Stripe from "stripe";
import { BookingError } from "../booking/booking-logic";
import {
  CHECKOUT_LIFETIME_SECONDS,
  CREATION_RETRY_SECONDS,
  canonicalJson,
} from "../payments/attempt-terms";
import { checkoutRouteForOrganization } from "../payments/connect";
import { retryAt } from "../payments/recovery-backoff";
import {
  PaymentContradictionError,
  type PaymentRoute,
  PaymentRoutingError,
} from "../payments/routing";
import {
  createCheckoutSession,
  retrievePaymentIntent,
  retrieveSession,
  sessionForPaymentIntent,
} from "../payments/stripe";
import { env } from "../server/env";
import { packageConfigurationSnapshot } from "./configuration-snapshot";
import { grantCreditsInTransaction, requirePackageOwner } from "./credits";

export type PackagePurchase = typeof schema.packagePurchases.$inferSelect;
const objectId = (value: string | { id: string } | null | undefined) =>
  typeof value === "string" ? value : (value?.id ?? null);
export function purchaseRoute(p: PackagePurchase): PaymentRoute {
  const t = p.terms;
  if (
    sha256hex(canonicalJson(t)) !== p.termsHash ||
    t.ownerUserId !== p.ownerUserId ||
    t.version !== 1 ||
    t.packageId !== p.packageId ||
    t.eventTypeId !== p.eventTypeId ||
    t.organizationId !== p.organizationId ||
    t.route.organizationId !== p.organizationId ||
    t.route.environment !== p.environment ||
    t.route.chargeAccountId !== p.chargeAccountId ||
    !Number.isSafeInteger(t.amount) ||
    t.amount <= 0 ||
    !Number.isInteger(t.totalCredits) ||
    t.totalCredits < 1 ||
    t.totalCredits > 100
  )
    throw new PaymentContradictionError("Saved package terms require reconciliation");
  if (
    !["direct", "connect"].includes(t.route.mode) ||
    !["test", "live"].includes(t.route.environment) ||
    t.route.credentialContext !== "primary" ||
    !/^acct_[A-Za-z0-9]+$/.test(t.route.chargeAccountId) ||
    !/^[a-z]{3}$/.test(t.currency) ||
    (t.route.mode === "direct" &&
      (t.route.destinationAccountId != null || (t.route.applicationFeeAmount ?? 0) !== 0)) ||
    (t.route.mode === "connect" &&
      (!/^acct_[A-Za-z0-9]+$/.test(t.route.destinationAccountId ?? "") ||
        t.route.destinationAccountId === t.route.chargeAccountId ||
        !Number.isSafeInteger(t.route.applicationFeeAmount) ||
        t.route.applicationFeeAmount! < 0 ||
        t.route.applicationFeeAmount! > t.amount))
  )
    throw new PaymentContradictionError("Saved package route is incomplete");
  return t.route as PaymentRoute;
}
export async function preparePackagePurchase(
  packageId: string,
  ownerId: string,
  requestId: string,
  db: Database = getDb(),
) {
  const key = `package-purchase:${ownerId.toLowerCase()}:${requestId.toLowerCase()}`;
  const fingerprint = sha256hex(
    canonicalJson({ packageId: packageId.toLowerCase(), ownerId: ownerId.toLowerCase() }),
  );
  return packageConfigurationSnapshot(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    const existing = await tx.query.packagePurchases.findFirst({
      where: eq(schema.packagePurchases.requestKey, key),
    });
    if (existing) {
      if (existing.requestFingerprint !== fingerprint)
        throw new BookingError("Purchase request was reused with different details", 409);
      purchaseRoute(existing);
      return existing;
    }
    const owner = await requirePackageOwner(ownerId, undefined, tx);
    // One statement captures package/service scope, count and price coherently.
    const [row] = await tx
      .select({ pkg: schema.sessionPackages, event: schema.eventTypes })
      .from(schema.sessionPackages)
      .innerJoin(schema.eventTypes, eq(schema.eventTypes.id, schema.sessionPackages.eventTypeId))
      .where(eq(schema.sessionPackages.id, packageId))
      .for("share");
    if (
      !row?.pkg.isActive ||
      !row.event.isActive ||
      row.pkg.organizationId !== row.event.organizationId ||
      row.pkg.priceAmount <= 0
    )
      throw new BookingError("Package not available", 404);
    const route = await checkoutRouteForOrganization(
      row.pkg.organizationId,
      row.event.ownerId,
      row.pkg.priceAmount,
      tx,
    );
    const createdAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    const id = randomUUID();
    const terms: schema.PackagePurchaseTerms = {
      version: 1,
      organizationId: row.pkg.organizationId,
      eventTypeId: row.pkg.eventTypeId,
      packageId: row.pkg.id,
      ownerUserId: owner.id,
      clientEmail: owner.email.toLowerCase(),
      totalCredits: row.pkg.sessionCount,
      amount: row.pkg.priceAmount,
      currency: row.pkg.currency,
      productName: `${row.pkg.name} - ${row.pkg.sessionCount} sessions`,
      route,
      successUrl: `${env.APP_URL}/packages/thanks?purchase_id=${id}`,
      cancelUrl: env.APP_URL,
    };
    const [purchase] = await tx
      .insert(schema.packagePurchases)
      .values({
        id,
        packageId,
        eventTypeId: terms.eventTypeId,
        requestKey: key,
        requestFingerprint: fingerprint,
        organizationId: terms.organizationId,
        ownerUserId: owner.id,
        terms,
        termsHash: sha256hex(canonicalJson(terms)),
        environment: route.environment,
        chargeAccountId: route.chargeAccountId,
        createdAt,
        expiresAt: new Date(createdAt.getTime() + CHECKOUT_LIFETIME_SECONDS * 1000),
        creationDeadline: new Date(createdAt.getTime() + CREATION_RETRY_SECONDS * 1000),
      })
      .returning();
    return purchase!;
  });
}
export function validatePackageSession(p: PackagePurchase, session: Stripe.Checkout.Session) {
  purchaseRoute(p);
  const t = p.terms;
  const m = session.metadata ?? {};
  const pi = objectId(session.payment_intent);
  if (
    session.mode !== "payment" ||
    !/^cs_[A-Za-z0-9_]+$/.test(session.id) ||
    (pi && !/^pi_[A-Za-z0-9]+$/.test(pi)) ||
    session.client_reference_id !== p.id ||
    m.purchaseId !== p.id ||
    m.termsHash !== p.termsHash ||
    m.ownerUserId !== p.ownerUserId ||
    session.livemode !== (p.environment === "live") ||
    session.amount_total !== t.amount ||
    session.currency !== t.currency ||
    session.amount_subtotal !== t.amount ||
    session.total_details?.amount_discount ||
    session.total_details?.amount_tax ||
    session.total_details?.amount_shipping ||
    m.organizationId !== p.organizationId ||
    m.paymentMode !== t.route.mode ||
    m.chargeAccountId !== p.chargeAccountId ||
    m.paymentEnvironment !== p.environment ||
    m.credentialContext !== t.route.credentialContext ||
    (m.dest ?? null) !== (t.route.destinationAccountId ?? null) ||
    (p.checkoutSessionId && p.checkoutSessionId !== session.id) ||
    (p.paymentIntentId && pi && p.paymentIntentId !== pi) ||
    session.expires_at !== Math.floor(p.expiresAt.getTime() / 1000)
  )
    throw new PaymentContradictionError("Package Checkout contradicts its original terms");
  return pi;
}
export function verifyPackagePayment(
  p: PackagePurchase,
  session: Stripe.Checkout.Session,
  pi: Stripe.PaymentIntent,
): schema.PaymentSuccessFacts {
  const expectedId = validatePackageSession(p, session);
  const t = p.terms;
  const route = purchaseRoute(p);
  const m = pi.metadata;
  if (
    !expectedId ||
    pi.id !== expectedId ||
    session.status !== "complete" ||
    session.payment_status !== "paid" ||
    pi.amount !== t.amount ||
    pi.currency !== t.currency ||
    pi.livemode !== (p.environment === "live") ||
    m.purchaseId !== p.id ||
    m.termsHash !== p.termsHash ||
    m.ownerUserId !== p.ownerUserId ||
    m.organizationId !== p.organizationId ||
    m.paymentMode !== route.mode ||
    m.chargeAccountId !== route.chargeAccountId ||
    m.paymentEnvironment !== route.environment ||
    m.credentialContext !== route.credentialContext ||
    (m.dest ?? null) !== (route.mode === "connect" ? route.destinationAccountId : null) ||
    objectId(pi.transfer_data?.destination) !==
      (route.mode === "connect" ? route.destinationAccountId : null) ||
    (pi.application_fee_amount ?? 0) !==
      (route.mode === "connect" ? route.applicationFeeAmount : 0) ||
    pi.on_behalf_of ||
    (route.mode === "direct" && (pi.transfer_data || pi.application_fee_amount !== null)) ||
    (pi.transfer_data?.amount != null && pi.transfer_data.amount !== t.amount)
  )
    throw new PaymentContradictionError("Package payment contradicts saved financial facts");
  if (pi.status !== "succeeded")
    throw new PaymentRoutingError("Package payment is not settled yet");
  if (pi.amount_received !== t.amount)
    throw new PaymentContradictionError("Captured package amount contradicts its original terms");
  const charge = pi.latest_charge;
  if (!charge || typeof charge === "string")
    throw new PaymentRoutingError("Package charge verification is unavailable");
  if (
    !charge.paid ||
    !/^ch_[A-Za-z0-9]+$/.test(charge.id) ||
    !charge.captured ||
    charge.status !== "succeeded" ||
    charge.amount !== t.amount ||
    charge.currency !== t.currency ||
    charge.livemode !== pi.livemode ||
    objectId(charge.payment_intent) !== pi.id ||
    charge.amount_refunded > 0
  )
    throw new PaymentContradictionError("Package charge requires reconciliation");
  return {
    version: 1,
    sessionId: session.id,
    paymentIntentId: pi.id,
    chargeId: charge.id,
    amount: pi.amount_received,
    currency: pi.currency,
    environment: route.environment,
    chargeAccountId: route.chargeAccountId,
    credentialContext: route.credentialContext,
    paymentMode: route.mode,
    destinationAccountId: route.mode === "connect" ? route.destinationAccountId : null,
    applicationFeeAmount: route.mode === "connect" ? route.applicationFeeAmount : 0,
  };
}
export async function bindPackageSession(
  p: PackagePurchase,
  session: Stripe.Checkout.Session,
  db: Database = getDb(),
) {
  validatePackageSession(p, session);
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(schema.packagePurchases)
      .where(eq(schema.packagePurchases.id, p.id))
      .for("update");
    if (!current) throw new PaymentRoutingError("Package purchase is missing");
    const pi = validatePackageSession(current, session);
    const [saved] = await tx
      .update(schema.packagePurchases)
      .set({
        checkoutSessionId: session.id,
        checkoutUrl: current.checkoutUrl ?? session.url,
        paymentIntentId: current.paymentIntentId ?? pi,
        state:
          current.successFacts || current.state === "requires_review"
            ? current.state
            : session.status === "expired"
              ? "expired"
              : "open",
      })
      .where(eq(schema.packagePurchases.id, p.id))
      .returning();
    return saved!;
  });
}
async function packageReview(id: string, code: string, db: Database) {
  await db.transaction(async (tx) => {
    const [p] = await tx
      .select()
      .from(schema.packagePurchases)
      .where(eq(schema.packagePurchases.id, id))
      .for("update");
    if (p)
      await tx
        .update(schema.packagePurchases)
        .set({ state: p.state === "granted" ? "granted" : "requires_review", reviewCode: code })
        .where(eq(schema.packagePurchases.id, id));
  });
}
export async function packageCheckout(
  p: PackagePurchase,
  db: Database = getDb(),
): Promise<{ checkoutUrl?: string; state: string }> {
  const route = purchaseRoute(p);
  if (p.reviewCode) return { state: "requires_review" };
  if (p.successFacts) return { state: await grantObservedPackage(p.id, db) };
  if (p.checkoutSessionId) {
    const session = await retrieveSession(p.checkoutSessionId, route);
    await bindPackageSession(p, session, db);
    if (session.status !== "open")
      return { state: await reconcilePackagePurchase(p.id, session.id, db) };
    return { state: "open", checkoutUrl: session.url ?? undefined };
  }
  if (Date.now() >= p.creationDeadline.getTime()) {
    await packageReview(p.id, "package_creation_ambiguous", db);
    return { state: "requires_review" };
  }
  const result = await createCheckoutSession({
    amount: p.terms.amount,
    currency: p.terms.currency,
    productName: p.terms.productName,
    customerEmail: p.terms.clientEmail,
    successUrl: p.terms.successUrl,
    cancelUrl: p.terms.cancelUrl,
    route,
    metadata: {
      kind: "package",
      purchaseId: p.id,
      termsHash: p.termsHash,
      ownerUserId: p.ownerUserId,
    },
    idempotencyKey: `package-checkout:${p.id}:v1`,
    expiresAt: Math.floor(p.expiresAt.getTime() / 1000),
    clientReferenceId: p.id,
  });
  const saved = await bindPackageSession(p, result.session, db);
  if (saved.successFacts) return { state: await grantObservedPackage(p.id, db) };
  return { state: "open", checkoutUrl: result.url };
}
export async function observePackagePayment(
  p: PackagePurchase,
  session: Stripe.Checkout.Session,
  pi: Stripe.PaymentIntent,
  db: Database = getDb(),
) {
  const facts = verifyPackagePayment(p, session, pi);
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(schema.packagePurchases)
      .where(eq(schema.packagePurchases.id, p.id))
      .for("update");
    if (!current) throw new PaymentRoutingError("Package purchase is missing");
    validatePackageSession(current, session);
    if (current.successFacts && canonicalJson(current.successFacts) !== canonicalJson(facts))
      throw new PaymentContradictionError("Package success observation conflicts");
    if (current.reviewCode && current.reviewCode !== "package_creation_ambiguous") return current;
    const [saved] = await tx
      .update(schema.packagePurchases)
      .set({
        checkoutSessionId: session.id,
        paymentIntentId: pi.id,
        successFacts: facts,
        state: current.state === "granted" ? "granted" : "payment_succeeded",
        reviewCode: null,
      })
      .where(eq(schema.packagePurchases.id, p.id))
      .returning();
    return saved!;
  });
}
export async function grantObservedPackage(id: string, db: Database = getDb()) {
  return db.transaction(async (tx) => {
    const [p] = await tx
      .select()
      .from(schema.packagePurchases)
      .where(eq(schema.packagePurchases.id, id))
      .for("update");
    if (!p) throw new PaymentRoutingError("Package purchase is missing");
    purchaseRoute(p);
    if (p.reviewCode) return "requires_review";
    if (p.creditId) return "granted";
    if (!p.successFacts || p.state !== "payment_succeeded") return "waiting_payment";
    const creditId = await grantCreditsInTransaction(
      {
        organizationId: p.organizationId,
        eventTypeId: p.terms.eventTypeId,
        ownerUserId: p.ownerUserId,
        clientEmail: p.terms.clientEmail,
        totalCredits: p.terms.totalCredits,
        packageId: p.terms.packageId,
        operationKey: `package-grant:${p.id}`,
        purchaseId: p.id,
        stripePaymentIntentId: p.paymentIntentId!,
      },
      tx,
    );
    await tx
      .update(schema.packagePurchases)
      .set({ creditId, state: "granted" })
      .where(eq(schema.packagePurchases.id, p.id));
    return "granted";
  });
}
export async function reconcilePackagePurchase(
  id: string,
  sessionId?: string,
  db: Database = getDb(),
) {
  const p = await db.query.packagePurchases.findFirst({
    where: eq(schema.packagePurchases.id, id),
  });
  if (!p) throw new PaymentRoutingError("Package purchase is missing");
  try {
    if (p.reviewCode && p.reviewCode !== "package_creation_ambiguous") return "requires_review";
    if (sessionId && p.checkoutSessionId && sessionId !== p.checkoutSessionId)
      throw new PaymentContradictionError("Package Session identity conflicts");
    if (p.successFacts) return await grantObservedPackage(id, db);
    if (!sessionId && !p.checkoutSessionId) return (await packageCheckout(p, db)).state;
    const session = await retrieveSession(sessionId ?? p.checkoutSessionId!, purchaseRoute(p));
    const piId = validatePackageSession(p, session);
    // Preserve canonical Session identity before an Intent read can fail/crash.
    const saved = await bindPackageSession(p, session, db);
    if (session.payment_status !== "paid") {
      await db
        .update(schema.packagePurchases)
        .set({ nextRecoveryAt: new Date(Date.now() + 5 * 60 * 1000) })
        .where(eq(schema.packagePurchases.id, id));
      return session.status === "expired" ? "expired" : "waiting_payment";
    }
    if (!piId) throw new PaymentContradictionError("Paid package Session has no PaymentIntent");
    await observePackagePayment(
      saved,
      session,
      await retrievePaymentIntent(piId, purchaseRoute(p)),
      db,
    );
    return await grantObservedPackage(id, db);
  } catch (err) {
    const failure = err as { code?: string; cause?: { code?: string } };
    if (
      err instanceof PaymentContradictionError ||
      ["23505", "23514"].includes(failure.cause?.code ?? failure.code ?? "")
    ) {
      await packageReview(id, "package_payment_contradiction", db);
      return "requires_review";
    }
    await db
      .update(schema.packagePurchases)
      .set({
        failures: sql`${schema.packagePurchases.failures}+1`,
        nextRecoveryAt: retryAt(p.failures + 1),
      })
      .where(eq(schema.packagePurchases.id, id));
    return "retry";
  }
}
/** Only called after raw-body signature verification. The durable intent is itself the recovery receipt. */
export async function receivePackageEvent(
  event: Stripe.Event,
  db: Database = getDb(),
): Promise<string | null> {
  if (
    ![
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed",
      "checkout.session.expired",
      "payment_intent.succeeded",
    ].includes(event.type)
  )
    return null;
  const object = event.data.object as Stripe.Checkout.Session | Stripe.PaymentIntent;
  const isSession = event.type.startsWith("checkout.session.");
  const reference = isSession ? (object as Stripe.Checkout.Session).client_reference_id : null;
  const purchaseId = object.metadata?.purchaseId;
  const byIdentity = await db.query.packagePurchases.findFirst({
    where: isSession
      ? eq(schema.packagePurchases.checkoutSessionId, object.id)
      : eq(schema.packagePurchases.paymentIntentId, object.id),
  });
  const p =
    byIdentity ??
    ((purchaseId || reference) &&
    /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(purchaseId ?? reference!)
      ? await db.query.packagePurchases.findFirst({
          where: eq(schema.packagePurchases.id, purchaseId ?? reference!),
        })
      : null);
  if (!p) {
    if (purchaseId || object.metadata?.kind === "package")
      throw new PaymentRoutingError("Package payment needs manual reconciliation");
    return null;
  }
  if (
    event.livemode !== (p.environment === "live") ||
    (event.account && event.account !== p.chargeAccountId) ||
    (purchaseId && purchaseId !== p.id)
  ) {
    await packageReview(p.id, "package_event_relationship_contradiction", db);
    return "requires_review";
  }
  if (isSession) {
    try {
      validatePackageSession(p, object as Stripe.Checkout.Session);
    } catch {
      await packageReview(p.id, "package_event_relationship_contradiction", db);
      return "requires_review";
    }
    return reconcilePackagePurchase(p.id, object.id, db);
  }
  // Intent metadata selects a candidate only; an authenticated Session read proves the relationship.
  let session: Stripe.Checkout.Session;
  try {
    session = p.checkoutSessionId
      ? await retrieveSession(p.checkoutSessionId, purchaseRoute(p))
      : await sessionForPaymentIntent(object.id, purchaseRoute(p));
  } catch (err) {
    if (err instanceof PaymentContradictionError) {
      await packageReview(p.id, "package_event_relationship_contradiction", db);
      return "requires_review";
    }
    return "retry"; // SDK errors/configuration are not logged or exposed by webhook intake.
  }
  if (objectId(session.payment_intent) !== object.id) {
    await packageReview(p.id, "package_event_relationship_contradiction", db);
    return "requires_review";
  }
  return reconcilePackagePurchase(p.id, session.id, db);
}
export async function recoverPackagePurchases(limit = 25, db: Database = getDb()) {
  const rows = await db
    .select()
    .from(schema.packagePurchases)
    .where(
      and(
        inArray(schema.packagePurchases.state, ["prepared", "open", "payment_succeeded"]),
        lte(schema.packagePurchases.nextRecoveryAt, new Date()),
      ),
    )
    .orderBy(schema.packagePurchases.nextRecoveryAt, schema.packagePurchases.id)
    .limit(Math.max(1, Math.min(100, limit)));
  for (const p of rows) await reconcilePackagePurchase(p.id, undefined, db);
  return { packages: rows.length };
}
