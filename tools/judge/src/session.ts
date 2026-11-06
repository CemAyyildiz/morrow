import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  BitcoindRpc,
  MIN_VAULT_STORAGE_YOCTO,
  MINUTE_NS,
  NearContractClient,
  RegtestControl,
  bytesToHex,
  createTestnetAccount,
  generateEnvelopeKeypair,
  presetPolicy,
  type EnvelopeKeypair,
  type Guardian,
  type Policy,
} from "@morrow/core-ts";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js";
import { loadJudgeConfig, type JudgeConfig } from "./config.js";

/** One faucet account and one set of keys, shared by every Scenario in a run. */
export interface JudgeSession {
  config: JudgeConfig;
  accountId: string;
  client: NearContractClient;
  ownerSecret: Uint8Array;
  ownerKey: string;
  /** A second faucet account acting as the Guardian, with its own Bitcoin key. */
  guardianAccountId: string;
  guardianClient: NearContractClient;
  guardianSecret: Uint8Array;
  guardianKey: string;
  /** The Owner account's NEAR key, for sub-accounts a Scenario needs of its own (S-6). */
  ownerNearKey: KeyPair;
  watcher: EnvelopeKeypair;
  rpc: BitcoindRpc;
  regtest: RegtestControl;
}

/** A fresh, unique testnet account id for this run. */
export function judgeAccountId(now = Date.now(), random = Math.random()): string {
  return `morrow-judge-${now.toString(36)}-${random.toString(36).slice(2, 8)}.testnet`;
}

const publicKeyHex = (secret: Uint8Array) => bytesToHex(secp256k1.getPublicKey(secret, true));

let current: Promise<JudgeSession> | null = null;

export function judgeSession(config: JudgeConfig = loadJudgeConfig()): Promise<JudgeSession> {
  current ??= (async () => {
    // The Owner account comes from the public faucet, or from a funded account when one is
    // configured (CI). The Guardian is a sub-account funded by the Owner: one faucet call per run.
    const provider = new JsonRpcProvider({ url: config.nearRpcUrl });
    const ownerKey = KeyPair.fromRandom("ed25519");
    let ownerId = judgeAccountId();
    if (config.funder) {
      ownerId = `j${Date.now().toString(36)}.${config.funder.accountId}`;
      const funder = new Account(
        config.funder.accountId,
        provider,
        KeyPairSigner.fromSecretKey(config.funder.secretKey as never),
      );
      await funder.createSubAccount({
        accountOrPrefix: ownerId,
        publicKey: ownerKey.getPublicKey(),
        // Six Vaults at 0.5 NEAR of storage each, the Guardian and S-6's and S-7's own accounts.
        nearToTransfer: 5_000_000_000_000_000_000_000_000n,
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
        contractId: config.vaultContract,
        rpcUrl: config.nearRpcUrl,
        signer: { accountId, secretKey: key.toString() },
      });
    const owner = { accountId: ownerId, client: client(ownerId, ownerKey) };
    const guardian = { accountId: guardianId, client: client(guardianId, guardianKey) };
    const rpc = new BitcoindRpc(config.regtestRpcUrl);
    const ownerSecret = secp256k1.utils.randomSecretKey();
    const guardianSecret = secp256k1.utils.randomSecretKey();
    return {
      config,
      accountId: owner.accountId,
      client: owner.client,
      ownerSecret,
      ownerKey: publicKeyHex(ownerSecret),
      guardianAccountId: guardian.accountId,
      guardianClient: guardian.client,
      guardianSecret,
      guardianKey: publicKeyHex(guardianSecret),
      ownerNearKey: ownerKey,
      watcher: await generateEnvelopeKeypair(),
      rpc,
      regtest: new RegtestControl(rpc),
    };
  })();
  return current;
}

/** A funded sub-account `<prefix>.<owner>` with a fresh key, and a contract client signed by it. */
export async function createJudgeSubAccount(
  session: JudgeSession,
  prefix: string,
  nearToTransfer: bigint,
): Promise<{ accountId: string; client: NearContractClient }> {
  const { config } = session;
  const key = KeyPair.fromRandom("ed25519");
  const accountId = `${prefix}.${session.accountId}`;
  const provider = new JsonRpcProvider({ url: config.nearRpcUrl });
  await new Account(
    session.accountId,
    provider,
    new KeyPairSigner(session.ownerNearKey),
  ).createSubAccount({ accountOrPrefix: accountId, publicKey: key.getPublicKey(), nearToTransfer });
  const client = new NearContractClient({
    contractId: config.vaultContract,
    rpcUrl: config.nearRpcUrl,
    signer: { accountId, secretKey: key.toString() },
  });
  return { accountId, client };
}

/** A fresh compressed secp256k1 public key, for a Guardian whose Bitcoin key nobody needs. */
export function freshGuardianKey(): string {
  return publicKeyHex(secp256k1.utils.randomSecretKey());
}

/** The session's Guardian, a `backup_device`. */
export function judgeGuardian(session: JudgeSession): Guardian {
  return {
    guardian_key: session.guardianKey,
    guardian_account: session.guardianAccountId,
    kind: "backup_device",
  };
}

/**
 * Judge Mode Policy: regtest with the 1-minute lower bounds, so Scenarios finish in minutes. Its
 * only Guardian is the session's, unless a Scenario passes its own list; `overrides` replace
 * single fields (S-7's Fast Approval timing).
 */
export function judgePolicy(
  session: JudgeSession,
  recoveryAddress: string,
  guardians: Guardian[] = [judgeGuardian(session)],
  overrides: Partial<Policy> = {},
): Policy {
  return {
    ...presetPolicy("standard", {
      plannedDepositSats: 10_000_000n,
      guardians,
      recoveryAddress,
      network: "regtest",
      watcherX25519Pk: session.watcher.publicKeyHex,
    }),
    delay_ns: MINUTE_NS.toString(),
    policy_change_delay_ns: MINUTE_NS.toString(),
    fast_approval_floor_ns: MINUTE_NS.toString(),
    escape_timelock_blocks: 6,
    ...overrides,
  };
}

/** Creates an active Judge Mode Vault for the session's account. */
export async function createJudgeVault(
  session: JudgeSession,
  { guardians, overrides }: { guardians?: Guardian[]; overrides?: Partial<Policy> } = {},
): Promise<{ vaultId: string; tx: string }> {
  const recovery = await session.regtest.newAddress();
  const vaultId = await session.client.createVault({
    owner_key: session.ownerKey,
    policy: judgePolicy(session, recovery, guardians, overrides),
    deposit_yocto: MIN_VAULT_STORAGE_YOCTO.toString(),
  });
  return { vaultId, tx: session.client.lastTransactionHash ?? "" };
}
