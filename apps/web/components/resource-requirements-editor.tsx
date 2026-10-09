"use client";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError, FormSuccess } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useState } from "react";

export interface ResourceOption {
  id: string;
  name: string;
  capacity: number;
  enabled: boolean;
}
export interface ResourceService {
  id: string;
  title: string;
  version: number;
  managed: boolean;
  requiresHost?: boolean;
  requirements: { id: string; quantity: number }[];
}
export async function resourceRequest(url: string, method: string, body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? "Could not save. Reload and try again.");
  return result;
}

/** Controlled rows keep disabled existing requirements visible and prevent duplicate selections. */
export function ResourceRequirementRows({
  resources,
  value,
  onChange,
  disabled = false,
}: {
  resources: ResourceOption[];
  value: { id: string; quantity: number }[];
  onChange: (rows: { id: string; quantity: number }[]) => void;
  disabled?: boolean;
}) {
  const available = resources.filter((r) => r.enabled && !value.some((v) => v.id === r.id));
  return (
    <div className="space-y-3">
      {!value.length && (
        <p className="text-sm text-[var(--color-muted)]">
          This service has no resource requirements.
        </p>
      )}
      {value.map((row, index) => (
        <div key={row.id} className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1 basis-48">
            <Select
              aria-label={`Required resource ${index + 1}`}
              className="w-full"
              value={row.id}
              disabled={disabled}
              onChange={(e) =>
                onChange(value.map((v, i) => (i === index ? { ...v, id: e.target.value } : v)))
              }
            >
              {!resources.some((r) => r.id === row.id) && (
                <option value={row.id}>Unavailable resource — remove or reload</option>
              )}
              {resources
                .filter((r) => r.id === row.id || (r.enabled && !value.some((v) => v.id === r.id)))
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                    {!r.enabled ? " (disabled)" : ""} · capacity {r.capacity}
                  </option>
                ))}
            </Select>
          </div>
          <Input
            aria-label={`Quantity for resource ${index + 1}`}
            className="w-24"
            type="number"
            min={1}
            max={2147483647}
            step={1}
            value={row.quantity}
            disabled={disabled}
            onChange={(e) =>
              onChange(
                value.map((v, i) => (i === index ? { ...v, quantity: Number(e.target.value) } : v)),
              )
            }
          />
          <Button
            type="button"
            variant="ghost"
            disabled={disabled}
            aria-label={`Remove resource ${index + 1}`}
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        disabled={disabled || !available.length}
        onClick={() => onChange([...value, { id: available[0]!.id, quantity: 1 }])}
      >
        Add resource
      </Button>
      {!resources.length && (
        <p className="text-sm text-[var(--color-muted)]">
          Create resources in organization settings first.
        </p>
      )}
      {value.some((v) => resources.some((r) => r.id === v.id && !r.enabled)) && (
        <p className="text-sm text-[var(--color-amber)]">
          A required resource is disabled. Its requirement is retained. Enable it or remove the
          requirement before changing this plan.
        </p>
      )}
    </div>
  );
}

export function ResourceRequirementsEditor({
  organizationId,
  service,
  resources,
}: { organizationId: string; service: ResourceService; resources: ResourceOption[] }) {
  const [requiresHost, setRequiresHost] = useState(service.requiresHost ?? true);
  const [savedRequiresHost, setSavedRequiresHost] = useState(service.requiresHost ?? true);
  const [rows, setRows] = useState(service.requirements);
  const [version, setVersion] = useState(service.version);
  const [savedRows, setSavedRows] = useState(service.requirements);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty =
    requiresHost !== savedRequiresHost || JSON.stringify(rows) !== JSON.stringify(savedRows);
  return (
    <Card>
      <CardHeader
        title="Resources required"
        description="Choose what this service needs and how many units each appointment uses."
      />
      <CardBody>
        {!service.managed && (
          <p className="mb-4 text-sm text-[var(--color-amber)]">
            Requirements are staged until an operator activates resource scheduling. Services with
            staged requirements do not offer public availability. Existing checkout sessions and
            bookings must be reviewed before activation.
          </p>
        )}
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setSaving(true);
            setError(null);
            setSaved(false);
            try {
              const result = await resourceRequest("/api/resource-requirements", "PUT", {
                organizationId,
                eventTypeId: service.id,
                version,
                requirements: rows,
                requiresHost,
              });
              const current = result.service as ResourceService;
              setRequiresHost(current.requiresHost ?? true);
              setSavedRequiresHost(current.requiresHost ?? true);
              setVersion(current.version);
              setRows(current.requirements);
              setSavedRows(current.requirements);
              setSaved(true);
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not save requirements.");
            } finally {
              setSaving(false);
            }
          }}
        >
          <div className="space-y-2">
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={requiresHost}
                disabled={saving}
                onChange={(e) => {
                  setRequiresHost(e.target.checked);
                  setSaved(false);
                }}
              />
              Requires host availability
            </label>
            <p className="text-sm text-[var(--color-muted)]">
              Turn off for a resource-only service. The host stays responsible and receives
              notifications, but their other appointments do not block this service. At least one
              resource is required. The selected schedule still sets service hours. Existing
              bookings keep their accepted policy.
            </p>
          </div>
          <ResourceRequirementRows
            resources={resources}
            value={rows}
            onChange={(r) => {
              setRows(r);
              setSaved(false);
            }}
            disabled={saving}
          />
          <FormError>{error}</FormError>
          <FormSuccess>{saved ? "Resource requirements saved." : null}</FormSuccess>
          <Button type="submit" disabled={saving || !dirty || (!requiresHost && !rows.length)}>
            {saving ? "Saving…" : "Save requirements"}
          </Button>
          <p className="text-sm text-[var(--color-muted)]">
            Existing bookings keep their accepted resource commitments. These settings are saved
            separately from other service details.
          </p>
        </form>
      </CardBody>
    </Card>
  );
}
