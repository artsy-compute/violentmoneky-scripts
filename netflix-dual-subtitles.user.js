// ==UserScript==
// @name         Netflix Dual Subtitles
// @namespace    http://tampermonkey.net/
// @version      0.7.7
// @description  Manually select Traditional Chinese and Japanese Netflix subtitles once; cache intercepted subtitle XML and display both together.
// @description:en Manually select Traditional Chinese and Japanese Netflix subtitles once; cache intercepted subtitle XML and display both together.
// @author       artsy-compute
// @license      MIT
// @match        https://www.netflix.com/watch/*
// @run-at       document-start
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      netflix.com
// @connect      *.netflix.com
// @connect      nflxvideo.net
// @connect      *.nflxvideo.net
// ==/UserScript==

(function() {
    'use strict';

    const ROOT_ID = 'netflix-dual-subtitles-root';
    const STYLE_ID = 'netflix-dual-subtitles-style';
    const BRIDGE_EVENT = 'netflix-dual-subtitles:response';
    const LANGS = ['zh-TW', 'ja'];
    const RENDER_INTERVAL_MS = 100;
    const MAX_RESPONSE_CHARS = 4_000_000;
    const CACHE_VERSION = 3;

    const state = {
        enabled: true,
        showStatus: false,
        requestedUrls: new Set(),
        displayLangs: [...LANGS],
        tracks: new Map(),
        root: null,
        textNode: null,
        statusNode: null,
        toastNode: null,
        toastTimer: null,
        lastText: '',
        status: 'manual mode: select zh-TW subtitle, then Japanese',
        ignoredPayloads: 0
    };

    function videoId() {
        const match = location.pathname.match(/\/watch\/(\d+)/);
        return match ? match[1] : 'unknown';
    }

    function cacheKey(lang) {
        return 'netflix-dual-subtitles:v' + CACHE_VERSION + ':' + videoId() + ':' + lang;
    }

    function notify(message) {
        state.status = message;
        render();

        if (!state.toastNode) {
            return;
        }

        state.toastNode.textContent = message;
        state.toastNode.classList.add('show');
        if (state.toastTimer) {
            clearTimeout(state.toastTimer);
        }
        state.toastTimer = setTimeout(() => {
            if (state.toastNode) {
                state.toastNode.classList.remove('show');
            }
        }, 2600);
    }

    function saveTrack(lang, cues, sourceUrl) {
        if (!cues.length) {
            return false;
        }

        const track = {
            lang,
            cues: cues.slice().sort((a, b) => a.start - b.start),
            sourceUrl: sourceUrl || '',
            savedAt: Date.now()
        };
        state.tracks.set(lang, track);

        try {
            localStorage.setItem(cacheKey(lang), JSON.stringify(track));
        } catch (_) {}

        notify('Captured ' + lang + ' subtitles (' + track.cues.length + ' cues)');
        return true;
    }

    function loadCachedTracks() {
        for (const lang of LANGS) {
            try {
                const raw = localStorage.getItem(cacheKey(lang));
                if (!raw) {
                    continue;
                }

                const track = JSON.parse(raw);
                if (track && track.lang === lang && Array.isArray(track.cues) && track.cues.length) {
                    state.tracks.set(lang, track);
                }
            } catch (_) {}
        }
    }


    function removeLegacyGenericChineseCache() {
        try {
            localStorage.removeItem('netflix-dual-subtitles:v1:' + videoId() + ':zh');
        } catch (_) {}
    }

    function clearCachedTracks() {
        for (const lang of LANGS) {
            state.tracks.delete(lang);
            try {
                localStorage.removeItem(cacheKey(lang));
            } catch (_) {}
        }
        state.lastText = '';
        state.status = 'cache cleared';
        render();
    }

    function addStyles() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            #${ROOT_ID} {
                position: fixed;
                left: 4vw;
                right: 4vw;
                bottom: 11.5vh;
                z-index: 2147483647;
                pointer-events: none;
                display: grid;
                justify-items: center;
                gap: 6px;
                font-family: "Noto Sans CJK TC", "Noto Sans CJK JP", "Hiragino Sans", "Microsoft JhengHei", "Yu Gothic", Arial, sans-serif;
            }
            #${ROOT_ID}.is-hidden { display: none; }
            .nds-lines {
                max-width: min(96vw, 1680px);
                display: grid;
                justify-items: center;
                gap: 4px;
                text-align: center;
            }
            .nds-line {
                padding: 3px 10px 5px;
                border-radius: 4px;
                color: #fff;
                line-height: 1.25;
                text-shadow: 0 2px 3px rgba(0,0,0,.95), 0 0 2px #000;
                white-space: normal;
                overflow-wrap: anywhere;
            }
            .nds-line.is-primary {
                font-size: clamp(17px, 2.2vw, 32px);
                background: rgba(0, 0, 0, 0.50);
                font-weight: 600;
            }
            .nds-line.is-secondary {
                font-size: clamp(20px, 2.65vw, 40px);
                background: rgba(0, 0, 0, 0.58);
                font-weight: 650;
            }
            .nds-status {
                display: none;
                padding: 4px 8px;
                border-radius: 4px;
                background: rgba(18, 18, 18, .78);
                color: #ddd;
                font: 12px/1.35 Arial, sans-serif;
            }
            #${ROOT_ID}.show-status .nds-status { display: block; }
            .nds-toast {
                position: fixed;
                top: 20px;
                right: 20px;
                max-width: min(360px, 86vw);
                padding: 10px 12px;
                border-radius: 6px;
                background: rgba(18, 18, 18, .88);
                color: #fff;
                font: 13px/1.35 Arial, sans-serif;
                box-shadow: 0 10px 28px rgba(0, 0, 0, .32);
                opacity: 0;
                transform: translateY(-6px);
                transition: opacity .18s ease, transform .18s ease;
            }
            .nds-toast.show {
                opacity: 1;
                transform: translateY(0);
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function createOverlay() {
        if (state.root && document.documentElement.contains(state.root)) {
            return;
        }

        addStyles();
        const root = document.createElement('div');
        root.id = ROOT_ID;

        const textNode = document.createElement('div');
        textNode.className = 'nds-lines';

        const statusNode = document.createElement('div');
        statusNode.className = 'nds-status';

        const toastNode = document.createElement('div');
        toastNode.className = 'nds-toast';

        root.appendChild(textNode);
        root.appendChild(statusNode);
        root.appendChild(toastNode);
        (document.body || document.documentElement).appendChild(root);

        state.root = root;
        state.textNode = textNode;
        state.statusNode = statusNode;
        state.toastNode = toastNode;
    }

    function getVideo() {
        const videos = Array.from(document.querySelectorAll('video'));
        return videos.find(video => video.readyState > 0 && !video.paused) || videos[0] || null;
    }

    function cueAt(track, timeMs) {
        if (!track) {
            return null;
        }

        return track.cues.find(cue => timeMs >= cue.start - 80 && timeMs <= cue.end + 500) || null;
    }

    function render() {
        createOverlay();
        if (!state.root || !state.textNode || !state.statusNode) {
            return;
        }

        state.root.classList.toggle('is-hidden', !state.enabled);
        state.root.classList.toggle('show-status', state.showStatus);

        const summary = state.displayLangs.map(lang => lang + ':' + (state.tracks.get(lang)?.cues.length || 0)).join(' ');
        state.statusNode.textContent = state.status + ' | ' + summary + ' | video:' + videoId();

        if (!state.enabled) {
            state.textNode.textContent = '';
            return;
        }

        const video = getVideo();
        if (!video) {
            return;
        }

        const timeMs = video.currentTime * 1000;
        const lines = state.displayLangs.map((lang, index) => ({
            lang,
            role: index === 0 ? 'primary' : 'secondary',
            cue: cueAt(state.tracks.get(lang), timeMs),
        }))
            .filter(item => item.cue && item.cue.text);
        const nextText = lines.map(item => item.lang + ':' + item.cue.text).join('\n');

        if (nextText === state.lastText) {
            return;
        }

        state.textNode.textContent = '';
        for (const item of lines) {
            const line = document.createElement('div');
            line.className = 'nds-line is-' + item.role;
            line.dataset.lang = item.lang;
            line.dataset.role = item.role;
            line.textContent = item.cue.text;
            state.textNode.appendChild(line);
        }
        state.lastText = nextText;
    }

    function decodeEntities(text) {
        const textarea = document.createElement('textarea');
        textarea.innerHTML = text;
        return textarea.value;
    }

    function cleanText(text) {
        return decodeEntities(String(text || '')
            .replace(/<br\s*\/?>/gi, ' ')
            .replace(/<[^>]+>/g, '')
            .replace(/\r/g, '')
            .replace(/\s+/g, ' ')
            .trim());
    }

    function parseTime(value, frameRate = 24, tickRate = 10000000) {
        const raw = String(value || '').trim();
        let match = raw.match(/^(\d+):(?:\d{2}):(?:\d{2})(?:[.,](?:\d{1,3}))?$/);
        if (match) {
            const parts = raw.replace(',', '.').split(':');
            return ((Number(parts[0]) * 3600) + (Number(parts[1]) * 60) + Number(parts[2])) * 1000;
        }

        match = raw.match(/^(\d+):(\d{2}):(\d{2}):(\d{2})$/);
        if (match) {
            return ((Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3]) + Number(match[4]) / frameRate) * 1000;
        }

        match = raw.match(/^(\d+(?:\.\d+)?)(ms|s|t)$/);
        if (match) {
            if (match[2] === 't') {
                return Number(match[1]) / tickRate * 1000;
            }
            return Number(match[1]) * (match[2] === 's' ? 1000 : 1);
        }

        return NaN;
    }

    function parseWebVtt(text) {
        return String(text || '').replace(/\r/g, '').split(/\n{2,}/).map(block => {
            const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
            const timingIndex = lines.findIndex(line => line.includes('-->'));
            if (timingIndex === -1) {
                return null;
            }

            const parts = lines[timingIndex].split('-->');
            const start = parseTime(parts[0]);
            const end = parseTime(parts[1].replace(/\s+.+$/, ''));
            const textValue = cleanText(lines.slice(timingIndex + 1).join('\n'));
            return Number.isFinite(start) && Number.isFinite(end) && textValue ? { start, end, text: textValue } : null;
        }).filter(Boolean);
    }

    function ttmlAttr(root, name, namespace) {
        return root.getAttribute(name) || root.getAttribute('ttp:' + name) || root.getAttributeNS(namespace, name);
    }

    function payloadLang(payload) {
        const text = String(payload || '');
        const match = text.match(/(?:xml:lang|lang)=["']([^"']+)["']/i);
        return match ? match[1] : '';
    }

    function languageMatchesPayload(targetLang, payload) {
        const lang = payloadLang(payload).toLowerCase();
        if (!lang) {
            return true;
        }

        if (targetLang === 'zh-TW') {
            return /^(zh-(tw|hant|hk|mo)|zh_hant|zh-tw|cmn-hant)/i.test(lang) || /hant|traditional|tw/i.test(lang);
        }

        if (targetLang === 'ja') {
            return /^(ja|jpn)(-|_|$)/i.test(lang) || lang === 'ja';
        }

        return true;
    }

    function parseTtml(text) {
        const doc = new DOMParser().parseFromString(String(text || ''), 'application/xml');
        if (doc.querySelector('parsererror')) {
            return [];
        }

        const parameterNs = 'http://www.w3.org/ns/ttml#parameter';
        const root = doc.documentElement;
        const frameRate = Number(ttmlAttr(root, 'frameRate', parameterNs) || 24);
        const tickRate = Number(ttmlAttr(root, 'tickRate', parameterNs) || 10000000);
        return Array.from(doc.getElementsByTagName('*')).filter(node => node.localName === 'p').map(node => {
            const start = parseTime(node.getAttribute('begin'), frameRate, tickRate);
            let end = parseTime(node.getAttribute('end'), frameRate, tickRate);
            const duration = parseTime(node.getAttribute('dur'), frameRate, tickRate);
            if (!Number.isFinite(end) && Number.isFinite(start) && Number.isFinite(duration)) {
                end = start + duration;
            }

            const textValue = cleanText(new XMLSerializer().serializeToString(node));
            return Number.isFinite(start) && Number.isFinite(end) && textValue ? { start, end, text: textValue } : null;
        }).filter(Boolean);
    }

    function parseJsonCues(text) {
        let data;
        try {
            data = JSON.parse(text);
        } catch (_) {
            return [];
        }

        const cues = [];
        const stack = [data];
        while (stack.length) {
            const item = stack.pop();
            if (!item || typeof item !== 'object') {
                continue;
            }

            if (Array.isArray(item)) {
                stack.push(...item);
                continue;
            }

            const start = Number(item.startTime ?? item.start ?? item.begin ?? item.from);
            const end = Number(item.endTime ?? item.end ?? item.to);
            const textValue = cleanText(item.text ?? item.content ?? item.value ?? item.payload ?? '');
            if (Number.isFinite(start) && Number.isFinite(end) && textValue) {
                cues.push({
                    start: start < 10000 ? start * 1000 : start,
                    end: end < 10000 ? end * 1000 : end,
                    text: textValue
                });
            }

            stack.push(...Object.values(item).filter(value => value && typeof value === 'object'));
        }

        return cues;
    }

    function parseCues(payload) {
        const text = String(payload || '').trim();
        if (!text) {
            return [];
        }

        if (/^WEBVTT/i.test(text) || text.includes('-->')) {
            return parseWebVtt(text);
        }
        if (text[0] === '<') {
            return parseTtml(text);
        }
        if (text[0] === '{' || text[0] === '[') {
            return parseJsonCues(text);
        }
        return [];
    }

    function inferPayloadLang(payload) {
        const lang = payloadLang(payload).toLowerCase();
        if (/^(zh-(tw|hant|hk|mo)|zh_hant|cmn-hant)/i.test(lang) || /hant|traditional|tw/i.test(lang)) {
            return 'zh-TW';
        }
        if (/^(ja|jpn)(-|_|$)/i.test(lang) || lang === 'ja') {
            return 'ja';
        }
        return '';
    }

    function subtitleUrlCandidate(url, entry) {
        let parsed;
        try {
            parsed = new URL(url, location.href);
        } catch (_) {
            return false;
        }

        const path = (parsed.pathname + parsed.search).toLowerCase();
        if (path.includes('subtitle') || path.includes('timedtext') || path.includes('dfxp') || path.includes('webvtt') || path.includes('ttml')) {
            return true;
        }

        if (!parsed.hostname.endsWith('nflxvideo.net')) {
            return false;
        }

        return parsed.searchParams.get('o') === '1' &&
            parsed.searchParams.has('v') &&
            parsed.searchParams.has('e') &&
            parsed.searchParams.has('t');
    }

    function gmGet(url) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(new Error('GM_xmlhttpRequest unavailable'));
                return;
            }

            GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType: 'text',
                timeout: 12000,
                onload: resolve,
                onerror: reject,
                ontimeout: () => reject(new Error('timeout'))
            });
        });
    }

    async function fetchCandidate(url, entry) {
        if (!subtitleUrlCandidate(url, entry) || state.requestedUrls.has(url)) {
            return;
        }

        state.requestedUrls.add(url);
        state.status = 'intercepted ?o=1 request #' + state.requestedUrls.size;
        render();

        try {
            const response = await gmGet(url);
            const body = String(response.responseText || '');
            if (response.status >= 400 || body.length > MAX_RESPONSE_CHARS) {
                state.status = 'fetch skipped: HTTP ' + response.status;
                render();
                return;
            }

            rememberPayload(url, body);
        } catch (error) {
            state.status = 'fetch error: ' + (error && error.message ? error.message : 'unknown');
            render();
        }
    }

    function rememberPayload(url, payload) {
        if (typeof payload !== 'string' || payload.length > MAX_RESPONSE_CHARS) {
            return;
        }

        const rawLang = payloadLang(payload) || 'unknown';
        const lang = inferPayloadLang(payload);
        if (!lang) {
            state.ignoredPayloads += 1;
            state.status = 'ignored subtitle payload lang=' + rawLang + ' ignored=' + state.ignoredPayloads;
            render();
            return;
        }
        if (state.tracks.has(lang)) {
            state.status = 'already captured ' + lang + '; ignored duplicate lang=' + rawLang;
            render();
            return;
        }

        const cues = parseCues(payload);
        if (!saveTrack(lang, cues, url)) {
            state.status = 'intercepted ' + rawLang + ' but could not parse len=' + payload.length;
            render();
        }
    }

    function observeSubtitleRequests() {
        const inspect = entry => fetchCandidate(entry.name, entry);

        try {
            performance.getEntriesByType('resource').forEach(inspect);
        } catch (_) {}

        if (typeof PerformanceObserver === 'function') {
            try {
                new PerformanceObserver(list => list.getEntries().forEach(inspect)).observe({ type: 'resource', buffered: true });
            } catch (_) {}
        }
    }

    function injectNetworkBridge() {
        const script = document.createElement('script');
        script.textContent = '(' + function(eventName, maxChars) {
            const originalFetch = window.fetch;
            const originalOpen = XMLHttpRequest.prototype.open;
            const originalSend = XMLHttpRequest.prototype.send;

            function emit(url, payload) {
                if (typeof payload !== 'string' || payload.length > maxChars) {
                    return;
                }
                window.dispatchEvent(new CustomEvent(eventName, { detail: { url: String(url || ''), payload } }));
            }

            function relevant(url, type) {
                return /subtitle|timedtext|dfxp|webvtt|ttml|nflxvideo\.net/i.test(String(url || '')) ||
                    /text|json|xml|vtt|ttml|dfxp|octet-stream/i.test(String(type || ''));
            }

            if (typeof originalFetch === 'function' && !originalFetch.__ndsPatched) {
                window.fetch = function(input) {
                    const requestUrl = input && input.url ? input.url : input;
                    return originalFetch.apply(this, arguments).then(response => {
                        const responseUrl = response.url || requestUrl;
                        const type = response.headers && response.headers.get ? response.headers.get('content-type') : '';
                        if (response.clone && relevant(responseUrl, type)) {
                            response.clone().text().then(text => emit(responseUrl, text)).catch(() => {});
                        }
                        return response;
                    });
                };
                window.fetch.__ndsPatched = true;
            }

            if (!XMLHttpRequest.prototype.open.__ndsPatched) {
                XMLHttpRequest.prototype.open = function(method, url) {
                    this.__ndsUrl = url;
                    return originalOpen.apply(this, arguments);
                };
                XMLHttpRequest.prototype.open.__ndsPatched = true;
            }

            if (!XMLHttpRequest.prototype.send.__ndsPatched) {
                XMLHttpRequest.prototype.send = function() {
                    this.addEventListener('load', function() {
                        const url = this.responseURL || this.__ndsUrl || '';
                        const type = this.getResponseHeader('content-type') || '';
                        if ((!this.responseType || this.responseType === 'text') && relevant(url, type)) {
                            emit(url, this.responseText);
                        }
                    });
                    return originalSend.apply(this, arguments);
                };
                XMLHttpRequest.prototype.send.__ndsPatched = true;
            }
        }.toString() + ')(' + JSON.stringify(BRIDGE_EVENT) + ',' + MAX_RESPONSE_CHARS + ');';
        (document.head || document.documentElement).appendChild(script);
        script.remove();
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function registerMenu() {
        if (typeof GM_registerMenuCommand !== 'function') {
            return;
        }

        GM_registerMenuCommand('Netflix Dual Subtitles: Switch main/secondary', () => {
            state.displayLangs.reverse();
            state.lastText = '';
            render();
        });
        GM_registerMenuCommand('Netflix Dual Subtitles: Toggle status', () => {
            state.showStatus = !state.showStatus;
            render();
        });
        GM_registerMenuCommand('Netflix Dual Subtitles: Clear cache', () => clearCachedTracks());
    }

    function init() {
        injectNetworkBridge();
        window.addEventListener(BRIDGE_EVENT, event => rememberPayload(event.detail.url, event.detail.payload));
        observeSubtitleRequests();
        registerMenu();
        removeLegacyGenericChineseCache();
        loadCachedTracks();

        const startup = setInterval(() => {
            if (document.body) {
                createOverlay();
                render();
                clearInterval(startup);
            }
        }, 50);

        setInterval(render, RENDER_INTERVAL_MS);
    }

    init();
})();
