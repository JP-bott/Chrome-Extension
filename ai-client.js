/* PhilGeps BidOps Matcher - ai-client.js
 * API communication, timeout, request deduplication, response validation,
 * secure token handling, and non-AI fallback orchestrator.
 * Runs in the extension background service worker context so tokens are never
 * exposed to page DOM or external content scripts.
 * Depends on: constants.js, ai-provider.js
 */

function pbomSanitizeErrorMessage(err, token) {
  let msg = err && err.message ? err.message : String(err || "Unknown error");
  if (token && typeof token === "string" && token.length > 4) {
    msg = msg.split(token).join("[REDACTED_TOKEN]");
  }
  msg = msg.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]");
  msg = msg.replace(/key=[A-Za-z0-9._~+\/-]+/gi, "key=[REDACTED]");
  return msg;
}

async function pbomTestAiConnection(config) {
  if (!config) return { ok: false, error: "No AI configuration provided." };
  const providerId = config.provider || "openai";
  const adapter = pbomGetAiAdapter(providerId);
  const token = (config.token || "").trim();

  if (!token && providerId !== "custom") {
    return { ok: false, error: "API access token is required for " + adapter.name };
  }

  const endpoint = (config.endpoint || "").trim();
  const model = (config.model || "").trim();

  let req;
  try {
    req = adapter.buildTestRequest({ endpoint, model, token });
  } catch (e) {
    return { ok: false, error: "Failed to build request: " + pbomSanitizeErrorMessage(e, token) };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      let errDetail = "";
      try {
        const errJson = await res.json();
        errDetail = (errJson.error && errJson.error.message) || JSON.stringify(errJson);
      } catch (e) {
        errDetail = res.statusText || ("HTTP " + res.status);
      }
      return {
        ok: false,
        status: res.status,
        error: `Provider returned HTTP ${res.status}: ${pbomSanitizeErrorMessage(errDetail, token)}`,
      };
    }

    const data = await res.json();
    adapter.parseResponse(data);
    return {
      ok: true,
      message: `Connection successful! ${adapter.name} (${model || "default model"}) is ready.`,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      return { ok: false, error: "Connection timed out after 12 seconds." };
    }
    return { ok: false, error: "Connection failed: " + pbomSanitizeErrorMessage(err, token) };
  }
}

function pbomValidateAiResponse(parsed, verifiedUrls) {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("AI response is not a valid JSON object");
  }

  const validStatuses = new Set([
    "ACTIVE", "UPCOMING", "CLOSED", "AWARDED", "CANCELLED", "BULLETIN", "APP", "STATUS UNVERIFIED"
  ]);

  let status = String(parsed.status || "").trim().toUpperCase();
  if (!validStatuses.has(status)) {
    status = "STATUS UNVERIFIED";
  }

  let cleanSourceUrl = null;
  if (parsed.source_url && typeof parsed.source_url === "string") {
    const candidateUrl = parsed.source_url.trim();
    if (verifiedUrls && verifiedUrls.has(candidateUrl)) {
      cleanSourceUrl = candidateUrl;
    }
  }

  return {
    title: parsed.title ? String(parsed.title).trim() : null,
    reference_number: parsed.reference_number ? String(parsed.reference_number).trim() : null,
    procuring_entity: parsed.procuring_entity ? String(parsed.procuring_entity).trim() : null,
    procurement_type: parsed.procurement_type ? String(parsed.procurement_type).trim() : null,
    publication_date: parsed.publication_date ? String(parsed.publication_date).trim() : null,
    closing_date: parsed.closing_date ? String(parsed.closing_date).trim() : null,
    location: parsed.location ? String(parsed.location).trim() : null,
    status,
    matched_keywords: Array.isArray(parsed.matched_keywords)
      ? parsed.matched_keywords.map((k) => String(k).trim()).filter(Boolean)
      : [],
    relevance_score: typeof parsed.relevance_score === "number" ? Math.min(100, Math.max(0, parsed.relevance_score)) : 50,
    confidence: ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "medium",
    needs_manual_review: !!parsed.needs_manual_review,
    evidence_excerpt: parsed.evidence_excerpt ? String(parsed.evidence_excerpt).slice(0, 300).trim() : null,
    source_url: cleanSourceUrl,
  };
}

