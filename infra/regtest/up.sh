#!/usr/bin/env bash
# Starts Bitcoin Core regtest and leaves a funded "miner" wallet with mature coins.
set -euo pipefail

cd "$(dirname "$0")"
docker compose up -d --wait --wait-timeout 60

cli() {
  docker compose exec -T bitcoind bitcoin-cli -regtest -rpcuser=morrow -rpcpassword=morrow "$@"
}

if ! cli listwallets | grep -q '"miner"'; then
  cli loadwallet miner >/dev/null 2>&1 || cli createwallet miner >/dev/null
fi

height=$(cli getblockcount)
if [ "$height" -lt 101 ]; then
  address=$(cli -rpcwallet=miner getnewaddress)
  cli generatetoaddress $((101 - height)) "$address" >/dev/null
fi

echo "regtest ready: height $(cli getblockcount), miner balance $(cli -rpcwallet=miner getbalance) BTC"
echo "MORROW_REGTEST_RPC=http://morrow:morrow@127.0.0.1:18443"
