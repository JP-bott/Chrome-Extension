/* PhilGeps BidOps Matcher - background.js
 * MV3 service worker. Aggregates candidates reported by content scripts,
 * deduplicates by uid, and recomputes qualification fresh on every read
 * (GET_STATE) since the 4-day window and expiry shift with the clock even
 * when nothing on any PhilGEPS page has changed.
 */

importScripts(
  "constants.js",
  "url-utils.js",
  "governmentEntities.js",
  "entity-detector.js",
  "date-validator.js",
  "location-detector.js",
  "procurement-classifier.js",
  "ai-provider.js",
  "ai-client.js",
  "matcher.js",
  "qualifier.js"
);

const DYNAMIC_SCRIPT_ID = "pbom-universal";
const TAB_SCANS_KEY = "pbom_tabScans"; // chrome.storage.session: { [tabId]: {url,title,at,strategy,scannedCount,matchedCount} }
const NOTIFIED_CAP = 500;

let stateCache = null;
const memTabScans = {}; // fallback when chrome.storage.session is unavailable
const recentNudges = new Map(); // tabId -> {url, at}: stops duplicate injections/scans on rapid events

// The service worker can be suspended at any time: nothing below relies on
// module state surviving. Everything durable is in chrome.storage; the
// in-memory cache is only a read-through optimisation.

