# Morrow

**Bitcoin that can't be rushed.**

Morrow is a time-lock vault for Bitcoin that works today, with no soft fork, no bridge and no wrapped BTC. A public NEAR contract co-signs your Bitcoin through NEAR Chain Signatures, but only after a Delay you chose, and during that Delay any Guardian can send a theft back to your own cold Recovery Address. If NEAR ever disappears, you still leave on your own after a Bitcoin timelock.

## Run the demo

You need a running Docker daemon, `make`, Node 24 and pnpm (`corepack enable`). A run takes about 15 minutes and needs no Bitcoin funds, API keys or accounts: Bitcoin runs on a local regtest node, and the NEAR testnet accounts come from the public faucet.

```sh
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
| `MORROW_NEAR_RPC_URL`                                    | the public NEAR testnet RPC            | The NEAR RPC endpoint.                                                                                                                         |
| `MORROW_REGTEST_RPC`                                     | `http://morrow:morrow@127.0.0.1:18443` | The Bitcoin Core regtest RPC that `make demo` starts.                                                                                          |
| `MORROW_RELEASE`                                         | unset                                  | `1` reports a mandatory Scenario that is not built as `FAIL` instead of `SKIP (not built)`.                                                    |

## Scenarios

Run one Scenario with its command, or all of them with `make demo`. The expected line and the progress line are exact: CI runs `make demo` and fails if its log lacks any of them (`.github/scripts/check-readme.mjs`).

| Id  | Scenario             | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Command                          | Expected line                   | Progress line also checked                                                                         |
| --- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------- |
| S-1 | Create               | A real Vault on NEAR testnet. Its Vault Address and Allowance Address are recomputed from the Vault Kit and match what the contract reports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `MORROW_SCENARIOS=S-1 make demo` | `S-1 Create PASS`               | `Co-signer keys derived by the NEAR MPC network (v1.signer-prod.testnet)`                          |
| S-2 | Withdraw after Delay | Execute before the Delay is refused by the contract. After the Delay the NEAR MPC network co-signs, and the withdrawal confirms on Bitcoin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `MORROW_SCENARIOS=S-2 make demo` | `S-2 Withdraw after Delay PASS` | `Execute before the Delay rejected: ERR_NOT_EXECUTABLE`                                            |
| S-3 | Thief and Clawback   | A thief with the real Owner keys requests a withdrawal. A Guardian claws back to the Recovery Address, the thief's Execute fails, and 0 sats leave.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `MORROW_SCENARIOS=S-3 make demo` | `S-3 Thief and Clawback PASS`   | `Attacker received 0 sats`                                                                         |
| S-4 | Duress               | A coerced Owner's withdrawal fails silently. On a Vault with a 10-minute Delay, the Owner first makes a control withdrawal with a normal Watcher Envelope, then, coerced, requests a withdrawal to an attacker with a duress-flagged one. On-chain the two look the same: envelopes of the same length, the same fields in their events and `get_op`, and no duress field. The Guardian Watcher's real duress handler, run as the Vault's Auto-Clawback Guardian, queues a Clawback at min(`executable_at`, signal + Delay) − 65 min, which has already passed, so it is due at once. Its real Clawback runner sends every coin to the Recovery Address, co-signed by the NEAR MPC network, and the Clawback begins before either withdrawal could execute. The coerced Execute fails with `ERR_CLAWED_BACK`, the attacker receives 0 sats, and the duress-mode labels from core-ts still show the request as Pending and the Vault as Active. | `MORROW_SCENARIOS=S-4 make demo` | `S-4 Duress PASS`               | `Duress mode still shows the request as Pending, the Vault as Active, and Execute as network busy` |
| S-5 | Escape               | With only the Owner Key and the Vault Kit, the Escape CLI signs offline and the coins leave after the Escape Timelock. NEAR is not used.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `MORROW_SCENARIOS=S-5 make demo` | `S-5 Escape PASS`               | `Vault Kit saved; from here on NEAR is not used`                                                   |
| S-6 | Policy Change        | A thief with the Owner keys cannot rewrite the rules. A Script-bound change is refused, a change waits the Policy Change Delay, a Guardian can veto it, and the Guardian Watcher's loosening guard, signing as its own Guardian account, vetoes an unconfirmed loosening change on its own. Against `morrow-vault-dev3.testnet`, which predates Policy Changes, it sends nothing and ends `S-6 Policy Change SKIP (morrow-vault-dev3.testnet predates Policy Changes)`; CI accepts that line for that contract only.                                                                                                                                                                                                                                                                                                                                                                                                                           | `MORROW_SCENARIOS=S-6 make demo` | `S-6 Policy Change PASS`        | `Unconfirmed loosening change auto-vetoed by the Guardian Watcher`                                 |
| S-7 | Fast Approval        | A Trusted Contact can shorten a withdrawal's Delay, but only down to the Fast Approval Floor, and no one else can. A Backup Device's approval is refused with `ERR_NOT_TRUSTED_CONTACT` and the Owner's with `ERR_UNAUTHORIZED`. The Trusted Contact's approval moves `executable_at` from 10 minutes away to approval time + the 1-minute Floor, and the withdrawal then executes, is co-signed by the NEAR MPC network and confirms on Bitcoin before the original Delay would have ended. Against `morrow-vault-dev3.testnet`, which predates Fast Approval, it sends nothing and ends `S-7 Fast Approval SKIP (morrow-vault-dev3.testnet predates Fast Approval)`; CI accepts that line for that contract only.                                                                                                                                                                                                                            | `MORROW_SCENARIOS=S-7 make demo` | `S-7 Fast Approval PASS`        | `Fast-approved by the Trusted Contact: the Delay now ends at the Fast Approval Floor`              |

