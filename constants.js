/* PhilGeps BidOps Matcher - constants.js
 * Shared, side-effect-free constants. Loaded as a classic (non-module)
 * script both by the content-script pipeline (manifest "js" array) and by
 * the background service worker (importScripts), so everything stays in
 * sync from one place.
 */

// Exactly 41 default keywords. Do not add or remove any entry here.
var PBOM_DEFAULT_KEYWORDS = [
  "Artificial Intelligence",
  "AI Software",
  "Generative AI",
  "Data Analytics",
  "Data Science",
  "Business Intelligence",
  "Business Analytics",
  "Data Visualization",
  "Analytics Software",
  "Business Intelligence Software",
  "Power BI",
  "Tableau",
  "Data Integration",
  "Systems Integration",
  "Cloud Services",
  "Cloud Computing",
  "Software License",
  "Software Subscription",
  "Software Renewal",
  "License Renewal",
  "ICT Software",
  "Enterprise Software",
  "Video Conferencing",
  "Web Conferencing",
  "Collaboration Software",
  "Zoom",
  "Creative Software",
  "Graphic Design Software",
  "Multimedia Software",
  "Video Editing Software",
  "Canva",
  "Filmora",
  "CAD",
  "CAD Software",
  "Computer-Aided Design",
  "Engineering Software",
  "Digital Transformation",
  "Digital Solution",
  "IT Solution",
  "ICT Solution",
  "Automation Software",
];

// Optional, opt-in category/related terms — never silently merged into the
// 41 defaults above. Only used for matching when the user enables the toggle.
var PBOM_RELATED_ICT_TERMS = ["Information Technology", "Information and Communications Technology"];

var PBOM_DEFAULT_OPTIONS = {
  caseSensitive: false,
  wholeWord: false,
  minMatches: 1,
  includeRelated: false,
};

// Mandatory rule: an opportunity closing more than this many days from now
// is disqualified, regardless of keyword/location match.
var PBOM_DATE_WINDOW_DAYS = 4;

// Monitoring is a tri-state, not a simple on/off:
//   ACTIVE  - scanning and reporting new opportunities
//   PAUSED  - observers stay attached but nothing new is processed/sent
//   OFF     - fully stopped, observers disconnected
var PBOM_MONITORING_STATES = {
  ACTIVE: "active",
  PAUSED: "paused",
  OFF: "off",
};

var PBOM_STORAGE_SCHEMA_VERSION = 1;

var PBOM_STORAGE_KEYS = {
  schemaVersion: "philgepsBidOps_schemaVersion",
  keywords: "philgepsBidOps_keywords",
  options: "philgepsBidOps_options",
  theme: "philgepsBidOps_theme",
  monitoringState: "philgepsBidOps_monitoringState", // one of PBOM_MONITORING_STATES
  notifyOnQualified: "philgepsBidOps_notifyOnQualified", // boolean
  persistAcrossRestart: "philgepsBidOps_persistAcrossRestart", // boolean, default true
  results: "philgepsBidOps_results", // { candidates: {uid: record}, version, updatedAt }
  unrecognizedEntities: "philgepsBidOps_unrecognizedEntities", // { [normalizedText]: {rawText, count, lastSeenAt} }
  session: "philgepsBidOps_session", // { pagesMonitored: [urls], opportunitiesScanned: n, lastScanAt: iso }
  notified: "philgepsBidOps_notified", // { [uid]: iso } opportunities already notified (prevents repeat notifications)
  aiConfig: "philgepsBidOps_aiConfig", // AI provider configuration & token
  aiCache: "philgepsBidOps_aiCache", // Local cached AI candidate assessments { [uid]: assessment }
};

