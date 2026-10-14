/* PhilGeps BidOps Matcher - location-detector.js
 * Classifies an opportunity's location into one of five tiers using a
 * priority order of text sources. Depends on: constants.js (PBOM_LOCATION_STATUS)
 */

// Base place names (normalized: uppercase, N instead of Ñ, single spaces).
var NCR_BASE_NAMES = [
  "CALOOCAN",
  "LAS PINAS",
  "MAKATI",
  "MALABON",
  "MANDALUYONG",
  "MANILA",
  "MARIKINA",
  "MUNTINLUPA",
  "NAVOTAS",
  "PARANAQUE",
  "PASAY",
  "PASIG",
  "PATEROS",
  "QUEZON",
  "SAN JUAN",
  "TAGUIG",
  "VALENZUELA",
];

// Exact standalone segment aliases that are always NCR regardless of prefix/suffix.
var NCR_EXACT_ALIASES = ["METRO MANILA", "NATIONAL CAPITAL REGION", "NCR", "QUEZON CITY"];

// A modest set of well-known non-NCR provinces/cities, used to recognize a
// place name as CONFIDENTLY outside NCR. Deliberately not exhaustive — an
// unrecognized place name is AMBIGUOUS rather than assumed to be outside NCR.
var KNOWN_NON_NCR_PLACES = [
  "CEBU",
  "DAVAO",
  "ILOILO",
  "BAGUIO",
  "CAGAYAN DE ORO",
  "ZAMBOANGA",
  "BACOLOD",
  "BATANGAS",
  "CAVITE",
  "LAGUNA",
  "BULACAN",
  "PAMPANGA",
  "TARLAC",
  "PANGASINAN",
  "ISABELA",
  "NUEVA ECIJA",
  "PALAWAN",
  "LEYTE",
  "SAMAR",
  "BOHOL",
  "RIZAL",
  "MALOLOS",
  "ANTIPOLO",
  "KALINGA",
  "GENERAL SANTOS",
  "ILOCOS NORTE",
  "ILOCOS SUR",
  "ALBAY",
  "CAMARINES SUR",
  "CAMARINES NORTE",
  "SORSOGON",
  "AKLAN",
  "CAPIZ",
  "ANTIQUE",
  "NEGROS OCCIDENTAL",
  "NEGROS ORIENTAL",
  "MISAMIS ORIENTAL",
  "MISAMIS OCCIDENTAL",
  "BUKIDNON",
  "SOUTH COTABATO",
  "SULTAN KUDARAT",
  "AGUSAN",
  "SURIGAO",
  "COTABATO",
  "MAGUINDANAO",
  "BENGUET",
  "MOUNTAIN PROVINCE",
  "ILOCOS",
  "ABRA",
  "APAYAO",
  "IFUGAO",
  "QUIRINO",
  "AURORA",
  "ZAMBALES",
  "BATAAN",
  "OCCIDENTAL MINDORO",
  "ORIENTAL MINDORO",
  "MARINDUQUE",
  "ROMBLON",
  "MASBATE",
  "CATANDUANES",
  "EASTERN SAMAR",
  "NORTHERN SAMAR",
  "SIQUIJOR",
  "GUIMARAS",
  "TAWI-TAWI",
  "SULU",
  "BASILAN",
  "LANAO",
  "DAVAO DEL NORTE",
  "DAVAO DEL SUR",
  "DAVAO ORIENTAL",
  "DAVAO OCCIDENTAL",
  "COMPOSTELA VALLEY",
];

