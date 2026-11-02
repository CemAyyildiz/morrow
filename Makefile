.PHONY: regtest-up regtest-down demo

regtest-up:
	./infra/regtest/up.sh

regtest-down:
	./infra/regtest/down.sh

# Judge Mode: starts regtest and runs Scenarios S-1..S-7.
demo: regtest-up
	pnpm --filter @morrow/judge start