var PBOM_ACTIONS = {
  PING: "PING",
  SCAN_PAGE: "SCAN_PAGE", // popup -> content: manual/force scan of the active tab
  HIGHLIGHT_MATCHES: "HIGHLIGHT_MATCHES", // popup -> content: safe reversible DOM highlight
  CLEAR_HIGHLIGHTS: "CLEAR_HIGHLIGHTS", // popup -> content: restore text nodes
  NAVIGATE_MATCH: "NAVIGATE_MATCH", // popup -> content: { direction: 'next'|'prev'|number }
  GET_MATCH_STATUS: "GET_MATCH_STATUS", // popup -> content: get match count and current active index
  SCROLL_TO_OPPORTUNITY: "SCROLL_TO_OPPORTUNITY", // popup -> content: scroll page to row/card
  OPPORTUNITIES_FOUND: "OPPORTUNITIES_FOUND", // content -> background: batch of classified opportunities
  PAGE_REGISTERED: "PAGE_REGISTERED", // content -> background: this tab/URL is being monitored
  GET_STATE: "GET_STATE", // popup -> background: aggregated results + session info
  SET_MONITORING_STATE: "SET_MONITORING_STATE", // popup -> background: {state: PBOM_MONITORING_STATES.*}
  MONITORING_STATE_CHANGED: "MONITORING_STATE_CHANGED", // background -> content: broadcast {state}
  CLEAR_RESULTS: "CLEAR_RESULTS", // popup -> background
  AI_TEST_CONNECTION: "AI_TEST_CONNECTION", // popup -> background: test configured AI provider
  AI_ANALYZE_CANDIDATES: "AI_ANALYZE_CANDIDATES", // popup -> background: enhance candidates with AI
};

// Where a result's link points. Never fabricated: DETAIL is a link taken from
// the listing row/card itself, LISTING is the genuine page the row was found
// on, UNAVAILABLE means no valid http(s) URL could be determined.
var PBOM_LINK_TYPE = {
  DETAIL: "detail",
  LISTING: "listing",
  UNAVAILABLE: "unavailable",
};

// Highlight categories for visual distinction (Section 3B)
var PBOM_HIGHLIGHT_TYPES = {
  DIRECT: "direct",         // Exact configured keyword match
  POTENTIAL: "potential",   // Relevant keyword in procurement context
  PRIORITY: "priority",     // Multiple keywords or high match score
  OPTIONAL: "optional",     // Contextual / optional match requiring review
};

// Highlighting CSS classes applied to <mark> elements
var PBOM_HIGHLIGHT_CLASSES = {
  BASE: "pbom-highlight",
  DIRECT: "pbom-hl-direct",
  POTENTIAL: "pbom-hl-potential",
  PRIORITY: "pbom-hl-priority",
  OPTIONAL: "pbom-hl-optional",
  ACTIVE: "pbom-hl-active",
};

// Procurement context & status recognition (Section 2C)
var PBOM_PROCUREMENT_STATUS = {
  ACTIVE: "ACTIVE",                 // Active procurement opportunity
  UPCOMING: "UPCOMING",             // Upcoming procurement / advance notice
  CLOSED: "CLOSED",                 // Closed or expired opportunity
  AWARDED: "AWARDED",               // Notice of Award / Notice to Proceed
  CANCELLED: "CANCELLED",           // Notice of Cancellation / Failure of Bidding
  BULLETIN: "BULLETIN",             // Bid Bulletin / Supplemental Bulletin / Addendum
  APP: "APP",                       // Annual Procurement Plan / Project Plan
  GENERAL: "GENERAL",               // General agency announcement
  HISTORICAL: "HISTORICAL",         // Historical procurement record
  UNVERIFIED: "STATUS UNVERIFIED",   // Status could not be determined reliably
};

// Sites the manifest injects into statically. These are the only sites the
// extension is allowed to scan or monitor.
var PBOM_PHILGEPS_HOST_PATTERNS = [
  "https://philgeps.gov.ph/*",
  "https://*.philgeps.gov.ph/*",
];
var PBOM_STATIC_HOST_PATTERNS = PBOM_PHILGEPS_HOST_PATTERNS.slice();
var PBOM_PHILGEPS_HOST_RE = /(^|\.)philgeps\.gov\.ph$/i;

// Injection order for the page pipeline (must match manifest content_scripts).
var PBOM_CONTENT_SCRIPT_FILES = [
  "constants.js",
  "url-utils.js",
  "governmentEntities.js",
  "entity-detector.js",
  "date-validator.js",
  "location-detector.js",
  "procurement-classifier.js",
  "procurement-adapters.js",
  "keyword-highlighter.js",
  "matcher.js",
  "qualifier.js",
  "scanner.js",
  "universal-extractor.js",
  "content.js",
];

