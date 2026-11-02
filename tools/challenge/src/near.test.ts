import type { ContractClient } from "@morrow/core-ts";
import { PublicKey } from "near-api-js";
import { AccessKeyDoesNotExistError } from "near-api-js/rpc-errors";
import { describe, expect, it } from "vitest";
import {
  OWNER_BALANCE_TOP_UP_YOCTO,
  STORAGE_TOP_UP_YOCTO,
  keyState,
  nearRound,
  type RoundAccount,
} from "./near.js";
import { CONTRACT, PARENT } from "./test-helpers.js";

const PUBLIC = "ed25519:DcA2MzgpJbrUATQLLceocVckhhAqrkingax4oJ9kZ847";

describe("nearRound (round loop)", () => {
  it("reads key allowance, deletes keys as the Owner Account and tops up storage as the parent", async () => {
    const calls: unknown[] = [];
    let missing = false;
    const account = (accountId: string, secretKey: string): RoundAccount => ({
      createSubAccount: async () => undefined,
      addFunctionCallAccessKey: async () => undefined,
      getAccessKey: async (publicKey) => {
        calls.push({ getAccessKey: publicKey, as: accountId });
        if (missing) {
          throw new AccessKeyDoesNotExistError(PublicKey.fromString(publicKey), "B", 1);
        }
        return {
          permission: {
            FunctionCall: { allowance: "50000000000000000000000", receiver_id: CONTRACT },
          },
        };
      },
      deleteKey: async (publicKey) =>
        calls.push({ deleteKey: publicKey, as: accountId, secretKey }),
      getState: async () => ({ balance: { available: accountId === PARENT ? 9n : 3n } }),
      transfer: async (args) => calls.push({ transfer: args, as: accountId, secretKey }),
    });
    const contract = (signer?: { accountId: string; secretKey: string }) =>
      ({
        topUpStorage: async (vaultId: string, deposit: string) =>
          calls.push({
            topUpStorage: vaultId,
            deposit,
            as: signer?.accountId,
            key: signer?.secretKey,
          }),
        getVault: async (vaultId: string) => ({ vault_id: vaultId }),
      }) as unknown as ContractClient;
    const near = nearRound({
      rpcUrl: "http://127.0.0.1:1",
      vaultContract: CONTRACT,
      ownerParent: PARENT,
      parentKey: "ed25519:parent",
      account,
      contract,
    });

    expect(await near.accessKey(`r1.${PARENT}`, "ed25519:owner", PUBLIC)).toEqual({
      exists: true,
      allowanceYocto: 50_000_000_000_000_000_000_000n,
    });
    missing = true;
    expect(await near.accessKey(`r1.${PARENT}`, "ed25519:owner", PUBLIC)).toEqual({
      exists: false,
    });
    await near.deleteKey(`r1.${PARENT}`, "ed25519:owner", PUBLIC);
    await near.topUpStorage("4", STORAGE_TOP_UP_YOCTO);
    expect(await near.getVault("4")).toEqual({ vault_id: "4" });
    expect(await near.availableBalance(`r1.${PARENT}`)).toBe(3n);
    await near.transferFromParent(`r1.${PARENT}`, OWNER_BALANCE_TOP_UP_YOCTO);
    expect(calls.at(-1)).toEqual({
      transfer: { receiverId: `r1.${PARENT}`, amount: 10n ** 24n },
      as: PARENT,
      secretKey: "ed25519:parent",
    });
    expect(calls.slice(2, 4)).toEqual([
      { deleteKey: PUBLIC, as: `r1.${PARENT}`, secretKey: "ed25519:owner" },
      {
        topUpStorage: "4",
        deposit: "500000000000000000000000",
        as: PARENT,
        key: "ed25519:parent",
      },
    ]);
  });

  it("reads unlimited and full-access permissions as no allowance", () => {
    expect(keyState("FullAccess")).toEqual({ exists: true, allowanceYocto: null });
    expect(keyState({ FunctionCall: { allowance: null } })).toEqual({
      exists: true,
      allowanceYocto: null,
    });
  });
});
