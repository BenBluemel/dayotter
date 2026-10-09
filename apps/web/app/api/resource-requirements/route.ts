import { saveRequirements } from "@/lib/resources/configuration";
import { configurationErrorResponse } from "@/lib/resources/http";
import { withUser } from "@/lib/server/http";
import { getDb } from "@dayotter/db";
import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export const PUT = withUser(async (user, request) => {
  try {
    return NextResponse.json(
      await saveRequirements(getDb(), user.id, await request.json().catch(() => null)),
    );
  } catch (error) {
    return configurationErrorResponse(error);
  }
});
