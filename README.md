# Sale Radar

Track when premium brands go on sale. Search any brand and get live sale intelligence, predicted next sale dates, and a 12-month calendar.

## Files

- `index.html` — the frontend (single file, no build step)
- `api/research-brand.js` — Vercel serverless function that researches any brand using Claude + web search
- `package.json` — declares the Anthropic SDK dependency

## Deploy to Vercel (5 minutes)

1. **Create an Anthropic API key** at https://console.anthropic.com/
2. **Push these files to a GitHub repo** (or use Vercel's CLI)
3. **Import to Vercel** → https://vercel.com/new
4. In the project settings, add an **Environment Variable**:
   - Name: `ANTHROPIC_API_KEY`
   - Value: your API key from step 1
5. Deploy. You'll get a URL like `sale-radar.vercel.app`

That's it. The 8 popular brands work instantly. Any other brand the user searches will trigger live research via the API.

## How it works

```
User types "Allbirds"
        ↓
Frontend checks if brand is in the 8 popular ones → no
        ↓
Frontend checks localStorage cache → no
        ↓
Frontend calls /api/research-brand?name=Allbirds
        ↓
Serverless function calls Claude with web_search enabled
        ↓
Claude searches the web, parses results into structured JSON
        ↓
Function returns JSON to frontend
        ↓
Frontend caches in localStorage + renders the modal
```

## Costs

Each unique brand search costs roughly **$0.05–0.10** in Anthropic API + web search fees. After the first search, the result is cached in the user's browser for free.

For better economics at scale, add server-side caching (Vercel KV, Upstash Redis) so the same brand isn't re-researched across users — drop your costs by 95%+.

## Adding your affiliate links

Each brand has a `shopUrl` field. For the 8 popular brands, edit them directly in `index.html` (search for `shopUrl:`). For researched brands, you'd want to:

1. Add a post-processing step in the API function that wraps URLs with your affiliate program ID
2. Or use Skimlinks/Sovrn — they auto-convert URLs at runtime

## Email capture

The waitlist form currently logs to console. To collect real emails, the easiest path is **Formspree**:

1. Sign up at https://formspree.io
2. Create a form, get your endpoint URL
3. In `index.html`, find the `handleEmail` function and replace the console.log with:

```javascript
await fetch("https://formspree.io/f/YOUR_FORM_ID", {
  method: "POST",
  body: JSON.stringify({ email: input.value }),
  headers: { "Content-Type": "application/json", Accept: "application/json" },
});
```

## Next steps to harden this into a real product

1. **Server-side caching** — store researched brands in a database (Supabase/Vercel KV) so repeated lookups are instant + free
2. **Daily refresh cron** — re-research each cached brand every 24 hours so data stays current
3. **SEO pages** — generate `/brand/[slug]` pages server-side for each brand, so Google indexes them and you rank for "when is the next Lululemon sale"
4. **Premium alerts** — Stripe-gated tier that emails users when their watchlist brands cross a discount threshold
