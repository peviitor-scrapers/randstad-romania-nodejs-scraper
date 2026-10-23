import { jest } from '@jest/globals';
import fetch from 'node-fetch';

const API_BASE = 'https://api.peviitor.ro/v1';

// demoanaf.ro's free API tier was sunset 2026-08-21 (permanent HTTP 402 on
// every /api/* call). anaf.js already falls back to cuiscan.ro/cuifirma.ro
// when demoanaf.ro fails, so "is ANAF available" must reflect that fallback
// chain — probing demoanaf.ro alone would leave these tests pending forever.
async function checkAnafAvailability() {
  try {
    const [demoanaf, cuifirma] = await Promise.allSettled([
      fetch('https://demoanaf.ro/api/search?q=test', { method: 'HEAD', signal: AbortSignal.timeout(5000) }),
      fetch('https://cuifirma.ro/api/search?q=test', { signal: AbortSignal.timeout(5000) }),
    ]);
    return (demoanaf.status === 'fulfilled' && demoanaf.value.ok) ||
           (cuifirma.status === 'fulfilled' && cuifirma.value.ok);
  } catch {
    return false;
  }
}

import companyConfig from '../../scraper/config/company.js';

// The template ships {{PLACEHOLDER}} config — the live API/ANAF checks only make
// sense once a real company has been filled in.
const CONFIGURED = !JSON.stringify(companyConfig).includes('{{');

const COMPANY_CIF = companyConfig.id;
const COMPANY_BRAND = companyConfig.brand;
const COMPANY_NAME = companyConfig.company;

// Jobs are stored with a zero-padded 8-digit CIF (Peviitor API requirement),
// while the company config / company core keep the real CIF. Compare loosely.
const cifMatches = (value) => String(value).replace(/^0+/, '') === COMPANY_CIF.replace(/^0+/, '');

// ANAF returns the official legal name with Romanian diacritics (e.g. "...
// ROMÂNIA..."), which may not match company.json's spelling if that field is
// also used as a live SOLR search key elsewhere (docs/index.html job lookups,
// company.js's peviitor reconciliation) against already-indexed records with
// the ASCII spelling. Compare diacritic-insensitively so a real ANAF/internal
// naming difference doesn't masquerade as a broken test — found in production
// on hochland-romania-nodejs-scraper (2026-09-25).
const stripDiacritics = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
const namesMatch = (a, b) => stripDiacritics(a).toUpperCase() === stripDiacritics(b).toUpperCase();

async function checkApiAvailability() {
  try {
    const res = await fetch(`${API_BASE}/scraper/jobs/?cif=${COMPANY_CIF}&rows=1`, {
      signal: AbortSignal.timeout(5000)
    });
    return res.ok || res.status === 400;
  } catch {
    return false;
  }
}

// NOTE: top-level await, resolved BEFORE the describe()/it() calls below are
// registered. Jest builds its whole test tree synchronously on file load, so
// a `beforeAll`-based check here would only ever be read by itIfApi/itIfAnaf
// AFTER they already decided (at their default `false`) whether to skip —
// permanently pending every gated test regardless of actual availability.
let HAS_API = false;
let HAS_ANAF = false;
if (CONFIGURED) {
  [HAS_API, HAS_ANAF] = await Promise.all([checkApiAvailability(), checkAnafAvailability()]);
}

function itIfApi(name, fn, timeout) {
  if (CONFIGURED && HAS_API) return it(name, fn, timeout);
  return it.skip(`${name} (skipped: ${CONFIGURED ? 'API unavailable' : 'company not configured'})`, fn, timeout);
}

// ANAF / CUIScan / CUIFirma are third-party services outside our control. When one of
// them is down (HTTP 5xx, an HTML maintenance page, a timeout) the live check says
// nothing about the scraper, so it must not fail the build - and send a "Run failed"
// email every day. Real assertion failures still fail.
const UPSTREAM_OUTAGE = /non-JSON response|API error: \d{3}|search error: \d{3}|returned no data|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|aborted due to timeout|TimeoutError|All company data sources unavailable/i;

