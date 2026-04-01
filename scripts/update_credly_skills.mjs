import fs from 'node:fs/promises';

const README_PATH = 'README.md';
const START = '<!--START_SECTION:credly_skills-->';
const END = '<!--END_SECTION:credly_skills-->';

function extractBadgeUrls(markdown) {
  const re = /https:\/\/www\.credly\.com\/badges\/[0-9a-fA-F-]+\/public_url/g;
  return Array.from(new Set(markdown.match(re) ?? []));
}

function getCredlySkillsPageUrl() {
  // Preferred: explicit full URL
  if (process.env.CREDLY_SKILLS_URL && process.env.CREDLY_SKILLS_URL.startsWith('http')) {
    return process.env.CREDLY_SKILLS_URL;
  }

  // Fallback: username/slug only
  const user = process.env.CREDLY_USER;
  if (user && user.length > 0) {
    return `https://www.credly.com/users/${user}/skills`;
  }

  // Repo default
  return 'https://www.credly.com/users/muhammad-junaid.370fa5c7/skills';
}

function normalizeSkill(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[-–•\s]+/, '')
    .trim();
}

function looksLikeSkill(text) {
  if (!text) return false;
  if (text.length < 2 || text.length > 60) return false;
  const lowered = text.toLowerCase();
  if (lowered === 'skills') return false;
  if (lowered === 'skill') return false;
  if (lowered.includes('issued by')) return false;
  if (lowered.includes('credly')) return false;
  // avoid very sentence-like strings
  if (/[.!?]$/.test(text)) return false;
  return /[a-zA-Z]/.test(text);
}

async function scrapeSkillsFromBadge(page, badgeUrl) {
  await page.goto(badgeUrl, { waitUntil: 'networkidle' });

  // Wait briefly for client-rendered content.
  await page.waitForTimeout(1500);

  // Try to find a section anchored by the "Skills" heading.
  const skills = await page.evaluate(() => {
    function uniq(arr) {
      return Array.from(new Set(arr));
    }

    const normalize = (s) => s.replace(/\s+/g, ' ').trim();

    // Find a node containing the heading text "Skills".
    const all = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,div,span'));
    const heading = all.find((el) => normalize(el.textContent || '') === 'Skills');

    // If we find the heading, collect short text tokens near it.
    let root = heading;
    for (let i = 0; i < 6 && root; i++) {
      // climb up a few levels to include the entire section
      if (root.parentElement) root = root.parentElement;
    }

    const scope = heading ? root : document.body;

    const tokens = Array.from(scope.querySelectorAll('a,button,span,div'))
      .map((el) => normalize(el.textContent || ''))
      .filter(Boolean);

    // Heuristic: skills usually appear as many repeated short chips.
    const short = tokens.filter((t) => t.length >= 2 && t.length <= 60);

    // Filter out obvious UI noise.
    const noise = new Set([
      'Skills',
      'Share',
      'Print',
      'Download',
      'Copy',
      'Badge',
      'Certification',
      'Certifications',
      'Issued',
      'Expires',
      'See more',
      'See less',
      'Show more',
      'Show less',
      'Verify',
    ]);

    const filtered = short
      .filter((t) => !noise.has(t))
      .filter((t) => !/^Issued\b/i.test(t))
      .filter((t) => !/^Expires\b/i.test(t))
      .filter((t) => !/\bIssued by\b/i.test(t));

    // Count frequency; skills tend to appear multiple times across badges,
    // but within a single badge we just need unique entries.
    return uniq(filtered);
  });

  // Narrow down to likely skill chips.
  const normalized = skills.map(normalizeSkill).filter(looksLikeSkill);
  return Array.from(new Set(normalized));
}

async function scrapeSkillsFromSkillsPage(page, skillsPageUrl) {
  await page.goto(skillsPageUrl, { waitUntil: 'networkidle' });

  // Give the SPA a moment to render.
  await page.waitForTimeout(2000);

  const skills = await page.evaluate(() => {
    const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim();

    const candidates = new Set();
    const elements = Array.from(document.querySelectorAll('a,button,li,span,div'));

    for (const el of elements) {
      const text = normalize(el.textContent);
      if (!text) continue;

      const href = (el.getAttribute('href') || '').toLowerCase();
      const cls = (el.getAttribute('class') || '').toLowerCase();
      const id = (el.getAttribute('id') || '').toLowerCase();

      // Bias toward elements that look skill-related.
      if (href.includes('skill') || cls.includes('skill') || id.includes('skill')) {
        candidates.add(text);
      }
    }

    // If that didn't find anything, fall back to scanning the page for many short "chip"-like tokens.
    if (candidates.size === 0) {
      for (const el of elements) {
        const text = normalize(el.textContent);
        if (!text) continue;
        if (text.length >= 2 && text.length <= 60) {
          candidates.add(text);
        }
      }
    }

    return Array.from(candidates);
  });

  const normalized = skills.map(normalizeSkill).filter(looksLikeSkill);
  return Array.from(new Set(normalized));
}

function buildSkillsBlock(skills) {
  if (skills.length === 0) {
    return `${START}\n(Unable to extract skills automatically yet.)\n${END}`;
  }

  const lines = skills.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .map((s) => `- ${s}`)
    .join('\n');

  return `${START}\n${lines}\n${END}`;
}

function replaceSection(readme, newBlock) {
  const startIdx = readme.indexOf(START);
  const endIdx = readme.indexOf(END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`Missing skills markers (${START} / ${END}) in ${README_PATH}`);
  }

  const before = readme.slice(0, startIdx);
  const after = readme.slice(endIdx + END.length);
  return `${before}${newBlock}${after}`;
}

async function main() {
  const readme = await fs.readFile(README_PATH, 'utf8');
  const badgeUrls = extractBadgeUrls(readme);

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  const allSkills = new Set();

  // 1) Preferred: scrape from the user's public skills page
  try {
    const skillsPageUrl = getCredlySkillsPageUrl();
    const skills = await scrapeSkillsFromSkillsPage(page, skillsPageUrl);
    for (const s of skills) allSkills.add(s);
  } catch (err) {
    console.error('Failed to scrape skills page:', err?.message || err);
  }

  // 2) Fallback: scrape each public badge page (requires badge links present in README)
  if (allSkills.size === 0) {
    if (badgeUrls.length === 0) {
      throw new Error('No Credly badge public_url links found in README.md and skills page scraping returned 0 skills');
    }

    for (const url of badgeUrls) {
      try {
        const skills = await scrapeSkillsFromBadge(page, url);
        for (const s of skills) allSkills.add(s);
        // be polite
        await page.waitForTimeout(500);
      } catch (err) {
        // Keep going; if we end up with 0 skills overall, we fail below.
        console.error(`Failed to scrape skills from ${url}:`, err?.message || err);
      }
    }
  }

  await browser.close();

  const skillsArr = Array.from(allSkills);
  if (skillsArr.length === 0) {
    throw new Error('Extracted 0 skills from badge pages');
  }

  const newBlock = buildSkillsBlock(skillsArr);
  const updated = replaceSection(readme, newBlock);
  await fs.writeFile(README_PATH, updated, 'utf8');
}

await main();