function pbomNormalizeForMatch(str) {
  return String(str)
    .toUpperCase()
    .replace(/\u00d1/g, "N")
    .replace(/\u00f1/g, "N")
    .replace(/[.]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Classifies a single normalized place name (without prefix/suffix) as
 * 'ncr' | 'outside' | 'ambiguous'.
 */
function pbomClassifyPlaceName(norm) {
  if (NCR_BASE_NAMES.includes(norm)) return "ncr";
  if (KNOWN_NON_NCR_PLACES.includes(norm)) return "outside";
  return "ambiguous";
}

/**
 * Extracts location candidates from a block of text (title, a dedicated
 * location column, or full row text). Each candidate carries a 'kind' of
 * 'ncr' | 'outside' | 'ambiguous'. Segments with no location-like shape at
 * all are not returned as candidates (avoids false positives from ordinary
 * title words).
 */
function pbomExtractLocationCandidates(text) {
  if (!text) return [];
  const segments = String(text)
    .split(/[,\n\/|]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const candidates = [];

  segments.forEach((seg) => {
    const norm = pbomNormalizeForMatch(seg);
    if (!norm) return;

    // Exact alias segment (e.g. "QUEZON CITY", "METRO MANILA", "NCR").
    if (NCR_EXACT_ALIASES.includes(norm)) {
      candidates.push({ segment: seg.trim(), kind: "ncr", matchType: "alias" });
      return;
    }

    // Prefix pattern: CITY OF X / MUNICIPALITY OF X / PROVINCE OF X
    const prefixMatch = norm.match(/^(CITY OF|MUNICIPALITY OF|PROVINCE OF)\s+(.+)$/);
    if (prefixMatch) {
      const prefixType = prefixMatch[1];
      const place = prefixMatch[2];
      // A province is never NCR, and is confidently outside — even if we
      // don't recognize the specific province name.
      const kind = prefixType === "PROVINCE OF" ? "outside" : pbomClassifyPlaceName(place);
      candidates.push({ segment: seg.trim(), kind, matchType: "prefix" });
      return;
    }

    // Suffix pattern: "<n> CITY"
    const suffixMatch = norm.match(/^(.+?)\s+CITY$/);
    if (suffixMatch) {
      const place = suffixMatch[1];
      candidates.push({ segment: seg.trim(), kind: pbomClassifyPlaceName(place), matchType: "suffix" });
      return;
    }

    // Bare recognized NCR base name standing alone as its own segment.
    if (NCR_BASE_NAMES.includes(norm)) {
      candidates.push({ segment: seg.trim(), kind: "ncr", matchType: "bare" });
      return;
    }

    // Bare recognized non-NCR place, so mixed lists (e.g. "Manila, Cebu")
    // are correctly flagged as conflicting rather than silently ignored.
    if (KNOWN_NON_NCR_PLACES.includes(norm)) {
      candidates.push({ segment: seg.trim(), kind: "outside", matchType: "bare-other" });
    }
  });

  return candidates;
}

function pbomDedupeCandidates(candidates) {
  const seen = new Set();
  const result = [];
  candidates.forEach((c) => {
    const key = pbomNormalizeForMatch(c.segment) + "|" + c.kind;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(c);
    }
  });
  return result;
}

/**
 * Aggregates a list of candidates (all from the same source) into a final
 * location status.
 */
function pbomAggregateCandidates(candidates, source) {
  if (!candidates || candidates.length === 0) {
    return { status: PBOM_LOCATION_STATUS.UNVERIFIED, detected: null, candidates: [], source: null };
  }
  const unique = pbomDedupeCandidates(candidates);
  const kinds = new Set(unique.map((c) => c.kind));
  const detected = unique.map((c) => c.segment).join(", ");

  if (kinds.size === 1) {
    if (kinds.has("ncr")) {
      return { status: PBOM_LOCATION_STATUS.VERIFIED_NCR, detected, candidates: unique, source };
    }
    if (kinds.has("outside")) {
      return { status: PBOM_LOCATION_STATUS.VERIFIED_OUTSIDE_NCR, detected, candidates: unique, source };
    }
    // all 'ambiguous'
    return { status: PBOM_LOCATION_STATUS.AMBIGUOUS, detected, candidates: unique, source };
  }

  // Mixed kinds — conflicting or uncertain, never silently resolved.
  return { status: PBOM_LOCATION_STATUS.MULTIPLE_LOCATIONS, detected, candidates: unique, source };
}

/**
 * Detects and classifies location using a priority order of sources:
 *   1. Dedicated location/area-of-delivery column (if the table has one)
 *   2. Opportunity title
 *   3. Full row text (row metadata) as a last-resort fallback
 * The first source that yields at least one candidate wins — sources are
 * never merged, so a clear signal early on isn't diluted by noise later
 * in the row.
 */
function pbomDetectLocation({ locationColumnText, title, rowText }) {
  const sources = [
    { text: locationColumnText, label: "Location Column" },
    { text: title, label: "Opportunity Title" },
    { text: rowText, label: "Opportunity Row" },
  ];

  for (const s of sources) {
    if (!s.text) continue;
    const candidates = pbomExtractLocationCandidates(s.text);
    if (candidates.length > 0) {
      return pbomAggregateCandidates(candidates, s.label);
    }
  }

  return { status: PBOM_LOCATION_STATUS.UNVERIFIED, detected: null, candidates: [], source: null };
}

function pbomVerificationMethodForSource(status, source) {
  if (status === PBOM_LOCATION_STATUS.MULTIPLE_LOCATIONS) return "conflicting_information";
  if (status === PBOM_LOCATION_STATUS.UNVERIFIED) return "unverified";
  if (source === "Opportunity Title") return "title_location";
  if (source === "Location Column") return "explicit_location";
  return "explicit_location";
}

/**
 * Explicit-location detection (pbomDetectLocation) always takes priority.
 * Government-entity recognition is only consulted as a fallback signal
 * when the explicit sources left the location inconclusive (UNVERIFIED,
 * AMBIGUOUS, or MULTIPLE_LOCATIONS) — it never overrides a confidently
 * confirmed NCR or outside-NCR result from explicit text (Part 14).
 *
 * entityFieldText should be passed in priority order of availability by
 * the caller: explicit "Procuring Entity" column first, falling back to
 * title/row text — see scanner.js's column detection and content.js.
 */
function pbomDetectLocationWithEntity({ locationColumnText, title, rowText, entityFieldText }) {
  const base = pbomDetectLocation({ locationColumnText, title, rowText });
  const verificationMethod = pbomVerificationMethodForSource(base.status, base.source);

  const inconclusive =
    base.status === PBOM_LOCATION_STATUS.UNVERIFIED ||
    base.status === PBOM_LOCATION_STATUS.AMBIGUOUS ||
    base.status === PBOM_LOCATION_STATUS.MULTIPLE_LOCATIONS;

  if (!inconclusive) {
    return { ...base, verificationMethod, governmentEntity: null, governmentEntityConfidence: null, unknownEntityRaw: null };
  }

  // Try the entity field first, then fall back to title/row text so an
  // agency name embedded in the title (e.g. "DOE - Supply of...") can still
  // be recognized even when PhilGEPS has no separate entity column.
  const entitySources = [entityFieldText, title, rowText];
  let entityResult = { status: "none" };
  for (const t of entitySources) {
    entityResult = pbomDetectGovernmentEntity(t);
    if (entityResult.status !== "none") break;
  }

  if (entityResult.status === "ncr") {
    return {
      status: PBOM_LOCATION_STATUS.VERIFIED_NCR,
      detected: (entityResult.canonicalName || "Government entity") + " (government entity)",
      candidates: base.candidates,
      source: "Government Entity Database",
      verificationMethod: "government_entity_database",
      governmentEntity: entityResult.canonicalName,
      governmentEntityConfidence: entityResult.confidence,
      unknownEntityRaw: null,
    };
  }

  if (entityResult.status === "outside") {
    return {
      status: PBOM_LOCATION_STATUS.VERIFIED_OUTSIDE_NCR,
      detected: entityResult.canonicalName || "Non-NCR government office",
      candidates: base.candidates,
      source: "Government Entity Database",
      verificationMethod: "government_entity_ncr_branch",
      governmentEntity: entityResult.canonicalName,
      governmentEntityConfidence: entityResult.confidence,
      unknownEntityRaw: null,
    };
  }

  if (entityResult.status === "uncertain") {
    return {
      ...base,
      verificationMethod,
      governmentEntity: entityResult.canonicalName,
      governmentEntityConfidence: entityResult.confidence,
      unknownEntityRaw: null,
    };
  }

  if (entityResult.status === "unknown") {
    return { ...base, verificationMethod, governmentEntity: null, governmentEntityConfidence: null, unknownEntityRaw: entityResult.rawText };
  }

  return { ...base, verificationMethod, governmentEntity: null, governmentEntityConfidence: null, unknownEntityRaw: null };
}
