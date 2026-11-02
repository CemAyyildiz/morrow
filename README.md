# Morrow

**Bitcoin that can't be rushed.**

Morrow is a time-lock vault for Bitcoin. A public NEAR contract co-signs your Bitcoin through NEAR Chain Signatures, but only after a delay you chose. During that delay a guardian can send a theft back to your cold wallet, and if NEAR ever disappears you can still leave on your own after a Bitcoin timelock.

> Work in progress for the NEAR Hackathon (2026-11-01 → 2026-11-14).

## Repository layout

| Path                    | What it is                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `contracts/vault`       | Vault Contract (Rust, near-sdk): the only place that builds Vault Scripts, transactions and sighashes |
| `contracts/mock-signer` | Sandbox-only stand-in for the NEAR MPC signer                                                         |
| `packages/core-ts`      | Shared TypeScript: contract client, witness assembly, low-S, envelopes, Bitcoin backends              |
| `apps/web`              | Owner, Guardian and Proof Page web app, plus the public site                                          |
| `services/watcher`      | Guardian Watcher: event loop, Telegram alerts, Auto-Clawback                                          |
| `tools/escape`          | Standalone offline Escape CLI (no other repo dependencies)                                            |
| `tools/judge`           | Judge Mode scenario runner                                                                            |
| `tools/challenge`       | Rob This Vault and Mainnet Bounty operator tooling                                                    |
| `infra/`                | Docker Compose (regtest) and Google Cloud deployment                                                  |
| `evidence/`             | Machine-readable run evidence                                                                         |

## Development

Requirements: Rust 1.97.1 (installed automatically from `rust-toolchain.toml`), Node 24.22 (`.nvmrc`) and pnpm 12.16.1 (via `corepack enable`).

```sh
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test
cargo test --workspace
```

## How this was built

Only work done inside the hackathon window is in this repository. Product research and planning written before 2026-11-01 are kept private and are not part of the submission. Development uses AI coding assistants (Claude Code); commits made with that help carry a `Co-Authored-By` trailer.

## License

[MIT](LICENSE)
