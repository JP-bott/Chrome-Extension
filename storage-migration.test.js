const fs = require('fs');
const vm = require('vm');

const base = {
  PBOM_STORAGE_KEYS: {
    schemaVersion: 'pbom_schema_version',
    results: 'pbom_results',
    session: 'pbom_session',
    monitoringState: 'pbom_monitoring_state',
    notifyOnQualified: 'pbom_notify_on_qualified',
    persistAcrossRestart: 'pbom_persist_across_restart',
    unrecognizedEntities: 'pbom_unrecognized_entities',
    notified: 'pbom_notified',
  },
  PBOM_STORAGE_SCHEMA_VERSION: 1,
  PBOM_MONITORING_STATES: { OFF: 'off', ACTIVE: 'active', PAUSED: 'paused' },
  PBOM_LINK_TYPE: { DETAIL: 'detail', LISTING: 'listing', UNAVAILABLE: 'unavailable' },
  PBOM_PROCUREMENT_STATUS: { UNVERIFIED: 'STATUS UNVERIFIED' },
  PBOM_LOCATION_STATUS: { UNVERIFIED: 'UNVERIFIED' },
  PBOM_DATE_STATUS: { INVALID: 'INVALID', EXPIRED: 'EXPIRED', BEYOND_WINDOW: 'BEYOND_WINDOW' },
  PBOM_QUALIFICATION: { QUALIFIED: 'QUALIFIED', OPTIONAL_PASSED: 'OPTIONAL_PASSED', POTENTIAL_MATCH: 'POTENTIAL_MATCH', NEEDS_VERIFICATION: 'NEEDS_VERIFICATION', REJECTED: 'REJECTED' },
};

const chromeStub = {
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    session: { get: async () => ({}), set: async () => {} },
    onChanged: { addListener: () => {} },
  },
  runtime: { onInstalled: { addListener: () => {} }, onStartup: { addListener: () => {} }, onMessage: { addListener: () => {} }, lastError: null },
  sidePanel: { setPanelBehavior: () => {}, setOptions: () => {} },
  tabs: { onUpdated: { addListener: () => {} }, onActivated: { addListener: () => {} }, onRemoved: { addListener: () => {} }, query: async () => [], get: async () => null, sendMessage: async () => ({ ok: true }), create: async () => ({}) },
  alarms: { onAlarm: { addListener: () => {} }, get: async () => null, clear: async () => {}, create: async () => {} },
  permissions: { onAdded: { addListener: () => {} }, onRemoved: { addListener: () => {} }, contains: async () => true },
  notifications: { create: () => {}, clear: async () => {}, onClicked: { addListener: () => {} } },
  scripting: { getRegisteredContentScripts: async () => [], unregisterContentScripts: async () => {}, updateContentScripts: async () => {}, registerContentScripts: async () => {}, executeScript: async () => [] },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
};

function pbomSanitizeUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return u.toString();
  } catch (e) {
    return null;
  }
}

function pbomGetDomain(raw) {
  try {
    return new URL(raw).hostname.replace(/^www\./i, '').toLowerCase();
  } catch (e) {
    return '';
  }
}

function pbomCanonicalizeUrl(raw) {
  const clean = pbomSanitizeUrl(raw);
  if (!clean) return null;
  const u = new URL(clean);
  u.hash = '';
  const keep = [];
  const params = Array.from(u.searchParams.entries()).filter(([key]) => !/^(utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_ga|_gl|ref_src)$/i.test(key));
  keep.push(...params);
  keep.sort(([a],[b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = '';
  keep.forEach(([k, v]) => u.searchParams.append(k, v));
  let out = u.toString();
  if (u.pathname.length > 1 && u.pathname.endsWith('/') && !u.search) out = out.replace(/\/$/, '');
  return out;
}

const context = {
  console,
  chrome: chromeStub,
  importScripts: () => {},
  setTimeout,
  clearTimeout,
  pbomSanitizeUrl,
  pbomGetDomain,
  pbomCanonicalizeUrl,
  ...base,
};

vm.createContext(context);
vm.runInContext(fs.readFileSync('background.js', 'utf8'), context);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const migrated = context.migrateStoredState({
  [base.PBOM_STORAGE_KEYS.schemaVersion]: 0,
  [base.PBOM_STORAGE_KEYS.results]: {
    candidates: [
      { uid: 'url:https://example.com/opportunity?utm_test=1', title: 'AI Software', url: 'https://example.com/opportunity?utm_test=1', sourcePageUrl: 'https://example.com/listing', reference: 'REF-01', entity: 'Agency', closingRaw: '2026-10-30' },
      { title: 'Cloud Services', url: 'https://example.com/opportunity', sourcePageUrl: 'https://example.com/listing', reference: 'REF-01', entity: 'Agency', closingRaw: '2026-10-30' },
    ],
  },
  [base.PBOM_STORAGE_KEYS.session]: { pagesMonitored: ['https://example.com/listing'], opportunitiesScanned: 2, lastScanAt: '2026-10-01T00:00:00Z' },
});

assert(Object.keys(migrated.candidates).length === 2, 'legacy candidates should be converted without dropping valid records');
assert(migrated.candidates['url:https://example.com/opportunity'] !== undefined, 'canonical URL dedupe should normalize URLs and tracking params');
assert(migrated.session.pagesMonitored.length === 1, 'session state should survive migration without being overwritten');

const record = context.normalizeRecord({
  title: 'AI Software',
  url: 'https://example.com/opportunity?utm_test=1',
  sourcePageUrl: 'https://example.com/listing',
  reference: 'REF-02',
  entity: 'Agency',
  closingRaw: '2026-10-30',
});
assert(record.uid.startsWith('url:'), 'normalized records should keep a stable URL-based key');
assert(record.sourceUrl && record.sourceUrl.startsWith('https://example.com/opportunity'), 'source URLs should remain valid resolved detail links');
assert(record.linkType === 'detail', 'record link type should remain explicit and valid');

console.log('storage migration checks passed');
