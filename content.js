/* PhilGeps BidOps Matcher - content.js
 * Orchestrator. Ties together scanner.js + universal-extractor.js
 * (extraction + page-change detection), matcher.js (keywords),
 * procurement-classifier.js, procurement-adapters.js, keyword-highlighter.js,
 * location-detector.js (NCR tiers), date-validator.js (4-day window), and
 * qualifier.js (final decision). This extension is intentionally limited to
 * official PhilGEPS pages and verified PhilGEPS listing URLs.
 */

(function () {
  // Protect against stale dynamic registrations or accidental manual
  // injection. This extension only operates on official PhilGEPS pages.
  if (!pbomIsPhilgepsUrl(window.location.href)) return;

  // One live instance per page. An instance orphaned by an extension
  // reload/update reports itself dead, so a fresh injection may take over.
  if (window.__pbomAlive && window.__pbomAlive()) {
    return;
  }
  window.__pbomAlive = function () {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  };

  // ---- Cached settings (kept in sync via chrome.storage.onChanged) ----------

  let cachedKeywords = PBOM_DEFAULT_KEYWORDS.slice();
  let cachedOptions = { ...PBOM_DEFAULT_OPTIONS };
  let cachedAiConfig = { ...PBOM_DEFAULT_AI_CONFIG };

  function loadCachedSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        [PBOM_STORAGE_KEYS.keywords, PBOM_STORAGE_KEYS.options, PBOM_STORAGE_KEYS.aiConfig],
        (result) => {
          cachedKeywords = Array.isArray(result[PBOM_STORAGE_KEYS.keywords])
            ? result[PBOM_STORAGE_KEYS.keywords]
            : PBOM_DEFAULT_KEYWORDS.slice();
          cachedOptions = result[PBOM_STORAGE_KEYS.options]
            ? { ...PBOM_DEFAULT_OPTIONS, ...result[PBOM_STORAGE_KEYS.options] }
            : { ...PBOM_DEFAULT_OPTIONS };
          cachedAiConfig = result[PBOM_STORAGE_KEYS.aiConfig]
            ? { ...PBOM_DEFAULT_AI_CONFIG, ...result[PBOM_STORAGE_KEYS.aiConfig] }
            : { ...PBOM_DEFAULT_AI_CONFIG };
          resolve();
        }
      );
    });
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[PBOM_STORAGE_KEYS.keywords]) {
      cachedKeywords = Array.isArray(changes[PBOM_STORAGE_KEYS.keywords].newValue)
        ? changes[PBOM_STORAGE_KEYS.keywords].newValue
        : cachedKeywords;
    }
    if (changes[PBOM_STORAGE_KEYS.options]) {
      cachedOptions = { ...PBOM_DEFAULT_OPTIONS, ...(changes[PBOM_STORAGE_KEYS.options].newValue || {}) };
    }
    if (changes[PBOM_STORAGE_KEYS.aiConfig]) {
      cachedAiConfig = { ...PBOM_DEFAULT_AI_CONFIG, ...(changes[PBOM_STORAGE_KEYS.aiConfig].newValue || {}) };
    }
  });

  function effectiveKeywords() {
    return cachedOptions.includeRelated ? cachedKeywords.concat(PBOM_RELATED_ICT_TERMS) : cachedKeywords;
  }

  // Terms typed into the side panel's search box for ONE scan.
  function keywordsWithTerms(terms) {
    const base = effectiveKeywords();
    if (!terms || terms.length === 0) return base;
    const have = new Set(base.map((k) => String(k).trim().toLowerCase()));
    return base.concat(terms.filter((t) => !have.has(t.toLowerCase())));
  }

  function sanitizeTerms(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((t) => String(t || "").replace(/\s+/g, " ").trim().slice(0, 80))
      .filter((t) => t.length >= 2)
      .slice(0, 5);
  }

  // ---- Classification pipeline (per opportunity) -----------------------------

  function classifyOpportunity(op, now, terms) {
    const matchResult = pbomMatchKeywords(
      { title: op.title, category: op.category, rowText: op.rowText },
      keywordsWithTerms(terms),
      cachedOptions
    );
    const keywordOk = matchResult.matchedCount >= cachedOptions.minMatches;

    const location = pbomDetectLocationWithEntity({
      locationColumnText: op.locationColumnText,
      title: op.title,
      rowText: op.rowText,
      entityFieldText: op.entity,
    });

    const dateInfo = pbomClassifyClosingDate(op.closing, now);
    const publishedInfo = pbomParseGenericDate(op.publish);

    const procurementStatus =
      op.procurementStatus ||
      (typeof pbomClassifyProcurementStatus === "function"
        ? pbomClassifyProcurementStatus(op.rowText, op.title, op.url || window.location.href)
        : PBOM_PROCUREMENT_STATUS.UNVERIFIED);

    const { qualification } = pbomQualify({
      keywordOk,
      locationStatus: location.status,
      dateStatus: dateInfo.status,
      procurementStatus,
    });

    return { matchResult, keywordOk, location, dateInfo, publishedInfo, procurementStatus, qualification };
  }

  // ---- Scan state for highlighting & navigation ------------------------------

  let lastScan = null; // { byRowKey: Map, candidates: Array, terms: Array }

  function executeHighlight(terms) {
    if (!window.pbomHighlighter) return { count: 0, currentIndex: 0, totalCount: 0 };
    const activeTerms = sanitizeTerms(terms || (lastScan && lastScan.terms));
    const candidateElements = lastScan ? Array.from(lastScan.byRowKey.values()).map((v) => v.rowEl) : [];

    const status = window.pbomHighlighter.highlightMatches({
      keywords: effectiveKeywords(),
      terms: activeTerms,
      options: cachedOptions,
      candidateElements,
      filterType: "all",
    });

    return { count: status.totalCount, currentIndex: status.currentIndex, totalCount: status.totalCount };
  }

  // ---- Scan + report ------------------------------------------------------

  async function performScanAndReport(opts) {
    await loadCachedSettings();
    const terms = sanitizeTerms(opts && opts.terms);

    const { strategy, structureFound, opportunities } = pbomExtractUniversal();
    const pageUrl = window.location.href;
    const listingUrl = pbomSanitizeUrl(pageUrl);
    const sourceDomain = pbomGetDomain(pageUrl);

    if (!structureFound) {
      lastScan = null;
      return {
        tableFound: false,
        structureFound: false,
        strategy: null,
        scannedCount: 0,
        candidateCount: 0,
        qualifiedCount: 0,
        optionalCount: 0,
        potentialCount: 0,
      };
    }

    const now = new Date();
    const byRowKey = new Map();
    const candidates = [];

    opportunities.forEach((op) => {
      const result = classifyOpportunity(op, now, terms);

      byRowKey.set(op.rowKey, {
        rowEl: op.rowEl,
        titleCellEl: op.titleCellEl,
        matched: result.matchResult.matched,
        location: result.location,
        qualification: result.qualification,
      });

      if (result.qualification === PBOM_QUALIFICATION.REJECTED) return;

      const detailUrl = op.url ? pbomSanitizeUrl(op.url) : null;
      const sourceUrl = detailUrl || listingUrl;
      const linkType = detailUrl ? PBOM_LINK_TYPE.DETAIL : listingUrl ? PBOM_LINK_TYPE.LISTING : PBOM_LINK_TYPE.UNAVAILABLE;

      candidates.push({
        uid: op.uid,
        legacyUid: op.legacyUid || null,
        title: op.title,
        url: detailUrl,
        sourceUrl,
        linkType,
        sourceDomain,
        strategy,
        rowKey: op.rowKey,
        no: op.no,
        reference: op.reference || "",
        rawFields: op.rawFields || null,
        entity: op.entity,
        category: op.category,
        procurementStatus: result.procurementStatus,
        datePublished: result.publishedInfo.date ? pbomFormatIsoDateOnly(result.publishedInfo.date) : null,
        datePublishedRaw: op.publish,
        closingRaw: op.closing,
        closingDate: result.dateInfo.date ? pbomFormatIsoDateOnly(result.dateInfo.date) : null,
        closingTime: result.dateInfo.date && !result.dateInfo.approximate ? pbomFormatTimeHHMM(result.dateInfo.date) : null,
        closingIso: result.dateInfo.date ? result.dateInfo.date.toISOString() : null,
        matched: result.matchResult.matched,
        matchedCount: result.matchResult.matchedCount,
        location: {
          status: result.location.status,
          detected: result.location.detected,
          source: result.location.source,
          verificationMethod: result.location.verificationMethod,
        },
        governmentEntity: result.location.governmentEntity || null,
        governmentEntityConfidence: result.location.governmentEntityConfidence || null,
        unknownEntityRaw: result.location.unknownEntityRaw || null,
        qualification: result.qualification,
        sourcePageUrl: pageUrl,
        sourcePageTitle: document.title,
      });
    });

    lastScan = { byRowKey, candidates, terms };

    const qualifiedCount = candidates.filter((c) => c.qualification === PBOM_QUALIFICATION.QUALIFIED).length;
    const optionalCount = candidates.filter((c) => c.qualification === PBOM_QUALIFICATION.OPTIONAL_PASSED).length;
    const potentialCount = candidates.filter(
      (c) => c.qualification === PBOM_QUALIFICATION.POTENTIAL_MATCH || c.qualification === PBOM_QUALIFICATION.NEEDS_VERIFICATION
    ).length;

    const summary = {
      tableFound: true,
      structureFound: true,
      strategy,
      scannedCount: opportunities.length,
      candidateCount: candidates.length,
      qualifiedCount,
      optionalCount,
      potentialCount,
    };

    if (extensionAlive()) {
      try {
        await chrome.runtime.sendMessage({
          action: PBOM_ACTIONS.OPPORTUNITIES_FOUND,
          pageUrl,
          pageTitle: document.title,
          scannedCount: opportunities.length,
          strategy,
          candidates,
        });
      } catch (e) {
        // Background may be waking up; not fatal for the local scan result.
      }
    }

    return summary;
  }

  // ---- Automatic monitoring lifecycle ---------------------------------------

  let monitoringState = PBOM_MONITORING_STATES.OFF;
  let observersRunning = false;
  let stopObserving = null;

  const IS_PHILGEPS = pbomIsPhilgepsUrl(window.location.href);
  const MIN_AUTO_SCAN_INTERVAL_MS = 2500;
  const GIVE_UP_AFTER_EMPTY_SCANS = 6;
  let lastAutoScanAt = 0;
  let pendingAutoScan = null;
  let emptyStreak = 0;
  let autoScanRunning = false;

  function extensionAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function registerPage() {
    if (!extensionAlive()) return;
    try {
      const pending = chrome.runtime.sendMessage({ action: PBOM_ACTIONS.PAGE_REGISTERED, url: window.location.href });
      if (pending && typeof pending.catch === "function") pending.catch(() => {});
    } catch (e) {
      // Context invalidated mid-call
    }
  }

  async function runAutoScan() {
    if (autoScanRunning) return;
    autoScanRunning = true;
    lastAutoScanAt = Date.now();
    try {
      const result = await performScanAndReport();
      if (result.structureFound) {
        emptyStreak = 0;
        registerPage();
      } else {
        emptyStreak++;
        if (IS_PHILGEPS) registerPage();
        if (!IS_PHILGEPS && emptyStreak >= GIVE_UP_AFTER_EMPTY_SCANS) teardownObservers();
      }
    } finally {
      autoScanRunning = false;
    }
  }

  function requestAutoScan() {
    if (!extensionAlive()) {
      teardownObservers();
      return;
    }
    if (monitoringState !== PBOM_MONITORING_STATES.ACTIVE) return;
    const wait = MIN_AUTO_SCAN_INTERVAL_MS - (Date.now() - lastAutoScanAt);
    if (wait > 0) {
      if (!pendingAutoScan) {
        pendingAutoScan = setTimeout(() => {
          pendingAutoScan = null;
          requestAutoScan();
        }, wait);
      }
      return;
    }
    runAutoScan();
  }

  function ensureObserversRunning() {
    if (observersRunning) return;
    observersRunning = true;
    stopObserving = IS_PHILGEPS
      ? pbomObservePageChanges(requestAutoScan, 600)
      : pbomObservePageChanges(requestAutoScan, 1500, { characterData: false });
  }

  function teardownObservers() {
    observersRunning = false;
    if (pendingAutoScan) {
      clearTimeout(pendingAutoScan);
      pendingAutoScan = null;
    }
    if (stopObserving) {
      stopObserving();
      stopObserving = null;
    }
  }

  function applyMonitoringState(nextState) {
    monitoringState = nextState;
    if (nextState === PBOM_MONITORING_STATES.OFF) {
      teardownObservers();
      return;
    }
    ensureObserversRunning();
    if (nextState === PBOM_MONITORING_STATES.ACTIVE) {
      emptyStreak = 0;
      requestAutoScan();
    }
  }

  async function initMonitoringFromStorage() {
    const stored = await new Promise((resolve) => chrome.storage.local.get([PBOM_STORAGE_KEYS.monitoringState], resolve));
    const initial = stored[PBOM_STORAGE_KEYS.monitoringState] || PBOM_MONITORING_STATES.OFF;
    if (initial !== PBOM_MONITORING_STATES.OFF) {
      applyMonitoringState(initial);
    }
  }

  // ---- Message handling ---------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      try {
        if (message.action === PBOM_ACTIONS.PING) {
          sendResponse({ ok: true });
          return;
        }

        if (message.action === PBOM_ACTIONS.SCAN_PAGE) {
          const result = await performScanAndReport({ terms: message.terms });
          sendResponse({ ok: true, ...result });
          return;
        }

        if (message.action === PBOM_ACTIONS.HIGHLIGHT_MATCHES) {
          const status = executeHighlight(message.terms);
          sendResponse({ ok: true, count: status.count, currentIndex: status.currentIndex, totalCount: status.totalCount });
          return;
        }

        if (message.action === PBOM_ACTIONS.CLEAR_HIGHLIGHTS) {
          const count = window.pbomHighlighter ? window.pbomHighlighter.clearHighlights() : 0;
          sendResponse({ ok: true, count });
          return;
        }

        if (message.action === PBOM_ACTIONS.NAVIGATE_MATCH) {
          if (!window.pbomHighlighter) {
            sendResponse({ ok: false, error: "Highlighter not initialized" });
            return;
          }
          const navResult = window.pbomHighlighter.navigateMatch(message.direction);
          sendResponse({ ok: true, ...navResult });
          return;
        }

        if (message.action === PBOM_ACTIONS.GET_MATCH_STATUS) {
          if (!window.pbomHighlighter) {
            sendResponse({ ok: true, totalCount: 0, currentIndex: 0 });
            return;
          }
          const status = window.pbomHighlighter.getMatchStatus();
          sendResponse({ ok: true, ...status });
          return;
        }

        if (message.action === PBOM_ACTIONS.SCROLL_TO_OPPORTUNITY) {
          if (!window.pbomHighlighter) {
            sendResponse({ ok: false, error: "Highlighter not initialized" });
            return;
          }
          let targetEl = null;
          if (message.rowKey) {
            targetEl = document.querySelector(`[${PBOM_ROW_ID_ATTR}="${message.rowKey}"]`);
          }
          if (!targetEl && lastScan && message.uid) {
            const match = lastScan.candidates.find((c) => c.uid === message.uid);
            if (match && match.rowKey) {
              targetEl = document.querySelector(`[${PBOM_ROW_ID_ATTR}="${match.rowKey}"]`);
            }
          }
          if (targetEl) {
            window.pbomHighlighter.scrollToOpportunityElement(targetEl);
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false, error: "Opportunity element not found on page" });
          }
          return;
        }

        if (message.action === PBOM_ACTIONS.MONITORING_STATE_CHANGED) {
          applyMonitoringState(message.state || PBOM_MONITORING_STATES.OFF);
          sendResponse({ ok: true });
          return;
        }

        sendResponse({ ok: false, error: "Unknown action." });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  });

  // ---- Init -----------------------------------------------------------------

  loadCachedSettings().then(initMonitoringFromStorage);
})();
