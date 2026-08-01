# SruthiScribe

Carnatic vocal recording → svara notation. Pitch tracking and ragam-constrained
decoding run entirely in the browser. A community Supabase database matches
readings against known compositions, suggests corrections, stores every
contribution as an immutable version, and can be browsed directly by ragam,
type, or free text.

Static site: no build step. One serverless function.

## Ask panel — shared Claude access (recommended)
This site can answer "Ask about this reading" questions for every visitor
using one Anthropic API key you provide, so nobody needs their own:

1. Vercel dashboard → this project → **Settings → Environment Variables**
2. Add `ANTHROPIC_API_KEY` = your key (starts `sk-ant-...`)
3. Redeploy (Vercel does this automatically on save, or trigger one manually)

The key lives only in Vercel's environment and inside `api/ask.js`'s server
runtime — it is never sent to the browser, never visible in page source, and
the model used is fixed server-side to Sonnet (`claude-sonnet-5`), ignoring
anything the client sends. If this isn't configured, visitors can still paste
their own Anthropic API key in the panel, which is used directly from their
browser and never touches this server.

## Database
Ships with the live Supabase project's URL and public "publishable" key
baked into `index.html` — the same database the Claude artifact version
uses. The publishable key is safe to ship: row-level security only allows
reads plus append-only community inserts; nothing can be edited or deleted
through it, and no service-role/secret key is used client-side anywhere.

## Everything else
Recording, pitch tracking, notation, corrections, database browsing, and PDF
export run entirely in the browser and need no key at all.
