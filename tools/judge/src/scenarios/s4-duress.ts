import {
  MINUTE_NS,
  MorrowContractError,
  NETWORK_BUSY,
  NearContractClient,
  executeErrorMessage,
  opStateLabel,
  sealEnvelope,
  vaultStateLabel,
  type BitcoinBackend,
  type ContractClient,
  type EnvelopeKeypair,
  type Hex,
  type Outpoint,
} from "@morrow/core-ts";
import {
  ClawbackRunner,
  DuressHandler,
  EventLoop,
  InMemoryDuressStore,
  InMemoryJobStore,
  InMemoryStore,
  NearFinalBlockClock,
  duressDueAt,
  guardianBroadcaster,
  type BroadcastSigned,
  type ChainClock,
  type ClawbackJob,
  type JobStore,
  type Logger,
} from "@morrow/watcher";
import { eventCount, findEvent, message, readAfter, within, type Call } from "../chain.js";
import { loadJudgeConfig } from "../config.js";
import type { ScenarioContext } from "../scenarios.js";
import { createJudgeVault, judgeGuardian, judgeSession } from "../session.js";

const FUNDING_SATS = 1_000_000n;
const THEFT_SATS = 900_000n;
/** How often S-4 ticks the in-process Watcher and checks on it. */
const POLL_MS = 2_000;
/** How long the duress handler may take to queue the Clawback once the request is on-chain. */
const JOB_WAIT_MS = 60_000;
/** How long the runner may take to begin, co-sign, broadcast and confirm the Clawback. */
const SWEEP_WAIT_MS = 180_000;

/** Bitcoin regtest, as S-4 and the Watcher's Clawback runner use it. */
export interface DuressBitcoin {
  /** Funds `address` with `sats`, mines it and returns the address's coins. */
  fund(address: string, sats: bigint): Promise<Outpoint[]>;
  newAddress(): Promise<string>;
  /** What the runner reads and S-4 checks balances with. */
  backend: BitcoinBackend;
  /** The runner's broadcaster: Guardian witnesses on the co-signed Clawback, then broadcast. */
  broadcastSigned: BroadcastSigned;
  /** Mines one block, so a broadcast Clawback confirms. */
  mine(): Promise<void>;
}

/** The S-4 Vault and the clients that act on it. */
export interface CoercedVault {
  vaultId: string;
  /** Signed by the (coerced) Owner. */
  owner: ContractClient;
  /** Signed by the session Guardian, the Vault's `auto_clawback` Guardian: the runner's signer. */
  guardian: ContractClient;
  guardianAccount: string;
  /** The Guardian's compressed Bitcoin key, as the Vault's Policy lists it. */
  guardianKey: Hex;
  /** The Vault's watcher key: the duress handler opens the envelopes with it. */
  envelopeKey: EnvelopeKeypair;
  bitcoin: DuressBitcoin;
}

export interface DuressScenarioDeps {
  /** Unsigned client for views: the Watcher's reads and every assertion. */
  reader: ContractClient;
  /** The latest final NEAR block time: the Watcher's "now". */
  clock: ChainClock;
  sleep(ms: number): Promise<void>;
  /** Wall-clock time in milliseconds, for the deadlines. */
  now(): number;
  /** Creates the S-4 Vault. */
  createVault(): Promise<CoercedVault>;
  /** The Watcher's Clawback queue (in-memory in Judge Mode). */
  jobs: JobStore;
  /** The limit for each RPC call and transaction (Vault creation and Watcher ticks get 3x). */
  rpcTimeoutMs: number;
}

const iso = (ns: bigint) => new Date(Number(ns / 1_000_000n)).toISOString();

/** `path.key` for every key of `value`, at any depth, whose name contains "duress". */
export function duressFields(value: unknown, path: string): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => duressFields(item, `${path}[${i}]`));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => [
    ...(/duress/i.test(key) ? [`${path}.${key}`] : []),
    ...duressFields(inner, `${path}.${key}`),
  ]);
}

const sameCoin = (a: { txid: string; vout: number }, b: { txid: string; vout: number }) =>
  a.txid === b.txid && a.vout === b.vout;

const sum = (coins: { value_sats: string }[]) =>
  coins.reduce((total, u) => total + BigInt(u.value_sats), 0n);

/**
 * S-4 Duress: a coerced Owner's withdrawal looks normal on-chain, yet the Guardian Watcher's
 * duress handler queues a Clawback and its runner sends every coin to the Recovery Address. The
 * attacker gets 0 sats, the coerced Execute is refused, and a duress-mode client still shows the
 * request as Pending. Both Watcher parts are the real ones, run in this process as the Vault's
 * Auto-Clawback Guardian with in-memory stores.
 */
