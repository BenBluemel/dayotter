"use client";
import { AvailabilityEditor, type Override, type Range } from "@/components/availability-editor";
import { PageHeader } from "@/components/page-header";
import {
  ResourceRequirementsEditor,
  type ResourceService,
  resourceRequest,
} from "@/components/resource-requirements-editor";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/form";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { ResourceOpeningHours } from "@dayotter/db";
import { useState } from "react";

export interface ResourceDetails {
  id: string;
  organizationId: string;
  name: string;
  capacity: number;
  enabled: boolean;
  version: number;
  openingHours: ResourceOpeningHours | null;
}
export interface ResourceConfiguration {
  resources: ResourceDetails[];
  services: ResourceService[];
}
export function resourceHoursDraft(hours: ResourceOpeningHours) {
  return {
    timezone: hours.timezone,
    days: Array.from({ length: 7 }, (_, dow) =>
      hours.rules
        .filter((r) => r.dayOfWeek === dow)
        .map((r) => ({ start: r.startTime.slice(0, 5), end: r.endTime.slice(0, 5) })),
    ),
    overrides: hours.overrides.map((o) => ({
      date: o.date,
      start: o.startTime?.slice(0, 5) ?? null,
      end: o.endTime?.slice(0, 5) ?? null,
    })),
  };
}
export function resourceHoursFromDraft(d: {
  timezone: string;
  days: Range[][];
  overrides: Override[];
}): ResourceOpeningHours {
  return {
    timezone: d.timezone,
    rules: d.days.flatMap((ranges, dayOfWeek) =>
      ranges.map((r) => ({ dayOfWeek, startTime: r.start, endTime: r.end })),
    ),
    overrides: d.overrides.map((o) => ({ date: o.date, startTime: o.start, endTime: o.end })),
  };
}
export function ResourceDetailsForm({
  initial,
  saving,
  error,
  onSave,
}: {
  initial?: ResourceDetails;
  saving: boolean;
  error: string | null;
  onSave: (details: { name: string; capacity: number; enabled: boolean }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [capacity, setCapacity] = useState(initial?.capacity ?? 1);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ name, capacity, enabled });
      }}
    >
      <div>
        <Label htmlFor="resource-name">Resource name</Label>
        <Input
          id="resource-name"
          required
          maxLength={200}
          value={name}
          disabled={saving}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="resource-capacity">Capacity</Label>
        <Input
          id="resource-capacity"
          type="number"
          min={1}
          max={2147483647}
          step={1}
          required
          value={capacity}
          disabled={saving}
          onChange={(e) => setCapacity(Number(e.target.value))}
        />
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          How many units appointments can use at the same time.
        </p>
      </div>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          disabled={saving}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Enabled for new appointments
      </label>
      <p className="text-sm text-[var(--color-muted)]">
        Disabling keeps existing bookings and commitments. Capacity changes must still accommodate
        existing bookings and service requirements.
      </p>
      <FormError>{error}</FormError>
      <Button type="submit" disabled={saving}>
        {saving ? "Saving…" : initial ? "Save resource" : "Create resource"}
      </Button>
    </form>
  );
}
function ResourceEditor({
  resource,
  organizationId,
  timezone,
  onDone,
}: {
  resource?: ResourceDetails;
  organizationId: string;
  timezone: string;
  onDone: () => Promise<void>;
}) {
  const [current, setCurrent] = useState(resource);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [limited, setLimited] = useState(!!resource?.openingHours);
  const [saved, setSaved] = useState(false);
  const [hoursRevision, setHoursRevision] = useState(0);
  const [confirmClearHours, setConfirmClearHours] = useState(false);
  async function clearHours() {
    setSaving(true);
    setError(null);
    try {
      if (current?.openingHours) await patch({ openingHours: null });
      setLimited(false);
      setConfirmClearHours(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not clear resource hours.");
    } finally {
      setSaving(false);
    }
  }
  async function patch(values: unknown) {
    if (!current) throw new Error("Create the resource first.");
    const result = await resourceRequest("/api/resources", "PATCH", {
      organizationId,
      id: current.id,
      version: current.version,
      ...(values as object),
    });
    setCurrent(result.resource);
    setSaved(true);
  }
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title={current ? `Edit ${current.name}` : "Create resource"} />
        <CardBody>
          <ResourceDetailsForm
            initial={current}
            saving={saving}
            error={error}
            onSave={async (details) => {
              setSaving(true);
              setError(null);
              setSaved(false);
              try {
                if (current) await patch(details);
                else {
                  const result = await resourceRequest("/api/resources", "POST", {
                    organizationId,
                    ...details,
                  });
                  setCurrent(result.resource);
                  setSaved(true);
                }
              } catch (err) {
                setError(err instanceof Error ? err.message : "Could not save resource.");
              } finally {
                setSaving(false);
              }
            }}
          />
          {saved && (
            <p role="status" className="mt-3 text-sm text-[var(--color-success)]">
              Resource saved.
            </p>
          )}
          <Button
            className="mt-4"
            variant="outline"
            type="button"
            disabled={saving}
            onClick={() => void onDone()}
          >
            Back to resources / reload details
          </Button>
        </CardBody>
      </Card>
      <ConfirmDialog
        open={confirmClearHours}
        onClose={() => setConfirmClearHours(false)}
        onConfirm={() => void clearHours()}
        title="Remove resource hours?"
        description={
          <>
            <p>
              This removes resource-specific opening hours and discards unsaved hours edits. Service
              and staff schedules will still apply.
            </p>
            <FormError>{error}</FormError>
          </>
        }
        confirmLabel="Remove resource hours"
        loading={saving}
      />
      {current && (
        <>
          <Card>
            <CardHeader title="Resource opening hours" />
            <CardBody>
              <p className="mb-3 text-sm text-[var(--color-muted)]">
                Without resource hours, only the service and staff schedules restrict appointments.
                Resource hours use their own timezone and include appointment buffers.
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => {
                  if (!limited) setLimited(true);
                  else setConfirmClearHours(true);
                }}
              >
                {limited ? "Remove resource hours" : "Set resource hours"}
              </Button>
              {!limited && (
                <p className="mt-3 text-sm">No resource-specific opening-hour restriction.</p>
              )}
            </CardBody>
          </Card>
          {limited && (
            <AvailabilityEditor
              key={hoursRevision}
              allowInitialSave={!current.openingHours}
              resourceHours
              disabled={saving}
              initial={resourceHoursDraft(
                current.openingHours ?? { timezone, rules: [], overrides: [] },
              )}
              onSave={async (draft) => {
                setSaving(true);
                try {
                  await patch({ openingHours: resourceHoursFromDraft(draft) });
                  setHoursRevision((v) => v + 1);
                } finally {
                  setSaving(false);
                }
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
export function ResourcesManager({
  organizations,
  initial,
}: {
  organizations: { id: string; name: string; businessTimezone: string }[];
  initial: ResourceConfiguration;
}) {
  const [organizationId, setOrganizationId] = useState(organizations[0]!.id);
  const [data, setData] = useState(initial);
  const [editing, setEditing] = useState<string | null>(null);
  const [serviceId, setServiceId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const org = organizations.find((o) => o.id === organizationId)!;
  async function reload(id = organizationId) {
    setLoading(true);
    setError(null);
    try {
      const next = await resourceRequest(`/api/resources?organizationId=${id}`, "GET");
      setData(next);
      setOrganizationId(id);
      setEditing(null);
      setServiceId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load resources.");
    } finally {
      setLoading(false);
    }
  }
  const service = data.services.find((s) => s.id === serviceId);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Resources"
        description="Set up shared equipment and tell services what they need. Capacity limits how many appointments can use it at once."
      />
      <div>
        <Label htmlFor="resource-organization">Organization</Label>
        <Select
          id="resource-organization"
          value={organizationId}
          disabled={loading || editing !== null || !!serviceId}
          onChange={(e) => void reload(e.target.value)}
        >
          {organizations.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
      </div>
      <FormError>{error}</FormError>
      {editing !== null ? (
        <ResourceEditor
          key={`${organizationId}:${editing}`}
          resource={data.resources.find((r) => r.id === editing)}
          organizationId={organizationId}
          timezone={org.businessTimezone}
          onDone={() => reload()}
        />
      ) : service ? (
        <>
          <ResourceRequirementsEditor
            key={service.id}
            organizationId={organizationId}
            service={service}
            resources={data.resources}
          />
          <Button variant="outline" disabled={loading} onClick={() => void reload()}>
            Back to resources / reload details
          </Button>
        </>
      ) : (
        <>
          <Card>
            <CardHeader
              title="Organization resources"
              action={
                <Button disabled={loading} onClick={() => setEditing("new")}>
                  Create resource
                </Button>
              }
            />
            <CardBody>
              {!data.resources.length && (
                <p className="text-sm text-[var(--color-muted)]">
                  No resources configured. Create your first resource, then assign it to a service
                  below.
                </p>
              )}
              <ul className="divide-y divide-[var(--color-border)]">
                {data.resources.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0 flex-1 break-words">
                      <p className="font-medium">{r.name}</p>
                      <p className="text-sm text-[var(--color-muted)]">
                        Capacity {r.capacity} · {r.enabled ? "Enabled" : "Disabled"} ·{" "}
                        {r.openingHours ? "Resource hours set" : "Unrestricted resource hours"}
                      </p>
                      <p className="text-sm text-[var(--color-muted)]">
                        Required by:{" "}
                        {data.services
                          .filter((s) => s.requirements.some((q) => q.id === r.id))
                          .map((s) => s.title)
                          .join(", ") || "No services"}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      aria-label={`Edit ${r.name}`}
                      disabled={loading}
                      onClick={() => setEditing(r.id)}
                    >
                      Edit
                    </Button>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
          <Card>
            <CardHeader
              title="Service resource requirements"
              description="Manage requirements separately from other service settings."
            />
            <CardBody>
              <ul className="space-y-3">
                {data.services.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-3">
                    <span className="min-w-0 flex-1 break-words">
                      {s.title} ·{" "}
                      {s.requirements.length
                        ? `${s.requirements.length} required resources`
                        : "No resources required"}
                      {!s.managed && s.requirements.length > 0 ? " · Awaiting activation" : ""}
                    </span>
                    <Button
                      variant="outline"
                      aria-label={`Edit requirements for ${s.title}`}
                      disabled={loading}
                      onClick={() => setServiceId(s.id)}
                    >
                      Edit requirements
                    </Button>
                  </li>
                ))}
              </ul>
              {!data.services.length && <p>No services available. Create a booking type first.</p>}
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
