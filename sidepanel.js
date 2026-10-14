/* PhilGeps BidOps Matcher - sidepanel.js
 * Side panel controller (replaces the old popup). Lives as long as the panel
 * is open; everything durable stays in chrome.storage / the background worker,
 * so closing and reopening the panel loses nothing.
 *
 *  - background (GET_STATE / SET_MONITORING_STATE / CLEAR_RESULTS): aggregated
 *    results, monitoring state, session stats
 *  - content script of the ACTIVE PhilGEPS tab (SCAN_PAGE / HIGHLIGHT / CLEAR):
 *    only for inherently per-tab actions
 *  - chrome.tabs events keep the "current page" card in step with navigation
 *    without resetting the rest of the interface
 */

const DEFAULT_KEYWORDS = PBOM_DEFAULT_KEYWORDS;
const DEFAULT_OPTIONS = PBOM_DEFAULT_OPTIONS;
const STORAGE_KEYS = PBOM_STORAGE_KEYS;

// ---- DOM references ---------------------------------------------------------

const el = {
  settingsToggleBtn: document.getElementById("settingsToggleBtn"),
  closePanelBtn: document.getElementById("closePanelBtn"),
  settingsPanel: document.getElementById("settingsPanel"),

  monitoringCard: document.querySelector(".monitoring-card"),
  monitoringToggle: document.getElementById("monitoringToggle"),
  monitoringSubtitle: document.getElementById("monitoringSubtitle"),
  pauseResumeBtn: document.getElementById("pauseResumeBtn"),
  statLastScan: document.getElementById("statLastScan"),
  statPages: document.getElementById("statPages"),
  statScanned: document.getElementById("statScanned"),

  pageDomain: document.getElementById("pageDomain"),
  pageAccess: document.getElementById("pageAccess"),
  pageTitle: document.getElementById("pageTitle"),
  pageUrl: document.getElementById("pageUrl"),
  searchInput: document.getElementById("searchInput"),
  searchClearBtn: document.getElementById("searchClearBtn"),
  searchHint: document.getElementById("searchHint"),
  scanNowBtn: document.getElementById("scanNowBtn"),
  rescanBtn: document.getElementById("rescanBtn"),
  scanStats: document.getElementById("scanStats"),

  highlightBtn: document.getElementById("highlightBtn"),
  clearHighlightsBtn: document.getElementById("clearHighlightsBtn"),
  clearResultsBtn: document.getElementById("clearResultsBtn"),

  unsupportedNotice: document.getElementById("unsupportedNotice"),
  accessNotice: document.getElementById("accessNotice"),
  accessNoticeText: document.getElementById("accessNoticeText"),
  grantSiteBtn: document.getElementById("grantSiteBtn"),
  noTableNotice: document.getElementById("noTableNotice"),
  errorNotice: document.getElementById("errorNotice"),
  errorNoticeText: document.getElementById("errorNoticeText"),

  qualFilter: document.getElementById("qualFilter"),
  scopeFilter: document.getElementById("scopeFilter"),
  domainFilter: document.getElementById("domainFilter"),

  emptyState: document.getElementById("emptyState"),
  emptyStateTitle: document.getElementById("emptyStateTitle"),
  emptyStateBody: document.getElementById("emptyStateBody"),
  resultsWrap: document.getElementById("resultsWrap"),

  sumQualified: document.getElementById("sumQualified"),
  sumOptionalPassed: document.getElementById("sumOptionalPassed"),

  resultGroups: document.getElementById("resultGroups"),

  diagnosticsToggleBtn: document.getElementById("diagnosticsToggleBtn"),
  diagnosticsPanel: document.getElementById("diagnosticsPanel"),
  diagnosticsList: document.getElementById("diagnosticsList"),
  diagnosticsEmptyNote: document.getElementById("diagnosticsEmptyNote"),

  minMatches: document.getElementById("minMatches"),
  caseSensitive: document.getElementById("caseSensitive"),
  wholeWord: document.getElementById("wholeWord"),
  includeRelated: document.getElementById("includeRelated"),
  acronymPairing: document.getElementById("acronymPairing"),
  negativeFiltering: document.getElementById("negativeFiltering"),
  fieldWeightedScoring: document.getElementById("fieldWeightedScoring"),

  notifyOnQualified: document.getElementById("notifyOnQualified"),
  persistAcrossRestart: document.getElementById("persistAcrossRestart"),

  siteAccessStatus: document.getElementById("siteAccessStatus"),
  grantAllSitesBtn: document.getElementById("grantAllSitesBtn"),
  revokeSitesBtn: document.getElementById("revokeSitesBtn"),

  keywordCount: document.getElementById("keywordCount"),
  manageKeywordsBtn: document.getElementById("manageKeywordsBtn"),
  keywordManager: document.getElementById("keywordManager"),
  keywordSearch: document.getElementById("keywordSearch"),
  keywordListRows: document.getElementById("keywordListRows"),
  keywordEmptyNote: document.getElementById("keywordEmptyNote"),
  newKeywordInput: document.getElementById("newKeywordInput"),
  addKeywordBtn: document.getElementById("addKeywordBtn"),
  resetKeywordsBtn: document.getElementById("resetKeywordsBtn"),

  themeSwitcher: document.getElementById("themeSwitcher"),

  // Ctrl+F Match navigation
  highlightMatchesBtn: document.getElementById("highlightMatchesBtn"),
  clearHighlightsNavBtn: document.getElementById("clearHighlightsNavBtn"),
  prevMatchBtn: document.getElementById("prevMatchBtn"),
  nextMatchBtn: document.getElementById("nextMatchBtn"),
  matchCounterText: document.getElementById("matchCounterText"),
  highlightFilterSelect: document.getElementById("highlightFilterSelect"),

  // AI Status and actions
  aiStatusCard: document.getElementById("aiStatusCard"),
  aiStatusSubtitle: document.getElementById("aiStatusSubtitle"),
  analyzeAiBtn: document.getElementById("analyzeAiBtn"),
  aiAnalysisFeedback: document.getElementById("aiAnalysisFeedback"),
  sumPotential: document.getElementById("sumPotential"),
  sumVerification: document.getElementById("sumVerification"),

  // AI Settings
  aiSettingsBadge: document.getElementById("aiSettingsBadge"),
  aiEnabledToggle: document.getElementById("aiEnabledToggle"),
  aiConfigFields: document.getElementById("aiConfigFields"),
  aiProviderSelect: document.getElementById("aiProviderSelect"),
  aiEndpointInput: document.getElementById("aiEndpointInput"),
  aiModelInput: document.getElementById("aiModelInput"),
  aiTokenInput: document.getElementById("aiTokenInput"),
  toggleTokenVisibilityBtn: document.getElementById("toggleTokenVisibilityBtn"),
  aiAutoAnalyzeToggle: document.getElementById("aiAutoAnalyzeToggle"),
  testAiConnectionBtn: document.getElementById("testAiConnectionBtn"),
  saveAiSettingsBtn: document.getElementById("saveAiSettingsBtn"),
  removeAiTokenBtn: document.getElementById("removeAiTokenBtn"),
  aiConnectionStatus: document.getElementById("aiConnectionStatus"),
};

let currentTab = null; // { id, url, title, windowId } of the active tab in this window
let state = { keywords: DEFAULT_KEYWORDS.slice() };
let lastResponse = null; // latest GET_STATE payload; filters re-render from it without refetching
let view = { qual: "all", scope: "all", domain: "", query: "" };
let scanBusy = false;
let scanSeq = 0;
let accessTarget = null; // { tabId, url } the "Allow access" button applies to
let lastScanSummary = null; // { tabId, url, at, text } from this panel's own scan

// ---- Icon hydration -----------------------------------------------------------

function hydrateIcons(root) {
  (root || document).querySelectorAll("[data-icon]").forEach((node) => {
    if (node.childElementCount === 0) {
      node.innerHTML = iconMarkup(node.getAttribute("data-icon"));
    }
  });
}

