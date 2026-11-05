import { describe, expect, it } from "vitest";
import { MorrowContractError } from "./errors.js";
import { DAY_NS, HOUR_NS, MINUTE_NS } from "./policy.js";
import {
  BACKUP,
  DESTINATION,
  EMMA,
  ENVELOPE,
  OWNER,
  OWNER_KEY,
  STRANGER,
  setup,
  signetPolicy,
  utxo,
} from "./test-fixtures.js";
import { MockContractClient, MIN_VAULT_STORAGE_YOCTO } from "./mock.js";

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof MorrowContractError && error.code === code,
  );
}

function withdrawal(vaultId: string, n = 1, amount = "500000") {
  return {
    vault_id: vaultId,
    amount_sats: amount,
    destination: DESTINATION,
    fee_rate_sat_vb: 2,
    utxos: [utxo(n)],
    envelope: ENVELOPE,
  };
}

describe("MockContractClient: I/O matrix", () => {
  it("creates an active Vault from a preset and emits creation events", async () => {
    const { mock, vaultId } = await setup();
    const vault = await mock.getVault(vaultId);
    expect(vault.state).toBe("active");
    expect(vault.owner_account).toBe(OWNER);
    expect(vault.addresses?.vault).toMatch(/^tb1q/);
    const kinds = (await mock.eventsSince("0", 100)).map((e) => e.kind);
    expect(kinds).toEqual(["vault_created", "vault_activated"]);
  });

  it("rejects a Delay below the bounds with ERR_POLICY_BOUNDS", async () => {
    await expectCode(setup({ delay_ns: (30n * MINUTE_NS).toString() }), "ERR_POLICY_BOUNDS");
  });

  it("rejects an early execute with ERR_NOT_EXECUTABLE", async () => {
    const { mock, vaultId } = await setup();
    const opId = await mock.requestWithdrawal(withdrawal(vaultId));
    await expectCode(mock.beginExecute(opId, ENVELOPE), "ERR_NOT_EXECUTABLE");
  });

  it("rejects an envelope that is not 160 hex chars with ERR_BAD_ENVELOPE", async () => {
    const { mock, vaultId } = await setup();
    await expectCode(
      mock.requestWithdrawal({ ...withdrawal(vaultId), envelope: "a".repeat(159) }),
      "ERR_BAD_ENVELOPE",
    );
  });

  it("refuses a withdrawal below dust and stores nothing, as the contract does", async () => {
    const { mock, vaultId } = await setup();
    for (const amount of ["6", "545"]) {
      await expectCode(
        mock.requestWithdrawal({ ...withdrawal(vaultId, 1, amount), fee_rate_sat_vb: 0 }),
        "ERR_INSUFFICIENT_FUNDS",
      );
    }
    // Nothing was stored: the coin is free and the next op takes id 1.
    expect(await mock.requestWithdrawal(withdrawal(vaultId, 1, "546"))).toBe("1");
  });

  it("rejects a second request on the same outpoint with ERR_OUTPOINT_RESERVED", async () => {
    const { mock, vaultId } = await setup();
    await mock.requestWithdrawal(withdrawal(vaultId, 1));
    await expectCode(mock.requestWithdrawal(withdrawal(vaultId, 1)), "ERR_OUTPOINT_RESERVED");
  });

  it("clawback voids live ops, closes the Vault and rejects later Owner calls", async () => {
    const { mock, vaultId } = await setup();
    const opId = await mock.requestWithdrawal(withdrawal(vaultId, 1));
    const clawbackId = await mock.asCaller(BACKUP).beginClawback({
      vault_id: vaultId,
      utxos: [utxo(1), utxo(2)],
      fee_rate_sat_vb: 5,
    });
    expect((await mock.getOp(opId)).state).toBe("voided");
    const clawback = await mock.getOp(clawbackId);
    expect(clawback.destination).toBe((await mock.getVault(vaultId)).policy.recovery_address);
    expect(clawback.state).toBe("frozen");
    expect((await mock.getVault(vaultId)).state).toBe("clawed_back");
    mock.asCaller(OWNER).advance(DAY_NS);
    await expectCode(mock.beginExecute(opId, ENVELOPE), "ERR_CLAWED_BACK");
    await expectCode(mock.requestWithdrawal(withdrawal(vaultId, 3)), "ERR_CLAWED_BACK");
  });

  it("rejects a Script-bound change with ERR_SCRIPT_BOUND", async () => {
    const { mock, vaultId } = await setup();
    await expectCode(
      mock.proposePolicyChange({
        vault_id: vaultId,
        changes: { guardians: [] },
        envelope: ENVELOPE,
      }),
      "ERR_SCRIPT_BOUND",
    );
  });

  it("rejects a second pending change with ERR_CHANGE_PENDING", async () => {
    const { mock, vaultId } = await setup();
    const change = { vault_id: vaultId, changes: { fee_cap_sats: "50000" }, envelope: ENVELOPE };
    await mock.proposePolicyChange(change);
    await expectCode(mock.proposePolicyChange(change), "ERR_CHANGE_PENDING");
  });

  it("rejects any Allowance spend when the limit is 0 with ERR_ALLOWANCE_LIMIT", async () => {
    const { mock, vaultId } = await setup({ allowance_limit_sats: "0" });
    await expectCode(
      mock.spendAllowance({ ...withdrawal(vaultId), amount_sats: "546" }),
      "ERR_ALLOWANCE_LIMIT",
    );
  });

  it("rejects a fast approval from a Backup Device with ERR_NOT_TRUSTED_CONTACT", async () => {
    const { mock, vaultId } = await setup({ fast_approval: true });
    const opId = await mock.requestWithdrawal(withdrawal(vaultId));
    await expectCode(mock.asCaller(BACKUP).fastApprove(opId), "ERR_NOT_TRUSTED_CONTACT");
  });

  it("pages events_since by seq", async () => {
    const { mock, vaultId } = await setup();
    await mock.requestWithdrawal(withdrawal(vaultId));
    const first = await mock.eventsSince("0", 2);
    expect(first.map((e) => e.seq)).toEqual(["1", "2"]);
    const next = await mock.eventsSince(first.at(-1)?.seq ?? "0", 2);
    expect(next.map((e) => e.kind)).toEqual(["withdrawal_requested"]);
  });
});