`make kill-near-demo` (not run in CI) runs S-5 with NEAR made unreachable on purpose, and prints `NEAR is gone: the contract cannot be reached` before the Escape.

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
  Thief tries to execute: ERR_CLAWED_BACK
  Attacker received 0 sats
S-3 Thief and Clawback PASS
```

The request is public on NEAR and has to wait the Delay. In that time a Guardian claws the whole Vault back to the Recovery Address. After that the contract refuses to co-sign the thief's withdrawal, and Bitcoin script refuses any spend that has only the Owner Key before the Escape Timelock.

To try it by hand, the web app's `/challenge` page offers "Try with these keys": real attempts from your browser with a Rob This Vault round's published Owner keys. It works only while a round is live. Without one, `pnpm --filter @morrow/challenge start attack --dry-run` runs the operator's scripted attacker (100 attempts over 3 rounds against a mock Vault Contract) and prints a JSON summary with `sats_to_attackers`.

## How it works

Coins sit in an ordinary Bitcoin P2WSH address with three spending paths. The Withdrawal Path needs the Owner Key and the Co-signer Key. The Clawback Path needs a Guardian Key and the Co-signer Key, and the contract only co-signs it to the Recovery Address. The Escape Path needs the Owner Key alone, after the Escape Timelock. The Co-signer Key is derived by NEAR Chain Signatures for the Vault Contract, and no person or company holds it. The Vault Contract builds every Bitcoin transaction and sighash itself, so it signs only what its public Policy allows.

```mermaid
flowchart LR
  subgraph device["Owner device"]
    web["Web app: Owner, Guardian, Proof Page"]
    escape["Escape CLI and Vault Kit"]
  end
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

  web -->|"Withdrawal Request, Clawback"| vault
  vault -->|"sign only what the Policy allows"| mpc
  web -->|"broadcast co-signed transaction"| btc
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

1. **T-1** NEAR's MPC network (16 participants, threshold 11, as read from `v1.signer-prod.testnet`'s `state` view on 2026-11-04) signs only what the Vault Contract requests and stays live. If it stops, G-3 still holds.
2. **T-2** The Vault Contract code is correct. It is open source here, unit-tested and run end to end on regtest. The web app's Proof Page (`/proof/<id>`) reads the deployed code hash from NEAR; its hosted link comes later.
3. **T-3** A Guardian and the MPC network do not collude. This is the one theft path: together they could sign a Clawback Path spend to any address.
4. **T-4** The Owner keeps the Recovery Address key offline.
5. **T-5** (only with Fast Approval) a Trusted Contact, who can shorten the Delay only to the Fast Approval Floor, does not collude with a thief. **T-6** (only with a Guardian Watcher) the Guardian Watcher stays live and uncompromised.

