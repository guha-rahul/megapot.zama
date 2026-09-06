# The keeper

`startRound`, `closeEntries` and `draw` are `onlyKeeper`. Nothing else in the lifecycle is —
`finalizeEntries`, `finalizeSweep`, `requestSweep`, `claim`, `harvest` and `topUpBuffer` are all
permissionless. So this process is a **scheduler, not a custodian**: if it stops, deposits and
withdrawals keep working and anyone can finish a round that is mid-flight. The worst a dead keeper
can do is leave a round un-opened.

`bot.mjs` decides what the next action is and runs the matching Hardhat task. It shells out rather
than talking to the chain directly because two steps need a KMS round-trip — publishing a
ciphertext for public decryption, then submitting the cleartext with its proof — and that plumbing
already exists and is already exercised in `tasks/megapot.ts`. Re-implementing it would double the
surface area of the part most likely to break.

**It never funds a prize and never moves principal.** When a round is drawable but the reserve is
empty it logs and waits, rather than topping it up: how much money goes into a prize is not a
decision to automate. It also never touches the Base leg — bridging is a value transfer with a
different risk profile and stays manual.

## Give it its own key first

The key that deployed this pool is both `keeper` **and** `owner`. Owner can re-point
`setMegapotRoute` and call the ticket agent's `sweep()`. Putting it on an internet-facing box makes
any compromise of that box a compromise of the protocol's admin.

Generate a fresh address, hand it the keeper role, and deploy only that key:

```shell
# on your own machine, with the owner key
cast wallet new                       # or any wallet — you only need the private key
npx hardhat megapot:set-keeper --address 0x<new-keeper> --network sepolia
```

The new key needs Sepolia ETH for gas and nothing else. It cannot move principal, cannot change
the yield source, cannot re-point the Megapot route, and cannot pause anything but deposits.

## Install

Node 20+ and the repo, on the server:

```shell
sudo useradd --system --create-home --shell /usr/sbin/nologin megapot
sudo git clone https://github.com/guha-rahul/megapot.zama /opt/megapot
sudo chown -R megapot:megapot /opt/megapot
sudo -u megapot npm --prefix /opt/megapot ci
```

Configuration, root-owned so the service user can read it but not rewrite it:

```shell
sudo install -o root -g megapot -m 0640 /dev/null /etc/megapot-keeper.env
sudo tee /etc/megapot-keeper.env >/dev/null <<'EOF'
PRIVATE_KEY=0x<the keeper key, not the owner key>
POOL=0xD5548Cb5b3E2d772f5B72f399f5D52107631e04b
RPC_URL=https://<your keyed sepolia endpoint>
SEPOLIA_RPC_URL=https://<the same endpoint — Hardhat reads this one>
TRACKS=0,1
ROUND_SECONDS=21600
CLAIM_SECONDS=86400
POLL_SECONDS=120
EOF
```

Use a keyed RPC. The bot polls, and a public endpoint under load will rate-limit it into
skipping ticks.

Then the unit:

```shell
sudo cp /opt/megapot/keeper/megapot-keeper.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now megapot-keeper
journalctl -u megapot-keeper -f
```

## Check it before you trust it

Run it once against the live chain with `DRY_RUN=1`. It reads every track, prints the decision it
would make, and sends nothing:

```shell
DRY_RUN=1 POLL_SECONDS=10 POOL=0x<pool> node keeper/bot.mjs
```

Expect lines like:

```
[main] round 0 Open · reserve 3 USDC · draws in 193118s
[mega] round 1 Claimable · reserve 0 USDC
DRY_RUN would run: npx hardhat megapot:sweep --track mega --round 1 --network sepolia
```

## Living alongside other services

The unit is deliberately a quiet neighbour on a busy box: `Nice=10` and `CPUWeight=20` so it
yields to everything else, `MemoryMax=1200M` and `TasksMax=256` so a runaway Hardhat subprocess
cannot exhaust the machine, and `ProtectSystem=strict` with `ReadWritePaths=/opt/megapot` so it can
only write inside its own directory. `StartLimitBurst=5` stops it flapping forever if it is
genuinely broken.

Idle cost is one `eth_getBlockByNumber` plus three small `eth_call`s per track per tick — at the
default 120s poll, a few thousand reads a day.

## Turning it off

```shell
sudo systemctl stop megapot-keeper
```

It handles `SIGTERM` by finishing the tick it is on, so it will not be killed mid-broadcast.
Stopping it strands nothing: a round in `Closing` or `Sweeping` can be finished by anyone, and
depositors can withdraw throughout.
