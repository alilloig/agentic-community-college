# Hint — Implementing the Polling Tick

The file you're editing is at `{{ target_file_absolute }}` (lines 116–145).

The polling tick runs on a fixed interval and must tolerate individual gRPC failures without stopping the loop.

Use `setInterval` to schedule the tick. Inside the tick callback, wrap each DeepBook SDK call with `withRetry(...)` to handle transient failures. Store the results in React state with `useState` and update them inside the callback.

Remember: if a tick throws after all retries are exhausted, catch that error and increment a failure counter — but do NOT clear the interval. The loop should keep running even when individual ticks fail, so the UI continues to refresh once the sandbox recovers.

The poll interval value `{{ poll_interval_ms }}` is injected from your personalization settings, so the student controls how frequently the order book refreshes.
