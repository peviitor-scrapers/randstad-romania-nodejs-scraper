// solr.js
//
// MIGRATED: this module used to talk directly to solr.peviitor.ro with
// SOLR_AUTH Basic Auth. It now goes through https://api.peviitor.ro/v1,
// exactly like the rest of Mihai's fleet (Brewtality-3-16's scraper/api.js).
// No credentials required, no dependency on anyone else's secret.
//
// Exported function names are kept IDENTICAL to the old module
// (querySOLR, upsertCompany, upsertJobs, deleteJobByUrl, deleteJobsByCIF)
// so index.js, company.js, validate-jobs.js and the tests need no changes
// to their imports.

import fetch from "node-fetch";
import { isDryRun } from "./src/premium.js";

const API_BASE_URL = "https://api.peviitor.ro/v1";
const TIMEOUT = 10000;
const userAgent = "randstad-romania-nodejs-scraper";

// Retry policy for transient API failures (network errors, 429, 5xx).
const IS_TEST = Boolean(process.env.JEST_WORKER_ID);
const MAX_RETRIES = IS_TEST ? 2 : 4;
const BASE_DELAY_MS = IS_TEST ? 2 : 2000;
const MAX_DELAY_MS = IS_TEST ? 10 : 60000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// Peviitor API requirement: CIFs are zero-padded to 8 digits.
function padCif(cif) {
  return String(cif).padStart(8, "0");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function backoffDelayMs(attempt, retryAfter) {
  const secs = Number(retryAfter);
  if (Number.isFinite(secs) && secs >= 0) {
    return Math.min(secs * 1000, MAX_DELAY_MS);
  }
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.random() * ceiling;
}

async function fetchWithRetry(url, options = {}, label = "request") {
  let lastErr;
  let retryAfter = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = backoffDelayMs(attempt - 1, retryAfter);
      console.log(`  ${label}: retry ${attempt}/${MAX_RETRIES} after ${Math.round(delay)}ms (${lastErr?.message})`);
      await sleep(delay);
    }

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT), ...options });

      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
        retryAfter = typeof res.headers?.get === "function" ? res.headers.get("retry-after") : null;
        lastErr = new Error(`${label}: HTTP ${res.status}`);
        continue;
      }

      return res;
    } catch (err) {
      retryAfter = null;
      lastErr = err;
    }
  }

  throw lastErr;
}

// --- Company core --------------------------------------------------------

export async function getCompanyByCif(cif) {
  const url = `${API_BASE_URL}/firme/company/?cif=${encodeURIComponent(padCif(cif))}`;
  const res = await fetch(url, { headers: { "User-Agent": userAgent } });

  if (!res.ok) {
    throw new Error(`API company search error: ${res.status}`);
  }

  const data = await res.json();
  if (!data.success) {
    throw new Error(`API company search failed: ${JSON.stringify(data)}`);
  }

  return data.data?.[0] || null;
}

export async function upsertCompany(companyDoc) {
  if (isDryRun()) { console.log('[dry-run] upsertCompany skipped'); return; }
  const url = `${API_BASE_URL}/firme/company/add/`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "User-Agent": userAgent },
    body: JSON.stringify({ ...companyDoc, id: padCif(companyDoc.id) }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API company upsert error: ${res.status} - ${text}`);
  }

  const data = await res.json();
  if (!data.success) {
    throw new Error(`API company upsert failed: ${JSON.stringify(data)}`);
  }

  console.log(`✅ Company "${companyDoc.company}" upserted via API.`);
}

// --- Jobs -----------------------------------------------------------------

export async function querySOLR(cif) {
  const url = `${API_BASE_URL}/scraper/jobs/?cif=${encodeURIComponent(padCif(cif))}&rows=500`;
  const res = await fetchWithRetry(url, { headers: { "User-Agent": userAgent } }, "jobs query");

  // api.peviitor.ro answers 404 {"error":"No jobs for CIF ..."} when the company has no jobs indexed yet:
  // that is an empty result, not a failure (the delete helpers below already treat 404 the same way).
  if (res.status === 404) {
    return { numFound: 0, docs: [] };
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API jobs query error: ${res.status} - ${text}`);
  }

  const data = await res.json();
  return { numFound: data.total ?? 0, docs: data.data ?? [] };
}

