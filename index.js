import { fetchWithRetry as fetch, assertCanary } from "./src/premium.js";
import * as cheerio from "cheerio";
import fs from "fs";
import { fileURLToPath } from "url";
import { validateAndGetCompany } from "./company.js";
import { querySOLR, deleteJobsByCIF, upsertJobs, upsertCompany } from "./solr.js";
import { generateJobsMarkdown } from "./src/markdown-generator.js";
import companyConfig from "./config/company.js";

const COMPANY_CIF = companyConfig.cif;
const TIMEOUT = 15000;

let COMPANY_NAME = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function searchRandstad() {
  const jobs = [];
  const searchUrl = "https://www.randstad.ro/jobs/";
  try {
    console.log(`Searching randstad.ro: ${searchUrl}`);
    const res = await fetch(searchUrl, {
      timeout: TIMEOUT,
      headers: { "User-Agent": "job_seeker_ro_spider" }
    });
    if (!res.ok) {
      console.log(`  randstad.ro returned ${res.status} for ${searchUrl}`);
      return jobs;
    }
    const html = await res.text();
    const $ = cheerio.load(html);
    $('a[href*="/jobs/"]').each((i, el) => {
      const href = $(el).attr('href');
      const title = $(el).text().trim();
      if (!href || !title) return;
      const cleanTitle = title.replace(/\s+/g, ' ').trim();
      if (cleanTitle.length < 5) return;
      const url = href.startsWith('http') ? href : `https://www.randstad.ro${href}`;
      if (!/randstad\.ro\/locuri-de-munca\//.test(url)) return;
      if (!jobs.find(j => j.url === url)) {
        jobs.push({ url, title: cleanTitle, source: "randstad.ro" });
      }
    });
    $('article, [class*="job"], [class*="card"]').each((i, el) => {
      const link = $(el).find('a[href]').first();
      const href = link.attr('href');
      const title = link.text().trim() || $(el).find('[class*="title"], h2, h3').first().text().trim();
      if (!href || !title) return;
      const cleanTitle = title.replace(/\s+/g, ' ').trim();
      if (cleanTitle.length < 5) return;
      const url = href.startsWith('http') ? href : `https://www.randstad.ro${href}`;
      if (!/randstad\.ro\/locuri-de-munca\//.test(url)) return;
      if (!jobs.find(j => j.url === url)) {
        jobs.push({ url, title: cleanTitle, source: "randstad.ro" });
      }
    });
    console.log(`  Found ${jobs.length} jobs on randstad.ro`);
  } catch (err) {
    console.log(`  randstad.ro error: ${err.message}`);
  }
  return jobs;
}

function isKnownGoodUrl(url) {
  return url.includes('mediere.anofm.ro') || url.includes('anofm.ro') || /randstad\.ro\/locuri-de-munca\//.test(url);
}

function filterLegitimateJobs(jobs) {
  return jobs.filter(j => isKnownGoodUrl(j.url));
}

async function searchAllPortals(brand, testOnly = false) {
  console.log(`\n=== Searching job portals for "${brand}" ===\n`);
  const allJobs = [];
  // NOTE: jobRapid.ro was removed as a source: jobRapid's company page "sc-randstad-sa-1219" is actually
  // RAPEL SRL's page, so its jobs were Rapel's (and flip-flopped CIF ownership with the rapel scraper).
  const searches = [
    searchRandstad()
  ];
  const results = await Promise.allSettled(searches);
  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const job of result.value) {
        if (!allJobs.find(j => j.url === job.url)) {
          allJobs.push(job);
        }
      }
    }
  }
  console.log(`\nTotal unique jobs found across all portals: ${allJobs.length}`);
  return allJobs;
}

function extractLocationFromTitle(title) {
  if (!title) return null;
  const romanianCities = [
    'București', 'Bucharest', 'Cluj-Napoca', 'Cluj',
    'Timișoara', 'Timisoara', 'Iași', 'Iasi', 'Brașov', 'Brasov',
    'Constanța', 'Constanta', 'Craiova', 'Galați', 'Galati',
    'Ploiești', 'Ploiesti', 'Oradea', 'Brăila', 'Braila',
    'Arad', 'Pitești', 'Pitesti', 'Sibiu', 'Bacău', 'Bacau',
    'Târgu Mureș', 'Targu Mures', 'Suceava', 'Satu Mare'
  ];
  const lower = title.toLowerCase();
  for (const city of romanianCities) {
    if (lower.includes(city.toLowerCase())) {
      return city;
    }
  }
  return null;
}


