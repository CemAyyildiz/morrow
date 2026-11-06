import {
  MINUTE_NS,
  MorrowContractError,
  NearContractClient,
  completeAndBroadcast,
  sealEnvelope,
  type ContractClient,
  type EnvelopeKeypair,
  type Guardian,
  type Outpoint,
  type SpendOp,
} from "@morrow/core-ts";
import { NearFinalBlockClock, type ChainClock } from "@morrow/watcher";
import {
  eventCount,
  findEvent,
  hasFastApproval,
  readAfter,
  refused,
  within,
  type Call,
} from "../chain.js";
import { loadJudgeConfig } from "../config.js";
import { ScenarioSkip } from "../runner.js";
import type { ScenarioContext } from "../scenarios.js";
import {
  createJudgeSubAccount,
  createJudgeVault,
  freshGuardianKey,
  judgeGuardian,
  judgeSession,
} from "../session.js";

/** The S-7 Vault's timing: a 10-minute Delay that Fast Approval cuts to a 1-minute Floor. */
const TEN_MINUTES = (10n * MINUTE_NS).toString();
const ONE_MINUTE = MINUTE_NS.toString();
/** The new `executable_at` may sit this far above approval time + Floor (block time jitter). */
const FLOOR_SLACK_NS = 5_000_000_000n;
/** S-7 refuses to wait longer than this for the Floor. */
const MAX_FLOOR_WAIT_MS = 5 * 60_000;
/** Retries of an Execute the chain still calls early, after the computed wait. */
const EXECUTE_RETRIES = 20;
const EXECUTE_RETRY_MS = 3_000;
const FUNDING_SATS = 1_000_000n;
const AMOUNT_SATS = 500_000n;
/** 0.2 NEAR for the Trusted Contact's account: plenty for one `fast_approve`. */
const CONTACT_FUNDING = 200_000_000_000_000_000_000_000n;

/** Bitcoin regtest, as S-7 uses it. */
export interface FastBitcoin {
  /** Funds `address` with `sats`, mines it and returns the address's coins. */
  fund(address: string, sats: bigint): Promise<Outpoint[]>;
  newAddress(): Promise<string>;
  /** Completes the co-signed withdrawal with the Owner Key, broadcasts and mines it; the txid. */
  broadcast(op: SpendOp, vaultScriptHex: string): Promise<string>;
  /** What confirmed transaction `txid` paid to `address`, 0 when it is not confirmed. */
  received(address: string, txid: string): Promise<bigint>;
}

/** The S-7 Vault and the clients that act on it. */
export interface FastVault {
  vaultId: string;
  /** Signed by the Owner. */
  owner: ContractClient;
  /** The session Guardian, a `backup_device`. */
  guardian: ContractClient;
  guardianAccount: string;
  /** The Owner-funded `contact.<owner>`, a `trusted_contact`. */
  contact: ContractClient;
  contactAccount: string;
  /** The Vault's watcher key, for the Watcher Envelopes. */
  envelopeKey: EnvelopeKeypair;
  bitcoin: FastBitcoin;
}

export interface FastScenarioDeps {
  /** The Vault Contract account, named in the SKIP line. */
  contract: string;
  /** Unsigned client for views: the legacy check and every assertion. */
  reader: ContractClient;
  /** The latest final NEAR block time. */
  clock: ChainClock;
  sleep(ms: number): Promise<void>;
  /** Creates the S-7 Vault. Called only once the contract is known to have Fast Approval. */
  createVault(): Promise<FastVault>;
  /** The limit for each RPC call and transaction (Vault creation gets three times as long). */
  rpcTimeoutMs: number;
}

const iso = (ns: bigint) => new Date(Number(ns / 1_000_000n)).toISOString();

/**
 * S-7 Fast Approval: a Trusted Contact can shorten a withdrawal's Delay, but only down to the Fast
 * Approval Floor, and neither a Backup Device nor the Owner can shorten it at all.
 */
