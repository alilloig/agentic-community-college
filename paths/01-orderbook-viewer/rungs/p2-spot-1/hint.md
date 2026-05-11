# Hint — Implementing the withRetry Helper

The file you're editing is at `{{ target_file_absolute }}` (lines 103–114).

The `withRetry` function wraps any async operation and automatically retries it when it throws an error.

Start by writing a loop from `attempt = 0` to `retries - 1`. On each iteration, `try` to call `fn()` and return its result if it succeeds. In the `catch` block, check whether this is the last attempt (`attempt === retries - 1`). If it is, re-throw the error so the caller knows all retries were exhausted. Otherwise, wait a short time (e.g. `50 * (attempt + 1)` ms) before the next attempt.

The key insight is that the function is generic (`<T>`) so it can wrap any async call — `midPrice`, `getLevel2TicksFromMid`, or any other gRPC call — without changing the return type.