const CITY_FROM_SLUG = {
  'bucuresti': 'Bucure\u0219ti', 'ploiesti': 'Ploie\u0219ti', 'cluj-napoca': 'Cluj-Napoca', 'brasov': 'Bra\u0219ov',
  'timisoara': 'Timi\u0219oara', 'iasi': 'Ia\u0219i', 'constanta': 'Constan\u021ba', 'galati': 'Gala\u021bi',
  'pitesti': 'Pite\u0219ti', 'targu-mures': 'T\u00e2rgu Mure\u0219', 'braila': 'Br\u0103ila', 'bacau': 'Bac\u0103u'
};

function extractLocationFromUrl(url) {
  const jr = (url || '').match(/-in-([a-z-]+)-\d+\.html$/);
  if (jr) { const sl = jr[1]; return CITY_FROM_SLUG[sl] || sl.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '); }
  const m = (url || '').match(/_([a-z-]+)_\d+\/?$/);
  if (!m) return null;
  const slug = m[1];
  if (CITY_FROM_SLUG[slug]) return CITY_FROM_SLUG[slug];
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('-');
}

function mapToJobModel(rawJob, cif, companyName = COMPANY_NAME) {
  const now = new Date().toISOString();
  const location = [];
  const locationFromTitle = extractLocationFromTitle(rawJob.title) || extractLocationFromUrl(rawJob.url);
  if (locationFromTitle) {
    location.push(locationFromTitle);
  }
  const job = {
    url: rawJob.url,
    title: rawJob.title,
    company: companyName,
    cif: cif,
    location: location.length ? location : undefined,
    date: now,
    status: "scraped"
  };
  Object.keys(job).forEach((k) => job[k] === undefined && delete job[k]);
  return job;
}

function transformJobsForSOLR(payload) {
  const normalizeWorkmode = (wm) => {
    if (!wm) return undefined;
    const lower = wm.toLowerCase();
    if (lower.includes('remote')) return 'remote';
    if (lower.includes('office') || lower.includes('on-site') || lower.includes('site')) return 'on-site';
    if (lower.includes('hybrid')) return 'hybrid';
    return undefined;
  };
  const transformed = {
    ...payload,
    company: payload.company?.toUpperCase(),
    jobs: payload.jobs.map(job => ({
      ...job,
      workmode: normalizeWorkmode(job.workmode) || job.workmode
    }))
  };
  return transformed;
}

export { mapToJobModel, transformJobsForSOLR, searchAllPortals };

async function main() {
  const testOnly = process.argv.includes("--test");
  try {
    fs.mkdirSync("tmp", { recursive: true });

    console.log("=== Step 1: Validate company via ANAF ===");
    const { company, cif } = await validateAndGetCompany();
    COMPANY_NAME = company;

    try {
      await upsertCompany({
        id: cif,
        company,
        brand: companyConfig.brand,
        status: "activ",
        location: [companyConfig.defaultLocation],
        website: [companyConfig.website],
        career: [companyConfig.careerUrl],
        lastScraped: new Date().toISOString().split('T')[0],
        scraperFile: companyConfig.scraperFile
      });
    } catch (err) {
      console.log(`Note: Could not upsert company to SOLR core: ${err.message}`);
    }

    console.log("\n=== Step 2: Get existing jobs from SOLR ===");
    let existingJobs = [];
    try {
      const result = await querySOLR(cif);
      existingJobs = result.docs || [];
      console.log(`Found ${existingJobs.length} existing jobs in SOLR for CIF ${cif}`);
    } catch (err) {
      console.log(`No existing jobs found or query error: ${err.message}`);
    }

    const existingBackup = {
      extractedAt: new Date().toISOString(),
      company: COMPANY_NAME,
      cif: cif,
      count: existingJobs.length,
      jobs: existingJobs
    };
    fs.writeFileSync("tmp/jobs_existing.json", JSON.stringify(existingBackup, null, 2), "utf-8");
    console.log(`Saved ${existingJobs.length} existing jobs to tmp/jobs_existing.json`);

    console.log("\n=== Step 3: Search job portals ===");
    let portalJobs = [];
    if (!testOnly) {
      portalJobs = await searchAllPortals(companyConfig.brand, testOnly);
    } else {
      console.log("Test mode: skipping portal search");
    }

    console.log(`\n=== Step 4: Process jobs ===`);
    const legitExisting = filterLegitimateJobs(existingJobs);
    console.log(`Existing jobs kept (known-good sources): ${legitExisting.length}`);

    const anofmJobs = await (async () => {
      if (testOnly) return [];
      const anofm = [];
      try {
        console.log(`Searching ANOFM by CIF: ${cif}`);
        const payload = {
          current: 1, rowCount: 250,
          sort: { created_at: "desc" },
          employer_tax_code: cif
        };
        const res = await fetch("https://mediere.anofm.ro/api/entity/vw_public_job_posting", {
          method: "POST", timeout: TIMEOUT,
          headers: { "Content-Type": "application/json", "User-Agent": "job_seeker_ro_spider" },
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          const data = await res.json();
          for (const row of data.rows || []) {
            const locParts = (row.address_locality_name || '').split('>').map(s => s.trim());
            const loc = locParts.length > 1 ? locParts[locParts.length - 1] : locParts[0];
            anofm.push({
              url: `https://mediere.anofm.ro/app/module/mediere/job/${row.id}`,
              title: row.occupation,
              location: loc ? [loc] : undefined,
              source: "ANOFM"
            });
          }
          console.log(`  Found ${anofm.length} jobs on ANOFM`);
        } else {
          console.log(`  ANOFM returned ${res.status}`);
        }
      } catch (err) {
        console.log(`  ANOFM error: ${err.message}`);
      }
      return anofm;
    })();

    const allPortalJobs = [...portalJobs, ...anofmJobs];
    const seenUrls = new Set();
    const uniquePortalJobs = [];
    for (const job of allPortalJobs) {
      if (!seenUrls.has(job.url)) {
        seenUrls.add(job.url);
        uniquePortalJobs.push(job);
      }
    }

    const updatedExisting = legitExisting.map(job => ({
      ...job,
      cif: cif,
      company: COMPANY_NAME,
      date: new Date().toISOString(),
      status: job.status || "scraped",
      location: (job.location && job.location.length) ? job.location : (extractLocationFromUrl(job.url) ? [extractLocationFromUrl(job.url)] : job.location)
    }));
    const newJobs = uniquePortalJobs.map(job => mapToJobModel(job, cif));

    // Fresh scrape first: the dedup below keeps the first copy of a URL, so re-scraped jobs must win over stale stored ones.
    const allJobs = [...newJobs, ...updatedExisting];
    const uniqueJobs = [];
    const urlSet = new Set();
    for (const job of allJobs) {
      if (!urlSet.has(job.url)) {
        urlSet.add(job.url);
        uniqueJobs.push(job);
      }
    }
    console.log(`Total jobs to upsert: ${uniqueJobs.length}`);

    const payload = {
      source: "randstad.ro",
      scrapedAt: new Date().toISOString(),
      company: COMPANY_NAME,
      cif: cif,
      jobs: uniqueJobs
    };

    const transformedPayload = transformJobsForSOLR(payload);
    fs.writeFileSync("tmp/jobs.json", JSON.stringify(transformedPayload, null, 2), "utf-8");
    console.log("Saved tmp/jobs.json");

    const companyData = {
      id: cif,
      company: transformedPayload.company,
      brand: companyConfig.brand,
      status: "activ",
      location: [companyConfig.defaultLocation],
      website: [companyConfig.website],
      career: [companyConfig.careerUrl],
      lastScraped: new Date().toISOString().split('T')[0]
    };
    const markdown = generateJobsMarkdown(companyData, transformedPayload.jobs);
    fs.mkdirSync("docs", { recursive: true });
    fs.writeFileSync("docs/jobs.md", markdown, "utf-8");
    console.log("Saved docs/jobs.md");
    fs.writeFileSync("docs/company.json", JSON.stringify(companyConfig, null, 2), "utf-8");
    console.log("Saved docs/company.json");

    console.log("\n=== Step 5: Delete old jobs by CIF ===");
    await deleteJobsByCIF(cif);

    console.log("\n=== Step 6: Upsert clean jobs to SOLR ===");
    await upsertJobs(transformedPayload.jobs);

    console.log("\n=== Step 7: Verify ===");
    const finalResult = await querySOLR(cif);
    console.log(`\n📊 === SUMMARY ===`);
    console.log(`📊 Jobs existing in SOLR before: ${existingJobs.length}`);
    console.log(`📊 Jobs found on portals: ${uniquePortalJobs.length}`);
    console.log(`📊 Jobs in SOLR after upsert: ${finalResult.numFound}`);
    console.log(`====================`);
    if (finalResult.numFound === 0 && transformedPayload.jobs.length > 0) {
      console.warn("Warning: the API returned no jobs right after the upload (indexing delay?); the upload itself succeeded.");
    }

    console.log("\n=== DONE ===");
    console.log("Scraper completed successfully!");

  } catch (err) {
    console.error("Scraper failed:", err);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
