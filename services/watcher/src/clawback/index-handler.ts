import type { MorrowEvent } from "@morrow/core-ts";
import type { EventHandler } from "../loop.js";
import type { JobStore } from "./jobs.js";

/**
 * Records every `op_frozen` op per Vault. The runner reads it to find clawback ops (whose coins
 * are reserved for good) and frozen or signed ops that compete for the coins it sweeps.
 */
export class ClawbackIndexHandler implements EventHandler {
  readonly name = "clawback-index";

  constructor(private readonly jobs: JobStore) {}

  async handle(event: MorrowEvent): Promise<void> {
    if (event.kind !== "op_frozen") return;
    await this.jobs.recordFrozenOp(event.vault_id, {
      op_id: event.data.op_id,
      kind: event.data.kind,
    });
  }
}
