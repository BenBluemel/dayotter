import type { NewCalendarEvent } from "@dayotter/calendar";
import { describe, expect, it, vi } from "vitest";
import { AppleCalendarAdapter } from "../../../../packages/calendar/src/providers/apple";
import { GoogleCalendarAdapter } from "../../../../packages/calendar/src/providers/google";
import { MicrosoftCalendarAdapter } from "../../../../packages/calendar/src/providers/microsoft";
const base: NewCalendarEvent = {
  title: "Light Therapy",
  start: new Date("2030-01-01T10:00Z"),
  end: new Date("2030-01-01T10:30Z"),
  timezone: "UTC",
  attendees: [{ email: "client@example.test" }],
};
describe("Slice 6 provider calendar awareness", () => {
  it.each([undefined, "opaque", "transparent"] as const)(
    "Google create and move preserve visibility with transparency=%s",
    async (transparency) => {
      const insert = vi.fn(async () => ({ data: { id: "event" } }));
      const update = vi.fn(async () => ({ data: { id: "event" } }));
      const adapter: GoogleCalendarAdapter = Object.assign(
        Object.create(GoogleCalendarAdapter.prototype),
        { api: { events: { insert, update } } },
      );
      await adapter.createEvent("calendar", { ...base, transparency });
      await adapter.updateEvent("calendar", "event", { ...base, transparency });
      for (const call of [insert.mock.calls[0], update.mock.calls[0]])
        expect(call).toEqual([
          expect.objectContaining({
            sendUpdates: "all",
            requestBody: expect.objectContaining({
              summary: "Light Therapy",
              transparency: transparency ?? "opaque",
              attendees: [{ email: "client@example.test", displayName: undefined }],
            }),
          }),
        ]);
    },
  );
  it.each([undefined, "opaque", "transparent"] as const)(
    "Microsoft create and move preserve visibility with transparency=%s",
    async (transparency) => {
      const post = vi.fn(async () => ({ id: "event" }));
      const patch = vi.fn(async () => ({ id: "event" }));
      const adapter: MicrosoftCalendarAdapter = Object.assign(
        Object.create(MicrosoftCalendarAdapter.prototype),
        { client: { api: () => ({ post, patch }) } },
      );
      await adapter.createEvent("calendar", { ...base, transparency });
      await adapter.updateEvent("calendar", "event", { ...base, transparency });
      for (const call of [post.mock.calls[0], patch.mock.calls[0]])
        expect(call).toEqual([
          expect.objectContaining({
            subject: "Light Therapy",
            showAs: transparency === "transparent" ? "free" : "busy",
            attendees: expect.arrayContaining([
              expect.objectContaining({
                emailAddress: { address: "client@example.test", name: undefined },
              }),
            ]),
          }),
        ]);
    },
  );
  it.each([undefined, "opaque", "transparent"] as const)(
    "CalDAV create and move encode actual ICS transparency=%s",
    async (transparency) => {
      const createCalendarObject = vi.fn(async () => undefined);
      const updateCalendarObject = vi.fn(async () => undefined);
      const adapter: AppleCalendarAdapter = Object.assign(
        Object.create(AppleCalendarAdapter.prototype),
        {
          client: { createCalendarObject, updateCalendarObject },
          calendars: [{ url: "https://calendar.example.test/" }],
        },
      );
      await adapter.createEvent("https://calendar.example.test/", { ...base, transparency });
      await adapter.updateEvent("https://calendar.example.test/", "event", {
        ...base,
        transparency,
      });
      const create = createCalendarObject.mock.calls[0] as unknown as [{ iCalString: string }];
      const update = updateCalendarObject.mock.calls[0] as unknown as [
        { calendarObject: { data: string } },
      ];
      for (const ics of [create[0].iCalString, update[0].calendarObject.data]) {
        expect(ics).toContain(
          `TRANSP:${transparency === "transparent" ? "TRANSPARENT" : "OPAQUE"}`,
        );
        expect(ics).toContain("SUMMARY:Light Therapy");
        expect(ics).toContain("MAILTO:client@example.test");
      }
    },
  );
});
