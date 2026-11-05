.PHONY: regtest-up regtest-down demo kill-near-demo wasm

regtest-up:
	./infra/regtest/up.sh

regtest-down:
	./infra/regtest/down.sh

# Judge Mode: starts regtest and runs Scenarios S-1..S-7.
demo: regtest-up
	pnpm --filter @morrow/judge start

# Video moment: NEAR is unreachable, and the Owner still escapes with the Vault Kit.
kill-near-demo: regtest-up
	MORROW_SCENARIOS=S-5 MORROW_KILL_NEAR=1 pnpm --filter @morrow/judge start

# Reproducible Vault Contract wasm: the pinned Rust image, so anyone gets the deployed code_hash.
# Output: target/reproducible/wasm32-unknown-unknown/release/morrow_vault.wasm
# tools/deploy reads the same values (src/build.ts); a unit test keeps them in step.
RUST_IMAGE := rust:1.97.1@sha256:b1b3c9c0d921d7fa0a6d1f9ec7e4eab87f8c8ec97644c3d791450f131dec813f
WASM_RUSTFLAGS := --cfg near -C link-arg=-s

wasm:
	docker run --rm --platform linux/amd64 \
		-v "$(CURDIR)":/work -w /work \
		-e RUSTFLAGS="$(WASM_RUSTFLAGS)" \
		-e CARGO_TARGET_DIR=/work/target/reproducible \
		$(RUST_IMAGE) \
		cargo build -p morrow-vault --target wasm32-unknown-unknown --release --locked
