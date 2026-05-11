# Prompt 1 of 4 — Orient yourself with the manifest

Open `{{ target_file_absolute }}` and read the file end-to-end. Pay particular attention to:

- The `Manifest` interface (lines 16–20) — this is the JSON shape returned by `/api/faucet/manifest`.
- The three helper signatures `packageIds`, `coinMap`, `poolMap` (lines 39–58) — they're empty bodies right now; that's the gap you're going to fill.
- How `client` (lines 84–90) wires the helpers into `deepbook({ packageIds, coins, pools })`.

Then paste this prompt into your live Claude session:

> I'm working through the Orderbook Viewer course (Phase 1 — Manifest → SDK Config). I'm in `{{ target_file_absolute }}`. Walk me through what `manifest.packages.deepbook.objects` actually contains in this lesson — each entry has `objectId` and `objectType`. Why does `pickObject(objs, "Registry", "Margin")` exclude `Margin`?

Read Claude's explanation. Stop when you understand:

1. The shape of `manifest.packages.<name>.objects` and why filtering by exact `::TypeName` (not substring) matters.
2. Which package on the manifest contains the DeepBook `Registry` vs the margin trading `MarginRegistry`.
3. Why `packageIds` returns three id fields rather than e.g. one big config blob.

When you can answer all three from memory, run **`getNextPrompt`** for prompt 2.
