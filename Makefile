.PHONY: regtest-up regtest-down demo kill-near-demo

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