describe("MockContractClient: lifecycles", () => {
  it("request → Delay → execute → sign every input ends Signed with ordered events", async () => {
    const { mock, vaultId } = await setup();
    const opId = await mock.requestWithdrawal({
      ...withdrawal(vaultId),
      utxos: [utxo(1), utxo(2)],
    });
    mock.advance(24n * HOUR_NS);
    const frozen = await mock.beginExecute(opId, ENVELOPE);
    expect(frozen.state).toBe("frozen");
    expect(frozen.sighashes).toHaveLength(2);
    expect(frozen.witness_template?.path).toBe("withdrawal");
    await mock.signInput(opId, 0);
    const again = await mock.signInput(opId, 0);
    expect(again).toBe("mock-signature-1-0");
    await mock.signInput(opId, 1);
    expect((await mock.getOp(opId)).state).toBe("signed");
    const events = await mock.eventsSince("2", 100);
    expect(events.map((e) => e.kind)).toEqual([
      "withdrawal_requested",
      "op_frozen",
      "input_signed",
      "input_signed",
      "op_signed",
    ]);
    expect(events.map((e) => Number(e.seq))).toEqual([3, 4, 5, 6, 7]);
  });

  it("begin_execute is idempotent once frozen", async () => {
    const { mock, vaultId } = await setup();
    const opId = await mock.requestWithdrawal(withdrawal(vaultId));
    mock.advance(DAY_NS);
    const first = await mock.beginExecute(opId, ENVELOPE);
    const second = await mock.beginExecute(opId, ENVELOPE);
    expect(second.unsigned_tx_hex).toBe(first.unsigned_tx_hex);
  });

  it("Owner and Guardians can cancel; strangers cannot", async () => {
    const { mock, vaultId } = await setup();
    const a = await mock.requestWithdrawal(withdrawal(vaultId, 1));
    const b = await mock.requestWithdrawal(withdrawal(vaultId, 2));
    await expectCode(mock.asCaller(STRANGER).cancel(a), "ERR_UNAUTHORIZED");
    await expectCode(mock.asCaller(OWNER).cancel(a), "ERR_BAD_ENVELOPE");
    await mock.cancel(a, ENVELOPE);
    await mock.asCaller(EMMA).cancel(b);
    expect((await mock.getOp(a)).state).toBe("cancelled");
    expect((await mock.getOp(b)).state).toBe("cancelled");
    // Cancelled ops release their outpoints.
    await mock.asCaller(OWNER).requestWithdrawal(withdrawal(vaultId, 1));
  });

  it("a Policy Change applies only after its delay and updates the Policy", async () => {
    const { mock, vaultId } = await setup();
    const changeId = await mock.proposePolicyChange({
      vault_id: vaultId,
      changes: { delay_ns: (48n * HOUR_NS).toString() },
      envelope: ENVELOPE,
    });
    await expectCode(mock.applyPolicyChange(changeId), "ERR_CHANGE_NOT_EFFECTIVE");
    mock.advance(7n * DAY_NS);
    await mock.asCaller(STRANGER).applyPolicyChange(changeId);
    const vault = await mock.getVault(vaultId);
    expect(vault.policy.delay_ns).toBe((48n * HOUR_NS).toString());
    expect(vault.pending_change).toBeNull();
  });

  it("a Guardian vetoes and the Owner withdraws a pending change", async () => {
    const { mock, vaultId } = await setup();
    const change = { vault_id: vaultId, changes: { fee_cap_sats: "50000" }, envelope: ENVELOPE };
    const vetoed = await mock.proposePolicyChange(change);
    await mock.asCaller(EMMA).vetoPolicyChange(vetoed);
    const withdrawn = await mock.asCaller(OWNER).proposePolicyChange(change);
    await mock.vetoPolicyChange(withdrawn, ENVELOPE);
    const kinds = (await mock.eventsSince("0", 100)).map((e) => e.kind);
    expect(kinds).toContain("policy_change_vetoed");
    expect(kinds).toContain("policy_change_withdrawn");
    expect(await mock.getPolicyChange(vetoed)).toMatchObject({ state: "vetoed", vetoed_by: EMMA });
    expect(await mock.getPolicyChange(withdrawn)).toMatchObject({
      state: "withdrawn",
      vetoed_by: null,
    });
    const last = (await mock.eventsSince("0", 100)).at(-1);
    expect(last).toMatchObject({
      kind: "policy_change_withdrawn",
      data: { change_id: withdrawn, envelope: ENVELOPE },
    });
    await expectCode(mock.getPolicyChange("99"), "ERR_CHANGE_NOT_FOUND");
  });

  it("an Owner who is also a Guardian withdraws, and needs an envelope", async () => {
    const guardians = [
      {
        guardian_key: `02${"22".repeat(32)}`,
        guardian_account: OWNER,
        kind: "backup_device" as const,
      },
      {
        guardian_key: `02${"33".repeat(32)}`,
        guardian_account: EMMA,
        kind: "trusted_contact" as const,
      },
    ];
    const { mock, vaultId } = await setup({ guardians });
    const change = { vault_id: vaultId, changes: { fee_cap_sats: "50000" }, envelope: ENVELOPE };
    const changeId = await mock.proposePolicyChange(change);
    await expectCode(mock.vetoPolicyChange(changeId), "ERR_BAD_ENVELOPE");
    await mock.vetoPolicyChange(changeId, ENVELOPE);
    expect((await mock.getPolicyChange(changeId)).state).toBe("withdrawn");
  });

  it("a Clawback vetoes a pending change as the clawing Guardian", async () => {
    const { mock, vaultId } = await setup();
    const changeId = await mock.proposePolicyChange({
      vault_id: vaultId,
      changes: { fee_cap_sats: "50000" },
      envelope: ENVELOPE,
    });
    await mock.asCaller(BACKUP).beginClawback({
      vault_id: vaultId,
      utxos: [utxo(1)],
      fee_rate_sat_vb: 2,
    });
    expect((await mock.getVault(vaultId)).pending_change).toBeNull();
    expect(await mock.getPolicyChange(changeId)).toMatchObject({
      state: "vetoed",
      vetoed_by: BACKUP,
    });
    const events = await mock.eventsSince("0", 100);
    expect(events.map((e) => e.kind).slice(-3)).toEqual([
      "policy_change_vetoed",
      "vault_clawed_back",
      "op_frozen",
    ]);
    expect(events.find((e) => e.kind === "policy_change_vetoed")?.data).toEqual({
      change_id: changeId,
      by: BACKUP,
    });
  });

  it("a Trusted Contact fast approval lowers executable_at to now + floor", async () => {
    const { mock, vaultId } = await setup({ fast_approval: true });
    const opId = await mock.requestWithdrawal(withdrawal(vaultId));
    await mock.asCaller(EMMA).fastApprove(opId);
    const op = await mock.getOp(opId);
    expect(op.executable_at).toBe((mock.now() + 10n * MINUTE_NS).toString());
    mock.advance(10n * MINUTE_NS).asCaller(OWNER);
    expect((await mock.beginExecute(opId, ENVELOPE)).state).toBe("frozen");
  });

  it("Allowance spends within the rolling 24 h limit and rejects beyond it", async () => {
    const { mock, vaultId } = await setup({ allowance_limit_sats: "100000" });
    const spend = (n: number, amount: string) => ({
      ...withdrawal(vaultId, n),
      amount_sats: amount,
    });
    expect((await mock.spendAllowance(spend(1, "60000"))).state).toBe("frozen");
    await expectCode(mock.spendAllowance(spend(2, "50000")), "ERR_ALLOWANCE_LIMIT");
    mock.advance(DAY_NS + 1n);
    expect((await mock.spendAllowance(spend(3, "50000"))).state).toBe("frozen");
  });

  it("Refresh pays only the Vault Address", async () => {
    const { mock, vaultId } = await setup();
    const op = await mock.refresh({
      vault_id: vaultId,
      fee_rate_sat_vb: 1,
      utxos: [utxo(1)],
      envelope: ENVELOPE,
    });
    expect(op.destination).toBe((await mock.getVault(vaultId)).addresses?.vault);
    expect(op.state).toBe("frozen");
    expect(op.executable_at).toBeNull();
    const frozen = (await mock.eventsSince("0", 100)).pop();
    expect(frozen?.kind).toBe("op_frozen");
    if (frozen?.kind !== "op_frozen") throw new Error("expected op_frozen");
    expect(frozen.data.kind).toBe("refresh");
    expect(frozen.data.envelope).toBe(ENVELOPE);
    expect(BigInt(op.amount_sats) + BigInt(frozen.data.fee_sats)).toBe(1_000_000n);
  });

  it("refuses a dust Refresh with ERR_INSUFFICIENT_FUNDS, as the contract does", async () => {
    const { mock, vaultId } = await setup();
    await expectCode(
      mock.refresh({
        vault_id: vaultId,
        fee_rate_sat_vb: 0,
        utxos: [utxo(1, 500)],
        envelope: ENVELOPE,
      }),
      "ERR_INSUFFICIENT_FUNDS",
    );
  });

  it("a refused Refresh leaves no op and no reservation behind", async () => {
    const { mock, vaultId } = await setup();
    const args = { vault_id: vaultId, utxos: [utxo(1)], envelope: ENVELOPE };
    await expectCode(mock.refresh({ ...args, fee_rate_sat_vb: 1000 }), "ERR_FEE_TOO_HIGH");
    await expectCode(mock.getOp("1"), "ERR_OP_NOT_FOUND");
    const op = await mock.refresh({ ...args, fee_rate_sat_vb: 1 });
    expect(op.op_id).toBe("1");
  });

  it("allows one Refresh per Delay, from the newest one's creation, whatever became of it", async () => {
    const { mock, vaultId } = await setup();
    const refresh = (n: number) =>
      mock.refresh({ vault_id: vaultId, fee_rate_sat_vb: 1, utxos: [utxo(n)], envelope: ENVELOPE });
    const delay = BigInt((await mock.getVault(vaultId)).policy.delay_ns);
    const first = await refresh(1);
    await mock.cancel(first.op_id, ENVELOPE);
    await expectCode(refresh(2), "ERR_REFRESH_TOO_SOON");
    mock.advance(delay - 1n);
    await expectCode(refresh(2), "ERR_REFRESH_TOO_SOON");
    mock.advance(1n);
    const second = await refresh(2);
    await mock.signInput(second.op_id, 0);
    expect((await mock.getOp(second.op_id)).state).toBe("signed");
    mock.advance(delay - 1n);
    await expectCode(refresh(3), "ERR_REFRESH_TOO_SOON");
    mock.advance(1n);
    expect((await refresh(3)).state).toBe("frozen");
  });

  it("an Allowance Refresh pays the Allowance Address, with its own rate limit", async () => {
    const { mock, vaultId } = await setup();
    const refresh = (n: number, source?: "vault" | "allowance") =>
      mock.refresh({
        vault_id: vaultId,
        fee_rate_sat_vb: 1,
        utxos: [utxo(n)],
        envelope: ENVELOPE,
        ...(source ? { source } : {}),
      });
    const vault = await mock.getVault(vaultId);
    const allowance = await refresh(1, "allowance");
    expect(allowance.source).toBe("allowance");
    expect(allowance.destination).toBe(vault.addresses?.allowance);
    const fromVault = await refresh(2);
    expect(fromVault.source).toBe("vault");
    expect(fromVault.destination).toBe(vault.addresses?.vault);
    await expectCode(refresh(3, "allowance"), "ERR_REFRESH_TOO_SOON");
    await expectCode(refresh(3, "vault"), "ERR_REFRESH_TOO_SOON");
    await mock.cancel(allowance.op_id, ENVELOPE);
    expect((await mock.getOp(allowance.op_id)).state).toBe("cancelled");
    await expectCode(refresh(3, "allowance"), "ERR_REFRESH_TOO_SOON");
    mock.advance(BigInt(vault.policy.delay_ns));
    expect((await refresh(1, "allowance")).state).toBe("frozen");
  });

  it("the Owner cancels a Frozen Refresh until every input is signed", async () => {
    const { mock, vaultId } = await setup();
    const args = { vault_id: vaultId, fee_rate_sat_vb: 1, envelope: ENVELOPE };
    const op = await mock.refresh({ ...args, utxos: [utxo(1), utxo(2)] });
    await mock.signInput(op.op_id, 0);
    await expectCode(mock.asCaller(EMMA).cancel(op.op_id), "ERR_UNAUTHORIZED");
    await expectCode(mock.asCaller(STRANGER).cancel(op.op_id, ENVELOPE), "ERR_UNAUTHORIZED");
    await expectCode(mock.asCaller(OWNER).cancel(op.op_id), "ERR_BAD_ENVELOPE");
    await mock.cancel(op.op_id, ENVELOPE);
    expect((await mock.getOp(op.op_id)).state).toBe("cancelled");
    const event = (await mock.eventsSince("0", 100)).pop();
    expect(event?.kind).toBe("refresh_cancelled");
    expect(event?.data).toEqual({ op_id: op.op_id, by: OWNER });
    // Its coins are free again.
    await mock.requestWithdrawal({ ...withdrawal(vaultId), utxos: [utxo(1), utxo(2)] });

    const later = await setup();
    const signed = await later.mock.refresh({
      ...args,
      vault_id: later.vaultId,
      utxos: [utxo(1)],
    });
    await later.mock.signInput(signed.op_id, 0);
    await expectCode(later.mock.cancel(signed.op_id, ENVELOPE), "ERR_BAD_OP_STATE");
  });

  it("enforces the creator allowlist", async () => {
    const mock = new MockContractClient({
      allowedNetworks: ["signet"],
      creatorAllowlist: ["operator.near"],
    });
    await expectCode(
      mock.asCaller(OWNER).createVault({
        owner_key: OWNER_KEY,
        policy: signetPolicy(),
        deposit_yocto: MIN_VAULT_STORAGE_YOCTO.toString(),
      }),
      "ERR_CREATOR_NOT_ALLOWED",
    );
  });

  it("rejects a fee above the cap with ERR_FEE_TOO_HIGH", async () => {
    const { mock, vaultId } = await setup();
    const opId = await mock.requestWithdrawal({ ...withdrawal(vaultId), fee_rate_sat_vb: 1000 });
    mock.advance(DAY_NS);
    await expectCode(mock.beginExecute(opId, ENVELOPE), "ERR_FEE_TOO_HIGH");
  });
});

