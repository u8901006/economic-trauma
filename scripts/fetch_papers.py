#!/usr/bin/env python3
"""
Fetch economic trauma research papers from PubMed E-utilities API.
Uses journal+date query with keyword relevance filtering.
"""

import json
import sys
import argparse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from urllib.request import urlopen, Request
from urllib.error import URLError
from urllib.parse import quote_plus

PUBMED_SEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
PUBMED_FETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"
DEDUP_FILE = "data/summarized_pmids.json"

JOURNALS = [
    "Social Science & Medicine",
    "JAMA Psychiatry",
    "American Journal of Public Health",
    "JAMA Network Open",
    "BMJ Open",
    "PLOS ONE",
    "BMC Public Health",
    "Psychological Medicine",
    "Journal of Affective Disorders",
    "Social Psychiatry and Psychiatric Epidemiology",
    "Brain Behavior and Immunity",
    "Journal of Traumatic Stress",
    "Biological Psychiatry",
    "The Lancet",
    "JAMA",
]

KEYWORDS = [
    "financial hardship", "financial strain", "financial stress",
    "economic hardship", "economic stress", "material hardship",
    "debt", "unemployment", "job loss", "job insecurity",
    "housing instability", "food insecurity", "economic abuse",
    "financial toxicity", "poverty", "deprivation",
    "austerity", "recession", "economic crisis",
    "allostatic load", "trauma", "PTSD",
    "financial distress", "medical debt", "foreclosure",
    "homelessness", "cost-of-living", "financial burden",
    "socioeconomic", "income inequality", "social determinants",
]

HEADERS = {"User-Agent": "EconomicTraumaBot/1.0 (research aggregator)"}


def build_query(days: int = 7, max_journals: int = 10) -> str:
    journal_part = " OR ".join([f'"{j}"[Journal]' for j in JOURNALS[:max_journals]])
    lookback = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y/%m/%d")
    date_part = f'"{lookback}"[Date - Publication] : "3000"[Date - Publication]'
    return f"({journal_part}) AND {date_part}"


def load_summarized_pmids() -> set:
    try:
        with open(DEDUP_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return set(data.get("pmids", []))
    except Exception:
        return set()


def is_relevant(title: str, abstract: str, keywords_list: list) -> bool:
    text = f"{title} {abstract} {' '.join(keywords_list)}".lower()
    return any(kw.lower() in text for kw in KEYWORDS)


def search_papers(query: str, retmax: int = 60) -> list:
    params = (
        f"?db=pubmed&term={quote_plus(query)}"
        f"&retmax={retmax}&sort=date&retmode=json"
    )
    url = PUBMED_SEARCH + params
    try:
        req = Request(url, headers=HEADERS)
        with urlopen(req, timeout=30) as resp:
            body = resp.read().decode()
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            print(f"[ERROR] PubMed non-JSON response (first 300): {body[:300]}", file=sys.stderr)
            return []
        return data.get("esearchresult", {}).get("idlist", [])
    except URLError as e:
        print(f"[ERROR] PubMed URL error: {e}", file=sys.stderr)
        return []
    except Exception as e:
        print(f"[ERROR] PubMed search failed: {e}", file=sys.stderr)
        return []


def fetch_details(pmids: list) -> list:
    if not pmids:
        return []
    ids = ",".join(pmids)
    params = f"?db=pubmed&id={ids}&retmode=xml"
    url = PUBMED_FETCH + params
    try:
        req = Request(url, headers=HEADERS)
        with urlopen(req, timeout=60) as resp:
            xml_data = resp.read().decode()
    except Exception as e:
        print(f"[ERROR] PubMed fetch failed: {e}", file=sys.stderr)
        return []

    papers = []
    try:
        root = ET.fromstring(xml_data)
        for article in root.findall(".//PubmedArticle"):
            medline = article.find(".//MedlineCitation")
            art = medline.find(".//Article") if medline else None
            if art is None:
                continue

            title_el = art.find(".//ArticleTitle")
            title = (
                (title_el.text or "").strip()
                if title_el is not None and title_el.text
                else ""
            )

            abstract_parts = []
            for abs_el in art.findall(".//Abstract/AbstractText"):
                label = abs_el.get("Label", "")
                text = "".join(abs_el.itertext()).strip()
                if label and text:
                    abstract_parts.append(f"{label}: {text}")
                elif text:
                    abstract_parts.append(text)
            abstract = " ".join(abstract_parts)[:2000]

            journal_el = art.find(".//Journal/Title")
            journal = (
                (journal_el.text or "").strip()
                if journal_el is not None and journal_el.text
                else ""
            )

            pub_date = art.find(".//PubDate")
            date_str = ""
            if pub_date is not None:
                year = pub_date.findtext("Year", "")
                month = pub_date.findtext("Month", "")
                day = pub_date.findtext("Day", "")
                parts = [p for p in [year, month, day] if p]
                date_str = " ".join(parts)

            pmid_el = medline.find(".//PMID")
            pmid = pmid_el.text if pmid_el is not None else ""
            link = f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/" if pmid else ""

            keywords = []
            for kw in medline.findall(".//KeywordList/Keyword"):
                if kw.text:
                    keywords.append(kw.text.strip())

            if is_relevant(title, abstract, keywords):
                papers.append(
                    {
                        "pmid": pmid,
                        "title": title,
                        "journal": journal,
                        "date": date_str,
                        "abstract": abstract,
                        "url": link,
                        "keywords": keywords,
                    }
                )
    except ET.ParseError as e:
        print(f"[ERROR] XML parse failed: {e}", file=sys.stderr)

    return papers


def main():
    parser = argparse.ArgumentParser(description="Fetch economic trauma papers from PubMed")
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--max-papers", type=int, default=60)
    parser.add_argument("--output", default="papers.json")
    args = parser.parse_args()

    query = build_query(days=args.days)
    print(f"[INFO] Searching PubMed (last {args.days} days, top 10 journals)...", file=sys.stderr)

    pmids = search_papers(query, retmax=args.max_papers)
    print(f"[INFO] Found {len(pmids)} PMIDs from PubMed", file=sys.stderr)

    if not pmids:
        print("[INFO] No papers found", file=sys.stderr)
        tz = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump({"date": tz, "count": 0, "papers": []}, f, ensure_ascii=False, indent=2)
        return

    summarized = load_summarized_pmids()
    new_pmids = [p for p in pmids if p not in summarized]
    print(f"[INFO] After dedup: {len(new_pmids)} new papers", file=sys.stderr)

    if not new_pmids:
        print("[INFO] All papers already summarized", file=sys.stderr)
        tz = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump({"date": tz, "count": 0, "papers": []}, f, ensure_ascii=False, indent=2)
        return

    papers = fetch_details(new_pmids)
    print(f"[INFO] Fetched details, {len(papers)} relevant to economic trauma", file=sys.stderr)

    tz = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")
    output_data = {"date": tz, "count": len(papers), "papers": papers}
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(output_data, f, ensure_ascii=False, indent=2)
    print(f"[INFO] Saved to {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
