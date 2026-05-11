# Phase 1 — Manifest → SDK Config

Welcome to Phase 1 of the Orderbook Viewer path. In this phase you will wire the DeepBook sandbox deployment manifest into the Sui TypeScript SDK client.

## What you are building

The sandbox's faucet endpoint at `/api/faucet/manifest` returns a JSON manifest that describes every on-chain object deployed by `pnpm deploy-all`. Your task is to extract three pieces of configuration from this manifest:

1. **`packageIds`** — the DeepBook package id, the Registry object id, and the Deep Treasury id.
2. **`coinMap`** — the DEEP, SUI, and USDC coin metadata required by the SDK.
3. **`poolMap`** — the pool object ids for DEEP_SUI and SUI_USDC.

These three helpers feed directly into the `deepbook(...)` SDK extension call that attaches the order book client to a `SuiGrpcClient`.

## Why this matters

The DeepBook v3 SDK uses a `deepbook({ address, packageIds, coins, pools })` factory. Every read-only operation — `midPrice`, `getLevel2TicksFromMid` — goes through this client. Without correctly wiring the manifest, the SDK cannot locate the on-chain objects and all queries will fail.

## Acceptance

Phase 1 is complete when `pnpm build` exits 0. This confirms the TypeScript compiler accepts your implementation and the SDK types align.

## References

- `.ts-sdk-docs/sui/clients/grpc.mdx` — `SuiGrpcClient` constructor and `$extend` pattern.
- `.sui-docs/develop/transactions/ptbs/inputs-and-results.mdx` — Background on how Sui objects are addressed.
- `paths/01-orderbook-viewer/reference/App.tsx` — Reference implementation (lines 39–58).
