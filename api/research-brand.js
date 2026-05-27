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
      max_tokens: 2000,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }],
      system: `You are a retail sale intelligence agent. Today's date is ${today}.

User gives you a brand name. Research efficiently — aim for 2-3 web searches total:
1. CURRENT active sale (check brand site + recent deal coverage)
2. HISTORICAL sale patterns (monthly cadence over past 1-2 years)
3. PREDICT next likely sale based on patterns

Prioritize: brand's own site, deal aggregators (Slickdeals, RetailMeNot), recent news.

Return ONLY raw JSON, no markdown, no backticks:
{
  "name": "Brand Name (properly capitalized)",
  "tagline": "one short sentence on their sale strategy",
  "activeSale": {
    "name": "e.g. Memorial Day Sale",
    "discount": "e.g. 40% off",
    "ends": "e.g. Ends June 2"
  } or null if no active sale,
  "nextSale": {
    "name": "string",
    "when": "e.g. Mid-July",
    "discount": "e.g. 30-40% off"
  },
  "saleCalendar": {
    "Jan": "short label under 20 chars or empty",
    "Feb": "...", "Mar": "...", "Apr": "...", "May": "...", "Jun": "...",
    "Jul": "...", "Aug": "...", "Sep": "...", "Oct": "...", "Nov": "...", "Dec": "..."
  },
  "patterns": ["3 short bullets, 1 sentence each"],
  "proTip": "2 sentences max",
  "shopUrl": "URL to brand's sale or main page",
  "nextEvent": "short label e.g. May 23 or Nov 2026",
  "avgDiscount": "e.g. 25-30%"
}

Be honest — if a brand rarely discounts, leave most calendar months empty.
If brand not found: {"error": "Brand not found"}`,
      messages: [{ role: "user", content: `Research: ${rawName}` }],
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
