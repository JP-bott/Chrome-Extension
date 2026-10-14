/* PhilGeps BidOps Matcher - entity-detector.js
 * Matching logic only — the data lives in governmentEntities.js. Produces
 * a confidence-tiered signal used by location-detector.js as a fallback
 * when explicit opportunity location text is missing or inconclusive.
 */

// Any of these appearing as a suffix/segment on a procuring entity name is
// treated as an explicit regional indicator and OVERRIDES the parent
// agency's default NCR classification — this is what stops "DOLE Region
// VII" from inheriting DOLE's NCR head office. Checked against ANY entity
// name, whether or not that entity has a governmentEntities.js record.
var PBOM_REGIONAL_SUFFIX_RE =
  /\b(REGION(?:AL)?\s*(?:OFFICE\s*)?(?:NO\.?\s*)?(?:[IVXLC]+|[0-9]+[A-Z]?)\b|FIELD OFFICE\s*(?:[IVXLC]+|[0-9]+[A-Z]?|NCR)?\b|PROVINCIAL OFFICE\b|REGIONAL OFFICE\b|\bCAR\b|\bCARAGA\b|\bBARMM\b|\bARMM\b)/i;

// Explicit NCR qualifiers that can follow an agency name (e.g. "DOLE-NCR",
// "DSWD FIELD OFFICE NCR") — these confirm NCR rather than override it.
var PBOM_NCR_SUFFIX_RE = /\b(NCR|NATIONAL CAPITAL REGION)\b/i;

function pbomNormalizeEntityText(text) {
  return String(text || "")
    .toUpperCase()
    .replace(/\u00d1/g, "N")
    .replace(/\u00f1/g, "N")
    .replace(/[.\u2013\u2014]/g, "-") // normalize periods/en-dash/em-dash
    .replace(/[^A-Z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pbomStripCommonSuffixes(norm) {
  return norm
    .replace(/\b(MAIN OFFICE|MAIN|CENTRAL OFFICE|HEAD OFFICE|\bCO\b)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Builds a lookup once per call — small dataset, called infrequently
 * (only when explicit location is inconclusive), so no caching complexity
 * is warranted.
 */
function pbomFindEntityRecord(normText) {
  const stripped = pbomStripCommonSuffixes(normText);
  let best = null;
  let bestLen = 0;
  PBOM_GOVERNMENT_ENTITIES.forEach((entry) => {
    const candidates = [entry.canonicalName, ...entry.aliases].map(pbomNormalizeEntityText);
    candidates.forEach((alias) => {
      const aliasStripped = pbomStripCommonSuffixes(alias);
      if (!aliasStripped) return;
      const re = new RegExp("\\b" + aliasStripped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
      if (re.test(stripped) && aliasStripped.length > bestLen) {
        best = entry;
        bestLen = aliasStripped.length;
      }
    });
  });
  return best;
}

/**
 * Detects a government-entity NCR signal from a piece of text (procuring
 * entity field, title, or row — caller decides priority order).
 *
 * Returns one of:
 *   { status: 'ncr', canonicalName, confidence: 'high', matchedVia }
 *   { status: 'outside', canonicalName, confidence: 'high', matchedVia }
 *   { status: 'uncertain', canonicalName, confidence: 'medium' }
 *   { status: 'unknown', rawText }               // no DB match at all
 *   { status: 'none' }                            // no entity-like text found
 */
function pbomDetectGovernmentEntity(text) {
  if (!text || !String(text).trim()) return { status: "none" };
  const norm = pbomNormalizeEntityText(text);

  // Regional-office protection: an explicit non-NCR regional indicator
  // always wins, regardless of what the parent agency's default is.
  const regionalMatch = norm.match(PBOM_REGIONAL_SUFFIX_RE);
  if (regionalMatch) {
    // "...FIELD OFFICE NCR" or "...NCR" alongside a regional-sounding token
    // is still NCR — only a genuinely non-NCR region token should reject.
    const isNcrQualifier = PBOM_NCR_SUFFIX_RE.test(norm) && !/REGION\s*(?:NO\.?\s*)?(?:[IVXLC]+|[0-9]+[A-Z]?)/i.test(regionalMatch[0]);
    if (!isNcrQualifier) {
      const record = pbomFindEntityRecord(norm);
      return {
        status: "outside",
        canonicalName: record ? record.canonicalName : null,
        confidence: "high",
        matchedVia: "regional_suffix",
      };
    }
  }

  if (PBOM_NCR_SUFFIX_RE.test(norm)) {
    const record = pbomFindEntityRecord(norm);
    return {
      status: "ncr",
      canonicalName: record ? record.canonicalName : null,
      confidence: "high",
      matchedVia: "ncr_suffix",
    };
  }

  const record = pbomFindEntityRecord(norm);
  if (!record) {
    // No database match. Only worth flagging as "unknown" (for the
    // diagnostics queue) if the text plausibly looks like an entity name
    // rather than an ordinary title fragment — callers pass entity-field
    // text specifically for this reason, so we don't filter further here.
    return { status: "unknown", rawText: String(text).trim() };
  }

  if (record.region === "NCR" && record.verificationLevel === "confirmed") {
    return { status: "ncr", canonicalName: record.canonicalName, confidence: "high", matchedVia: "database" };
  }

  return { status: "uncertain", canonicalName: record.canonicalName, confidence: "medium", matchedVia: "database" };
}
