# Prompt 2 of 4 — Implement `packageIds`

You're going to fill in the `packageIds(m: Manifest): DeepbookPackageIds` body in `{{ target_file_absolute }}` (line 39). The function returns three ids the SDK extension needs to locate every on-chain object DeepBook touches.

Paste this into your live Claude session:

> In `{{ target_file_absolute }}`, sketch the body of `packageIds(m)` so it returns `{ DEEPBOOK_PACKAGE_ID, REGISTRY_ID, DEEP_TREASURY_ID }`. Use `pickObject` for the two object lookups. Walk me through your reasoning **first** — which package each id comes from, what the `pickObject` call's typeName / exclude arguments should be — and then write the code. Highlight the parts I should type myself rather than just accepting a copy-paste.

You should personally type at least:

- The three property names on the returned object.
- The `pickObject(m.packages.deepbook.objects, "Registry", "Margin")` call (the `"Registry"` literal and the `"Margin"` exclusion).
- The `m.packages.deepbook.packageId` lookup.

When the function compiles AND you can explain why `"Margin"` is excluded without looking, run **`getNextPrompt`** for prompt 3.
