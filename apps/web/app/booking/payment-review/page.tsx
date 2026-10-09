export default function PaymentReviewPage() {
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-md flex-col items-center justify-center px-6 text-center">
      <h1 className="font-display text-2xl">Your booking needs review</h1>
      <p className="mt-2 text-sm text-[var(--color-muted)]">
        We could not automatically confirm your booking. Please contact the business so it can check
        your payment and arrange the next step. Do not submit another payment while this is being
        reviewed.
      </p>
    </main>
  );
}
