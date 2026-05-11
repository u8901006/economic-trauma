import { writeFileSync, readFileSync, existsSync } from 'fs';
import { XMLParser } from 'fast-xml-parser';

const PUBMED_SEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const PUBMED_FETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';
const DEDUP_FILE = 'data/summarized_pmids.json';

const EXPOSURE_TERMS = [
  '"Socioeconomic Factors"[Mesh]', '"Economic Factors"[Mesh]',
  '"Economic Status"[Mesh]', '"Poverty"[Mesh]', '"Income"[Mesh]',
  '"Employment"[Mesh]', '"Housing Instability"[Mesh]',
  '"Food Insecurity"[Mesh]', '"Social Determinants of Health"[Mesh]',
  '"financial hardship"[tiab]', '"financial strain"[tiab]',
  '"financial stress"[tiab]', '"financial distress"[tiab]',
  '"economic hardship"[tiab]', '"economic stress"[tiab]',
  '"material hardship"[tiab]', 'debt[tiab]', 'indebtedness[tiab]',
  'bankruptcy[tiab]', '"medical debt"[tiab]', 'unemployment[tiab]',
  '"job loss"[tiab]', '"job insecurity"[tiab]', '"income shock"[tiab]',
  '"housing insecurity"[tiab]', '"housing instability"[tiab]',
  'eviction[tiab]', 'foreclosure[tiab]', 'homelessness[tiab]',
  '"food insecurity"[tiab]', 'hunger[tiab]', 'austerity[tiab]',
  'recession[tiab]', '"economic crisis"[tiab]',
  '"cost-of-living crisis"[tiab]', '"economic abuse"[tiab]',
  '"financial abuse"[tiab]', '"coerced debt"[tiab]',
  '"financial toxicity"[tiab]',
];

const OUTCOME_TERMS = [
  '"Stress Disorders, Post-Traumatic"[Mesh]',
  '"Stress Disorders, Traumatic"[Mesh]',
  '"Psychological Trauma"[Mesh]',
  '"Stress, Psychological"[Mesh]',
  '"Adverse Childhood Experiences"[Mesh]',
  'trauma*[tiab]', '"traumatic stress"[tiab]', 'PTSD[tiab]',
  '"complex PTSD"[tiab]', '"toxic stress"[tiab]',
  '"adverse childhood experiences"[tiab]', 'ACEs[tiab]',
  '"allostatic load"[tiab]', 'cortisol[tiab]', '"HPA axis"[tiab]',
  'inflammation[tiab]', 'depression[tiab]', 'anxiety[tiab]',
  '"psychological distress"[tiab]', '"suicidal ideation"[tiab]',
  'suicide[tiab]', 'insomnia[tiab]', '"substance use"[tiab]',
];

function buildQuery(days) {
  const now = new Date();
  const lookback = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const y = lookback.getFullYear();
  const m = String(lookback.getMonth() + 1).padStart(2, '0');
  const d = String(lookback.getDate()).padStart(2, '0');
  const dateStr = `${y}/${m}/${d}`;
  const datePart = `"${dateStr}"[Date - Publication] : "3000"[Date - Publication]`;
  const exposure = `(${EXPOSURE_TERMS.join(' OR ')})`;
  const outcomes = `(${OUTCOME_TERMS.join(' OR ')})`;
  return `${exposure} AND ${outcomes} AND ${datePart}`;
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

async function searchPapers(query, retmax = 50) {
  const params = new URLSearchParams({
    db: 'pubmed',
    term: query,
    retmax: String(retmax),
    sort: 'date',
    retmode: 'json',
  });
  try {
    const resp = await fetch(`${PUBMED_SEARCH}?${params}`, {
      headers: { 'User-Agent': 'EconomicTraumaBot/1.0 (research aggregator)' },
      signal: AbortSignal.timeout(30000),
    });
    const data = await resp.json();
    return data?.esearchresult?.idlist || [];
  } catch (e) {
    console.error(`[ERROR] PubMed search failed: ${e.message}`);
    return [];
  }
}

async function fetchDetails(pmids) {
  if (!pmids.length) return [];
  const params = new URLSearchParams({
    db: 'pubmed',
    id: pmids.join(','),
    retmode: 'xml',
  });
  let xmlData;
  try {
    const resp = await fetch(`${PUBMED_FETCH}?${params}`, {
      headers: { 'User-Agent': 'EconomicTraumaBot/1.0 (research aggregator)' },
      signal: AbortSignal.timeout(60000),
    });
    xmlData = await resp.text();
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

    papers.push({ pmid: String(pmid), title, journal, date: dateStr, abstract, url: link, keywords });
  }

  return papers;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 7, maxPapers: 50, output: 'papers.json' };
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
  console.error(`[INFO] Searching PubMed for economic trauma papers (last ${opts.days} days)...`);

  const allPmids = await searchPapers(query, opts.maxPapers);
  console.error(`[INFO] Found ${allPmids.length} PMIDs from PubMed`);

  if (!allPmids.length) {
    console.error('[INFO] No papers found');
    const tz = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
    const empty = { date: tz, count: 0, papers: [] };
    writeFileSync(opts.output, JSON.stringify(empty, null, 2), 'utf-8');
    return;
  }

  const summarized = loadSummarizedPmids();
  const newPmids = allPmids.filter(id => !summarized.has(String(id)));
  console.error(`[INFO] After dedup: ${newPmids.length} new papers (filtered ${allPmids.length - newPmids.length} already summarized)`);

  if (!newPmids.length) {
    console.error('[INFO] All papers already summarized');
    const tz = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
    const empty = { date: tz, count: 0, papers: [] };
    writeFileSync(opts.output, JSON.stringify(empty, null, 2), 'utf-8');
    return;
  }

  const papers = await fetchDetails(newPmids);
  console.error(`[INFO] Fetched details for ${papers.length} papers`);

  const tz = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const output = { date: tz, count: papers.length, papers };
  writeFileSync(opts.output, JSON.stringify(output, null, 2), 'utf-8');
  console.error(`[INFO] Saved to ${opts.output}`);
}

main().catch(e => { console.error(`[FATAL] ${e.message}`); process.exit(1); });
