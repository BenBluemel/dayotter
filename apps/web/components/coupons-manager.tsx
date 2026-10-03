"use client";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { minorPerUnit } from "@/lib/booking/money";
import { DateTime } from "luxon";
import { useEffect, useState } from "react";

type Org = { id: string; name: string; businessTimezone: string };
type Service = {
  id: string;
  organizationId: string;
  title: string;
  currency: string | null;
  isActive: boolean;
};
type Coupon = {
  id: string;
  code: string;
  label: string | null;
  isActive: boolean;
  discountKind: "percentage" | "fixed";
  discountValue: number;
  currency: string | null;
  startsAt: string;
  endsAt: string;
  validityTimezone: string;
  minimumBasePrice: number | null;
  globalLimit: number | null;
  perCustomerLimit: number | null;
  eventTypeIds: string[];
  consumed: number;
  reserved: number;
};
type Form = {
  id?: string;
  code: string;
  label: string;
  isActive: boolean;
  discountKind: "percentage" | "fixed";
  discountAmount: string;
  currency: string;
  startDate: string;
  endDate: string;
  minimumPurchase: string;
  globalLimit: string;
  perCustomerLimit: string;
  eventTypeIds: string[];
};
function blank(): Form {
  return {
    code: "",
    label: "",
    isActive: true,
    discountKind: "percentage",
    discountAmount: "",
    currency: "usd",
    startDate: "",
    endDate: "",
    minimumPurchase: "",
    globalLimit: "",
    perCustomerLimit: "",
    eventTypeIds: [],
  };
}
function minor(text: string, currency: string) {
  const amount = Number(text);
  return Number.isFinite(amount) ? Math.round(amount * minorPerUnit(currency)) : Number.NaN;
}
export function CouponsManager({
  organizations,
  services,
}: { organizations: Org[]; services: Service[] }) {
  const [orgId, setOrgId] = useState(organizations[0]?.id ?? "");
  const [zones, setZones] = useState<Record<string, string>>(
    Object.fromEntries(organizations.map((o) => [o.id, o.businessTimezone])),
  );
  const [zoneDraft, setZoneDraft] = useState(organizations[0]?.businessTimezone ?? "America/Boise");
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [form, setForm] = useState<Form>(blank);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Keep inactive services visible when editing: silently dropping a saved
  // restriction would change the coupon's scope if that service is reactivated.
  const currentServices = services.filter((s) => s.organizationId === orgId);
  const minimumCurrency =
    currentServices.find((s) => form.eventTypeIds.includes(s.id))?.currency ?? "usd";
  async function reload(id = orgId) {
    const response = await fetch(`/api/coupons?organizationId=${encodeURIComponent(id)}`);
    const body = await response.json();
    if (response.ok) setCoupons(body.coupons);
    else setError(body.error ?? "Could not load coupons");
  }
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/coupons?organizationId=${encodeURIComponent(orgId)}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Could not load coupons");
        return body.coupons;
      })
      .then((rows) => setCoupons(rows))
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [orgId]);
  function edit(c: Coupon) {
    setForm({
      id: c.id,
      code: c.code,
      label: c.label ?? "",
      isActive: c.isActive,
      discountKind: c.discountKind,
      discountAmount: String(
        c.discountValue /
          (c.discountKind === "percentage" ? 100 : minorPerUnit(c.currency ?? "usd")),
      ),
      currency: c.currency ?? "usd",
      startDate: DateTime.fromISO(c.startsAt).setZone(c.validityTimezone).toISODate() ?? "",
      endDate:
        DateTime.fromISO(c.endsAt).setZone(c.validityTimezone).minus({ days: 1 }).toISODate() ?? "",
      minimumPurchase:
        c.minimumBasePrice == null
          ? ""
          : String(
              c.minimumBasePrice /
                minorPerUnit(
                  services.find((s) => c.eventTypeIds.includes(s.id))?.currency ?? "usd",
                ),
            ),
      globalLimit: c.globalLimit?.toString() ?? "",
      perCustomerLimit: c.perCustomerLimit?.toString() ?? "",
      eventTypeIds: c.eventTypeIds,
    });
    setError(null);
    setNotice(null);
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setSaving(true);
    const request = {
      id: form.id,
      organizationId: orgId,
      code: form.code,
      label: form.label.trim() || null,
      isActive: form.isActive,
      discountKind: form.discountKind,
      discountValue: minor(
        form.discountAmount,
        form.discountKind === "percentage" ? "usd" : form.currency,
      ),
      currency: form.discountKind === "fixed" ? form.currency.toLowerCase() : null,
      startDate: form.startDate,
      endDate: form.endDate,
      minimumBasePrice: form.minimumPurchase ? minor(form.minimumPurchase, minimumCurrency) : null,
      globalLimit: form.globalLimit ? Number(form.globalLimit) : null,
      perCustomerLimit: form.perCustomerLimit ? Number(form.perCustomerLimit) : null,
      eventTypeIds: form.eventTypeIds,
    };
    const response = await fetch("/api/coupons", {
      method: form.id ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    }).catch(() => null);
    setSaving(false);
    if (!response) {
      setError("Could not connect to the server");
      return;
    }
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? "Check the coupon details");
      return;
    }
    setNotice(form.id ? "Coupon updated" : "Coupon created");
    setForm(blank());
    await reload();
  }
  async function saveZone() {
    setError(null);
    const response = await fetch("/api/coupons/timezone", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: orgId, businessTimezone: zoneDraft }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? "Could not save timezone");
      return;
    }
    setZones({ ...zones, [orgId]: body.businessTimezone });
    setNotice("Business timezone saved. Existing coupon dates and booking prices stay as saved.");
  }
  function field<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Coupons</h2>
        <p className="text-sm text-[var(--color-muted)]">
          Create codes for signed-in customers. The best single discount applies automatically.
        </p>
        {organizations.length > 1 ? (
          <>
            <Label htmlFor="coupon-org">Organization</Label>
            <Select
              id="coupon-org"
              value={orgId}
              onChange={(e) => {
                setOrgId(e.target.value);
                setZoneDraft(zones[e.target.value] ?? "America/Boise");
                setForm(blank());
              }}
            >
              {organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </>
        ) : null}
      </div>
      <div className="rounded-md border border-[var(--color-border)] p-4">
        <Label htmlFor="coupon-zone">Business timezone for coupon calendar dates</Label>
        <div className="mt-2 flex gap-2">
          <Input
            id="coupon-zone"
            value={zoneDraft}
            onChange={(e) => setZoneDraft(e.target.value)}
            placeholder="America/Boise"
          />
          <Button type="button" variant="outline" onClick={saveZone}>
            Save timezone
          </Button>
        </div>
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Start date is included; end date is included through the end of that local day. Current
          timezone: {zones[orgId]}.
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
      <form
        onSubmit={save}
        className="space-y-4 rounded-md border border-[var(--color-border)] p-4"
      >
        <h3 className="font-semibold">{form.id ? "Edit coupon" : "New coupon"}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="coupon-code">Code</Label>
            <Input
              id="coupon-code"
              required
              value={form.code}
              onChange={(e) => field("code", e.target.value)}
              placeholder="FRIEND50"
            />
          </div>
          <div>
            <Label htmlFor="coupon-label">Description (optional)</Label>
            <Input
              id="coupon-label"
              value={form.label}
              onChange={(e) => field("label", e.target.value)}
              placeholder="Friends and family"
            />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(e) => field("isActive", e.target.checked)}
          />{" "}
          Active
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="coupon-kind">Discount type</Label>
            <Select
              id="coupon-kind"
              value={form.discountKind}
              onChange={(e) => field("discountKind", e.target.value as Form["discountKind"])}
            >
              <option value="percentage">Percent off</option>
              <option value="fixed">Fixed amount off</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="coupon-amount">
              {form.discountKind === "percentage" ? "Percent off" : "Amount off"}
            </Label>
            <Input
              id="coupon-amount"
              type="number"
              min="0.01"
              max={form.discountKind === "percentage" ? "100" : undefined}
              step={
                form.discountKind === "fixed" && minorPerUnit(form.currency) === 1 ? "1" : "0.01"
              }
              required
              value={form.discountAmount}
              onChange={(e) => field("discountAmount", e.target.value)}
            />
          </div>
          {form.discountKind === "fixed" ? (
            <div>
              <Label htmlFor="coupon-currency">Currency</Label>
              <Input
                id="coupon-currency"
                value={form.currency}
                maxLength={3}
                onChange={(e) => field("currency", e.target.value)}
              />
            </div>
          ) : null}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="coupon-start">First valid appointment date</Label>
            <Input
              id="coupon-start"
              type="date"
              required
              value={form.startDate}
              onChange={(e) => field("startDate", e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="coupon-end">Last valid appointment date</Label>
            <Input
              id="coupon-end"
              type="date"
              required
              value={form.endDate}
              onChange={(e) => field("endDate", e.target.value)}
            />
          </div>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Applicable services</legend>
          {currentServices.map((s) => (
            <label key={s.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.eventTypeIds.includes(s.id)}
                onChange={(e) =>
                  field(
                    "eventTypeIds",
                    e.target.checked
                      ? [...form.eventTypeIds, s.id]
                      : form.eventTypeIds.filter((id) => id !== s.id),
                  )
                }
              />
              {s.title} ({(s.currency ?? "usd").toUpperCase()}){!s.isActive ? " · inactive" : ""}
            </label>
          ))}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="coupon-min">Minimum regular price (optional)</Label>
            <Input
              id="coupon-min"
              type="number"
              min="0"
              step={minorPerUnit(minimumCurrency) === 1 ? "1" : "0.01"}
              value={form.minimumPurchase}
              onChange={(e) => field("minimumPurchase", e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="coupon-global">Maximum total bookings (blank = unlimited)</Label>
            <Input
              id="coupon-global"
              type="number"
              min="1"
              step="1"
              value={form.globalLimit}
              onChange={(e) => field("globalLimit", e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="coupon-customer">Maximum per customer (blank = unlimited)</Label>
            <Input
              id="coupon-customer"
              type="number"
              min="1"
              step="1"
              value={form.perCustomerLimit}
              onChange={(e) => field("perCustomerLimit", e.target.value)}
            />
          </div>
        </div>
        <div className="flex gap-2">
          <Button type="submit" disabled={saving || !form.eventTypeIds.length}>
            {saving ? "Saving…" : form.id ? "Save changes" : "Create coupon"}
          </Button>
          {form.id ? (
            <Button type="button" variant="outline" onClick={() => setForm(blank())}>
              Cancel edit
            </Button>
          ) : null}
        </div>
      </form>
      <div>
        <h3 className="mb-3 font-semibold">Existing coupons</h3>
        <div className="space-y-2">
          {coupons.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between gap-3 rounded-md border border-[var(--color-border)] p-3 text-sm"
            >
              <div>
                <strong>{c.code}</strong> {c.label ? `· ${c.label}` : ""}{" "}
                {!c.isActive ? "· Inactive" : ""}
                <p className="text-[var(--color-muted)]">
                  {c.consumed} booked · {c.reserved} in checkout ·{" "}
                  {c.globalLimit == null ? "No total limit" : `${c.globalLimit} total limit`}
                </p>
              </div>
              <Button type="button" variant="outline" onClick={() => edit(c)}>
                Edit
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