export async function upsertJobs(jobs) {
  if (isDryRun()) { console.log('[dry-run] upsertJobs skipped'); return; }
  // api.peviitor.ro answers 400 to an empty array; nothing to write means nothing to send.
  if (!Array.isArray(jobs) || jobs.length === 0) { console.log('No jobs to upsert - skipping upload.'); return { count: 0 }; }
  const url = `${API_BASE_URL}/scraper/jobs/upload/`;
  const paddedJobs = jobs.map(({ _version_, ...job }) => ({ ...job, cif: padCif(job.cif) }));

  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": userAgent },
    body: JSON.stringify(paddedJobs),
  }, "jobs upload");

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API jobs upload error: ${res.status} - ${text}`);
  }

  const data = await res.json();
  console.log(`✅ Upserted ${data.count ?? jobs.length} jobs via API.`);
  return data;
}

// --- Delete -----------------------------------------------------------------

export async function deleteJobsByCIF(cif) {
  if (isDryRun()) { console.log('[dry-run] deleteJobsByCIF skipped'); return; }
  const url = `${API_BASE_URL}/scraper/jobs/delete/`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", "User-Agent": userAgent },
    body: JSON.stringify({ cif: padCif(cif) }),
  });

  if (res.status === 404) {
    console.log(`⚠️ No jobs found for CIF ${cif} — nothing to delete.`);
    return { count: 0 };
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API jobs delete error: ${res.status} - ${text}`);
  }

  const data = await res.json();
  console.log(`✅ Deleted ${data.count ?? 0} jobs for CIF ${cif} via API.`);
  return data;
}

export async function deleteJobByUrl(url) {
  if (isDryRun()) { console.log('[dry-run] deleteJobByUrl skipped'); return; }
  const apiUrl = `${API_BASE_URL}/scraper/jobs/delete/`;
  const res = await fetch(apiUrl, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", "User-Agent": userAgent },
    body: JSON.stringify({ url }),
  });

  if (res.status === 404) {
    return { count: 0 };
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API jobs delete error: ${res.status} - ${text}`);
  }

  return res.json().catch(() => ({}));
}

// --- URL validation / verification (kept for parity with the old CLI) -----

async function checkUrl(url) {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(TIMEOUT),
      headers: { "User-Agent": userAgent },
    });
    return { url, status: res.status, valid: res.ok };
  } catch (err) {
    return { url, status: 0, valid: false, error: err.message };
  }
}

export async function runVerification(cif) {
  console.log("=== Verify jobs via API ===\n");

  const result = await querySOLR(cif);
  console.log(`Total jobs for CIF ${cif}: ${result.numFound}`);

  console.log("\nFirst 5 jobs:");
  result.docs.slice(0, 5).forEach((job, i) => {
    console.log(`${i + 1}. ${job.title} (${job.location?.join(", ")}) - ${job.workmode}`);
  });

  const invalidUrls = [];
  for (let i = 0; i < result.docs.length; i++) {
    const job = result.docs[i];
    const res = await checkUrl(job.url);
    console.log(`[${i + 1}/${result.docs.length}] ${res.status > 0 ? res.status : "ERR"} - ${job.url}`);
    if (!res.valid) invalidUrls.push(job.url);
  }

  if (invalidUrls.length > 0) {
    console.log(`\n⚠️ ${invalidUrls.length} invalid URLs found - deleting via API...`);
    for (const url of invalidUrls) {
      await deleteJobByUrl(url);
    }
    console.log(`✅ Deleted ${invalidUrls.length} invalid jobs via API`);
  } else {
    console.log("\n✅ All URLs valid");
  }
}

// --- Standalone mode --------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("solr.js")) {
  const args = process.argv.slice(2);

  (async () => {
    try {
      if (args[0] === "extract" && args[1]) {
        const result = await querySOLR(args[1]);
        console.log(JSON.stringify(result, null, 2));
      } else if (args[0] === "company" && args[1]) {
        const result = await getCompanyByCif(args[1]);
        console.log(JSON.stringify(result, null, 2));
      } else if (args[0]) {
        await runVerification(args[0]);
      } else {
        console.error("Usage: node solr.js <CIF> | node solr.js extract <CIF> | node solr.js company <CIF>");
      }
    } catch (err) {
      console.error(err);
      process.exitCode = 1;
    }
  })();
}
