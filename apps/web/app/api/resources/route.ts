import {
  createResource,
  listResourceConfiguration,
  updateResource,
} from "@/lib/resources/configuration";
import { configurationErrorResponse } from "@/lib/resources/http";
import { jsonError, withUser } from "@/lib/server/http";
import { getDb } from "@dayotter/db";
import { NextResponse } from "next/server";
import { z } from "zod";
export const dynamic = "force-dynamic";
export const GET = withUser(async (user, request) => {
  const org = z.string().uuid().safeParse(new URL(request.url).searchParams.get("organizationId"));
  if (!org.success) return jsonError("Choose an organization.", 400);
  try {
    return NextResponse.json(await listResourceConfiguration(getDb(), user.id, org.data));
  } catch (error) {
    return configurationErrorResponse(error);
  }
});
export const POST = withUser(async (user, request) => {
  try {
    return NextResponse.json(
      { resource: await createResource(getDb(), user.id, await request.json().catch(() => null)) },
      { status: 201 },
    );
  } catch (error) {
    return configurationErrorResponse(error);
  }
});
export const PATCH = withUser(async (user, request) => {
  try {
    return NextResponse.json({
      resource: await updateResource(getDb(), user.id, await request.json().catch(() => null)),
    });
  } catch (error) {
    return configurationErrorResponse(error);
  }
});
