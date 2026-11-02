import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  BitcoindRpc,
  MIN_VAULT_STORAGE_YOCTO,
  MINUTE_NS,
  MorrowContractError,
  NEAR_RPC_URLS,
  NearContractClient,
  RegtestControl,
  bytesToHex,
  completeAndBroadcast,
  createTestnetAccount,
  generateEnvelopeKeypair,
  presetPolicy,
  sealEnvelope,
  type ContractClient,
  type Hex,
  type Outpoint,
  type SpendOp,
  type U64,
  type VaultKit,
} from "@morrow/core-ts";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js";
import { describe, expect, it } from "vitest";
import { NearFinalBlockClock } from "../clock.js";
import { createLogger } from "../log.js";
import { EventLoop } from "../loop.js";
import { InMemoryStore } from "../store.js";
import { ClawbackIndexHandler } from "./index-handler.js";
import { InMemoryJobStore, type ClawbackJob } from "./jobs.js";
import { ClawbackRunner, guardianBroadcaster } from "./runner.js";

const env = process.env;
const enabled = env.MORROW_E2E === "1" && Boolean(env.MORROW_REGTEST_RPC);
const VAULT_CONTRACT = env.MORROW_VAULT_CONTRACT ?? "morrow-vault-dev3.testnet";
const NEAR_RPC = env.MORROW_NEAR_RPC_URL ?? NEAR_RPC_URLS.testnet;
const THIEF_RATE = 3;
const VAULT_SATS = 1_000_000n;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const publicKeyHex = (secret: Uint8Array) => bytesToHex(secp256k1.getPublicKey(secret, true));

/** The highest event seq so far, so the index starts at our Vaults and not at the contract's first event. */
async function latestSeq(client: ContractClient): Promise<string> {
  const after = async (seq: bigint) => (await client.eventsSince(seq.toString(), 1)).length > 0;
  let low = 0n;
  let high = 0n;
  while (await after(high)) {
    low = high;
    high = high === 0n ? 1024n : high * 2n;
  }
  while (high - low > 1n) {
    const mid = (low + high) / 2n;
    if (await after(mid)) low = mid;
    else high = mid;
  }
  return high.toString();
}

/** Views may lag a just-landed call on a load-balanced RPC: wait until every input is signed. */
async function signedOp(client: ContractClient, opId: U64): Promise<SpendOp> {
  for (let attempt = 0; ; attempt++) {
    const op = await client.getOp(opId);
    if (op.signatures.every((s) => s !== null) || attempt >= 30) return op;
    await sleep(2_000);
  }
}

/** An Owner account (faucet, or a funded sub-account in CI) and a Guardian sub-account. */
async function accounts() {
  const provider = new JsonRpcProvider({ url: NEAR_RPC });
  const ownerKey = KeyPair.fromRandom("ed25519");
  let ownerId = `morrow-race-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.testnet`;
  if (env.MORROW_JUDGE_FUNDER_ACCOUNT && env.MORROW_JUDGE_FUNDER_KEY) {
    ownerId = `r${Date.now().toString(36)}.${env.MORROW_JUDGE_FUNDER_ACCOUNT}`;
    await new Account(
      env.MORROW_JUDGE_FUNDER_ACCOUNT,
      provider,
      KeyPairSigner.fromSecretKey(env.MORROW_JUDGE_FUNDER_KEY as never),
    ).createSubAccount({
      accountOrPrefix: ownerId,
      publicKey: ownerKey.getPublicKey(),
      nearToTransfer: 2_500_000_000_000_000_000_000_000n,
    });
  } else {
    await createTestnetAccount(ownerId, ownerKey.getPublicKey().toString());
  }
  const guardianKey = KeyPair.fromRandom("ed25519");
  const guardianId = `guardian.${ownerId}`;
  await new Account(ownerId, provider, new KeyPairSigner(ownerKey)).createSubAccount({
    accountOrPrefix: guardianId,
    publicKey: guardianKey.getPublicKey(),
    nearToTransfer: 500_000_000_000_000_000_000_000n,
  });
  const client = (accountId: string, key: KeyPair) =>
    new NearContractClient({
      contractId: VAULT_CONTRACT,
      rpcUrl: NEAR_RPC,
      signer: { accountId, secretKey: key.toString() },
    });
  return {
    owner: client(ownerId, ownerKey),
    guardian: client(guardianId, guardianKey),
    guardianId,
  };
}

