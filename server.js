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

app.use(cors({
  origin: ['https://wanderbreezeexim.com', 'http://localhost:5173', 'https://wbe-scraper.up.railway.app', 'https://production.up.railway.app'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key'],
}));
app.use(express.json());
app.options('*', cors()); // handle preflight

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
  // ── Core ─────────────────────────────────────────────────
  "",
  "/contact",
  "/contact-us",
  "/contact_us",
  "/contactus",
  "/contacts",
  "/contact/",

  // ── WordPress common slugs ────────────────────────────────
  "/contact-us/",
  "/get-in-touch",
  "/get-in-touch/",
  "/reach-us",
  "/reach-out",
  "/enquiry",
  "/enquire",
  "/inquiry",
  "/send-message",
  "/book-appointment",
  "/appointment",
  "/book",
  "/booking",

  // ── PHP / static site extensions ─────────────────────────
  "/contact.php",
  "/contact-us.php",
  "/contactus.php",
  "/contact.html",
  "/contact-us.html",
  "/contactus.html",
  "/contact.htm",
  "/enquiry.php",
  "/enquiry.html",
  "/getintouch.php",
  "/getintouch.html",

  // ── Location-based contact pages (clinics/local biz) ─────
  "/melbourne-contact",
  "/sydney-contact",
  "/brisbane-contact",
  "/perth-contact",
  "/contact-melbourne",
  "/contact-sydney",
  "/locations",
  "/our-locations",
  "/find-us",
  "/visit-us",
  "/our-clinic",
  "/our-office",
  "/our-practice",
  "/clinic",
  "/clinic-contact",

  // ── About pages (often have email) ───────────────────────
  "/about",
  "/about-us",
  "/about_us",
  "/aboutus",
  "/about/",
  "/about-us/",
  "/our-story",
  "/our-team",
  "/team",
  "/staff",
  "/meet-the-team",

  // ── Shopify ───────────────────────────────────────────────
  "/pages/contact",
  "/pages/contact-us",
  "/pages/about",
  "/pages/about-us",
  "/pages/get-in-touch",

  // ── Squarespace / Wix / Webflow ──────────────────────────
  "/contact-1",
  "/contact-page",
  "/contact-form",
  "/contactpage",

  // ── European / multilingual ───────────────────────────────
  "/kontakt",           // German/Dutch
  "/impressum",         // German legal (almost always has email)
  "/imprint",
  "/ueber-uns",
  "/uber-uns",
  "/over-ons",          // Dutch
  "/nous-contacter",    // French
  "/contacto",          // Spanish
  "/contatti",          // Italian
  "/contato",           // Portuguese
  "/iletisim",          // Turkish

  // ── Footer/legal pages (often contain email) ─────────────
  "/privacy-policy",
  "/privacy",
  "/legal",
  "/terms",
  "/disclaimer",
  "/sitemap",
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

// ── Scrape Facebook with Playwright (real browser) ──────────
async function scrapeFacebookWithPlaywright(browser, facebookUrl) {
  const page = await browser.newPage();
  try {
    console.log(`[Facebook] Scraping: ${facebookUrl}`);

    // Set a real user agent to avoid bot detection
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
    });

    const allEmails = new Set();

    // ── Visit 1: Main page (homepage) ──────────────────────
    await page.goto(facebookUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(3000);

    // Scroll to load dynamic content
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, 2000));
      await page.waitForTimeout(1000);
    }

    let bodyText = await page.locator("body").innerText().catch(() => "");
    let html = await page.content();
    extractEmails(bodyText).forEach(e => allEmails.add(e));
    extractEmails(html).forEach(e => allEmails.add(e));

    // ── Visit 2: About tab — this is where email/contact info lives ──
    const aboutUrl = facebookUrl.replace(/\/$/, "") + "/about";
    try {
      await page.goto(aboutUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page.waitForTimeout(3000);

      // Scroll the about page
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.scrollBy(0, 1500));
        await page.waitForTimeout(800);
      }

      bodyText = await page.locator("body").innerText().catch(() => "");
      html = await page.content();
      extractEmails(bodyText).forEach(e => allEmails.add(e));
      extractEmails(html).forEach(e => allEmails.add(e));
      console.log(`[Facebook] About page scraped: ${allEmails.size} emails so far`);
    } catch (err) {
      console.log(`[Facebook] About page failed: ${err.message}`);
    }

    // ── Visit 3: about_contact — dedicated contact info page ──
    const contactUrl = facebookUrl.replace(/\/$/, "") + "/about_contact_and_basic_info";
    try {
      await page.goto(contactUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page.waitForTimeout(3000);

      bodyText = await page.locator("body").innerText().catch(() => "");
      html = await page.content();
      extractEmails(bodyText).forEach(e => allEmails.add(e));
      extractEmails(html).forEach(e => allEmails.add(e));
      console.log(`[Facebook] Contact page scraped: ${allEmails.size} emails so far`);
    } catch (err) {
      console.log(`[Facebook] Contact page failed: ${err.message}`);
    }

    const all = [...allEmails];
    console.log(`[Facebook] Total found: ${all.length} emails from ${facebookUrl}`);
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

// ═══════════════════════════════════════════════════════════════
// EMAIL SENDER — /send-emails
// Uses nodemailer + Gmail App Password
// Called by Supabase cron every 15 minutes
// ═══════════════════════════════════════════════════════════════

const nodemailer   = require("nodemailer");
const { createClient } = require("@supabase/supabase-js");

const GMAIL_USER   = process.env.GMAIL_USER       || "contact@wanderbreezeexim.com";
const GMAIL_PASS   = process.env.GMAIL_APP_PASSWORD;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DAILY_LIMIT  = parseInt(process.env.DAILY_EMAIL_LIMIT || "1800");

// Gmail transporter
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: GMAIL_USER, pass: GMAIL_PASS },
});

