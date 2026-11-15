# makefun-token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Sandi207/makefun-token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Sandi207/makefun-token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar ranks the pre-token protocols in DefiLlama's frozen snapshot by implied value and shows how to farm each one. The board covers the snapshot's whole 40-protocol watchlist, plus every pre-token protocol below the watchlist floor that passes the watchlist's own token-existence test. The value model (radar-2) calibrates its base multiple from the snapshot's own live market — the median market-cap-to-TVL ratio of its live-token protocols, per category where the snapshot has enough of them — then adjusts for seven-day growth, age with no token, and chain breadth. The dashboard is a static page with no network: search, category, chain and scope filters, sortable columns, a per-protocol detail view with the model's own inputs and a farm plan with costs and durations.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=tvfbjxfd&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
