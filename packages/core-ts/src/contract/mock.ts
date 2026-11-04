import type { ContractClient } from "./client.js";
import { EVENTS_SINCE_MAX_LIMIT, isExecutable } from "./client.js";
import { MorrowContractError, type ErrorCode } from "./errors.js";
import type { EventData, EventKind, MorrowEvent } from "./events.js";
import {
  DAY_NS,
  ENVELOPE_HEX_LENGTH,
  MAX_INPUTS_PER_OP,
  assertAddress,
  assertU64,
  validatePolicy,
  validatePolicyChange,
} from "./policy.js";
import type {
  AccountId,
  BeginClawbackArgs,
  BtcNetwork,
  CreateVaultArgs,
  Guardian,
  Hex,
  Outpoint,
  PolicyChange,
  ProposePolicyChangeArgs,
  RefreshArgs,
  RequestWithdrawalArgs,
  ScriptPath,
  SpendAllowanceArgs,
  SpendOp,
  SpendOpKind,
  SpendSource,
  U64,
  Vault,
  VaultKit,
  WitnessTemplate,
} from "./types.js";

/** 0.5 NEAR, the minimum `create_vault` deposit. */
export const MIN_VAULT_STORAGE_YOCTO = 500_000_000_000_000_000_000_000n;

/** Witness slot order per path, bottom of the stack first (matches the Vault Script). */
export const WITNESS_TEMPLATES: Record<ScriptPath, WitnessTemplate> = {
  withdrawal: {
    path: "withdrawal",
    slots: [
      { kind: "signature", signer: "cosigner" },
      { kind: "signature", signer: "owner" },
      { kind: "selector", hex: "01" },
      { kind: "script" },
    ],
  },
  clawback: {
    path: "clawback",
    slots: [
      { kind: "empty" },
      { kind: "signature", signer: "guardian" },
      { kind: "signature", signer: "cosigner" },
      { kind: "selector", hex: "01" },
      { kind: "empty" },
      { kind: "script" },
    ],
  },
  escape: {
    path: "escape",
    slots: [
      { kind: "signature", signer: "owner" },
      { kind: "empty" },
      { kind: "empty" },
      { kind: "script" },
    ],
  },
};

export interface MockOptions {
  allowedNetworks?: readonly BtcNetwork[];
  /** Non-empty: only these accounts may call `create_vault`. */
  creatorAllowlist?: readonly AccountId[];
  /** Initial NEAR block time in nanoseconds. */
  nowNs?: bigint;
}

const BECH32_CHARS = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const NETWORK_PREFIX: Record<BtcNetwork, string> = {
  regtest: "bcrt1",
  signet: "tb1",
  testnet4: "tb1",
  bitcoin: "bc1",
};

/** Deterministic bech32-charset filler so mock addresses look like addresses. */
function fakeBech32(seed: string, length: number): string {
  let hash = 2166136261;
  let out = "";
  for (let i = 0; out.length < length; i++) {
    hash ^= seed.charCodeAt(i % seed.length) + i;
    hash = Math.imul(hash, 16777619) >>> 0;
    out += BECH32_CHARS[hash % 32];
  }
  return out;
}

/** Rough P2WSH vsize: the mock cannot build transactions, so fees are estimated. */
function estimateVsize(inputs: number, outputs: number): bigint {
  return BigInt(11 + inputs * 140 + outputs * 43);
}