export async function runFast(ctx: ScenarioContext, deps: FastScenarioDeps): Promise<void> {
  const { reader, clock, sleep } = deps;
  const call: Call = (what, work) => within(deps.rpcTimeoutMs, what, work);
  if (!(await hasFastApproval(reader, call))) {
    throw new ScenarioSkip(`${deps.contract} predates Fast Approval`);
  }
  const vault = await within(3 * deps.rpcTimeoutMs, "creating the S-7 Vault", deps.createVault);
  const { vaultId, owner, guardian, guardianAccount, contact, contactAccount, bitcoin } = vault;
  const read = <T>(what: string, work: () => Promise<T>, settled: (value: T) => boolean) =>
    readAfter(sleep, call, what, work, settled);

  const { policy } = await read(
    "get_vault",
    () => reader.getVault(vaultId),
    () => true,
  );
  const kindOf = (account: string) =>
    policy.guardians.find((g) => g.guardian_account === account)?.kind;
  if (
    !policy.fast_approval ||
    policy.delay_ns !== TEN_MINUTES ||
    policy.fast_approval_floor_ns !== ONE_MINUTE ||
    kindOf(contactAccount) !== "trusted_contact" ||
    kindOf(guardianAccount) !== "backup_device"
  ) {
    throw new Error(`Vault ${vaultId} does not have the S-7 Fast Approval Policy`);
  }
  const floor = BigInt(policy.fast_approval_floor_ns);
  ctx.log(
    `Vault ${vaultId}: Delay 10 minutes, Fast Approval Floor 1 minute; Trusted Contact ${contactAccount}, Backup Device ${guardianAccount}`,
  );

  const kit = await read(
    "get_vault_kit",
    () => reader.getVaultKit(vaultId),
    () => true,
  );
  const utxos = await within(3 * deps.rpcTimeoutMs, "funding the Vault on regtest", () =>
    bitcoin.fund(kit.addresses.vault, FUNDING_SATS),
  );
  const destination = await within(deps.rpcTimeoutMs, "getnewaddress", () => bitcoin.newAddress());
  const envelope = await sealEnvelope("normal", vault.envelopeKey.publicKeyHex);
  const opId = await call("request_withdrawal", () =>
    owner.requestWithdrawal({
      vault_id: vaultId,
      amount_sats: AMOUNT_SATS.toString(),
      destination,
      fee_rate_sat_vb: 2,
      utxos,
      envelope,
    }),
  );
  const requested = await read(
    "get_op",
    () => reader.getOp(opId),
    () => true,
  );
  if (requested.executable_at === null) throw new Error(`Withdrawal ${opId} has no executable_at`);
  const original = BigInt(requested.executable_at);
  if (original - BigInt(requested.created_at) !== BigInt(policy.delay_ns)) {
    throw new Error(`Withdrawal ${opId} is not executable one Delay after its request`);
  }
  ctx.log(
    `Withdrawal ${opId} requested: executable at ${iso(original)}, after the 10-minute Delay`,
  );

  await refused("ERR_NOT_TRUSTED_CONTACT", "The Backup Device's fast_approve", () =>
    call("fast_approve", () => guardian.fastApprove(opId)),
  );
  ctx.log("Backup Device fast_approve rejected: ERR_NOT_TRUSTED_CONTACT");
  await refused("ERR_UNAUTHORIZED", "The Owner's fast_approve", () =>
    call("fast_approve", () => owner.fastApprove(opId)),
  );
  ctx.log("Owner fast_approve rejected: ERR_UNAUTHORIZED");

  const cursor = await eventCount(reader, call);
  await call("fast_approve", () => contact.fastApprove(opId));
  const approved = await read(
    "get_op",
    () => reader.getOp(opId),
    (op) => op.executable_at !== requested.executable_at,
  );
  const lowered = BigInt(approved.executable_at ?? original);
  if (lowered >= original) {
    throw new Error(`fast_approve did not lower executable_at (still ${iso(lowered)})`);
  }
  // The approval's own block time, from its event: the Floor counts from there.
  const approval = await read(
    "events_since",
    () =>
      findEvent(reader, cursor, (e) => e.kind === "fast_approved" && e.data.op_id === opId, call),
    (event) => event !== null,
  );
  if (approval?.kind !== "fast_approved") {
    throw new Error(`No fast_approved event for withdrawal ${opId}`);
  }
  if (approval.data.by !== contactAccount) {
    throw new Error(`Withdrawal ${opId} was fast-approved by ${approval.data.by}`);
  }
  const floorAt = BigInt(approval.block_timestamp) + floor;
  if (lowered < floorAt) {
    throw new Error(
      `executable_at ${iso(lowered)} is below the Fast Approval Floor (approval time + 1 minute = ${iso(floorAt)})`,
    );
  }
  if (lowered - floorAt > FLOOR_SLACK_NS || approval.data.executable_at !== lowered.toString()) {
    throw new Error(
      `executable_at ${iso(lowered)} is not approval time + the Fast Approval Floor (${iso(floorAt)})`,
    );
  }
  ctx.log("Fast-approved by the Trusted Contact: the Delay now ends at the Fast Approval Floor");

  const execute = () => call("begin_execute", () => owner.beginExecute(opId, envelope));
  await refused("ERR_NOT_EXECUTABLE", "Execute before the new executable_at", execute);
  ctx.log("Execute before the Fast Approval Floor rejected: ERR_NOT_EXECUTABLE");

  const waitMs = Number((lowered - (await call("block", () => clock.now()))) / 1_000_000n);
  if (waitMs > MAX_FLOOR_WAIT_MS) {
    throw new Error(
      `Withdrawal ${opId} is executable in ${Math.ceil(waitMs / 1_000)} s, beyond the 5-minute bound`,
    );
  }
  ctx.log(`Waiting for the Fast Approval Floor (executable at ${iso(lowered)})`);
  await sleep(Math.max(0, waitMs) + 2_000);
  let frozen: SpendOp | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      frozen = await execute();
      break;
    } catch (error) {
      const early = error instanceof MorrowContractError && error.code === "ERR_NOT_EXECUTABLE";
      if (!early || attempt >= EXECUTE_RETRIES) throw error;
      await sleep(EXECUTE_RETRY_MS);
    }
  }
  const freeze = await read(
    "events_since",
    () => findEvent(reader, cursor, (e) => e.kind === "op_frozen" && e.data.op_id === opId, call),
    (event) => event !== null,
  );
  if (!freeze) throw new Error(`No op_frozen event for withdrawal ${opId}`);
  const frozenAt = BigInt(freeze.block_timestamp);
  if (frozenAt >= original) {
    throw new Error(
      `Withdrawal ${opId} froze at ${iso(frozenAt)}, not before the original executable_at ${iso(original)}`,
    );
  }
  ctx.log(
    `Contract froze the transaction ${(original - frozenAt) / 1_000_000_000n} s before the original Delay would have ended`,
  );

  for (let i = 0; i < (frozen?.sighashes.length ?? 0); i++) {
    const started = Date.now();
    await call("sign_input", () => owner.signInput(opId, i));
    ctx.log(
      `Input ${i} co-signed by the NEAR MPC network in ${((Date.now() - started) / 1000).toFixed(1)} s`,
    );
  }
  const signed = await read(
    "get_op",
    () => reader.getOp(opId),
    (op) => op.state === "signed",
  );
  if (signed.state !== "signed") throw new Error(`Op ${opId} is ${signed.state}, expected signed`);
  const txid = await within(3 * deps.rpcTimeoutMs, "broadcasting the withdrawal", () =>
    bitcoin.broadcast(signed, kit.vault_script_hex),
  );
  const received = await within(deps.rpcTimeoutMs, "reading the destination", () =>
    bitcoin.received(destination, txid),
  );
  if (received !== AMOUNT_SATS) throw new Error(`Destination received ${received} sats`);
  ctx.log(`Bitcoin transaction ${txid} confirmed; destination received 500,000 sats`);
}

