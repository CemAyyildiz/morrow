import type { BitcoinBackend } from "../bitcoin/backend.js";
import { txidOf } from "../bitcoin/browser-txid.js";
import type { ContractClient } from "../contract/client.js";
import { EVENTS_SINCE_MAX_LIMIT } from "../contract/client.js";
import { ERROR_CODES, MorrowContractError, parseContractError } from "../contract/errors.js";
import type { MorrowEvent } from "../contract/events.js";
import type {
  AccountId,
  Hex,
  ScriptPath,
  SpendOp,
  SpendOpState,
  SpendSource,
  U64,
  VaultKit,
  WitnessTemplate,
} from "../contract/types.js";
import { functionCall, functionCallError } from "./failure.js";
import { bitcoinTxUrl, nearTxUrl, type NearNetwork } from "./links.js";
import {
  NearRpcError,
  blockRef,
  decodeBase64,
  txStatusRef,
  viewRef,
  type NearRpc,
  type RpcBlockHeader,
  type RpcReceipt,
  type RpcTxStatus,
  type TxLocator,
} from "./ports.js";
import {
  XRayInputError,
  type BitcoinStage,
  type EventFacts,
  type MpcInput,
  type MpcStage,
  type Refusal,
  type RuleEvent,
  type RuleStage,
  type ScriptStage,
  type Sourced,
  type StageStatus,
  type XRay,
  type XRayInput,
} from "./types.js";

export interface XRayDeps {
  /** Only `get_op`, `get_vault_kit` and `events_since` are read. */
  contract: Pick<ContractClient, "getOp" | "getVaultKit" | "eventsSince">;
  /** The Vault Contract account the client talks to. */
  contractId: AccountId;
  nearNetwork: NearNetwork;
  /** Archival RPC: transaction status, historical views, block headers. */
  rpc: NearRpc;
  /** Finds NEAR transaction hashes (hints first, then an indexer). */
  locator: TxLocator;
  bitcoin: Pick<BitcoinBackend, "getTx">;
  /** Non-fatal lookup failures (indexer down, RPC miss). Defaults to `console.warn`. */
  log?: (message: string, error?: unknown) => void;
  /** Pages of 100 events to scan from the op's first event. Default 20. */
  maxEventPages?: number;
}

export const RECEIPTS_UNAVAILABLE = "receipts unavailable";

const DEFAULT_MAX_EVENT_PAGES = 20;

/** An op event, the `events_since` call that returned it, and its index in that page. */
interface FoundEvent {
  event: MorrowEvent;
  ref: string;
  index: number;
}

const TERMINAL_EVENTS = new Set(["op_signed", "withdrawal_cancelled", "op_voided"]);
const SIGNER_RESPONSE_METHOD = "return_signature_and_clean_state_on_success";

/** Assembles the four X-Ray stages for one op or one refused call, from chain data only. */
export async function buildXRay(input: XRayInput, deps: XRayDeps): Promise<XRay> {
  const ctx = new Context(deps);
  return "opId" in input ? ctx.forOp(input.opId) : ctx.forRefusal(input.refusedTx);
}

function sourced<T>(value: T, ref: string, url: string | null = null): Sourced<T> {
  return { value, source: { ref, url } };
}

/** `ref` plus the field inside the result the value was taken from. */
function at(ref: string, path: string): string {
  return `${ref} → ${path}`;
}

const notReached = {
  mpc: (): MpcStage => ({ status: "not_reached", inputs: [] }),
  bitcoin: (): BitcoinStage => ({
    status: "not_reached",
    txid: null,
    confirmations: null,
    blockHeight: null,
  }),
  script: (): ScriptStage => ({
    status: "not_reached",
    path: null,
    coinSource: null,
    scriptHex: null,
    address: null,
    template: null,
  }),
};

