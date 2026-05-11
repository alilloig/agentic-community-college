# Prompt 4 of 4 — Verify and reflect

Build inside the workspace:

```bash
cd {{ workspace_path }} && pnpm build
```

If the build fails, read the error carefully — the most common slips on this spot are a missing `pickObject` exclusion, a mistyped scalar, or returning `m.packages.usdc.packageId` for USDC's `type` instead of the pool's `quoteCoinType`.

When the build is green, paste this into your live Claude session as the closing reflection:

> I just finished Phase 1 of the Orderbook Viewer course. In two or three sentences each, summarize: (a) why the manifest fetch is decoupled from the SDK client construction, (b) why the SDK takes coin metadata as a *map* rather than reading it on-demand from `getCoinMetadata`, and (c) what would break if I returned the wrong `REGISTRY_ID` (the `MarginRegistry` instead of `Registry`).

Once you've read Claude's reflection and you're satisfied with your understanding, the conductor will ask you to call **`verifySpot`** to lock in the spot and advance the cursor.

You're done with the prompted-agentic flow for this spot.
