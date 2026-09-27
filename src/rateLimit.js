// =============================================================================
// RATE LIMIT — fixed-window cap on requests per client address
// -----------------------------------------------------------------------------
// In-memory, per process. Render runs one instance of this service, so one
// map is the whole picture; if that ever changes the cap becomes per instance
// (N× looser), which is still a cap. Written inline rather than pulled from
// npm: the service has three dependencies and each one is a supply-chain
// surface.
//
// Fixed window: the first request from an address opens a window of
// `windowMs`; requests beyond `max` inside it answer 429 with Retry-After
// (seconds until the window resets). Expired entries are swept once a minute
// so an address that never comes back does not stay in memory.
//
// Keys on req.ip, which is the X-Forwarded-For client only because server.js
// sets `trust proxy`; without that every caller behind Render's proxy would
// share one bucket.
// =============================================================================

const SWEEP_INTERVAL_MS = 60_000;

export function rateLimit({ max, windowMs }) {
  const hits = new Map(); // ip -> { count, resetAt }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(ip);
    }
  }, SWEEP_INTERVAL_MS);
  sweep.unref(); // never keeps the process alive on its own

  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    const key = req.ip || "unknown";
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((entry.resetAt - now) / 1000),
      );
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res
        .status(429)
        .json({ error: "Too many requests. Try again shortly." });
    }
    next();
  };
}
