import fs from 'node:fs/promises';

const README_PATH = 'README.md';
const START = '<!--START_SECTION:credly_skills-->';
const END = '<!--END_SECTION:credly_skills-->';

function extractBadgeUrls(markdown) {
  const re = /https:\/\/www\.credly\.com\/badges\/[0-9a-fA-F-]+\/public_url/g;
  return Array.from(new Set(markdown.match(re) ?? []));
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

  if (badgeUrls.length === 0) {
    throw new Error('No Credly badge public_url links found in README.md');
  }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  const allSkills = new Set();

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