// ---- Storage helpers (keywords / options / theme are still local settings) ----

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      [STORAGE_KEYS.keywords, STORAGE_KEYS.options, STORAGE_KEYS.theme],
      (result) => {
        const keywords = Array.isArray(result[STORAGE_KEYS.keywords]) ? result[STORAGE_KEYS.keywords] : DEFAULT_KEYWORDS;
        const options = result[STORAGE_KEYS.options] ? { ...DEFAULT_OPTIONS, ...result[STORAGE_KEYS.options] } : { ...DEFAULT_OPTIONS };
        const theme = result[STORAGE_KEYS.theme] || "system";
        resolve({ keywords, options, theme });
      }
    );
  });
}

function saveKeywords(keywords) {
  return new Promise((resolve) => chrome.storage.local.set({ [STORAGE_KEYS.keywords]: keywords }, resolve));
}

function saveOptions(options) {
  return new Promise((resolve) => chrome.storage.local.set({ [STORAGE_KEYS.options]: options }, resolve));
}

function saveTheme(theme) {
  return new Promise((resolve) => chrome.storage.local.set({ [STORAGE_KEYS.theme]: theme }, resolve));
}

function loadMonitoringPrefs() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEYS.notifyOnQualified, STORAGE_KEYS.persistAcrossRestart], (result) => {
      resolve({
        notifyOnQualified: !!result[STORAGE_KEYS.notifyOnQualified],
        persistAcrossRestart: result[STORAGE_KEYS.persistAcrossRestart] !== false,
      });
    });
  });
}

// ---- Theme ---------------------------------------------------------------------

let systemMediaQuery = null;

function resolveTheme(themeChoice) {
  if (themeChoice === "system") return systemMediaQuery && systemMediaQuery.matches ? "dark" : "light";
  return themeChoice;
}

function applyTheme(themeChoice) {
  document.documentElement.setAttribute("data-theme", resolveTheme(themeChoice));
  el.themeSwitcher.querySelectorAll(".theme-option").forEach((btn) => {
    const isActive = btn.getAttribute("data-theme-choice") === themeChoice;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-checked", isActive ? "true" : "false");
  });
}

function initThemeWatcher(themeChoice) {
  if (!systemMediaQuery) {
    systemMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    systemMediaQuery.addEventListener("change", () => {
      if (document.documentElement.getAttribute("data-theme-choice") === "system") applyTheme("system");
    });
  }
  document.documentElement.setAttribute("data-theme-choice", themeChoice);
  applyTheme(themeChoice);
}

// ---- Options UI ---------------------------------------------------------------

function getOptionsFromUI() {
  const minMatches = Math.max(1, parseInt(el.minMatches.value, 10) || 1);
  return {
    caseSensitive: el.caseSensitive.checked,
    wholeWord: el.wholeWord.checked,
    minMatches,
    includeRelated: el.includeRelated.checked,
    acronymPairing: el.acronymPairing ? el.acronymPairing.checked : true,
    negativeFiltering: el.negativeFiltering ? el.negativeFiltering.checked : true,
    fieldWeightedScoring: el.fieldWeightedScoring ? el.fieldWeightedScoring.checked : true,
  };
}

function setOptionsInUI(options) {
  el.caseSensitive.checked = !!options.caseSensitive;
  el.wholeWord.checked = !!options.wholeWord;
  el.minMatches.value = options.minMatches || 1;
  el.includeRelated.checked = !!options.includeRelated;
  if (el.acronymPairing) el.acronymPairing.checked = options.acronymPairing !== false;
  if (el.negativeFiltering) el.negativeFiltering.checked = options.negativeFiltering !== false;
  if (el.fieldWeightedScoring) el.fieldWeightedScoring.checked = options.fieldWeightedScoring !== false;
}

// ---- Keyword manager -----------------------------------------------------------

function renderKeywordCount() {
  el.keywordCount.textContent = state.keywords.length;
}

function renderKeywordRows(filterText) {
  const filter = (filterText || "").trim().toLowerCase();
  const filtered = filter ? state.keywords.filter((k) => k.toLowerCase().includes(filter)) : state.keywords;

  el.keywordListRows.innerHTML = "";
  if (filtered.length === 0) {
    el.keywordEmptyNote.classList.remove("hidden");
    return;
  }
  el.keywordEmptyNote.classList.add("hidden");

  filtered.forEach((keyword) => {
    const row = document.createElement("div");
    row.className = "keyword-row";

    const text = document.createElement("span");
    text.className = "keyword-row-text";
    text.textContent = keyword;
    text.title = keyword;
    row.appendChild(text);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "keyword-row-delete";
    delBtn.setAttribute("aria-label", "Delete " + keyword);
    delBtn.title = "Delete";
    delBtn.innerHTML = iconMarkup("trash-2");
    delBtn.addEventListener("click", () => deleteKeyword(keyword));
    row.appendChild(delBtn);

    el.keywordListRows.appendChild(row);
  });
}

async function deleteKeyword(keyword) {
  state.keywords = state.keywords.filter((k) => k !== keyword);
  await saveKeywords(state.keywords);
  renderKeywordCount();
  renderKeywordRows(el.keywordSearch.value);
}

async function addKeywordFromInput() {
  const value = el.newKeywordInput.value.trim();
  if (!value) return;
  const exists = state.keywords.some((k) => k.toLowerCase() === value.toLowerCase());
  if (exists) {
    el.newKeywordInput.value = "";
    return;
  }
  state.keywords.push(value);
  await saveKeywords(state.keywords);
  el.newKeywordInput.value = "";
  renderKeywordCount();
  renderKeywordRows(el.keywordSearch.value);
}

async function resetKeywordsToDefaults() {
  state.keywords = DEFAULT_KEYWORDS.slice();
  await saveKeywords(state.keywords);
  renderKeywordCount();
  renderKeywordRows(el.keywordSearch.value);
}

function toggleKeywordManager() {
  const isHidden = el.keywordManager.classList.contains("hidden");
  el.keywordManager.classList.toggle("hidden");
  el.manageKeywordsBtn.setAttribute("aria-expanded", isHidden ? "true" : "false");
  el.manageKeywordsBtn.querySelector(".chevron-inline").style.transform = isHidden ? "rotate(180deg)" : "";
  if (isHidden) renderKeywordRows(el.keywordSearch.value);
}

// ---- Notices --------------------------------------------------------------------

function showError(message) {
  el.errorNoticeText.textContent = message;
  el.errorNotice.classList.remove("hidden");
}

function hideError() {
  el.errorNotice.classList.add("hidden");
  el.errorNoticeText.textContent = "";
}

function hideScanNotices() {
  hideError();
  el.noTableNotice.classList.add("hidden");
  el.accessNotice.classList.add("hidden");
  accessTarget = null;
}

// ---- Active tab helpers ---------------------------------------------------------

function errMsg(err) {
  return err && err.message ? err.message : String(err);
}

