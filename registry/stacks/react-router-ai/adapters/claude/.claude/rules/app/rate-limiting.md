---
paths:
  - "app/.server/services/RateLimiter*"
  - "app/.server/services/StreamSlots*"
  - "app/.server/http*"
---

# Rate limiting

- `RateLimiter` is a Tag with `check(key)` that returns allowed or a retry delay. The Live layer is an in-memory token bucket (or GCRA) with capacity and refill rate from Config. Not a fixed window: that allows a 2x burst across a window boundary.
- `rateLimitKey(request)` is the only place that picks the key. It returns `"global"` today; per-user or per-API-key limits change that function, not the limiter.
- A distributed limiter (Redis) is another layer behind the same Tag. Keep the interface free of in-memory assumptions (no exposing the bucket Map).
- `StreamSlots` caps concurrent streams separately. Take a slot before streaming and release it exactly once from the end, error, or abort callback.
- Both return 429 with `Retry-After` (seconds, rounded up) through `runRoute`.
- Bucket state lives on `globalThis` in dev so hot reload doesn't reset counters.
- Test with `TestClock`: burst to capacity then reject, refill over time, separate keys are independent, no double burst at a boundary, `Retry-After` matches the delay.
