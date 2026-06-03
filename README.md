# WBE Scraper Service

Playwright + Express scraper service. Runs the exact script you wrote —
real Chromium for Facebook, axios+cheerio for websites.

---

## Local Development

```bash
cd scraper-service
npm install
npm run install-browsers   # one-time: downloads Chromium
npm start                  # runs on http://localhost:3001
```

Your `.env` stays as:
```
VITE_SCRAPER_URL=http://localhost:3001
VITE_SCRAPER_API_KEY=          # empty = no auth locally
```

---

## Production Deployment (Railway — Recommended)

### 1. Push scraper-service to GitHub
The `scraper-service/` folder needs to be its own GitHub repo (or subfolder).

```bash
# Option A: separate repo (easiest)
cd scraper-service
git init
git add .
git commit -m "WBE scraper service"
git remote add origin https://github.com/YOUR_USERNAME/wbe-scraper.git
git push -u origin main
```

### 2. Deploy on Railway
1. Go to https://railway.app → New Project → Deploy from GitHub
2. Select your `wbe-scraper` repo
3. Railway auto-detects the Dockerfile ✓

### 3. Set environment variables in Railway
In Railway dashboard → your service → Variables:
```
SCRAPER_API_KEY=your-random-secret-here   # generate: openssl rand -hex 32
PORT=3001                                  # Railway sets this automatically
```

### 4. Get your Railway URL
Railway gives you a URL like: `https://wbe-scraper-production.up.railway.app`

### 5. Update your Vercel environment variables
In Vercel dashboard → your project → Settings → Environment Variables:
```
VITE_SCRAPER_URL=https://wbe-scraper-production.up.railway.app
VITE_SCRAPER_API_KEY=your-random-secret-here   # same value as Railway
```

Redeploy on Vercel — done.

---

## Alternative: Render.com (Free)

1. New Web Service → connect GitHub repo
2. Runtime: Docker
3. Set env var: `SCRAPER_API_KEY=your-secret`
4. Note: free tier spins down after 15min inactivity (first request takes ~30s to wake up)

---

## How It Works

```
LeadRadar search
    │
    ├─ emailScraper.ts checks localhost:3001/health (or VITE_SCRAPER_URL)
    │
    ├─ Service ONLINE ──► POST /scrape { url }
    │                         │
    │                         ├─ axios fetches /contact, /about, etc.
    │                         ├─ cheerio extracts emails + socials
    │                         ├─ finds Facebook URL on site
    │                         └─ Playwright opens Facebook in real Chromium
    │                               scrolls 5x, extracts emails from text+HTML
    │
    └─ Service OFFLINE ──► browser fallback (no Facebook, still works)
```

## API

| Method | Endpoint | Auth | Body |
|--------|----------|------|------|
| GET | `/health` | None | — |
| POST | `/scrape` | `x-api-key` header | `{ url: "https://..." }` |
| POST | `/scrape-batch` | `x-api-key` header | `{ leads: [{website}] }` |