async function tolerateOutage(fn) {
  try {
    await fn();
  } catch (err) {
    if (UPSTREAM_OUTAGE.test(String((err && err.message) || err))) {
      console.warn(`Upstream ANAF/CUIScan outage - not a scraper problem, skipping assertions: ${err.message}`);
      return;
    }
    throw err;
  }
}

function itIfAnaf(name, fn, timeout) {
  if (CONFIGURED && HAS_ANAF) return it(name, () => tolerateOutage(fn), timeout);
  return it.skip(`${name} (skipped: ${CONFIGURED ? 'ANAF unavailable' : 'company not configured'})`, fn, timeout);
}

describe('Integration: API Workflow', () => {

  describe('ANAF API', () => {
    let anaf;

    beforeAll(async () => {
      anaf = await import('../../scraper/anaf.js');
    });

    itIfAnaf('should search for company brand and find the company', async () => {
      const results = await anaf.searchCompany(COMPANY_BRAND);

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);

      const company = results.find(c =>
        c.cui.toString() === COMPANY_CIF && c.statusLabel === 'Funcțiune'
      );
      expect(company).toBeDefined();
      expect(company.cui.toString()).toBe(COMPANY_CIF);
    }, 15000);

    itIfAnaf('should return empty array for non-existent brand', async () => {
      const results = await anaf.searchCompany('ThisBrandDoesNotExistXYZ123');

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(0);
    }, 15000);

    itIfAnaf('should fetch company details by valid CIF', async () => {
      const data = await anaf.getCompanyFromANAF(COMPANY_CIF);

      expect(data).toBeDefined();
      expect(namesMatch(data.name, COMPANY_NAME)).toBe(true);
      expect(data).toHaveProperty('address');
      expect(data).toHaveProperty('registrationNumber');
      expect(data).toHaveProperty('caenCode');
      expect(data).toHaveProperty('inactive', false);
      expect(data).toHaveProperty('onrcStatusLabel', 'Funcțiune');
    }, 15000);

    itIfAnaf('should throw for invalid CIF', async () => {
      await expect(anaf.getCompanyFromANAF('00000000')).rejects.toThrow();
    }, 60000);

    itIfAnaf('should use cached data when API fails (getCompanyFromANAFWithFallback)', async () => {
      const cached = { cui: parseInt(COMPANY_CIF, 10), name: COMPANY_NAME };

      const data = await anaf.getCompanyFromANAFWithFallback(COMPANY_CIF, cached);

      expect(data).toBeDefined();
      expect(data.cui).toBe(parseInt(COMPANY_CIF, 10));
    }, 15000);
  });

  describe('Peviitor API', () => {
    itIfApi('should return company data from Peviitor API', async () => {
      const api = await import('../../scraper/api.js');
      const company = await api.getCompanyByCif(COMPANY_CIF);
      expect(company).toBeTruthy();
      // peViitor's own API returns the CIF zero-padded to 8 digits (SOLR
      // requirement, see scraper/api.js padCif()); company.json stores it
      // unpadded, so compare with the existing cifMatches() normalizer.
      expect(cifMatches(company.id)).toBe(true);
    }, 15000);
  });

  describe('API Company Core', () => {
    let api;

    beforeAll(async () => {
      api = await import('../../scraper/api.js');
    });

    itIfApi('should query company core by CIF', async () => {
      const result = await api.getCompanyByCif(COMPANY_CIF);

      expect(result).not.toBeNull();
      expect(cifMatches(result.id)).toBe(true);
      expect(result.company).toBe(COMPANY_NAME);
      expect(result.status).toBe('activ');
      expect(Array.isArray(result.location)).toBe(true);
      expect(result.lastScraped).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }, 15000);

    itIfApi('should have required company model fields', async () => {
      const result = await api.getCompanyByCif(COMPANY_CIF);

      expect(result).toHaveProperty('id');
      expect(cifMatches(result.id)).toBe(true);
      expect(result).toHaveProperty('company');
      expect(result).toHaveProperty('status');
      expect(['activ', 'suspendat', 'inactiv', 'radiat']).toContain(result.status);
      expect(result).toHaveProperty('location');
      expect(Array.isArray(result.location)).toBe(true);
      // website/career are maintained by whichever scraper "owns" the company
      // core record. Assert only if present.
      if (result.website !== undefined) {
        expect(Array.isArray(result.website)).toBe(true);
        expect(result.website[0]).toMatch(/^https?:\/\/.+/);
      }
      if (result.career !== undefined) {
        expect(Array.isArray(result.career)).toBe(true);
        expect(result.career[0]).toMatch(/^https?:\/\/.+/);
      }
      expect(result).toHaveProperty('lastScraped');
    }, 15000);

    itIfApi('should have optional field (group) if present', async () => {
      const result = await api.getCompanyByCif(COMPANY_CIF);

      if (result.group !== undefined) {
        expect(typeof result.group).toBe('string');
      }
    }, 15000);
  });

  describe('API Jobs Core', () => {
    let api;

    beforeAll(async () => {
      api = await import('../../scraper/api.js');
    });

    itIfApi('should query jobs by CIF and return valid data', async () => {
      const result = await api.querySOLR(COMPANY_CIF);

      if (result.numFound === 0) {
        console.log('⚠️ No jobs in API — skipping job field assertions (scraper may not have run yet)');
        return;
      }

      expect(result.numFound).toBeGreaterThan(0);
      expect(Array.isArray(result.docs)).toBe(true);

      const job = result.docs[0];
      expect(job).toHaveProperty('url');
      expect(job).toHaveProperty('title');
      expect(job).toHaveProperty('company', COMPANY_NAME);
      expect(cifMatches(job.cif)).toBe(true);
      expect(job).toHaveProperty('status');
      expect(job).toHaveProperty('location');
    }, 15000);

    itIfApi('should not have duplicate URLs for same CIF', async () => {
      const result = await api.querySOLR(COMPANY_CIF);

      const urls = result.docs.map(j => j.url);
      const uniqueUrls = new Set(urls);
      expect(uniqueUrls.size).toBe(result.docs.length);
    }, 15000);

    itIfApi('should have valid status values for all jobs', async () => {
      const validStatuses = ['scraped', 'tested', 'verified', 'published'];
      const result = await api.querySOLR(COMPANY_CIF);

      for (const job of result.docs) {
        expect(validStatuses).toContain(job.status);
      }
    }, 15000);

    itIfApi('should have valid CIF format for all jobs', async () => {
      const result = await api.querySOLR(COMPANY_CIF);

      for (const job of result.docs) {
        expect(job.cif).toMatch(/^\d{6,9}$/);
      }
    }, 15000);
  });

  describe('Full Validation Workflow', () => {
    let anaf;
    let companyModule;
    let api;

    beforeAll(async () => {
      anaf = await import('../../scraper/anaf.js');
      companyModule = await import('../../scraper/company.js');
      api = await import('../../scraper/api.js');
    });

    itIfAnaf('should complete the ANAF → Peviitor validation path', async () => {
      const searchResults = await anaf.searchCompany(COMPANY_BRAND);
      expect(searchResults.length).toBeGreaterThan(0);

      const matchedCompany = searchResults.find(c =>
        c.cui.toString() === COMPANY_CIF && c.statusLabel === 'Funcțiune'
      );
      expect(matchedCompany).toBeDefined();

      const anafData = await anaf.getCompanyFromANAF(matchedCompany.cui.toString());
      expect(namesMatch(anafData.name, COMPANY_NAME)).toBe(true);
      expect(anafData.inactive).toBe(false);
    }, 30000);

    itIfApi('should have matching CIF in company core', async () => {
      const companyResult = await companyModule.validateAndGetCompany();

      const companyData = await api.getCompanyByCif(COMPANY_CIF);
      expect(companyData).not.toBeNull();
      expect(cifMatches(companyData.id)).toBe(true);
      expect(companyData.company).toBe(COMPANY_NAME);
    }, 30000);

    itIfApi('should validate company and query API for existing jobs', async () => {
      const companyResult = await companyModule.validateAndGetCompany();

      expect(companyResult.status).toBe('active');
      expect(companyResult.company).toBe(COMPANY_NAME);
      expect(companyResult.cif).toBe(COMPANY_CIF);

      if (companyResult.existingJobsCount === 0) {
        console.log('⚠️ No jobs in API — skipping job count assertion (scraper may not have run yet)');
        return;
      }
      expect(companyResult.existingJobsCount).toBeGreaterThan(0);
    }, 30000);
  });
});