// Serialises message handling so two content scripts reporting at once can
// never interleave their read-modify-write of the shared state.
let messageQueue = Promise.resolve();
function enqueue(task) {
  const run = messageQueue.then(task, task);
  messageQueue = run.catch(() => {});
  return run;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pbomNormalizeWhitespace(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function pbomSimpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Makes a stored record safe and uniform. Idempotent, so it doubles as the
 * migration for records saved by earlier versions:
 *  - the display "reason" field is removed
 *  - the link is re-validated (http/https only); sourceUrl is the detail
 *    link when one exists, else the genuine listing page, else unavailable
 *  - sourceDomain is filled in
 */
function mvRecordSafeUid(rec) {
  if (!rec || typeof rec !== "object") return null;
  if (rec.uid) return rec.uid;

  const candidateUrl = rec.url || rec.sourceUrl || rec.sourcePageUrl || rec.detailUrl || rec.listingUrl;
  const canonical = candidateUrl ? pbomCanonicalizeUrl(candidateUrl) : null;
  if (canonical) return "url:" + canonical;

  const refText = pbomNormalizeWhitespace(rec.reference || rec.ref || rec.solicitationNumber || "");
  if (refText) return "ref:" + refText.toUpperCase();

  const title = pbomNormalizeWhitespace(rec.title || "");
  const closing = pbomNormalizeWhitespace(rec.closing || rec.closingRaw || "");
  const entity = pbomNormalizeWhitespace(rec.entity || rec.governmentEntity || "");
  const composite = [title, closing, entity].join("|").toUpperCase();
  return composite ? "composite:" + pbomSimpleHash(composite) : null;
}

function normalizeRecord(rec) {
  if (!rec || typeof rec !== "object") return null;
  const safe = { ...rec };
  delete safe.reason;
  delete safe.legacyUid;
  const detail = pbomSanitizeUrl(safe.url);
  const listing = pbomSanitizeUrl(safe.sourcePageUrl);
  safe.url = detail || null;
  safe.sourceUrl = detail || listing || null;
  safe.linkType = detail ? PBOM_LINK_TYPE.DETAIL : listing ? PBOM_LINK_TYPE.LISTING : PBOM_LINK_TYPE.UNAVAILABLE;
  safe.sourceDomain = pbomGetDomain(safe.sourceUrl || safe.sourcePageUrl || "") || safe.sourceDomain || "";
  if (!safe.reference) safe.reference = "";
  if (!safe.procurementStatus) safe.procurementStatus = PBOM_PROCUREMENT_STATUS.UNVERIFIED;
  if (!safe.uid) safe.uid = mvRecordSafeUid(safe);
  if (!safe.firstSeenAt) safe.firstSeenAt = new Date().toISOString();
  if (!safe.lastSeenAt) safe.lastSeenAt = safe.firstSeenAt;
  return safe;
}

function migrateStoredCandidates(rawCandidates) {
  const fallback = {};
  if (!rawCandidates || typeof rawCandidates !== "object") return fallback;

  const entries = Array.isArray(rawCandidates) ? rawCandidates : Object.values(rawCandidates);
  entries.forEach((entry) => {
    if (!entry || typeof entry !== "object") return;
    const rec = normalizeRecord(entry);
    if (!rec || !rec.uid) return;
    fallback[rec.uid] = { ...rec };
  });

  return fallback;
}

function migrateStoredState(stored) {
  const sanitized = {};
  sanitized.candidates = migrateStoredCandidates(
    (stored && stored[PBOM_STORAGE_KEYS.results] && stored[PBOM_STORAGE_KEYS.results].candidates) ||
    stored[PBOM_STORAGE_KEYS.results] ||
    {}
  );
  sanitized.session = (stored && stored[PBOM_STORAGE_KEYS.session]) || { pagesMonitored: [], opportunitiesScanned: 0, lastScanAt: null };
  sanitized.monitoringState = (stored && stored[PBOM_STORAGE_KEYS.monitoringState]) || PBOM_MONITORING_STATES.OFF;
  sanitized.notifyOnQualified = !!(stored && stored[PBOM_STORAGE_KEYS.notifyOnQualified]);
  sanitized.persistAcrossRestart = (stored && stored[PBOM_STORAGE_KEYS.persistAcrossRestart]) !== false;
  sanitized.unrecognizedEntities = (stored && stored[PBOM_STORAGE_KEYS.unrecognizedEntities]) || {};
  sanitized.notified = (stored && stored[PBOM_STORAGE_KEYS.notified]) || {};
  sanitized.schemaVersion = Number((stored && stored[PBOM_STORAGE_KEYS.schemaVersion]) || PBOM_STORAGE_SCHEMA_VERSION);
  return sanitized;
}

async function loadState() {
  if (stateCache) return stateCache;
  let stored = {};
  try {
    stored = await chrome.storage.local.get([
      PBOM_STORAGE_KEYS.schemaVersion,
      PBOM_STORAGE_KEYS.results,
      PBOM_STORAGE_KEYS.session,
      PBOM_STORAGE_KEYS.monitoringState,
      PBOM_STORAGE_KEYS.notifyOnQualified,
      PBOM_STORAGE_KEYS.persistAcrossRestart,
      PBOM_STORAGE_KEYS.unrecognizedEntities,
      PBOM_STORAGE_KEYS.notified,
    ]);
  } catch (e) {
    stored = {};
  }

  const migrated = migrateStoredState(stored);
  stateCache = {
    candidates: migrated.candidates,
    session: migrated.session,
    monitoringState: migrated.monitoringState,
    notifyOnQualified: migrated.notifyOnQualified,
    persistAcrossRestart: migrated.persistAcrossRestart,
    unrecognizedEntities: migrated.unrecognizedEntities,
    notified: migrated.notified,
    schemaVersion: migrated.schemaVersion,
  };
  return stateCache;
}

// Settings the side panel writes straight to storage must reach a cache that
// may already be loaded (a suspended worker reloads fresh, a live one would
// otherwise keep the old value).
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !stateCache) return;
  if (changes[PBOM_STORAGE_KEYS.notifyOnQualified]) stateCache.notifyOnQualified = !!changes[PBOM_STORAGE_KEYS.notifyOnQualified].newValue;
  if (changes[PBOM_STORAGE_KEYS.persistAcrossRestart]) stateCache.persistAcrossRestart = changes[PBOM_STORAGE_KEYS.persistAcrossRestart].newValue !== false;
  if (changes[PBOM_STORAGE_KEYS.monitoringState]) stateCache.monitoringState = changes[PBOM_STORAGE_KEYS.monitoringState].newValue || PBOM_MONITORING_STATES.OFF;
});

