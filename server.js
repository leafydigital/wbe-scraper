/**
 * WBE CRM — Local Scraper Service
 * ================================
 * Runs on http://localhost:3001
 * Uses Playwright (real Chromium) + Cheerio — exactly like the working Node.js script.
 *
 * Start: cd scraper-service && npm install && npm run install-browsers && npm start
 *
 * API:
 *   POST /scrape        { url: "https://example.com" }
 *   POST /scrape-batch  { leads: [{ website, facebook? }, ...] }
 *   GET  /health        → { ok: true }
 */

const express    = require("express");
const cors       = require("cors");
const axios      = require("axios");
const cheerio    = require("cheerio");
const { chromium } = require("playwright");

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ── API Key auth — set SCRAPER_API_KEY in Railway env vars ───
const API_KEY = process.env.SCRAPER_API_KEY || null;
app.use((req, res, next) => {
  if (req.path === "/health") return next(); // health check is public
  if (!API_KEY) return next();               // no key set = open (local dev)
  const provided = req.headers["x-api-key"] || req.query.key;
  if (provided !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ── Config ────────────────────────────────────────────────────
const PAGES_TO_CHECK = [
  "",
  "/contact",
  "/contact-us",
  "/contactus",
  "/about",
  "/about-us",
  "/aboutus",
  "/team",
  "/our-team",
  "/kontakt",
  "/impressum",
  "/over-ons",
  "/imprint",
  "/reach-us",
];

const SOCIAL_DOMAINS = [
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "youtube.com",
];

const JUNK_EMAIL_PATTERNS = [
  "example@mail.com", "example.com", "facebook.com", "fb.com",
  "sentry", "noreply", "no-reply", "do-not-reply", "donotreply",
  "test@test.com", "mail.com", "email.com", "example.org", "example.net",
  "yourdomain", "wixpress", "schema", "google", "apple",
  "w3", "jquery", "cloudflare", "amazonaws", "test@", "user@",
  ".png@", ".jpg@", ".svg@", "@2x",
];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ── Email extraction ──────────────────────────────────────────
function extractEmails(text) {
  const raw = text.match(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi) || [];
  return [...new Set(raw)].filter(isValidEmail);
}

function isValidEmail(email) {
  const lower = email.toLowerCase();
  return (
    email.includes("@") &&
    email.length > 5 &&
    email.length < 100 &&
    !JUNK_EMAIL_PATTERNS.some(j => lower.includes(j)) &&
    !/\.(png|jpg|jpeg|gif|svg|webp|bmp|ico|css|js)$/i.test(email) &&
    /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email)
  );
}

// ── Social link extraction ────────────────────────────────────
function extractSocials(html) {
  const $ = cheerio.load(html);
  const found = { facebook: null, instagram: null, linkedin: null, twitter: null, tiktok: null, youtube: null };
  const facebookUrls = new Set();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const lower = href.toLowerCase();

    if (lower.includes("facebook.com") && !lower.includes("/share") && !lower.includes("/sharer") && !lower.includes("/dialog")) {
      const clean = href.replace(/[/"'\s]+$/, "").split("?")[0];
      if (!found.facebook) found.facebook = clean;
      facebookUrls.add(clean);
    }
    if (lower.includes("instagram.com") && !lower.includes("/p/") && !lower.includes("/reel/") && !found.instagram) {
      found.instagram = href.replace(/[/"'\s]+$/, "").split("?")[0];
    }
    if (lower.includes("linkedin.com/company") && !found.linkedin) {
      found.linkedin = href.replace(/[/"'\s]+$/, "").split("?")[0];
    }
    if ((lower.includes("twitter.com") || lower.includes("x.com")) && !lower.includes("/share") && !lower.includes("/intent") && !found.twitter) {
      found.twitter = href.replace(/[/"'\s]+$/, "").split("?")[0];
    }
    if (lower.includes("tiktok.com") && !found.tiktok) {
      found.tiktok = href.replace(/[/"'\s]+$/, "").split("?")[0];
    }
    if (lower.includes("youtube.com/@") && !found.youtube) {
      found.youtube = href.replace(/[/"'\s]+$/, "").split("?")[0];
    }
  });

  // Also scan raw HTML for links not in <a> tags (JSON configs, JS vars)
  const rawFb = html.match(/https?:\/\/(?:www\.)?facebook\.com\/(?!share|sharer|dialog|policy|help|legal|ads|business|watch|groups|events\/|login|photo|video|plugins)[a-zA-Z0-9.\-_]+/gi) || [];
  rawFb.forEach(u => {
    const clean = u.replace(/[/"'\s\\]+$/, "").split("?")[0];
    if (!found.facebook) found.facebook = clean;
    facebookUrls.add(clean);
  });

  const rawTk = html.match(/https?:\/\/(?:www\.)?tiktok\.com\/@[a-zA-Z0-9.\-_]+/gi) || [];
  if (!found.tiktok && rawTk.length) found.tiktok = rawTk[0].replace(/[/"'\s]+$/, "").split("?")[0];

  const rawYt = html.match(/https?:\/\/(?:www\.)?youtube\.com\/@[a-zA-Z0-9.\-_]+/gi) || [];
  if (!found.youtube && rawYt.length) found.youtube = rawYt[0].replace(/[/"'\s]+$/, "").split("?")[0];

  return { ...found, allFacebookUrls: [...facebookUrls] };
}

// ── Fetch a page with axios ───────────────────────────────────
async function fetchPage(url) {
  try {
    const res = await axios.get(url, {
      timeout: 15000,
      headers: { "User-Agent": USER_AGENT },
      validateStatus: s => s < 400,
    });
    return res.data;
  } catch {
    return null;
  }
}

// ── Scrape Facebook with Playwright (real browser — your exact script) ──
async function scrapeFacebookWithPlaywright(browser, facebookUrl) {
  const page = await browser.newPage();
  try {
    console.log(`[Facebook] Scraping: ${facebookUrl}`);

    await page.goto(facebookUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Wait for page to settle
    await page.waitForTimeout(4000);

    // Scroll several times to load dynamic content — exactly like your script
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, 2000));
      await page.waitForTimeout(1500);
    }

    // Get both rendered text and raw HTML — exactly like your script
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const html     = await page.content();

    // Extract from visible text + HTML
    const textEmails = extractEmails(bodyText);
    const htmlEmails = extractEmails(html);

    const all = [...new Set([...textEmails, ...htmlEmails])];
    console.log(`[Facebook] Found ${all.length} emails from ${facebookUrl}`);
    return all;
  } catch (err) {
    console.log(`[Facebook] Error: ${err.message}`);
    return [];
  } finally {
    await page.close();
  }
}

// ── Main scrape function ──────────────────────────────────────
async function scrapeWebsite(websiteUrl) {
  const result = {
    emails: [],
    facebook: null,
    instagram: null,
    linkedin: null,
    twitter: null,
    tiktok: null,
    youtube: null,
  };

  if (!websiteUrl) return result;

  const baseUrl = websiteUrl.startsWith("http") ? websiteUrl : `https://${websiteUrl}`;
  const allEmails = new Set();
  const allFacebookUrls = new Set();

  let domain = "";
  try { domain = new URL(baseUrl).hostname.replace("www.", ""); } catch {}

  // ── Step 1: Scrape website pages ─────────────────────────
  const pageUrls = PAGES_TO_CHECK.map(p => baseUrl.replace(/\/$/, "") + p);

  await Promise.all(pageUrls.map(async (url) => {
    const html = await fetchPage(url);
    if (!html) return;

    // Extract emails
    extractEmails(html).forEach(e => allEmails.add(e));

    // Extract socials
    const socials = extractSocials(html);
    if (!result.facebook  && socials.facebook)  result.facebook  = socials.facebook;
    if (!result.instagram && socials.instagram) result.instagram = socials.instagram;
    if (!result.linkedin  && socials.linkedin)  result.linkedin  = socials.linkedin;
    if (!result.twitter   && socials.twitter)   result.twitter   = socials.twitter;
    if (!result.tiktok    && socials.tiktok)    result.tiktok    = socials.tiktok;
    if (!result.youtube   && socials.youtube)   result.youtube   = socials.youtube;
    socials.allFacebookUrls.forEach(u => allFacebookUrls.add(u));
  }));

  console.log(`[${domain}] Website: ${allEmails.size} emails, ${allFacebookUrls.size} FB URLs`);

  // ── Step 2: Scrape each Facebook URL with Playwright ─────
  if (allFacebookUrls.size > 0) {
    const browser = await chromium.launch({ headless: true });
    try {
      for (const fbUrl of allFacebookUrls) {
        const fbEmails = await scrapeFacebookWithPlaywright(browser, fbUrl);
        fbEmails.forEach(e => allEmails.add(e));
      }
    } finally {
      await browser.close();
    }
  }

  // ── Step 3: Deduplicate — domain emails first ─────────────
  const allValid = [...allEmails].filter(isValidEmail);
  const domainEmails = allValid.filter(e =>  e.includes(domain));
  const otherEmails  = allValid.filter(e => !e.includes(domain));
  result.emails = [...new Set([...domainEmails, ...otherEmails])];

  console.log(`[${domain}] Final: ${result.emails.length} unique emails`);
  return result;
}

// ── Routes ────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "WBE Scraper", version: "1.0.0" });
});

// Single scrape
app.post("/scrape", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });

  console.log(`\n[/scrape] ${url}`);
  try {
    const result = await scrapeWebsite(url);
    res.json(result);
  } catch (err) {
    console.error("[/scrape] Error:", err.message);
    res.status(500).json({ error: err.message, emails: [], facebook: null, instagram: null, linkedin: null, twitter: null, tiktok: null, youtube: null });
  }
});

// Batch scrape — processes multiple websites, returns array in same order
app.post("/scrape-batch", async (req, res) => {
  const { leads } = req.body;
  if (!Array.isArray(leads) || !leads.length) {
    return res.status(400).json({ error: "leads array required" });
  }

  console.log(`\n[/scrape-batch] ${leads.length} leads`);

  // Process 3 at a time to balance speed vs resource use
  const CONCURRENCY = 3;
  const results = new Array(leads.length).fill(null);

  for (let i = 0; i < leads.length; i += CONCURRENCY) {
    const batch = leads.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(lead => scrapeWebsite(lead.website || lead.url || ""))
    );
    settled.forEach((r, j) => {
      results[i + j] = r.status === "fulfilled"
        ? r.value
        : { emails: [], facebook: null, instagram: null, linkedin: null, twitter: null, tiktok: null, youtube: null };
    });
    console.log(`[/scrape-batch] ${Math.min(i + CONCURRENCY, leads.length)}/${leads.length} done`);
  }

  res.json({ results });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ WBE Scraper Service running on http://localhost:${PORT}`);
  console.log(`   POST /scrape        — scrape single website`);
  console.log(`   POST /scrape-batch  — scrape multiple websites`);
  console.log(`   GET  /health        — health check\n`);
});
