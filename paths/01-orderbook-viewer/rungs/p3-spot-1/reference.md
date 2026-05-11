# Reference — Lines 116–145 of App.tsx

The following is the reference implementation for the polling loop (lines 116–145 of `src/App.tsx`). The literal `{{ poll_interval_ms }}` placeholder is replaced at runtime with your personalization value.

```tsx
useEffect(() => {
    if (!client) return;
    let failures = 0;

    const tick = async () => {
        try {
            const mid = await withRetry(() =>
                client.deepbook.midPrice(POOL_ID),
            );
            const ticks = await withRetry(() =>
                client.deepbook.getLevel2TicksFromMid(POOL_ID, DEPTH),
            );
            setMidPrice(mid);
            setLevel2Ticks(ticks);
            failures = 0;
        } catch (err) {
            failures += 1;
            console.warn(`Polling tick failed (${failures} consecutive):`, err);
        }
    };

    void tick();
    const id = setInterval(() => { void tick(); }, {{ poll_interval_ms }});
    return () => clearInterval(id);
}, [client]);
```

The key design points:
- Each tick calls `withRetry` so transient gRPC errors are retried before counting as a failure.
- Failures increment a counter but do not cancel the interval — the loop keeps running.
- The `{{ poll_interval_ms }}` placeholder is substituted with your `poll_interval_ms` personalization value (e.g. `3000` for 3-second polling).
