/**
 * Company Data Module — ANAF + CUIScan + CUIFirma
 *
 * Strategy: 1 try demoanaf.ro → 1 try cuiscan.ro → cached data. No retries.
 * Search: 1 try demoanaf.ro → 1 try cuifirma.ro.
 */

import fetch from "node-fetch";
import { userAgent } from "./config/scraper.js";

const ANAF_API_URL = "https://demoanaf.ro/api/company/";
const ANAF_SEARCH_URL = "https://demoanaf.ro/api/search";
const CUISCAN_API_URL = "https://cuiscan.ro/api.php";
const CUISFIRMA_SEARCH_URL = "https://cuifirma.ro/api/search";
const TIMEOUT_MS = 10000;

// ============================================================================
// CUIScan — company details fallback
// ============================================================================

function mapCuiscanToAnafFormat(data) {
  return {
    cui: data.cui,
    name: data.denumire,
    address: data.adresa,
    registrationNumber: data.nrRegCom,
    phone: data.telefon || "",
    fax: data.fax || "",
    postalCode: data.codPostal,
    caenCode: data.codCaen,
    iban: data.iban || "",
    registrationState: data.stareInregistrare,
    registrationDate: data.dataInregistrare,
    fiscalAuthority: data.organFiscal,
    ownershipForm: data.formaProprietate,
    organizationForm: data.formaOrganizare,
    legalForm: data.formaJuridica,
    vatRegistered: data.platitorTVA,
    vatPeriods: (data.perioadeTVA || []).map(p => ({
      start: p.dataStart, end: p.dataEnd || null, yearStart: "", message: p.mesaj || ""
    })),
    cashBasisVat: data.tvaIncasare || false,
    cashBasisVatStart: data.dataInceputTvaInc || null,
    cashBasisVatEnd: data.dataSfarsitTvaInc || null,
    inactive: !data.activ,
    inactiveSince: data.dataInactivare || null,
    reactivatedSince: data.dataReactivare || null,
    splitVat: data.splitTVA || false,
    eFacturaRegistered: data.eFactura || false,
    headquartersAddress: data.adresaSediu ? {
      street: data.adresaSediu.strada || "",
      number: data.adresaSediu.numar || "",
      locality: data.adresaSediu.localitate || "",
      county: data.adresaSediu.judet || "",
      country: "",
      postalCode: data.adresaSediu.codPostal || ""
    } : { street: "", number: "", locality: "", county: "", country: "", postalCode: "" },
    fiscalAddress: { street: "", number: "", locality: "", county: "", country: "", postalCode: "" },
    administrators: (data.administratori || []).map(a => ({
      name: a.nume || a.name || "", role: a.rol || a.role || "administrator"
    })),
    authorizedCaenCodes: data.caenAutorizate || [],
    onrcStatus: 0,
    onrcStatusLabel: data.activ ? "Funcțiune" : "Inactiv"
  };
}

/**
 * Parse a fetch Response as JSON, throwing a clear error when the service
 * answered with something else (typically an HTML error/maintenance page while
 * the upstream is down) instead of an opaque "Unexpected token '<'" SyntaxError.
 * @param {Response} res
 * @param {string} label service name used in the error message
 */
export async function parseJsonResponse(res, label) {
  try {
    return await res.json();
  } catch {
    throw new Error(`${label} returned a non-JSON response (HTTP ${res.status}) - service likely down`);
  }
}

async function fetchFromCuiscan(cif) {
  const res = await fetch(`${CUISCAN_API_URL}?action=company&cui=${cif}`, {
    headers: { "User-Agent": userAgent },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`CUIScan API error: ${res.status}`);
  const json = await parseJsonResponse(res, "CUIScan");
  if (!json || !json.denumire) throw new Error("CUIScan returned no data");
  return mapCuiscanToAnafFormat(json);
}

// ============================================================================
// ANAF — primary source
// ============================================================================

async function fetchFromAnaf(cif) {
  const res = await fetch(`${ANAF_API_URL}${cif}`, {
    headers: { "User-Agent": userAgent },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`ANAF API error: ${res.status}`);
  const json = await parseJsonResponse(res, "ANAF");
  if (json.success === false) throw new Error(json.error?.message || "ANAF returned error");
  return json.data || null;
}

async function searchFromAnaf(brandName) {
  const res = await fetch(`${ANAF_SEARCH_URL}?q=${encodeURIComponent(brandName)}`, {
    headers: { "User-Agent": userAgent },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`ANAF search error: ${res.status}`);
  const json = await parseJsonResponse(res, "ANAF search");
  return json.data || [];
}

// ============================================================================
// CUIFirma — search fallback
// ============================================================================

async function searchFromCuifirma(brandName) {
  const res = await fetch(`${CUISFIRMA_SEARCH_URL}?q=${encodeURIComponent(brandName)}`, {
    headers: { "User-Agent": userAgent },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`CUIFirma search error: ${res.status}`);
  const json = await parseJsonResponse(res, "CUIFirma");
  return (json.results || []).map(r => ({
    cui: String(r.cui),
    name: r.name,
    statusLabel: r.is_active ? "Funcțiune" : (r.status_label || "Inactiv")
  }));
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Fetches company by CIF — ANAF first, CUIScan fallback
 */
export async function getCompanyFromANAF(cif) {
  try {
    console.log(`Fetching company data for CIF: ${cif} (demoanaf.ro)...`);
    return await fetchFromAnaf(cif);
  } catch (err) {
    console.log(`DemoANAF failed: ${err.message} — trying cuiscan.ro...`);
    return await fetchFromCuiscan(cif);
  }
}

/**
 * Fetches company with fallback to cached data
 */
export async function getCompanyFromANAFWithFallback(cif, cachedData = null) {
  try {
    return await getCompanyFromANAF(cif);
  } catch (err) {
    console.log(`\n⚠️ All company data sources unavailable: ${err.message}`);
    if (cachedData) {
      console.log("✅ Using cached company data as fallback");
      return cachedData;
    }
    throw err;
  }
}

/**
 * Searches companies by brand — ANAF first, CUIFirma fallback
 */
export async function searchCompany(brandName) {
  try {
    return await searchFromAnaf(brandName);
  } catch (err) {
    console.log(`DemoANAF search failed: ${err.message} — trying cuifirma.ro...`);
    return await searchFromCuifirma(brandName);
  }
}
