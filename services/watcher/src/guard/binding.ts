import { createHash } from "node:crypto";
import { canonicalChangesJson, type Hex, type PolicyChange } from "@morrow/core-ts";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * What an Owner Confirmation is bound to:
 * `sha256("morrow-confirm:v1:" vault_id ":" change_id ":" sha256(canonical changes) ":" effective_at)`.
 * The guard recomputes it from `get_policy_change` before it skips a veto; any difference counts
 * as unconfirmed.
 */
export function changeBinding(
  change: Pick<PolicyChange, "vault_id" | "change_id" | "changes" | "effective_at">,
): Hex {
  const changes = sha256(canonicalChangesJson(change.changes));
  return sha256(
    `morrow-confirm:v1:${change.vault_id}:${change.change_id}:${changes}:${change.effective_at}`,
  );
}
