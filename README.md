# SruthiScribe

Carnatic vocal recording → svara notation. Pitch tracking and ragam-constrained
decoding run entirely in the browser. A community Supabase database matches
readings against known compositions, suggests corrections, and stores every
contribution as an immutable version.

Static site: no build step, no server, no environment variables. The
database's publishable key is safe to ship in client code — row-level
security restricts it to reads plus append-only inserts.

## Ask panel
No built-in AI backend outside Claude, so each visitor pastes their own
Anthropic API key in "Ask about this reading." Everything else needs no key.

## Deploy
This repo is meant to be connected to Vercel via Git integration (Vercel
dashboard → Add New → Project → Import this repo → Deploy). Once connected,
every push to `main` deploys automatically.
