import {
  ERROR_CODES,
  MINUTE_NS,
  MorrowContractError,
  NETWORK_BUSY,
  NearContractClient,
  OP_STATE_LABELS,
  VAULT_STATE_LABELS,
  executeErrorMessage,
  opStateLabel,
  sealEnvelope,
  vaultStateLabel,
  type BitcoinBackend,
  type ContractClient,
  type EnvelopeKeypair,
  type Hex,
  type MorrowEvent,
  type Outpoint,
  type SpendOp,
} from "@morrow/core-ts";
import {
  ClawbackRunner,
  DuressHandler,
  EventLoop,
  InMemoryDuressStore,
  InMemoryJobStore,
  InMemoryStore,
  NearFinalBlockClock,
  VETO_LEAD_NS,
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

/** The S-4 Delay: 10 minutes, still well under the 65-minute lead, so the Clawback is due at once. */
const DELAY_NS = 10n * MINUTE_NS;
/** The coin the coerced Owner tries to send away, and how much of it. */
const FUNDING_SATS = 1_000_000n;
const THEFT_SATS = 900_000n;
/** A second coin for the control request: a normal withdrawal to compare the coerced one with. */
const CONTROL_FUNDING_SATS = 100_000n;
const CONTROL_SATS = 50_000n;
/** How often S-4 ticks the in-process Watcher and checks on it. */
const POLL_MS = 2_000;
/** How long the duress handler may take to queue the Clawback once the request is on-chain. */
const JOB_WAIT_MS = 60_000;
/** How long the runner may take to begin, co-sign, broadcast and confirm the Clawback. */
const SWEEP_WAIT_MS = 180_000;
/** Reads of a NEAR clock that is still behind a job's `due_at`, one second apart. */
const CLOCK_READS = 5;

/** Bitcoin regtest, as S-4 and the Watcher's Clawback runner use it. */
export interface DuressBitcoin {
  /** Funds `address` with `sats`, mines it and returns all of the address's coins. */
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

/** Every key path of `value` (array items merged as `[]`), sorted; values are ignored. */
export function keyShape(value: unknown, path = ""): string[] {
  const paths = new Set<string>();
  const walk = (inner: unknown, at: string) => {
    if (Array.isArray(inner)) {
      for (const item of inner) walk(item, `${at}[]`);
    } else if (typeof inner === "object" && inner !== null) {
      for (const [key, next] of Object.entries(inner)) {
        paths.add(`${at}.${key}`);
        walk(next, `${at}.${key}`);
      }
    }
  };
  walk(value, path);
  return [...paths].sort();
}

/** What differs between two key shapes, or null when they are the same. */
function shapeDifference(control: unknown, coerced: unknown): string | null {
  const a = keyShape(control);
  const b = keyShape(coerced);
  const onlyCoerced = b.filter((k) => !a.includes(k));
  const onlyControl = a.filter((k) => !b.includes(k));
  if (onlyCoerced.length === 0 && onlyControl.length === 0) return null;
  return `only in the coerced one: ${onlyCoerced.join(", ") || "nothing"}; only in the control one: ${onlyControl.join(", ") || "nothing"}`;
}

const sameCoin = (a: { txid: string; vout: number }, b: { txid: string; vout: number }) =>
  a.txid === b.txid && a.vout === b.vout;

const sum = (coins: { value_sats: string }[]) =>
  coins.reduce((total, u) => total + BigInt(u.value_sats), 0n);

const grouped = (sats: bigint) => sats.toLocaleString("en-US");
const seconds = (ms: number) => Math.round(ms / 1_000);
const LEAD_MINUTES = VETO_LEAD_NS / MINUTE_NS;
const DELAY_MINUTES = DELAY_NS / MINUTE_NS;

/**
 * S-4 Duress: a coerced Owner's withdrawal looks like a normal one on-chain, yet the Guardian
 * Watcher's duress handler queues a Clawback and its runner sends every coin to the Recovery
 * Address before any withdrawal could execute. The attacker gets 0 sats, the coerced Execute is
 * refused, and a duress-mode client still shows the request as Pending. Both Watcher parts are the
 * real ones, run in this process as the Vault's Auto-Clawback Guardian with in-memory stores.
 */
export async function runDuress(ctx: ScenarioContext, deps: DuressScenarioDeps): Promise<void> {
  const run = { stopped: false };
  try {
    await duressScenario(ctx, deps, run);
  } finally {
    // A runner pass that timed out may still be in flight: from here on it can send nothing.
    run.stopped = true;
  }
}

async function duressScenario(
  ctx: ScenarioContext,
  deps: DuressScenarioDeps,
  run: { stopped: boolean },
): Promise<void> {
  const { reader, clock, sleep, now, jobs } = deps;
  const call: Call = (what, work) => within(deps.rpcTimeoutMs, what, work);
  const read = <T>(what: string, work: () => Promise<T>, settled: (value: T) => boolean) =>
    readAfter(sleep, call, what, work, settled);
  const whileRunning =
    <A extends unknown[], R>(work: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> =>
      run.stopped ? Promise.reject(new Error("S-4 has ended")) : work(...args);
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
    policy.delay_ns !== DELAY_NS.toString()
  ) {
    throw new Error(
      `Vault ${vaultId} does not have the S-4 Policy (a ${DELAY_MINUTES}-minute Delay, ${guardianAccount} as its Auto-Clawback Guardian, the session watcher key)`,
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
  const fund = (sats: bigint) =>
    within(3 * deps.rpcTimeoutMs, "funding the Vault on regtest", () =>
      bitcoin.fund(kit.addresses.vault, sats),
    );
  const theftCoins = await fund(FUNDING_SATS);
  const utxos = await fund(CONTROL_FUNDING_SATS);
  const controlCoins = utxos.filter((u) => !theftCoins.some((t) => sameCoin(t, u)));
  if (theftCoins.length === 0 || controlCoins.length === 0) {
    throw new Error(`Funding Vault ${vaultId} on regtest did not add two coins`);
  }
  const attacker = await within(deps.rpcTimeoutMs, "getnewaddress", () => bitcoin.newAddress());
  const controlDestination = await within(deps.rpcTimeoutMs, "getnewaddress", () =>
    bitcoin.newAddress(),
  );
  ctx.log(`Vault ${vaultId} holds ${grouped(sum(utxos))} sats on regtest in ${utxos.length} coins`);

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

  const withdraw = (amount: bigint, destination: string, coins: Outpoint[], envelope: string) =>
    call("request_withdrawal", () =>
      owner.requestWithdrawal({
        vault_id: vaultId,
        amount_sats: amount.toString(),
        destination,
        fee_rate_sat_vb: 2,
        utxos: coins,
        envelope,
      }),
    );
  const requestedOp = async (opId: string) => {
    const op = await read(
      "get_op",
      () => reader.getOp(opId),
      () => true,
    );
    if (op.executable_at === null) throw new Error(`Withdrawal ${opId} has no executable_at`);
    return { op, executableAt: BigInt(op.executable_at) };
  };
  const requestedEvent = async (opId: string) => {
    const found = await read(
      "events_since",
      () =>
        findEvent(
          reader,
          cursor,
          (e) => e.kind === "withdrawal_requested" && e.data.op_id === opId,
          call,
        ),
      (e) => e !== null,
    );
    if (found?.kind !== "withdrawal_requested") {
      throw new Error(`No withdrawal_requested event for withdrawal ${opId}`);
    }
    return found as Extract<MorrowEvent, { kind: "withdrawal_requested" }>;
  };

  const normal = await sealEnvelope("normal", policy.watcher_x25519_pk);
  const duress = await sealEnvelope("duress", policy.watcher_x25519_pk);
  const controlId = await withdraw(CONTROL_SATS, controlDestination, controlCoins, normal);
  ctx.log(
    `Control: the Owner requests ${grouped(CONTROL_SATS)} sats with a normal Watcher Envelope (withdrawal ${controlId})`,
  );
  const opId = await withdraw(THEFT_SATS, attacker, theftCoins, duress);
  ctx.log(
    `You are coerced: the Owner requests ${grouped(THEFT_SATS)} sats to the attacker, with a duress-flagged Watcher Envelope (withdrawal ${opId})`,
  );
  const control = { ...(await requestedOp(controlId)), event: await requestedEvent(controlId) };
  const coerced = { ...(await requestedOp(opId)), event: await requestedEvent(opId) };

  for (const [id, sent, event] of [
    [opId, duress, coerced.event],
    [controlId, normal, control.event],
  ] as const) {
    const onChain = event.data.envelope;
    if (onChain.length !== normal.length) {
      throw new Error(
        `Duress leak: the withdrawal_requested envelope of withdrawal ${id} is ${onChain.length} hex characters, a normal one ${normal.length}`,
      );
    }
    if (onChain !== sent) {
      throw new Error(
        `The withdrawal_requested event of withdrawal ${id} does not carry the envelope S-4 sent`,
      );
    }
  }
  const leaks = [
    ...duressFields(coerced.event, `withdrawal_requested[${opId}]`),
    ...duressFields(coerced.op, `get_op[${opId}]`),
    ...duressFields(control.event, `withdrawal_requested[${controlId}]`),
    ...duressFields(control.op, `get_op[${controlId}]`),
  ];
  if (leaks.length > 0) throw new Error(`Duress leak: ${leaks.join(", ")}`);
  for (const [what, a, b] of [
    ["withdrawal_requested event", control.event.data, coerced.event.data],
    ["get_op", control.op, coerced.op],
  ] as const) {
    const difference = shapeDifference(a, b);
    if (difference) {
      throw new Error(
        `Duress leak: the coerced ${what} differs in shape from the control one (${difference})`,
      );
    }
  }
  ctx.log(
    `Withdrawal ${opId} looks like the normal withdrawal ${controlId} on-chain: ${normal.length}-hex envelopes, the same fields in the event and get_op, and no duress field`,
  );

  const jobStarted = now();
  const jobDeadline = jobStarted + JOB_WAIT_MS;
  let job: ClawbackJob | undefined;
  for (;;) {
    await tickWatcher();
    job = (await jobs.jobs()).find((j) => j.vault_id === vaultId);
    if (job) break;
    if (now() >= jobDeadline) {
      throw new Error(
        `The Watcher queued no Clawback for Vault ${vaultId} within ${seconds(now() - jobStarted)} s; last error: ${lastProblem ?? "none"}`,
      );
    }
    await sleep(POLL_MS);
  }
  if (job.trigger !== "duress") {
    throw new Error(
      `The Watcher queued a ${job.trigger} Clawback for Vault ${vaultId}, expected duress`,
    );
  }
  // The 8.2 time, from chain values: min(live executable_at, first signal + Delay) − 65 min, or the
  // moment the job was queued once that has passed. The signal is the coerced request's block.
  const signal = BigInt(coerced.event.block_timestamp);
  const scheduled = duressDueAt(
    signal,
    BigInt(policy.delay_ns),
    [control.executableAt, coerced.executableAt],
    0n,
  );
  if (scheduled > signal) {
    throw new Error(
      `min(executable_at, signal + Delay) − ${LEAD_MINUTES} min is ${iso(scheduled)}, after the duress signal at ${iso(signal)}: the Clawback is not due at once`,
    );
  }
  const dueAt = BigInt(job.due_at);
  // A NEAR clock read a moment ago may still be behind the time the handler read.
  let checkedAt = await call("block", () => clock.now());
  for (let reads = 1; dueAt > checkedAt && reads < CLOCK_READS; reads++) {
    await sleep(1_000);
    checkedAt = await call("block", () => clock.now());
  }
  if (dueAt < signal || dueAt > checkedAt) {
    throw new Error(
      `The duress Clawback is due at ${iso(dueAt)}; min(executable_at, signal + Delay) − ${LEAD_MINUTES} min is ${iso(scheduled)}, already passed, so it must be due at once: between the duress signal ${iso(signal)} and NEAR time ${iso(checkedAt)}`,
    );
  }
  ctx.log(
    `Duress Clawback queued for ${iso(dueAt)}: min(executable_at, signal + Delay) − ${LEAD_MINUTES} min = ${iso(scheduled)} has already passed with the ${DELAY_MINUTES}-minute Delay, so it is due at once`,
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
  ctx.log("The Vault coins are still unspent when the Clawback runner starts");

  const signer = new Proxy(vault.guardian, {
    get: (target, prop, receiver) => {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      return whileRunning((...args: unknown[]) =>
        Promise.resolve((value as (...a: unknown[]) => unknown).apply(target, args)),
      );
    },
  });
  const runner = new ClawbackRunner({
    reader,
    signer,
    guardianAccount,
    guardianKey: vault.guardianKey,
    backend,
    broadcastSigned: whileRunning(bitcoin.broadcastSigned),
    jobs,
    clock,
    log,
  });
  const sweepStarted = now();
  const sweepDeadline = sweepStarted + SWEEP_WAIT_MS;
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
        `Clawback job ${job.job_id} is ${current.status} after ${seconds(now() - sweepStarted)} s; last error: ${problem()}`,
      );
    }
    if (current.status === "broadcast" || current.status === "pinned") {
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
  const firstExecutable =
    control.executableAt < coerced.executableAt ? control.executableAt : coerced.executableAt;
  let lastBegun = 0n;
  for (const sweep of confirmed) {
    const sweepOp = sweep.op_id;
    if (sweepOp === null) throw new Error(`Confirmed Clawback ${sweep.txid} has no op_id`);
    const op: SpendOp = await read(
      "get_op",
      () => reader.getOp(sweepOp),
      () => true,
    );
    if (op.kind !== "clawback" || op.destination !== policy.recovery_address) {
      throw new Error(`Op ${op.op_id} is a ${op.kind} to ${op.destination}, not a Clawback home`);
    }
    // `begin_clawback` stores its own block time as the op's `created_at`.
    const begun = BigInt(op.created_at);
    if (begun >= firstExecutable) {
      throw new Error(
        `Clawback op ${op.op_id} began at ${iso(begun)}, not before a withdrawal could execute at ${iso(firstExecutable)}`,
      );
    }
    if (begun > lastBegun) lastBegun = begun;
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
  ctx.log(
    `The Clawback began ${(firstExecutable - lastBegun) / 1_000_000_000n} s before either withdrawal could execute`,
  );

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

  const received = (address: string) =>
    within(deps.rpcTimeoutMs, "reading a destination", () => backend.getUtxos(address)).then(sum);
  const stolen = await received(attacker);
  if (stolen !== 0n) throw new Error(`Attacker received ${stolen} sats`);
  const controlPaid = await received(controlDestination);
  if (controlPaid !== 0n) throw new Error(`The control destination received ${controlPaid} sats`);
  ctx.log("Attacker received 0 sats");

  const voided = (id: string) =>
    read(
      "get_op",
      () => reader.getOp(id),
      (o) => o.state === "voided",
    );
  const op = await voided(opId);
  const controlOp = await voided(controlId);
  const closed = await read(
    "get_vault",
    () => reader.getVault(vaultId),
    (v) => v.state === "clawed_back",
  );
  const duressShown = {
    request: opStateLabel(op.state, "duress"),
    vault: vaultStateLabel(closed.state, "duress"),
    execute: executeErrorMessage(refusal, "duress"),
  };
  if (
    duressShown.request !== OP_STATE_LABELS.pending ||
    duressShown.vault !== VAULT_STATE_LABELS.active ||
    duressShown.execute !== NETWORK_BUSY
  ) {
    throw new Error(
      `A duress-mode client shows the request as ${duressShown.request}, the Vault as ${duressShown.vault} and Execute as "${duressShown.execute}"`,
    );
  }
  for (const o of [op, controlOp]) {
    if (o.state !== "voided")
      throw new Error(`Withdrawal ${o.op_id} is ${o.state}, expected voided`);
  }
  if (closed.state !== "clawed_back") {
    throw new Error(`Vault ${vaultId} is ${closed.state}, expected clawed_back`);
  }
  const normalShown = {
    request: opStateLabel(op.state, "normal"),
    vault: vaultStateLabel(closed.state, "normal"),
    execute: executeErrorMessage(refusal, "normal"),
  };
  if (
    normalShown.request !== OP_STATE_LABELS.voided ||
    normalShown.vault !== VAULT_STATE_LABELS.clawed_back ||
    normalShown.execute !== ERROR_CODES.ERR_CLAWED_BACK
  ) {
    throw new Error(
      `A normal client shows the request as ${normalShown.request}, the Vault as ${normalShown.vault} and Execute as "${normalShown.execute}"`,
    );
  }
  ctx.log(
    `Normal mode shows withdrawal ${opId} as ${normalShown.request}, the Vault as ${normalShown.vault}, and Execute as "${normalShown.execute}"`,
  );
  ctx.log(
    "Duress mode still shows the request as Pending, the Vault as Active, and Execute as network busy",
  );
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
        // The Policy Change Delay may never be below the Delay.
        overrides: { delay_ns: DELAY_NS.toString(), policy_change_delay_ns: DELAY_NS.toString() },
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
