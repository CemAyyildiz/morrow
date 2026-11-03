/**
 * The `--dry-run` harness: the attack run against a mock Vault Contract, a fake Bitcoin backend,
 * a simulated Auto-Clawback watcher and a fake Attempt Log feed. It exercises all five attempt
 * categories without a live Vault or operator keys, and it never writes into `evidence/`.
 */
import {
  MockContractClient,
  MorrowContractError,
  presetPolicy,
  randomP2wpkhAddress,
  type AccountId,
  type Policy,
  type Utxo,
  type Vault,
} from "@morrow/core-ts";
import { KeyPair } from "near-api-js";
import type { AttemptEntry } from "../attempts.js";
import type { PublicRound } from "../store.js";
import type { AccessKeyState, CallPlan, CallResult, NearPort } from "./near.js";
import {
  logViews,
  type AttackPorts,
  type BitcoinPort,
  type Clock,
  type ClawbackInfo,
  type LogEntryView,
  type RoundSource,
  type Watcher,
} from "./run.js";

const GUARDIAN: AccountId = "watcher-guardian.challenge";
const OWNER_ACCOUNT: AccountId = "r1.challenge";
const VAULT_CONTRACT: AccountId = "vault.challenge";

const ONE_NEAR = 1_000_000_000_000_000_000_000_000n;

/** A deterministic 64-hex NEAR tx hash from a counter. */
const fakeHash = (n: number) => n.toString(16).padStart(64, "0");

/** A recorded on-chain call, for the fake Attempt Log. */
interface Included {
  hash: string;
  kind: "rejected" | "withdrawal";
  op_id: string | null;
  vault_id: string | null;
}

/** The mock contract wired as a `NearPort`, plus the pieces the harness needs. */
export class DryRunChain {
  readonly mock = new MockContractClient({ nowNs: 1_767_225_600_000_000_000n });
  readonly included: Included[] = [];
  private hashCounter = 1;
  /** Remaining gas allowance per public key (not decremented; the mock does not meter gas). */
  private readonly allowance = new Map<string, bigint>();

  constructor(
    private readonly ownerAccount: AccountId,
    functionCallPublicKey: string,
  ) {
    this.allowance.set(functionCallPublicKey, ONE_NEAR);
  }

  /** Opens a fresh Challenge Vault, as the real round loop does after each Clawback. */
  async openVault(): Promise<string> {
    this.mock.asCaller(this.ownerAccount);
    return this.mock.createVault({
      owner_key: `02${"11".repeat(32)}`,
      deposit_yocto: ONE_NEAR.toString(),
      policy: standardPolicy(),
    });
  }

  near(): NearPort {
    return {
      accessKey: async (_accountId, publicKey): Promise<AccessKeyState> => {
        const allowance = this.allowance.get(publicKey);
        return allowance === undefined
          ? { exists: false }
          : { exists: true, nonce: 1, allowanceYocto: allowance };
      },
      getVault: (vaultId) => this.mock.getVault(vaultId),
      getVaultKit: (vaultId) => this.mock.getVaultKit(vaultId),
      codeHash: async () => "mock11111111111111111111111111111111111111111",
      tipHeight: async () => 1000,
      call: (_key, plan) => this.call(plan),
    };
  }

  private async call(plan: CallPlan): Promise<CallResult> {
    const hash = fakeHash(this.hashCounter++);
    this.mock.asCaller(plan.signerId);
    try {
      const value = await dispatch(this.mock, plan);
      if (plan.method === "request_withdrawal" && typeof value === "string") {
        const vaultId = (plan.args as { vault_id?: string }).vault_id ?? null;
        this.included.push({ hash, kind: "withdrawal", op_id: value, vault_id: vaultId });
      }
      return { kind: "accepted", hash, value, logs: [] };
    } catch (error) {
      if (error instanceof MorrowContractError) {
        this.included.push({ hash, kind: "rejected", op_id: null, vault_id: null });
        return {
          kind: "refused",
          hash,
          code: error.code,
          failure: "ActionError.FunctionCallError.ExecutionError",
        };
      }
      throw error;
    }
  }

  /** The simulated watcher: claws back any live request as the Guardian. */
  watcher(): Watcher {
    return {
      tick: async (vaultId): Promise<ClawbackInfo | null> => {
        const vault = await this.mock.getVault(vaultId).catch(() => null);
        if (!vault || vault.state === "clawed_back") return null;
        // A distinct Clawback outpoint per Vault (the mock reserves them contract-globally).
        const clawTxid = Number(vaultId).toString(16).padStart(64, "c");
        const opId = await this.mock.asCaller(GUARDIAN).beginClawback({
          vault_id: vaultId,
          utxos: [{ txid: clawTxid, vout: 0, value_sats: "100000" }],
          fee_rate_sat_vb: 2,
        });
        return { op_id: opId, txid: null };
      },
    };
  }

  /** The fake Attempt Log: every included call, newest first, numbered in discovery order. */
  feedEntries(): LogEntryView[] {
    return this.included.map((i, index) => ({
      n: index + 1,
      tx_hash: i.hash,
      op_id: i.op_id,
      vault_id: i.vault_id,
    }));
  }
}