async function persistState() {
  const payload = {
    [PBOM_STORAGE_KEYS.schemaVersion]: PBOM_STORAGE_SCHEMA_VERSION,
    [PBOM_STORAGE_KEYS.results]: {
      version: PBOM_STORAGE_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      candidates: stateCache.candidates,
    },
    [PBOM_STORAGE_KEYS.session]: stateCache.session,
    [PBOM_STORAGE_KEYS.unrecognizedEntities]: stateCache.unrecognizedEntities,
    [PBOM_STORAGE_KEYS.notified]: stateCache.notified,
  };

  try {
    await chrome.storage.local.set(payload);
  } catch (e) {
    console.warn("[PBOM] result storage failed:", e && e.message ? e.message : e);
    throw e;
  }
}

// ---- Per-tab scan bookkeeping (kept in storage.session so it survives worker restarts) ----

async function readTabScans() {
  try {
    const got = await chrome.storage.session.get(TAB_SCANS_KEY);
    return got[TAB_SCANS_KEY] || {};
  } catch (e) {
    return memTabScans;
  }
}

async function writeTabScans(map) {
  const ids = Object.keys(map);
  if (ids.length > 60) {
    ids
      .sort((x, y) => (map[x].at || 0) - (map[y].at || 0))
      .slice(0, ids.length - 60)
      .forEach((id) => delete map[id]);
  }
  try {
    await chrome.storage.session.set({ [TAB_SCANS_KEY]: map });
  } catch (e) {
    Object.keys(memTabScans).forEach((k) => delete memTabScans[k]);
    Object.assign(memTabScans, map);
  }
}

async function setTabScan(tabId, info) {
  if (tabId == null) return;
  const map = await readTabScans();
  map[tabId] = info;
  await writeTabScans(map);
}

async function getTabScan(tabId) {
  if (tabId == null) return null;
  const map = await readTabScans();
  return map[tabId] || null;
}

/**
 * Sort priority (Part 15):
 *   1. Date Published — newest first
 *   2. Qualification status — QUALIFIED before OPTIONAL_PASSED
 *   3. Closing Date — soonest first
 *   4. Matched keyword count — highest first
 *   5. First seen — newest first
 */
function pbomCompareResults(a, b) {
  const pa = a.datePublished ? new Date(a.datePublished + "T00:00:00").getTime() : -Infinity;
  const pb = b.datePublished ? new Date(b.datePublished + "T00:00:00").getTime() : -Infinity;
  if (pa !== pb) return pb - pa;

  if (a.qualification !== b.qualification) {
    return a.qualification === PBOM_QUALIFICATION.QUALIFIED ? -1 : 1;
  }

  const ca = a.closingDate ? new Date(a.closingDate + "T00:00:00").getTime() : Infinity;
  const cb = b.closingDate ? new Date(b.closingDate + "T00:00:00").getTime() : Infinity;
  if (ca !== cb) return ca - cb;

  if ((b.matchedCount || 0) !== (a.matchedCount || 0)) return (b.matchedCount || 0) - (a.matchedCount || 0);

  const fa = a.firstSeenAt ? new Date(a.firstSeenAt).getTime() : 0;
  const fb = b.firstSeenAt ? new Date(b.firstSeenAt).getTime() : 0;
  return fb - fa;
}

/**
 * Recomputes qualification for every stored candidate against the current
 * time. Closing-date rejection follows the existing retention behavior;
 * publication-ineligible records remain stored for diagnostics/history but
 * are omitted from the displayed list. Returns one combined, fully sorted
 * list (Part 15 priority) plus counts — grouping by Date Published for
 * display is left to the popup.
 */