On a Vault with an Auto-Clawback Guardian, the Guardian Watcher vetoes every loosening Policy Change (such as a new Recovery Address or a shorter Delay) unless the Owner confirms it from the Vault's owner Telegram chat. The request shows the old and new values in full, and a new Recovery Address must have its last 6 characters typed back. A confirmation counts only from the owner chat in force, pressed by the person who linked it, and only if that chat was already active when the change was proposed. The one exception is a replacement chat that the active owner chat approved: it takes over the old chat's activation time. With no active owner chat, every loosening change is vetoed. Telegram links are signed with the Vault's own keys and with the watcher's bot name, so a signed request is good for one watcher only. The watcher's `link-code` command signs one from a key file that only its owner can read (`pnpm --filter @morrow/watcher link-code -- --watcher https://watcher.example --bot <bot> --vault <id> --role owner --account <account> --key-file owner.key`). An owner chat must be a private chat with the bot. A new owner chat becomes active only after 7 days, unless the active owner chat approves it, and every new link is announced to every chat of the Vault. The watcher also vetoes a duress-flagged change, even a confirmed one or one that tightens the rules; it can read that flag only when it holds the watcher key (`MORROW_WATCHER_X25519_SK`), and with that key a flag it cannot read counts as duress. A thief holding the Owner keys can still loosen the Vault if the Owner's Telegram is also compromised, or if the Owner and every Guardian ignore about 14 days of alerts (7 days of link maturity plus the Policy Change Delay). The watcher must be live from `effective_at` − 1 h 5 min until the change is applied.

With the watcher key, the Guardian Watcher of an Auto-Clawback Guardian also acts on duress. A Vault is in duress from the first Owner Watcher Envelope that carries the duress flag, whether it came with a withdrawal request, an execution, or a Policy Change proposal or withdrawal, and it stays in duress. The watcher then queues a Clawback for 1 h 5 min before the earlier of two times: the earliest `executable_at` of the Vault's pending withdrawals, and that first signal plus the Delay. If that time has passed, the Clawback runs at once. A later withdrawal, a Fast Approval or a lowered Delay can only bring it forward. A flag the watcher cannot read never starts a Clawback, because a Clawback moves every coin. It logs a duress request exactly like a normal one. The watcher must be live and caught up from 1 h 5 min before that earlier time.

The deployment is not locked yet. Until its account's access keys are deleted (Story 7.5), whoever deployed it can replace the contract code and void every guarantee above. The tooling that locks a deployment, and lets anyone check one, is in `tools/deploy`; see [Verify the deployment](#verify-the-deployment).

## Verify the deployment

A locked Vault Contract account has no access keys at all, so nobody, the builder included, can replace its code, delete it, or sign anything as the contract. `tools/deploy verify` checks that from public NEAR data; the verifier needs no keys and no NEAR of their own. The locked testnet and mainnet account names will be filled in here once they are deployed (see What is not done yet).