async function dispatch(mock: MockContractClient, plan: CallPlan): Promise<unknown> {
  const args = plan.args as Record<string, unknown>;
  switch (plan.method) {
    case "request_withdrawal":
      return mock.requestWithdrawal(args as never);
    case "begin_execute":
      return mock.beginExecute(args.op_id as string, args.envelope as string);
    case "sign_input":
      return mock.signInput(args.op_id as string, args.input_index as number);
    case "begin_clawback":
      return mock.beginClawback(args as never);
    case "top_up_storage":
      return mock.topUpStorage(args.vault_id as string, "0");
    case "spend_allowance":
      return mock.spendAllowance(args as never);
    case "refresh":
      return mock.refresh(args as never);
    case "propose_policy_change":
      return mock.proposePolicyChange(args as never);
    default:
      throw new Error(`unknown method ${plan.method}`);
  }
}

function standardPolicy(): Policy {
  return {
    ...presetPolicy("standard", {
      plannedDepositSats: 100_000n,
      guardians: [
        { guardian_key: `03${"22".repeat(32)}`, guardian_account: GUARDIAN, kind: "auto_clawback" },
      ],
      recoveryAddress: randomP2wpkhAddress("signet"),
      network: "signet",
      watcherX25519Pk: "44".repeat(32),
    }),
    allowance_limit_sats: "0",
  };
}

/** A fake Bitcoin backend: one confirmed coin at the Vault Address, nothing at attacker addresses. */
export class FakeBitcoin implements BitcoinPort {
  private readonly utxos = new Map<string, Utxo[]>();
  tip = 200;

  fund(address: string, sats: bigint): void {
    this.utxos.set(address, [
      { txid: "ab".repeat(32), vout: 0, value_sats: sats.toString(), height: 190 },
    ]);
  }
  async getUtxos(address: string): Promise<Utxo[]> {
    return this.utxos.get(address) ?? [];
  }
  async getTipHeight(): Promise<number> {
    return this.tip;
  }
  async broadcast(): Promise<string> {
    throw new Error("the fake backend never broadcasts (mock kit)");
  }
}

/** A clock that resolves sleeps at once but advances its own time, so deadlines still progress. */
export class FastClock implements Clock {
  private t = Date.parse("2026-11-03T00:00:00.000Z");
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
}

export interface DryRunPorts extends AttackPorts {
  chain: DryRunChain;
}

/**
 * A fixed published function-call key for the dry run, so a report is reproducible for a given
 * seed. It is a throwaway key for the mock contract, never a real credential.
 */
export const DRY_RUN_FUNCTION_CALL_KEY =
  "ed25519:66m7p6tWp1rAfxZSpZsSKMee8gQwbaUHo94TFer32vkovBffNHHtMeZKVMGqj4Gz533H6qt6QhdUPLBWp8MEp13k";

/** Builds every port for a dry run: a fresh Vault per round, a simulated watcher and feed. */
export async function dryRunPorts(): Promise<DryRunPorts> {
  const fcKey = KeyPair.fromString(DRY_RUN_FUNCTION_CALL_KEY as never);
  const chain = new DryRunChain(OWNER_ACCOUNT, fcKey.getPublicKey().toString());
  const bitcoin = new FakeBitcoin();

  let active: PublicRound | null = null;
  let roundNumber = 0;

  const openRound = async (): Promise<PublicRound> => {
    const vaultId = await chain.openVault();
    const vault: Vault = await chain.mock.getVault(vaultId);
    const vaultAddress = vault.addresses?.vault ?? "";
    bitcoin.fund(vaultAddress, 100_000n);
    roundNumber += 1;
    return {
      round: roundNumber,
      vault_contract: VAULT_CONTRACT,
      near_network: "testnet",
      btc_network: "signet",
      vault_id: vaultId,
      owner_account: OWNER_ACCOUNT,
      owner_key: vault.owner_key,
      owner_key_secret: "11".repeat(32),
      near_function_call_key: fcKey.toString(),
      vault_address: vaultAddress,
      escape_timelock_blocks: vault.policy.escape_timelock_blocks,
      funding_txid: "ab".repeat(32),
      funding_height: 190,
      rotation_deadline_height: 21_214,
    };
  };

  const rounds: RoundSource = {
    // A new round opens only once the current Vault is clawed back, as the real loop does.
    current: async () => {
      if (active) {
        const vault = await chain.mock.getVault(active.vault_id as string).catch(() => null);
        if (!vault || vault.state === "clawed_back") active = await openRound();
      } else {
        active = await openRound();
      }
      return active;
    },
  };
  const feed = { entries: async () => chain.feedEntries() };
  return {
    chain,
    rounds,
    near: chain.near(),
    bitcoin,
    feed,
    watcher: chain.watcher(),
    clock: new FastClock(),
  };
}

/** Converts the public feed shape (`GET /attempts`) to matching views (for the live run). */
export function feedFromEntries(entries: readonly AttemptEntry[]): LogEntryView[] {
  return logViews(entries);
}
