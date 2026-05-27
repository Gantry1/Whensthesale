import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// === In-memory rate limit + cache (resets when serverless instance recycles) ===
// For production at scale, swap this for Vercel KV or Upstash Redis.
const rateLimitMap = new Map();   // IP -> { count, resetAt }
const cache = new Map();           // brandKey -> { data, expiresAt }

const RATE_LIMIT_PER_HOUR = 10;     // max research calls per IP per hour
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // cache results 24h
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

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 3000,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
      system: `You are a retail sale intelligence agent. Today's date is ${today}.

The user gives you a retailer / brand name. You research:
1. Any CURRENT active sale (check homepage, news, deal sites)
2. HISTORICAL sale patterns over the past 1-2 years (monthly cadence)
3. PREDICT when their next likely sale will be, based on patterns

Search the web aggressively. Look at: the brand's own site, news coverage, deal sites (Slickdeals, RetailMeNot, dealnews), past sale announcements.

Return ONLY raw JSON, no markdown, no backticks, no explanation:
{
  "name": "Brand Name (clean, properly capitalized)",
  "tagline": "One short sentence describing their sale strategy",
  "activeSale": {
    "name": "string e.g. 'Memorial Day Sale'",
    "discount": "string e.g. '40% off everything'",
    "ends": "string e.g. 'Ends June 2'"
  } or null if no active sale,
  "nextSale": {
    "name": "string",
    "when": "string e.g. 'Mid-July'",
    "discount": "string e.g. '30-40% off'"
  },
  "bestSaleEver": "string e.g. 'Black Friday — 40% off everything'",
  "lastSale": "string e.g. 'Black Friday 2025'",
  "saleCalendar": {
    "Jan": "short label of typical sale in Jan, or empty string",
    "Feb": "...", "Mar": "...", "Apr": "...", "May": "...", "Jun": "...",
    "Jul": "...", "Aug": "...", "Sep": "...", "Oct": "...", "Nov": "...", "Dec": "..."
  },
  "patterns": ["4-6 bullets, 1-2 sentences each"],
  "proTip": "best concrete advice, 2-3 sentences",
  "shopUrl": "URL to the brand's sale or main page",
  "nextEvent": "short label e.g. 'May 23' or 'Nov 2026'",
  "avgDiscount": "string e.g. '25-30%'"
}

Keep saleCalendar labels SHORT (under 25 chars).
Be honest — if a brand rarely has sales, leave most months empty.
If you cannot find a brand by that name, return: {"error": "Brand not found"}`,
      messages: [{ role: "user", content: `Research the sale patterns for: ${rawName}` }],
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

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
    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=86400");
    res.status(200).json(parsed);
  } catch (err) {
    console.error("Research error:", err);
    // Don't leak internal error details to the client
    res.status(500).json({ error: "Research failed. Try again later." });
  }
}