function pruneAndClassify(state) {
  const now = new Date();
  const results = [];
  let qualifiedCount = 0;
  let optionalPassedCount = 0;
  let potentialCount = 0;
  let verificationCount = 0;

  Object.keys(state.candidates).forEach((uid) => {
    const record = state.candidates[uid];
    const dateInfo = pbomClassifyClosingDate(record.closingRaw, now);
    const publicationEligibility = pbomClassifyPublicationEligibility(record.datePublishedRaw || record.datePublished, now);

    record.publicationEligibility = publicationEligibility.status;
    record.publicationEligibilityReason = publicationEligibility.reason || null;

    // Keep records in durable storage for history and diagnostics, but never
    // expose a verified publication date outside the allowed window.
    if (publicationEligibility.status === "OUTSIDE_WINDOW") return;

    // Active opportunities expire when closing date passes or exceeds 4 days
    if (record.procurementStatus === PBOM_PROCUREMENT_STATUS.ACTIVE &&
        (dateInfo.status === PBOM_DATE_STATUS.EXPIRED || dateInfo.status === PBOM_DATE_STATUS.BEYOND_WINDOW)) {
      delete state.candidates[uid];
      return;
    }

    // Opportunities whose closing date could never be verified don't expire
    // by date, so retire them once they haven't been seen for a long time.
    if (dateInfo.status === PBOM_DATE_STATUS.INVALID && record.lastSeenAt) {
      const ageMs = now.getTime() - new Date(record.lastSeenAt).getTime();
      if (ageMs > PBOM_UNDATED_RETENTION_DAYS * 24 * 60 * 60 * 1000) {
        delete state.candidates[uid];
        return;
      }
    }

    let { qualification } = pbomQualify({
      keywordOk: true,
      locationStatus: record.location ? record.location.status : PBOM_LOCATION_STATUS.UNVERIFIED,
      dateStatus: dateInfo.status,
      procurementStatus: record.procurementStatus,
    });

    if (publicationEligibility.status === "VERIFY") {
      qualification = PBOM_QUALIFICATION.NEEDS_VERIFICATION;
    }

    if (qualification === PBOM_QUALIFICATION.REJECTED) {
      delete state.candidates[uid];
      return;
    }

    const enriched = {
      ...record,
      qualification,
      remainingMs: dateInfo.remainingMs,
      remainingText: dateInfo.remainingText,
      closingApproximate: dateInfo.approximate,
    };

    if (qualification === PBOM_QUALIFICATION.QUALIFIED) qualifiedCount++;
    else if (qualification === PBOM_QUALIFICATION.OPTIONAL_PASSED) optionalPassedCount++;
    else if (qualification === PBOM_QUALIFICATION.POTENTIAL_MATCH) potentialCount++;
    else if (qualification === PBOM_QUALIFICATION.NEEDS_VERIFICATION) verificationCount++;

    results.push(enriched);
  });

  results.sort(pbomCompareResults);

  return { results, qualifiedCount, optionalPassedCount, potentialCount, verificationCount };
}

async function updateBadge() {
  const state = await loadState();
  const { qualifiedCount } = pruneAndClassify(state);
  try {
    await chrome.action.setBadgeText({ text: qualifiedCount > 0 ? String(qualifiedCount) : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#1c8a52" });
  } catch (e) {
    /* badge is cosmetic */
  }
}

// ---- Site access -----------------------------------------------------------------------------------------

/**
 * True when the extension may script this URL. The only supported origins are
 * covered by the static PhilGEPS host permissions.
 */
async function hasHostAccess(url) {
  if (!pbomIsScannableUrl(url)) return false;
  if (pbomIsPhilgepsUrl(url)) return true;
  const pattern = pbomOriginPattern(url);
  if (!pattern) return false;
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch (e) {
    return false;
  }
}

async function pingTab(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { action: PBOM_ACTIONS.PING });
    return !!(r && r.ok);
  } catch (e) {
    return false;
  }
}

async function ensureInjected(tabId) {
  if (await pingTab(tabId)) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: PBOM_CONTENT_SCRIPT_FILES });
    return true;
  } catch (e) {
    return false; // restricted page, permission revoked, tab closed mid-navigation...
  }
}

