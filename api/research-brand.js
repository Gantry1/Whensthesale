import Anthropic from "@anthropic-ai/sdk";

// Allow this function to run up to 50s on Vercel (longer than our 45s internal
// abort, so our graceful timeout fires first instead of Vercel hard-killing it).
export const config = { maxDuration: 50 };

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// === In-memory rate limit + cache (resets when serverless instance recycles) ===
// For production at scale, swap this for Vercel KV or Upstash Redis.
const rateLimitMap = new Map();   // IP -> { count, resetAt }
const cache = new Map();           // brandKey -> { data, expiresAt }

const RATE_LIMIT_PER_HOUR = 10;     // max research calls per IP per hour
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // cache results 1 week
const ALLOWED_ORIGINS = [
  // Add your Vercel URL here once deployed, e.g. "https://sale-radar-xxx.vercel.app"
  // Add your custom domain when you have one
  // For testing, leave "*" or add localhost
];

function getClientIP(req) {
  const fwd = req.headers["x-forwarded-for"];
  return (typeof fwd === "string" ? fwd.split(",")[0].trim() : null) ||
    req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown";
}

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return { ok: true, remaining: RATE_LIMIT_PER_HOUR - 1 };
  }
  if (entry.count >= RATE_LIMIT_PER_HOUR) {
    return { ok: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count++;
  return { ok: true, remaining: RATE_LIMIT_PER_HOUR - entry.count };
}

export default async function handler(req, res) {
  // === CORS ===
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // === Input validation ===
  const rawName = (req.query.name || "").toString().trim();
  if (!rawName) {
    res.status(400).json({ error: "Missing 'name' query param" });
    return;
  }
  if (rawName.length > 60) {
    res.status(400).json({ error: "Brand name too long (max 60 chars)" });
    return;
  }
  // Allow letters, numbers, spaces, ampersand, dot, hyphen, apostrophe — block everything else
  if (!/^[a-zA-Z0-9\s&.\-']+$/.test(rawName)) {
    res.status(400).json({ error: "Invalid characters in brand name" });
    return;
  }
  const name = rawName.toLowerCase();

  // === Server-side cache (free repeat lookups) ===
  const cached = cache.get(name);
  if (cached && Date.now() < cached.expiresAt) {
    res.setHeader("X-Cache", "HIT");
    res.status(200).json(cached.data);
    return;
  }

  // === Rate limiting ===
  const ip = getClientIP(req);
  const rl = checkRateLimit(ip);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    res.status(429).json({ error: "Rate limit exceeded. Try again in an hour." });
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: "Server not configured" });
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const startTime = Date.now();

  // Hard timeout: abort the call if it runs longer than 45s so a runaway
  // agentic loop can't burn 90+ seconds and a pile of tokens.
  const TIMEOUT_MS = 45000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await anthropic.messages.create(
      {
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 1 }],
      system: `You are a retail sale intelligence agent. Today's date is ${today}.

CRITICAL SEARCH LIMIT: You may run AT MOST 1 web search. After it returns, you MUST immediately write the final JSON using only the information you have gathered. Do NOT run a 2nd search under any circumstances, even if information feels incomplete. Make your single search count by using ONE broad, high-yield query that captures both current sale status AND historical sale patterns at once.

Good single-query examples:
- "[brand name] sale history 2024 2025 black friday memorial day"
- "[brand name] current promo and past year sales"

Prioritize results from: brand's own site, deal aggregators (Slickdeals, RetailMeNot), recent news.

Return ONLY raw JSON, no markdown, no backticks. The angle-bracket text below describes what goes in each field — those are DESCRIPTIONS, NOT literal values to copy.

{
  "name": "<brand name, properly capitalized>",
  "tagline": "<one short sentence on the brand's sale strategy>",
  "activeSale": <object described below, OR null>,
  "alwaysOnPromo": <object described below, OR null>,
  "nextSale": {
    "name": "<predicted next sale name based on historical pattern>",
    "when": "<predicted timing, e.g. mid-July, late November>",
    "discount": "<historically typical discount range>"
  },
  "saleMonths": [
    { "month": "<3-letter month>", "label": "<short event label>", "discount": "<honest discount range>" }
  ],
  "patterns": ["<3 short bullets, 1 sentence each, describing this brand's sale behavior>"],
  "proTip": "<concrete actionable advice, max 2 sentences>",
  "shopUrl": "<URL to brand's main shop or sale page>",
  "nextEvent": "<short label, e.g. Jul 2026, Nov 2026>",
  "avgDiscount": "<typical discount range>"
}

=== CRITICAL RULES FOR activeSale (most error-prone field) ===

activeSale MUST be null unless ALL THREE of these are true:
  (a) Your search returned clear evidence of a sale CURRENTLY running on the brand's OWN website (not just a deal-blog article describing a past sale)
  (b) The source describing the sale is recent — published or updated within the last 5 days
  (c) Any end date stated for the sale is ON OR AFTER today (${today})

If you decide activeSale should be populated, use this shape:
{
  "name": "<sale name exactly as the brand calls it on their site right now>",
  "discount": "<headline discount as stated on the brand site>",
  "ends": "<'Ends Month Day' format, only if the brand explicitly states an end date; otherwise null>"
}

NEVER fabricate, predict, or guess an end date. If the brand doesn't explicitly state one, set "ends" to null — do not make one up to fill the field.

Holiday-sale guardrails:
- Memorial Day sales end by the Tuesday after Memorial Day (last Monday of May)
- Black Friday sales end by Cyber Monday
- Labor Day sales end the Tuesday after Labor Day
- 4th of July sales end within a few days of July 4
If today (${today}) is past that natural end window, the sale is NOT active — return activeSale: null EVEN IF articles you find still describe it as if active. Those articles are stale.

When uncertain, return activeSale: null. The UI gracefully falls back to alwaysOnPromo and nextSale, so a null active sale is ALWAYS better than an inaccurate one.

=== RULES FOR saleMonths ===

ONLY include months where the brand runs a STOREWIDE (or near-storewide) sale of 10% OR MORE — OR a signature annual event shoppers actively watch for (e.g., Aloversary, Apple Back-to-School bundle, Apple Black Friday gift card promo, Patagonia Past-Season Sale, Sephora Beauty Insider events).

EXCLUDE: category-only sales (e.g. "spring dresses 20% off"), outlet-only events, vague promotions ("spring picks"), and small flash sales under 10%.

The "discount" field MUST BE HONEST. If a brand says "up to 50% off" but most items are at 10–20%, write "10–50%" or "20–50%" — NOT "50%". Use ranges ("20–40%") freely. Use dollar ranges for brands that discount that way ("$50–100 off"). Use "Up to $X" for gift-card promos like Apple. Use "Free gift" for bundle promos. Never overpromise — a user who sees the headline number should expect that to roughly match what they pay. Keep label under 22 chars.

Use 3-letter month names (Jan, Feb, Mar...). A brand with 2 storewide events returns 2 entries — do NOT pad with empty or weak entries. Be honest — if a brand rarely runs storewide sales, return just 1 entry (e.g. only Black Friday). It's fine to return an empty saleMonths array if a brand never has storewide sales.

=== RULES FOR alwaysOnPromo ===

Use this for the SMALLER ongoing offer a brand has when no major sale is running, so users always have something actionable when they click through. Good examples: a brand's permanent sale/outlet/clearance section ("Past-season styles up to 50% off"), a year-round student/educator discount ("15% off with valid school ID"), a loyalty program with real discounts ("adiClub members get monthly drops"), a refurbished-goods program ("Bose Refurbished, 15–25% off with full warranty").

Shape:
{
  "name": "<short offer name>",
  "discount": "<concrete discount info>"
}

Return null only if the brand truly has nothing always available — but most do. Keep both fields short and concrete.

===

If you cannot find a brand after your one search, return: {"error": "Brand not found"}

REMINDER: Exactly 1 search. After it returns, write the JSON immediately. When uncertain about activeSale, ALWAYS prefer null over inventing data.`,
      messages: [{ role: "user", content: `Research: ${rawName}` }],
      },
      { signal: controller.signal }
    );

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    // --- Timing & search-count diagnostics (visible in Vercel logs) ---
    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    const searchCount = response.content.filter(
      (b) => b.type === "server_tool_use" || b.type === "web_search_tool_result"
    ).length;
    console.log(
      `[research] brand="${rawName}" elapsed=${elapsedSec}s searchBlocks=${searchCount} ` +
      `inputTokens=${response.usage?.input_tokens ?? "?"} outputTokens=${response.usage?.output_tokens ?? "?"} ` +
      `stopReason=${response.stop_reason}`
    );

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      res.status(502).json({ error: "Could not parse research result" });
      return;
    }

    const parsed = JSON.parse(match[0]);
    if (parsed.error) {
      res.status(404).json(parsed);
      return;
    }

    // Cache it
    cache.set(name, { data: parsed, expiresAt: Date.now() + CACHE_TTL_MS });

    res.setHeader("X-Cache", "MISS");
    res.setHeader("Cache-Control", "public, s-maxage=604800, stale-while-revalidate=604800");
    res.status(200).json(parsed);
  } catch (err) {
    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    if (err.name === "AbortError" || controller.signal.aborted) {
      console.error(`[research] TIMEOUT brand="${rawName}" elapsed=${elapsedSec}s (aborted at ${TIMEOUT_MS / 1000}s)`);
      res.status(504).json({ error: "Research took too long. Please try again." });
    } else {
      console.error(`[research] ERROR brand="${rawName}" elapsed=${elapsedSec}s msg=${err.message}`);
      res.status(500).json({ error: "Research failed. Try again later." });
    }
  } finally {
    clearTimeout(timeoutId);
  }
}