async function queryActiveTab() {
  let windowId = null;
  try {
    const win = await chrome.windows.getCurrent();
    windowId = win && win.id != null ? win.id : null;
  } catch (e) {
    windowId = null;
  }
  const query = windowId != null ? { active: true, windowId } : { active: true, currentWindow: true };
  const tabs = await chrome.tabs.query(query);
  return tabs && tabs[0] ? tabs[0] : null;
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function injectContentScript(tabId) {
  return chrome.scripting.executeScript({ target: { tabId }, files: PBOM_CONTENT_SCRIPT_FILES });
}

async function sendMessageEnsuringInjected(tabId, message) {
  try {
    return await sendMessageToTab(tabId, message);
  } catch (e) {
    await injectContentScript(tabId); // throws a permission error on pages we may not access
    return await sendMessageToTab(tabId, message);
  }
}

function looksLikeAccessError(err) {
  return /cannot access|must request permission|permission|not allowed|extensions gallery|host/i.test(errMsg(err));
}

// ---- Background messaging --------------------------------------------------------

function sendToBackground(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

// ---- Rendering: shared helpers --------------------------------------------------

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatIsoDateReadable(isoDateOnly) {
  if (!isoDateOnly) return null;
  const [y, m, d] = isoDateOnly.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return null;
  return `${MONTH_ABBR[m - 1]} ${String(d).padStart(2, "0")}, ${y}`;
}

function formatTime12h(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

function locationLine(location) {
  if (!location) return "Location not verified";
  switch (location.status) {
    case "VERIFIED_NCR":
      return (location.detected || "NCR") + " · NCR verified";
    case "VERIFIED_OUTSIDE_NCR":
      return (location.detected || "Outside NCR") + " · Outside NCR";
    case "AMBIGUOUS":
      return "Location text is ambiguous";
    case "MULTIPLE_LOCATIONS":
      return "Multiple locations detected";
    default:
      return "Not indicated / unable to verify";
  }
}

function keywordSummaryText(matched) {
  const names = (matched || []).map((m) => m.keyword);
  if (names.length <= 3) return names.join(" · ");
  return names.slice(0, 3).join(" · ") + " · +" + (names.length - 3) + " more";
}

function publishedLine(op) {
  const readable = formatIsoDateReadable(op.datePublished);
  return readable || (op.datePublishedRaw ? op.datePublishedRaw : "Not indicated");
}

function closingLine(op) {
  const readable = formatIsoDateReadable(op.closingDate);
  if (!readable) return op.closingRaw || "Not indicated";
  const time = op.closingTime ? formatTime12h(op.closingTime) : null;
  return readable + (time ? " – " + time : "");
}

function openUrlInNewTab(url) {
  chrome.tabs.create({ url, active: true }).catch(() => {});
}

function metaRow(iconName, text) {
  const row = document.createElement("div");
  row.className = "opp-meta-row";
  row.appendChild(iconElement(iconName));
  const span = document.createElement("span");
  span.textContent = text;
  row.appendChild(span);
  return row;
}

/** Click handler that opens in a new tab via the tabs API but leaves normal
 *  modified-clicks (ctrl/cmd/middle) to the browser. */
function attachSafeOpen(anchor, url) {
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.addEventListener("click", (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    openUrlInNewTab(url);
  });
}

function renderOpportunityCard(op) {
  let kind = "qualified";
  let statusText = "Passed";
  let statusIcon = "circle-check";

  if (op.qualification === "OPTIONAL_PASSED") {
    kind = "optional";
    statusText = "Optional Passed";
    statusIcon = "info";
  } else if (op.qualification === "POTENTIAL_MATCH") {
    kind = "potential";
    statusText = "Potential Match";
    statusIcon = "layers";
  } else if (op.qualification === "NEEDS_VERIFICATION") {
    kind = "verification";
    statusText = "Needs Verification";
    statusIcon = "triangle-alert";
  }

  const card = document.createElement("div");
  card.className = "opp-card";
  card.setAttribute("title", "Click to scroll to this opportunity on the page");

  // Click card to scroll active tab to opportunity
  card.addEventListener("click", (e) => {
    if (e.target.closest("a, button")) return;
    if (currentTab && currentTab.id) {
      sendMessageToTab(currentTab.id, {
        action: PBOM_ACTIONS.SCROLL_TO_OPPORTUNITY,
        uid: op.uid,
        rowKey: op.rowKey,
      }).catch(() => {});
    }
  });

  const statusRow = document.createElement("div");
  statusRow.className = "opp-status-row";
  const status = document.createElement("div");
  status.className = "opp-status opp-status-" + kind;
  status.appendChild(iconElement(statusIcon));
  const statusLabel = document.createElement("span");
  statusLabel.textContent = statusText;
  status.appendChild(statusLabel);
  statusRow.appendChild(status);

  // Status tag if recognized
  if (op.procurementStatus && op.procurementStatus !== "ACTIVE") {
    const pTag = document.createElement("span");
    const tagLower = op.procurementStatus.toLowerCase().replace(/[^a-z]/g, "");
    pTag.className = "opp-procurement-tag " + tagLower;
    pTag.textContent = op.procurementStatus;
    statusRow.appendChild(pTag);
  }

  // AI badge if enhanced
  if (op.aiEnhanced) {
    const aiBadge = document.createElement("span");
    aiBadge.className = "opp-ai-badge";
    aiBadge.appendChild(iconElement("sparkles"));
    aiBadge.appendChild(document.createTextNode("AI"));
    statusRow.appendChild(aiBadge);
  }

  if (op.sourceDomain) {
    const dom = document.createElement("span");
    dom.className = "opp-domain";
    dom.textContent = op.sourceDomain;
    dom.title = op.sourceDomain;
    statusRow.appendChild(dom);
  }
  card.appendChild(statusRow);

  // Link is always re-validated here; only a plain http(s) URL is clickable.
  const safeUrl = pbomSanitizeUrl(op.sourceUrl);

  const title = document.createElement("div");
  title.className = "opp-title";
  if (safeUrl) {
    const a = document.createElement("a");
    a.className = "opp-title-link";
    a.appendChild(document.createTextNode(op.title));
    a.appendChild(iconElement("external-link"));
    a.title = safeUrl;
    attachSafeOpen(a, safeUrl);
    title.appendChild(a);
  } else {
    title.textContent = op.title;
    title.title = op.title;
  }
  card.appendChild(title);

  const entity = op.governmentEntity || op.entity;
  const detectedLoc = (op.location && op.location.detected) || "";
  if (entity && !detectedLoc.toLowerCase().includes(entity.toLowerCase())) { // location row already names it
    const entityEl = document.createElement("div");
    entityEl.className = "opp-gov-entity-line";
    entityEl.textContent = entity + (op.governmentEntity && op.governmentEntityConfidence === "medium" ? " (uncertain office)" : "");
    card.appendChild(entityEl);
  }
  if (op.reference) {
    const refEl = document.createElement("div");
    refEl.className = "opp-gov-entity-line";
    refEl.textContent = "Ref. " + op.reference;
    card.appendChild(refEl);
  }

  const kwRow = document.createElement("div");
  kwRow.className = "opp-meta-row";
  kwRow.appendChild(iconElement("tags"));
  const kwSpan = document.createElement("span");
  const strong = document.createElement("span");
  strong.className = "opp-meta-strong";
  strong.textContent = op.matchedCount + (op.matchedCount === 1 ? " keyword" : " keywords");
  kwSpan.appendChild(strong);
  if (typeof op.matchScore === "number" && op.matchScore > op.matchedCount) {
    const scoreBadge = document.createElement("span");
    scoreBadge.className = "opp-score-badge";
    scoreBadge.textContent = "Score " + op.matchScore;
    kwSpan.appendChild(scoreBadge);
  }
  if (op.matched && op.matched.length) {
    const list = document.createElement("span");
    list.className = "opp-keywords";
    list.textContent = " · " + keywordSummaryText(op.matched);
    kwSpan.appendChild(list);
  }
  kwRow.appendChild(kwSpan);
  card.appendChild(kwRow);

  if (op.bundleMatches && op.bundleMatches.length > 0) {
    const bundleRow = document.createElement("div");
    bundleRow.className = "opp-bundles-row";
    op.bundleMatches.forEach((b) => {
      const bTag = document.createElement("span");
      bTag.className = "opp-bundle-tag";
      bTag.textContent = b.label || b.id;
      bundleRow.appendChild(bTag);
    });
    card.appendChild(bundleRow);
  }

  if (op.proximityMatches && op.proximityMatches.length > 0) {
    const proxLine = document.createElement("div");
    proxLine.className = "opp-proximity-line";
    proxLine.textContent = "Co-occurrence: " + op.proximityMatches.join(", ");
    card.appendChild(proxLine);
  }

  card.appendChild(metaRow("map-pin", locationLine(op.location)));
  card.appendChild(metaRow("file-text", "Published " + publishedLine(op)));
  card.appendChild(
    metaRow("calendar-clock", "Closes " + closingLine(op) + (op.remainingText ? " · " + op.remainingText + " left" : ""))
  );

  if (op.evidenceExcerpt) {
    const ev = document.createElement("div");
    ev.className = "opp-evidence-line";
    ev.textContent = `“${op.evidenceExcerpt}”`;
    card.appendChild(ev);
  }

  const actions = document.createElement("div");
  actions.className = "opp-actions";
  if (safeUrl) {
    const open = document.createElement("a");
    open.className = "opp-open-link";
    open.appendChild(document.createTextNode(op.linkType === "detail" ? "Open Opportunity" : "Open Listing Page"));
    open.appendChild(iconElement("external-link"));
    attachSafeOpen(open, safeUrl);
    actions.appendChild(open);
    if (op.linkType !== "detail") {
      const note = document.createElement("span");
      note.className = "opp-link-note";
      note.textContent = "no direct link on page";
      actions.appendChild(note);
    }
  } else {
    const unavailable = document.createElement("span");
    unavailable.className = "opp-link-unavailable";
    unavailable.appendChild(iconElement("triangle-alert"));
    unavailable.appendChild(document.createTextNode("Source unavailable"));
    actions.appendChild(unavailable);
  }
  card.appendChild(actions);

  return card;
}

// ---- Rendering: date-grouped result list -----------------------------------------

function dateGroupLabel(isoDateOnly) {
  if (!isoDateOnly) return "Undated";
  const today = new Date();
  const todayIso = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayIso =
    yesterday.getFullYear() + "-" + String(yesterday.getMonth() + 1).padStart(2, "0") + "-" + String(yesterday.getDate()).padStart(2, "0");

  if (isoDateOnly === todayIso) return "Today — " + formatIsoDateReadable(isoDateOnly);
  if (isoDateOnly === yesterdayIso) return "Yesterday — " + formatIsoDateReadable(isoDateOnly);
  return formatIsoDateReadable(isoDateOnly) || "Undated";
}

function renderResultGroups(results) {
  el.resultGroups.replaceChildren();
  if (results.length === 0) return;

  let currentBucket = null;
  let currentListEl = null;

  results.forEach((op) => {
    const bucket = op.datePublished || "__undated__";
    if (bucket !== currentBucket) {
      currentBucket = bucket;
      const group = document.createElement("div");
      group.className = "result-group";

      const header = document.createElement("div");
      header.className = "result-group-header";
      header.textContent = dateGroupLabel(op.datePublished);
      group.appendChild(header);

      const list = document.createElement("div");
      list.className = "opportunity-list";
      group.appendChild(list);

      el.resultGroups.appendChild(group);
      currentListEl = list;
    }
    currentListEl.appendChild(renderOpportunityCard(op));
  });
}

// ---- Rendering: diagnostics (unrecognized entities) -------------------------------

function renderDiagnostics(unrecognizedEntities) {
  el.diagnosticsList.innerHTML = "";
  const entries = unrecognizedEntities || [];
  if (entries.length === 0) {
    el.diagnosticsEmptyNote.classList.remove("hidden");
    return;
  }
  el.diagnosticsEmptyNote.classList.add("hidden");
  entries.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "diagnostics-row";
    const text = document.createElement("span");
    text.className = "keyword-row-text";
    text.textContent = entry.rawText;
    text.title = entry.rawText;
    const count = document.createElement("span");
    count.className = "diagnostics-row-count";
    count.textContent = entry.count + "×";
    row.appendChild(text);
    row.appendChild(count);
    el.diagnosticsList.appendChild(row);
  });
}

function toggleDiagnostics() {
  const isHidden = el.diagnosticsPanel.classList.contains("hidden");
  el.diagnosticsPanel.classList.toggle("hidden");
  el.diagnosticsToggleBtn.setAttribute("aria-expanded", isHidden ? "true" : "false");
  el.diagnosticsToggleBtn.querySelector(".chevron-inline").style.transform = isHidden ? "rotate(180deg)" : "";
}

function formatRelativeTime(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 45 * 1000) return "Just now";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return minutes + (minutes === 1 ? " min ago" : " mins ago");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
  const days = Math.floor(hours / 24);
  return days + (days === 1 ? " day ago" : " days ago");
}