/** S-7 against the configured Vault Contract on NEAR testnet and Bitcoin regtest. */
export async function runFastApproval(ctx: ScenarioContext): Promise<void> {
  const config = loadJudgeConfig();
  await runFast(ctx, {
    contract: config.vaultContract,
    reader: new NearContractClient({ contractId: config.vaultContract, rpcUrl: config.nearRpcUrl }),
    clock: new NearFinalBlockClock(config.nearRpcUrl),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    rpcTimeoutMs: 60_000,
    createVault: async () => {
      const session = await judgeSession();
      const { rpc, regtest } = session;
      const contact = await createJudgeSubAccount(session, "contact", CONTACT_FUNDING);
      const trusted: Guardian = {
        guardian_key: freshGuardianKey(),
        guardian_account: contact.accountId,
        kind: "trusted_contact",
      };
      const { vaultId } = await createJudgeVault(session, {
        guardians: [judgeGuardian(session), trusted],
        overrides: {
          fast_approval: true,
          delay_ns: TEN_MINUTES,
          policy_change_delay_ns: TEN_MINUTES,
          fast_approval_floor_ns: ONE_MINUTE,
        },
      });
      return {
        vaultId,
        owner: session.client,
        guardian: session.guardianClient,
        guardianAccount: session.guardianAccountId,
        contact: contact.client,
        contactAccount: contact.accountId,
        envelopeKey: session.watcher,
        bitcoin: {
          fund: async (address, sats) => {
            await regtest.fund(address, sats);
            await regtest.mine(1);
            return (await rpc.getUtxos(address)).map(({ txid, vout, value_sats }) => ({
              txid,
              vout,
              value_sats,
            }));
          },
          newAddress: () => regtest.newAddress(),
          broadcast: async (op, vaultScriptHex) => {
            const txid = await completeAndBroadcast(op, vaultScriptHex, session.ownerSecret, rpc);
            await regtest.mine(1);
            return txid;
          },
          received: async (address, txid) => {
            const status = await rpc.getTx(txid);
            if (!status || status.confirmations < 1) return 0n;
            return (await rpc.getUtxos(address))
              .filter((u) => u.txid === txid)
              .reduce((sum, u) => sum + BigInt(u.value_sats), 0n);
          },
        },
      };
    },
  });
}
