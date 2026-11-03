import { Account, JsonRpcProvider, KeyPairSigner } from "near-api-js";
import type { ContractClient } from "../contract/client.js";
import { MorrowContractError, parseContractError } from "../contract/errors.js";
import type { MorrowEvent } from "../contract/events.js";
import type {
  BeginClawbackArgs,
  CreateVaultArgs,
  Hex,
  ProposePolicyChangeArgs,
  RefreshArgs,
  RequestWithdrawalArgs,
  SpendAllowanceArgs,
  SpendOp,
  U64,
  Vault,
  VaultKit,
} from "../contract/types.js";

export const NEAR_RPC_URLS = {
  testnet: "https://rpc.testnet.near.org",
  mainnet: "https://rpc.mainnet.near.org",
} as const;

/** create_vault waits for two MPC derivations and a callback. */
const CREATE_VAULT_GAS = 100_000_000_000_000n;
/** sign_input waits for one MPC signature and a callback. */
const SIGN_GAS = 100_000_000_000_000n;
const DEFAULT_GAS = 30_000_000_000_000n;

export interface NearContractClientOptions {
  contractId: string;
  rpcUrl: string;
  /** Needed for calls; views work without it. */
  signer?: { accountId: string; secretKey: string };
}

interface CallOptions {
  deposit?: bigint;
  gas?: bigint;
}

/** Maps a NEAR error to `MorrowContractError` when it carries a known `ERR_*` code. */
function translate(error: unknown): unknown {
  const text = error instanceof Error ? error.message : String(error);
  return parseContractError(text) ?? error;
}

/** `ContractClient` over NEAR JSON-RPC, using near-api-js. */
export class NearContractClient implements ContractClient {
  private readonly provider: JsonRpcProvider;
  private readonly account: Account | null;
  private lastHash: string | null = null;

  constructor(private readonly options: NearContractClientOptions) {
    this.provider = new JsonRpcProvider({ url: options.rpcUrl });
    this.account = options.signer
      ? new Account(
          options.signer.accountId,
          this.provider,
          KeyPairSigner.fromSecretKey(options.signer.secretKey as never),
        )
      : null;
  }

  get contractId(): string {
    return this.options.contractId;
  }

  /** Hash of the last transaction this client sent, for explorer links. */
  get lastTransactionHash(): string | null {
    return this.lastHash;
  }

  private async view<T>(method: string, args: Record<string, unknown>): Promise<T> {
    try {
      return (await this.provider.callFunction({
        contractId: this.options.contractId,
        method,
        args,
      })) as T;
    } catch (error) {
      throw translate(error);
    }
  }

  private async call<T>(methodName: string, args: object, options: CallOptions = {}): Promise<T> {
    if (!this.account) throw new Error("NearContractClient needs a signer for calls");
    try {
      const outcome = await this.account.callFunctionRaw({
        contractId: this.options.contractId,
        methodName,
        args,
        deposit: options.deposit ?? 0n,
        gas: options.gas ?? DEFAULT_GAS,
      });
      this.lastHash = outcome.transaction.hash;
      const status = outcome.status as { SuccessValue?: string; Failure?: unknown };
      if (status.Failure !== undefined) throw new Error(JSON.stringify(status.Failure));
      const encoded = status.SuccessValue ?? "";
      if (!encoded) return undefined as T;
      return JSON.parse(
        new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))),
      ) as T;
    } catch (error) {
      const translated = translate(error);
      if (translated instanceof MorrowContractError) throw translated;
      throw error;
    }
  }

  createVault({ owner_key, policy, deposit_yocto }: CreateVaultArgs): Promise<U64> {
    return this.call(
      "create_vault",
      { owner_key, policy },
      { deposit: BigInt(deposit_yocto), gas: CREATE_VAULT_GAS },
    );
  }

  topUpStorage(vaultId: U64, depositYocto: string): Promise<void> {
    return this.call("top_up_storage", { vault_id: vaultId }, { deposit: BigInt(depositYocto) });
  }

  requestWithdrawal(args: RequestWithdrawalArgs): Promise<U64> {
    return this.call("request_withdrawal", args);
  }

  beginExecute(opId: U64, envelope: Hex): Promise<SpendOp> {
    return this.call("begin_execute", { op_id: opId, envelope });
  }

  spendAllowance(args: SpendAllowanceArgs): Promise<SpendOp> {
    return this.call("spend_allowance", args);
  }

  refresh(args: RefreshArgs): Promise<SpendOp> {
    const { source, ...rest } = args;
    return this.call("refresh", source === undefined ? rest : { ...rest, source });
  }

  proposePolicyChange(args: ProposePolicyChangeArgs): Promise<U64> {
    return this.call("propose_policy_change", args);
  }

  cancel(opId: U64, envelope?: Hex): Promise<void> {
    return this.call("cancel", { op_id: opId, ...(envelope === undefined ? {} : { envelope }) });
  }

  beginClawback(args: BeginClawbackArgs): Promise<U64> {
    return this.call("begin_clawback", args);
  }

  signInput(opId: U64, inputIndex: number): Promise<Hex> {
    return this.call("sign_input", { op_id: opId, input_index: inputIndex }, { gas: SIGN_GAS });
  }

  vetoPolicyChange(changeId: U64, envelope?: Hex): Promise<void> {
    return this.call("veto_policy_change", {
      change_id: changeId,
      ...(envelope === undefined ? {} : { envelope }),
    });
  }

  fastApprove(opId: U64): Promise<void> {
    return this.call("fast_approve", { op_id: opId });
  }

  applyPolicyChange(changeId: U64): Promise<void> {
    return this.call("apply_policy_change", { change_id: changeId });
  }

  async getVault(vaultId: U64): Promise<Vault> {
    const vault = await this.view<
      Omit<Vault, "pending_change"> & { pending_change?: Vault["pending_change"] }
    >("get_vault", { vault_id: vaultId });
    return { ...vault, pending_change: vault.pending_change ?? null };
  }

  getOp(opId: U64): Promise<SpendOp> {
    return this.view("get_op", { op_id: opId });
  }

  getVaultKit(vaultId: U64): Promise<VaultKit> {
    return this.view("get_vault_kit", { vault_id: vaultId });
  }

  eventsSince(cursor: U64, limit: number): Promise<MorrowEvent[]> {
    return this.view("events_since", { cursor, limit });
  }
}