export async function runDuress(ctx: ScenarioContext, deps: DuressScenarioDeps): Promise<void> {
  const { reader, clock, sleep, now, jobs } = deps;
  const call: Call = (what, work) => within(deps.rpcTimeoutMs, what, work);
  const read = <T>(what: string, work: () => Promise<T>, settled: (value: T) => boolean) =>
    readAfter(sleep, call, what, work, settled);
  const vault = await within(3 * deps.rpcTimeoutMs, "creating the S-4 Vault", deps.createVault);
  const { vaultId, owner, guardianAccount, bitcoin } = vault;
  const { backend } = bitcoin;

  const { policy } = await read(
    "get_vault",
    () => reader.getVault(vaultId),
    () => true,
  );
  const guardian = policy.guardians.find((g) => g.guardian_account === guardianAccount);
  if (
    guardian?.kind !== "auto_clawback" ||
    guardian.guardian_key.toLowerCase() !== vault.guardianKey.toLowerCase() ||
    policy.watcher_x25519_pk !== vault.envelopeKey.publicKeyHex ||
    policy.delay_ns !== MINUTE_NS.toString()
  ) {
    throw new Error(
      `Vault ${vaultId} does not have the S-4 Policy (a 1-minute Delay, ${guardianAccount} as its Auto-Clawback Guardian, the session watcher key)`,
    );
  }
  ctx.log(
    `Vault ${vaultId}: the Watcher's duress handler and Clawback runner run in-process as its Auto-Clawback Guardian ${guardianAccount}`,
  );

  const kit = await read(
    "get_vault_kit",
    () => reader.getVaultKit(vaultId),
    () => true,
  );
  const utxos = await within(3 * deps.rpcTimeoutMs, "funding the Vault on regtest", () =>
    bitcoin.fund(kit.addresses.vault, FUNDING_SATS),
  );
  const attacker = await within(deps.rpcTimeoutMs, "getnewaddress", () => bitcoin.newAddress());
  ctx.log(`Vault ${vaultId} holds 0.01 BTC on regtest`);

  // The Watcher's own log stays out of the Judge Mode output; only its last problem is kept.
  let lastProblem: string | null = null;
  const log: Logger = (level, msg, fields) => {
    if (level === "error" || level === "warn") {
      lastProblem = fields?.error ? `${msg}: ${String(fields.error)}` : msg;
    }
  };
  // No history replay: the Watcher starts at the contract's current event count.
  const cursor = await eventCount(reader, call);
  const progress = new InMemoryStore();
  await progress.commit(cursor.toString(), "0");
  const loop = new EventLoop({
    client: reader,
    store: progress,
    handlers: [
      new DuressHandler({
        reader,
        guardianAccount,
        store: new InMemoryDuressStore(),
        jobs,
        envelopeKeypair: vault.envelopeKey,
        challengeOwnerParent: null,
      }),
    ],
    clock,
    log,
  });
  /** One pass of the Watcher's event loop; a failed pass is kept as the last problem. */
  const tickWatcher = () =>
    within(3 * deps.rpcTimeoutMs, "the duress handler's event loop", () =>
      loop.tick().catch((error: unknown) => {
        lastProblem = `poll failed: ${message(error)}`;
        return 0;
      }),
    );

  const normal = await sealEnvelope("normal", policy.watcher_x25519_pk);
  const duress = await sealEnvelope("duress", policy.watcher_x25519_pk);
  ctx.log(
    "You are coerced: the Owner requests 900,000 sats to the attacker, with a duress-flagged Watcher Envelope",
  );
  const opId = await call("request_withdrawal", () =>
    owner.requestWithdrawal({
      vault_id: vaultId,
      amount_sats: THEFT_SATS.toString(),
      destination: attacker,
      fee_rate_sat_vb: 2,
      utxos,
      envelope: duress,
    }),
  );
  const requested = await read(
    "get_op",
    () => reader.getOp(opId),
    () => true,
  );
  if (requested.executable_at === null) throw new Error(`Withdrawal ${opId} has no executable_at`);
  const event = await read(
    "events_since",
    () =>
      findEvent(
        reader,
        cursor,
        (e) => e.kind === "withdrawal_requested" && e.data.op_id === opId,
        call,
      ),
    (found) => found !== null,
  );
  if (event?.kind !== "withdrawal_requested") {
    throw new Error(`No withdrawal_requested event for withdrawal ${opId}`);
  }
  const onChain = event.data.envelope;
  if (onChain.length !== normal.length) {
    throw new Error(
      `Duress leak: the withdrawal_requested envelope is ${onChain.length} hex characters, a normal one ${normal.length}`,
    );
  }
  if (onChain !== duress) {
    throw new Error(`The withdrawal_requested event does not carry the envelope S-4 sent`);
  }
  const leaks = [
    ...duressFields(event, "withdrawal_requested"),
    ...duressFields(requested, "get_op"),
  ];
  if (leaks.length > 0) throw new Error(`Duress leak: ${leaks.join(", ")}`);
  ctx.log(
    `Withdrawal ${opId} looks normal on-chain: a ${onChain.length}-hex envelope like any other, and no duress field in the event or get_op`,
  );

  const jobDeadline = now() + JOB_WAIT_MS;
  let job: ClawbackJob | undefined;
  for (;;) {
    await tickWatcher();
    job = (await jobs.jobs()).find((j) => j.vault_id === vaultId);
    if (job) break;
    if (now() >= jobDeadline) {
      throw new Error(
        `The Watcher queued no Clawback for Vault ${vaultId} within 60 s; last error: ${lastProblem ?? "none"}`,
      );
    }
    await sleep(POLL_MS);
  }
  if (job.trigger !== "duress") {
    throw new Error(
      `The Watcher queued a ${job.trigger} Clawback for Vault ${vaultId}, expected duress`,
    );
  }
  // The 8.2 time, from chain values: min(executable_at, first signal + Delay) − 65 min, or the
  // moment the job was queued once that has passed.
  const scheduled = duressDueAt(
    BigInt(event.block_timestamp),
    BigInt(policy.delay_ns),
    [BigInt(requested.executable_at)],
    0n,
  );
  const checkedAt = await call("block", () => clock.now());
  const dueAt = BigInt(job.due_at);
  if (scheduled > checkedAt) {
    throw new Error(
      `min(executable_at, signal + Delay) − 65 min is ${iso(scheduled)}, still ahead of NEAR time ${iso(checkedAt)}: S-4 cannot wait for it`,
    );
  }
  if (dueAt < scheduled || dueAt > checkedAt) {
    throw new Error(
      `The duress Clawback is due at ${iso(dueAt)}; min(executable_at, signal + Delay) − 65 min is ${iso(scheduled)}, already passed, so it must be due at once (NEAR time ${iso(checkedAt)})`,
    );
  }
  ctx.log(
    `Duress Clawback queued for ${iso(dueAt)}: min(executable_at, signal + Delay) − 65 min = ${iso(scheduled)} has already passed with the 1-minute Delay, so it is due at once`,
  );

  const coins = await within(deps.rpcTimeoutMs, "reading the Vault Address", () =>
    backend.getUtxos(kit.addresses.vault),
  );
  for (const utxo of utxos) {
    const spender = await call("gettxspendingprevout", () => backend.getSpender(utxo));
    if (!coins.some((c) => sameCoin(c, utxo)) || spender) {
      throw new Error(
        `The Vault coin ${utxo.txid}:${utxo.vout} was spent before the duress Clawback ran`,
      );
    }
  }
  ctx.log("No Vault Address spend before the scheduled time: the Vault coin is still unspent");

  const runner = new ClawbackRunner({
    reader,
    signer: vault.guardian,
    guardianAccount,
    guardianKey: vault.guardianKey,
    backend,
    broadcastSigned: bitcoin.broadcastSigned,
    jobs,
    clock,
    log,
  });
  const sweepDeadline = now() + SWEEP_WAIT_MS;
  let done: ClawbackJob;
  for (;;) {
    // An MPC signature can take a while: each pass gets three times the RPC limit.
    await within(3 * deps.rpcTimeoutMs, "the Clawback runner", () => runner.tick());
    const current = await jobs.job(job.job_id);
    if (!current) throw new Error(`Clawback job ${job.job_id} disappeared`);
    const problem = () => current.last_error ?? lastProblem ?? "none";
    if (current.status === "done") {
      done = current;
      break;
    }
    if (current.status === "lost" || current.status === "failed") {
      throw new Error(`Clawback job ${job.job_id} is ${current.status}; last error: ${problem()}`);
    }
    if (now() >= sweepDeadline) {
      throw new Error(
        `Clawback job ${job.job_id} is ${current.status} after 180 s; last error: ${problem()}`,
      );
    }
    if (current.status === "broadcast") {
      await within(deps.rpcTimeoutMs, "mining a block", () => bitcoin.mine());
    }
    await sleep(POLL_MS);
  }

  const confirmed = (done.sweeps ?? []).filter((s) => s.state === "confirmed");
  for (const utxo of utxos) {
    if (!confirmed.some((s) => s.utxos.some((u) => sameCoin(u, utxo)))) {
      throw new Error(`The duress Clawback did not sweep the Vault coin ${utxo.txid}:${utxo.vout}`);
    }
  }
  const recovered = await within(deps.rpcTimeoutMs, "reading the Recovery Address", () =>
    backend.getUtxos(policy.recovery_address),
  );
  for (const sweep of confirmed) {
    const op = await read(
      "get_op",
      () => reader.getOp(sweep.op_id ?? ""),
      () => true,
    );
    if (op.kind !== "clawback" || op.destination !== policy.recovery_address) {
      throw new Error(`Op ${op.op_id} is a ${op.kind} to ${op.destination}, not a Clawback home`);
    }
    const home = sum(recovered.filter((u) => u.txid === sweep.txid));
    if (home !== BigInt(op.amount_sats)) {
      throw new Error(
        `The Recovery Address received ${home} sats from Clawback ${sweep.txid}, expected ${op.amount_sats}`,
      );
    }
    ctx.log(
      `Clawback ${sweep.txid} confirmed: ${home} sats back at the Recovery Address, co-signed by the NEAR MPC network and broadcast by the Watcher's runner`,
    );
  }

  const executeEnvelope = await sealEnvelope("duress", policy.watcher_x25519_pk);
  let refusal: unknown = null;
  try {
    await call("begin_execute", () => owner.beginExecute(opId, executeEnvelope));
  } catch (error) {
    refusal = error;
  }
  if (refusal === null) throw new Error("The coerced Execute succeeded; expected ERR_CLAWED_BACK");
  if (!(refusal instanceof MorrowContractError && refusal.code === "ERR_CLAWED_BACK")) {
    throw refusal;
  }
  ctx.log("Coerced Execute rejected: ERR_CLAWED_BACK");

  const stolen = sum(
    await within(deps.rpcTimeoutMs, "reading the attacker address", () =>
      backend.getUtxos(attacker),
    ),
  );
  if (stolen !== 0n) throw new Error(`Attacker received ${stolen} sats`);
  ctx.log("Attacker received 0 sats");

  const op = await read(
    "get_op",
    () => reader.getOp(opId),
    (o) => o.state === "voided",
  );
  const closed = await read(
    "get_vault",
    () => reader.getVault(vaultId),
    (v) => v.state === "clawed_back",
  );
  if (op.state !== "voided") throw new Error(`Withdrawal ${opId} is ${op.state}, expected voided`);
  if (closed.state !== "clawed_back") {
    throw new Error(`Vault ${vaultId} is ${closed.state}, expected clawed_back`);
  }
  const shown = {
    request: opStateLabel(op.state, "duress"),
    vault: vaultStateLabel(closed.state, "duress"),
    execute: executeErrorMessage(refusal, "duress"),
  };
  if (shown.request !== "Pending" || shown.vault !== "Pending" || shown.execute !== NETWORK_BUSY) {
    throw new Error(
      `A duress-mode client shows the request as ${shown.request}, the Vault as ${shown.vault} and Execute as "${shown.execute}"`,
    );
  }
  ctx.log(
    `Normal mode shows withdrawal ${opId} as ${opStateLabel(op.state, "normal")} and Execute as ERR_CLAWED_BACK`,
  );
  ctx.log("Duress mode still shows the request as Pending, and Execute as network busy");
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** S-4 against the configured Vault Contract on NEAR testnet and Bitcoin regtest. */
export async function runDuressScenario(ctx: ScenarioContext): Promise<void> {
  const config = loadJudgeConfig();
  const reader = new NearContractClient({
    contractId: config.vaultContract,
    rpcUrl: config.nearRpcUrl,
  });
  await runDuress(ctx, {
    reader,
    clock: new NearFinalBlockClock(config.nearRpcUrl),
    sleep,
    now: () => Date.now(),
    jobs: new InMemoryJobStore(),
    rpcTimeoutMs: 60_000,
    createVault: async () => {
      const session = await judgeSession();
      const { rpc, regtest } = session;
      // The session Guardian is the Vault's Auto-Clawback Guardian: the in-process Watcher acts
      // as it, with its NEAR account and its Bitcoin key.
      const { vaultId } = await createJudgeVault(session, {
        guardians: [{ ...judgeGuardian(session), kind: "auto_clawback" }],
      });
      return {
        vaultId,
        owner: session.client,
        guardian: session.guardianClient,
        guardianAccount: session.guardianAccountId,
        guardianKey: session.guardianKey,
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
          backend: rpc,
          broadcastSigned: guardianBroadcaster(reader, rpc, session.guardianSecret),
          mine: async () => {
            await regtest.mine(1);
          },
        },
      };
    },
  });
}
