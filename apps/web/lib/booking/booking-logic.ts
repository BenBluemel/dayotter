import { classifyResourceError } from "@dayotter/db";
/** Pure booking helpers - no I/O - so they can be unit-tested directly. */

export class BookingError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class ResourceInvariantError extends Error {
  constructor(
    readonly identity: string,
    cause: unknown,
  ) {
    super("Scheduling data requires technical review", { cause });
  }
}

/** Public routes cannot send payment facts, but internal callers must also fail closed. */
export function assertExclusiveSettlement(input: {
  payment?: unknown;
  redeemCredit?: boolean;
}): void {
  if (input.payment != null && input.redeemCredit) {
    throw new BookingError(
      "A booking cannot both redeem a package credit and take a cash payment",
      400,
    );
  }
}

interface IntakeQuestion {
  id: string;
  label: string;
  type: string;
  required: boolean;
}

/**
 * Enforce an event type's required intake questions against a booker's answers.
 * Throws `BookingError(400)` naming the first unanswered required question.
 * Checkboxes must be exactly `true`; other fields must be a non-empty string.
 */
export function validateResponses(
  questions: IntakeQuestion[] | null | undefined,
  responses: Record<string, unknown> | null | undefined,
): void {
  const answers = responses ?? {};
  for (const q of questions ?? []) {
    if (!q.required) continue;
    const v = answers[q.id];
    const answered = q.type === "checkbox" ? v === true : typeof v === "string" && v.trim() !== "";
    if (!answered) throw new BookingError(`Please answer: ${q.label}`, 400);
  }
}

/**
 * Classify an error thrown while inserting a booking:
 * - a `BookingError` passes through unchanged,
 * - a Postgres unique violation (23505 - the double-book guard) becomes a 409,
 * - anything else is rethrown as-is.
 * Always throws; never returns.
 */
export function mapInsertError(err: unknown): never {
  if (err instanceof BookingError) throw err;
  const resource = classifyResourceError(err);
  if (resource?.category === "invariant") throw new ResourceInvariantError(resource.identity, err);
  if (resource?.category === "conflict")
    throw new BookingError("That appointment is unavailable", 409);
  if (resource?.category === "transient") throw err;
  const failure = err as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  if ((failure.cause ?? failure).constraint === "booking_settlement_claim_conflict")
    throw new BookingError(
      "This booking request already has a settlement; retry the original request",
      409,
    );
  // 23505 = unique_violation (same-instant race); 23P01 = exclusion_violation
  // (the bookings_no_overlap GiST constraint catching a cross-duration overlap).
  const code = (failure.cause ?? failure)?.code;
  if (code === "23505" || code === "23P01") {
    throw new BookingError("That time was just booked", 409);
  }
  throw err;
}