/** Tells one tab to (re)evaluate itself under the current monitoring state. */
async function nudgeTab(tab, minGapMs) {
  if (!tab || tab.id == null || !tab.url || tab.discarded) return;
  const state = await loadState();
  if (state.monitoringState !== PBOM_MONITORING_STATES.ACTIVE) return;

  const prev = recentNudges.get(tab.id);
  const now = Date.now();
  if (prev && prev.url === tab.url && now - prev.at < (minGapMs || 4000)) return;
  recentNudges.set(tab.id, { url: tab.url, at: now });

  if (!(await hasHostAccess(tab.url))) return;
  if (!(await ensureInjected(tab.id))) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { action: PBOM_ACTIONS.MONITORING_STATE_CHANGED, state: PBOM_MONITORING_STATES.ACTIVE });
  } catch (e) {
    /* tab navigated away between inject and message — harmless */
  }
}

async function listWebTabs() {
  try {
    return await chrome.tabs.query({ url: PBOM_PHILGEPS_HOST_PATTERNS });
  } catch (e) {
    return [];
  }
}

async function broadcastMonitoringState(monitoringState) {
  const tabs = await listWebTabs();
  for (const tab of tabs) {
    if (tab.id == null || tab.discarded || !(await hasHostAccess(tab.url))) continue;
    if (monitoringState === PBOM_MONITORING_STATES.ACTIVE) {
      recentNudges.delete(tab.id);
      await nudgeTab(tab, 0);
    } else {
      // Only talk to tabs that already run the pipeline; never inject just to say "stop".
      chrome.tabs.sendMessage(tab.id, { action: PBOM_ACTIONS.MONITORING_STATE_CHANGED, state: monitoringState }).catch(() => {});
    }
  }
}

/**
 * Keeps one registered content script in sync with the sites the user has
 * granted. With it, granted sites start monitoring at page load without the
 * worker having to be awake. Nothing is registered while monitoring is Off or
 * when no extra sites have been granted.
 */
async function syncDynamicContentScripts() {
  try {
    const state = await loadState();
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [DYNAMIC_SCRIPT_ID] });
    // Static content scripts already cover every approved PhilGEPS pattern.
    // Keep this empty so registrations left by older versions are removed and
    // no previously granted unrelated origin can become executable again.
    const origins = [];
    const wanted = state.monitoringState !== PBOM_MONITORING_STATES.OFF && origins.length > 0;

    if (!wanted) {
      if (existing.length > 0) await chrome.scripting.unregisterContentScripts({ ids: [DYNAMIC_SCRIPT_ID] });
      return;
    }
    const definition = {
      id: DYNAMIC_SCRIPT_ID,
      matches: origins,
      js: PBOM_CONTENT_SCRIPT_FILES,
      runAt: "document_idle",
      persistAcrossSessions: true,
    };
    if (existing.length > 0) await chrome.scripting.updateContentScripts([definition]);
    else await chrome.scripting.registerContentScripts([definition]);
  } catch (e) {
    console.warn("[PBOM] could not sync content scripts:", e && e.message ? e.message : e);
  }
}

// ---- Scheduling (chrome.alarms; no setInterval, no always-on loop) -----------------------------------

async function syncSweepAlarm() {
  try {
    const state = await loadState();
    const existing = await chrome.alarms.get(PBOM_ALARM_SWEEP);
    if (state.monitoringState === PBOM_MONITORING_STATES.OFF) {
      if (existing) await chrome.alarms.clear(PBOM_ALARM_SWEEP);
      return;
    }
    if (!existing) await chrome.alarms.create(PBOM_ALARM_SWEEP, { delayInMinutes: PBOM_SWEEP_MINUTES, periodInMinutes: PBOM_SWEEP_MINUTES });
  } catch (e) {
    /* alarms unavailable: monitoring still works through tab events */
  }
}

/**
 * Periodic housekeeping while monitoring is on: re-classify stored results
 * against the clock (expired / out-of-window entries are pruned), refresh the
 * badge, and give open, accessible tabs a bounded rescan so listings that
 * changed while nobody was looking are picked up. It only covers pages that
 * are open; it does not crawl the web.
 */
