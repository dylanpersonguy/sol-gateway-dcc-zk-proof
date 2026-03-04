'use strict';
/**
 * Per-user rate limiter middleware for Telegraf.
 *
 * Limits each Telegram userId to `maxRequests` commands within `windowMs`.
 * Bots are exempt (ctx.from.is_bot).
 *
 * Usage:
 *   bot.use(rateLimiter({ windowMs: 10_000, maxRequests: 5 }));
 */

/**
 * @param {object} opts
 * @param {number} opts.windowMs      Rolling window in milliseconds (default 10 000)
 * @param {number} opts.maxRequests   Max requests per window per user (default 5)
 * @param {string} [opts.message]     Reply text when rate-limited
 */
function rateLimiter({
  windowMs    = 10_000,
  maxRequests = 5,
  message     = '⏳ Too many requests — please slow down.',
} = {}) {
  // userId → [timestamp, ...]
  const buckets = new Map();

  // Prune stale entries every minute to avoid memory growth
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [uid, times] of buckets) {
      const fresh = times.filter(t => t > cutoff);
      if (fresh.length === 0) buckets.delete(uid);
      else buckets.set(uid, fresh);
    }
  }, 60_000).unref();

  return async (ctx, next) => {
    // Only rate-limit real user messages / callback queries
    if (!ctx.from || ctx.from.is_bot) return next();

    const uid    = ctx.from.id;
    const now    = Date.now();
    const cutoff = now - windowMs;
    const times  = (buckets.get(uid) || []).filter(t => t > cutoff);

    if (times.length >= maxRequests) {
      // Silently ignore callback queries; reply to messages
      if (ctx.callbackQuery) {
        try { await ctx.answerCbQuery(message); } catch {}
      } else {
        try { await ctx.reply(message); } catch {}
      }
      return; // do not call next()
    }

    times.push(now);
    buckets.set(uid, times);
    return next();
  };
}

module.exports = { rateLimiter };
