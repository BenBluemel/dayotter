export default function ProcessingPage() {
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-md flex-col items-center justify-center px-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-accent-soft)] text-2xl">
        …
      </div>
      <h1 className="font-display mt-5 text-2xl">Checking your booking</h1>
      <p className="mt-2 text-sm text-[var(--color-muted)]">
        Payment processing or booking confirmation is still pending. Your booking is confirmed only
        when its confirmation page is available. You do not need to submit another payment.
      </p>
    </main>
  );
}
