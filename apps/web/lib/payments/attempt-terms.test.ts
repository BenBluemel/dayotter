import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appointmentRequestIdentity,
  attemptRoute,
  decodeAttempt,
  mayCreateSession,
  validateAttemptSession,
} from "./attempt-terms";

import { fixtureAttempt, fixtureSession } from "./attempt-fixtures";

const previousKey = process.env.ENCRYPTION_KEY;
beforeAll(() => {
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
});
afterAll(() => {
  if (previousKey === undefined) Reflect.deleteProperty(process.env, "ENCRYPTION_KEY");
  else process.env.ENCRYPTION_KEY = previousKey;
});

describe("frozen appointment checkout terms", () => {
  it("retains encrypted intent and authoritative promotion/deposit terms without Redis", () => {
    const attempt = fixtureAttempt();
    expect(attempt.bookingIntent).not.toContain("private-code");
    expect(decodeAttempt(attempt)).toMatchObject({
      input: { accessCode: "private-code" },
      quote: { effectivePrice: 4000, amountToCollect: 3500, promotion: { label: "October" } },
    });
  });
  it("binds stable operation identity to canonical booking input", () => {
    const input = decodeAttempt(fixtureAttempt()).input;
    expect(appointmentRequestIdentity(input, "/")).toEqual(
      appointmentRequestIdentity(
        { ...input, attendee: { timezone: "UTC", email: input.attendee.email, name: "Client" } },
        "/",
      ),
    );
    const id = randomUUID();
    expect(appointmentRequestIdentity(input, "/", id).key).toBe(
      appointmentRequestIdentity({ ...input, notes: "changed" }, "/", id).key,
    );
    expect(appointmentRequestIdentity(input, "/", id).fingerprint).not.toBe(
      appointmentRequestIdentity({ ...input, notes: "changed" }, "/", id).fingerprint,
    );
  });
  it("rejects changed quote/hash, routing and payment expectations", () => {
    const attempt = fixtureAttempt();
    expect(() => decodeAttempt({ ...attempt, amount: 4000 })).toThrow();
    expect(() =>
      decodeAttempt({ ...attempt, quote: { ...(attempt.quote as object), effectivePrice: 4900 } }),
    ).toThrow();
    expect(() => attemptRoute({ ...attempt, paymentMode: "direct" })).toThrow("saved direct");
    const session = fixtureSession(attempt);
    expect(validateAttemptSession(attempt, session)).toBeNull();
    for (const change of [
      { amount_total: 1 },
      { currency: "eur" },
      { livemode: true },
      { client_reference_id: randomUUID() },
      { metadata: { ...session.metadata, dest: "acct_wrong" } },
    ]) {
      expect(() => validateAttemptSession(attempt, { ...session, ...change })).toThrow();
    }
    expect(() => validateAttemptSession(attempt, session, true)).toThrow();
  });
  it("never recreates an old ambiguous checkout after its bounded retry deadline", () => {
    const attempt = fixtureAttempt();
    expect(mayCreateSession(attempt, new Date(attempt.creationDeadline.getTime() - 1))).toBe(true);
    expect(mayCreateSession(attempt, attempt.creationDeadline)).toBe(false);
    expect(mayCreateSession({ ...attempt, checkoutSessionId: "cs_saved" }, attempt.createdAt)).toBe(
      false,
    );
    expect(mayCreateSession({ ...attempt, state: "requires_review" }, attempt.createdAt)).toBe(
      false,
    );
  });
  it("reconstructs original account/destination/fee facts with no deployment mode input", () => {
    const attempt = fixtureAttempt();
    expect(attemptRoute(attempt)).toEqual({
      mode: "connect",
      organizationId: attempt.organizationId,
      environment: "test",
      chargeAccountId: "acct_platform",
      credentialContext: "primary",
      destinationAccountId: "acct_host",
      applicationFeeAmount: 175,
    });
  });
});
