/* PhilGeps BidOps Matcher - ai-provider.js
 * Multi-provider adapter architecture for optional AI-assisted procurement extraction.
 * Supports OpenAI-compatible endpoints, Google Gemini, Anthropic Claude, and Custom LLM gateways.
 * Depends on: constants.js (PBOM_AI_PROVIDERS, PBOM_PROVIDER_DEFAULTS)
 */

var PBOM_AI_EXTRACTION_SYSTEM_PROMPT = `You are a specialized Philippine Government Procurement Extraction Assistant.
Your task is to analyze raw text extracted from Philippine government procurement webpages, announcements, or document listings.
Extract or classify procurement metadata accurately.

STRICT ACCURACY AND ANTI-HALLUCINATION RULES:
1. Do NOT fabricate, invent, or guess reference numbers, closing dates, budgets, or agency names. If a field is not present in the excerpt, set it to null.
2. Do NOT invent source URLs or file links. Only return URLs that are explicitly present in the candidate text.
3. Classify status strictly as one of: "ACTIVE", "UPCOMING", "CLOSED", "AWARDED", "CANCELLED", "BULLETIN", "APP", or "STATUS UNVERIFIED".
4. Provide a short verbatim "evidence_excerpt" from the input text demonstrating the procurement subject.
5. If the notice relates to contextual synonyms of configured business terms (e.g., predictive analytics, decision support, IT systems, licensing), note them in "matched_keywords".

OUTPUT FORMAT:
You MUST respond ONLY with a valid JSON object matching this schema:
{
  "title": string or null,
  "reference_number": string or null,
  "procuring_entity": string or null,
  "procurement_type": string or null,
  "publication_date": string or null,
  "closing_date": string or null,
  "location": string or null,
  "status": "ACTIVE" | "UPCOMING" | "CLOSED" | "AWARDED" | "CANCELLED" | "BULLETIN" | "APP" | "STATUS UNVERIFIED",
  "matched_keywords": string[],
  "relevance_score": number between 0 and 100,
  "confidence": "high" | "medium" | "low",
  "needs_manual_review": boolean,
  "evidence_excerpt": string or null,
  "source_url": string or null
}`;

var pbomOpenAIAdapter = {
  id: "openai",
  name: "OpenAI-Compatible",
  buildRequest: function ({ endpoint, model, token, prompt, systemPrompt }) {
    const url = endpoint || (typeof PBOM_PROVIDER_DEFAULTS !== "undefined" ? PBOM_PROVIDER_DEFAULTS.openai.endpoint : "https://api.openai.com/v1/chat/completions");
    return {
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: model || (typeof PBOM_PROVIDER_DEFAULTS !== "undefined" ? PBOM_PROVIDER_DEFAULTS.openai.model : "gpt-4o-mini"),
        messages: [
          { role: "system", content: systemPrompt || PBOM_AI_EXTRACTION_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
      }),
    };
  },
  parseResponse: function (json) {
    if (!json || !json.choices || !json.choices[0] || !json.choices[0].message) {
      throw new Error("Invalid OpenAI response format");
    }
    const content = json.choices[0].message.content;
    return typeof content === "string" ? JSON.parse(content) : content;
  },
  buildTestRequest: function ({ endpoint, model, token }) {
    return this.buildRequest({
      endpoint,
      model,
      token,
      prompt: "Respond with JSON: {\"status\": \"ok\", \"message\": \"connection successful\"}",
      systemPrompt: "You are an assistant. Respond only with valid JSON.",
    });
  },
};

var pbomGeminiAdapter = {
  id: "gemini",
  name: "Google Gemini",
  buildRequest: function ({ endpoint, model, token, prompt, systemPrompt }) {
    const m = model || (typeof PBOM_PROVIDER_DEFAULTS !== "undefined" ? PBOM_PROVIDER_DEFAULTS.gemini.model : "gemini-1.5-flash");
    let url = endpoint;
    if (!url || url.includes("{model}")) {
      url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
    }
    return {
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": token,
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: systemPrompt || PBOM_AI_EXTRACTION_SYSTEM_PROMPT }],
        },
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          response_mime_type: "application/json",
        },
      }),
    };
  },
  parseResponse: function (json) {
    if (!json || !json.candidates || !json.candidates[0] || !json.candidates[0].content) {
      if (json && json.error) throw new Error(json.error.message || "Gemini API error");
      throw new Error("Invalid Gemini response format");
    }
    const text = json.candidates[0].content.parts[0].text;
    return typeof text === "string" ? JSON.parse(text) : text;
  },
  buildTestRequest: function ({ endpoint, model, token }) {
    return this.buildRequest({
      endpoint,
      model,
      token,
      prompt: "Respond with JSON: {\"status\": \"ok\", \"message\": \"connection successful\"}",
      systemPrompt: "You are an assistant. Respond only with valid JSON.",
    });
  },
};

var pbomAnthropicAdapter = {
  id: "anthropic",
  name: "Anthropic Claude",
  buildRequest: function ({ endpoint, model, token, prompt, systemPrompt }) {
    const url = endpoint || (typeof PBOM_PROVIDER_DEFAULTS !== "undefined" ? PBOM_PROVIDER_DEFAULTS.anthropic.endpoint : "https://api.anthropic.com/v1/messages");
    return {
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": token,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model || (typeof PBOM_PROVIDER_DEFAULTS !== "undefined" ? PBOM_PROVIDER_DEFAULTS.anthropic.model : "claude-3-5-haiku-20241022"),
        max_tokens: 1024,
        system: (systemPrompt || PBOM_AI_EXTRACTION_SYSTEM_PROMPT) + "\n\nCRITICAL: Output ONLY raw JSON, with no preamble or explanation.",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
      }),
    };
  },
  parseResponse: function (json) {
    if (!json || !json.content || !json.content[0] || !json.content[0].text) {
      if (json && json.error) throw new Error(json.error.message || "Anthropic API error");
      throw new Error("Invalid Anthropic response format");
    }
    let text = json.content[0].text.trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }
    return JSON.parse(text);
  },
  buildTestRequest: function ({ endpoint, model, token }) {
    return this.buildRequest({
      endpoint,
      model,
      token,
      prompt: "Respond with JSON: {\"status\": \"ok\", \"message\": \"connection successful\"}",
      systemPrompt: "You are an assistant. Respond only with valid JSON.",
    });
  },
};

var pbomCustomAdapter = {
  id: "custom",
  name: "Custom Endpoint",
  buildRequest: function (params) {
    return pbomOpenAIAdapter.buildRequest(params);
  },
  parseResponse: function (json) {
    return pbomOpenAIAdapter.parseResponse(json);
  },
  buildTestRequest: function (params) {
    return pbomOpenAIAdapter.buildTestRequest(params);
  },
};

var PBOM_AI_ADAPTERS = {
  openai: pbomOpenAIAdapter,
  gemini: pbomGeminiAdapter,
  anthropic: pbomAnthropicAdapter,
  custom: pbomCustomAdapter,
};

function pbomGetAiAdapter(providerId) {
  return PBOM_AI_ADAPTERS[providerId] || PBOM_AI_ADAPTERS.openai;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PBOM_AI_EXTRACTION_SYSTEM_PROMPT,
    pbomOpenAIAdapter,
    pbomGeminiAdapter,
    pbomAnthropicAdapter,
    pbomCustomAdapter,
    PBOM_AI_ADAPTERS,
    pbomGetAiAdapter,
  };
}
