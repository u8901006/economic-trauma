import { writeFileSync, readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { XMLParser } from 'fast-xml-parser';

const PUBMED_SEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const PUBMED_FETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';
const DEDUP_FILE = 'data/summarized_pmids.json';

const JOURNALS = [
  'Social Science & Medicine',
  'JAMA Psychiatry',
  'American Journal of Public Health',
  'JAMA Network Open',
  'BMJ Open',
  'PLOS ONE',
  'BMC Public Health',
  'Psychological Medicine',
  'Journal of Affective Disorders',
  'Social Psychiatry and Psychiatric Epidemiology',
  'Brain Behavior and Immunity',
  'Journal of Traumatic Stress',
  'Biological Psychiatry',
  'The Lancet',
  'JAMA',
];

const KEYWORDS = [
  'financial hardship', 'financial strain', 'financial stress',
  'economic hardship', 'economic stress', 'material hardship',
  'debt', 'unemployment', 'job loss', 'job insecurity',
  'housing instability', 'food insecurity', 'economic abuse',
  'financial toxicity', 'poverty', 'deprivation',
  'austerity', 'recession', 'economic crisis',
  'allostatic load', 'trauma', 'PTSD',
];

function buildQuery(days, maxJournals = 10) {
  const journalPart = JOURNALS.slice(0, maxJournals)
    .map(j => `"${j}"[Journal]`)
    .join(' OR ');
  const now = new Date();
  const lookback = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const dateStr = `${lookback.getFullYear()}/${String(lookback.getMonth() + 1).padStart(2, '0')}/${String(lookback.getDate()).padStart(2, '0')}`;
  const datePart = `"${dateStr}"[Date - Publication] : "3000"[Date - Publication]`;
  return `(${journalPart}) AND ${datePart}`;
}

function loadSummarizedPmids() {
  if (!existsSync(DEDUP_FILE)) return new Set();
  try {
    const raw = readFileSync(DEDUP_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return new Set(data.pmids || []);
  } catch {
    return new Set();
  }
}

function curlGet(urlStr, timeoutMs = 30000) {
  const safeUrl = urlStr.replace(/"/g, '\\"');
  return execSync(
    `curl -sS --max-time ${Math.floor(timeoutMs / 1000)} -A "EconomicTraumaBot/1.0" "${safeUrl}"`,
    { encoding: 'utf-8', timeout: timeoutMs + 5000, maxBuffer: 10 * 1024 * 1024 },
  );
}

async function searchPapers(query, retmax = 50) {
  const params = new URLSearchParams({
    db: 'pubmed', term: query, retmax: String(retmax),
    sort: 'date', retmode: 'json',
  });
  try {
    const text = curlGet(`${PUBMED_SEARCH}?${params.toString()}`, 30000);
    try {
      const data = JSON.parse(text);
      return data?.esearchresult?.idlist || [];
    } catch {
      console.error(`[ERROR] PubMed non-JSON (first 300): ${text.slice(0, 300)}`);
      return [];
    }
  } catch (e) {
    console.error(`[ERROR] PubMed search failed: ${e.message}`);
    return [];
  }
}

async function fetchDetails(pmids) {
  if (!pmids.length) return [];
  const params = new URLSearchParams({
    db: 'pubmed', id: pmids.join(','), retmode: 'xml',
  });
  let xmlData;
  try {
    xmlData = curlGet(`${PUBMED_FETCH}?${params.toString()}`, 60000);
  } catch (e) {
    console.error(`[ERROR] PubMed fetch failed: ${e.message}`);
    return [];
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    isArray: (name) => ['PubmedArticle', 'AbstractText', 'Keyword'].includes(name),
  });

  let parsed;
  try {
    parsed = parser.parse(xmlData);
  } catch (e) {
    console.error(`[ERROR] XML parse failed: ${e.message}`);
    return [];
  }

  const articles = parsed?.PubmedArticleSet?.PubmedArticle || [];
  const papers = [];

  for (const article of articles) {
    const medline = article?.MedlineCitation;
    const art = medline?.Article;
    if (!art) continue;

    const titleEl = art?.ArticleTitle;
    const title = typeof titleEl === 'string' ? titleEl.trim() :
      (titleEl?.['#text'] || titleEl?.span?.['#text'] || '').trim();

    const abstractParts = [];
    const abstractTexts = art?.Abstract?.AbstractText || [];
    for (const absEl of abstractTexts) {
      const label = absEl?.['@_Label'] || '';
      const text = typeof absEl === 'string' ? absEl.trim() :
        (absEl?.['#text'] || '').trim();
      if (label && text) abstractParts.push(`${label}: ${text}`);
      else if (text) abstractParts.push(text);
    }
    const abstract = abstractParts.join(' ').slice(0, 2000);

    const journal = (art?.Journal?.Title || '').trim();

    const pubDate = art?.Journal?.JournalIssue?.PubDate;
    const dateParts = [
      pubDate?.Year || '', pubDate?.Month || '', pubDate?.Day || '',
    ].filter(Boolean);
    const dateStr = dateParts.join(' ');

    const pmid = medline?.PMID?.['#text'] || medline?.PMID || '';
    const link = pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : '';

    const keywords = [];
    const kwList = medline?.KeywordList?.Keyword || [];
    for (const kw of (Array.isArray(kwList) ? kwList : [kwList])) {
      const t = typeof kw === 'string' ? kw : kw?.['#text'];
      if (t) keywords.push(t.trim());
    }

    const textContent = `${title} ${abstract} ${keywords.join(' ')}`.toLowerCase();
    const isRelevant = KEYWORDS.some(kw => textContent.includes(kw.toLowerCase()));

    if (isRelevant) {
      papers.push({ pmid: String(pmid), title, journal, date: dateStr, abstract, url: link, keywords });
    }
  }

  return papers;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 7, maxPapers: 60, output: 'papers.json' };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--days': opts.days = parseInt(args[++i], 10); break;
      case '--max-papers': opts.maxPapers = parseInt(args[++i], 10); break;
      case '--output': opts.output = args[++i]; break;
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs();
  const query = buildQuery(opts.days);
  console.error(`[INFO] Searching PubMed (last ${opts.days} days, top 10 journals)...`);

  const allPmids = await searchPapers(query, opts.maxPapers);
  console.error(`[INFO] Found ${allPmids.length} PMIDs from PubMed`);

  if (!allPmids.length) {
    console.error('[INFO] No papers found');
    const tz = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
    writeFileSync(opts.output, JSON.stringify({ date: tz, count: 0, papers: [] }, null, 2), 'utf-8');
    return;
  }

  const summarized = loadSummarizedPmids();
  const newPmids = allPmids.filter(id => !summarized.has(String(id)));
  console.error(`[INFO] After dedup: ${newPmids.length} new papers`);

  if (!newPmids.length) {
    console.error('[INFO] All papers already summarized');
    const tz = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
    writeFileSync(opts.output, JSON.stringify({ date: tz, count: 0, papers: [] }, null, 2), 'utf-8');
    return;
  }

  const papers = await fetchDetails(newPmids);
  console.error(`[INFO] Fetched details, ${papers.length} relevant to economic trauma`);

  const tz = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  writeFileSync(opts.output, JSON.stringify({ date: tz, count: papers.length, papers }, null, 2), 'utf-8');
  console.error(`[INFO] Saved to ${opts.output}`);
}

main().catch(e => { console.error(`[FATAL] ${e.message}`); process.exit(1); });