async function runSweep() {
  await enqueue(async () => {
    const state = await loadState();
    if (state.monitoringState === PBOM_MONITORING_STATES.OFF) return;
    pruneAndClassify(state);
    await persistState();
    await updateBadge();
  });
  const state = await loadState();
  if (state.monitoringState !== PBOM_MONITORING_STATES.ACTIVE) return;
  const tabs = (await listWebTabs()).filter((t) => !t.discarded && t.status === "complete").slice(0, 20);
  for (const tab of tabs) {
    recentNudges.delete(tab.id);
    await nudgeTab(tab, 0);
    await sleep(200);
  }
}

// ---- Notifications -------------------------------------------------------------------------------------------------

function notifyNewQualified(record) {
  try {
    const lines = [record.title];
    if (record.closingRaw) lines.push("Closes: " + record.closingRaw);
    chrome.notifications.create("pbom-" + record.uid, {
      type: "basic",
      iconUrl: "assets/icons/icon-128.png",
      title: "New passed procurement opportunity",
      message: lines.join("\n"),
      contextMessage: record.sourceDomain || "",
      priority: 1,
    });
  } catch (e) {
    // Notifications are best-effort; never block scanning on a failure here.
  }
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (!notificationId || !notificationId.startsWith("pbom-")) return;
  try {
    const state = await loadState();
    const record = state.candidates[notificationId.slice(5)];
    const url = record && pbomSanitizeUrl(record.sourceUrl);
    if (url) await chrome.tabs.create({ url });
    chrome.notifications.clear(notificationId);
  } catch (e) {
    /* nothing to open */
  }
});

function rememberNotified(state, uid) {
  state.notified[uid] = new Date().toISOString();
  const keys = Object.keys(state.notified);
  if (keys.length > NOTIFIED_CAP) {
    keys
      .sort((a, b) => (state.notified[a] < state.notified[b] ? -1 : 1))
      .slice(0, keys.length - NOTIFIED_CAP + 100)
      .forEach((k) => delete state.notified[k]);
  }
}

// ---- Message handling --------------------------------------------------------------------------------------------

