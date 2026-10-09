export default function PaymentFailedPage() {
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-md flex-col items-center justify-center px-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-danger)]/15 text-2xl text-[var(--color-danger)]">
        !
      </div>
      <h1 className="font-display mt-5 text-2xl">Booking not confirmed</h1>
      <p className="mt-2 text-sm text-[var(--color-muted)]">
        We couldn't confirm your booking. Please contact the business to check your payment and
        booking status before submitting another payment.
      </p>
    </main>
  );
}
