/* PhilGeps BidOps Matcher - qualifier.js
 * Pure decision logic — no DOM access — so it can run identically inside
 * the content-script pipeline and inside the background service worker
 * (which recomputes qualification fresh on every popup open, since the
 * date window shifts with time even when nothing on the page changes).
 * Depends on: constants.js (PBOM_QUALIFICATION, PBOM_LOCATION_STATUS, PBOM_DATE_STATUS, PBOM_PROCUREMENT_STATUS)
 */

/**
 * @param {Object} input
 * @param {boolean} input.keywordOk - matchedCount >= configured minimum
 * @param {string} input.locationStatus - one of PBOM_LOCATION_STATUS
 * @param {string} input.dateStatus - one of PBOM_DATE_STATUS
 * @param {string} [input.procurementStatus] - one of PBOM_PROCUREMENT_STATUS
 * @returns {{ qualification: string, reason: string }}
 */
function pbomQualify({ keywordOk, locationStatus, dateStatus, procurementStatus }) {
  const qualStatus = typeof PBOM_QUALIFICATION !== "undefined"
    ? PBOM_QUALIFICATION
    : { QUALIFIED: "QUALIFIED", OPTIONAL_PASSED: "OPTIONAL_PASSED", POTENTIAL_MATCH: "POTENTIAL_MATCH", NEEDS_VERIFICATION: "NEEDS_VERIFICATION", REJECTED: "REJECTED" };

  const locStatus = typeof PBOM_LOCATION_STATUS !== "undefined"
    ? PBOM_LOCATION_STATUS
    : { VERIFIED_NCR: "VERIFIED_NCR", VERIFIED_OUTSIDE_NCR: "VERIFIED_OUTSIDE_NCR", UNVERIFIED: "UNVERIFIED", AMBIGUOUS: "AMBIGUOUS", MULTIPLE_LOCATIONS: "MULTIPLE_LOCATIONS" };

  const dStatus = typeof PBOM_DATE_STATUS !== "undefined"
    ? PBOM_DATE_STATUS
    : { WITHIN_WINDOW: "WITHIN_WINDOW", EXPIRED: "EXPIRED", BEYOND_WINDOW: "BEYOND_WINDOW", INVALID: "INVALID" };

  const procStatus = typeof PBOM_PROCUREMENT_STATUS !== "undefined"
    ? PBOM_PROCUREMENT_STATUS
    : { ACTIVE: "ACTIVE", UPCOMING: "UPCOMING", CLOSED: "CLOSED", AWARDED: "AWARDED", CANCELLED: "CANCELLED", BULLETIN: "BULLETIN", APP: "APP", GENERAL: "GENERAL", UNVERIFIED: "STATUS UNVERIFIED" };

  if (!keywordOk) {
    return { qualification: qualStatus.REJECTED, reason: "No qualifying keyword match." };
  }

  // Procurement Status Distinction (Section 2C & Section 5):
  // Do not treat every page mentioning a keyword as an active bid.
  if (procurementStatus === procStatus.CANCELLED) {
    return { qualification: qualStatus.NEEDS_VERIFICATION, reason: "Procurement is cancelled or declared failure." };
  }

  if (procurementStatus === procStatus.AWARDED) {
    return { qualification: qualStatus.POTENTIAL_MATCH, reason: "Notice of Award / Awarded Contract." };
  }

  if (procurementStatus === procStatus.APP) {
    return { qualification: qualStatus.POTENTIAL_MATCH, reason: "Annual Procurement Plan / Project Plan." };
  }

  if (procurementStatus === procStatus.BULLETIN) {
    return { qualification: qualStatus.POTENTIAL_MATCH, reason: "Bid Bulletin or Amendment." };
  }

  if (procurementStatus === procStatus.UPCOMING) {
    return { qualification: qualStatus.POTENTIAL_MATCH, reason: "Upcoming Procurement / Advance Notice." };
  }

  if (dateStatus === dStatus.EXPIRED || procurementStatus === procStatus.CLOSED) {
    return { qualification: qualStatus.REJECTED, reason: "Closing date has passed or bid is closed." };
  }

  if (dateStatus === dStatus.BEYOND_WINDOW) {
    return { qualification: qualStatus.REJECTED, reason: "Closing date is more than 4 days away." };
  }

  if (locationStatus === locStatus.VERIFIED_OUTSIDE_NCR) {
    return { qualification: qualStatus.REJECTED, reason: "Project location is outside Metro Manila/NCR." };
  }

  // From here: keyword matched, not expired, not beyond the 4-day window,
  // and not confidently outside NCR.

  if (dateStatus === dStatus.INVALID) {
    return { qualification: qualStatus.OPTIONAL_PASSED, reason: "Closing date could not be verified." };
  }

  if (locationStatus === locStatus.VERIFIED_NCR) {
    return { qualification: qualStatus.QUALIFIED, reason: "" };
  }

  if (locationStatus === locStatus.UNVERIFIED) {
    return { qualification: qualStatus.OPTIONAL_PASSED, reason: "Location could not be verified." };
  }

  if (locationStatus === locStatus.AMBIGUOUS) {
    return { qualification: qualStatus.OPTIONAL_PASSED, reason: "Location text is ambiguous." };
  }

  if (locationStatus === locStatus.MULTIPLE_LOCATIONS) {
    return { qualification: qualStatus.OPTIONAL_PASSED, reason: "Multiple conflicting locations detected." };
  }

  return { qualification: qualStatus.REJECTED, reason: "Unclassified location status." };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { pbomQualify };
}