function parseJson(base64: string | undefined): unknown {
  if (base64 === undefined || base64 === "") return null;
  try {
    return JSON.parse(decodeBase64(base64));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class Context {
  private configSigner: Promise<Sourced<AccountId> | null> | null = null;

  constructor(private readonly deps: XRayDeps) {}

  private get contractId(): AccountId {
    return this.deps.contractId;
  }

  private log(message: string, error?: unknown): void {
    (this.deps.log ?? ((m: string, e?: unknown) => console.warn(m, e)))(message, error);
  }

  private nearUrl(hash: string): string {
    return nearTxUrl(this.deps.nearNetwork, hash);
  }

  private opRef(opId: U64): string {
    return viewRef(this.contractId, "get_op", { op_id: opId });
  }

  private kitRef(vaultId: U64): string {
    return viewRef(this.contractId, "get_vault_kit", { vault_id: vaultId });
  }

  private async getOp(opId: U64): Promise<SpendOp | null> {
    try {
      return await this.deps.contract.getOp(opId);
    } catch (error) {
      if (error instanceof MorrowContractError && error.code === "ERR_OP_NOT_FOUND") return null;
      throw error;
    }
  }

  private async getKit(vaultId: U64): Promise<VaultKit | null> {
    try {
      return await this.deps.contract.getVaultKit(vaultId);
    } catch (error) {
      this.log(`X-Ray: get_vault_kit(${vaultId}) failed`, error);
      return null;
    }
  }

  // Op X-Ray

  async forOp(opId: U64): Promise<XRay> {
    if (!/^\d+$/.test(opId)) throw new XRayInputError(`Not an op id: ${opId}`);
    const op = await this.getOp(opId);
    if (!op) throw new XRayInputError(`No op ${opId} on ${this.contractId}`);
    const opRef = this.opRef(op.op_id);
    const kit = await this.getKit(op.vault_id);
    const events = await this.opEvents(op);
    const mpc = await this.mpcStage(op);
    return {
      opId: sourced(op.op_id, at(opRef, "op_id")),
      vaultId: sourced(op.vault_id, at(opRef, "vault_id")),
      btcNetwork: kit
        ? sourced(kit.btc_network, at(this.kitRef(op.vault_id), "btc_network"))
        : null,
      script: this.scriptStage(op.vault_id, op, kit),
      rule: this.ruleStage(op, events),
      mpc,
      bitcoin: await this.bitcoinStage(op, kit),
    };
  }

  /** Path from the op: its frozen witness template, else `withdrawal` for a withdrawal. */
  private opPath(op: SpendOp): Sourced<ScriptPath> | null {
    const opRef = this.opRef(op.op_id);
    if (op.witness_template) {
      return sourced(op.witness_template.path, at(opRef, "witness_template.path"));
    }
    if (op.kind === "withdrawal") return sourced("withdrawal", at(opRef, "kind"));
    return null;
  }

  /** Stage 1. `fallback` names the path when there is no op (a refused call). */
  private scriptStage(
    vaultId: U64 | null,
    op: SpendOp | null,
    kit: VaultKit | null,
    fallback?: { path: Sourced<ScriptPath>; coinSource: Sourced<SpendSource> },
  ): ScriptStage {
    const path = (op && this.opPath(op)) ?? fallback?.path ?? null;
    const coinSource = op
      ? sourced(op.source, at(this.opRef(op.op_id), "source"))
      : (fallback?.coinSource ?? null);
    if (!path || !coinSource) return notReached.script();
    const kitRef = vaultId === null ? null : this.kitRef(vaultId);
    const template =
      op?.witness_template != null
        ? sourced(op.witness_template, at(this.opRef(op.op_id), "witness_template"))
        : kit && kitRef
          ? (() => {
              const fromKit = kit.witness_templates[path.value] as WitnessTemplate | undefined;
              return fromKit === undefined
                ? null
                : sourced(fromKit, at(kitRef, `witness_templates.${path.value}`));
            })()
          : null;
    const scriptKey =
      coinSource.value === "allowance" ? "allowance_script_hex" : "vault_script_hex";
    return {
      // No kit for a known Vault means the get_vault_kit lookup failed.
      status: kit ? "done" : vaultId !== null ? "failed" : "not_reached",
      path,
      coinSource,
      scriptHex: kit && kitRef ? sourced(kit[scriptKey], at(kitRef, scriptKey)) : null,
      address:
        kit && kitRef
          ? sourced(kit.addresses[coinSource.value], at(kitRef, `addresses.${coinSource.value}`))
          : null,
      template,
    };
  }

  /** Smallest cursor whose next event is at or after `createdAt` (or past the end). */
  private async firstCursorAtOrAfter(createdAt: bigint): Promise<bigint> {
    const ok = async (cursor: bigint) => {
      const [event] = await this.deps.contract.eventsSince(cursor.toString(), 1);
      return !event || BigInt(event.block_timestamp) >= createdAt;
    };
    if (await ok(0n)) return 0n;
    let lo = 0n;
    let hi = 1n;
    while (!(await ok(hi))) {
      lo = hi;
      hi *= 2n;
    }
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      if (await ok(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  }

  /** The op's events, from its creation block up to its terminal event. */
  private async opEvents(op: SpendOp): Promise<FoundEvent[]> {
    let cursor = await this.firstCursorAtOrAfter(BigInt(op.created_at));
    const out: FoundEvent[] = [];
    const maxPages = this.deps.maxEventPages ?? DEFAULT_MAX_EVENT_PAGES;
    for (let pages = 0; ; pages++) {
      if (pages === maxPages) {
        this.log(`X-Ray: stopped after ${maxPages} event pages for op ${op.op_id}`);
        return out;
      }
      const ref = `events_since ${JSON.stringify({ cursor: cursor.toString(), limit: EVENTS_SINCE_MAX_LIMIT })}`;
      const page = await this.deps.contract.eventsSince(cursor.toString(), EVENTS_SINCE_MAX_LIMIT);
      for (const [i, event] of page.entries()) {
        const data = event.data as unknown as Record<string, unknown>;
        if (event.vault_id !== op.vault_id || data.op_id !== op.op_id) continue;
        out.push({ event, ref, index: i });
        if (TERMINAL_EVENTS.has(event.kind)) return out;
      }
      const last = page.at(-1);
      if (!last || page.length < EVENTS_SINCE_MAX_LIMIT) return out;
      cursor = BigInt(last.seq);
    }
  }

  private ruleStage(op: SpendOp, events: FoundEvent[]): RuleStage {
    const opRef = this.opRef(op.op_id);
    const ruleEvents: RuleEvent[] = events.map(({ event, ref, index }) => {
      const facts: EventFacts = {};
      for (const [key, value] of Object.entries(event.data as unknown as Record<string, unknown>)) {
        if (
          value === null ||
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          facts[key] = sourced(value, at(ref, `[${index}].data.${key}`));
        }
      }
      return {
        seq: sourced(event.seq, at(ref, `[${index}].seq`)),
        kind: sourced(event.kind, at(ref, `[${index}].kind`)),
        blockTimestamp: sourced(event.block_timestamp, at(ref, `[${index}].block_timestamp`)),
        facts,
      };
    });
    const factOf = (kind: string, key: string): Sourced<U64> | null => {
      const fact = ruleEvents.find((e) => e.kind.value === kind)?.facts[key];
      return fact && typeof fact.value === "string" ? (fact as Sourced<U64>) : null;
    };
    return {
      status: "done",
      events: ruleEvents,
      opState: sourced(op.state, at(opRef, "state")),
      executableAt:
        op.executable_at === null ? null : sourced(op.executable_at, at(opRef, "executable_at")),
      feeSats: factOf("op_frozen", "fee_sats"),
      voidedBy: factOf("op_voided", "by_op_id"),
      refusal: null,
    };
  }

  private async signerFromConfig(): Promise<Sourced<AccountId> | null> {
    this.configSigner ??= (async () => {
      try {
        const config = await this.deps.rpc.viewAt(this.contractId, "get_config", {});
        const signer = isRecord(config) ? config.signer_account : undefined;
        if (typeof signer !== "string") return null;
        return sourced(signer, at(viewRef(this.contractId, "get_config", {}), "signer_account"));
      } catch (error) {
        this.log("X-Ray: get_config failed", error);
        return null;
      }
    })();
    return this.configSigner;
  }

  /** `sign_input` transactions for the op, keyed by input index; the one that stored wins. */
  private async signTxs(
    op: SpendOp,
  ): Promise<Map<number, { hash: string; sender: AccountId; tx: RpcTxStatus }>> {
    const byInput = new Map<number, { hash: string; sender: AccountId; tx: RpcTxStatus }>();
    // Nothing stored yet: no successful sign_input to show, so skip the indexer.
    if (op.signatures.every((s) => s === null)) return byInput;
    let refs;
    try {
      refs = await this.deps.locator.find(this.contractId, {
        method: "sign_input",
        opId: op.op_id,
        sinceNs: op.created_at,
      });
    } catch (error) {
      this.log(`X-Ray: no sign_input transactions found for op ${op.op_id}`, error);
      return byInput;
    }
    for (const ref of refs) {
      try {
        const sender = ref.senderId ?? (await this.deps.locator.senderOf?.(ref.hash)) ?? null;
        if (sender === null) {
          this.log(`X-Ray: unknown sender for ${ref.hash}`);
          continue;
        }
        const tx = await this.deps.rpc.txStatus(ref.hash, sender);
        if (tx.transaction.receiver_id !== this.contractId) continue;
        const call = tx.transaction.actions
          .map((a) => (typeof a === "string" ? null : (a.FunctionCall ?? null)))
          .find((fc) => fc?.method_name === "sign_input");
        const args = parseJson(call?.args);
        if (!isRecord(args) || args.op_id !== op.op_id || typeof args.input_index !== "number") {
          continue;
        }
        const index = args.input_index;
        const stored = this.callback(tx) !== null;
        const current = byInput.get(index);
        if (!current || (stored && this.callback(current.tx) === null)) {
          byInput.set(index, { hash: ref.hash, sender, tx });
        }
      } catch (error) {
        this.log(`X-Ray: tx status for ${ref.hash} failed`, error);
      }
    }
    return byInput;
  }

  /** The `on_signed` receipt and the value it returned, if it succeeded. */
  private callback(tx: RpcTxStatus): { receipt: RpcReceipt; value: string } | null {
    const receipt = tx.receipts.find(
      (r) =>
        r.receiver_id === this.contractId &&
        r.predecessor_id === this.contractId &&
        functionCall(r)?.method_name === "on_signed",
    );
    if (!receipt) return null;
    const outcome = tx.receipts_outcome.find((o) => o.id === receipt.receipt_id);
    const value = parseJson(outcome?.outcome.status.SuccessValue);
    return typeof value === "string" ? { receipt, value } : null;
  }

  private async mpcStage(op: SpendOp): Promise<MpcStage> {
    if (op.sighashes.length === 0) return notReached.mpc();
    const opRef = this.opRef(op.op_id);
    const txs = await this.signTxs(op);
    const closed = op.state === "voided" || op.state === "cancelled";
    const inputs: MpcInput[] = [];
    for (const [index, sighash] of op.sighashes.entries()) {
      const stored = op.signatures[index] ?? null;
      const input: MpcInput = {
        status: "pending",
        index: sourced(index, at(opRef, `sighashes[${index}]`)),
        sighash: sourced(sighash, at(opRef, `sighashes[${index}]`)),
        payload: null,
        domainId: null,
        path: null,
        signer: null,
        txHash: null,
        signReceiptId: null,
        responseReceiptId: null,
        callbackReceiptId: null,
        response: null,
        callbackValue: null,
        signature: stored === null ? null : sourced(stored, at(opRef, `signatures[${index}]`)),
        participants: null,
        threshold: null,
        protocol: null,
        note: null,
      };
      const found = txs.get(index);
      if (found) {
        await this.fillReceipts(input, found);
        // Only failed attempts were found for a stored signature.
        if (stored !== null && input.callbackReceiptId === null) input.note = RECEIPTS_UNAVAILABLE;
      } else {
        input.signer = await this.signerFromConfig();
        if (stored !== null) input.note = RECEIPTS_UNAVAILABLE;
      }

      const mismatches: string[] = [];
      if (input.payload && input.payload.value !== sighash) {
        mismatches.push("sign payload differs from get_op sighash");
      }
      // With no stored signature yet, a returned one means signing landed between the reads.
      if (input.callbackValue && stored !== null && input.callbackValue.value !== stored) {
        mismatches.push("on_signed value differs from get_op signature");
      }
      if (mismatches.length > 0) {
        input.status = "failed";
        input.note = mismatches.join("; ");
      } else {
        input.status = stored !== null ? "done" : closed ? "not_reached" : "pending";
      }
      inputs.push(input);
    }
    const statuses = inputs.map((i) => i.status);
    const status: StageStatus = statuses.includes("failed")
      ? "failed"
      : statuses.every((s) => s === "done")
        ? "done"
        : statuses.includes("pending")
          ? "pending"
          : "not_reached";
    return { status, inputs };
  }

  private async fillReceipts(
    input: MpcInput,
    found: { hash: string; sender: AccountId; tx: RpcTxStatus },
  ): Promise<void> {
    const { hash, sender, tx } = found;
    const ref = txStatusRef(hash, sender);
    const url = this.nearUrl(hash);
    const s = <T>(value: T, path: string): Sourced<T> => sourced(value, at(ref, path), url);
    input.txHash = s(tx.transaction.hash, "transaction.hash");

    const sign = tx.receipts.find(
      (r) => r.predecessor_id === this.contractId && functionCall(r)?.method_name === "sign",
    );
    if (sign) {
      const id = sign.receipt_id;
      const where = `receipts[receipt_id=${id}]`;
      input.signReceiptId = s(id, `${where}.receipt_id`);
      input.signer = s(sign.receiver_id, `${where}.receiver_id`);
      const args = parseJson(functionCall(sign)?.args);
      const request = isRecord(args) && isRecord(args.request) ? args.request : null;
      const payload =
        request && isRecord(request.payload_v2) ? request.payload_v2.Ecdsa : undefined;
      if (typeof payload === "string") {
        input.payload = s(payload, `${where}.args.request.payload_v2.Ecdsa`);
      }
      if (request && typeof request.path === "string") {
        input.path = s(request.path, `${where}.args.request.path`);
      }
      if (request && typeof request.domain_id === "number") {
        input.domainId = s(request.domain_id, `${where}.args.request.domain_id`);
      }

      const signOutcome = tx.receipts_outcome.find((o) => o.id === id);
      const nextId = signOutcome?.outcome.status.SuccessReceiptId;
      const response =
        tx.receipts.find((r) => r.receipt_id === nextId) ??
        tx.receipts.find(
          (r) =>
            r.receiver_id === sign.receiver_id &&
            functionCall(r)?.method_name === SIGNER_RESPONSE_METHOD,
        );
      if (response) {
        const rWhere = `receipts_outcome[id=${response.receipt_id}]`;
        input.responseReceiptId = s(response.receipt_id, `${rWhere}.id`);
        const outcome = tx.receipts_outcome.find((o) => o.id === response.receipt_id);
        const value = parseJson(outcome?.outcome.status.SuccessValue);
        if (isRecord(value)) input.response = s(value, `${rWhere}.outcome.status.SuccessValue`);
      }
      if (signOutcome) {
        await this.fillSignerState(input, sign.receiver_id, signOutcome.block_hash);
      }
    } else {
      input.signer = await this.signerFromConfig();
    }

    const callback = this.callback(tx);
    if (callback) {
      const cWhere = `receipts_outcome[id=${callback.receipt.receipt_id}]`;
      input.callbackReceiptId = s(callback.receipt.receipt_id, `${cWhere}.id`);
      input.callbackValue = s(callback.value, `${cWhere}.outcome.status.SuccessValue`);
    }
  }

  /** Participants, threshold and protocol from the signer's `state` at the `sign` block. */
  private async fillSignerState(
    input: MpcInput,
    signer: AccountId,
    blockHash: string,
  ): Promise<void> {
    let state: unknown;
    try {
      state = await this.deps.rpc.viewAt(signer, "state", {}, blockHash);
    } catch (error) {
      this.log(`X-Ray: ${signer} state at ${blockHash} failed`, error);
      return;
    }
    const ref = viewRef(signer, "state", {}, blockHash);
    const running = isRecord(state) && isRecord(state.Running) ? state.Running : null;
    const parameters = running && isRecord(running.parameters) ? running.parameters : null;
    const participants =
      parameters && isRecord(parameters.participants) ? parameters.participants.participants : null;
    if (Array.isArray(participants)) {
      input.participants = sourced(
        participants.length,
        at(ref, "Running.parameters.participants.participants.length"),
      );
    }
    const threshold = parameters?.threshold;
    const thresholdValue = isRecord(threshold) ? threshold.value : threshold;
    if (typeof thresholdValue === "number") {
      input.threshold = sourced(thresholdValue, at(ref, "Running.parameters.threshold"));
    }
    const domains =
      running && isRecord(running.domains) && Array.isArray(running.domains.domains)
        ? running.domains.domains
        : [];
    const domainId = input.domainId?.value ?? 0;
    const domain = domains.find((d) => isRecord(d) && d.id === domainId);
    if (isRecord(domain) && typeof domain.protocol === "string") {
      input.protocol = sourced(
        domain.protocol,
        at(ref, `Running.domains.domains[id=${domainId}].protocol`),
      );
    }
  }

  private async bitcoinStage(op: SpendOp, kit: VaultKit | null): Promise<BitcoinStage> {
    if (op.unsigned_tx_hex === null) return notReached.bitcoin();
    let txid: Hex;
    try {
      txid = txidOf(op.unsigned_tx_hex);
    } catch (error) {
      this.log(`X-Ray: unsigned_tx_hex of op ${op.op_id} does not parse`, error);
      return { ...notReached.bitcoin(), status: "failed" };
    }
    const url = kit ? bitcoinTxUrl(kit.btc_network, txid) : null;
    const stage: BitcoinStage = {
      status: "pending",
      txid: sourced(
        txid,
        at(
          this.opRef(op.op_id),
          "unsigned_tx_hex (txid = double SHA-256 of the tx without witnesses, reversed)",
        ),
        url,
      ),
      confirmations: null,
      blockHeight: null,
    };
    if (op.state === "voided" || op.state === "cancelled")
      return { ...stage, status: "not_reached" };
    if (op.state !== "signed") return stage;
    const ref = `BitcoinBackend.getTx ${JSON.stringify(txid)}`;
    let status;
    try {
      status = await this.deps.bitcoin.getTx(txid);
    } catch (error) {
      this.log(`X-Ray: getTx(${txid}) failed`, error);
      return { ...stage, status: "failed" };
    }
    if (!status) return stage;
    return {
      ...stage,
      status: status.confirmations > 0 ? "done" : "pending",
      confirmations: sourced(status.confirmations, at(ref, "confirmations"), url),
      blockHeight: sourced(status.block_height, at(ref, "block_height"), url),
    };
  }

  // Refused-call X-Ray

  async forRefusal(refused: { hash: string; senderId?: AccountId }): Promise<XRay> {
    const sender = refused.senderId ?? (await this.deps.locator.senderOf?.(refused.hash)) ?? null;
    if (sender === null) throw new XRayInputError(`Unknown sender for transaction ${refused.hash}`);
    let tx: RpcTxStatus;
    try {
      tx = await this.deps.rpc.txStatus(refused.hash, sender);
    } catch (error) {
      if (error instanceof NearRpcError && error.causeName === "UNKNOWN_TRANSACTION") {
        throw new XRayInputError(`Unknown transaction ${refused.hash}`);
      }
      throw error;
    }
    if (tx.transaction.receiver_id !== this.contractId) {
      throw new XRayInputError(`Transaction ${refused.hash} is not a call to ${this.contractId}`);
    }
    const failing = tx.receipts_outcome.find(
      (o) => o.outcome.executor_id === this.contractId && functionCallError(o) !== undefined,
    );
    if (!failing) throw new XRayInputError(`Transaction ${refused.hash} did not fail`);
    const parsed = parseContractError(JSON.stringify(functionCallError(failing)));
    if (!parsed) {
      throw new XRayInputError(`Transaction ${refused.hash} failed without an ERR_* code`);
    }

    const ref = txStatusRef(refused.hash, sender);
    const url = this.nearUrl(refused.hash);
    const where = `receipts_outcome[id=${failing.id}]`;
    const receipt = tx.receipts.find((r) => r.receipt_id === failing.id);
    let call = functionCall(receipt);
    let callPath = `receipts[receipt_id=${failing.id}]`;
    if (!call) {
      const index = tx.transaction.actions.findIndex(
        (a) => typeof a !== "string" && a.FunctionCall,
      );
      const action = tx.transaction.actions[index];
      call = typeof action === "object" ? (action.FunctionCall ?? null) : null;
      callPath = `transaction.actions[${index}].FunctionCall`;
    }
    const method = call?.method_name ?? "";
    const rawArgs = parseJson(call?.args);
    const args = isRecord(rawArgs) ? rawArgs : {};
    const methodPath = `${callPath}.method_name`;
    const argsPath = `${callPath}.args`;
    let header: RpcBlockHeader | null = null;
    try {
      header = await this.deps.rpc.blockHeader(failing.block_hash);
    } catch (error) {
      this.log(`X-Ray: block ${failing.block_hash} failed`, error);
    }

    const namedOpId = typeof args.op_id === "string" ? args.op_id : null;
    const op = namedOpId === null ? null : await this.getOp(namedOpId);
    // The state the call was judged on: the failing block's parent, before its own effects.
    const judgedAt = header?.prevHash ?? null;
    let opAtBlock: SpendOp | null = null;
    if (namedOpId !== null && op && judgedAt !== null) {
      try {
        opAtBlock = (await this.deps.rpc.viewAt(
          this.contractId,
          "get_op",
          { op_id: namedOpId },
          judgedAt,
        )) as SpendOp;
      } catch (error) {
        this.log(`X-Ray: get_op(${namedOpId}) at ${judgedAt} failed`, error);
      }
    }
    const atBlockRef =
      namedOpId === null || judgedAt === null
        ? ""
        : viewRef(this.contractId, "get_op", { op_id: namedOpId }, judgedAt);

    const refusal: Refusal = {
      code: sourced(parsed.code, at(ref, `${where}.outcome.status.Failure`), url),
      gloss: sourced(ERROR_CODES[parsed.code], `ERROR_CODES.${parsed.code} (@morrow/core-ts)`),
      method: sourced(method, at(ref, methodPath), url),
      args: sourced(args, at(ref, argsPath), url),
      txHash: sourced(tx.transaction.hash, at(ref, "transaction.hash"), url),
      receiptId: sourced(failing.id, at(ref, `${where}.id`), url),
      facts: {
        blockTimestamp: header
          ? sourced(
              header.timestampNs,
              at(blockRef(failing.block_hash), "header.timestamp_nanosec"),
            )
          : null,
        executableAt:
          opAtBlock && typeof opAtBlock.executable_at === "string"
            ? sourced(opAtBlock.executable_at, at(atBlockRef, "executable_at"))
            : null,
        opState:
          opAtBlock && typeof opAtBlock.state === "string"
            ? sourced(opAtBlock.state as SpendOpState, at(atBlockRef, "state"))
            : null,
      },
    };

    const vaultId = op?.vault_id ?? (typeof args.vault_id === "string" ? args.vault_id : null);
    const kit = vaultId === null ? null : await this.getKit(vaultId);
    const byMethod = (path: ScriptPath, source: SpendSource, sourcePath: string) => ({
      path: sourced(path, at(ref, methodPath), url),
      coinSource: sourced(source, at(ref, sourcePath), url),
    });
    let fallback: ReturnType<typeof byMethod> | undefined;
    if (method === "request_withdrawal" || method === "begin_execute") {
      fallback = byMethod("withdrawal", "vault", methodPath);
    } else if (method === "begin_clawback") {
      const source = args.source === "allowance" ? "allowance" : "vault";
      fallback = byMethod(
        "clawback",
        source,
        args.source === undefined
          ? `${argsPath} (default "vault": args.source absent)`
          : `${argsPath}.source`,
      );
    }
    const script = this.scriptStage(vaultId, op, kit, fallback);

    return {
      opId: op ? sourced(op.op_id, at(this.opRef(op.op_id), "op_id")) : null,
      vaultId:
        vaultId === null
          ? null
          : op
            ? sourced(vaultId, at(this.opRef(op.op_id), "vault_id"))
            : sourced(vaultId, at(ref, `${argsPath}.vault_id`), url),
      btcNetwork:
        kit && vaultId !== null
          ? sourced(kit.btc_network, at(this.kitRef(vaultId), "btc_network"))
          : null,
      script,
      rule: {
        status: "refused",
        events: [],
        opState: null,
        executableAt: null,
        feeSats: null,
        voidedBy: null,
        refusal,
      },
      mpc: notReached.mpc(),
      bitcoin: notReached.bitcoin(),
    };
  }
}
