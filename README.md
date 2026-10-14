# PhilGeps BidOps Matcher 3.1.0 — Official PhilGEPS Opportunity Monitoring

Persistent Chrome Side Panel for procurement opportunity extraction, matching, highlighting, and monitoring on the official PhilGEPS website and its verified listing pages.

Preserves the diagnostic console visual theme, animated radar sweep, 41 core keyword defaults, NCR/Metro Manila location rules, 4-day closing window qualification, background monitoring, and direct source link fidelity.

---

## What's New in Version 3.1.0

### 1. Universal Government Procurement Search (Layered Architecture)
- **Layer 1: Structured HTML Tables & Cards**: Header-driven column mapping and repeating procurement cards across non-PhilGEPS government websites.
- **Layer 2: Contextual Text & Announcement Extraction** (`procurement-adapters.js`): Scans agency news portals, bulletin boards, and announcement articles for procurement solicitations.
- **Layer 3: Downloadable Document Link Discovery** (`procurement-classifier.js`): Detects links to downloadable RFQs, ITBs, RFPs, Bid Bulletins, and Procurement Plans (`.pdf`, `.docx`, `.xlsx`, `.zip`) with extracted filenames, reference numbers, and direct download URLs.
- **Layer 4: Fallback Generic DOM/Text Scanner**: Unstructured Philippine government pages receive a universal content scan without requiring site-specific adapters.
- **Procurement Status Recognition**: Accurately distinguishes between Active Solicitations, Upcoming Bids, Notices of Award (NOA), Notices to Proceed (NTP), Bid Bulletins / Addenda, Annual Procurement Plans (APP), and Cancelled / Failed Biddings. Notices of Award and APPs are segregated as **Potential Matches** rather than masquerading as open solicitations.

### 2. Enhanced Ctrl+F Smart Highlighting & Navigation Engine (`keyword-highlighter.js`)
- **Safe Reversible DOM Highlighting**: Operates purely on text nodes using DocumentFragments and `<mark>` elements without destroying parent container event listeners or corrupting dynamic modern web frameworks.
- **Multi-Tier Visual Classifications**:
  - **Direct Keyword Match** (`pbom-hl-direct`): Exact match for configured procurement terms.
  - **High-Priority Match** (`pbom-hl-priority`): Multiple matching keywords or high relevance procurement listings.
  - **Potential Opportunity Match** (`pbom-hl-potential`): Matching terms appearing within recognized procurement contexts or headings.
  - **Optional Match** (`pbom-hl-optional`): Terms requiring manual verification.
- **Interactive Match Navigation**:
  - **Previous Match (`<`)** and **Next Match (`>`)** buttons.
  - Real-time match counter readout (e.g. `3 of 18`).
  - Active match indicator with pulse animation and smooth scrolling (`scrollIntoView`).
  - Highlight filtering by tier (`All`, `Direct`, `Priority`, `Potential`).
  - Click-to-scroll: Clicking any opportunity card in the side panel smoothly scrolls the webpage directly to the listing element.

### 3. Optional Multi-Provider AI Integration (`ai-provider.js` & `ai-client.js`)
- **Strictly Optional Enhancement**: Fully functional without AI. When disabled or disconnected, the extension seamlessly runs its native keyword matching, DOM scanner, and qualification engine.
- **Supported Providers**:
  - **OpenAI-Compatible**: OpenAI (e.g., `gpt-4o-mini`, `gpt-4o`), Groq, OpenRouter, Ollama, LocalAI, vLLM.
  - **Google Gemini**: Gemini models via Gemini API (`gemini-1.5-flash`, `gemini-1.5-pro`).
  - **Anthropic Claude**: Claude models via Messages API (`claude-3-5-haiku-20241022`, `claude-3-5-sonnet-20241022`).
  - **Custom Endpoints**: Configurable host URL and model name for internal enterprise or self-hosted models.
- **Security & Privacy Guardrails**:
  - API tokens are stored in local extension storage and executed **only** within the extension's background service worker.
  - Tokens are masked by default with a show/hide toggle.
  - Tokens are never sent to scanned government websites, never injected into the page DOM, never logged to the console, and redacted from error messages.
  - **URL Anti-Hallucination Guardrail**: AI models cannot fabricate URLs. Extracted `source_url` candidates are strictly validated against verified URLs from the page.
  - Cost control: Only truncated text excerpts of candidate items (up to 2,500 characters) are analyzed; whole DOM trees are never transmitted.

---

## Installation Instructions

1. Open Google Chrome and navigate to `chrome://extensions`.
2. Toggle on **Developer mode** in the upper-right corner.
3. Click **Load unpacked**.
4. Select the `philgeps-bidops-matcher` folder containing `manifest.json`.
5. Click the extension icon in the Chrome toolbar to open the Side Panel.

---

## Required Permissions & Rationale

| Permission | Purpose |
| :--- | :--- |
| `sidePanel` | Provides the persistent side panel user interface across browser tabs. |
| `storage` | Stores user-configured keywords, AI provider settings (token, model, endpoint), and collected bid records. |
| `activeTab` | Grants temporary scripting access to the active webpage when the user clicks **Scan Current Page** or navigates highlights. |
| `scripting` | Injects the universal content script pipeline into allowed government procurement pages. |
| `tabs` | Synchronizes the side panel context with the currently active browser tab and opens direct opportunity links. |
| `notifications` | Emits desktop alerts when a high-priority matching procurement opportunity closing within 4 days is discovered. |
| `alarms` | Periodically triggers the background maintenance sweep every 15 minutes to re-qualify bids against the clock. |
| `host_permissions` | Static access to the official PhilGEPS host patterns only: `https://philgeps.gov.ph/*` and `https://*.philgeps.gov.ph/*`. |
| `optional_host_permissions` | Not used; the extension intentionally remains limited to official PhilGEPS pages and verified PhilGEPS listing URLs. |

---

## Configuration & Usage Guide

### PhilGEPS Page Monitoring
1. Open an official PhilGEPS procurement listing or opportunity page.
2. Click **Scan Current Page** in the panel.
3. The extraction pipeline inspects the current PhilGEPS listing for structured rows, detail links, and verifiable opportunity fields.
4. Click **Highlight Matches** to visually highlight all matching terms on the webpage.
5. Use **<** and **>** to step through matching terms with automatic smooth scrolling.
6. Click any result card to jump directly to its row or source link on the active PhilGEPS page.

### Configuring AI Assistance (Optional)
1. Open **Settings** by clicking the gear icon in the panel header.
2. Scroll to the **AI Integration (Optional)** group and toggle **Enable AI Assistance** on.
3. Choose your provider (`OpenAI-Compatible`, `Google Gemini`, `Anthropic Claude`, or `Custom`).
4. Enter your API Endpoint and Model Name (defaults are prefilled).
5. Paste your API Access Token into the password field.
6. Click **Test Connection** to verify reachability.
7. Click **Save AI Settings**.
8. In the main panel, click **Analyze with AI** to extract contextual insights, recognize non-literal synonyms (e.g. decision support, predictive software), and extract verifiable reference numbers.
9. To revert to standard non-AI operation at any time, toggle **Enable AI Assistance** off or click **Remove Token**.