describe("MockContractClient: Spending Allowance check order and window rules", () => {
  const spend = (vaultId: string, n: number, amount: string, value = 100_000) => ({
    vault_id: vaultId,
    amount_sats: amount,
    destination: DESTINATION,
    fee_rate_sat_vb: 2,
    utxos: [utxo(n, value)],
    envelope: ENVELOPE,
  });

  it("freezes an allowance op from the Allowance Address and emits allowance_spent", async () => {
    const { mock, vaultId } = await setup({ allowance_limit_sats: "100000" });
    const op = await mock.spendAllowance(spend(vaultId, 1, "60000"));
    expect(op).toMatchObject({
      kind: "allowance",
      source: "allowance",
      state: "frozen",
      amount_sats: "60000",
      destination: DESTINATION,
      executable_at: null,
    });
    const events = (await mock.eventsSince("2", 100)).map((e) => [e.kind, e.data]);
    expect(events).toEqual([
      [
        "op_frozen",
        { op_id: op.op_id, kind: "allowance", envelope: ENVELOPE, fee_sats: expect.any(String) },
      ],
      [
        "allowance_spent",
        { op_id: op.op_id, amount_sats: "60000", destination: DESTINATION, window_sats: "60000" },
      ],
    ]);
    await mock.signInput(op.op_id, 0);
    expect((await mock.getOp(op.op_id)).state).toBe("signed");
  });

  it("only the Owner signs an allowance op", async () => {
    const { mock, vaultId } = await setup();
    const op = await mock.spendAllowance(spend(vaultId, 1, "60000"));
    await expectCode(mock.asCaller(EMMA).signInput(op.op_id, 0), "ERR_UNAUTHORIZED");
  });

  it("a refused spend leaves no op, no op id and no reservation", async () => {
    const { mock, vaultId } = await setup();
    const events = (await mock.eventsSince("0", 100)).length;
    await expectCode(
      mock.spendAllowance({ ...spend(vaultId, 1, "60000"), fee_rate_sat_vb: 100 }),
      "ERR_FEE_TOO_HIGH",
    );
    await expectCode(mock.getOp("1"), "ERR_OP_NOT_FOUND");
    expect((await mock.eventsSince("0", 100)).length).toBe(events);
    // The same coin is free, and the next op takes the id the refused one did not spend.
    expect(await mock.requestWithdrawal(withdrawal(vaultId, 1, "50000"))).toBe("1");
    // Nothing counts toward the window either.
    expect((await mock.spendAllowance(spend(vaultId, 2, "100000", 200_000))).state).toBe("frozen");
  });

  it("the window counts frozen and signed spends created after now - 24 h", async () => {
    const { mock, vaultId } = await setup({ allowance_limit_sats: "100000" });
    const first = await mock.spendAllowance(spend(vaultId, 1, "60000"));
    await mock.signInput(first.op_id, 0);
    mock.advance(DAY_NS - 1n);
    await expectCode(mock.spendAllowance(spend(vaultId, 2, "50000")), "ERR_ALLOWANCE_LIMIT");
    expect((await mock.spendAllowance(spend(vaultId, 2, "40000"))).state).toBe("frozen");
    mock.advance(1n);
    // The first spend has left the window; the 40,000 one has not.
    await expectCode(mock.spendAllowance(spend(vaultId, 3, "60001")), "ERR_ALLOWANCE_LIMIT");
    await mock.spendAllowance(spend(vaultId, 3, "60000"));
    const last = (await mock.eventsSince("0", 100)).at(-1);
    expect(last?.kind === "allowance_spent" && last.data.window_sats).toBe("100000");
  });

  it("a limit of 0 refuses every spend before looking at the coins", async () => {
    const malformed = { ...utxo(1), txid: "not-a-txid" };
    const coinSets = [
      [utxo(1)],
      [],
      [1, 2, 3, 4, 5, 6].map((n) => utxo(n)),
      [utxo(1), utxo(1)],
      [malformed],
    ];
    for (const utxos of coinSets) {
      for (const amount of ["546", "60000", "18446744073709551615"]) {
        const { mock, vaultId } = await setup({ allowance_limit_sats: "0" });
        await expectCode(
          mock.spendAllowance({ ...spend(vaultId, 1, amount), utxos }),
          "ERR_ALLOWANCE_LIMIT",
        );
      }
    }
    // Coins a live withdrawal holds are not even checked.
    const { mock, vaultId } = await setup({ allowance_limit_sats: "0" });
    await mock.requestWithdrawal(withdrawal(vaultId, 1, "100000"));
    await expectCode(
      mock.spendAllowance({ ...spend(vaultId, 1, "546"), utxos: [utxo(1)] }),
      "ERR_ALLOWANCE_LIMIT",
    );
  });

  it("on a limit of 0 the earlier checks still come first", async () => {
    const zero = () => setup({ allowance_limit_sats: "0" });
    const bad = { destination: "bc1qnotsignet", amount_sats: "0" };
    {
      const { mock, vaultId } = await zero();
      await expectCode(
        mock.spendAllowance({ ...spend(vaultId, 1, "0"), ...bad }),
        "ERR_BAD_ADDRESS",
      );
      await expectCode(mock.spendAllowance(spend(vaultId, 1, "0")), "ERR_INSUFFICIENT_FUNDS");
      await expectCode(mock.spendAllowance(spend(vaultId, 1, "545")), "ERR_INSUFFICIENT_FUNDS");
      await expectCode(
        mock.asCaller(STRANGER).spendAllowance({ ...spend(vaultId, 1, "0"), ...bad }),
        "ERR_UNAUTHORIZED",
      );
      await expectCode(
        mock
          .asCaller(OWNER)
          .spendAllowance({ ...spend(vaultId, 1, "0"), ...bad, envelope: "a".repeat(159) }),
        "ERR_BAD_ENVELOPE",
      );
    }
    const { mock, vaultId } = await zero();
    await mock
      .asCaller(EMMA)
      .beginClawback({ vault_id: vaultId, utxos: [utxo(9)], fee_rate_sat_vb: 2 });
    await expectCode(
      mock
        .asCaller(OWNER)
        .spendAllowance({ ...spend(vaultId, 1, "0"), ...bad, envelope: "a".repeat(159) }),
      "ERR_CLAWED_BACK",
    );
  });

  it("refuses an amount below dust", async () => {
    const { mock, vaultId } = await setup();
    await expectCode(mock.spendAllowance(spend(vaultId, 1, "545")), "ERR_INSUFFICIENT_FUNDS");
  });

  for (const signed of [0, 1]) {
    it(`the Owner cancels a frozen spend with ${signed} of 2 inputs signed`, async () => {
      const { mock, vaultId } = await setup({ allowance_limit_sats: "100000" });
      const coins = [utxo(1, 50_000), utxo(2, 30_000)];
      const op = await mock.spendAllowance({ ...spend(vaultId, 1, "60000"), utxos: coins });
      for (let i = 0; i < signed; i++) await mock.signInput(op.op_id, i);
      await mock.cancel(op.op_id, ENVELOPE);
      expect((await mock.getOp(op.op_id)).state).toBe("cancelled");
      const last = (await mock.eventsSince("0", 100)).at(-1);
      expect(last).toMatchObject({
        kind: "allowance_cancelled",
        data: { op_id: op.op_id, by: OWNER },
      });
      // The window is free again, and so are the coins.
      expect((await mock.spendAllowance(spend(vaultId, 3, "100000", 200_000))).state).toBe(
        "frozen",
      );
      const withdrawalId = await mock.requestWithdrawal({
        ...withdrawal(vaultId, 1, "70000"),
        utxos: coins,
      });
      expect((await mock.getOp(withdrawalId)).state).toBe("pending");
    });
  }

  it("only the Owner with an envelope cancels a spend, and never a signed one", async () => {
    const { mock, vaultId } = await setup();
    const op = await mock.spendAllowance(spend(vaultId, 1, "60000"));
    await expectCode(mock.asCaller(EMMA).cancel(op.op_id), "ERR_UNAUTHORIZED");
    await expectCode(mock.asCaller(STRANGER).cancel(op.op_id), "ERR_UNAUTHORIZED");
    await expectCode(mock.asCaller(OWNER).cancel(op.op_id), "ERR_BAD_ENVELOPE");
    await mock.signInput(op.op_id, 0);
    await expectCode(mock.cancel(op.op_id, ENVELOPE), "ERR_BAD_OP_STATE");
  });

  it("a Clawback voids a frozen allowance op", async () => {
    const { mock, vaultId } = await setup();
    const op = await mock.spendAllowance(spend(vaultId, 1, "60000"));
    await mock.asCaller(EMMA).beginClawback({
      vault_id: vaultId,
      utxos: [utxo(1, 100_000)],
      fee_rate_sat_vb: 2,
      source: "allowance",
    });
    expect((await mock.getOp(op.op_id)).state).toBe("voided");
  });
});
