/* PhilGeps BidOps Matcher - url-utils.js
 * Pure URL helpers shared by the page pipeline, the background service
 * worker and the side panel. No DOM, no chrome.* calls.
 *
 * Safety contract: anything that becomes a clickable link or a stored
 * source URL goes through pbomSanitizeUrl first, which only ever returns a
 * plain http(s) URL (no javascript:, data:, blob:, file:, mailto:, ...).
 */

/**
 * @param {string} raw
 * @param {string} [base] - base URL used to resolve relative references
 * @returns {string|null} absolute http(s) URL without embedded credentials, or null
 */
function pbomSanitizeUrl(raw, base) {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  let u;
  try {
    u = base ? new URL(text, base) : new URL(text);
  } catch (e) {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  u.username = "";
  u.password = "";
  return u.toString();
}

var PBOM_TRACKING_PARAM_RE = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_ga|_gl|ref_src)$/i;

/**
 * Stable form of a URL for deduplication and "is this the same page" checks:
 * http(s) only, fragment dropped, tracking params dropped, remaining params
 * sorted, trailing slash dropped. Query params that carry meaning (record
 * ids, pagination) are preserved.
 * @returns {string|null}
 */
function pbomCanonicalizeUrl(raw) {
  const clean = pbomSanitizeUrl(raw);
  if (!clean) return null;
  const u = new URL(clean);
  u.hash = "";
  const keep = [];
  u.searchParams.forEach((value, key) => {
    if (!PBOM_TRACKING_PARAM_RE.test(key)) keep.push([key, value]);
  });
  keep.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  u.search = "";
  keep.forEach(([k, v]) => u.searchParams.append(k, v));
  let out = u.toString();
  if (u.pathname.length > 1 && u.pathname.endsWith("/") && !u.search) {
    out = out.replace(/\/$/, "");
  }
  return out;
}

/** Hostname without a leading "www.", or "" when the URL is unusable. */
function pbomGetDomain(raw) {
  try {
    return new URL(raw).hostname.replace(/^www\./i, "").toLowerCase();
  } catch (e) {
    return "";
  }
}

function pbomIsPhilgepsUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch (e) {
    return false;
  }
  return url.protocol === "https:" && PBOM_PHILGEPS_HOST_RE.test(url.hostname.toLowerCase());
}

/**
 * True for pages an extension is allowed to script at all. Chrome internal
 * pages, extension pages, file:, and the Chrome Web Store are never
 * scannable, whatever permissions have been granted.
 */
function pbomIsScannableUrl(raw) {
  return pbomIsPhilgepsUrl(raw);
}

/** Host match pattern ("https://host/*") used for per-site permission requests. */
function pbomOriginPattern(raw) {
  if (!pbomIsPhilgepsUrl(raw)) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.protocol + "//" + u.hostname + "/*";
  } catch (e) {
    return null;
  }
}

/** The pre-upgrade uid scheme for URL-keyed records (kept for migration). */
function pbomLegacyUrlUid(rawUrl) {
  return rawUrl ? "url:" + String(rawUrl).split("#")[0] : null;
}
