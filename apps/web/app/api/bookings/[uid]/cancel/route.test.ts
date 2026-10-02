import { beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ cancel: vi.fn(), series: vi.fn() }));
vi.mock("@/lib/booking/cancel-booking", () => ({
  cancelBookingWithResult: mock.cancel,
  cancelBookingSeries: mock.series,
}));
vi.mock("@/lib/server/rate-limit", () => ({ enforceRateLimit: async () => null }));
import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
});
const request = () =>
  new Request("https://example.test/api/bookings/capability/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
it.each(["processing", "requires_review", "refunded"])(
  "reports durable refund %s without exposing financial identifiers",
  async (refund) => {
    mock.cancel.mockResolvedValue({ changed: true, refund });
    const response = await POST(request(), { params: Promise.resolve({ uid: "capability" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, cancelled: 1, refund });
  },
);
it("accepts an already cancelled booking while re-driving its incomplete refund", async () => {
  mock.cancel.mockResolvedValue({ changed: false, refund: "processing" });
  const response = await POST(request(), { params: Promise.resolve({ uid: "capability" }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, cancelled: 0, refund: "processing" });
});
it("returns not found only when the capability does not identify a booking", async () => {
  mock.cancel.mockResolvedValue(null);
  const response = await POST(request(), { params: Promise.resolve({ uid: "unknown" }) });
  expect(response.status).toBe(404);
});