async function handleMessage(message, sender) {
  const state = await loadState();

  function senderIsApprovedPhilgepsPage(requirePageUrl) {
    const senderUrl = sender && sender.tab && sender.tab.url;
    if (!pbomIsPhilgepsUrl(senderUrl)) return false;
    return !requirePageUrl || pbomIsPhilgepsUrl(requirePageUrl);
  }

  switch (message.action) {
    case PBOM_ACTIONS.PAGE_REGISTERED: {
      const url = message.url;
      if (!senderIsApprovedPhilgepsPage(url)) return { ok: false, error: "Only PhilGEPS pages may be monitored." };
      if (url && !state.session.pagesMonitored.includes(url)) {
        state.session.pagesMonitored.push(url);
        if (state.session.pagesMonitored.length > PBOM_MAX_PAGES_TRACKED) {
          state.session.pagesMonitored = state.session.pagesMonitored.slice(-PBOM_MAX_PAGES_TRACKED);
        }
        await persistState();
      }
      return { ok: true };
    }

    case PBOM_ACTIONS.OPPORTUNITIES_FOUND: {
      if (!senderIsApprovedPhilgepsPage(message.pageUrl)) {
        return { ok: false, error: "Only PhilGEPS pages may report opportunities." };
      }
      // Automatic re-scans are already gated to ACTIVE state inside the
      // content script; manual "Scan Page" is allowed to report regardless of
      // monitoring state. No gate here.
      const nowIso = new Date().toISOString();
      const notifyCandidates = [];

      (message.candidates || []).forEach((c) => {
        let existing = state.candidates[c.uid];
        let legacyNotified = false;

        // Fold a record saved under the pre-canonical uid scheme into the new
        // uid so an upgrade neither duplicates results nor re-notifies.
        if (!existing && c.legacyUid && c.legacyUid !== c.uid && state.candidates[c.legacyUid]) {
          existing = state.candidates[c.legacyUid];
          delete state.candidates[c.legacyUid];
        }
        if (c.legacyUid && state.notified[c.legacyUid]) legacyNotified = true;

        const isNew = !existing && !state.notified[c.uid] && !legacyNotified;
        state.candidates[c.uid] = normalizeRecord({
          ...c,
          firstSeenAt: existing ? existing.firstSeenAt : nowIso,
          lastSeenAt: nowIso,
        });
        if (isNew) notifyCandidates.push(c.uid);

        // Diagnostics queue: procuring entities that looked like an entity
        // name but matched nothing in governmentEntities.js. Never shown in
        // the main results — Settings/Diagnostics only.
        if (c.unknownEntityRaw) {
          const key = c.unknownEntityRaw.trim().toUpperCase();
          const existingEntry = state.unrecognizedEntities[key];
          state.unrecognizedEntities[key] = {
            rawText: c.unknownEntityRaw.trim(),
            count: existingEntry ? existingEntry.count + 1 : 1,
            lastSeenAt: nowIso,
          };
        }
      });

      state.session.opportunitiesScanned += message.scannedCount || 0;
      state.session.lastScanAt = nowIso;
      if (message.pageUrl && !state.session.pagesMonitored.includes(message.pageUrl)) {
        state.session.pagesMonitored.push(message.pageUrl);
        if (state.session.pagesMonitored.length > PBOM_MAX_PAGES_TRACKED) {
          state.session.pagesMonitored = state.session.pagesMonitored.slice(-PBOM_MAX_PAGES_TRACKED);
        }
      }

      if (state.notifyOnQualified && notifyCandidates.length > 0) {
        const { results } = pruneAndClassify(state);
        const byUid = new Map(results.map((r) => [r.uid, r]));
        notifyCandidates.forEach((uid) => {
          const record = byUid.get(uid);
          if (record && record.qualification === PBOM_QUALIFICATION.QUALIFIED && !state.notified[uid]) {
            notifyNewQualified(record);
            rememberNotified(state, uid);
          }
        });
      }

      await persistState();
      await updateBadge();
      await setTabScan(sender && sender.tab ? sender.tab.id : null, {
        url: message.pageUrl || (sender && sender.tab && sender.tab.url) || "",
        title: message.pageTitle || "",
        at: Date.now(),
        strategy: message.strategy || null,
        scannedCount: message.scannedCount || 0,
        matchedCount: (message.candidates || []).length,
      });
      return { ok: true };
    }

    case PBOM_ACTIONS.GET_STATE: {
      const { results, qualifiedCount, optionalPassedCount, potentialCount, verificationCount } = pruneAndClassify(state);
      await persistState();
      await updateBadge();

      const unrecognizedEntities = Object.values(state.unrecognizedEntities)
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);

      return {
        ok: true,
        monitoringState: state.monitoringState,
        notifyOnQualified: state.notifyOnQualified,
        persistAcrossRestart: state.persistAcrossRestart,
        session: state.session,
        results,
        history: results,
        qualifiedCount,
        optionalPassedCount,
        potentialCount: potentialCount || 0,
        verificationCount: verificationCount || 0,
        unrecognizedEntities,
        tabScan: await getTabScan(message.tabId),
      };
    }

    case PBOM_ACTIONS.AI_TEST_CONNECTION: {
      return await pbomTestAiConnection(message.config);
    }

    case PBOM_ACTIONS.AI_ANALYZE_CANDIDATES: {
      const stored = await chrome.storage.local.get([PBOM_STORAGE_KEYS.aiConfig]);
      const config = stored[PBOM_STORAGE_KEYS.aiConfig] || PBOM_DEFAULT_AI_CONFIG;
      if (!config.enabled) {
        return { ok: false, error: "AI assistance is disabled in Settings." };
      }
      const toAnalyze = message.candidates && message.candidates.length > 0
        ? message.candidates
        : Object.values(state.candidates);
      const res = await pbomBatchAnalyzeCandidates(toAnalyze, config, message.pageUrls);
      (res.candidates || []).forEach((c) => {
        if (state.candidates[c.uid]) {
          state.candidates[c.uid] = normalizeRecord({ ...state.candidates[c.uid], ...c });
        }
      });
      await persistState();
      return { ok: true, analyzedCount: res.analyzedCount, fallbackCount: res.fallbackCount, candidates: res.candidates };
    }

    case PBOM_ACTIONS.SET_MONITORING_STATE: {
      const next = message.state;
      if (![PBOM_MONITORING_STATES.ACTIVE, PBOM_MONITORING_STATES.PAUSED, PBOM_MONITORING_STATES.OFF].includes(next)) {
        return { ok: false, error: "Invalid monitoring state." };
      }
      state.monitoringState = next;
      await chrome.storage.local.set({ [PBOM_STORAGE_KEYS.monitoringState]: next });
      await syncSweepAlarm();
      await syncDynamicContentScripts();
      // Not awaited: injecting into many tabs must not hold up the toggle or the message queue.
      broadcastMonitoringState(next).catch(() => {});
      return { ok: true, monitoringState: next };
    }

    case PBOM_ACTIONS.CLEAR_RESULTS: {
      state.candidates = {};
      state.session = { pagesMonitored: [], opportunitiesScanned: 0, lastScanAt: null };
      state.unrecognizedEntities = {};
      // state.notified is kept on purpose: clearing the list must not make
      // already-announced opportunities notify again on the next scan.
      await persistState();
      await writeTabScans({});
      await updateBadge();
      return { ok: true };
    }

    default:
      return { ok: false, error: "Unknown action." };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  enqueue(() => handleMessage(message || {}, sender))
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
  return true; // keep the message channel open for the async response
});

