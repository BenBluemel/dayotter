import { AvailabilityEditor } from "@/components/availability-editor";
import { SETTINGS_NAV } from "@/components/nav-items";
import {
  ResourceRequirementRows,
  ResourceRequirementsEditor,
  resourceRequest,
} from "@/components/resource-requirements-editor";
import {
  ResourceDetailsForm,
  ResourcesManager,
  resourceHoursDraft,
  resourceHoursFromDraft,
} from "@/components/resources-manager";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
const render = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(element);
const equipment = { id: "equipment", name: "Shared equipment", capacity: 2, enabled: true };
describe("native resource administration UI", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("adds Resources to settings navigation", () =>
    expect(SETTINGS_NAV).toContainEqual({ href: "/settings/resources", label: "Resources" }));
  it("provides organization selection and useful resource/service empty states", () => {
    const html = render(
      createElement(ResourcesManager, {
        organizations: [
          { id: "org", name: "Example organization", businessTimezone: "America/Boise" },
        ],
        initial: { resources: [], services: [] },
      }),
    );
    expect(html).toContain("No resources configured");
    expect(html).toContain("Create resource");
    expect(html).toContain("Create a booking type first");
    expect(html).toContain("Example organization");
  });
  it("create form has labelled validated capacity and enabled controls", () => {
    const html = render(
      createElement(ResourceDetailsForm, { saving: false, error: null, onSave: () => {} }),
    );
    expect(html).toContain('for="resource-name"');
    expect(html).toContain('min="1"');
    expect(html).toContain('max="2147483647"');
    expect(html).toContain("Enabled for new appointments");
    expect(html).toContain("Create resource");
  });
  it("edit form preserves name/capacity/disabled state and presents actionable backend errors", () => {
    const html = render(
      createElement(ResourceDetailsForm, {
        initial: {
          ...equipment,
          organizationId: "org",
          version: 1,
          openingHours: null,
          enabled: false,
        },
        saving: false,
        error: "Existing bookings require more capacity.",
        onSave: () => {},
      }),
    );
    expect(html).toContain('value="Shared equipment"');
    expect(html).toContain('value="2"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Existing bookings require more capacity.");
    expect(html).toContain("Save resource");
  });
  it("shows empty requirements and disables add when no resource is available", () => {
    const html = render(
      createElement(ResourceRequirementRows, { resources: [], value: [], onChange: () => {} }),
    );
    expect(html).toContain("no resource requirements");
    expect(html).toContain("Create resources");
    expect(html).toMatch(/disabled=""[^>]*>Add resource/);
  });
  it("retains disabled resources and prevents duplicate choices", () => {
    const html = render(
      createElement(ResourceRequirementRows, {
        resources: [
          equipment,
          { id: "disabled", name: "Archived equipment", capacity: 1, enabled: false },
        ],
        value: [
          { id: equipment.id, quantity: 2 },
          { id: "disabled", quantity: 1 },
        ],
        onChange: () => {},
      }),
    );
    expect(html).toContain("Archived equipment (disabled)");
    expect(html).toContain("Its requirement is retained");
    expect(html.match(/Shared equipment/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Quantity for resource 1"');
    expect(html).toContain('value="2"');
  });
  it("staged requirements explain activation and separate service saves", () => {
    const html = render(
      createElement(ResourceRequirementsEditor, {
        organizationId: "org",
        service: {
          id: "service",
          title: "Consultation",
          version: 1,
          managed: false,
          requirements: [],
        },
        resources: [equipment],
      }),
    );
    expect(html).toContain("operator activates resource scheduling");
    expect(html).toContain("saved separately from other service details");
    expect(html).toContain("Existing bookings keep");
  });
  it("resource hours reuse weekly/date editor and preserve timezone and 24:00 boundaries", () => {
    const hours = {
      timezone: "UTC",
      rules: [{ dayOfWeek: 1, startTime: "00:00:00", endTime: "24:00:00" }],
      overrides: [{ date: "2030-03-10", startTime: null, endTime: null }],
    };
    const draft = resourceHoursDraft(hours);
    expect(resourceHoursFromDraft(draft)).toEqual({
      ...hours,
      rules: [{ dayOfWeek: 1, startTime: "00:00", endTime: "24:00" }],
    });
    const html = render(
      createElement(AvailabilityEditor, {
        initial: draft,
        resourceHours: true,
        onSave: async () => {},
      }),
    );
    expect(html).toContain("Date overrides");
    expect(html).toContain("including buffers");
    expect(html).toMatch(/>UTC</);
    expect(html).toContain('value="24:00"');
    expect(html).toContain('aria-label="Available on Monday"');
    expect(html).toContain("Save resource hours");
  });
  it("new explicit closed hours can be saved without inventing windows", () => {
    const html = render(
      createElement(AvailabilityEditor, {
        initial: { timezone: "America/Boise", days: Array.from({ length: 7 }, () => []) },
        resourceHours: true,
        allowInitialSave: true,
        onSave: async () => {},
      }),
    );
    expect(html).not.toMatch(/disabled=""[^>]*>Save resource hours/);
    expect(html).toContain("Unsaved changes");
  });
  it("preserves backend error messages and never treats a timeout as success", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ error: "Capacity cannot be reduced below existing bookings." }),
            { status: 409 },
          ),
        ),
    );
    await expect(resourceRequest("/api/resources", "PATCH", {})).rejects.toThrow(
      "Capacity cannot be reduced",
    );
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Request timed out")));
    await expect(resourceRequest("/api/resources", "POST", {})).rejects.toThrow(
      "Request timed out",
    );
  });
  it("disables resource-hours controls during another resource mutation", () => {
    const html = render(
      createElement(AvailabilityEditor, {
        initial: { timezone: "UTC", days: Array.from({ length: 7 }, () => []) },
        resourceHours: true,
        disabled: true,
        onSave: async () => {},
      }),
    );
    expect(html).toMatch(/<fieldset disabled="" aria-label="Resource opening hours"/);
  });
  it("Slice 6 shows default host attendance, resource-only explanation and accepted-booking policy", () => {
    const html = render(
      createElement(ResourceRequirementsEditor, {
        organizationId: "org",
        resources: [equipment],
        service: {
          id: "service",
          title: "Light Therapy",
          version: 1,
          managed: false,
          requirements: [],
        },
      }),
    );
    expect(html).toMatch(/type="checkbox"[^>]*checked=""/);
    expect(html).toContain("Requires host availability");
    expect(html).toContain("At least one resource is required");
    expect(html).toContain("Existing bookings keep their accepted policy");
  });
  it("Slice 6 resource-only UI preserves the owner and cannot save empty requirements", () => {
    const html = render(
      createElement(ResourceRequirementsEditor, {
        organizationId: "org",
        resources: [equipment],
        service: {
          id: "service",
          title: "Light Therapy",
          version: 1,
          managed: true,
          requiresHost: false,
          requirements: [],
        },
      }),
    );
    expect(html).not.toMatch(/type="checkbox"[^>]*checked=""/);
    expect(html).toContain("host stays responsible and receives notifications");
    expect(html).toMatch(/disabled=""[^>]*>Save requirements/);
  });
});
