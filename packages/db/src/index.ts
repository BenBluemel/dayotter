export * from "./client";
export * as schema from "./schema/index";
export type { RoutingField, RoutingRoute } from "./schema/routing";
export {
  eq,
  ne,
  and,
  or,
  gte,
  lte,
  gt,
  lt,
  inArray,
  isNull,
  isNotNull,
  sql,
  desc,
  asc,
} from "drizzle-orm";
export {
  allocateBookingResources,
  releaseBookingResources,
  classifyResourceError,
  withResourceTransaction,
  type ResourceErrorIdentity,
} from "./resources";

export type { ResourceOpeningHours } from "./schema/resources";
