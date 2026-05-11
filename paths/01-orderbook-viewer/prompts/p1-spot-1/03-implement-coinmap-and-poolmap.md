# Prompt 3 of 4 — `coinMap` and `poolMap`

Two helpers left in `{{ target_file_absolute }}` (lines 46 and 53):

- `coinMap(m): CoinMap` — `{ DEEP, SUI, USDC }`, each with `{ address, type, scalar }`. SUI uses `SUI_FRAMEWORK_ADDRESS` and scalar `1_000_000_000`; the other two pull `address` from their respective `m.packages.<token>.packageId` and use scalar `1_000_000`.
- `poolMap(m): PoolMap` — `{ DEEP_SUI, SUI_USDC }`, each with `{ address, baseCoin, quoteCoin }` where `address` is the `poolId` from `m.pools.<name>`.

Paste into your live Claude session:

> Two SDK config helpers in `{{ target_file_absolute }}` — `coinMap` and `poolMap`. For each one: explain the shape it produces, then implement it. Specifically: where do `m.pools.DEEP_SUI.baseCoinType` and `m.pools.SUI_USDC.quoteCoinType` come from in the manifest, and why does USDC's `type` come from the *quote* side of `SUI_USDC` instead of from `m.packages.usdc`?

You should personally type:

- The three coin keys (`DEEP`, `SUI`, `USDC`) and the field-pull on each (e.g. `m.packages.token.packageId`).
- Both pool entries with the right `baseCoin`/`quoteCoin` labels.

When `pnpm build` exits 0 inside `{{ workspace_path }}`, run **`getNextPrompt`** for prompt 4.
