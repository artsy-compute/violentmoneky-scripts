// ==UserScript==
// @name         Japanese Furigana Annotator (OpenAI)
// @namespace    https://local.workspace/
// @version      0.1.4
// @description  Add furigana to Japanese webpages with OpenAI, configurable from an on-page panel.
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.openai.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG_KEY = "vm-furigana-openai-config:v1";
  const API_KEY_STORAGE_KEY = "vm-furigana-openai-api-key:v1";
  const ENABLED_STORAGE_KEY = "vm-furigana-openai-enabled:v1";
  const CACHE_KEY = "vm-furigana-openai-cache:v1";
  const ROOT_ATTR = "data-vm-furigana-root";
  const PROCESSED_ATTR = "data-vm-furigana-processed";
  const TRANSLATION_ATTR = "data-vm-furigana-translation";
  const DEFAULT_CONFIG = {
    apiKey: "",
    model: "gpt-4.1-mini",
    cacheMinutes: 10,
    mode: "manual",
    targetLanguage: "zh-TW",
    paragraphTranslationEnabled: true,
  };
  const MAX_TEXTS_PER_BATCH = 4;
  const HOVER_TRIGGER_DELAY_MS = 450;
  const MAX_PRIORITY_FOR_QUEUE = 35000;
  const MAX_RETRIES = 2;
  const MAX_CHARS_PER_BATCH = 360;
  const MAX_TEXT_LENGTH = 280;
  const UI_Z_INDEX = 2147483646;
  const TARGET_LANGUAGES = [
    { value: "zh-TW", label: "Traditional Chinese (Taiwan)" },
    { value: "zh-CN", label: "Simplified Chinese" },
    { value: "en", label: "English" },
    { value: "ko", label: "Korean" },
    { value: "es", label: "Spanish" },
    { value: "fr", label: "French" },
    { value: "de", label: "German" },
  ];
  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEXTAREA",
    "INPUT",
    "OPTION",
    "SELECT",
    "BUTTON",
    "CODE",
    "PRE",
    "RUBY",
    "RT",
    "RP",
    "SVG",
    "MATH",
  ]);

  let state = {
    enabled: false,
    running: false,
    initTimer: null,
    manualHandler: null,
    autoObserver: null,
    autoTimer: null,
    panelOpen: false,
    activeSpinner: null,
    debugHistory: [],
  };

  function loadStoredApiKey() {
    try {
      if (typeof GM_getValue === "function") {
        return String(GM_getValue(API_KEY_STORAGE_KEY, DEFAULT_CONFIG.apiKey) || "");
      }
    } catch (_error) {
      // Fall back to localStorage below.
    }
    return localStorage.getItem(API_KEY_STORAGE_KEY) || DEFAULT_CONFIG.apiKey;
  }

  function saveStoredApiKey(apiKey) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(API_KEY_STORAGE_KEY, apiKey || "");
        return;
      }
    } catch (_error) {
      // Fall back to localStorage below.
    }
    localStorage.setItem(API_KEY_STORAGE_KEY, apiKey || "");
  }

  function loadStoredEnabled() {
    try {
      if (typeof GM_getValue === "function") {
        const value = GM_getValue(ENABLED_STORAGE_KEY, false);
        return value === true || value === "true" || value === "1";
      }
    } catch (_error) {
      // Fall back to localStorage below.
    }
    return localStorage.getItem(ENABLED_STORAGE_KEY) === "true";
  }

  function saveStoredEnabled(enabled) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(ENABLED_STORAGE_KEY, Boolean(enabled));
        return;
      }
    } catch (_error) {
      // Fall back to localStorage below.
    }
    localStorage.setItem(ENABLED_STORAGE_KEY, enabled ? "true" : "false");
  }

  function normalizeTargetLanguage(value) {
    const normalized = typeof value === "string" ? value.trim() : "";
    return TARGET_LANGUAGES.some((language) => language.value === normalized)
      ? normalized
      : DEFAULT_CONFIG.targetLanguage;
  }

  function getTargetLanguageLabel(value) {
    const normalized = normalizeTargetLanguage(value);
    const match = TARGET_LANGUAGES.find((language) => language.value === normalized);
    return match ? match.label : normalized;
  }

  function getTranslationKey(targetLanguage, text) {
    let hash = 0;
    const value = `${targetLanguage}::${text || ""}`;
    for (let index = 0; index < value.length; index += 1) {
      hash = (Math.imul(hash, 31) + value.charCodeAt(index)) | 0;
    }
    return `${targetLanguage}:${(hash >>> 0).toString(36)}:${value.length}`;
  }

  function loadConfig() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}");
      return {
        apiKey: loadStoredApiKey(),
        model: typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : DEFAULT_CONFIG.model,
        cacheMinutes: Number.isFinite(Number(parsed.cacheMinutes))
          ? Math.max(0, Number(parsed.cacheMinutes))
          : DEFAULT_CONFIG.cacheMinutes,
        mode: parsed.mode === "automatic" ? "automatic" : "manual",
        targetLanguage: normalizeTargetLanguage(parsed.targetLanguage),
        paragraphTranslationEnabled: parsed.paragraphTranslationEnabled !== false,
      };
    } catch (_error) {
      return { ...DEFAULT_CONFIG, apiKey: loadStoredApiKey() };
    }
  }

  function saveConfig(nextConfig) {
    saveStoredApiKey(nextConfig.apiKey || "");
    localStorage.setItem(
      CONFIG_KEY,
      JSON.stringify({
        model: nextConfig.model,
        cacheMinutes: nextConfig.cacheMinutes,
        mode: nextConfig.mode === "automatic" ? "automatic" : "manual",
        targetLanguage: normalizeTargetLanguage(nextConfig.targetLanguage),
        paragraphTranslationEnabled: nextConfig.paragraphTranslationEnabled !== false,
      })
    );
  }

  function loadCache() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || '{"entries":{}}');
      return parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object"
        ? parsed
        : { entries: {} };
    } catch (_error) {
      return { entries: {} };
    }
  }

  function saveCache(cache) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch (_error) {
      // Ignore quota failures.
    }
  }

  function pruneCache(cache) {
    const now = Date.now();
    const next = { entries: {} };
    Object.entries(cache.entries || {}).forEach(([key, entry]) => {
      if (!entry || typeof entry !== "object") return;
      if (typeof entry.exp !== "number" || entry.exp <= now) return;
      if (typeof entry.source !== "string" || typeof entry.html !== "string") return;
      next.entries[key] = entry;
    });
    return next;
  }

  function cacheKey(model, targetLanguage, paragraphTranslationEnabled, text) {
    const translationMode = paragraphTranslationEnabled === false ? "annotation-only" : "with-translation";
    return `${model}::${normalizeTargetLanguage(targetLanguage)}::${translationMode}::vocab-v1::${text}`;
  }

  function getCachedResult(config, text) {
    const cache = pruneCache(loadCache());
    saveCache(cache);
    const entry = cache.entries[
      cacheKey(config.model, config.targetLanguage, config.paragraphTranslationEnabled, text)
    ];
    if (!entry || entry.source !== text || typeof entry.html !== "string") return null;
    return {
      html: entry.html,
      translation: typeof entry.translation === "string" ? entry.translation : "",
      vocabulary: Array.isArray(entry.vocabulary) ? entry.vocabulary : [],
    };
  }

  function setCachedResult(config, text, result) {
    const cache = pruneCache(loadCache());
    cache.entries[cacheKey(config.model, config.targetLanguage, config.paragraphTranslationEnabled, text)] = {
      source: text,
      html: result.html,
      translation: result.translation || "",
      vocabulary: Array.isArray(result.vocabulary) ? result.vocabulary : [],
      targetLanguage: normalizeTargetLanguage(config.targetLanguage),
      paragraphTranslationEnabled: config.paragraphTranslationEnabled !== false,
      exp: Date.now() + Math.max(0, Number(config.cacheMinutes) || 0) * 60 * 1000,
    };
    saveCache(cache);
  }

  function clearCache() {
    localStorage.removeItem(CACHE_KEY);
  }

  function isJapaneseCandidate(text) {
    return /[一-龯々〆ヵヶぁ-ゖァ-ヴー]/u.test(text) && /[一-龯々〆ヵヶ]/u.test(text);
  }

  function hasUiChromeHint(element) {
    if (!element) return false;
    const tag = (element.tagName || "").toLowerCase();
    const className = typeof element.className === "string" ? element.className.toLowerCase() : "";
    const id = (element.id || "").toLowerCase();
    const attrs = `${tag} ${className} ${id} ${(element.getAttribute("aria-label") || "").toLowerCase()}`;
    if (tag === "button") return true;
    if (element.closest("button, svg, img, picture")) return true;
    if (element.closest("[aria-hidden='true']")) return true;
    return /(comment|share|social|sns|promo|banner|widget|footer|header|nav|menu|riff-|clickable|visuallyhidden)/.test(attrs);
  }

  function isPreferredTextContainer(element) {
    if (!element) return false;
    const tag = (element.tagName || "").toLowerCase();
    const className = typeof element.className === "string" ? element.className.toLowerCase() : "";
    const id = (element.id || "").toLowerCase();
    const attrs = `${tag} ${className} ${id}`;
    return tag in { h1: 1, h2: 1, h3: 1, p: 1, li: 1, article: 1, span: 1 } || /(title|headline|summary|digest|article|story|body|content|highlightsearchtarget)/.test(attrs);
  }

  function normalizeTextContainer(element) {
    if (!(element instanceof Element)) return element;
    const parent = element.parentElement;
    if (!parent) return element;

    const tag = (element.tagName || "").toLowerCase();
    const parentTag = (parent.tagName || "").toLowerCase();
    const parentText = (parent.innerText || parent.textContent || "").trim();
    const ownText = (element.innerText || element.textContent || "").trim();

    if (tag === "span" && ["p", "li", "article", "section", "h1", "h2", "h3", "h4", "h5", "h6"].includes(parentTag)) {
      if (parentText && ownText && parentText.length >= ownText.length) return parent;
    }

    return element;
  }

  function getPreferredHoverScope(target) {
    if (!(target instanceof Element)) return null;
    const normalizedTarget = normalizeTextContainer(target);
    const card = normalizedTarget.closest("article, [data-ual-view-type], [class*='digest'], [class*='article'], [class*='card'], [class*='story']");
    if (card) {
      const text = (card.innerText || card.textContent || "").trim();
      if (text && text.length <= 2500) return card;
    }
    return normalizeTextContainer(
      normalizedTarget.closest("p, li, div, section, article, h1, h2, h3, h4, h5, h6, span") || normalizedTarget
    );
  }

  function shouldSkipNode(textNode) {
    if (!textNode || !textNode.parentElement) return true;
    const parent = textNode.parentElement;
    if (parent.closest(`[${ROOT_ATTR}]`)) return true;
    if (parent.closest(`[${TRANSLATION_ATTR}]`)) return true;
    if (parent.closest(`span[${PROCESSED_ATTR}]`)) return true;
    if (SKIP_TAGS.has(parent.tagName)) return true;
    if (parent.closest("ruby")) return true;
    if (parent.isContentEditable) return true;
    if (parent.closest("[contenteditable='true']")) return true;
    if (hasUiChromeHint(parent)) return true;
    const text = textNode.nodeValue || "";
    if (!text.trim()) return true;
    if (text.length > MAX_TEXT_LENGTH) return true;
    if (text.trim().length <= 2) return true;
    if (!isJapaneseCandidate(text)) return true;
    return false;
  }

  function collectTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let current;
    while ((current = walker.nextNode())) {
      if (!shouldSkipNode(current)) nodes.push(current);
    }
    return nodes;
  }

  function getViewportPriority(element) {
    if (!element || !element.isConnected) return Number.POSITIVE_INFINITY;

    const rect = element.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const nearMargin = 600;
    const horizontallyVisible = rect.right >= 0 && rect.left <= viewportWidth;
    const verticallyVisible = rect.bottom >= 0 && rect.top <= viewportHeight;

    if (horizontallyVisible && verticallyVisible) {
      return Math.max(0, rect.top);
    }

    const aboveDistance = Math.max(0, -rect.bottom);
    const belowDistance = Math.max(0, rect.top - viewportHeight);
    const verticalDistance = Math.max(aboveDistance, belowDistance);
    const horizontalPenalty = horizontallyVisible ? 0 : nearMargin;
    const nearViewport = verticalDistance <= nearMargin;

    if (nearViewport) {
      return 10000 + verticalDistance + horizontalPenalty;
    }

    return 100000 + verticalDistance + horizontalPenalty;
  }

  function getBlockRoleScore(element) {
    if (!element) return 0;

    let score = 0;
    const role = (element.getAttribute("role") || "").toLowerCase();
    const tag = (element.tagName || "").toLowerCase();
    const className = typeof element.className === "string" ? element.className.toLowerCase() : "";
    const id = (element.id || "").toLowerCase();
    const hint = `${tag} ${role} ${className} ${id}`;

    if (/\b(main|article|content|entry|post|story|reader|chapter|body|markdown)\b/.test(hint)) score -= 5000;
    if (/\b(sidebar|aside|nav|menu|header|footer|comment|related|recommend|promo|banner|ad|ads|sponsor|widget|rail)\b/.test(hint)) score += 9000;
    if (tag === "main" || tag === "article") score -= 7000;
    if (tag === "aside" || tag === "nav" || tag === "footer") score += 10000;
    if (role === "main" || role === "article") score -= 6000;
    if (role === "complementary" || role === "navigation") score += 8000;

    return score;
  }

  function getBlockTextDensityScore(element) {
    if (!element) return 0;
    const textLength = (element.innerText || element.textContent || "").trim().length;
    const linkCount = element.querySelectorAll ? element.querySelectorAll("a").length : 0;
    const paragraphCount = element.querySelectorAll ? element.querySelectorAll("p, li").length : 0;

    let score = 0;
    if (textLength >= 1200) score -= 3500;
    else if (textLength >= 600) score -= 2000;
    else if (textLength <= 120) score += 1200;

    if (paragraphCount >= 4) score -= 1400;
    if (linkCount >= 12) score += 2600;
    else if (linkCount >= 6) score += 1200;

    return score;
  }

  function getStructuralPriority(element) {
    let score = 0;
    let current = element;
    let depth = 0;

    while (current && current !== document.body && depth < 5) {
      score += getBlockRoleScore(current);
      if (depth === 0 || depth === 1) score += getBlockTextDensityScore(current);
      current = current.parentElement;
      depth += 1;
    }

    return score;
  }

  function getNodePriority(textNode) {
    const element = textNode && textNode.parentElement;
    if (!element || !element.isConnected) return Number.POSITIVE_INFINITY;
    return getViewportPriority(element) + getStructuralPriority(element);
  }

  function selectNextBatch(items) {
    const sorted = [...items].sort((a, b) => a.priority - b.priority);
    const selected = [];
    let currentChars = 0;

    for (const item of sorted) {
      const size = item.text.length;
      const exceeds = selected.length >= MAX_TEXTS_PER_BATCH || currentChars + size > MAX_CHARS_PER_BATCH;
      if (selected.length && exceeds) break;
      selected.push(item);
      currentChars += size;
    }

    return selected;
  }

  function getHoverBlock(target) {
    if (!(target instanceof Element)) return null;
    const block = getPreferredHoverScope(target);
    if (!block || block.closest(`[${ROOT_ATTR}]`)) return null;
    const text = (block.innerText || block.textContent || "").trim();
    if (!text || text.length > 2500 || !/[一-龯々〆ヵヶ]/u.test(text)) return null;
    return block;
  }

  function collectManualBatch(rootElement) {
    if (!rootElement || rootElement.closest(`[${ROOT_ATTR}]`)) return [];

    const base = rootElement.nodeType === Node.ELEMENT_NODE ? rootElement : rootElement.parentElement;
    if (!base) return [];

    const scope = getPreferredHoverScope(base) || base;
    const preferredContainers = Array.from(
      scope.querySelectorAll("h1, h2, h3, p, li, article, span, [class*='title'], [class*='headline'], [class*='summary'], [class*='digest'], [class*='article'], [class*='story'], .highLightSearchTarget")
    )
      .map((element) => normalizeTextContainer(element))
      .filter((element, index, array) => array.indexOf(element) === index)
      .filter((element) => !hasUiChromeHint(element) && isPreferredTextContainer(element));

    const sources = preferredContainers.length ? preferredContainers : [scope];
    const seen = new Set();
    const nodes = [];

    sources.forEach((container) => {
      collectTextNodes(container).forEach((node) => {
        if (seen.has(node)) return;
        seen.add(node);
        nodes.push(node);
      });
    });

    const manualItems = [];
    let currentChars = 0;
    const config = loadConfig();

    for (const node of nodes) {
      const text = node.nodeValue || "";
      const cachedResult = getCachedResult(config, text);
      if (cachedResult != null) {
        applyAnnotatedResult({ node, text }, cachedResult, config, "cache");
        continue;
      }
      const size = text.length;
      const exceeds = manualItems.length >= MAX_TEXTS_PER_BATCH || currentChars + size > MAX_CHARS_PER_BATCH;
      if (manualItems.length && exceeds) break;
      manualItems.push({ node, text, priority: 0 });
      currentChars += size;
    }

    return manualItems;
  }

  function sanitizeRubyHtml(html) {
    const template = document.createElement("template");
    template.innerHTML = html;
    const allowed = new Set(["RUBY", "RT", "RP", "BR"]);

    function cleanNode(node) {
      if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent || "");
      if (node.nodeType !== Node.ELEMENT_NODE) return document.createDocumentFragment();
      if (!allowed.has(node.tagName)) {
        return document.createTextNode(node.textContent || "");
      }
      const clone = document.createElement(node.tagName.toLowerCase());
      Array.from(node.childNodes).forEach((child) => {
        clone.appendChild(cleanNode(child));
      });
      return clone;
    }

    const fragment = document.createDocumentFragment();
    Array.from(template.content.childNodes).forEach((child) => {
      fragment.appendChild(cleanNode(child));
    });
    return fragment;
  }

  function wrapAnnotatedNode(textNode, html) {
    if (!textNode.parentNode) return null;
    const wrapper = document.createElement("span");
    wrapper.className = "vm-furigana-node";
    wrapper.setAttribute(PROCESSED_ATTR, "1");
    wrapper.dataset.originalText = textNode.nodeValue || "";
    wrapper.appendChild(sanitizeRubyHtml(html));
    textNode.parentNode.replaceChild(wrapper, textNode);
    return wrapper;
  }

  function normalizeVocabularyNotes(notes) {
    if (!Array.isArray(notes)) return [];
    return notes
      .map((note) => ({
        term: typeof note?.term === "string" ? note.term.trim() : "",
        reading: typeof note?.reading === "string" ? note.reading.trim() : "",
        meaning: typeof note?.meaning === "string" ? note.meaning.trim() : "",
        note: typeof note?.note === "string" ? note.note.trim() : "",
      }))
      .filter((note) => note.term && (note.meaning || note.note))
      .slice(0, 4);
  }

  function formatVocabularyNote(note) {
    const reading = note.reading ? ` (${note.reading})` : "";
    const meaning = note.meaning ? `: ${note.meaning}` : "";
    const extra = note.note ? ` - ${note.note}` : "";
    return `${note.term}${reading}${meaning}${extra}`;
  }

  function renderLearningNotesAfterNode(wrapper, result, config, sourceText) {
    const translation =
      config.paragraphTranslationEnabled === false || typeof result?.translation !== "string"
        ? ""
        : result.translation.trim();
    const vocabulary = normalizeVocabularyNotes(result?.vocabulary);
    if ((!translation && !vocabulary.length) || !(wrapper instanceof Element)) return;

    const block =
      wrapper.closest("p, li, blockquote, figcaption, td, th, h1, h2, h3, h4, h5, h6") || wrapper.parentElement;
    if (!block || !block.parentNode) return;

    const key = getTranslationKey(config.targetLanguage, sourceText);
    let container = block.nextElementSibling;
    if (!(container instanceof HTMLElement) || !container.hasAttribute(TRANSLATION_ATTR)) {
      container = document.createElement("div");
      container.className = "vm-furigana-translation";
      container.setAttribute(TRANSLATION_ATTR, "1");
      container.lang = normalizeTargetLanguage(config.targetLanguage);
      block.parentNode.insertBefore(container, block.nextSibling);
    }

    const alreadyRendered = Array.from(container.children).some((child) => child.dataset.translationKey === key);
    if (alreadyRendered) return;

    if (translation) {
      const line = document.createElement("div");
      line.className = "vm-furigana-translation-line";
      line.dataset.translationKey = key;
      line.textContent = translation;
      container.appendChild(line);
    }

    if (vocabulary.length) {
      const list = document.createElement("ul");
      list.className = "vm-furigana-vocab-list";
      list.dataset.translationKey = key;
      vocabulary.forEach((note) => {
        const item = document.createElement("li");
        item.className = "vm-furigana-vocab-item";
        item.textContent = formatVocabularyNote(note);
        list.appendChild(item);
      });
      container.appendChild(list);
    }
  }

  function restoreAnnotatedNodes() {
    document.querySelectorAll(`[${TRANSLATION_ATTR}]`).forEach((node) => node.remove());
    document.querySelectorAll(`span[${PROCESSED_ATTR}]`).forEach((node) => {
      const text = node.dataset.originalText || node.textContent || "";
      node.replaceWith(document.createTextNode(text));
    });
  }

  function hasRubyMarkup(html) {
    return typeof html === "string" && /<ruby[\s>]/i.test(html) && /<rt[\s>]/i.test(html);
  }

  function shouldAcceptAnnotatedResult(sourceText, html) {
    if (typeof html !== "string" || !html.trim()) return false;
    if (!/[一-龯々〆ヵヶ]/u.test(sourceText || "")) return true;
    return hasRubyMarkup(html);
  }

  function applyAnnotatedResult(item, result, config, source) {
    if (!item?.node?.parentNode) return false;
    const html = typeof result === "string" ? result : result?.html;
    const translation =
      config.paragraphTranslationEnabled === false
        ? ""
        : typeof result === "object" && typeof result.translation === "string"
          ? result.translation
          : "";
    const vocabulary = typeof result === "object" ? normalizeVocabularyNotes(result.vocabulary) : [];
    if (!shouldAcceptAnnotatedResult(item.text, html)) {
      pushDebugHistory({
        type: "unchanged_result",
        source,
        text: item.text,
        returnedHtml: html,
      });
      return false;
    }

    setCachedResult(config, item.text, { html, translation, vocabulary });
    const wrapper = wrapAnnotatedNode(item.node, html);
    renderLearningNotesAfterNode(wrapper, { translation, vocabulary }, config, item.text);
    return true;
  }

  function chunkTexts(items) {
    const batches = [];
    let current = [];
    let currentChars = 0;

    items.forEach((item) => {
      const size = item.text.length;
      const exceeds = current.length >= MAX_TEXTS_PER_BATCH || currentChars + size > MAX_CHARS_PER_BATCH;
      if (current.length && exceeds) {
        batches.push(current);
        current = [];
        currentChars = 0;
      }
      current.push(item);
      currentChars += size;
    });

    if (current.length) batches.push(current);
    return batches;
  }

  function extractResponseText(payload) {
    if (!payload || typeof payload !== "object") return "";
    if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text;

    const output = Array.isArray(payload.output) ? payload.output : [];
    for (const item of output) {
      const content = Array.isArray(item && item.content) ? item.content : [];
      for (const part of content) {
        if (typeof part?.text === "string" && part.text.trim()) return part.text;
      }
    }
    return "";
  }

  function openAiRequest(apiKey, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: "https://api.openai.com/v1/responses",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        data: JSON.stringify(body),
        onload: (response) => {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`OpenAI request failed (${response.status}): ${response.responseText || "Unknown error"}`));
            return;
          }

          try {
            resolve(JSON.parse(response.responseText));
          } catch (error) {
            reject(new Error(`Failed to parse OpenAI response: ${error.message}`));
          }
        },
        onerror: () => reject(new Error("Network error while calling OpenAI.")),
      });
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function pushDebugHistory(entry) {
    state.debugHistory.unshift({ at: new Date().toISOString(), ...entry });
    state.debugHistory = state.debugHistory.slice(0, 8);
    renderDebugHistory();
  }

  function renderDebugHistory() {
    const node = document.getElementById("vm-furigana-debug-history");
    if (!node) return;
    node.value = state.debugHistory.length
      ? state.debugHistory.map((entry) => JSON.stringify(entry, null, 2)).join("\n\n---\n\n")
      : "No history yet.";
  }

  async function annotateBatch(config, batch) {
    const targetLanguage = normalizeTargetLanguage(config.targetLanguage);
    const targetLanguageLabel = getTargetLanguageLabel(targetLanguage);
    const paragraphTranslationEnabled = config.paragraphTranslationEnabled !== false;
    const prompt = [
      paragraphTranslationEnabled
        ? "You add furigana to Japanese text and translate it."
        : "You add furigana to Japanese text.",
      "For html, return the exact same source text content, but wrap kanji words or kanji-containing compounds with HTML ruby tags using hiragana in rt tags.",
      paragraphTranslationEnabled
        ? "For translation, translate the source text into the requested target language."
        : "For translation, return an empty string.",
      "For vocabulary, select only useful words or short phrases from the source text that are uncommon, easy to confuse, idiomatic, domain-specific, or likely to be forgotten by a Japanese learner.",
      "Avoid very common particles, auxiliaries, basic pronouns, and obvious words unless they are used in a confusing way.",
      "Return at most 4 vocabulary notes per input, with concise meanings and notes in the target language.",
      "Do not summarize, explain, or remove any source text from html.",
      "Preserve punctuation, whitespace, numbers, Latin text, and kana exactly as provided in html.",
      "Do not wrap kana-only text, particles, punctuation, or Latin text in ruby tags.",
      paragraphTranslationEnabled
        ? "If a string does not need furigana or is not Japanese, return html unchanged, but still translate it when possible."
        : "If a string does not need furigana or is not Japanese, return html unchanged and translation as an empty string.",
      "Do not include markdown fences.",
    ].join(" ");

    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              html: { type: "string" },
              translation: { type: "string" },
              vocabulary: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    term: { type: "string" },
                    reading: { type: "string" },
                    meaning: { type: "string" },
                    note: { type: "string" },
                  },
                  required: ["term", "reading", "meaning", "note"],
                },
              },
            },
            required: ["html", "translation", "vocabulary"],
          },
        },
      },
      required: ["items"],
    };

    const body = {
      model: config.model,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: prompt }],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                instruction: "Return one object per input, in the same order. Each object must include html, translation, and vocabulary.",
                targetLanguage,
                targetLanguageLabel,
                paragraphTranslationEnabled,
                texts: batch.map((item) => item.text),
              }),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "furigana_translation_batch",
          schema,
          strict: true,
        },
      },
    };

    pushDebugHistory({
      type: "request",
      model: config.model,
      targetLanguage,
      paragraphTranslationEnabled,
      prompt,
      batchTexts: batch.map((item) => item.text),
      schema: "json_schema/html_translation_vocabulary_items",
    });

    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const response = await openAiRequest(config.apiKey, body);
        const responseText = extractResponseText(response);
        if (!responseText) throw new Error("OpenAI returned no structured text.");

        let parsed;
        try {
          parsed = JSON.parse(responseText);
        } catch (error) {
          throw new Error(`Failed to parse structured output: ${error.message}`);
        }

        const items = Array.isArray(parsed?.items) ? parsed.items : [];
        if (items.length !== batch.length) {
          throw new Error(`OpenAI returned ${items.length} items for ${batch.length} inputs.`);
        }
        pushDebugHistory({
          type: "response",
          model: config.model,
          targetLanguage,
          paragraphTranslationEnabled,
          rawOutputText: responseText,
          parsedItems: items,
        });
        return items.map((item) => ({
          html: typeof item?.html === "string" ? item.html : "",
          translation: typeof item?.translation === "string" ? item.translation : "",
          vocabulary: normalizeVocabularyNotes(item?.vocabulary),
        }));
      } catch (error) {
        lastError = error;
        pushDebugHistory({
          type: "error",
          model: config.model,
          targetLanguage,
          paragraphTranslationEnabled,
          attempt: attempt + 1,
          message: error.message || String(error),
        });
        if (attempt >= MAX_RETRIES) break;
        await sleep(350 * (attempt + 1));
      }
    }

    throw lastError || new Error("OpenAI request failed.");
  }

  function showSpinner(target) {
    hideSpinner();
    if (!(target instanceof Element)) return;

    const host = target.closest("p, li, div, section, article, h1, h2, h3, h4, h5, h6, span") || target;
    const rect = host.getBoundingClientRect();
    const spinner = document.createElement("div");
    spinner.className = "vm-furigana-spinner";
    spinner.style.top = `${Math.max(8, window.scrollY + rect.top + 6)}px`;
    spinner.style.left = `${Math.max(8, window.scrollX + rect.left - 14)}px`;
    document.body.appendChild(spinner);
    state.activeSpinner = spinner;
  }

  function hideSpinner() {
    if (state.activeSpinner) {
      state.activeSpinner.remove();
      state.activeSpinner = null;
    }
  }

  function collectAutomaticBatch() {
    const config = loadConfig();
    const nodes = collectTextNodes(document.body || document.documentElement);
    const pending = [];

    nodes.forEach((node) => {
      const text = node.nodeValue || "";
      const cachedResult = getCachedResult(config, text);
      if (cachedResult != null) {
        applyAnnotatedResult({ node, text }, cachedResult, config, "cache");
        return;
      }
      const priority = getNodePriority(node);
      if (priority > MAX_PRIORITY_FOR_QUEUE) return;
      pending.push({ node, text, priority });
    });

    return selectNextBatch(pending);
  }

  async function handleAutomaticDiscovery() {
    if (!state.enabled || state.running || !document.body) return;
    const config = loadConfig();
    if (!config.apiKey) {
      setStatus("Add an OpenAI API key in settings.");
      return;
    }

    const batch = collectAutomaticBatch();
    if (!batch.length) return;

    state.running = true;
    try {
      setStatus(
        config.paragraphTranslationEnabled === false
          ? `Auto annotating ${batch.length} block(s)...`
          : `Auto annotating and translating ${batch.length} block(s)...`
      );
      const results = await annotateBatch(config, batch);
      let appliedCount = 0;
      results.forEach((result, index) => {
        const item = batch[index];
        if (applyAnnotatedResult(item, result, config, "automatic")) {
          appliedCount += 1;
        }
      });
      if (appliedCount === 0) {
        setStatus("Automatic scan returned no usable furigana");
      }
      if (state.enabled && loadConfig().mode === "automatic") {
        state.autoTimer = window.setTimeout(() => {
          handleAutomaticDiscovery().catch((error) => console.error("[vm-furigana-openai]", error));
        }, 250);
      }
    } catch (error) {
      console.error("[vm-furigana-openai]", error);
      setStatus(error.message || "Failed automatic annotation.");
    } finally {
      state.running = false;
      hideSpinner();
    }
  }

  function startObserver() {
    if (!document.body) return;
    const config = loadConfig();

    if (config.mode === "manual") {
      if (state.manualHandler) return;
      state.manualHandler = (event) => {
        const block = getHoverBlock(event.target);
        if (!block) return;
        handleManualTrigger({ target: block }).catch((error) => console.error("[vm-furigana-openai]", error));
      };
      document.addEventListener("dblclick", state.manualHandler, true);
      return;
    }

    if (!state.autoObserver) {
      state.autoObserver = new MutationObserver(() => {
        if (state.autoTimer) window.clearTimeout(state.autoTimer);
        state.autoTimer = window.setTimeout(() => {
          handleAutomaticDiscovery().catch((error) => console.error("[vm-furigana-openai]", error));
        }, 300);
      });
      state.autoObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
    if (state.autoTimer) window.clearTimeout(state.autoTimer);
    state.autoTimer = window.setTimeout(() => {
      handleAutomaticDiscovery().catch((error) => console.error("[vm-furigana-openai]", error));
    }, 0);
  }

  function stopObserver() {
    if (state.manualHandler) {
      document.removeEventListener("dblclick", state.manualHandler, true);
      state.manualHandler = null;
    }
    if (state.autoObserver) {
      state.autoObserver.disconnect();
      state.autoObserver = null;
    }
    if (state.autoTimer) {
      window.clearTimeout(state.autoTimer);
      state.autoTimer = null;
    }
    hideSpinner();
  }

  async function handleManualTrigger(event) {
    if (!state.enabled) return;
    if (state.running) {
      setStatus("Busy, try again in a moment");
      return;
    }

    const target = event.target;
    if (!(target instanceof Element)) return;
    const batch = collectManualBatch(target);
    if (!batch.length) {
      setStatus("No Japanese text found in this block");
      return;
    }

    const config = loadConfig();
    if (!config.apiKey) {
      setStatus("Add an OpenAI API key in settings.");
      return;
    }

    state.running = true;
    showSpinner(target);
    try {
      setStatus(
        config.paragraphTranslationEnabled === false
          ? `Annotating manual block (${batch.length})...`
          : `Annotating and translating manual block (${batch.length})...`
      );
      const results = await annotateBatch(config, batch);
      let appliedCount = 0;
      results.forEach((result, index) => {
        const item = batch[index];
        if (applyAnnotatedResult(item, result, config, "manual")) {
          appliedCount += 1;
        }
      });
      setStatus(
        appliedCount > 0
          ? config.paragraphTranslationEnabled === false
            ? "Manual block annotated"
            : "Manual block annotated and translated"
          : "No usable furigana returned"
      );
    } catch (error) {
      console.error("[vm-furigana-openai]", error);
      setStatus(error.message || "Failed to annotate manual block.");
    } finally {
      state.running = false;
      hideSpinner();
    }
  }

  function setToggleState(enabled) {
    state.enabled = enabled;
    const button = document.getElementById("vm-furigana-toggle");
    if (!button) return;
    button.classList.toggle("is-enabled", enabled);
    button.setAttribute("aria-pressed", enabled ? "true" : "false");
    button.title = enabled ? "Disable furigana" : "Enable furigana";
  }

  function setStatus(message) {
    const node = document.getElementById("vm-furigana-status");
    if (node) node.textContent = message;
    renderDebugHistory();
  }

  function readPanelConfig() {
    return {
      apiKey: document.getElementById("vm-furigana-api-key").value.trim(),
      model: document.getElementById("vm-furigana-model").value.trim() || DEFAULT_CONFIG.model,
      cacheMinutes: Math.max(0, Number(document.getElementById("vm-furigana-cache").value) || 0),
      mode: document.getElementById("vm-furigana-mode").value === "automatic" ? "automatic" : "manual",
      targetLanguage: normalizeTargetLanguage(document.getElementById("vm-furigana-target-language").value),
      paragraphTranslationEnabled: document.getElementById("vm-furigana-translate-paragraphs").checked,
    };
  }

  function syncPanelFromConfig(config) {
    document.getElementById("vm-furigana-api-key").value = config.apiKey || "";
    document.getElementById("vm-furigana-model").value = config.model || DEFAULT_CONFIG.model;
    document.getElementById("vm-furigana-cache").value = String(config.cacheMinutes ?? DEFAULT_CONFIG.cacheMinutes);
    document.getElementById("vm-furigana-mode").value = config.mode === "automatic" ? "automatic" : "manual";
    document.getElementById("vm-furigana-target-language").value = normalizeTargetLanguage(config.targetLanguage);
    document.getElementById("vm-furigana-translate-paragraphs").checked = config.paragraphTranslationEnabled !== false;
    syncTranslationControls();
  }

  function syncTranslationControls() {
    const checkbox = document.getElementById("vm-furigana-translate-paragraphs");
    const targetLanguage = document.getElementById("vm-furigana-target-language");
    if (!checkbox || !targetLanguage) return;
    targetLanguage.disabled = false;
    targetLanguage.style.opacity = "1";
  }

  function togglePanel(forceOpen) {
    state.panelOpen = typeof forceOpen === "boolean" ? forceOpen : !state.panelOpen;
    const panel = document.getElementById("vm-furigana-panel");
    if (!panel) return;
    panel.hidden = !state.panelOpen;
  }

  function disableFurigana() {
    saveStoredEnabled(false);
    setToggleState(false);
    stopObserver();
    state.running = false;
    setStatus("Furigana off");
  }

  function enableFurigana() {
    saveStoredEnabled(true);
    setToggleState(true);
    startObserver();
    setStatus(loadConfig().mode === "automatic" ? "Automatic discovery on" : "Double-click a text block");
  }

  function addStyles() {
    const css = `
      [${ROOT_ATTR}] {
        all: initial;
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: ${UI_Z_INDEX};
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      [${ROOT_ATTR}] *, [${ROOT_ATTR}] *::before, [${ROOT_ATTR}] *::after {
        box-sizing: border-box;
      }
      .vm-furigana-stack {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 10px;
      }
      .vm-furigana-buttons {
        display: flex;
        gap: 8px;
      }
      .vm-furigana-icon {
        all: unset;
        width: 44px;
        height: 44px;
        border-radius: 14px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        color: #f8fafc;
        background: rgba(15, 23, 42, 0.94);
        border: 1px solid rgba(148, 163, 184, 0.28);
        box-shadow: 0 14px 36px rgba(15, 23, 42, 0.26);
        font-size: 19px;
        line-height: 1;
      }
      .vm-furigana-icon:hover {
        transform: translateY(-1px);
        background: rgba(30, 41, 59, 0.96);
      }
      .vm-furigana-icon.is-enabled {
        background: #0f766e;
      }
      .vm-furigana-panel {
        width: min(340px, calc(100vw - 32px));
        padding: 14px;
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.98);
        color: #0f172a;
        border: 1px solid rgba(148, 163, 184, 0.35);
        box-shadow: 0 24px 48px rgba(15, 23, 42, 0.24);
      }
      .vm-furigana-title {
        margin: 0 0 10px;
        font: 700 15px/1.2 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .vm-furigana-label {
        display: block;
        margin: 10px 0 6px;
        font: 600 12px/1.2 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #334155;
      }
      .vm-furigana-input {
        width: 100%;
        padding: 10px 11px;
        border-radius: 10px;
        border: 1px solid #cbd5e1;
        background: #fff;
        color: #0f172a;
        font: 13px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .vm-furigana-row {
        display: flex;
        gap: 8px;
        margin-top: 12px;
      }
      .vm-furigana-check-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 10px 0 0;
        color: #334155;
        font: 600 12px/1.2 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .vm-furigana-check-row input {
        width: 14px;
        height: 14px;
        accent-color: #0f766e;
      }
      .vm-furigana-action {
        all: unset;
        padding: 9px 12px;
        border-radius: 10px;
        cursor: pointer;
        font: 600 12px/1 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #e2e8f0;
        color: #0f172a;
      }
      .vm-furigana-action.is-primary {
        background: #0f766e;
        color: #fff;
      }
      .vm-furigana-status {
        margin-top: 10px;
        min-height: 16px;
        font: 500 12px/1.3 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #475569;
      }
      .vm-furigana-spinner {
        position: absolute;
        width: 12px;
        height: 12px;
        border-radius: 999px;
        border: 2px solid rgba(15, 118, 110, 0.2);
        border-top-color: #0f766e;
        animation: vm-furigana-spin 0.7s linear infinite;
        z-index: 2147483647;
        pointer-events: none;
        background: rgba(255, 255, 255, 0.9);
      }
      @keyframes vm-furigana-spin {
        to { transform: rotate(360deg); }
      }
      .vm-furigana-node ruby rt {
        font-size: 0.62em;
      }
      .vm-furigana-translation {
        margin: 0.35em 0 0.9em;
        padding-left: 0.75em;
        border-left: 3px solid rgba(15, 118, 110, 0.35);
        color: #334155;
        font: 0.92em/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .vm-furigana-translation-line + .vm-furigana-translation-line {
        margin-top: 0.35em;
      }
      .vm-furigana-vocab-list {
        margin: 0.45em 0 0;
        padding-left: 1.25em;
      }
      .vm-furigana-vocab-item {
        margin: 0.2em 0;
      }
    `;

    if (typeof GM_addStyle === "function") GM_addStyle(css);
    else {
      const style = document.createElement("style");
      style.textContent = css;
      document.head.appendChild(style);
    }
  }

  function buildUi() {
    addStyles();

    const targetLanguageOptions = TARGET_LANGUAGES.map(
      (language) => `<option value="${language.value}">${language.label}</option>`
    ).join("");
    const root = document.createElement("div");
    root.setAttribute(ROOT_ATTR, "1");
    root.style.position = "fixed";
    root.style.top = "16px";
    root.style.right = "16px";
    root.style.zIndex = String(UI_Z_INDEX);
    root.style.display = "block";
    root.style.visibility = "visible";
    root.style.opacity = "1";
    root.innerHTML = `
      <div class="vm-furigana-stack">
        <div class="vm-furigana-buttons">
          <button id="vm-furigana-settings" class="vm-furigana-icon" type="button" title="Open settings">⚙</button>
          <button id="vm-furigana-toggle" class="vm-furigana-icon" type="button" title="Enable furigana" aria-pressed="false">あ</button>
        </div>
        <section id="vm-furigana-panel" class="vm-furigana-panel" hidden>
          <h2 class="vm-furigana-title">Furigana Settings</h2>
          <label class="vm-furigana-label" for="vm-furigana-api-key">OpenAI API key</label>
          <input id="vm-furigana-api-key" class="vm-furigana-input" type="password" placeholder="sk-..." autocomplete="off" />
          <label class="vm-furigana-label" for="vm-furigana-model">Model</label>
          <input id="vm-furigana-model" class="vm-furigana-input" type="text" placeholder="gpt-4.1-mini" />
          <label class="vm-furigana-label" for="vm-furigana-cache">Cache minutes</label>
          <input id="vm-furigana-cache" class="vm-furigana-input" type="number" min="0" step="1" />
          <label class="vm-furigana-label" for="vm-furigana-mode">Mode</label>
          <select id="vm-furigana-mode" class="vm-furigana-input">
            <option value="manual">Manual (double click)</option>
            <option value="automatic">Automatic discovery</option>
          </select>
          <label class="vm-furigana-check-row" for="vm-furigana-translate-paragraphs">
            <input id="vm-furigana-translate-paragraphs" type="checkbox" />
            <span>Paragraph translation</span>
          </label>
          <label class="vm-furigana-label" for="vm-furigana-target-language">Target language</label>
          <select id="vm-furigana-target-language" class="vm-furigana-input">
            ${targetLanguageOptions}
          </select>
          <div class="vm-furigana-row">
            <button id="vm-furigana-save" class="vm-furigana-action is-primary" type="button">Save</button>
            <button id="vm-furigana-clear-cache" class="vm-furigana-action" type="button">Clear cache</button>
          </div>
          <div id="vm-furigana-status" class="vm-furigana-status">Double-click a text block</div>
          <label class="vm-furigana-label" for="vm-furigana-debug-history">Debug history</label>
          <textarea id="vm-furigana-debug-history" class="vm-furigana-input" rows="12" readonly></textarea>
        </section>
      </div>
    `;

    (document.body || document.documentElement).appendChild(root);

    const config = loadConfig();
    syncPanelFromConfig(config);
    renderDebugHistory();
    setStatus("Ready");

    document.getElementById("vm-furigana-settings").addEventListener("click", () => togglePanel());
    document.getElementById("vm-furigana-translate-paragraphs").addEventListener("change", syncTranslationControls);
    document.getElementById("vm-furigana-save").addEventListener("click", () => {
      const nextConfig = readPanelConfig();
      const wasEnabled = state.enabled;
      saveConfig(nextConfig);
      if (wasEnabled) {
        stopObserver();
        startObserver();
      }
      setStatus(`Settings saved (${nextConfig.mode === "automatic" ? "automatic" : "manual"})`);
    });
    document.getElementById("vm-furigana-clear-cache").addEventListener("click", () => {
      clearCache();
      setStatus("Cache cleared");
    });
    document.getElementById("vm-furigana-toggle").addEventListener("click", () => {
      if (state.enabled) disableFurigana();
      else enableFurigana();
    });

    if (loadStoredEnabled()) {
      enableFurigana();
    }
  }

  function init() {
    if (document.querySelector(`[${ROOT_ATTR}]`)) return;
    if (!document.body || !document.documentElement) {
      if (!state.initTimer) {
        state.initTimer = window.setTimeout(() => {
          state.initTimer = null;
          init();
        }, 500);
      }
      return;
    }
    buildUi();
  }

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", init, { once: true });
    window.addEventListener("load", init, { once: true });
  }
  init();
})();
