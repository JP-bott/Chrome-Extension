/* PhilGeps BidOps Matcher - matcher.js
 * Keyword matching engine. Preserves the existing case-sensitive /
 * whole-word / minimum-matches options, and adds source-based match
 * confidence so metadata noise elsewhere in the row can't manufacture a
 * false positive once the title/category has already been checked.
 */

function pbomNormalizeMatchText(value) {
  if (value == null) return "";
  return String(value)
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pbomEscapeRegExp(str) {
  return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pbomNormalizeMatchOptions(options) {
  const safe = {
    caseSensitive: false,
    wholeWord: false,
    minMatches: 1,
    ...(options || {}),
  };

  safe.caseSensitive = !!safe.caseSensitive;
  safe.wholeWord = !!safe.wholeWord;

  const min = Number(safe.minMatches);
  safe.minMatches = Number.isFinite(min) && min > 0 ? Math.floor(min) : 1;

  return safe;
}

function pbomBuildKeywordRegex(keyword, caseSensitive, wholeWord) {
  const cleaned = pbomNormalizeMatchText(keyword);
  if (!cleaned) return null;

  const escaped = pbomEscapeRegExp(cleaned);
  const pattern = wholeWord ? `\\b${escaped}\\b` : escaped;
  const flags = caseSensitive ? "g" : "gi";
  try {
    return new RegExp(pattern, flags);
  } catch (e) {
    return null;
  }
}

function pbomKeywordMatchTargets({ title, category, rowText } = {}) {
  return [
    { key: "title", label: "Opportunity Title", confidence: "high", value: title },
    { key: "category", label: "Category", confidence: "medium", value: category },
    { key: "rowText", label: "Opportunity Row", confidence: "low", value: rowText },
  ];
}

function pbomCollectDistinctMatches(text, keyword, caseSensitive, wholeWord) {
  const normalizedText = pbomNormalizeMatchText(text);
  if (!normalizedText) return [];

  const regex = pbomBuildKeywordRegex(keyword, caseSensitive, wholeWord);
  if (!regex) return [];

  const matches = [];
  const seen = new Set();

  for (const match of normalizedText.matchAll(regex)) {
    const value = match[0];
    if (!value) continue;
    const key = caseSensitive ? value : value.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      matches.push(value);
    }
  }

  return matches;
}

/**
 * Matches distinct keywords against the relevant opportunity fields in order of
 * confidence: title -> category -> row text. Once a keyword is matched at the
 * strongest available source, it is not added again from lower-confidence text.
 *
 * Returns { matched: [{keyword, count, source, confidence, fields}], matchedCount }
 */
function pbomMatchKeywords({ title, category, rowText } = {}, keywords, options) {
  const safeOptions = pbomNormalizeMatchOptions(options);
  const items = Array.isArray(keywords) ? keywords : [];
  const matched = [];
  const seen = new Set();

  for (const rawKeyword of items) {
    const trimmed = pbomNormalizeMatchText(rawKeyword);
    if (!trimmed) continue;

    const key = safeOptions.caseSensitive ? trimmed : trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const hits = [];
    for (const target of pbomKeywordMatchTargets({ title, category, rowText })) {
      if (!target.value) continue;
      const distinctMatches = pbomCollectDistinctMatches(target.value, trimmed, safeOptions.caseSensitive, safeOptions.wholeWord);
      if (distinctMatches.length === 0) continue;
      hits.push({
        field: target.key,
        source: target.label,
        confidence: target.confidence,
        count: distinctMatches.length,
        matches: distinctMatches,
      });
    }

    if (hits.length === 0) continue;

    hits.sort((a, b) => {
      const order = { high: 3, medium: 2, low: 1 };
      return (order[b.confidence] || 0) - (order[a.confidence] || 0);
    });

    const bestHit = hits[0];
    matched.push({
      keyword: trimmed,
      count: bestHit.count,
      source: bestHit.source,
      confidence: bestHit.confidence,
      fields: hits.map((hit) => hit.field),
    });
  }

  return {
    matched,
    matchedCount: matched.length,
    minMatchesMet: matched.length >= safeOptions.minMatches,
  };
}
