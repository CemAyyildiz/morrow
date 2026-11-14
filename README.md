# Morrow

**Bitcoin that can't be rushed.**

Morrow is a time-lock vault for Bitcoin that works today, with no soft fork, no bridge and no wrapped BTC. A public NEAR contract co-signs your Bitcoin through NEAR Chain Signatures, but only after a Delay you chose, and during that Delay any Guardian can send a theft back to your own cold Recovery Address. If NEAR ever disappears, you still leave on your own after a Bitcoin timelock.

**The problem.** On Bitcoin today, whoever holds your keys can move your coins in the next block, and nothing can call them back. A phished seed, a stolen phone or a wrench attack is a final loss. Bitcoin has no native vaults: the soft forks that would add them (`OP_VAULT`, `OP_CTV`) are not active.

**What NEAR does here.** The Vault Contract is a NEAR smart contract with no access keys. It holds the rules, builds every Bitcoin transaction itself, and asks NEAR Chain Signatures (the MPC signer `v1.signer-prod.testnet`, and `v1.signer` on mainnet) to sign it with a Bitcoin key that no person holds. That key is one of the two keys every spend needs, so the contract's rules are the Bitcoin coins' rules.

Live web app: [morrow-web-341572138939.europe-west1.run.app](https://morrow-web-341572138939.europe-west1.run.app). It reads the locked testnet contract `morrow-vault-v1.testnet` and Bitcoin signet; nothing on it holds real bitcoin. Connect a NEAR testnet wallet at [`/vault/new`](https://morrow-web-341572138939.europe-west1.run.app/vault/new) to create and operate a Vault of your own: see [Use it yourself](#use-it-yourself).

## Verify it

Each check reads public data or runs this repository.

| Check                                        | Needs                                                                      | Time             |
| -------------------------------------------- | -------------------------------------------------------------------------- | ---------------- |
| 1. The contract is locked (`curl`)           | nothing installed                                                          | 1 minute         |
| 1. Its code is this repository (`make wasm`) | Docker, Node 24.22, pnpm                                                   | about 5 minutes  |
| 2. Every Scenario passes (`make demo`)       | Docker, Node 24.22, pnpm                                                   | about 15 minutes |
| 3. The CI log                                | a browser, or [`evidence/`](evidence)                                      | 1 minute         |
| 4. The web app                               | a browser ([hosted](https://morrow-web-341572138939.europe-west1.run.app)) | 2 minutes        |

**1. The Vault Contract is locked.** The testnet deployment `morrow-vault-v1.testnet` and the mainnet deployment `morrow-vault.near` have no access keys, so nobody, the builder included, can replace their code. Check it with nothing installed:

```sh
curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"morrow-vault-v1.testnet"}}'
curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"morrow-vault.near"}}'
```

Each returns `"keys":[]`. The Vault Contract has no method that deploys code, deletes its account or adds an access key (there is no `deploy_contract`, `delete_account`, `add_*_key` or `delete_key` call in `contracts/vault/src`), so with no keys its code and config are fixed. The same call with `"request_type":"view_account"` reads the deployed code:

```sh
curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"morrow-vault-v1.testnet"}}'
curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"morrow-vault.near"}}'
```

Both return `"code_hash":"3JwGeYBT3FQjyNDhcQ86sTjCEcix2KuTJPePzGxRefsZ"`. To check that this hash is the code in this repository, build it in the pinned Docker image and compare (after `pnpm install --frozen-lockfile`). `make wasm` mounts the repository into the container, so clone it where Docker can mount it, such as under your home directory (Docker Desktop and colima do not share `/tmp` by default):

```sh
make wasm
pnpm --filter @morrow/deploy start verify --account morrow-vault-v1.testnet --signer v1.signer-prod.testnet --networks regtest,signet
pnpm --filter @morrow/deploy start verify --account morrow-vault.near --network mainnet --signer v1.signer --networks bitcoin --creators 00785c6304a08920dff8174f8fb72bfbe28c39357d6715f53f20c6a1d6e52737
```

Each ends `Deployment verified: 1 account(s), code_hash 3JwGeYBT3FQjyNDhcQ86sTjCEcix2KuTJPePzGxRefsZ, locked`. More in [Verify the deployment](#verify-the-deployment).

**2. Every Scenario passes.** [`make demo`](#run-the-demo) (about 15 minutes, no funds or keys) runs Scenarios S-1 to S-7 against `morrow-vault-v1.testnet` and the live testnet MPC signer, and all seven end in PASS. The exact expected lines are in the [Scenarios](#scenarios) table, which CI checks against the `make demo` log.

**3. CI ran it too.** In [CI run 43212594055](https://github.com/CemAyyildiz/morrow/actions/runs/43212594055) (2026-11-12, commit `e9c2c26`), the "Regtest integration and Judge Mode" job ran `make demo` against `morrow-vault-v1.testnet`, printed S-1 to S-7 PASS between 11:51 and 11:57 UTC, and then `Judge Mode log has all 17 README lines: OK`. Those 17 lines are every Judge Mode log line this README quotes (the Scenarios table's expected and progress lines and the S-3 excerpt), checked by `.github/scripts/check-readme.mjs`. That run's full log is also in this repository, [`evidence/judge-ci-43212594055.txt`](evidence/judge-ci-43212594055.txt): every NearBlocks link in it opens the real testnet transaction. Check it yourself with `node .github/scripts/check-readme.mjs --log evidence/judge-ci-43212594055.txt`.

**4. Read it in the browser.** The web app reads the same contract live. X-Ray at `/xray/30` shows Withdrawal 30 from an earlier CI run, [42989446444](https://github.com/CemAyyildiz/morrow/actions/runs/42989446444) (log in [`evidence/judge-ci-42989446444.txt`](evidence/judge-ci-42989446444.txt)), with its signature stage reading "Signed by the NEAR MPC network (11 of 16)". Its fourth stage, the Bitcoin transaction, is expected to read "The Bitcoin transaction could not be read", because the transaction confirmed on CI's own regtest node (details in [Read it in the browser](#read-it-in-the-browser)). The Proof Page at `/proof/33` shows that run's Vault 33 with the contract's `code_hash` and "Locked: no full-access keys". `/lost` says what to do after losing a device. Open them on the hosted app: [`/xray/30`](https://morrow-web-341572138939.europe-west1.run.app/xray/30), [`/proof/33`](https://morrow-web-341572138939.europe-west1.run.app/proof/33), [`/lost`](https://morrow-web-341572138939.europe-west1.run.app/lost).

## Run the demo

You need a running Docker daemon, `make`, Node 24.22 and pnpm (`corepack enable`). `pnpm install` refuses any other Node version; with nvm, `nvm install` in the repository picks it up from `.nvmrc`. A run takes about 15 minutes and needs no Bitcoin funds, API keys or accounts: Bitcoin runs on a local regtest node, and the NEAR testnet accounts come from the public faucet.

```sh
nvm install   # or any other way to get Node 24.22, the version in .nvmrc
corepack enable
pnpm install --frozen-lockfile
make demo
```

`make demo` starts Bitcoin Core regtest in Docker, creates fresh NEAR testnet accounts, and runs every Scenario against the Vault Contract on NEAR testnet (`morrow-vault-v1.testnet`) and the live testnet MPC signer (`v1.signer-prod.testnet`). Each Scenario ends with one line: `PASS`, `FAIL`, `SKIP (not built)`, or `SKIP (<reason>)` when the deployment under test cannot run it. Any `FAIL` exits non-zero.

Optional environment variables:

| Variable                                                 | Default                                | Effect                                                                                                                                         |
| -------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `MORROW_SCENARIOS`                                       | every Scenario                         | Comma-separated ids to run, such as `S-3` or `S-1,S-5`. An unknown id exits 1.                                                                 |
| `MORROW_JUDGE_FUNDER_ACCOUNT`, `MORROW_JUDGE_FUNDER_KEY` | unset                                  | A funded testnet account and its secret key (`ed25519:...`). With both set, the run creates its accounts under it instead of using the faucet. |
| `MORROW_VAULT_CONTRACT`                                  | `morrow-vault-v1.testnet`              | The Vault Contract deployment to test.                                                                                                         |
| `MORROW_NEAR_RPC_URL`                                    | `https://rpc.testnet.fastnear.com`     | The NEAR RPC endpoint.                                                                                                                         |
| `MORROW_REGTEST_RPC`                                     | `http://morrow:morrow@127.0.0.1:18443` | The Bitcoin Core regtest RPC that `make demo` starts.                                                                                          |
| `MORROW_RELEASE`                                         | unset                                  | `1` reports a mandatory Scenario that is not built as `FAIL` instead of `SKIP (not built)`.                                                    |

## Read it in the browser

The web app (`apps/web`) is hosted on Google Cloud Run at [morrow-web-341572138939.europe-west1.run.app](https://morrow-web-341572138939.europe-west1.run.app), built from `infra/web/Dockerfile` with the same settings as the local run below: NEAR testnet and Bitcoin signet, read through mempool.space's Esplora API (`MORROW_BTC_NETWORK=signet`, `MORROW_BTC_BACKEND_URL=https://mempool.space/signet/api`). To run it yourself against the locked testnet contract, after `pnpm install --frozen-lockfile`:

```sh
pnpm --filter @morrow/web build
MORROW_NEAR_NETWORK=testnet MORROW_VAULT_CONTRACT=morrow-vault-v1.testnet MORROW_BTC_NETWORK=signet MORROW_BTC_BACKEND_URL=https://mempool.space/signet/api PORT=8080 pnpm --filter @morrow/web start
```

Then open `http://localhost:8080` (or the hosted link). The page reads NEAR testnet through FastNEAR (`rpc.testnet.fastnear.com`, its archival RPC and its transaction API) and Bitcoin signet through mempool.space.

- `/xray/30`: X-Ray of Withdrawal 30 from [CI run 42989446444](https://github.com/CemAyyildiz/morrow/actions/runs/42989446444) (log in [`evidence/`](evidence/judge-ci-42989446444.txt)), in four stages: the Bitcoin script path, the Vault Contract rule, the NEAR MPC signature and the Bitcoin transaction. The first three are done, and the signature stage reads "Signed by the NEAR MPC network (11 of 16)". The fourth reads "The Bitcoin transaction could not be read", because that transaction confirmed on CI's own regtest node, which nothing public serves. It shows the txid; compare it with the CI log line `Bitcoin transaction 684e09dcfb2098048fd3ce1f54aa64e35dfb8a827c2cadc2723289cb83ded70f confirmed; destination received 1,500,000 sats`. `/xray` opens any op id, or the hash of a refused NEAR transaction.
- `/proof/33`: the Proof Page of Vault 33 from the same run: its Policy, Vault Address and Allowance Address read live from the contract, the contract's `code_hash`, and "Locked: no full-access keys".
- `/lost`: what to do when a device that holds your Owner Key or signs for your Owner Account is lost or stolen.

## Use it yourself

Create a Vault on Bitcoin signet with your own keys, fund it with signet test coins, and claw it back. You need a NEAR testnet account in [Meteor Wallet](https://wallet.meteorwallet.app) or [Intear Wallet](https://wallet.intear.tech) with about 1 testnet NEAR (from the [NEAR testnet faucet](https://near-faucet.io)). Signet coins are test coins with no value.

1. Open [`/vault/new`](https://morrow-web-341572138939.europe-west1.run.app/vault/new) and press **Connect a NEAR wallet**. Pick Meteor or Intear and sign in on testnet. You see "Connected as `<your account>`". Your account becomes the Owner Account and the Backup Device Guardian.
2. Choose the Delay: **1 hour** (for testing) or **24 hours**. The rest of the Policy is fixed: Policy Change Delay 7 days, Escape Timelock 4,320 blocks, Fee Cap 100,000 sats, Spending Allowance 10,000 sats per 24 hours, Fast Approval off. A withdrawal or a Clawback spends at most 5 coins; a Clawback of more coins needs another press once the first is on Bitcoin.
3. Paste a signet Recovery Address you control (`tb1…`), or press **Generate a test Recovery Address** (testing only: its key goes into the key file). Re-type its last 6 characters.
4. Press **Download key file**. The Owner Key, the Backup Device Guardian Key and the watcher key were drawn in your browser; this file is their only copy. **Create Vault** stays disabled until it is saved.
5. Press **Create Vault** and approve `create_vault` in the wallet (0.5 NEAR storage deposit, 100 TGas). The page waits until NEAR shows the Vault active and opens `/vault/<id>`, with its Vault Address.
6. Fund the Vault Address from a signet faucet, such as [signet257.bublina.eu.org](https://signet257.bublina.eu.org/). After one confirmation the page shows the balance and the actions open.
7. **Request a withdrawal** to any signet address. You see "Withdrawal Request op #N accepted. It is pending until `<time>`." Note the op id: this browser remembers it for the Vault's page, and on any other you open the request by its op id.
8. **Claw back**. Approve `begin_clawback`, then one `sign_input` per coin, in the wallet. The browser signs with the Backup Device Guardian Key, assembles the transaction and broadcasts it to mempool.space. You see "On Bitcoin signet: `<txid>`" with a link to the transaction, which pays your Recovery Address. The pending request is voided and the Vault is closed. If the wallet or the Bitcoin backend stops it halfway, pressing **Claw back** again carries the same Clawback on (and **Broadcast again** resends a transaction already signed).

Instead of step 8 you can wait out the Delay and press **Execute** on the request: the browser signs with the Owner Key and the withdrawal pays its destination. On a later visit, open `/vault/<id>` and load the key file: the keys stay in the page's memory and are never sent or stored. A key file for another account, Vault or network is refused with the reason, and nothing is sent.

The wallet pages are the only pages that run wallet code. near-connect (`@hot-labs/near-connect`, pinned) loads only there, and each wallet's executor is a pinned copy served from this app's own origin (`apps/web/public/wallets/`, with its source URL and sha256 in `apps/web/src/vault/wallets.ts`, checked by a test). near-connect runs it in a sandboxed iframe under the page's per-response CSP nonce. So no page loads script from a third-party origin; the wallet pages also allow inline styles, data-URI images, the wallets' own connection origins (`*.meteorwallet.app`, `*.intear.tech`) and Intear's framed wallet page. Every other page keeps the strict CSP, and moving between the two kinds of page is a full page load.

## Scenarios

Run one Scenario with its command, or all of them with `make demo`. The expected line and the progress line are exact: CI runs `make demo` and fails if its log lacks any of them (`.github/scripts/check-readme.mjs`).

| Id  | Scenario             | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Command                          | Expected line                   | Progress line also checked                                                                         |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------- |
| S-1 | Create               | A real Vault on NEAR testnet. Its Vault Address and Allowance Address are recomputed from the Vault Kit and match what the contract reports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `MORROW_SCENARIOS=S-1 make demo` | `S-1 Create PASS`               | `Co-signer keys derived by the NEAR MPC network (v1.signer-prod.testnet)`                          |
| S-2 | Withdraw after Delay | Execute before the Delay is refused by the contract. After the Delay the NEAR MPC network co-signs, and the withdrawal confirms on Bitcoin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `MORROW_SCENARIOS=S-2 make demo` | `S-2 Withdraw after Delay PASS` | `Execute before the Delay rejected: ERR_NOT_EXECUTABLE`                                            |
| S-3 | Thief and Clawback   | A thief with the real Owner keys requests a withdrawal. A Guardian claws back to the Recovery Address, the thief's Execute fails, and 0 sats leave.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `MORROW_SCENARIOS=S-3 make demo` | `S-3 Thief and Clawback PASS`   | `Attacker received 0 sats`                                                                         |
| S-4 | Duress               | A coerced Owner's withdrawal fails silently. The Owner makes a control withdrawal with a normal Watcher Envelope, then, coerced, one to an attacker with a duress-flagged envelope; on-chain the two look the same. The real Guardian Watcher, as the Vault's Auto-Clawback Guardian, reads the flag and its Clawback sends every coin to the Recovery Address, co-signed by the NEAR MPC network, before either withdrawal could execute. The coerced Execute fails with `ERR_CLAWED_BACK` and the attacker receives 0 sats, while the duress-mode screens still show the request as Pending.                                                                                                                      | `MORROW_SCENARIOS=S-4 make demo` | `S-4 Duress PASS`               | `Duress mode still shows the request as Pending, the Vault as Active, and Execute as network busy` |
| S-5 | Escape               | With only the Owner Key and the Vault Kit, the Escape CLI signs offline and the coins leave after the Escape Timelock. NEAR is not used. Before the timelock the CLI refuses; told a false height, it signs anyway, and Bitcoin Core rejects that spend as `non-BIP68-final`, so the timelock is enforced by Bitcoin, not by the CLI.                                                                                                                                                                                                                                                                                                                                                                               | `MORROW_SCENARIOS=S-5 make demo` | `S-5 Escape PASS`               | `Signed anyway with a false height, Bitcoin Core rejects it: non-BIP68-final`                      |
| S-6 | Policy Change        | A thief with the Owner keys cannot rewrite the rules. A Script-bound change is refused, a change waits the Policy Change Delay, a Guardian can veto it, and the Guardian Watcher's loosening guard, signing as its own Guardian account, vetoes an unconfirmed loosening change on its own. Against `morrow-vault-dev3.testnet`, which predates Policy Changes, it sends nothing and ends `S-6 Policy Change SKIP (morrow-vault-dev3.testnet predates Policy Changes)`; CI accepts that line for that contract only.                                                                                                                                                                                                | `MORROW_SCENARIOS=S-6 make demo` | `S-6 Policy Change PASS`        | `Unconfirmed loosening change auto-vetoed by the Guardian Watcher`                                 |
| S-7 | Fast Approval        | A Trusted Contact can shorten a withdrawal's Delay, but only down to the Fast Approval Floor, and no one else can. A Backup Device's approval is refused with `ERR_NOT_TRUSTED_CONTACT` and the Owner's with `ERR_UNAUTHORIZED`. The Trusted Contact's approval moves `executable_at` from 10 minutes away to approval time + the 1-minute Floor, and the withdrawal then executes, is co-signed by the NEAR MPC network and confirms on Bitcoin before the original Delay would have ended. Against `morrow-vault-dev3.testnet`, which predates Fast Approval, it sends nothing and ends `S-7 Fast Approval SKIP (morrow-vault-dev3.testnet predates Fast Approval)`; CI accepts that line for that contract only. | `MORROW_SCENARIOS=S-7 make demo` | `S-7 Fast Approval PASS`        | `Fast-approved by the Trusted Contact: the Delay now ends at the Fast Approval Floor`              |

`make kill-near-demo` (not run in CI) runs S-5 with its NEAR client pointed at a dead address (`127.0.0.1:9`), and prints `NEAR is gone: the contract cannot be reached` before the Escape.

**Property suite.** "The contract never co-signs outside the Policy" is also tested with random hostile call sequences, not only with hand-written examples. Each case runs up to 30 steps against the real contract in the NEAR unit-test environment. In those steps the Owner, both Guardians, a stranger and another Vault's Owner and Guardian call every spend, signing, callback, Fast Approval and Policy method. They use bad envelopes, foreign or invalid addresses, empty, duplicate, reserved or fake coins, edge amounts and fee rates, and jump time to 1 ns around each `executable_at` and `effective_at`. After every step the suite checks three invariant families with its own transaction decoder and BIP143 code:

1. **No signature outside the Policy.** Every MPC sign request is for a legally frozen op (a withdrawal no earlier than the end of its Delay, or approval time + the Fast Approval Floor in effect then if that is earlier), comes from an authorised caller, uses the op's path and carries the recomputed sighash. Its transaction pays only what the Policy allows. A Clawback has exactly one output, and it pays the Recovery Address in effect when it was frozen. One case in four starts by moving the Recovery Address through an applied Policy Change, so this is also checked after the address has changed.
2. **No fee above the cap.** min(Fee Cap, 5 %), or min(2 × Fee Cap, 10 %) for a Clawback.
3. **No change to Script-bound data.** A Policy field changes only through an applied Policy Change after its `effective_at`.

CI runs it on every push:

```sh
cargo test -p morrow-vault --profile proptest property -- --nocapture
```

It prints `Property suite: <N> cases, seed <hex>, 0 violations`; by default `Property suite: 1000 cases, seed 0x6d6f72726f77, 0 violations`. `MORROW_PROPTEST_SEED=<hex>` replays another seed and `MORROW_PROPTEST_CASES=<n>` runs more cases. Meta-tests plant bugs and assert that the suite reports each one:

- **Signatures:** a withdrawal frozen 1 ns early; a Fast Approval stored 1 ns below its floor; a stranger's freeze; an allowance over its rolling limit; a change output redirected; an extra output; an allowance paying 1 sat more; a Clawback paying elsewhere, or paying the old Recovery Address after a change; a foreign coin; a wrong version, lock time, sequence or dust output; a forged sign request; a stray sign call; a stored signature that the signer did not return; a panic without an error code.
- **Fees:** a fee 1 sat over each cap.
- **Script-bound data:** each Script-bound field edited; a Policy field edited directly; a change applied 1 ns before `effective_at`; a vetoed change brought back.

## You hold the Owner keys: try to rob it

S-3 is the attack, scripted. A scripted attacker holds the real Owner Key and Owner Account of a funded Vault and uses them to request a withdrawal to its own address.

```sh
MORROW_SCENARIOS=S-3 make demo
```

An excerpt of its output, where `…` stands for lines left out (Vault ids, transaction links, timings):

```text
  …
  You hold the Owner keys. Trying to rob the vault…
  …
  Thief tries to execute at once: ERR_NOT_EXECUTABLE
  …
  Thief tries to execute: ERR_CLAWED_BACK
  Attacker received 0 sats
S-3 Thief and Clawback PASS
```

The request is public on NEAR and has to wait the Delay: an Execute at once is refused. In that time a Guardian claws the whole Vault back to the Recovery Address. After that the contract refuses to co-sign the thief's withdrawal, and Bitcoin script refuses any spend that has only the Owner Key before the Escape Timelock.

To try it by hand, the web app's `/challenge` page offers "Try with these keys": real attempts from your browser with a Rob This Vault round's published Owner keys. It works only while a round is live. Without one, `pnpm --filter @morrow/challenge start attack --dry-run` runs the operator's scripted attacker (100 attempts over 3 rounds against a mock Vault Contract) and prints a JSON summary with `sats_to_attackers`.

## How it works

Coins sit in an ordinary Bitcoin P2WSH address with three spending paths. The Withdrawal Path needs the Owner Key and the Co-signer Key. The Clawback Path needs a Guardian Key and the Co-signer Key, and the contract only co-signs it to the Recovery Address. The Escape Path needs the Owner Key alone, after the Escape Timelock. The Co-signer Key is derived by NEAR Chain Signatures for the Vault Contract, and no person or company holds it. The Vault Contract builds every Bitcoin transaction and sighash itself, so it signs only what its public Policy allows.

```mermaid
flowchart LR
  subgraph device["Owner device"]
    escape["Escape CLI and Vault Kit"]
  end
  web["Web app: Proof Page, X-Ray, Lost a device, Rob This Vault"]
  subgraph near["NEAR"]
    vault["Vault Contract: Policy, builds every transaction"]
    mpc["MPC signer: v1.signer-prod.testnet, v1.signer"]
  end
  subgraph watch["Guardian Watcher"]
    watcher["services/watcher"]
    tg["Telegram alerts"]
  end
  btc[("Bitcoin")]
  judge["tools/judge: make demo"]
  challenge["tools/challenge: Rob This Vault"]

  web -->|"reads Vaults, ops, code_hash; Try with these keys"| vault
  vault -->|"sign only what the Policy allows"| mpc
  web -.->|"reads transactions"| btc
  watcher -->|"events_since"| vault
  watcher --> tg
  watcher -->|"Auto-Clawback"| vault
  escape -.->|"Escape Path, no NEAR"| btc
  judge --> vault
  judge --> btc
  challenge --> vault
  challenge --> btc
```

## Trust model

What Morrow guarantees:

- **G-1 No instant theft.** A thief who holds both the Owner Key and the Owner Account still has to wait the Delay.
- **G-2 Safe-direction recovery.** Until a withdrawal executes, any Guardian can move the whole Vault to the Recovery Address, and nowhere else.
- **G-3 No hostage.** The Co-signer cannot spend alone. If NEAR stops, the Owner Key alone spends after the Escape Timelock, using only Bitcoin.
- **G-4 No silent rule changes.** No Policy field changes faster than the Policy Change Delay, and any Guardian can veto a change.

What you trust:

1. **T-1** NEAR's MPC network (16 participants, threshold 11, as read from `v1.signer-prod.testnet`'s `state` view on 2026-11-04; the mainnet signer `v1.signer` has the same 16 participants and threshold 11, as read from its `state` view on 2026-11-11) signs only what the Vault Contract requests and stays live. If it stops, G-3 still holds.
2. **T-2** The Vault Contract code is correct. It is open source here, unit-tested and run end to end on regtest. The web app's Proof Page (`/proof/<id>`) reads the deployed code hash and the lock from NEAR; open [`/proof/33`](https://morrow-web-341572138939.europe-west1.run.app/proof/33) on the hosted app, or [run it locally](#read-it-in-the-browser).
3. **T-3** A Guardian and the MPC network do not collude. This is the one theft path: together they could sign a Clawback Path spend to any address.
4. **T-4** The Owner keeps the Recovery Address key offline.
5. **T-5** (only with Fast Approval) a Trusted Contact, who can shorten the Delay only to the Fast Approval Floor, does not collude with a thief. **T-6** (only with a Guardian Watcher) the Guardian Watcher stays live and uncompromised.

On a Vault with an Auto-Clawback Guardian, the Guardian Watcher vetoes every loosening Policy Change (such as a new Recovery Address or a shorter Delay) unless the Owner confirms it from the Vault's owner Telegram chat. The request shows the old and new values in full, and a new Recovery Address must have its last 6 characters typed back. A confirmation counts only from the owner chat in force, pressed by the person who linked it, and only if that chat was already active when the change was proposed. The one exception is a replacement chat that the active owner chat approved: it takes over the old chat's activation time. With no active owner chat, every loosening change is vetoed. Telegram links are signed with the Vault's own keys and with the watcher's bot name, so a signed request is good for one watcher only. The watcher's `link-code` command signs one from a key file that only its owner can read (`pnpm --filter @morrow/watcher link-code -- --watcher https://watcher.example --bot <bot> --vault <id> --role owner --account <account> --key-file owner.key`). An owner chat must be a private chat with the bot. A new owner chat becomes active only after 7 days, unless the active owner chat approves it, and every new link is announced to every chat of the Vault. The watcher also vetoes a duress-flagged change, even a confirmed one or one that tightens the rules; it can read that flag only when it holds the watcher key (`MORROW_WATCHER_X25519_SK`), and with that key a flag it cannot read counts as duress. A thief holding the Owner keys can still loosen the Vault if the Owner's Telegram is also compromised, or if the Owner and every Guardian ignore about 14 days of alerts (7 days of link maturity plus the Policy Change Delay). The watcher must be live from `effective_at` − 1 h 5 min until the change is applied.

With the watcher key, the Guardian Watcher of an Auto-Clawback Guardian also acts on duress. A Vault is in duress from the first Owner Watcher Envelope that carries the duress flag, whether it came with a withdrawal request, an execution, or a Policy Change proposal or withdrawal, and it stays in duress. The watcher then queues a Clawback for 1 h 5 min before the earlier of two times: the earliest `executable_at` of the Vault's pending withdrawals, and that first signal plus the Delay. If that time has passed, the Clawback runs at once. A later withdrawal, a Fast Approval or a lowered Delay can only bring it forward. A flag the watcher cannot read never starts a Clawback, because a Clawback moves every coin. It logs a duress request exactly like a normal one. The watcher must be live and caught up from 1 h 5 min before that earlier time.

The testnet deployment, `morrow-vault-v1.testnet`, and the mainnet deployment, `morrow-vault.near`, are locked: their accounts have no access keys, so nobody, the builder included, can replace their code and void the guarantees above. Both have the `code_hash` `3JwGeYBT3FQjyNDhcQ86sTjCEcix2KuTJPePzGxRefsZ`, the same as `make wasm` builds from this repository. Anyone can check both; see [Verify the deployment](#verify-the-deployment).

## Verify the deployment

A locked Vault Contract account has no access keys at all, so nobody, the builder included, can replace its code, delete it, or sign anything as the contract. `tools/deploy verify` checks that from public NEAR data; the verifier needs no keys and no NEAR of their own. The locked testnet deployment is `morrow-vault-v1.testnet` (lock transaction `26q8SS3xT6NhYPJwcMfJge9NkN3p2k3kqpP9Qy5bQ16g`). The locked mainnet deployment is `morrow-vault.near` (deploy transaction `3T7WshZqKbjaKE7h27zoJyPG3CmLoJcZfSXZn83rAbj8`, lock transaction `y6DYezBSgEBqfT1F3evJgk3NjqU3sqwm8DBWmmVoqnY`): the MPC signer `v1.signer`, `bitcoin` only, and a creator allowlist of one account, `00785c6304a08920dff8174f8fb72bfbe28c39357d6715f53f20c6a1d6e52737`, the builder's NEAR implicit account. `tools/deploy` requires a creator allowlist on mainnet, so only that account can create a mainnet Vault.

```sh
pnpm install --frozen-lockfile
make wasm   # builds the contract wasm in the pinned rust:1.97.1 Docker image, so your code_hash matches the operator's
pnpm --filter @morrow/deploy start verify --account morrow-vault-v1.testnet --signer v1.signer-prod.testnet --networks regtest,signet
pnpm --filter @morrow/deploy start verify --account morrow-vault.near --network mainnet --signer v1.signer --networks bitcoin --creators 00785c6304a08920dff8174f8fb72bfbe28c39357d6715f53f20c6a1d6e52737
```

For each account, `verify` reads everything at one final block and prints:

- the block height;
- the deployed `code_hash` next to your local build's;
- `Locked: no access keys`, or every remaining key with its permission;
- `get_config` (MPC signer, allowed Bitcoin networks, creator allowlist, version).

`get_config` must follow the same rules `deploy` applies, and its version must equal `contracts/vault/Cargo.toml`'s. To also check the exact init, put `--signer`, `--networks` and `--creators` after that account's `--account`. With several accounts, `verify` also checks that they all run the same code. It exits 0 only when every check passes, and it ends with `Deployment verified: <n> account(s), code_hash <hash>, locked`.

Pass `--wasm <path>` to compare against another build, and `hash --wasm <path>` prints any wasm file's `code_hash`. The account's network comes from its `.testnet` or `.near` suffix; any other account id needs `--network testnet|mainnet`. An `--rpc` that serves another network is refused. CI builds `make wasm` twice from clean target dirs and checks that both builds have the same `code_hash`.

### Operator: deploy and lock

These steps use a funded account that holds no contract yet. The key comes from `~/.near-credentials/<network>/<account>.json` or `MORROW_DEPLOY_PRIVATE_KEY`, and is never printed. Nothing is sent without `--send` (deploy) or `--confirm <account>` (lock).

```sh
make wasm
# 1. Dry run: prints the DeployContract + new(...) batch and the read-only checks
#    (the account exists, holds no contract, and its balance covers the storage stake). Sends nothing.
pnpm --filter @morrow/deploy start deploy --account <account> --signer v1.signer-prod.testnet --networks signet
# 2. Send it: one transaction, then a verify against the init just sent that does not yet require the lock.
pnpm --filter @morrow/deploy start deploy --account <account> --signer v1.signer-prod.testnet --networks signet --send
# 3. Lock: checks code_hash and get_config against this init, and prints the config, the keys to delete
#    and the balance that can never be withdrawn afterwards. Then, in one transaction, it redeploys the
#    verified wasm and deletes every access key, and re-reads the account.
pnpm --filter @morrow/deploy start lock --account <account> --signer v1.signer-prod.testnet --networks signet --confirm <account>
# 4. Check it the way a judge does.
pnpm --filter @morrow/deploy start verify --account <account> --signer v1.signer-prod.testnet --networks signet
```

On mainnet, add `--network mainnet` and use `--signer v1.signer --networks bitcoin --creators <account>[,<account>]`; every creator must be an existing mainnet account. The tool refuses any other Bitcoin network, any other signer, or an empty creator allowlist there. A testnet deployment cannot allow `bitcoin`. `build --local` builds with the host toolchain and the same flags, for a quick check; its `code_hash` differs from `make wasm`'s because the paths embedded in the wasm differ.

## Prior art

| Approach                                    | What it needs                                                                 | What it can do                                                                                    | What it cannot do                                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| OP_VAULT (BIP-345)                          | A Bitcoin soft fork                                                           | Consensus-enforced delay and recovery                                                             | Run today: the soft fork has not happened, and the proposal was [withdrawn in 2025](https://github.com/bitcoin/bips/pull/1848) |
| CTV vaults (BIP-119)                        | The CTV soft fork                                                             | Precommitted unvault flows                                                                        | Run today: CTV is not active                                                                                                   |
| Presigned-transaction vaults (deleted keys) | Nothing new on Bitcoin                                                        | Delay and recovery today                                                                          | Prove the keys were really deleted, or change amounts and fees after signing                                                   |
| BitVault                                    | The company's co-signing server                                               | A delay with cancel                                                                               | Prove the delay: it is the company's promise, not a public rule                                                                |
| Casa / Unchained collaborative multisig     | A multisig with a provider key                                                | Key recovery and inheritance                                                                      | Delay a spend: a quorum of keys spends at once                                                                                 |
| Morrow                                      | A public NEAR contract that holds no Bitcoin keys, locked with no access keys | A Delay and safe-direction recovery on Bitcoin today, plus an Escape Path that needs only Bitcoin | Stop a Guardian and the MPC network acting together (T-3)                                                                      |

## Sustainability

BitVault sells spend delays by subscription, which shows people pay for this. Morrow's core, the Vault Contract, the web app, the Escape CLI and the Guardian Watcher, stays free, open source and self-hostable. The planned paid layer is an optional hosted Guardian Watcher (alerts, Auto-Clawback, an uptime commitment) and multi-Owner company treasury Vaults. Neither is built yet.

## What is not done yet

- Against the older `morrow-vault-dev3.testnet`, which predates Policy Changes and Fast Approval, S-6 and S-7 end in a SKIP.
- There is no Duress PIN or Duress Session UI yet (Story 8.1): S-4 checks the duress-mode labels that core-ts gives such a client.
- The Guardian Watcher's Telegram alerts for Fast Approval ("fast-approved by" a Guardian, and a possible-duress alert to Trusted Contacts only) are not built yet (Story 8.5b).
- The hosted web app runs on NEAR testnet and Bitcoin signet; the wallet pages create signet Vaults only, never mainnet or regtest ones. The Rob This Vault recording, the demo video and the Mainnet Bounty come with their own stories and are not claimed here.
- The wallet pages keep no keystore and no PIN (Story 1.10): the key file is the only copy of a web-created Vault's keys. They create one Backup Device Guardian, the Owner's own account, with no Guardian invites or Telegram alerts.
- No live Rob This Vault round has run on signet yet.
- Against the default `morrow-vault-v1.testnet`, `make demo` uses the live testnet MPC signer, with no fallback to a mock signer: a Scenario that needs a signature cannot pass while that signer is down.
- X-Ray cannot read a regtest Bitcoin transaction, because there is no public regtest Bitcoin backend.
- The locked mainnet Vault Contract, `morrow-vault.near`, is deployed, but no mainnet Vault holding real bitcoin is claimed here, and the contract has had no independent security audit.

## Repository layout

| Path                    | What it is                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `contracts/vault`       | Vault Contract (Rust, near-sdk): the only place that builds Vault Scripts, transactions and sighashes |
| `contracts/mock-signer` | Sandbox-only stand-in for the NEAR MPC signer                                                         |
| `packages/core-ts`      | Shared TypeScript: contract client, witness assembly, low-S, envelopes, Bitcoin backends              |
| `apps/web`              | Web app: the public site, the wallet pages, Proof Page, X-Ray, Lost a device and Rob This Vault pages |
| `services/watcher`      | Guardian Watcher: event loop, Telegram alerts, Auto-Clawback                                          |
| `tools/escape`          | Standalone offline Escape CLI (no other repo dependencies)                                            |
| `tools/judge`           | Judge Mode Scenario runner (`make demo`)                                                              |
| `tools/challenge`       | Rob This Vault and Mainnet Bounty operator tooling                                                    |
| `tools/deploy`          | Vault Contract build, deploy, lock and verify tooling                                                 |
| `infra/`                | Docker Compose for the local Bitcoin regtest node; the web app's Cloud Run image                      |
| `evidence/`             | Logs of CI Judge Mode runs that this README cites                                                     |

## Development

Rust 1.97.1 (installed from `rust-toolchain.toml`), Node 24.22 (`.nvmrc`) and pnpm 12.16.1 (`corepack enable`).

```sh
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test
cargo test --workspace
make regtest-up   # Bitcoin Core regtest for the integration tests; make regtest-down stops it
pnpm check:readme # this README's Scenario table against tools/judge
```

## How this was built

**Window.** Morrow is an entry to the NEAR Hackathon (2026-11-01 to 2026-11-14). All code in this repository was written in that window.

**Pre-window material.** Before 2026-11-01 the author wrote product research, planning and brand documents and one Chain Signatures spike script. They are kept private and are not part of the submission. The spike called `sign()` on NEAR testnet once to check that the MPC signer returns a signature valid for a P2WSH sighash: transaction `9knPzwxh4kNk2uiq5MiJfJix9YhE9ydNf1SwNJpsj7on` from `timesafe-1029-31513.testnet`.

**AI-generated code.** Most of the code was written with Claude Code, under the author's direction and review. Commits made with it carry a `Co-Authored-By` trailer.

**NEAR tools used.** Chain Signatures (the MPC signer `v1.signer-prod.testnet` on testnet, `v1.signer` on mainnet), NEAR testnet and its faucet, `near-sdk` and `omni-transaction` (Bitcoin transactions and sighashes inside the contract), `near-api-js`, and `@hot-labs/near-connect` (the web app's wallet connection, with Meteor Wallet and Intear Wallet).

**Libraries**, by workspace. Exact versions are pinned in `Cargo.toml`, `Cargo.lock`, each `package.json` and `pnpm-lock.yaml`; CI checks that every runtime dependency is named here.

- `contracts/vault`: `near-sdk`, `omni-transaction`, `bech32`, `bs58`, `sha2`.
- `contracts/mock-signer`: `near-sdk`.
- `packages/core-ts`: `near-api-js`, `bitcoinjs-lib`, `@noble/curves`, `@noble/hashes`, `@noble/ciphers`, `@scure/base`, `libsodium-wrappers-sumo`.
- `apps/web`: `react`, `react-dom`, `@hot-labs/near-connect`, `@radix-ui/react-slot`, `class-variance-authority`, `clsx`, `tailwind-merge`, `@fontsource/anton`, `@fontsource/doto`, `@fontsource/funnel-display`, `@fontsource/funnel-sans`, `@fontsource/geist-mono`. Dev: `vite`, `@vitejs/plugin-react`, `tailwindcss`, `@tailwindcss/vite`, `@playwright/test`.
- `services/watcher`: `grammy`, `@noble/curves`. Dev: `near-api-js`.
- `tools/escape`: `bitcoinjs-lib`, `@noble/curves`.
- `tools/judge`: `near-api-js`, `@noble/curves`.
- `tools/challenge`: `near-api-js`, `bitcoinjs-lib`, `@noble/curves`.
- `tools/deploy`: `near-api-js`.
- Dev, repository-wide: `typescript`, `eslint`, `@eslint/js`, `typescript-eslint`, `prettier`, `vitest`, `tsx`.
- Pinned third-party wallet code, not written for Morrow: Meteor Wallet's and Intear Wallet's near-connect executors, byte for byte as fetched on 2026-11-12, in `apps/web/public/wallets/` (sources and sha256 in `apps/web/src/vault/wallets.ts`).
- Contract build: the Rust Docker image `rust:1.97.1@sha256:b1b3c9c0d921d7fa0a6d1f9ec7e4eab87f8c8ec97644c3d791450f131dec813f` (`make wasm`).
- Runtime services: Bitcoin Core (Docker `bitcoin/bitcoin:32.1@sha256:d2454aaf2ff4ce1ebbc49f4aa05ed044c907b849a80a3f4c0ad23e488e50bbe0`, from `infra/regtest`), Telegram Bot API.

## License

[MIT](LICENSE)