async function pbomAnalyzeCandidateWithAi(candidate, config, verifiedUrls) {
  if (!config || !config.enabled) {
    return { ok: false, fallback: true, reason: "AI assistance is disabled." };
  }

  const token = (config.token || "").trim();
  const providerId = config.provider || "openai";
  if (!token && providerId !== "custom") {
    return { ok: false, fallback: true, reason: "AI token not configured." };
  }

  const adapter = pbomGetAiAdapter(providerId);

  const excerpt = String(candidate.rowText || candidate.title || "").slice(0, 2500);
  const prompt = [
    `OPPORTUNITY TO ANALYZE:`,
    `Title: ${candidate.title || "Not indicated"}`,
    `Reference: ${candidate.reference || "Not indicated"}`,
    `Entity: ${candidate.entity || "Not indicated"}`,
    `Category: ${candidate.category || "Not indicated"}`,
    `Closing Raw: ${candidate.closingRaw || "Not indicated"}`,
    `Published Raw: ${candidate.datePublishedRaw || "Not indicated"}`,
    `Raw Page Excerpt:\n${excerpt}`,
  ].join("\n");

  let req;
  try {
    req = adapter.buildRequest({
      endpoint: config.endpoint,
      model: config.model,
      token,
      prompt,
    });
  } catch (e) {
    return { ok: false, fallback: true, error: pbomSanitizeErrorMessage(e, token) };
  }

  const controller = new AbortController();
  const timeoutMs = config.timeoutMs || 15000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      let errDetail = "";
      try {
        const errJson = await res.json();
        errDetail = (errJson.error && errJson.error.message) || JSON.stringify(errJson);
      } catch (e) {
        errDetail = res.statusText || ("HTTP " + res.status);
      }
      return {
        ok: false,
        fallback: true,
        error: `Provider HTTP ${res.status}: ${pbomSanitizeErrorMessage(errDetail, token)}`,
      };
    }

    const json = await res.json();
    const parsed = adapter.parseResponse(json);
    const validated = pbomValidateAiResponse(parsed, verifiedUrls);

    return {
      ok: true,
      assessment: validated,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err.name === "AbortError";
    return {
      ok: false,
      fallback: true,
      error: isTimeout ? "AI request timed out after " + (timeoutMs / 1000) + "s." : pbomSanitizeErrorMessage(err, token),
    };
  }
}

async function pbomBatchAnalyzeCandidates(candidates, config, pageUrls) {
  if (!config || !config.enabled || !candidates || candidates.length === 0) {
    return { candidates, analyzedCount: 0, fallbackCount: 0 };
  }

  const verifiedUrls = new Set((pageUrls || []).filter(Boolean));
  candidates.forEach((c) => {
    if (c.sourceUrl) verifiedUrls.add(c.sourceUrl);
    if (c.url) verifiedUrls.add(c.url);
  });

  const maxAnalyze = Math.min(candidates.length, config.maxCandidatesPerScan || 5);
  const toProcess = candidates.slice(0, maxAnalyze);

  let analyzedCount = 0;
  let fallbackCount = 0;

  for (const c of toProcess) {
    const res = await pbomAnalyzeCandidateWithAi(c, config, verifiedUrls);
    if (res.ok && res.assessment) {
      analyzedCount++;
      c.aiAssessment = res.assessment;
      if (!c.reference && res.assessment.reference_number) {
        c.reference = res.assessment.reference_number;
      }
      if (res.assessment.status && res.assessment.status !== "STATUS UNVERIFIED") {
        c.procurementStatus = res.assessment.status;
      }
      if (res.assessment.evidence_excerpt) {
        c.evidenceExcerpt = res.assessment.evidence_excerpt;
      }
      c.aiEnhanced = true;
    } else {
      fallbackCount++;
      c.aiFallback = true;
      c.aiError = res.error || res.reason || "AI unavailable";
    }
  }

  return { candidates, analyzedCount, fallbackCount };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    pbomSanitizeErrorMessage,
    pbomTestAiConnection,
    pbomValidateAiResponse,
    pbomAnalyzeCandidateWithAi,
    pbomBatchAnalyzeCandidates,
  };
}
