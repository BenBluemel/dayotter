import { getSession } from "@/lib/auth/session";
import { reconcilePackagePurchase } from "@/lib/packages/purchases";
import { eq, getDb, schema } from "@dayotter/db";
export const dynamic = "force-dynamic";
export default async function PackageThanks({
  searchParams,
}: { searchParams: Promise<{ purchase_id?: string }> }) {
  const { purchase_id } = await searchParams;
  const session = await getSession();
  if (
    !session?.user?.id ||
    !purchase_id ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(purchase_id)
  )
    return <main>Sign in to check your package purchase.</main>;
  const purchase = await getDb().query.packagePurchases.findFirst({
    where: eq(schema.packagePurchases.id, purchase_id),
  });
  if (!purchase || purchase.ownerUserId !== session.user.id)
    return <main>Package purchase unavailable.</main>;
  const state = await reconcilePackagePurchase(purchase.id);
  return (
    <main>
      {state === "granted"
        ? "Your prepaid sessions are available."
        : state === "requires_review"
          ? "Your package purchase needs review. Contact the business."
          : state === "expired"
            ? "This checkout expired. Start a new package purchase if you still need prepaid sessions."
            : "Your package payment is processing. Your prepaid sessions will become available after payment is confirmed."}
    </main>
  );
}