var PBOM_ALARM_SWEEP = "pbom-sweep"; // chrome.alarms name: periodic background re-check
var PBOM_SWEEP_MINUTES = 15;
var PBOM_MAX_PAGES_TRACKED = 200;
var PBOM_UNDATED_RETENTION_DAYS = 30; // results with no verifiable closing date are dropped this long after last seen
var PBOM_MAX_OPPORTUNITIES_PER_SCAN = 500;

// Location classification tiers used throughout location-detector.js,
// matcher.js output, and the popup.
var PBOM_LOCATION_STATUS = {
  VERIFIED_NCR: "VERIFIED_NCR",
  VERIFIED_OUTSIDE_NCR: "VERIFIED_OUTSIDE_NCR",
  UNVERIFIED: "UNVERIFIED",
  AMBIGUOUS: "AMBIGUOUS",
  MULTIPLE_LOCATIONS: "MULTIPLE_LOCATIONS",
};

// Overall per-opportunity qualification outcome.
var PBOM_QUALIFICATION = {
  QUALIFIED: "QUALIFIED",
  OPTIONAL_PASSED: "OPTIONAL_PASSED",
  POTENTIAL_MATCH: "POTENTIAL_MATCH",
  NEEDS_VERIFICATION: "NEEDS_VERIFICATION",
  REJECTED: "REJECTED", // never shown in the popup; kept only for internal debug counts
};

// Date-window classification for a parsed closing date/time.
var PBOM_DATE_STATUS = {
  WITHIN_WINDOW: "WITHIN_WINDOW",
  EXPIRED: "EXPIRED",
  BEYOND_WINDOW: "BEYOND_WINDOW",
  INVALID: "INVALID",
};

// AI Provider Identifiers
var PBOM_AI_PROVIDERS = {
  OPENAI: "openai",
  GEMINI: "gemini",
  ANTHROPIC: "anthropic",
  CUSTOM: "custom",
};

// Standard endpoint & model defaults per provider
var PBOM_PROVIDER_DEFAULTS = {
  openai: {
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
  },
  gemini: {
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent",
    model: "gemini-1.5-flash",
  },
  anthropic: {
    endpoint: "https://api.anthropic.com/v1/messages",
    model: "claude-3-5-haiku-20241022",
  },
  custom: {
    endpoint: "http://localhost:11434/v1/chat/completions",
    model: "llama3",
  },
};

var PBOM_DEFAULT_AI_CONFIG = {
  enabled: false,
  provider: PBOM_AI_PROVIDERS.OPENAI,
  endpoint: PBOM_PROVIDER_DEFAULTS.openai.endpoint,
  model: PBOM_PROVIDER_DEFAULTS.openai.model,
  token: "",
  autoAnalyze: false,
  maxCandidatesPerScan: 5,
  timeoutMs: 15000,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PBOM_DEFAULT_KEYWORDS,
    PBOM_RELATED_ICT_TERMS,
    PBOM_DEFAULT_OPTIONS,
    PBOM_DATE_WINDOW_DAYS,
    PBOM_STORAGE_KEYS,
    PBOM_ACTIONS,
    PBOM_MONITORING_STATES,
    PBOM_LOCATION_STATUS,
    PBOM_QUALIFICATION,
    PBOM_DATE_STATUS,
    PBOM_LINK_TYPE,
    PBOM_HIGHLIGHT_TYPES,
    PBOM_HIGHLIGHT_CLASSES,
    PBOM_PROCUREMENT_STATUS,
    PBOM_STATIC_HOST_PATTERNS,
    PBOM_PHILGEPS_HOST_RE,
    PBOM_CONTENT_SCRIPT_FILES,
    PBOM_ALARM_SWEEP,
    PBOM_SWEEP_MINUTES,
    PBOM_MAX_PAGES_TRACKED,
    PBOM_UNDATED_RETENTION_DAYS,
    PBOM_MAX_OPPORTUNITIES_PER_SCAN,
    PBOM_AI_PROVIDERS,
    PBOM_PROVIDER_DEFAULTS,
    PBOM_DEFAULT_AI_CONFIG,
  };
}
