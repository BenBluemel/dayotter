import { getDb } from "@dayotter/db";
import { connection } from "@dayotter/jobs";
import { recoverAppointmentPayments } from "../lib/payments/recovery";
import { recoverRefundOperations } from "../lib/payments/refunds";

if (!process.env.DATABASE_URL)
  throw new Error("Recovery requires an explicitly configured DATABASE_URL");
try {
  console.log(await recoverAppointmentPayments(25));
  console.log(await recoverRefundOperations(25));
} finally {
  await getDb().$client.end();
  connection.disconnect();
}