// Supabase client (server-side, service role)
function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Supabase env vars not set");
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

// ── Count emails already sent today ──────────────────────────
async function countTodaysSent(supabase) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { count } = await supabase
    .from("sc_outreach_queue")
    .select("id", { count: "exact", head: true })
    .in("status", ["sent", "delivered", "opened"])
    .gte("sent_at", startOfDay.toISOString());

  return count || 0;
}

// ── Log event to sc_outreach_events ──────────────────────────
async function logEvent(supabase, row, type, newStatus, meta = {}) {
  await supabase.from("sc_outreach_events").insert({
    queue_id:    row.id,
    campaign_id: row.campaign_id,
    lead_id:     row.lead_id,
    event_type:  type,
    old_status:  row.status,
    new_status:  newStatus,
    metadata:    meta,
  });
}

// ── Send one email ────────────────────────────────────────────
async function sendOne(row) {
  const html = (row.body || "").replace(/\n/g, "<br>");
  await transporter.sendMail({
    from:    `"Ram | Wander Breeze Exim" <${GMAIL_USER}>`,
    to:      row.to_email,
    bcc:     ["contact@wanderbreezeexim.com", "wanderbreezeexim@gmail.com"],
    subject: row.subject || "Export Inquiry – Wander Breeze Exim",
    html,
    text:    row.body || "",
  });
}

// ── /send-emails endpoint ─────────────────────────────────────
app.post("/send-emails", async (req, res) => {
  if (!GMAIL_PASS) {
    return res.status(500).json({ error: "GMAIL_APP_PASSWORD not configured" });
  }

  let supabase;
  try { supabase = getSupabase(); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  const now = new Date();

  // Check today's quota
  const sentToday = await countTodaysSent(supabase);
  const remaining = DAILY_LIMIT - sentToday;

  if (remaining <= 0) {
    console.log(`[/send-emails] Daily limit reached (${sentToday}/${DAILY_LIMIT})`);
    return res.json({ sent: 0, message: `Daily limit reached (${sentToday}/${DAILY_LIMIT})` });
  }

  // Fetch queued emails due now — cap at remaining quota
  const batchCap = Math.min(remaining, 5); // max 5 per cron run
  const { data: rows, error } = await supabase
    .from("sc_outreach_queue")
    .select("*")
    .eq("status", "queued")
    .lte("scheduled_at", now.toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(batchCap);

  if (error) {
    console.error("[/send-emails] DB error:", error.message);
    return res.status(500).json({ error: error.message });
  }

  if (!rows || rows.length === 0) {
    return res.json({ sent: 0, message: "No emails due", quota: { sentToday, remaining } });
  }

  // Random batch size: 2–4
  const batchSize = Math.floor(Math.random() * 3) + 2;
  const batch = rows.slice(0, batchSize);
  const results = [];

  for (let i = 0; i < batch.length; i++) {
    const row = batch[i];

    // Mark as sending
    await supabase.from("sc_outreach_queue").update({ status: "sending" }).eq("id", row.id);

    try {
      await sendOne(row);

      await supabase.from("sc_outreach_queue").update({
        status:  "sent",
        sent_at: new Date().toISOString(),
      }).eq("id", row.id);

      await logEvent(supabase, row, "email_sent", "sent", { via: "gmail" });

      // Update lead status to 'sent'
      if (row.lead_id) {
        await supabase
          .from("sc_outreach_leads")
          .update({ lead_status: "sent" })
          .eq("id", row.lead_id);
      }

      results.push({ id: row.id, success: true, to: row.to_email });
      console.log(`[/send-emails] ✅ Sent to ${row.to_email}`);

    } catch (err) {
      await supabase.from("sc_outreach_queue").update({ status: "failed" }).eq("id", row.id);
      await logEvent(supabase, row, "failed", "failed", { error: err.message });
      results.push({ id: row.id, success: false, to: row.to_email, error: err.message });
      console.error(`[/send-emails] ❌ Failed ${row.to_email}: ${err.message}`);
    }

    // Random gap 3–11 seconds between sends
    if (i < batch.length - 1) {
      await new Promise(r => setTimeout(r, (Math.floor(Math.random() * 8) + 3) * 1000));
    }
  }

  const sent = results.filter(r => r.success).length;
  console.log(`[/send-emails] Done: ${sent}/${batch.length} sent | Today total: ${sentToday + sent}/${DAILY_LIMIT}`);

  res.json({
    sent,
    results,
    quota: { sentToday: sentToday + sent, remaining: remaining - sent, limit: DAILY_LIMIT },
  });
});

// ── /quota endpoint — check today's usage ────────────────────
app.get("/quota", async (req, res) => {
  try {
    const supabase  = getSupabase();
    const sentToday = await countTodaysSent(supabase);
    res.json({ sentToday, limit: DAILY_LIMIT, remaining: DAILY_LIMIT - sentToday });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});