```sh
pnpm install --frozen-lockfile
make wasm   # builds the contract wasm in the pinned rust:1.97.1 Docker image, so your code_hash matches the operator's
pnpm --filter @morrow/deploy start verify --account <testnet-account> --account <mainnet-account>
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

| Approach                                    | What it needs                                                                     | What it can do                                                                                    | What it cannot do                                                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| OP_VAULT (BIP-345)                          | A Bitcoin soft fork                                                               | Consensus-enforced delay and recovery                                                             | Run today: the soft fork has not happened, and the proposal was [withdrawn in 2025](https://github.com/bitcoin/bips/pull/1848) |
| CTV vaults (BIP-119)                        | The CTV soft fork                                                                 | Precommitted unvault flows                                                                        | Run today: CTV is not active                                                                                                   |
| Presigned-transaction vaults (deleted keys) | Nothing new on Bitcoin                                                            | Delay and recovery today                                                                          | Prove the keys were really deleted, or change amounts and fees after signing                                                   |
| BitVault                                    | The company's co-signing server                                                   | A delay with cancel                                                                               | Prove the delay: it is the company's promise, not a public rule                                                                |
| Casa / Unchained collaborative multisig     | A multisig with a provider key                                                    | Key recovery and inheritance                                                                      | Delay a spend: a quorum of keys spends at once                                                                                 |
| Morrow                                      | A public NEAR contract that holds no Bitcoin keys, to be locked before submission | A Delay and safe-direction recovery on Bitcoin today, plus an Escape Path that needs only Bitcoin | Stop a Guardian and the MPC network acting together (T-3)                                                                      |

## Sustainability

BitVault sells spend delays by subscription, which shows people pay for this. Morrow's core, the Vault Contract, the web app, the Escape CLI and the Guardian Watcher, stays free, open source and self-hostable. The planned paid layer is an optional hosted Guardian Watcher (alerts, Auto-Clawback, an uptime commitment) and multi-Owner company treasury Vaults. Neither is built yet.

## What is not done yet

The default deployment, `morrow-vault-v1.testnet`, is not locked yet: until its last access key is deleted (Story 7.5b), whoever holds that key can replace its code. Against the older `morrow-vault-dev3.testnet`, which predates Policy Changes and Fast Approval, S-6 and S-7 end in a SKIP. There is no Duress PIN or Duress Session UI yet (Story 8.1): S-4 checks the duress-mode labels that core-ts gives such a client. The Guardian Watcher's Telegram alerts for Fast Approval ("fast-approved by" a Guardian, and a possible-duress alert to Trusted Contacts only) are not built yet (Story 8.5b). The hosted link to the demo Vault's Proof Page, the hosted live demo, the Rob This Vault recording, the Mainnet Bounty and the locked deployment with its code hash come with their own stories and are not claimed here. Nothing in this repository is deployed on mainnet.

## Repository layout

| Path                    | What it is                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `contracts/vault`       | Vault Contract (Rust, near-sdk): the only place that builds Vault Scripts, transactions and sighashes |
| `contracts/mock-signer` | Sandbox-only stand-in for the NEAR MPC signer                                                         |
| `packages/core-ts`      | Shared TypeScript: contract client, witness assembly, low-S, envelopes, Bitcoin backends              |
| `apps/web`              | Owner, Guardian and Proof Page web app, plus the public site                                          |
| `services/watcher`      | Guardian Watcher: event loop, Telegram alerts, Auto-Clawback                                          |
| `tools/escape`          | Standalone offline Escape CLI (no other repo dependencies)                                            |
| `tools/judge`           | Judge Mode Scenario runner (`make demo`)                                                              |
| `tools/challenge`       | Rob This Vault and Mainnet Bounty operator tooling                                                    |
| `tools/deploy`          | Vault Contract build, deploy, lock and verify tooling                                                 |
| `infra/`                | Docker Compose (regtest) and Google Cloud deployment                                                  |
| `evidence/`             | Machine-readable run evidence                                                                         |

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

**NEAR tools used.** Chain Signatures (the MPC signer `v1.signer-prod.testnet` on testnet, `v1.signer` on mainnet), NEAR testnet and its faucet, `near-sdk` and `omni-transaction` (Bitcoin transactions and sighashes inside the contract), and `near-api-js`.

**Libraries**, by workspace. Exact versions are pinned in `Cargo.toml`, `Cargo.lock`, each `package.json` and `pnpm-lock.yaml`; CI checks that every runtime dependency is named here.

- `contracts/vault`: `near-sdk`, `omni-transaction`, `bech32`, `bs58`, `sha2`.
- `contracts/mock-signer`: `near-sdk`.
- `packages/core-ts`: `near-api-js`, `bitcoinjs-lib`, `@noble/curves`, `@noble/hashes`, `@noble/ciphers`, `@scure/base`, `libsodium-wrappers-sumo`.
- `apps/web`: `react`, `react-dom`, `@radix-ui/react-slot`, `class-variance-authority`, `clsx`, `tailwind-merge`, `@fontsource/anton`, `@fontsource/doto`, `@fontsource/funnel-display`, `@fontsource/funnel-sans`, `@fontsource/geist-mono`. Dev: `vite`, `@vitejs/plugin-react`, `tailwindcss`, `@tailwindcss/vite`, `@playwright/test`.
- `services/watcher`: `grammy`, `@noble/curves`. Dev: `near-api-js`.
- `tools/escape`: `bitcoinjs-lib`, `@noble/curves`.
- `tools/judge`: `near-api-js`, `@noble/curves`.
- `tools/challenge`: `near-api-js`, `bitcoinjs-lib`, `@noble/curves`.
- `tools/deploy`: `near-api-js`.
- Dev, repository-wide: `typescript`, `eslint`, `@eslint/js`, `typescript-eslint`, `prettier`, `vitest`, `tsx`.
- Contract build: the Rust Docker image `rust:1.97.1@sha256:b1b3c9c0d921d7fa0a6d1f9ec7e4eab87f8c8ec97644c3d791450f131dec813f` (`make wasm`).
- Runtime services: Bitcoin Core (Docker `bitcoin/bitcoin:32.1@sha256:d2454aaf2ff4ce1ebbc49f4aa05ed044c907b849a80a3f4c0ad23e488e50bbe0`, from `infra/regtest`), Telegram Bot API.

## License

[MIT](LICENSE)