interface Theft {
  vaultId: U64;
  kit: VaultKit;
  recovery: string;
  attacker: string;
  utxo: Outpoint;
  opId: U64;
  envelope: Hex;
}

describe.skipIf(!enabled)("Auto-Clawback mempool race on regtest (e2e)", () => {
  it(
    "replaces a thief's withdrawal at >= 2x its fee rate, and ends pinned against a CPFP child",
    { timeout: 20 * 60_000 },
    async () => {
      const log = createLogger("race-e2e");
      const rpc = new BitcoindRpc(env.MORROW_REGTEST_RPC ?? "");
      const regtest = new RegtestControl(rpc);
      const reader = new NearContractClient({ contractId: VAULT_CONTRACT, rpcUrl: NEAR_RPC });
      const { owner, guardian, guardianId } = await accounts();
      const ownerSecret = secp256k1.utils.randomSecretKey();
      const guardianSecret = secp256k1.utils.randomSecretKey();
      const watcher = await generateEnvelopeKeypair();
      const cursor = await latestSeq(reader);

      // Two funded Vaults whose Owner keys the thief holds.
      const thefts: Theft[] = [];
      for (let i = 0; i < 2; i++) {
        const recovery = await regtest.newAddress();
        const vaultId = await owner.createVault({
          owner_key: publicKeyHex(ownerSecret),
          deposit_yocto: MIN_VAULT_STORAGE_YOCTO.toString(),
          policy: {
            ...presetPolicy("standard", {
              plannedDepositSats: 10_000_000n,
              guardians: [
                {
                  guardian_key: publicKeyHex(guardianSecret),
                  guardian_account: guardianId,
                  kind: "auto_clawback",
                },
              ],
              recoveryAddress: recovery,
              network: "regtest",
              watcherX25519Pk: watcher.publicKeyHex,
            }),
            delay_ns: MINUTE_NS.toString(),
            policy_change_delay_ns: MINUTE_NS.toString(),
            fast_approval_floor_ns: MINUTE_NS.toString(),
            escape_timelock_blocks: 6,
          },
        });
        const kit = await reader.getVaultKit(vaultId);
        await regtest.fund(kit.addresses.vault, VAULT_SATS);
        thefts.push({
          vaultId,
          kit,
          recovery,
          attacker: await regtest.newAddress(),
          utxo: { txid: "", vout: 0, value_sats: "0" },
          opId: "",
          envelope: "",
        });
      }
      await regtest.mine(1);

      let executableAt = 0n;
      for (const theft of thefts) {
        const [utxo] = await rpc.getUtxos(theft.kit.addresses.vault);
        if (!utxo) throw new Error(`Vault ${theft.vaultId} is not funded`);
        theft.utxo = { txid: utxo.txid, vout: utxo.vout, value_sats: utxo.value_sats };
        theft.envelope = await sealEnvelope("normal", watcher.publicKeyHex);
        theft.opId = await owner.requestWithdrawal({
          vault_id: theft.vaultId,
          amount_sats: "900000",
          destination: theft.attacker,
          fee_rate_sat_vb: THIEF_RATE,
          utxos: [theft.utxo],
          envelope: theft.envelope,
        });
        executableAt = BigInt((await reader.getOp(theft.opId)).executable_at ?? "0");
      }

      // The thief waits out the Delay, gets the withdrawals co-signed and broadcasts them.
      await sleep(Math.max(0, Number(executableAt / 1_000_000n) - Date.now()) + 2_000);
      const thiefTxids: Hex[] = [];
      for (const theft of thefts) {
        let frozen: SpendOp;
        for (let attempt = 0; ; attempt++) {
          try {
            frozen = await owner.beginExecute(theft.opId, theft.envelope);
            break;
          } catch (error) {
            const early =
              error instanceof MorrowContractError && error.code === "ERR_NOT_EXECUTABLE";
            if (!early || attempt >= 60) throw error;
            await sleep(3_000);
          }
        }
        for (let i = 0; i < frozen.sighashes.length; i++) await owner.signInput(theft.opId, i);
        const signed = await signedOp(reader, theft.opId);
        thiefTxids.push(
          await completeAndBroadcast(signed, theft.kit.vault_script_hex, ownerSecret, rpc),
        );
      }

      // On the second Vault the thief pins the withdrawal with a high-fee child.
      const pinned = thefts[1]!;
      const parent = await rpc.call<{
        vout: { n: number; value: number; scriptPubKey: { address?: string; hex: string } }[];
      }>("getrawtransaction", [thiefTxids[1], true]);
      const paid = parent.vout.find((o) => o.scriptPubKey.address === pinned.attacker)!;
      const unsignedChild = await rpc.call<string>("createrawtransaction", [
        [{ txid: thiefTxids[1], vout: paid.n }],
        [{ [await regtest.newAddress()]: "0.00600000" }], // 900,000 in: a 300,000 sat fee
      ]);
      const child = await rpc.call<{ hex: string; complete: boolean }>(
        "signrawtransactionwithwallet",
        [
          unsignedChild,
          [
            {
              txid: thiefTxids[1],
              vout: paid.n,
              scriptPubKey: paid.scriptPubKey.hex,
              amount: paid.value,
            },
          ],
        ],
        "miner",
      );
      expect(child.complete).toBe(true);
      await rpc.call("sendrawtransaction", [child.hex, 0]);

      // The watcher: frozen-op index from the event feed, then the Auto-Clawback runner.
      const jobs = new InMemoryJobStore();
      const store = new InMemoryStore();
      await store.commit(cursor, "0");
      await new EventLoop({
        client: reader,
        store,
        handlers: [new ClawbackIndexHandler(jobs)],
        clock: { now: async () => 0n },
        log,
      }).tick();
      const runner = new ClawbackRunner({
        reader,
        signer: guardian,
        guardianAccount: guardianId,
        backend: rpc,
        broadcastSigned: guardianBroadcaster(reader, rpc, guardianSecret),
        jobs,
        clock: new NearFinalBlockClock(NEAR_RPC),
        log,
      });
      for (const theft of thefts) await runner.enqueue(theft.vaultId);
      const jobOf = async (theft: Theft) =>
        (await jobs.jobs()).find((j) => j.vault_id === theft.vaultId) as ClawbackJob;
      for (let attempt = 0; attempt < 20; attempt++) {
        await runner.tick();
        const statuses = await Promise.all(thefts.map(async (t) => (await jobOf(t)).status));
        if (statuses.every((s) => s === "broadcast" || s === "pinned")) break;
        await sleep(3_000);
      }

      const raced = await jobOf(thefts[0]!);
      const sweep = raced.sweeps![0]!;
      const thief = sweep.conflicts.find((c) => c.txid === thiefTxids[0])!;
      expect(raced.status).toBe("broadcast");
      expect(thief.fee_rate_sat_vb).toBeGreaterThanOrEqual(THIEF_RATE);
      expect(sweep.fee_rate_sat_vb).toBeGreaterThanOrEqual(2 * thief.fee_rate_sat_vb);
      expect((await rpc.getSpender(thefts[0]!.utxo))?.txid).toBe(sweep.txid);
      expect((await jobOf(pinned)).status).toBe("pinned");

      await regtest.mine(1);
      await runner.tick();
      expect((await jobOf(thefts[0]!)).status).toBe("done");
      const home = await rpc.getUtxos(thefts[0]!.recovery);
      expect(home.map((u) => u.txid)).toContain(sweep.txid);
      expect(await rpc.getUtxos(thefts[0]!.attacker)).toEqual([]);
      // The pinned thief's withdrawal confirmed instead: the job is lost, not retried forever.
      expect((await jobOf(pinned)).status).toBe("lost");
    },
  );
});