// ---- Tab events ---------------------------------------------------------------------------------------------------------
// A tab that just finished loading (or was switched into view) gets nudged
// so it registers itself and scans if monitoring is active. hasHostAccess
// keeps this to PhilGEPS and sites the user has allowed.

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab && tab.url && pbomIsScannableUrl(tab.url)) {
    nudgeTab(tab, 4000).catch(() => {});
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab || !tab.url || !pbomIsScannableUrl(tab.url)) return;
    nudgeTab(tab, 30000).catch(() => {});
  });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  recentNudges.delete(tabId);
  try {
    const map = await readTabScans();
    if (map[tabId]) {
      delete map[tabId];
      await writeTabScans(map);
    }
  } catch (e) {
    /* best effort */
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === PBOM_ALARM_SWEEP) runSweep().catch(() => {});
});

chrome.permissions.onAdded.addListener(() => {
  syncDynamicContentScripts();
});
chrome.permissions.onRemoved.addListener(() => {
  syncDynamicContentScripts();
});

// ---- Lifecycle ---------------------------------------------------------------------------------------------------------------

function configureSidePanel() {
  try {
    // The toolbar button toggles the native side panel; the panel itself is
    // global, so it stays open as the user moves between tabs and sites.
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    chrome.sidePanel.setOptions({ path: "sidepanel.html", enabled: true }).catch(() => {});
  } catch (e) {
    /* sidePanel API unavailable (Chrome < 114): the panel can't be offered */
  }
}

configureSidePanel();

chrome.runtime.onInstalled.addListener(async () => {
  configureSidePanel();
  const state = await loadState(); // loading normalises/migrates stored records
  await enqueue(() => persistState());
  await updateBadge();
  await syncSweepAlarm();
  await syncDynamicContentScripts();
  return state;
});

// If the user opted out of "persist monitoring after browser restart",
// force monitoring OFF at the start of every new browser session. Results
// already collected are left untouched — only the running state resets.
chrome.runtime.onStartup.addListener(async () => {
  configureSidePanel();
  const state = await loadState();
  if (!state.persistAcrossRestart && state.monitoringState !== PBOM_MONITORING_STATES.OFF) {
    state.monitoringState = PBOM_MONITORING_STATES.OFF;
    await chrome.storage.local.set({ [PBOM_STORAGE_KEYS.monitoringState]: PBOM_MONITORING_STATES.OFF });
  }
  await updateBadge();
  await syncSweepAlarm();
  await syncDynamicContentScripts();
});
