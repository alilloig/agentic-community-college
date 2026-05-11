# Reference — Lines 103–114 of App.tsx

The following is the reference implementation for the `withRetry` helper (lines 103–114 of `src/App.tsx`):

```tsx
async function withRetry<T>(
    fn: () => Promise<T>,
    retries = 3,
): Promise<T> {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt === retries - 1) throw err;
            await new Promise((res) => setTimeout(res, 50 * (attempt + 1)));
        }
    }
    throw new Error("unreachable");
}
```

This function wraps any async call and retries it up to `retries` times with linear backoff, re-throwing on the final attempt so errors are not silently swallowed.
