// ==UserScript==
// @name         Markdown Viewer
// @namespace    http://tampermonkey.net/
// @version      2.4.0
// @description  Automatically formats and displays .md files with a pleasant, readable theme, font settings, and an optional slide deck view.
// @description:en Automatically formats and displays .md files with a pleasant, readable theme, font settings, and an optional slide deck view.
// @description:de Automatisch .md-Dateien formatieren und anzeigen mit einem angenehmen, lesbaren Thema, Schriftarten und optionaler Folienansicht.
// @author       anga83 (original), artsy-compute
// @license      MIT
// @homepageURL  https://greasyfork.org/zh-TW/scripts/538817-markdown-viewer
// @match        *://*/*.md
// @include      file://*/*.md
// @exclude      https://github.com/*
// @exclude      http://github.com/*
// @require      https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.umd.min.js
// @require      https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

// Adapted from the original "Markdown Viewer" userscript by anga83.
// Source: https://greasyfork.org/zh-TW/scripts/538817-markdown-viewer

(function() {
    'use strict';

    // --- SETTINGS IDENTIFIERS ---
    const FONT_STYLE_KEY = 'markdownViewer_fontStyle';
    const THEME_KEY = 'markdownViewer_theme';
    const VIEW_MODE_KEY = 'markdownViewer_viewMode';
    const STYLE_ELEMENT_ID_FONT = 'userscript-markdown-font-style';
    const STYLE_ELEMENT_ID_THEME = 'userscript-markdown-theme-style';
    const STYLE_ELEMENT_ID_BASE = 'userscript-markdown-base-style';
    const SAFE_HREF_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'mailto:']);
    const SAFE_SRC_PROTOCOLS = new Set(['http:', 'https:', 'file:']);
    const ALLOWED_URI_REGEXP = /^(?:(?:https?|file|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;
    const VIEW_MODES = new Set(['markdown', 'slides']);
    const viewerState = {
        setViewMode: null
    };

    // --- FONT SETTINGS ---
    const FONT_SETTINGS = {
        'serif': `Iowan Old Style, Apple Garamond, Baskerville, Georgia, Times New Roman, Droid Serif, Times, Source Serif Pro, serif, Apple Color Emoji, Segoe UI Emoji, Segoe UI Symbol`,
        'sans-serif': `"Segoe UI", "SF Pro Text", "Helvetica Neue", "Ubuntu", "Arial", sans-serif`
    };

    function removeExistingStyleElement(id) {
        const existingStyle = document.getElementById(id);
        if (existingStyle) {
            existingStyle.remove();
        }
    }

    function addStyleElement(id, css) {
        removeExistingStyleElement(id);
        const style = document.createElement('style');
        style.id = id;
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
    }

    function applyFontStyle() {
        const chosenFont = GM_getValue(FONT_STYLE_KEY, 'serif'); // Standard 'serif'
        const fontFamily = FONT_SETTINGS[chosenFont] || FONT_SETTINGS.serif;
        addStyleElement(STYLE_ELEMENT_ID_FONT, `.markdown-body { font-family: ${fontFamily} !important; }`);
    }

    // --- THEME SETTINGS ---
    function applyThemeStyle() {
        const chosenTheme = GM_getValue(THEME_KEY, 'system'); // 'system', 'light', 'dark'
        const prefersDarkScheme = window.matchMedia('(prefers-color-scheme: dark)').matches;

        let useDarkTheme = false;
        if (chosenTheme === 'dark') {
            useDarkTheme = true;
        } else if (chosenTheme === 'system' && prefersDarkScheme) {
            useDarkTheme = true;
        }

        let themeCss = '';
        if (useDarkTheme) {
            // Dark Theme
            themeCss += `
                :root {
                    --markdown-control-bg: #202326;
                    --markdown-control-bg-hover: #2b3036;
                    --markdown-control-bg-active: #34506f;
                    --markdown-control-border: #3f464f;
                    --markdown-control-border-active: #6aa5dc;
                    --markdown-control-text: #e1e4e8;
                    --markdown-control-muted: #aeb6c1;
                    --markdown-slide-page-bg: #101214;
                    --markdown-slide-surface: #17191c;
                    --markdown-slide-surface-2: #20242a;
                    --markdown-slide-border: #343a42;
                    --markdown-slide-shadow: rgba(0, 0, 0, 0.34);
                }
                body {
                    background-color: rgb(27, 28, 29) !important;
                    color: rgb(220, 220, 220) !important;
                }
                .markdown-body {
                    color: rgb(220, 220, 220) !important;
                }
                .markdown-body a { 
                    color: #79b8ff !important; /* Dezenter blau-türkis Farbton statt kräftiges Blau */
                    text-decoration: none !important; /* Keine Unterstreichung standardmäßig */
                }
                .markdown-body a:hover {
                    text-decoration: underline !important; /* Nur beim Hovern unterstreichen */
                }
                .markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6 {
                    border-bottom-color: #30363d !important;
                    color: rgb(220, 220, 220) !important;
                }
                .markdown-body hr { background-color: #30363d !important; }
                .markdown-body blockquote {
                    color: #a0a0a0 !important;
                    border-left-color: #30363d !important;
                }
                .markdown-body table th, .markdown-body table td { border-color: #484f58 !important; }
                .markdown-body code:not(pre code) { /* Inline code */
                    background-color: rgb(50, 50, 50) !important;
                    border: 1px solid rgb(70, 70, 70) !important;
                    color: rgb(220, 220, 220) !important;
                }
                .markdown-body pre { /* Code block */
                    background-color: rgb(40, 42, 44) !important;
                    border: 1px solid rgb(60, 62, 64) !important;
                }
                .markdown-body pre code {
                     color: rgb(220, 220, 220) !important;
                }
                .markdown-body kbd {
                    background-color: rgb(50,50,50) !important;
                    border: 1px solid rgb(70,70,70) !important;
                    color: rgb(220,220,220) !important;
                    border-bottom-color: rgb(80,80,80) !important;
                }
                .markdown-body img { filter: brightness(.8) contrast(1.2); }
                
                /* Dark Mode Button Styling */
                .custom-play-button {
                    background-color: #444d56 !important; /* Dunklerer, weniger aufdringlicher Grauton */
                    color: #e1e4e8 !important; /* Helle Schrift für dunklen Hintergrund */
                    border: 1px solid #586069 !important; /* Dezenter Rand */
                }
                .custom-play-button:hover, .custom-play-button:focus {
                    background-color: #586069 !important; /* Etwas heller beim Hover */
                    color: #e1e4e8 !important;
                    border-color: #6a737d !important;
                }
                .custom-play-button a {
                    color: #e1e4e8 !important; /* Links erben die Button-Textfarbe */
                    text-decoration: none !important;
                }
                .custom-play-button a:hover {
                    color: #e1e4e8 !important; /* Auch beim Hover Button-Farbe beibehalten */
                    text-decoration: none !important;
                }
            `;
        } else { // Light Theme
            themeCss += `
                :root {
                    --markdown-control-bg: #f6f8fa;
                    --markdown-control-bg-hover: #eaeef2;
                    --markdown-control-bg-active: #dbeafe;
                    --markdown-control-border: #d0d7de;
                    --markdown-control-border-active: #0969da;
                    --markdown-control-text: #24292e;
                    --markdown-control-muted: #57606a;
                    --markdown-slide-page-bg: #f3f4f6;
                    --markdown-slide-surface: #ffffff;
                    --markdown-slide-surface-2: #f8fafc;
                    --markdown-slide-border: #d8dee4;
                    --markdown-slide-shadow: rgba(31, 35, 40, 0.14);
                }
                body {
                    background-color: #ffffff !important;
                    color: #24292e !important;
                }
                .markdown-body {
                    color: #24292e !important;
                }
                .markdown-body a { 
                    color: #0366d6 !important; 
                    text-decoration: none !important; /* Keine Unterstreichung standardmäßig */
                }
                .markdown-body a:hover {
                    text-decoration: underline !important; /* Nur beim Hovern unterstreichen */
                }
                .markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6 {
                    border-bottom-color: #eaecef !important;
                    color: #24292e !important;
                }
                .markdown-body hr { background-color: #e1e4e8 !important; }
                .markdown-body blockquote {
                    color: #6a737d !important;
                    border-left-color: #dfe2e5 !important;
                }
                .markdown-body table th, .markdown-body table td { border: 1px solid #dfe2e5 !important; }
                .markdown-body code:not(pre code) { /* Inline code */
                    background-color: rgba(27,31,35,.07) !important;
                    border: 1px solid rgba(27,31,35,.1) !important;
                    color: #24292e !important;
                }
                .markdown-body pre { /* Code block */
                    background-color: #f6f8fa !important;
                    border: 1px solid #eaecef !important;
                }
                 .markdown-body pre code {
                    color: #24292e !important;
                }
                .markdown-body kbd {
                    background-color: #fafbfc !important;
                    border: 1px solid #d1d5da !important;
                    border-bottom-color: #c6cbd1 !important;
                    color: #444d56 !important;
                }
                .markdown-body img { filter: none; }
                
                /* Light Mode Button Styling */
                .custom-play-button {
                    background-color: #f6f8fa !important; /* Heller, subtiler Grauton */
                    color: #24292e !important; /* Dunkle Schrift für hellen Hintergrund */
                    border: 1px solid #d1d5da !important; /* Dezenter Rand */
                }
                .custom-play-button:hover, .custom-play-button:focus {
                    background-color: #e1e4e8 !important; /* Etwas dunkler beim Hover */
                    color: #24292e !important;
                    border-color: #c6cbd1 !important;
                }
                .custom-play-button a {
                    color: #24292e !important; /* Links erben die Button-Textfarbe */
                    text-decoration: none !important;
                }
                .custom-play-button a:hover {
                    color: #24292e !important; /* Auch beim Hover Button-Farbe beibehalten */
                    text-decoration: none !important;
                }
            `;
        }
        addStyleElement(STYLE_ELEMENT_ID_THEME, themeCss);
    }

    // --- MENU COMMANDS ---
    GM_registerMenuCommand('Font: Serif', () => {
        GM_setValue(FONT_STYLE_KEY, 'serif');
        applyFontStyle();
    });

    GM_registerMenuCommand('Font: Sans-serif', () => {
        GM_setValue(FONT_STYLE_KEY, 'sans-serif');
        applyFontStyle();
    });

    GM_registerMenuCommand('Theme: System', () => {
        GM_setValue(THEME_KEY, 'system');
        applyThemeStyle();
    });

    GM_registerMenuCommand('Theme: Light', () => {
        GM_setValue(THEME_KEY, 'light');
        applyThemeStyle();
    });

    GM_registerMenuCommand('Theme: Dark', () => {
        GM_setValue(THEME_KEY, 'dark');
        applyThemeStyle();
    });

    GM_registerMenuCommand('View: Markdown', () => {
        if (typeof viewerState.setViewMode === 'function') {
            viewerState.setViewMode('markdown');
        } else {
            GM_setValue(VIEW_MODE_KEY, 'markdown');
        }
    });

    GM_registerMenuCommand('View: Slides', () => {
        if (typeof viewerState.setViewMode === 'function') {
            viewerState.setViewMode('slides');
        } else {
            GM_setValue(VIEW_MODE_KEY, 'slides');
        }
    });

    // --- BASE STYLES ---
    function applyBaseStyles() {
        addStyleElement(STYLE_ELEMENT_ID_BASE, `
            body {
                margin: 0;
            }
            .markdown-viewer-shell {
                box-sizing: border-box;
                min-width: 200px;
                width: 100%;
            }
            .markdown-viewer-toolbar {
                box-sizing: border-box;
                max-width: 980px;
                margin: 0 auto;
                padding: 14px 30px 0;
                display: flex;
                justify-content: flex-end;
                gap: 8px;
                font-family: "Segoe UI", "SF Pro Text", "Helvetica Neue", "Ubuntu", "Arial", sans-serif;
            }
            .markdown-viewer-toggle {
                display: inline-flex;
                gap: 3px;
                padding: 3px;
                border: 1px solid var(--markdown-control-border);
                border-radius: 8px;
                background: var(--markdown-control-bg);
            }
            .markdown-viewer-toggle-button,
            .markdown-slide-button {
                appearance: none;
                border: 1px solid transparent;
                border-radius: 6px;
                background: transparent;
                color: var(--markdown-control-muted);
                cursor: pointer;
                font: inherit;
                font-size: 0.86rem;
                line-height: 1.2;
                min-width: 86px;
                padding: 7px 11px;
                text-align: center;
                transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
            }
            .markdown-viewer-toggle-button:hover,
            .markdown-viewer-toggle-button:focus-visible,
            .markdown-slide-button:hover,
            .markdown-slide-button:focus-visible {
                background: var(--markdown-control-bg-hover);
                color: var(--markdown-control-text);
                outline: none;
            }
            .markdown-viewer-toggle-button.is-active {
                background: var(--markdown-control-bg-active);
                border-color: var(--markdown-control-border-active);
                color: var(--markdown-control-text);
            }
            .markdown-slide-button:disabled {
                cursor: default;
                opacity: 0.45;
            }
            .markdown-viewer-panel[hidden] {
                display: none !important;
            }
            .markdown-body {
                box-sizing: border-box;
                min-width: 200px;
                max-width: 980px;
                margin: 0 auto;
                padding: 15px 30px 30px;
            }
            .markdown-slides-panel {
                box-sizing: border-box;
                min-height: calc(100vh - 54px);
                padding: 18px 16px 30px;
                background: var(--markdown-slide-page-bg);
            }
            .markdown-slide-deck {
                max-width: 1180px;
                margin: 0 auto;
            }
            .markdown-slide-stage {
                box-sizing: border-box;
                aspect-ratio: 16 / 9;
                width: 100%;
                max-height: calc(100vh - 150px);
                min-height: 360px;
                position: relative;
                overflow: hidden;
                border: 1px solid var(--markdown-slide-border);
                border-radius: 8px;
                background: var(--markdown-slide-surface);
                box-shadow: 0 22px 60px var(--markdown-slide-shadow);
            }
            .markdown-slide {
                box-sizing: border-box;
                display: none;
                width: 100%;
                height: 100%;
                overflow: auto;
                padding: 54px 64px;
            }
            .markdown-slide.is-active {
                display: flex;
                flex-direction: column;
                justify-content: center;
            }
            .markdown-slide-content.markdown-body {
                width: 100%;
                min-width: 0;
                max-width: none;
                margin: 0;
                padding: 0;
                font-size: 1.24rem;
                line-height: 1.5;
            }
            .markdown-slide-content h1,
            .markdown-slide-content h2 {
                margin-top: 0;
                line-height: 1.08;
            }
            .markdown-slide-content h1 {
                font-size: 2.8rem;
            }
            .markdown-slide-content h2 {
                font-size: 2.25rem;
            }
            .markdown-slide-content h3 {
                font-size: 1.65rem;
            }
            .markdown-slide-content p,
            .markdown-slide-content li {
                font-size: 1.24rem;
            }
            .markdown-slide-content pre {
                max-height: 36vh;
            }
            .markdown-slide-content img {
                max-height: 48vh;
                object-fit: contain;
            }
            .markdown-slide-controls {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                margin-top: 14px;
                font-family: "Segoe UI", "SF Pro Text", "Helvetica Neue", "Ubuntu", "Arial", sans-serif;
            }
            .markdown-slide-button-group {
                display: inline-flex;
                gap: 3px;
                padding: 3px;
                border: 1px solid var(--markdown-control-border);
                border-radius: 8px;
                background: var(--markdown-control-bg);
            }
            .markdown-slide-status {
                min-width: 72px;
                color: var(--markdown-control-muted);
                font-size: 0.9rem;
                text-align: center;
            }
            .markdown-slide-progress {
                height: 4px;
                flex: 1 1 auto;
                overflow: hidden;
                border-radius: 999px;
                background: var(--markdown-slide-surface-2);
                border: 1px solid var(--markdown-slide-border);
            }
            .markdown-slide-progress-bar {
                height: 100%;
                width: 0;
                background: var(--markdown-control-border-active);
                transition: width 0.18s ease;
            }
            .markdown-body img {
                max-width: 100%; /* Korrigiert von 150% auf 100% */
                height: auto;
                display: block;
                margin-left: auto;
                margin-right: auto;
                border-radius: 3px;
            }
            .markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6 {
                margin-top: 1.8em;
                margin-bottom: 0.7em;
                padding-bottom: 0.3em; /* Für die untere Linie */
            }
            .markdown-body h1:hover, .markdown-body h2:hover, .markdown-body h3:hover, .markdown-body h4:hover, .markdown-body h5:hover, .markdown-body h6:hover {
                text-decoration: underline; /* Direkte Unterstreichung der Überschriften beim Hovern */
            }
            .markdown-body h1 { font-size: 2.1em; }
            .markdown-body h2 { font-size: 1.7em; }
            .markdown-body h3 { font-size: 1.4em; }
            .markdown-body h4 { font-size: 1.2em; }
            .markdown-body h5 { font-size: 1.05em; }
            .markdown-body h6 { font-size: 0.9em; }

            /* Code font family (colors/backgrounds are in theme) */
            .markdown-body code, .markdown-body kbd, .markdown-body samp, .markdown-body pre {
                font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;
                font-size: 0.9em; /* Etwas kleiner für bessere Lesbarkeit im Fließtext */
            }
            .markdown-body pre {
                padding: 16px;
                overflow: auto;
                border-radius: 6px;
                line-height: 1.45;
            }
            .markdown-body code:not(pre code) { /* Inline code */
                padding: .2em .4em;
                margin: 0 .2em; /* Kleiner horizontaler Abstand */
                font-size: 88%; /* Relativ zur umgebenden Schriftgröße */
                border-radius: 3px;
            }
            .markdown-body kbd {
                padding: .2em .4em;
                margin: 0 .2em;
                font-size: 88%;
                border-radius: 3px;
            }
            .markdown-body ul, .markdown-body ol {
                padding-left: 2em; /* Standardeinzug für Listen */
            }
            .markdown-body table {
                display: block; /* Für Responsivität und Overflow */
                width: max-content; /* Passt sich dem Inhalt an, aber nicht breiter als Container */
                max-width: 100%;
                overflow: auto; /* Scrollbar bei Bedarf */
                border-spacing: 0;
                border-collapse: collapse;
                margin-top: 1em;
                margin-bottom: 1em;
            }
            .markdown-body table th, .markdown-body table td {
                padding: 6px 13px;
            }
            .markdown-body blockquote {
                margin-left: 0; /* Standard-Blockquote-Styling */
                margin-right: 0;
                padding: 0 1em; /* Innenabstand */
            }
            @media (max-width: 767px) {
                .markdown-viewer-toolbar {
                    padding: 12px 15px 0;
                    justify-content: stretch;
                }
                .markdown-viewer-toggle {
                    width: 100%;
                }
                .markdown-viewer-toggle-button {
                    flex: 1 1 0;
                    min-width: 0;
                }
                .markdown-body {
                    padding: 20px 15px 15px;
                }
                .markdown-slides-panel {
                    min-height: calc(100vh - 50px);
                    padding: 12px 10px 20px;
                }
                .markdown-slide-stage {
                    min-height: 420px;
                    max-height: none;
                    aspect-ratio: auto;
                }
                .markdown-slide {
                    padding: 30px 24px;
                }
                .markdown-slide-content.markdown-body {
                    font-size: 1rem;
                }
                .markdown-slide-content h1 { font-size: 2rem; }
                .markdown-slide-content h2 { font-size: 1.65rem; }
                .markdown-slide-content h3 { font-size: 1.35rem; }
                .markdown-slide-content p,
                .markdown-slide-content li { font-size: 1rem; }
                .markdown-slide-controls {
                    align-items: stretch;
                    flex-wrap: wrap;
                }
                .markdown-slide-button-group {
                    flex: 1 1 auto;
                }
                .markdown-slide-button {
                    flex: 1 1 0;
                    min-width: 0;
                }
                .markdown-slide-progress {
                    flex-basis: 100%;
                }
                .markdown-body h1 { font-size: 1.8em; }
                .markdown-body h2 { font-size: 1.5em; }
                .markdown-body h3 { font-size: 1.3em; }
            }

            /* Custom Button Base Style */
            .custom-play-button {
                display: inline-block;
                padding: 10px 18px;
                text-decoration: none !important;
                border-radius: 5px;
                border: none;
                font-family: "Segoe UI", "SF Pro Text", "Helvetica Neue", "Ubuntu", "Arial", sans-serif;
                font-size: 0.95em;
                font-weight: 500;
                text-align: center;
                cursor: pointer;
                margin: 8px 0;
                transition: background-color 0.2s ease-in-out, border-color 0.2s ease-in-out;
            }
            .custom-play-button a {
                color: inherit !important;
                text-decoration: none !important;
            }
        `);
    }

    function normalizeSafeUrl(rawUrl, allowedProtocols) {
        if (typeof rawUrl !== 'string') {
            return null;
        }

        const trimmedUrl = rawUrl.trim();
        if (!trimmedUrl) {
            return null;
        }

        if (trimmedUrl.startsWith('//') && !['http:', 'https:'].includes(location.protocol)) {
            return null;
        }

        try {
            const parsedUrl = new URL(trimmedUrl, location.href);
            return allowedProtocols.has(parsedUrl.protocol) ? parsedUrl.href : null;
        } catch {
            return null;
        }
    }

    function sanitizeInlineHtml(html) {
        return DOMPurify.sanitize(html, {
            USE_PROFILES: { html: true },
            ALLOWED_URI_REGEXP: ALLOWED_URI_REGEXP,
            FORBID_TAGS: ['style']
        });
    }

    function normalizeLinkRendererArgs(rendererContext, hrefOrToken, title, text) {
        if (hrefOrToken && typeof hrefOrToken === 'object') {
            const token = hrefOrToken;
            const renderedText = Array.isArray(token.tokens) && rendererContext &&
                rendererContext.parser && typeof rendererContext.parser.parseInline === 'function'
                ? rendererContext.parser.parseInline(token.tokens)
                : (token.text || '');

            return {
                href: token.href,
                title: token.title,
                text: renderedText
            };
        }

        return {
            href: hrefOrToken,
            title,
            text: text || ''
        };
    }

    function buildSafeLinkHtml({ href, title, htmlText, textContent, className, target, rel }) {
        const safeHref = normalizeSafeUrl(href, SAFE_HREF_PROTOCOLS);
        const fallbackHtml = typeof htmlText === 'string' ? sanitizeInlineHtml(htmlText) : '';
        const fallbackText = typeof textContent === 'string' ? textContent : fallbackHtml;

        if (!safeHref) {
            return fallbackText;
        }

        const anchor = document.createElement('a');
        anchor.href = safeHref;

        if (title) {
            anchor.title = title;
        }
        if (className) {
            anchor.className = className;
        }
        if (target) {
            anchor.target = target;
        }
        if (rel) {
            anchor.rel = rel;
        }

        if (typeof textContent === 'string') {
            anchor.textContent = textContent;
        } else {
            anchor.innerHTML = fallbackHtml;
        }

        return anchor.outerHTML;
    }

    function enforceSafeUrlAttributes(root) {
        root.querySelectorAll('[href]').forEach((element) => {
            const safeHref = normalizeSafeUrl(element.getAttribute('href'), SAFE_HREF_PROTOCOLS);

            if (!safeHref) {
                element.removeAttribute('href');
                element.removeAttribute('target');
                element.removeAttribute('rel');
                return;
            }

            element.setAttribute('href', safeHref);
        });

        root.querySelectorAll('[src]').forEach((element) => {
            const safeSrc = normalizeSafeUrl(element.getAttribute('src'), SAFE_SRC_PROTOCOLS);

            if (!safeSrc) {
                element.removeAttribute('src');
                return;
            }

            element.setAttribute('src', safeSrc);
        });
    }

    function sanitizeMarkdownHtml(dirtyHtml) {
        const cleanFragment = DOMPurify.sanitize(dirtyHtml, {
            USE_PROFILES: { html: true },
            ALLOWED_URI_REGEXP: ALLOWED_URI_REGEXP,
            FORBID_TAGS: ['style'],
            RETURN_DOM_FRAGMENT: true
        });

        enforceSafeUrlAttributes(cleanFragment);
        return cleanFragment;
    }


    function splitMarkdownIntoSlides(markdownText) {
        let lines = String(markdownText || '').replace(/\r\n?/g, '\n').split('\n');
        if (/^\s*---\s*$/.test(lines[0] || '')) {
            const closingIndex = lines.slice(1).findIndex((line) => /^\s*---\s*$/.test(line));
            const frontMatterLines = closingIndex >= 0 ? lines.slice(1, closingIndex + 1) : [];
            const looksLikeFrontMatter = frontMatterLines.some((line) => /^\s*[A-Za-z0-9_-]+:\s*/.test(line));
            if (looksLikeFrontMatter) {
                lines = lines.slice(closingIndex + 2);
            }
        }

        const explicitSlides = [];
        let currentSlideLines = [];
        let foundExplicitSeparator = false;
        let insideFence = false;

        lines.forEach((line) => {
            if (/^\s*(```|~~~)/.test(line)) {
                insideFence = !insideFence;
            }

            if (!insideFence && /^\s*---+\s*$/.test(line)) {
                foundExplicitSeparator = true;
                explicitSlides.push(currentSlideLines.join('\n').trim());
                currentSlideLines = [];
                return;
            }

            currentSlideLines.push(line);
        });

        if (foundExplicitSeparator) {
            explicitSlides.push(currentSlideLines.join('\n').trim());
            const nonEmptySlides = explicitSlides.filter(Boolean);
            return nonEmptySlides.length ? nonEmptySlides : ['# Slide'];
        }

        const headingSlides = [];
        currentSlideLines = [];
        insideFence = false;

        lines.forEach((line) => {
            if (/^\s*(```|~~~)/.test(line)) {
                insideFence = !insideFence;
            }

            if (!insideFence && /^\s*#{1,2}\s+/.test(line) && currentSlideLines.join('\n').trim()) {
                headingSlides.push(currentSlideLines.join('\n').trim());
                currentSlideLines = [];
            }

            currentSlideLines.push(line);
        });

        headingSlides.push(currentSlideLines.join('\n').trim());
        const nonEmptySlides = headingSlides.filter(Boolean);
        return nonEmptySlides.length ? nonEmptySlides : ['# Slide'];
    }

    function getInitialViewMode() {
        const storedMode = GM_getValue(VIEW_MODE_KEY, 'markdown');
        return VIEW_MODES.has(storedMode) ? storedMode : 'markdown';
    }

    function isEditableElement(element) {
        if (!element) {
            return false;
        }

        const tagName = String(element.tagName || '').toLowerCase();
        return element.isContentEditable || ['input', 'textarea', 'select', 'button'].includes(tagName);
    }

    function createSlidesPanel(markdownText) {
        const panel = document.createElement('section');
        panel.className = 'markdown-slides-panel markdown-viewer-panel';
        panel.setAttribute('aria-label', 'Slide deck view');

        const deck = document.createElement('div');
        deck.className = 'markdown-slide-deck';

        const stage = document.createElement('div');
        stage.className = 'markdown-slide-stage';

        const slideSources = splitMarkdownIntoSlides(markdownText);
        const slides = slideSources.map((slideMarkdown, index) => {
            const slide = document.createElement('section');
            slide.className = 'markdown-slide';
            slide.setAttribute('aria-label', `Slide ${index + 1}`);

            const slideContent = document.createElement('div');
            slideContent.className = 'markdown-body markdown-slide-content';
            slideContent.replaceChildren(sanitizeMarkdownHtml(marked.parse(slideMarkdown)));
            slide.appendChild(slideContent);
            stage.appendChild(slide);
            return slide;
        });

        const controls = document.createElement('div');
        controls.className = 'markdown-slide-controls';

        const navGroup = document.createElement('div');
        navGroup.className = 'markdown-slide-button-group';

        const previousButton = document.createElement('button');
        previousButton.type = 'button';
        previousButton.className = 'markdown-slide-button';
        previousButton.textContent = 'Prev';

        const nextButton = document.createElement('button');
        nextButton.type = 'button';
        nextButton.className = 'markdown-slide-button';
        nextButton.textContent = 'Next';

        navGroup.append(previousButton, nextButton);

        const slideStatus = document.createElement('div');
        slideStatus.className = 'markdown-slide-status';

        const progress = document.createElement('div');
        progress.className = 'markdown-slide-progress';
        const progressBar = document.createElement('div');
        progressBar.className = 'markdown-slide-progress-bar';
        progress.appendChild(progressBar);

        const presentGroup = document.createElement('div');
        presentGroup.className = 'markdown-slide-button-group';

        const presentButton = document.createElement('button');
        presentButton.type = 'button';
        presentButton.className = 'markdown-slide-button';
        presentButton.textContent = 'Present';
        presentGroup.appendChild(presentButton);

        controls.append(navGroup, slideStatus, progress, presentGroup);
        deck.append(stage, controls);
        panel.appendChild(deck);

        let currentSlideIndex = 0;

        function setSlide(nextIndex) {
            currentSlideIndex = Math.max(0, Math.min(slides.length - 1, nextIndex));
            slides.forEach((slide, index) => {
                const isActive = index === currentSlideIndex;
                slide.classList.toggle('is-active', isActive);
                slide.hidden = !isActive;
            });

            previousButton.disabled = currentSlideIndex === 0;
            nextButton.disabled = currentSlideIndex === slides.length - 1;
            slideStatus.textContent = `${currentSlideIndex + 1} / ${slides.length}`;
            progressBar.style.width = `${((currentSlideIndex + 1) / slides.length) * 100}%`;
        }

        previousButton.addEventListener('click', () => setSlide(currentSlideIndex - 1));
        nextButton.addEventListener('click', () => setSlide(currentSlideIndex + 1));
        presentButton.addEventListener('click', () => {
            if (stage.requestFullscreen) {
                stage.requestFullscreen();
            }
        });

        document.addEventListener('keydown', (event) => {
            if (panel.hidden || isEditableElement(event.target)) {
                return;
            }

            if (['ArrowRight', 'PageDown', ' '].includes(event.key)) {
                event.preventDefault();
                setSlide(currentSlideIndex + 1);
            } else if (['ArrowLeft', 'PageUp'].includes(event.key)) {
                event.preventDefault();
                setSlide(currentSlideIndex - 1);
            } else if (event.key === 'Home') {
                event.preventDefault();
                setSlide(0);
            } else if (event.key === 'End') {
                event.preventDefault();
                setSlide(slides.length - 1);
            }
        });

        setSlide(0);

        return {
            panel,
            setSlide
        };
    }

    function createViewerShell(markdownPanel, slidesPanel, onModeChange) {
        const shell = document.createElement('main');
        shell.className = 'markdown-viewer-shell';

        const toolbar = document.createElement('div');
        toolbar.className = 'markdown-viewer-toolbar';

        const toggle = document.createElement('div');
        toggle.className = 'markdown-viewer-toggle';
        toggle.setAttribute('role', 'group');
        toggle.setAttribute('aria-label', 'View mode');

        const markdownButton = document.createElement('button');
        markdownButton.type = 'button';
        markdownButton.className = 'markdown-viewer-toggle-button';
        markdownButton.textContent = 'Markdown';
        markdownButton.dataset.viewMode = 'markdown';

        const slidesButton = document.createElement('button');
        slidesButton.type = 'button';
        slidesButton.className = 'markdown-viewer-toggle-button';
        slidesButton.textContent = 'Slides';
        slidesButton.dataset.viewMode = 'slides';

        [markdownButton, slidesButton].forEach((button) => {
            button.addEventListener('click', () => onModeChange(button.dataset.viewMode));
            toggle.appendChild(button);
        });

        toolbar.appendChild(toggle);
        shell.append(toolbar, markdownPanel, slidesPanel);

        return {
            shell,
            buttons: {
                markdown: markdownButton,
                slides: slidesButton
            }
        };
    }

    function showError(markdownBodyDiv, message) {
        const errorParagraph = document.createElement('p');
        errorParagraph.style.color = 'red';
        errorParagraph.style.fontFamily = 'sans-serif';
        errorParagraph.textContent = message;

        markdownBodyDiv.replaceChildren(errorParagraph);
        document.body.replaceChildren(markdownBodyDiv);
    }

    // --- MAIN SCRIPT EXECUTION ---
    function initializeViewer() {
        applyBaseStyles();
        applyThemeStyle();
        applyFontStyle();

        // Listener für System-Theme-Änderungen
        if (GM_getValue(THEME_KEY, 'system') === 'system') {
            const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
            mediaQuery.removeEventListener('change', applyThemeStyle); // Vorsichtshalber entfernen
            mediaQuery.addEventListener('change', applyThemeStyle);
        }

        const markdownBodyDiv = document.createElement('div');
        markdownBodyDiv.className = 'markdown-body markdown-viewer-panel';

        // Überprüfen, ob marked durch @require geladen wurde
        if (typeof marked === 'undefined' || typeof marked.parse !== 'function') {
            console.error("Markdown Viewer: Marked.js library not loaded correctly via @require or 'parse' function is missing.");
            console.error("Markdown Viewer: typeof marked:", typeof marked);
            if (typeof marked !== 'undefined') {
                console.error("Markdown Viewer: marked properties:", Object.keys(marked));
                console.error("Markdown Viewer: typeof marked.parse:", typeof marked.parse);
            }
            showError(markdownBodyDiv, 'Error: Marked.js library could not be loaded. Check console for details.');
            return;
        }

        if (typeof DOMPurify === 'undefined' || typeof DOMPurify.sanitize !== 'function') {
            console.error("Markdown Viewer: DOMPurify library not loaded correctly via @require or 'sanitize' function is missing.");
            showError(markdownBodyDiv, 'Error: DOMPurify library could not be loaded. Check console for details.');
            return;
        }

        try {
            let markdownContentToParse = "";
            if (document.contentType === 'text/markdown' ||
                (location.protocol === 'file:' && document.body && document.body.children.length === 1 && document.body.firstChild.tagName === 'PRE')) {
                markdownContentToParse = document.body.firstChild.innerText;
            } else if (document.body && document.body.innerText) {
                markdownContentToParse = document.body.innerText;
            } else if (document.body && document.body.textContent) {
                 markdownContentToParse = document.body.textContent;
            }

            const renderer = new marked.Renderer();

            renderer.link = function(hrefOrToken, title, text) {
                const linkArgs = normalizeLinkRendererArgs(this, hrefOrToken, title, text);
                const buttonPattern = /^\s*<kbd>\s*<br>\s*➡️ Play it right now in your browser\s*<br>\s*<\/kbd>\s*$/i;

                if (buttonPattern.test(linkArgs.text)) {
                    return buildSafeLinkHtml({
                        href: linkArgs.href,
                        title: linkArgs.title,
                        textContent: '➡️ Play it right now in your browser',
                        className: 'custom-play-button',
                        target: '_blank',
                        rel: 'noopener noreferrer'
                    });
                }

                return buildSafeLinkHtml({
                    href: linkArgs.href,
                    title: linkArgs.title,
                    htmlText: linkArgs.text
                });
            };

            marked.use({ renderer });

            const dirtyHtmlContent = marked.parse(markdownContentToParse);
            const sanitizedFragment = sanitizeMarkdownHtml(dirtyHtmlContent);
            markdownBodyDiv.replaceChildren(sanitizedFragment);

            const slidesView = createSlidesPanel(markdownContentToParse);
            let currentViewMode = getInitialViewMode();

            const setViewMode = (requestedMode) => {
                currentViewMode = VIEW_MODES.has(requestedMode) ? requestedMode : 'markdown';
                GM_setValue(VIEW_MODE_KEY, currentViewMode);

                markdownBodyDiv.hidden = currentViewMode !== 'markdown';
                slidesView.panel.hidden = currentViewMode !== 'slides';
                viewerControls.buttons.markdown.classList.toggle('is-active', currentViewMode === 'markdown');
                viewerControls.buttons.markdown.setAttribute('aria-pressed', String(currentViewMode === 'markdown'));
                viewerControls.buttons.slides.classList.toggle('is-active', currentViewMode === 'slides');
                viewerControls.buttons.slides.setAttribute('aria-pressed', String(currentViewMode === 'slides'));
            };

            const viewerControls = createViewerShell(markdownBodyDiv, slidesView.panel, setViewMode);
            viewerState.setViewMode = setViewMode;

            document.body.replaceChildren(viewerControls.shell);
            setViewMode(currentViewMode);

        } catch (e) {
            console.error("Markdown Viewer: Error during Markdown parsing:", e);
            showError(markdownBodyDiv, `Error rendering Markdown: ${e.message}. Check console for details.`);
        }
    }

    // Stelle sicher, dass das DOM bereit ist, bevor es manipuliert wird
    if (document.readyState === "complete" || document.readyState === "interactive") {
        initializeViewer();
    } else {
        document.addEventListener("DOMContentLoaded", initializeViewer);
    }

})();