/** Deep copy of plain JSON data (every contract value is JSON). */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Outputs below this are non-standard (the contract's `DUST_LIMIT_SATS`). */
const DUST_LIMIT_SATS = 546n;

const TERMINAL_STATES = new Set<SpendOp["state"]>(["signed", "cancelled", "voided"]);

/**
 * In-memory reference implementation of the Vault Contract's behaviour for lanes B and C.
 * It enforces the state machine, caller rules and Policy validation, but builds no Bitcoin
 * bytes: transactions, sighashes and signatures are clearly fake placeholders.
 */
export class MockContractClient implements ContractClient {
  private readonly allowedNetworks: readonly BtcNetwork[];
  private readonly creatorAllowlist: readonly AccountId[];
  private nowNs: bigint;
  private caller: AccountId = "owner.test.near";
  private readonly vaults = new Map<U64, Vault>();
  private readonly ops = new Map<U64, SpendOp>();
  private readonly changes = new Map<U64, PolicyChange>();
  private readonly events: MorrowEvent[] = [];
  private nextVaultId = 1n;
  private nextOpId = 1n;
  private nextChangeId = 1n;

  constructor(options: MockOptions = {}) {
    this.allowedNetworks = options.allowedNetworks ?? ["regtest", "signet", "testnet4"];
    this.creatorAllowlist = options.creatorAllowlist ?? [];
    this.nowNs = options.nowNs ?? 1_767_225_600_000_000_000n;
  }

  // Test controls

  /** Sets the account that signs the next calls. */
  asCaller(account: AccountId): this {
    this.caller = account;
    return this;
  }

  setNow(nowNs: bigint): this {
    this.nowNs = nowNs;
    return this;
  }

  advance(durationNs: bigint): this {
    this.nowNs += durationNs;
    return this;
  }

  now(): bigint {
    return this.nowNs;
  }

  // Calls

  async createVault(args: CreateVaultArgs): Promise<U64> {
    if (this.creatorAllowlist.length > 0 && !this.creatorAllowlist.includes(this.caller)) {
      this.fail("ERR_CREATOR_NOT_ALLOWED");
    }
    if (BigInt(args.deposit_yocto) < MIN_VAULT_STORAGE_YOCTO) this.fail("ERR_DEPOSIT_TOO_LOW");
    if (!/^0[23][0-9a-f]{64}$/.test(args.owner_key)) this.fail("ERR_BAD_KEY", "owner_key");
    validatePolicy(args.policy, this.allowedNetworks);

    const vaultId = (this.nextVaultId++).toString();
    const prefix = NETWORK_PREFIX[args.policy.btc_network];
    const vault: Vault = {
      vault_id: vaultId,
      owner_account: this.caller,
      owner_key: args.owner_key,
      policy: clone(args.policy),
      state: "pending_keys",
      cosigner_pubkeys: null,
      addresses: null,
      storage_balance: args.deposit_yocto,
      created_at: this.nowNs.toString(),
      pending_change: null,
    };
    this.vaults.set(vaultId, vault);
    this.emit(vaultId, "vault_created", { owner_account: this.caller });

    // The real contract activates in the derived_public_key callback; the mock does it at once.
    vault.cosigner_pubkeys = {
      vault: `02${fakeBech32(`cv${vaultId}`, 64).replace(/[^0-9a-f]/g, "a")}`,
      allowance: `03${fakeBech32(`ca${vaultId}`, 64).replace(/[^0-9a-f]/g, "b")}`,
    };
    vault.addresses = {
      vault: `${prefix}q${fakeBech32(`va${vaultId}`, 58)}`,
      allowance: `${prefix}q${fakeBech32(`al${vaultId}`, 58)}`,
    };
    vault.state = "active";
    this.emit(vaultId, "vault_activated", {
      vault_address: vault.addresses.vault,
      allowance_address: vault.addresses.allowance,
    });
    return vaultId;
  }

  async topUpStorage(vaultId: U64, depositYocto: string): Promise<void> {
    const vault = this.vault(vaultId);
    vault.storage_balance = (BigInt(vault.storage_balance) + BigInt(depositYocto)).toString();
    this.emit(vaultId, "storage_topped_up", { amount_yocto: depositYocto });
  }

  async requestWithdrawal(args: RequestWithdrawalArgs): Promise<U64> {
    const vault = this.ownerAction(args.vault_id, args.envelope);
    assertAddress(args.destination, vault.policy.btc_network);
    this.checkInputs(args.utxos, false);
    this.checkFunds(args.utxos, assertU64(args.amount_sats, "amount_sats"));
    const executableAt = this.nowNs + BigInt(vault.policy.delay_ns);
    const op = this.newOp(vault, "withdrawal", "pending", args.amount_sats, args.destination, args);
    op.executable_at = executableAt.toString();
    this.emit(vault.vault_id, "withdrawal_requested", {
      op_id: op.op_id,
      amount_sats: op.amount_sats,
      destination: op.destination,
      executable_at: op.executable_at,
      utxos: op.utxos,
      envelope: args.envelope,
    });
    return op.op_id;
  }

  async beginExecute(opId: U64, envelope: Hex): Promise<SpendOp> {
    const op = this.op(opId);
    const vault = this.ownerAction(op.vault_id, envelope);
    if (op.kind !== "withdrawal") this.fail("ERR_BAD_OP_STATE");
    if (op.state === "frozen" || op.state === "signed") return clone(op);
    if (op.state !== "pending") this.fail("ERR_BAD_OP_STATE");
    if (!isExecutable(op, this.nowNs)) this.fail("ERR_NOT_EXECUTABLE");
    this.freeze(vault, op, envelope);
    return clone(op);
  }

  async spendAllowance(args: SpendAllowanceArgs): Promise<SpendOp> {
    const vault = this.ownerAction(args.vault_id, args.envelope);
    assertAddress(args.destination, vault.policy.btc_network);
    const amount = assertU64(args.amount_sats, "amount_sats");
    if (amount <= 0n) this.fail("ERR_INSUFFICIENT_FUNDS", "amount must be positive");
    if (amount < DUST_LIMIT_SATS) this.fail("ERR_INSUFFICIENT_FUNDS", "amount is below dust");
    // The limit comes before the coins: on a limit of 0 nothing else is even looked at, not
    // even the window.
    const limit = BigInt(vault.policy.allowance_limit_sats);
    if (limit === 0n) this.fail("ERR_ALLOWANCE_LIMIT");
    const window = this.allowanceWindow(vault.vault_id) + amount;
    if (window > limit) this.fail("ERR_ALLOWANCE_LIMIT");
    this.checkInputs(args.utxos, false);
    this.checkFunds(args.utxos, amount);
    const op = this.newOp(vault, "allowance", "pending", args.amount_sats, args.destination, args);
    op.source = "allowance";
    try {
      this.freeze(vault, op, args.envelope);
    } catch (error) {
      // The contract reverts a refused call: no op, no reservation, no op id spent.
      this.ops.delete(op.op_id);
      this.nextOpId--;
      throw error;
    }
    this.emit(vault.vault_id, "allowance_spent", {
      op_id: op.op_id,
      amount_sats: op.amount_sats,
      destination: op.destination,
      window_sats: window.toString(),
    });
    return clone(op);
  }

  async refresh(args: RefreshArgs): Promise<SpendOp> {
    const vault = this.ownerAction(args.vault_id, args.envelope);
    this.checkInputs(args.utxos, false);
    const source = args.source ?? "vault";
    // One Refresh per Delay and source, from the newest one's created_at, whatever became of it.
    const last = [...this.ops.values()]
      .reverse()
      .find((o) => o.vault_id === vault.vault_id && o.kind === "refresh" && o.source === source);
    if (last && this.nowNs < BigInt(last.created_at) + BigInt(vault.policy.delay_ns)) {
      this.fail("ERR_REFRESH_TOO_SOON");
    }
    const total = args.utxos.reduce((sum, u) => sum + BigInt(u.value_sats), 0n);
    const destination = vault.addresses?.[source] ?? "";
    const op = this.newOp(vault, "refresh", "pending", total.toString(), destination, args);
    try {
      this.freeze(vault, op, args.envelope);
    } catch (error) {
      // The contract reverts a refused call: no op, no reservation, no op id spent.
      this.ops.delete(op.op_id);
      this.nextOpId--;
      throw error;
    }
    return clone(op);
  }

  async proposePolicyChange(args: ProposePolicyChangeArgs): Promise<U64> {
    const vault = this.ownerAction(args.vault_id, args.envelope);
    if (vault.pending_change) this.fail("ERR_CHANGE_PENDING");
    validatePolicyChange(vault.policy, args.changes);
    const change: PolicyChange = {
      change_id: (this.nextChangeId++).toString(),
      vault_id: vault.vault_id,
      changes: clone(args.changes),
      proposed_at: this.nowNs.toString(),
      effective_at: (this.nowNs + BigInt(vault.policy.policy_change_delay_ns)).toString(),
      state: "pending",
      vetoed_by: null,
    };
    this.changes.set(change.change_id, change);
    vault.pending_change = change;
    this.emit(vault.vault_id, "policy_change_proposed", {
      change_id: change.change_id,
      changes: change.changes,
      effective_at: change.effective_at,
      envelope: args.envelope,
    });
    return change.change_id;
  }

  async cancel(opId: U64, envelope?: Hex): Promise<void> {
    const op = this.op(opId);
    const vault = this.activeVault(op.vault_id);
    const ownerOnly = op.kind === "refresh" || op.kind === "allowance";
    if (this.caller === vault.owner_account) {
      this.checkEnvelope(envelope);
    } else if (ownerOnly || !this.guardianOf(vault)) {
      this.fail("ERR_UNAUTHORIZED");
    }
    // A pending withdrawal, or a Frozen Refresh or Allowance spend with an unsigned input
    // (Owner only).
    const cancellable = ownerOnly
      ? op.state === "frozen" && op.signatures.some((s) => s === null)
      : op.kind === "withdrawal" && op.state === "pending";
    if (!cancellable) this.fail("ERR_BAD_OP_STATE");
    op.state = "cancelled";
    const kind =
      op.kind === "refresh"
        ? "refresh_cancelled"
        : op.kind === "allowance"
          ? "allowance_cancelled"
          : "withdrawal_cancelled";
    this.emit(vault.vault_id, kind, { op_id: op.op_id, by: this.caller });
  }

  async beginClawback(args: BeginClawbackArgs): Promise<U64> {
    const vault = this.vault(args.vault_id);
    if (vault.state === "pending_keys") this.fail("ERR_VAULT_NOT_ACTIVE");
    if (!this.guardianOf(vault)) this.fail("ERR_UNAUTHORIZED");
    this.checkInputs(args.utxos, true);
    const total = args.utxos.reduce((sum, u) => sum + BigInt(u.value_sats), 0n);
    const op = this.newOp(
      vault,
      "clawback",
      "pending",
      total.toString(),
      vault.policy.recovery_address,
      args,
    );

    for (const other of this.ops.values()) {
      if (
        other.vault_id === vault.vault_id &&
        other.kind !== "clawback" &&
        !TERMINAL_STATES.has(other.state)
      ) {
        other.state = "voided";
        this.emit(vault.vault_id, "op_voided", { op_id: other.op_id, by_op_id: op.op_id });
      }
    }
    // A change pending when the Vault closes can never apply: the clawing Guardian vetoes it.
    if (vault.pending_change) this.vetoChange(vault, vault.pending_change.change_id);
    if (vault.state !== "clawed_back") {
      vault.state = "clawed_back";
      this.emit(vault.vault_id, "vault_clawed_back", {
        op_id: op.op_id,
        by: this.caller,
        recovery_address: vault.policy.recovery_address,
      });
    }
    this.freeze(vault, op, null);
    return op.op_id;
  }

  async signInput(opId: U64, inputIndex: number): Promise<Hex> {
    const op = this.op(opId);
    const vault = this.vault(op.vault_id);
    if (op.kind === "clawback") {
      if (!this.guardianOf(vault)) this.fail("ERR_UNAUTHORIZED");
    } else {
      if (vault.state === "clawed_back") this.fail("ERR_CLAWED_BACK");
      if (this.caller !== vault.owner_account) this.fail("ERR_UNAUTHORIZED");
    }
    if (op.state !== "frozen" && op.state !== "signed") this.fail("ERR_BAD_OP_STATE");
    if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= op.signatures.length) {
      this.fail("ERR_INPUT_INDEX");
    }
    const stored = op.signatures[inputIndex];
    if (stored) return stored;

    const signature = `mock-signature-${op.op_id}-${inputIndex}`;
    op.signatures[inputIndex] = signature;
    this.emit(vault.vault_id, "input_signed", { op_id: op.op_id, input_index: inputIndex });
    if (op.signatures.every((s) => s !== null)) {
      op.state = "signed";
      this.emit(vault.vault_id, "op_signed", { op_id: op.op_id });
    }
    return signature;
  }

  async vetoPolicyChange(changeId: U64, envelope?: Hex): Promise<void> {
    const change = this.change(changeId);
    const vault = this.activeVault(change.vault_id);
    if (change.state !== "pending") this.fail("ERR_BAD_OP_STATE");
    // The Owner first: an Owner who is also a Guardian withdraws, with an envelope.
    if (this.caller === vault.owner_account) {
      this.checkEnvelope(envelope);
      change.state = "withdrawn";
      vault.pending_change = null;
      this.emit(vault.vault_id, "policy_change_withdrawn", {
        change_id: changeId,
        envelope: envelope as Hex,
      });
    } else if (this.guardianOf(vault)) {
      this.vetoChange(vault, changeId);
    } else {
      this.fail("ERR_UNAUTHORIZED");
    }
  }

  async fastApprove(opId: U64): Promise<void> {
    const op = this.op(opId);
    const vault = this.activeVault(op.vault_id);
    const guardian = this.guardianOf(vault);
    if (!guardian) this.fail("ERR_UNAUTHORIZED");
    if (!vault.policy.fast_approval) this.fail("ERR_FAST_APPROVAL_DISABLED");
    if (guardian.kind !== "trusted_contact") this.fail("ERR_NOT_TRUSTED_CONTACT");
    if (op.kind !== "withdrawal" || op.state !== "pending" || op.executable_at === null) {
      this.fail("ERR_BAD_OP_STATE");
    }
    const floorAt = this.nowNs + BigInt(vault.policy.fast_approval_floor_ns);
    const current = BigInt(op.executable_at);
    op.executable_at = (floorAt < current ? floorAt : current).toString();
    this.emit(vault.vault_id, "fast_approved", {
      op_id: op.op_id,
      by: this.caller,
      executable_at: op.executable_at,
    });
  }

  async applyPolicyChange(changeId: U64): Promise<void> {
    const change = this.change(changeId);
    const vault = this.activeVault(change.vault_id);
    if (change.state !== "pending") this.fail("ERR_BAD_OP_STATE");
    if (this.nowNs < BigInt(change.effective_at)) this.fail("ERR_CHANGE_NOT_EFFECTIVE");
    vault.policy = validatePolicyChange(vault.policy, change.changes);
    change.state = "applied";
    vault.pending_change = null;
    this.emit(vault.vault_id, "policy_change_applied", { change_id: changeId });
  }

  // Views

  async getVault(vaultId: U64): Promise<Vault> {
    return clone(this.vault(vaultId));
  }

  async getOp(opId: U64): Promise<SpendOp> {
    return clone(this.op(opId));
  }

  async getPolicyChange(changeId: U64): Promise<PolicyChange> {
    return clone(this.change(changeId));
  }

  async getVaultKit(vaultId: U64): Promise<VaultKit> {
    const vault = this.vault(vaultId);
    if (!vault.addresses || !vault.cosigner_pubkeys) this.fail("ERR_VAULT_NOT_ACTIVE");
    return {
      kit_version: 1,
      btc_network: vault.policy.btc_network,
      vault_script_hex: `mock-vault-script-${vaultId}`,
      allowance_script_hex: `mock-allowance-script-${vaultId}`,
      addresses: clone(vault.addresses),
      escape_timelock_blocks: vault.policy.escape_timelock_blocks,
      cosigner_pubkeys: clone(vault.cosigner_pubkeys),
      witness_templates: clone(WITNESS_TEMPLATES),
    };
  }

  async eventsSince(cursor: U64, limit: number): Promise<MorrowEvent[]> {
    const from = BigInt(cursor);
    const max = Math.min(Math.max(1, Math.floor(limit)), EVENTS_SINCE_MAX_LIMIT);
    return clone(this.events.filter((e) => BigInt(e.seq) > from).slice(0, max));
  }

  // Internals

  private fail(code: ErrorCode, detail?: string): never {
    throw new MorrowContractError(code, detail);
  }

  private emit<K extends EventKind>(vaultId: U64, kind: K, data: EventData[K]): void {
    this.events.push({
      seq: (this.events.length + 1).toString(),
      block_timestamp: this.nowNs.toString(),
      vault_id: vaultId,
      kind,
      data,
    } as MorrowEvent);
  }

  private vault(vaultId: U64): Vault {
    return this.vaults.get(vaultId) ?? this.fail("ERR_VAULT_NOT_FOUND");
  }

  private op(opId: U64): SpendOp {
    return this.ops.get(opId) ?? this.fail("ERR_OP_NOT_FOUND");
  }

  /** A Guardian's veto (the caller's): settles the change and emits `policy_change_vetoed`. */
  private vetoChange(vault: Vault, changeId: U64): void {
    const change = this.change(changeId);
    change.state = "vetoed";
    change.vetoed_by = this.caller;
    vault.pending_change = null;
    this.emit(vault.vault_id, "policy_change_vetoed", { change_id: changeId, by: this.caller });
  }

  private change(changeId: U64): PolicyChange {
    return this.changes.get(changeId) ?? this.fail("ERR_CHANGE_NOT_FOUND");
  }

  /** Active, not clawed back. */
  private activeVault(vaultId: U64): Vault {
    const vault = this.vault(vaultId);
    if (vault.state === "clawed_back") this.fail("ERR_CLAWED_BACK");
    if (vault.state !== "active") this.fail("ERR_VAULT_NOT_ACTIVE");
    return vault;
  }

  private ownerAction(vaultId: U64, envelope: Hex | undefined): Vault {
    const vault = this.activeVault(vaultId);
    if (this.caller !== vault.owner_account) this.fail("ERR_UNAUTHORIZED");
    this.checkEnvelope(envelope);
    return vault;
  }

  private checkEnvelope(envelope: Hex | undefined): void {
    if (
      envelope === undefined ||
      envelope.length !== ENVELOPE_HEX_LENGTH ||
      !/^[0-9a-f]+$/.test(envelope)
    ) {
      this.fail("ERR_BAD_ENVELOPE");
    }
  }

  private guardianOf(vault: Vault): Guardian | undefined {
    return vault.policy.guardians.find((g) => g.guardian_account === this.caller);
  }

  /**
   * The rolling 24-hour Allowance total: amounts (fees not counted) of this Vault's allowance ops
   * that are frozen or signed and were created after `now - 24 h`.
   */
  private allowanceWindow(vaultId: U64): bigint {
    const since = this.nowNs - DAY_NS;
    return [...this.ops.values()]
      .filter(
        (o) =>
          o.vault_id === vaultId &&
          o.kind === "allowance" &&
          (o.state === "frozen" || o.state === "signed") &&
          BigInt(o.created_at) > since,
      )
      .reduce((sum, o) => sum + BigInt(o.amount_sats), 0n);
  }

  private checkInputs(utxos: Outpoint[], forClawback: boolean): void {
    if (utxos.length === 0) this.fail("ERR_NO_INPUTS");
    if (utxos.length > MAX_INPUTS_PER_OP) this.fail("ERR_TOO_MANY_INPUTS");
    const key = (u: Outpoint) => `${u.txid}:${u.vout}`;
    const wanted = new Set(utxos.map(key));
    if (wanted.size !== utxos.length) this.fail("ERR_OUTPOINT_RESERVED", "duplicate outpoint");
    for (const op of this.ops.values()) {
      const blocks = forClawback
        ? op.kind === "clawback"
        : op.kind !== "clawback" && !TERMINAL_STATES.has(op.state);
      if (blocks && op.utxos.some((u) => wanted.has(key(u)))) this.fail("ERR_OUTPOINT_RESERVED");
    }
  }

  private checkFunds(utxos: Outpoint[], amount: bigint): void {
    if (amount <= 0n) this.fail("ERR_INSUFFICIENT_FUNDS", "amount must be positive");
    const total = utxos.reduce((sum, u) => sum + BigInt(u.value_sats), 0n);
    if (total < amount) this.fail("ERR_INSUFFICIENT_FUNDS");
  }

  private newOp(
    vault: Vault,
    kind: SpendOpKind,
    state: SpendOp["state"],
    amountSats: U64,
    destination: string,
    args: { utxos: Outpoint[]; fee_rate_sat_vb: number; source?: SpendSource },
  ): SpendOp {
    const op: SpendOp = {
      op_id: (this.nextOpId++).toString(),
      vault_id: vault.vault_id,
      kind,
      source: "source" in args && args.source === "allowance" ? "allowance" : "vault",
      state,
      amount_sats: amountSats,
      destination,
      fee_rate_sat_vb: args.fee_rate_sat_vb,
      utxos: clone(args.utxos),
      created_at: this.nowNs.toString(),
      executable_at: null,
      unsigned_tx_hex: null,
      sighashes: [],
      signatures: [],
      witness_template: null,
    };
    this.ops.set(op.op_id, op);
    return op;
  }

  /** Builds (fake) bytes once, checks the fee rule, and moves the op to frozen. */
  private freeze(vault: Vault, op: SpendOp, envelope: Hex | null): void {
    const total = op.utxos.reduce((sum, u) => sum + BigInt(u.value_sats), 0n);
    const outputs = op.kind === "withdrawal" || op.kind === "allowance" ? 2 : 1;
    const fee =
      estimateVsize(op.utxos.length, outputs) * BigInt(Math.max(0, Math.ceil(op.fee_rate_sat_vb)));
    const feeCap = BigInt(vault.policy.fee_cap_sats);
    const moved =
      op.kind === "withdrawal" || op.kind === "allowance" ? BigInt(op.amount_sats) : total;
    const cap =
      op.kind === "clawback"
        ? [2n * feeCap, moved / 10n].reduce((a, b) => (a < b ? a : b))
        : [feeCap, moved / 20n].reduce((a, b) => (a < b ? a : b));
    if (fee > cap) this.fail("ERR_FEE_TOO_HIGH");
    if (
      (op.kind === "withdrawal" || op.kind === "allowance") &&
      BigInt(op.amount_sats) + fee > total
    ) {
      this.fail("ERR_INSUFFICIENT_FUNDS");
    }
    if (op.kind === "refresh" && total - fee < DUST_LIMIT_SATS) this.fail("ERR_INSUFFICIENT_FUNDS");
    if (op.kind === "refresh" || op.kind === "clawback") op.amount_sats = (total - fee).toString();

    op.unsigned_tx_hex = `mock-tx-${op.op_id}`;
    op.sighashes = op.utxos.map((_, i) => `mock-sighash-${op.op_id}-${i}`);
    op.signatures = op.utxos.map(() => null);
    op.witness_template = clone(
      WITNESS_TEMPLATES[op.kind === "clawback" ? "clawback" : "withdrawal"],
    );
    op.state = "frozen";
    this.emit(vault.vault_id, "op_frozen", {
      op_id: op.op_id,
      kind: op.kind,
      envelope,
      fee_sats: fee.toString(),
    });
  }
}
