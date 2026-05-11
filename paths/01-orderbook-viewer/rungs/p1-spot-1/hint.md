# Hint — Wiring the Manifest to the SDK

The file you're editing is at `{{ target_file_absolute }}` (lines 39–58).

You need to implement three helper functions that extract configuration from the deployment manifest.

For pool `{{ pool_subset }}`, the relevant pool entry is under `manifest.pools.{{ pool_subset }}`.

**`packageIds(manifest)`** — look inside `manifest.packages.deepbook` for the package id and Registry object, and `manifest.packages.token` for the ProtectedTreasury.

**`coinMap(manifest)`** — the DEEP coin address comes from `manifest.packages.token.packageId`; SUI uses `SUI_FRAMEWORK_ADDRESS`; USDC comes from `manifest.packages.usdc.packageId`.

**`poolMap(manifest)`** — map pool names (e.g. `DEEP_SUI`, `SUI_USDC`) to their `poolId` from `manifest.pools`.

Once you have these three, pass them to `deepbook({ address: ZERO_ADDR, packageIds: ..., coins: ..., pools: ... })` as the `$extend` argument.
