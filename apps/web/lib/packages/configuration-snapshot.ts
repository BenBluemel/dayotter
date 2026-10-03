import type { Database } from "@dayotter/db";
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** FOR SHARE can follow a concurrently updated row at READ COMMITTED. Preserve one
 * coherent package/service/merchant decision; retry the DB work, never Stripe. */
export async function packageConfigurationSnapshot<T>(
  db: Database,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  for (let retry = 0; ; retry++) {
    try {
      return await db.transaction(work, { isolationLevel: "repeatable read" });
    } catch (err) {
      const failure = err as {
        code?: string;
        constraint?: string;
        cause?: { code?: string; constraint?: string };
      };
      const detail = failure.cause ?? failure;
      if (
        retry < 2 &&
        (detail.code === "40001" ||
          (detail.code === "23505" &&
            ["package_purchase_request_idx", "package_mutation_operation_idx"].includes(
              detail.constraint ?? "",
            )))
      )
        continue;
      throw err;
    }
  }
}
