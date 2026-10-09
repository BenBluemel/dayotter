import { jsonError } from "@/lib/server/http";
import { classifyResourceError } from "@dayotter/db";
import { ZodError } from "zod";
import { ConfigurationError } from "./configuration";

export function configurationErrorResponse(error: unknown) {
  if (error instanceof ConfigurationError) return jsonError(error.message, error.status);
  if (error instanceof ZodError)
    return jsonError(
      "Check the resource name, quantities, and opening hours. Each resource may appear only once.",
      400,
    );
  const diagnostic = classifyResourceError(error);
  if (diagnostic && "identity" in diagnostic) {
    const messages = {
      resource_capacity_conflict:
        "Capacity must accommodate existing bookings and every service requirement. Keep the current capacity or lower the required quantity.",
      resource_disabled:
        "A required resource is disabled. Enable it or remove its requirement before saving. Existing requirements have been kept.",
      resource_closed: "The required interval is outside resource opening hours.",
      resource_adoption_required:
        "Existing bookings or payments prevent this change. Keep the current configuration and arrange an operator review.",
      resource_plan_completeness_violation:
        "Check the opening hours and resource quantities. Requirements need an individual service with a responsible host, one attendee, and no recurrence. Resource-only services need at least one resource.",
      resource_scope_violation: "Choose resources and services belonging to this organization.",
      resource_claim_lifecycle_violation:
        "Existing bookings prevent this change. Keep the current configuration and arrange an operator review.",
    };
    return jsonError(
      messages[diagnostic.identity],
      diagnostic.identity === "resource_scope_violation" ? 400 : 409,
    );
  }
  return jsonError("Could not save resource configuration. Reload and try again.", 503);
}