// ---- Filtering / search ---------------------------------------------------------------

function canonicalOrNull(url) {
  return url ? pbomCanonicalizeUrl(url) : null;
}

function matchesQuery(op, query) {
  if (!query) return true;
  const hay = [
    op.title,
    op.entity,
    op.governmentEntity,
    op.reference,
    op.category,
    op.sourceDomain,
    op.location && op.location.detected,
    (op.matched || []).map((m) => m.keyword).join(" "),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

function scopeResults(results) {
  const here = currentTab ? canonicalOrNull(currentTab.url) : null;
  return results.filter((op) => {
    if (view.scope === "page" && (!here || canonicalOrNull(op.sourcePageUrl) !== here)) return false;
    if (view.domain && op.sourceDomain !== view.domain) return false;
    return matchesQuery(op, view.query);
  });
}

function rebuildDomainOptions(results) {
  const domains = Array.from(new Set(results.map((r) => r.sourceDomain).filter(Boolean))).sort();
  if (view.domain && !domains.includes(view.domain)) view.domain = "";
  const frag = document.createDocumentFragment();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All sources";
  frag.appendChild(all);
  domains.forEach((d) => {
    const o = document.createElement("option");
    o.value = d;
    o.textContent = d;
    frag.appendChild(o);
  });
  el.domainFilter.replaceChildren(frag);
  el.domainFilter.value = view.domain;
  el.domainFilter.disabled = domains.length < 2;
}

function renderResults() {
  if (!lastResponse) return;
  const all = lastResponse.results || [];
  rebuildDomainOptions(all);

  const base = scopeResults(all);
  const qualified = base.filter((r) => r.qualification === "QUALIFIED").length;
  const optional = base.filter((r) => r.qualification === "OPTIONAL_PASSED").length;
  const potential = base.filter((r) => r.qualification === "POTENTIAL_MATCH").length;
  const verification = base.filter((r) => r.qualification === "NEEDS_VERIFICATION").length;
  el.sumQualified.textContent = String(qualified);
  el.sumOptionalPassed.textContent = String(optional);
  if (el.sumPotential) el.sumPotential.textContent = String(potential);
  if (el.sumVerification) el.sumVerification.textContent = String(verification);

  const shown = view.qual === "all" ? base : base.filter((r) => r.qualification === view.qual);
  renderResultGroups(shown);

  const hasAny = shown.length > 0;
  el.emptyState.classList.toggle("hidden", hasAny);
  el.resultsWrap.classList.toggle("hidden", !hasAny);
  if (!hasAny) {
    if (all.length === 0) {
      el.emptyStateTitle.textContent = "No opportunities collected yet";
      el.emptyStateBody.textContent =
        "Scan the current page, or turn on Automatic Monitoring and browse PhilGEPS and the government procurement sites you've allowed. Matches closing within the next 4 days collect here.";
    } else {
      el.emptyStateTitle.textContent = "No matches for these filters";
      el.emptyStateBody.textContent = "Try clearing the search, choosing All collected, or switching the qualification or source filter.";
    }
  }
}

function setSegmentActive(container, attr, value) {
  container.querySelectorAll(".filter-opt").forEach((btn) => {
    const active = btn.getAttribute(attr) === value;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-checked", active ? "true" : "false");
  });
}

function updateSearchHint() {
  const term = el.searchInput.value.trim();
  el.searchClearBtn.classList.toggle("hidden", term.length === 0);
  if (term.length >= 2) {
    el.searchHint.textContent = "Filtering collected results. Scan Current Page will also match \u201c" + term + "\u201d on the page.";
    el.searchHint.classList.remove("hidden");
  } else {
    el.searchHint.classList.add("hidden");
    el.searchHint.textContent = "";
  }
}

// ---- Rendering: monitoring indicator ----------------------------------------------

function renderState(response) {
  lastResponse = response;
  const monitoringState = response.monitoringState || "off";
  const isOn = monitoringState !== "off";
  const isPaused = monitoringState === "paused";

  el.monitoringToggle.checked = isOn;
  el.monitoringCard.classList.toggle("active", monitoringState === "active");
  el.monitoringCard.classList.toggle("paused", isPaused);

  if (monitoringState === "active") {
    el.monitoringSubtitle.textContent = "Active \u2014 PhilGEPS only";
  } else if (isPaused) {
    el.monitoringSubtitle.textContent = "Paused \u2014 resume to keep collecting";
  } else {
    el.monitoringSubtitle.textContent = "Off";
  }

  el.pauseResumeBtn.classList.toggle("hidden", !isOn);
  el.pauseResumeBtn.textContent = isPaused ? "Resume Monitoring" : "Pause Monitoring";

  if (typeof response.notifyOnQualified === "boolean") el.notifyOnQualified.checked = response.notifyOnQualified;
  if (typeof response.persistAcrossRestart === "boolean") el.persistAcrossRestart.checked = response.persistAcrossRestart;

  const session = response.session || { pagesMonitored: [], opportunitiesScanned: 0, lastScanAt: null };
  el.statLastScan.textContent = formatRelativeTime(session.lastScanAt);
  el.statPages.textContent = String((session.pagesMonitored || []).length);
  el.statScanned.textContent = String(session.opportunitiesScanned || 0);

  renderResults();
  renderDiagnostics(response.unrecognizedEntities);
  renderScanStats();
}

let refreshInFlight = null;
async function refreshState() {
  if (refreshInFlight) return refreshInFlight; // coalesce bursts of storage events
  refreshInFlight = (async () => {
    try {
      const response = await sendToBackground({ action: PBOM_ACTIONS.GET_STATE, tabId: currentTab ? currentTab.id : null });
      if (response && response.ok) renderState(response);
    } catch (e) {
      // Worker waking up or extension reloading — the next storage event/tick retries.
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

let refreshDebounce = null;
function scheduleRefreshState() {
  if (refreshDebounce) clearTimeout(refreshDebounce);
  refreshDebounce = setTimeout(() => {
    refreshDebounce = null;
    refreshState();
  }, 250);
}

// ---- Current page context (follows the active tab) -------------------------------

const STRATEGY_LABEL = { "philgeps-table": "PhilGEPS table", table: "HTML table", cards: "repeated listings" };

function strategyLabel(name) {
  if (!name) return "";
  if (name.startsWith("adapter:")) return name.slice(8) + " adapter";
  return STRATEGY_LABEL[name] || name;
}

function renderScanStats() {
  let text = "";
  const here = currentTab ? canonicalOrNull(currentTab.url) : null;
  if (lastScanSummary && currentTab && lastScanSummary.tabId === currentTab.id && canonicalOrNull(lastScanSummary.url) === here) {
    text = lastScanSummary.text;
  } else if (lastResponse && lastResponse.tabScan && here && canonicalOrNull(lastResponse.tabScan.url) === here) {
    const t = lastResponse.tabScan;
    text =
      "Last scan of this page: " +
      t.scannedCount +
      " listing" +
      (t.scannedCount === 1 ? "" : "s") +
      " \u00b7 " +
      t.matchedCount +
      " matched \u00b7 " +
      formatRelativeTime(new Date(t.at).toISOString()) +
      (t.strategy ? " \u00b7 " + strategyLabel(t.strategy) : "");
  }
  el.scanStats.textContent = text;
  el.scanStats.classList.toggle("hidden", !text);
}

async function siteAccessState(url) {
  if (!pbomIsScannableUrl(url)) return "blocked";
  return "granted";
}

const ACCESS_LABEL = { granted: "PhilGEPS access allowed", request: "", blocked: "Only PhilGEPS pages can be scanned" };

let ctxSeq = 0;
let lastCtxUrl = null;
async function refreshTabContext() {
  const seq = ++ctxSeq;
  let tab = null;
  try {
    tab = await queryActiveTab();
  } catch (e) {
    tab = null;
  }
  if (seq !== ctxSeq) return; // a newer navigation/tab switch superseded this lookup

  const url = tab && tab.url ? tab.url : "";
  const access = tab ? await siteAccessState(url) : "blocked";
  if (seq !== ctxSeq) return;

  currentTab = tab ? { id: tab.id, url, title: tab.title || "", windowId: tab.windowId } : null;

  el.pageDomain.textContent = pbomGetDomain(url) || (tab ? "Browser page" : "\u2014");
  el.pageTitle.textContent = (tab && tab.title) || (tab ? "Untitled page" : "No page selected");
  el.pageUrl.textContent = url;
  el.pageUrl.title = url;
  el.pageAccess.dataset.access = access;
  el.pageAccess.textContent = ACCESS_LABEL[access];

  const canScan = access !== "blocked";
  el.unsupportedNotice.classList.toggle("hidden", canScan);
  if (!scanBusy) {
    el.scanNowBtn.disabled = !canScan;
    el.rescanBtn.disabled = !canScan;
    el.highlightBtn.disabled = !canScan;
    el.clearHighlightsBtn.disabled = !canScan;
  }

  // Navigation to a different page clears per-page notices but not results,
  // filters, search text or settings.
  const canonical = canonicalOrNull(url) || url;
  if (canonical !== lastCtxUrl) {
    lastCtxUrl = canonical;
    if (!scanBusy) hideScanNotices();
    if (view.scope === "page" && lastResponse) renderResults();
  }
  renderScanStats();
  scheduleRefreshState(); // re-fetch so the per-tab scan info matches the new page
}

let ctxDebounce = null;
function scheduleContextRefresh() {
  if (ctxDebounce) clearTimeout(ctxDebounce);
  ctxDebounce = setTimeout(() => {
    ctxDebounce = null;
    refreshTabContext();
  }, 150);
}

// ---- Scan flow --------------------------------------------------------------------------

function setScanBusy(busy) {
  scanBusy = busy;
  el.scanNowBtn.disabled = busy;
  el.rescanBtn.disabled = busy;
}

function showAccessNotice(tab) {
  accessTarget = { tabId: tab.id, url: tab.url };
  const domain = pbomGetDomain(tab.url);
  el.accessNoticeText.textContent =
    "The extension doesn't have access to " +
    (domain || "this site") +
    " yet. Allow it to read this page so it can look for procurement listings. You can revoke this any time in Settings.";
  el.accessNotice.classList.remove("hidden");
}

async function runScan(rescan) {
  if (scanBusy) return;
  hideScanNotices();
  await refreshTabContext();
  const tab = currentTab;

  if (!tab || !pbomIsScannableUrl(tab.url)) {
    el.unsupportedNotice.classList.remove("hidden");
    return;
  }

  const started = Date.now();
  const seq = ++scanSeq;
  const scanTab = { id: tab.id, url: tab.url };
  setScanBusy(true);

  const term = el.searchInput.value.trim();
  const terms = term.length >= 2 ? [term] : [];

  try {
    if (rescan) {
      try {
        await sendMessageToTab(scanTab.id, { action: PBOM_ACTIONS.CLEAR_HIGHLIGHTS });
      } catch (e) {
        /* nothing injected yet — nothing to clear */
      }
    }
    const response = await sendMessageEnsuringInjected(scanTab.id, { action: PBOM_ACTIONS.SCAN_PAGE, terms });
    const stillHere = seq === scanSeq && currentTab && currentTab.id === scanTab.id;

    if (!response || !response.ok) {
      if (stillHere) showError((response && response.error) || "Unable to scan this page.");
    } else if (!response.structureFound) {
      lastScanSummary = null;
      if (stillHere) el.noTableNotice.classList.remove("hidden");
    } else {
      lastScanSummary = {
        tabId: scanTab.id,
        url: scanTab.url,
        at: Date.now(),
        text:
          "Scanned " +
          response.scannedCount +
          " listing" +
          (response.scannedCount === 1 ? "" : "s") +
          " \u00b7 " +
          response.candidateCount +
          " matched (" +
          response.qualifiedCount +
          " passed, " +
          response.optionalCount +
          " optional)" +
          (response.strategy ? " \u00b7 " + strategyLabel(response.strategy) : ""),
      };
    }
  } catch (err) {
    if (seq === scanSeq && currentTab && currentTab.id === scanTab.id) {
      if (looksLikeAccessError(err)) showAccessNotice(scanTab);
      else showError("Could not scan this page: " + errMsg(err));
    }
  } finally {
    const elapsed = Date.now() - started;
    if (elapsed < 700) await new Promise((r) => setTimeout(r, 700 - elapsed)); // let the radar readout register
    setScanBusy(false);
    await refreshTabContext();
    await refreshState();
  }
}

async function grantSiteAccess() {
  const target = accessTarget;
  if (!target) return;
  const pattern = pbomOriginPattern(target.url);
  if (!pattern) return;
  // PhilGEPS is declared in host_permissions; no per-site grant is needed.
  el.accessNotice.classList.add("hidden");
  await runScan(false);
}

// ---- Highlight / clear (per active tab) --------------------------------------------

async function runTabAction(action, failMessage) {
  hideError();
  await refreshTabContext();
  if (!currentTab || !pbomIsScannableUrl(currentTab.url)) {
    el.unsupportedNotice.classList.remove("hidden");
    return;
  }
  const tab = currentTab;
  try {
    const response = await sendMessageEnsuringInjected(tab.id, { action });
    if (!response || !response.ok) showError((response && response.error) || failMessage);
  } catch (err) {
    if (looksLikeAccessError(err)) showAccessNotice(tab);
    else showError(failMessage + " " + errMsg(err));
  }
}

// ---- Highlighting & Match Navigation (Enhanced Ctrl+F) ---------------------------

async function runHighlightMatches() {
  hideError();
  await refreshTabContext();
  if (!currentTab || !pbomIsScannableUrl(currentTab.url)) {
    el.unsupportedNotice.classList.remove("hidden");
    return;
  }
  const tab = currentTab;
  const terms = sanitizeTerms(view.query ? [view.query] : []);
  try {
    const response = await sendMessageEnsuringInjected(tab.id, {
      action: PBOM_ACTIONS.HIGHLIGHT_MATCHES,
      terms,
    });
    if (response && response.ok) {
      updateMatchCounter(response.currentIndex, response.totalCount != null ? response.totalCount : response.count);
    } else {
      showError((response && response.error) || "Unable to highlight matches.");
    }
  } catch (err) {
    if (looksLikeAccessError(err)) showAccessNotice(tab);
    else showError("Unable to highlight matches: " + errMsg(err));
  }
}

async function runClearHighlights() {
  hideError();
  await refreshTabContext();
  if (!currentTab || !pbomIsScannableUrl(currentTab.url)) return;
  try {
    await sendMessageEnsuringInjected(currentTab.id, { action: PBOM_ACTIONS.CLEAR_HIGHLIGHTS });
    updateMatchCounter(0, 0);
  } catch (err) {
    /* ignore */
  }
}

async function navigateMatch(direction) {
  if (!currentTab || !pbomIsScannableUrl(currentTab.url)) return;
  try {
    const res = await sendMessageEnsuringInjected(currentTab.id, {
      action: PBOM_ACTIONS.NAVIGATE_MATCH,
      direction,
    });
    if (res && res.ok) {
      updateMatchCounter(res.currentIndex, res.totalCount);
    }
  } catch (err) {
    /* best effort */
  }
}

function updateMatchCounter(current, total) {
  if (!el.matchCounterText) return;
  if (total > 0) {
    el.matchCounterText.textContent = `${current} of ${total}`;
  } else {
    el.matchCounterText.textContent = `0 of 0`;
  }
}

async function onHighlightFilterChange() {
  if (!currentTab || !pbomIsScannableUrl(currentTab.url)) return;
  const filterType = el.highlightFilterSelect ? el.highlightFilterSelect.value : "all";
  try {
    const terms = sanitizeTerms(view.query ? [view.query] : []);
    const res = await sendMessageEnsuringInjected(currentTab.id, {
      action: PBOM_ACTIONS.HIGHLIGHT_MATCHES,
      terms,
      filterType,
    });
    if (res && res.ok) {
      updateMatchCounter(res.currentIndex, res.totalCount != null ? res.totalCount : res.count);
    }
  } catch (err) {
    /* best effort */
  }
}

const runHighlight = runHighlightMatches;

// ---- Optional AI Model Integration ------------------------------------------------

let aiConfig = { ...PBOM_DEFAULT_AI_CONFIG };

async function loadAiSettings() {
  const stored = await chrome.storage.local.get([PBOM_STORAGE_KEYS.aiConfig]);
  aiConfig = stored[PBOM_STORAGE_KEYS.aiConfig]
    ? { ...PBOM_DEFAULT_AI_CONFIG, ...stored[PBOM_STORAGE_KEYS.aiConfig] }
    : { ...PBOM_DEFAULT_AI_CONFIG };

  if (el.aiEnabledToggle) el.aiEnabledToggle.checked = !!aiConfig.enabled;
  if (el.aiConfigFields) el.aiConfigFields.classList.toggle("hidden", !aiConfig.enabled);
  if (el.aiProviderSelect) el.aiProviderSelect.value = aiConfig.provider || "openai";
  if (el.aiEndpointInput) el.aiEndpointInput.value = aiConfig.endpoint || "";
  if (el.aiModelInput) el.aiModelInput.value = aiConfig.model || "";
  if (el.aiTokenInput) el.aiTokenInput.value = aiConfig.token || "";
  if (el.aiAutoAnalyzeToggle) el.aiAutoAnalyzeToggle.checked = !!aiConfig.autoAnalyze;

  updateAiStatusCard();
}

function updateAiStatusCard() {
  if (!el.aiStatusSubtitle || !el.aiSettingsBadge) return;
  if (!aiConfig.enabled) {
    el.aiStatusSubtitle.textContent = "Disabled (Optional)";
    el.aiSettingsBadge.textContent = "Disabled";
    el.aiSettingsBadge.className = "settings-badge";
    if (el.aiStatusCard) el.aiStatusCard.classList.remove("active");
  } else {
    const providerName = aiConfig.provider ? aiConfig.provider.toUpperCase() : "OPENAI";
    const hasToken = !!(aiConfig.token && aiConfig.token.trim());
    el.aiStatusSubtitle.textContent = hasToken ? `Ready (${providerName})` : `Token required (${providerName})`;
    el.aiSettingsBadge.textContent = hasToken ? "Ready" : "Config needed";
    el.aiSettingsBadge.className = "settings-badge " + (hasToken ? "ready" : "");
    if (el.aiStatusCard) el.aiStatusCard.classList.add("active");
  }
}

function onAiEnabledToggle() {
  const isEnabled = el.aiEnabledToggle.checked;
  if (el.aiConfigFields) el.aiConfigFields.classList.toggle("hidden", !isEnabled);
  aiConfig.enabled = isEnabled;
  updateAiStatusCard();
}

function onAiProviderChange() {
  const p = el.aiProviderSelect.value;
  if (PBOM_PROVIDER_DEFAULTS && PBOM_PROVIDER_DEFAULTS[p]) {
    el.aiEndpointInput.value = PBOM_PROVIDER_DEFAULTS[p].endpoint;
    el.aiModelInput.value = PBOM_PROVIDER_DEFAULTS[p].model;
  }
}

function toggleTokenVisibility() {
  if (!el.aiTokenInput) return;
  const isPassword = el.aiTokenInput.type === "password";
  el.aiTokenInput.type = isPassword ? "text" : "password";
  if (el.toggleTokenVisibilityBtn) {
    el.toggleTokenVisibilityBtn.innerHTML = iconMarkup(isPassword ? "eye-off" : "eye");
  }
}

async function testAiConnection() {
  if (!el.aiConnectionStatus) return;
  el.aiConnectionStatus.className = "settings-hint ai-conn-status";
  el.aiConnectionStatus.textContent = "Testing connection...";
  el.aiConnectionStatus.classList.remove("hidden");

  const testConfig = {
    provider: el.aiProviderSelect.value,
    endpoint: el.aiEndpointInput.value.trim(),
    model: el.aiModelInput.value.trim(),
    token: el.aiTokenInput.value.trim(),
  };

  try {
    const res = await sendToBackground({
      action: PBOM_ACTIONS.AI_TEST_CONNECTION,
      config: testConfig,
    });
    if (res && res.ok) {
      el.aiConnectionStatus.className = "settings-hint ai-conn-status success";
      el.aiConnectionStatus.textContent = res.message || "Connection successful!";
    } else {
      el.aiConnectionStatus.className = "settings-hint ai-conn-status error";
      el.aiConnectionStatus.textContent = (res && res.error) || "Connection test failed.";
    }
  } catch (err) {
    el.aiConnectionStatus.className = "settings-hint ai-conn-status error";
    el.aiConnectionStatus.textContent = "Connection test failed: " + errMsg(err);
  }
}

async function saveAiSettings() {
  aiConfig = {
    enabled: el.aiEnabledToggle.checked,
    provider: el.aiProviderSelect.value,
    endpoint: el.aiEndpointInput.value.trim(),
    model: el.aiModelInput.value.trim(),
    token: el.aiTokenInput.value.trim(),
    autoAnalyze: el.aiAutoAnalyzeToggle.checked,
    maxCandidatesPerScan: 5,
    timeoutMs: 15000,
  };
  await chrome.storage.local.set({ [PBOM_STORAGE_KEYS.aiConfig]: aiConfig });
  updateAiStatusCard();
  if (el.aiConnectionStatus) {
    el.aiConnectionStatus.className = "settings-hint ai-conn-status success";
    el.aiConnectionStatus.textContent = "AI settings saved successfully.";
    el.aiConnectionStatus.classList.remove("hidden");
    setTimeout(() => {
      el.aiConnectionStatus.classList.add("hidden");
    }, 3000);
  }
}

async function removeAiToken() {
  if (el.aiTokenInput) el.aiTokenInput.value = "";
  aiConfig.token = "";
  await chrome.storage.local.set({ [PBOM_STORAGE_KEYS.aiConfig]: aiConfig });
  updateAiStatusCard();
  if (el.aiConnectionStatus) {
    el.aiConnectionStatus.className = "settings-hint ai-conn-status";
    el.aiConnectionStatus.textContent = "Token removed.";
    el.aiConnectionStatus.classList.remove("hidden");
  }
}

async function runAiAnalysis() {
  if (!aiConfig.enabled) {
    showError("Please enable AI in Settings first.");
    return;
  }
  if (!aiConfig.token && aiConfig.provider !== "custom") {
    showError("Please configure an API token in Settings.");
    return;
  }
  if (!lastResponse || !lastResponse.results || lastResponse.results.length === 0) {
    showError("No opportunities available to analyze. Please scan a page first.");
    return;
  }

  if (el.aiAnalysisFeedback) {
    el.aiAnalysisFeedback.className = "ai-feedback";
    el.aiAnalysisFeedback.textContent = "Analyzing opportunities with AI model...";
    el.aiAnalysisFeedback.classList.remove("hidden");
  }
  if (el.analyzeAiBtn) el.analyzeAiBtn.disabled = true;

  try {
    const candidates = scopeResults(lastResponse.results).slice(0, 5);
    const res = await sendToBackground({
      action: PBOM_ACTIONS.AI_ANALYZE_CANDIDATES,
      candidates,
      pageUrls: [currentTab ? currentTab.url : null],
    });
    if (res && res.ok) {
      if (el.aiAnalysisFeedback) {
        el.aiAnalysisFeedback.textContent = `AI analysis complete: ${res.analyzedCount} enhanced${res.fallbackCount > 0 ? `, ${res.fallbackCount} fallback` : ""}.`;
      }
      await refreshState();
    } else {
      if (el.aiAnalysisFeedback) {
        el.aiAnalysisFeedback.className = "ai-feedback error";
        el.aiAnalysisFeedback.textContent = (res && res.error) || "AI analysis failed; retained non-AI records.";
      }
    }
  } catch (err) {
    if (el.aiAnalysisFeedback) {
      el.aiAnalysisFeedback.className = "ai-feedback error";
      el.aiAnalysisFeedback.textContent = "AI error: " + errMsg(err);
    }
  } finally {
    if (el.analyzeAiBtn) el.analyzeAiBtn.disabled = false;
    setTimeout(() => {
      if (el.aiAnalysisFeedback) el.aiAnalysisFeedback.classList.add("hidden");
    }, 4500);
  }
}

// ---- Monitoring controls ---------------------------------------------------------------

async function toggleMonitoring() {
  hideError();
  const turningOn = el.monitoringToggle.checked;
  const nextState = turningOn ? "active" : "off";
  try {
    const response = await sendToBackground({ action: PBOM_ACTIONS.SET_MONITORING_STATE, state: nextState });
    if (!response || !response.ok) {
      showError("Could not update monitoring state.");
      el.monitoringToggle.checked = !turningOn;
      return;
    }
    await refreshState();
  } catch (err) {
    showError("Could not reach the extension background: " + errMsg(err));
    el.monitoringToggle.checked = !turningOn;
  }
}

async function togglePauseResume() {
  hideError();
  const isPaused = el.monitoringCard.classList.contains("paused");
  const nextState = isPaused ? "active" : "paused";
  try {
    const response = await sendToBackground({ action: PBOM_ACTIONS.SET_MONITORING_STATE, state: nextState });
    if (!response || !response.ok) {
      showError("Could not update monitoring state.");
      return;
    }
    await refreshState();
  } catch (err) {
    showError("Could not reach the extension background: " + errMsg(err));
  }
}

async function clearResults() {
  hideError();
  const confirmed = window.confirm("Clear all collected results? Keyword and matching settings are kept.");
  if (!confirmed) return;
  try {
    const response = await sendToBackground({ action: PBOM_ACTIONS.CLEAR_RESULTS });
    if (!response || !response.ok) {
      showError("Could not clear results.");
      return;
    }
    lastScanSummary = null;
    await refreshState();
  } catch (err) {
    showError("Could not clear results: " + errMsg(err));
  }
}

// ---- Site access (Settings) ---------------------------------------------------------------

async function extraGrantedOrigins() {
  const perms = await chrome.permissions.getAll();
  return (perms.origins || []).filter((o) => !PBOM_STATIC_HOST_PATTERNS.includes(o));
}

async function updateSiteAccessUI() {
  try {
    const extra = await extraGrantedOrigins();
    if (extra.length > 0) {
      const names = extra.map((o) => o.replace(/^[a-z*]+:\/\//, "").replace(/\/\*$/, ""));
      const shown = names.slice(0, 5).join(", ") + (names.length > 5 ? " +" + (names.length - 5) + " more" : "");
      el.siteAccessStatus.textContent = "PhilGEPS only. Legacy access ignored: " + shown;
    } else {
      el.siteAccessStatus.textContent = "Only official PhilGEPS pages are allowed.";
    }
    el.grantAllSitesBtn.classList.add("hidden");
    el.revokeSitesBtn.classList.toggle("hidden", extra.length === 0);
  } catch (e) {
    el.siteAccessStatus.textContent = "";
  }
}

async function grantAllSites() {
  showError("Only official PhilGEPS pages can be scanned.");
}

async function revokeExtraSites() {
  try {
    const extra = await extraGrantedOrigins();
    if (extra.length) await chrome.permissions.remove({ origins: extra });
  } catch (err) {
    showError("Could not remove access: " + errMsg(err));
  }
  await updateSiteAccessUI();
  await refreshTabContext();
}

// ---- Panel chrome -------------------------------------------------------------------------------

async function closePanel() {
  try {
    if (chrome.sidePanel && typeof chrome.sidePanel.close === "function") {
      const win = await chrome.windows.getCurrent();
      await chrome.sidePanel.close({ windowId: win.id });
      return;
    }
  } catch (e) {
    /* fall through to window.close() */
  }
  window.close(); // supported side panel behaviour on Chrome versions without sidePanel.close()
}

function bindSegment(container, attr, onPick) {
  container.querySelectorAll(".filter-opt").forEach((btn) => {
    btn.addEventListener("click", () => {
      const value = btn.getAttribute(attr);
      setSegmentActive(container, attr, value);
      onPick(value);
      renderResults();
    });
  });
}

// ---- Init -----------------------------------------------------------------------------------

async function init() {
  hydrateIcons(document);

  const { keywords, options, theme } = await loadSettings();
  state.keywords = keywords;
  renderKeywordCount();
  setOptionsInUI(options);
  initThemeWatcher(theme);

  const monitoringPrefs = await loadMonitoringPrefs();
  el.notifyOnQualified.checked = monitoringPrefs.notifyOnQualified;
  el.persistAcrossRestart.checked = monitoringPrefs.persistAcrossRestart;

  await loadAiSettings();
  await refreshTabContext();
  await refreshState();
  await updateSiteAccessUI();

  // Live updates: results/session/monitoring changes arrive via storage events
  // (no fixed-interval polling); a slow tick keeps relative times and the
  // closing-date window fresh.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const watched = [STORAGE_KEYS.results, STORAGE_KEYS.session, STORAGE_KEYS.monitoringState, STORAGE_KEYS.unrecognizedEntities];
    if (watched.some((k) => k in changes)) scheduleRefreshState();
    if (STORAGE_KEYS.theme in changes) {
      const choice = changes[STORAGE_KEYS.theme].newValue || "system";
      document.documentElement.setAttribute("data-theme-choice", choice);
      applyTheme(choice);
    }
  });
  setInterval(refreshState, 30000);

  // Follow navigation and tab switches without rebuilding the interface.
  chrome.tabs.onActivated.addListener(() => scheduleContextRefresh());
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!currentTab || tabId !== currentTab.id) return;
    if (changeInfo.url || changeInfo.status === "complete" || changeInfo.title) scheduleContextRefresh();
  });
  chrome.windows.onFocusChanged.addListener(() => scheduleContextRefresh());
  chrome.permissions.onAdded.addListener(() => {
    updateSiteAccessUI();
    scheduleContextRefresh();
  });
  chrome.permissions.onRemoved.addListener(() => {
    updateSiteAccessUI();
    scheduleContextRefresh();
  });

  el.closePanelBtn.addEventListener("click", closePanel);

  el.settingsToggleBtn.addEventListener("click", () => {
    const isOpen = el.settingsPanel.hasAttribute("open");
    if (isOpen) {
      el.settingsPanel.removeAttribute("open");
    } else {
      el.settingsPanel.setAttribute("open", "");
      el.settingsPanel.scrollIntoView({ block: "end", behavior: "smooth" });
    }
    el.settingsToggleBtn.setAttribute("aria-expanded", String(!isOpen));
  });

  el.manageKeywordsBtn.addEventListener("click", toggleKeywordManager);
  el.keywordSearch.addEventListener("input", () => renderKeywordRows(el.keywordSearch.value));
  el.addKeywordBtn.addEventListener("click", addKeywordFromInput);
  el.newKeywordInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addKeywordFromInput();
    }
  });
  el.resetKeywordsBtn.addEventListener("click", resetKeywordsToDefaults);
  el.diagnosticsToggleBtn.addEventListener("click", toggleDiagnostics);

  el.monitoringToggle.addEventListener("change", toggleMonitoring);
  el.pauseResumeBtn.addEventListener("click", togglePauseResume);
  el.scanNowBtn.addEventListener("click", () => runScan(false));
  el.rescanBtn.addEventListener("click", () => runScan(true));
  el.grantSiteBtn.addEventListener("click", grantSiteAccess);
  el.highlightBtn.addEventListener("click", runHighlight);
  el.clearHighlightsBtn.addEventListener("click", runClearHighlights);

  // Match Navigation Controls
  if (el.highlightMatchesBtn) el.highlightMatchesBtn.addEventListener("click", runHighlightMatches);
  if (el.clearHighlightsNavBtn) el.clearHighlightsNavBtn.addEventListener("click", runClearHighlights);
  if (el.prevMatchBtn) el.prevMatchBtn.addEventListener("click", () => navigateMatch("prev"));
  if (el.nextMatchBtn) el.nextMatchBtn.addEventListener("click", () => navigateMatch("next"));
  if (el.highlightFilterSelect) el.highlightFilterSelect.addEventListener("change", onHighlightFilterChange);

  // AI Controls
  if (el.analyzeAiBtn) el.analyzeAiBtn.addEventListener("click", runAiAnalysis);
  if (el.aiEnabledToggle) el.aiEnabledToggle.addEventListener("change", onAiEnabledToggle);
  if (el.aiProviderSelect) el.aiProviderSelect.addEventListener("change", onAiProviderChange);
  if (el.toggleTokenVisibilityBtn) el.toggleTokenVisibilityBtn.addEventListener("click", toggleTokenVisibility);
  if (el.testAiConnectionBtn) el.testAiConnectionBtn.addEventListener("click", testAiConnection);
  if (el.saveAiSettingsBtn) el.saveAiSettingsBtn.addEventListener("click", saveAiSettings);
  if (el.removeAiTokenBtn) el.removeAiTokenBtn.addEventListener("click", removeAiToken);
  el.clearResultsBtn.addEventListener("click", clearResults);
  el.grantAllSitesBtn.addEventListener("click", grantAllSites);
  el.revokeSitesBtn.addEventListener("click", revokeExtraSites);

  el.searchInput.addEventListener("input", () => {
    view.query = el.searchInput.value.trim();
    updateSearchHint();
    renderResults();
  });
  el.searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runScan(false);
    } else if (e.key === "Escape" && el.searchInput.value) {
      el.searchInput.value = "";
      view.query = "";
      updateSearchHint();
      renderResults();
    }
  });
  el.searchClearBtn.addEventListener("click", () => {
    el.searchInput.value = "";
    view.query = "";
    updateSearchHint();
    renderResults();
    el.searchInput.focus();
  });

  bindSegment(el.qualFilter, "data-filter", (v) => (view.qual = v));
  bindSegment(el.scopeFilter, "data-scope", (v) => (view.scope = v));
  el.domainFilter.addEventListener("change", () => {
    view.domain = el.domainFilter.value;
    renderResults();
  });

  el.notifyOnQualified.addEventListener("change", () => {
    chrome.storage.local.set({ [STORAGE_KEYS.notifyOnQualified]: el.notifyOnQualified.checked });
  });
  el.persistAcrossRestart.addEventListener("change", () => {
    chrome.storage.local.set({ [STORAGE_KEYS.persistAcrossRestart]: el.persistAcrossRestart.checked });
  });

  [
    el.caseSensitive, el.wholeWord, el.minMatches, el.includeRelated,
    el.acronymPairing, el.negativeFiltering, el.fieldWeightedScoring
  ].filter(Boolean).forEach((input) => {
    input.addEventListener("change", () => saveOptions(getOptionsFromUI()));
  });

  el.themeSwitcher.querySelectorAll(".theme-option").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const choice = btn.getAttribute("data-theme-choice");
      document.documentElement.setAttribute("data-theme-choice", choice);
      applyTheme(choice);
      await saveTheme(choice);
    });
  });
}

init();
