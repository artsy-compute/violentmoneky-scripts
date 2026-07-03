// ==UserScript==
// @name         Netflix Dual Subtitles
// @namespace    http://tampermonkey.net/
// @version      0.10.4
// @description  Load Netflix subtitle languages from the manifest; fetch selected tracks by manifest URL and display two subtitles together.
// @description:en Load Netflix subtitle languages from the manifest; fetch selected tracks by manifest URL and display two subtitles together.
// @author       artsy-compute
// @license      MIT
// @match        https://www.netflix.com/*
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
    const RENDER_INTERVAL_MS = 100;
    const MAX_RESPONSE_CHARS = 4_000_000;
    const CACHE_VERSION = 3;
    const MAX_DISPLAY_LANGS = 2;
    const MANIFEST_SCAN_LIMIT = 50000;
    const SELECTOR_IDLE_HIDE_MS = 2600;
    const PREFETCH_DELAY_MS = 140;
    const HIDE_NATIVE_PREF_KEY = 'netflix-dual-subtitles:hide-native';

    function loadHideNativePreference() {
        try {
            return localStorage.getItem(HIDE_NATIVE_PREF_KEY) !== '0';
        } catch (_) {
            return true;
        }
    }

    function saveHideNativePreference(value) {
        try {
            localStorage.setItem(HIDE_NATIVE_PREF_KEY, value ? '1' : '0');
        } catch (_) {}
    }

    const state = {
        enabled: true,
        showStatus: false,
        hideNative: loadHideNativePreference(),
        requestedUrls: new Set(),
        resourceObserverStarted: false,
        historyPatched: false,
        videoId: '',
        displayLangs: [],
        manualDisplay: false,
        selectorOpen: false,
        selectorVisible: true,
        selectorHover: false,
        selectorHideTimer: null,
        selectorSignature: '',
        nativeOptions: [],
        manifestOptions: [],
        prefetchQueue: [],
        prefetchActive: false,
        prefetchedOptionKeys: new Set(),
        pendingSlots: {},
        pendingSlotValues: {},
        pendingCaptureSlot: '',
        tracks: new Map(),
        root: null,
        textNode: null,
        statusNode: null,
        selectorNode: null,
        toastNode: null,
        toastTimer: null,
        lastText: '',
        status: 'manual mode: select subtitle languages; latest two are shown',
        ignoredPayloads: 0
    };

    function videoId() {
        const match = location.pathname.match(/\/watch\/(\d+)/);
        return match ? match[1] : '';
    }

    function cachePrefix() {
        return 'netflix-dual-subtitles:v' + CACHE_VERSION + ':' + (state.videoId || videoId() || 'unknown') + ':';
    }

    function cacheKey(lang) {
        return cachePrefix() + lang;
    }

    function langIndexKey() {
        return cachePrefix() + '__langs';
    }

    function normalizeNativeLabel(label) {
        return String(label || '')
            .replace(/\s+/g, ' ')
            .replace(/^[✓✔•\-\s]+/, '')
            .replace(/\s+(?:selected|已選取|已选取)$/i, '')
            .trim();
    }

    function nativeLabelKey(label) {
        return normalizeNativeLabel(label).toLowerCase();
    }

    function langFromNativeLabel(label) {
        const raw = normalizeNativeLabel(label).toLowerCase();
        if (!raw) {
            return '';
        }
        if (/日本語|日語|日文|japanese|ja(?:pan)?/.test(raw)) {
            return 'ja';
        }
        if (/繁體|繁体|traditional chinese|chinese.*traditional|中文.*繁|zh[-_ ]?(tw|hant|hk)/.test(raw)) {
            return 'zh-TW';
        }
        if (/简体|簡體|simplified chinese|chinese.*simplified|中文.*简|中文.*簡|zh[-_ ]?(cn|hans)/.test(raw)) {
            return 'zh-CN';
        }
        if (/english|英語|英语|英文/.test(raw)) {
            return 'en';
        }
        if (/korean|한국어|韓国語|韓語|韓文|韩国语|韩语|韩文/.test(raw)) {
            return 'ko';
        }
        if (/spanish|español|espanol|西班牙語|西班牙语/.test(raw)) {
            return 'es';
        }
        if (/french|français|francais|法語|法语/.test(raw)) {
            return 'fr';
        }
        if (/german|deutsch|德語|德语/.test(raw)) {
            return 'de';
        }
        if (/italian|italiano|義大利語|意大利语/.test(raw)) {
            return 'it';
        }
        if (/portuguese|português|portugues|葡萄牙語|葡萄牙语/.test(raw)) {
            return 'pt';
        }
        if (/thai|ไทย/.test(raw)) {
            return 'th';
        }
        if (/vietnamese|tiếng việt|tieng viet/.test(raw)) {
            return 'vi';
        }
        return '';
    }

    function normalizeLang(raw) {
        const lang = String(raw || '').trim().toLowerCase().replace(/_/g, '-');
        if (!lang) {
            return '';
        }

        if (/^(ja|jpn)(-|$)/.test(lang)) {
            return 'ja';
        }
        if (/^(zh-(tw|hant|hk|mo)|cmn-hant)(-|$)/.test(lang) || /hant|traditional/.test(lang)) {
            return 'zh-TW';
        }
        if (/^(zh-(cn|hans|sg)|cmn-hans)(-|$)/.test(lang) || /hans|simplified/.test(lang)) {
            return 'zh-CN';
        }

        const parts = lang.split('-').filter(Boolean);
        if (!parts.length) {
            return '';
        }
        if (parts.length === 1) {
            return parts[0];
        }
        return parts[0] + '-' + parts.slice(1).map(part => part.length === 2 ? part.toUpperCase() : part).join('-');
    }

    function normalizeTrackKey(value) {
        return String(value || '').trim();
    }

    function trackCacheKey(track) {
        if (!track) {
            return '';
        }
        return normalizeTrackKey(track.key || track.trackKey || track.lang || '');
    }

    function trackDisplayLabel(track) {
        if (!track) {
            return '';
        }
        const label = normalizeNativeLabel(track.label || track.displayName || '');
        const lang = normalizeLang(track.lang || '');
        if (label && lang && !label.toLowerCase().includes(lang.toLowerCase())) {
            return label + ' [' + lang + ']';
        }
        return label || lang || trackCacheKey(track);
    }

    function resolveTrackKey(value) {
        const raw = normalizeTrackKey(String(value || '').replace(/^cached:/, ''));
        if (!raw) {
            return '';
        }
        if (state.tracks.has(raw)) {
            return raw;
        }

        const normalized = normalizeLang(raw);
        if (normalized && state.tracks.has(normalized)) {
            return normalized;
        }
        if (normalized) {
            const match = Array.from(state.tracks.values())
                .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
                .find(track => normalizeLang(track.lang) === normalized);
            return match ? trackCacheKey(match) : '';
        }
        return '';
    }

    function knownTrackKeys() {
        const keys = new Set(Array.from(state.tracks.values()).map(trackCacheKey).filter(Boolean));
        try {
            const indexed = JSON.parse(localStorage.getItem(langIndexKey()) || '[]');
            if (Array.isArray(indexed)) {
                indexed.map(normalizeTrackKey).filter(Boolean).forEach(key => keys.add(key));
            }
        } catch (_) {}
        return Array.from(keys);
    }

    function saveLangIndex() {
        try {
            localStorage.setItem(langIndexKey(), JSON.stringify(knownTrackKeys().sort()));
        } catch (_) {}
    }

    function mergedNativeOptions() {
        const merged = new Map();
        [...state.manifestOptions, ...state.nativeOptions].forEach(option => {
            if (option && option.key && !merged.has(option.key)) {
                merged.set(option.key, option);
            }
        });
        return Array.from(merged.values()).sort((a, b) => a.label.localeCompare(b.label));
    }

    function cachedTrackKeyForOption(option) {
        if (!option) {
            return '';
        }
        if (option.key && state.tracks.has(option.key)) {
            return option.key;
        }
        const match = Array.from(state.tracks.values()).find(track =>
            option.key && track.optionKey === option.key ||
            option.urls && option.urls.some(url => url && url === track.sourceUrl)
        );
        return match ? trackCacheKey(match) : '';
    }

    function officialOptionCached(option) {
        return !!cachedTrackKeyForOption(option);
    }

    function latestTrackKeys() {
        return Array.from(state.tracks.values())
            .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
            .map(trackCacheKey)
            .filter(Boolean);
    }

    function setLatestDisplayLangs() {
        state.manualDisplay = false;
        state.displayLangs = latestTrackKeys().slice(0, MAX_DISPLAY_LANGS);
        state.lastText = '';
        state.selectorSignature = '';
    }

    function promoteDisplayLang(value) {
        const key = resolveTrackKey(value);
        if (!key || state.manualDisplay) {
            return false;
        }

        const before = state.displayLangs.join('\n');
        state.displayLangs = [key, ...state.displayLangs.filter(item => item !== key)]
            .filter(item => state.tracks.has(item))
            .slice(0, MAX_DISPLAY_LANGS);
        state.lastText = '';
        state.selectorSignature = '';
        return before !== state.displayLangs.join('\n');
    }

    function setDisplaySlot(slot, value) {
        const index = slot === 'secondary' ? 1 : 0;
        const key = resolveTrackKey(value);
        const next = state.displayLangs.filter(item => state.tracks.has(item));

        state.manualDisplay = true;
        if (!normalizeTrackKey(value)) {
            next.splice(index, 1);
        } else if (key && state.tracks.has(key)) {
            next[index] = key;
        } else {
            return;
        }

        state.displayLangs = next.filter((item, itemIndex, array) => item && array.indexOf(item) === itemIndex).slice(0, MAX_DISPLAY_LANGS);
        state.lastText = '';
        state.selectorSignature = '';
        delete state.pendingSlotValues[index === 0 ? 'primary' : 'secondary'];
        notify((index === 0 ? 'Primary' : 'Secondary') + ': ' + (key ? trackDisplayLabel(state.tracks.get(key)) : 'off'));
    }

    function setDisplaySlotValue(slot, value) {
        const raw = String(value || '');
        if (raw.startsWith('official:')) {
            selectOfficialSubtitleForSlot(slot, raw.slice('official:'.length));
            return;
        }
        setDisplaySlot(slot, raw.replace(/^cached:/, ''));
    }

    function setDisplayRole(lang, role) {
        setDisplaySlot(role, lang);
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

    function saveTrack(lang, cues, sourceUrl, options = {}) {
        const normalized = normalizeLang(lang);
        if (!normalized || !cues.length) {
            return false;
        }

        const key = normalizeTrackKey(options.key || options.optionKey || normalized);
        const label = normalizeNativeLabel(options.label || options.displayName || normalized);
        const track = {
            key,
            optionKey: options.optionKey || options.key || '',
            lang: normalized,
            label,
            cues: cues.slice().sort((a, b) => a.start - b.start),
            sourceUrl: sourceUrl || '',
            savedAt: Date.now()
        };
        state.tracks.set(key, track);

        try {
            localStorage.setItem(cacheKey(key), JSON.stringify(track));
        } catch (_) {}
        saveLangIndex();
        if (!options.preserveDisplay) {
            promoteDisplayLang(key);
        } else if (!state.manualDisplay && state.displayLangs.length < MAX_DISPLAY_LANGS && !state.displayLangs.includes(key)) {
            state.displayLangs = [...state.displayLangs, key].slice(0, MAX_DISPLAY_LANGS);
            state.lastText = '';
            state.selectorSignature = '';
        }

        const pendingRole = options.displaySlot || state.pendingSlots[key] || state.pendingSlots[normalized] || state.pendingCaptureSlot;
        if (pendingRole) {
            delete state.pendingSlots[key];
            delete state.pendingSlots[normalized];
            delete state.pendingSlotValues[pendingRole];
            state.pendingCaptureSlot = '';
            setDisplaySlot(pendingRole, key);
        }

        if (!options.silent) {
            notify('Captured ' + trackDisplayLabel(track) + ' subtitles (' + track.cues.length + ' cues)');
        } else {
            state.status = 'cached ' + state.tracks.size + ' subtitle track(s)';
            render();
        }
        return true;
    }

    function loadCachedTracks() {
        const candidates = new Set(knownTrackKeys());
        try {
            const prefix = cachePrefix();
            for (let index = 0; index < localStorage.length; index += 1) {
                const key = localStorage.key(index);
                if (key && key.startsWith(prefix) && key !== langIndexKey()) {
                    candidates.add(normalizeTrackKey(key.slice(prefix.length)));
                }
            }
        } catch (_) {}

        for (const candidateKey of Array.from(candidates).filter(Boolean)) {
            try {
                const raw = localStorage.getItem(cacheKey(candidateKey));
                if (!raw) {
                    continue;
                }

                const track = JSON.parse(raw);
                const trackLang = normalizeLang(track && track.lang || candidateKey);
                if (trackLang && Array.isArray(track.cues) && track.cues.length) {
                    track.lang = trackLang;
                    track.key = normalizeTrackKey(track.key || candidateKey || trackLang);
                    track.label = normalizeNativeLabel(track.label || track.displayName || trackLang);
                    state.tracks.set(track.key, track);
                }
            } catch (_) {}
        }

        setLatestDisplayLangs();
        saveLangIndex();
    }


    function removeLegacyGenericChineseCache() {
        try {
            localStorage.removeItem('netflix-dual-subtitles:v1:' + videoId() + ':zh');
        } catch (_) {}
    }

    function clearCachedTracks() {
        const prefix = cachePrefix();
        state.tracks.clear();
        state.displayLangs = [];
        state.manualDisplay = false;
        state.nativeOptions = [];
        state.manifestOptions = [];
        state.prefetchQueue = [];
        state.prefetchActive = false;
        state.prefetchedOptionKeys.clear();
        state.pendingSlots = {};
        state.pendingSlotValues = {};
        state.pendingCaptureSlot = '';
        state.selectorSignature = '';
        try {
            const keys = [];
            for (let index = 0; index < localStorage.length; index += 1) {
                const key = localStorage.key(index);
                if (key && key.startsWith(prefix)) {
                    keys.push(key);
                }
            }
            keys.forEach(key => localStorage.removeItem(key));
        } catch (_) {}
        state.lastText = '';
        state.status = 'cache cleared';
        render();
    }

    function addStyles() {
        if (document.getElementById(STYLE_ID)) {
            return true;
        }

        const parent = document.head || document.documentElement;
        if (!parent) {
            return false;
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
            html.nds-hide-native-subtitles .player-timedtext-text-container {
                display: none !important;
            }
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
            .nds-selector {
                position: fixed;
                right: max(96px, calc(env(safe-area-inset-right) + 96px));
                bottom: max(84px, calc(env(safe-area-inset-bottom) + 84px));
                pointer-events: auto;
                display: grid;
                justify-items: end;
                gap: 8px;
                color: #fff;
                font: 13px/1.35 Arial, sans-serif;
                opacity: 1;
                transform: translateX(0);
                transition: opacity .18s ease, transform .18s ease;
            }
            .nds-selector.is-idle {
                opacity: 0;
                pointer-events: none;
                transform: translateX(8px);
            }
            .nds-selector-toggle {
                width: 42px;
                height: 42px;
                border: 1px solid rgba(255,255,255,.28);
                border-radius: 999px;
                background: rgba(18, 18, 18, .72);
                color: #fff;
                font: 700 13px/1 Arial, sans-serif;
                cursor: pointer;
            }
            .nds-selector-panel {
                width: min(320px, 84vw);
                max-height: min(58vh, 420px);
                overflow: auto;
                padding: 10px;
                border: 1px solid rgba(255,255,255,.18);
                border-radius: 6px;
                background: rgba(15, 15, 15, .86);
                box-shadow: 0 12px 30px rgba(0,0,0,.36);
                display: grid;
                gap: 8px;
            }
            .nds-selector-title {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                color: #ddd;
            }
            .nds-selector-row {
                display: grid;
                grid-template-columns: 76px minmax(150px, 1fr);
                align-items: center;
                gap: 8px;
            }
            .nds-selector-row label {
                color: #ddd;
            }
            .nds-selector select {
                min-width: 0;
                border: 1px solid rgba(255,255,255,.24);
                border-radius: 5px;
                background: rgba(255,255,255,.1);
                color: #fff;
                padding: 6px 8px;
            }
            .nds-selector option {
                background: #1a1a1a;
                color: #fff;
            }
            .nds-selector-count {
                color: #aaa;
                font-size: 11px;
            }
            .nds-selector button {
                border: 1px solid rgba(255,255,255,.22);
                border-radius: 5px;
                background: rgba(255,255,255,.08);
                color: #fff;
                padding: 6px 8px;
                cursor: pointer;
            }
            .nds-selector button.is-active {
                background: rgba(229, 9, 20, .82);
                border-color: rgba(255,255,255,.38);
            }
            .nds-selector button:disabled {
                cursor: default;
                opacity: .38;
            }
            .nds-selector-empty {
                color: #bbb;
            }
        `;
        parent.appendChild(style);
        return true;
    }

    function fullscreenElement() {
        return document.fullscreenElement ||
            document.webkitFullscreenElement ||
            document.mozFullScreenElement ||
            document.msFullscreenElement ||
            null;
    }

    function overlayParent() {
        return fullscreenElement() || document.body || null;
    }

    function createOverlay() {
        const parent = overlayParent();
        if (!parent) {
            return false;
        }

        if (state.root && document.documentElement.contains(state.root)) {
            if (state.root.parentNode !== parent) {
                parent.appendChild(state.root);
            }
            return true;
        }

        addStyles();
        const root = document.createElement('div');
        root.id = ROOT_ID;

        const textNode = document.createElement('div');
        textNode.className = 'nds-lines';

        const statusNode = document.createElement('div');
        statusNode.className = 'nds-status';

        const selectorNode = document.createElement('div');
        selectorNode.className = 'nds-selector';
        selectorNode.addEventListener('mouseenter', () => {
            state.selectorHover = true;
            showSelectorChrome();
        });
        selectorNode.addEventListener('mouseleave', () => {
            state.selectorHover = false;
            scheduleSelectorHide();
        });
        selectorNode.addEventListener('change', event => {
            const role = event.target && event.target.dataset ? event.target.dataset.role : '';
            if (role === 'primary' || role === 'secondary') {
                event.preventDefault();
                event.stopPropagation();
                showSelectorChrome();
                setDisplaySlotValue(role, event.target.value);
            }
        });
        selectorNode.addEventListener('click', event => {
            const action = event.target && event.target.dataset ? event.target.dataset.action : '';
            if (!action) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            showSelectorChrome();
            if (action === 'toggle-selector') {
                state.selectorOpen = !state.selectorOpen;
                state.selectorSignature = '';
                if (state.selectorOpen) {
                    refreshNativeOptions(true);
                }
                if (!state.selectorOpen) {
                    scheduleSelectorHide();
                }
                render();
                return;
            }
        });

        const toastNode = document.createElement('div');
        toastNode.className = 'nds-toast';

        root.appendChild(textNode);
        root.appendChild(statusNode);
        root.appendChild(selectorNode);
        root.appendChild(toastNode);
        parent.appendChild(root);

        state.root = root;
        state.textNode = textNode;
        state.statusNode = statusNode;
        state.selectorNode = selectorNode;
        state.selectorSignature = '';
        state.toastNode = toastNode;
        return true;
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

    function applyNativeSubtitleVisibility() {
        document.documentElement.classList.toggle('nds-hide-native-subtitles', state.hideNative);
    }

    function appendSelectorButton(parent, label, action, lang, active, disabled = false, role = '') {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.dataset.action = action;
        if (lang) {
            button.dataset.lang = lang;
        }
        if (role) {
            button.dataset.role = role;
        }
        if (active) {
            button.className = 'is-active';
        }
        button.disabled = !!disabled;
        parent.appendChild(button);
    }

    function appendLanguageSelect(parent, role, tracks) {
        const row = document.createElement('div');
        row.className = 'nds-selector-row';

        const label = document.createElement('label');
        label.textContent = role === 'primary' ? 'Primary' : 'Secondary';
        row.appendChild(label);

        const select = document.createElement('select');
        select.dataset.role = role;
        const selected = role === 'primary' ? state.displayLangs[0] : state.displayLangs[1];
        const pendingValue = state.pendingSlotValues[role] || '';

        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = 'Off';
        select.appendChild(empty);

        const officialOptions = mergedNativeOptions();
        const officialTrackKeys = new Set();
        if (officialOptions.length) {
            const group = document.createElement('optgroup');
            group.label = 'Available Netflix';
            officialOptions.forEach(nativeOption => {
                const option = document.createElement('option');
                const cachedKey = cachedTrackKeyForOption(nativeOption);
                const cachedTrack = cachedKey ? state.tracks.get(cachedKey) : null;
                const value = 'official:' + nativeOption.key;
                if (cachedKey) {
                    officialTrackKeys.add(cachedKey);
                }
                option.value = value;
                option.textContent = nativeOption.label + (cachedTrack ? ' (' + cachedTrack.cues.length + ')' : '');
                option.selected = pendingValue === value || !pendingValue && cachedKey && cachedKey === selected;
                group.appendChild(option);
            });
            select.appendChild(group);
        }

        const cachedOnlyTracks = tracks.filter(track => !officialTrackKeys.has(trackCacheKey(track)));
        if (cachedOnlyTracks.length) {
            const group = document.createElement('optgroup');
            group.label = 'Cached';
            cachedOnlyTracks.forEach(track => {
                const option = document.createElement('option');
                const trackKey = trackCacheKey(track);
                option.value = 'cached:' + trackKey;
                option.textContent = trackDisplayLabel(track) + ' (' + track.cues.length + ')';
                option.selected = !pendingValue && trackKey === selected;
                group.appendChild(option);
            });
            select.appendChild(group);
        }
        row.appendChild(select);

        parent.appendChild(row);
    }

    function showSelectorChrome() {
        if (state.selectorHideTimer) {
            clearTimeout(state.selectorHideTimer);
            state.selectorHideTimer = null;
        }
        if (!state.selectorVisible) {
            state.selectorVisible = true;
            state.selectorSignature = '';
            render();
        }
    }

    function scheduleSelectorHide() {
        if (state.selectorHideTimer) {
            clearTimeout(state.selectorHideTimer);
        }
        state.selectorHideTimer = setTimeout(() => {
            state.selectorHideTimer = null;
            if (state.selectorOpen || state.selectorHover) {
                return;
            }
            state.selectorVisible = false;
            state.selectorSignature = '';
            render();
        }, SELECTOR_IDLE_HIDE_MS);
    }

    function noteScreenActivity() {
        state.selectorVisible = true;
        state.selectorSignature = '';
        scheduleSelectorHide();
        renderSelector();
    }

    function renderSelector() {
        if (!state.selectorNode) {
            return;
        }

        const tracks = Array.from(state.tracks.values()).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
        const signature = [
            state.selectorOpen ? 'open' : 'closed',
            state.selectorVisible ? 'visible' : 'idle',
            state.manualDisplay ? 'manual' : 'latest',
            state.displayLangs.join(','),
            JSON.stringify(state.pendingSlotValues),
            mergedNativeOptions().map(option => option.key + ':' + option.lang + ':' + ((option.urls || []).length)).join('|'),
            tracks.map(track => track.lang + ':' + track.cues.length + ':' + (track.savedAt || 0)).join('|')
        ].join('::');
        if (signature === state.selectorSignature) {
            return;
        }
        state.selectorSignature = signature;

        const selector = state.selectorNode;
        selector.classList.toggle('is-idle', !state.selectorVisible && !state.selectorOpen);
        selector.textContent = '';
        appendSelectorButton(selector, 'CC', 'toggle-selector', '', false);
        selector.firstChild.className = 'nds-selector-toggle' + (state.selectorOpen ? ' is-active' : '');
        selector.firstChild.title = 'Dual subtitle language selector';
        if (!state.selectorOpen) {
            return;
        }

        const panel = document.createElement('div');
        panel.className = 'nds-selector-panel';

        const title = document.createElement('div');
        title.className = 'nds-selector-title';
        title.textContent = 'Dual subtitles';
        panel.appendChild(title);

        const officialOptions = mergedNativeOptions();
        if (!tracks.length && !officialOptions.length) {
            const empty = document.createElement('div');
            empty.className = 'nds-selector-empty';
            empty.textContent = 'Waiting for Netflix subtitle languages from the playback manifest.';
            panel.appendChild(empty);
        }
        if (tracks.length || officialOptions.length) {
            appendLanguageSelect(panel, 'primary', tracks);
            appendLanguageSelect(panel, 'secondary', tracks);
        }

        selector.appendChild(panel);
    }

    function render() {
        createOverlay();
        applyNativeSubtitleVisibility();
        if (!state.root || !state.textNode || !state.statusNode) {
            return;
        }

        state.root.classList.toggle('is-hidden', !state.enabled);
        state.root.classList.toggle('show-status', state.showStatus);

        const summary = state.displayLangs.map(key => {
            const track = state.tracks.get(key);
            return track ? trackDisplayLabel(track) + ':' + track.cues.length : key + ':0';
        }).join(' ');
        state.statusNode.textContent = state.status + ' | ' + (state.manualDisplay ? 'manual' : 'latest') + ' | ' + summary + ' | video:' + videoId();
        renderSelector();

        if (!state.enabled) {
            state.textNode.textContent = '';
            return;
        }

        const video = getVideo();
        if (!video) {
            return;
        }

        const timeMs = video.currentTime * 1000;
        const lines = state.displayLangs.map((key, index) => {
            const track = state.tracks.get(key);
            return {
                lang: track ? track.lang : key,
                label: trackDisplayLabel(track),
                role: index === 0 ? 'primary' : 'secondary',
                cue: cueAt(track, timeMs),
            };
        })
            .filter(item => item.cue && item.cue.text);
        const nextText = lines.map(item => item.label + ':' + item.cue.text).join('\n');

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
        return normalizeLang(payloadLang(payload));
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

    function uniqueValues(values) {
        return Array.from(new Set(values.filter(Boolean)));
    }

    function stableHash(value) {
        let hash = 0;
        const text = String(value || '');
        for (let index = 0; index < text.length; index += 1) {
            hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
        }
        return Math.abs(hash).toString(36);
    }

    function collectUrls(value, urls = []) {
        if (!value) {
            return urls;
        }
        if (typeof value === 'string') {
            if (/^https?:\/\//i.test(value) || /nflxvideo\.net/i.test(value)) {
                urls.push(value);
            }
            return urls;
        }
        if (Array.isArray(value)) {
            value.forEach(item => collectUrls(item, urls));
            return urls;
        }
        if (typeof value !== 'object') {
            return urls;
        }

        ['url', 'href', 'uri', 'downloadUrl', 'downloadURL', 'downloadUrls', 'downloadURLs', 'urls', 'Lua'].forEach(key => {
            if (key in value) {
                collectUrls(value[key], urls);
            }
        });
        return urls;
    }

    function textProfileScore(profile) {
        const value = String(profile || '').toLowerCase();
        if (/webvtt|vtt/.test(value)) {
            return 0;
        }
        if (/dfxp|ttml|simplesdh|simple/.test(value)) {
            return 1;
        }
        if (/imsc/.test(value)) {
            return 2;
        }
        if (/nflx-cmisc|image|png/.test(value)) {
            return 20;
        }
        return 8;
    }

    function downloadableEntries(track) {
        const holders = [
            track.ttDownloadables,
            track.downloadables,
            track.T7,
            track.el,
            track.streams,
            track.urls,
            track.downloadUrls
        ].filter(Boolean);

        const entries = [];
        holders.forEach(holder => {
            if (Array.isArray(holder)) {
                holder.forEach(item => entries.push({ profile: item && (item.profile || item.contentProfile || item.NN || item.kc), value: item }));
            } else if (typeof holder === 'object') {
                Object.entries(holder).forEach(([profile, value]) => entries.push({ profile, value }));
            } else {
                entries.push({ profile: '', value: holder });
            }
        });
        return entries;
    }

    function extractTrackUrls(track) {
        return uniqueValues(downloadableEntries(track)
            .sort((a, b) => textProfileScore(a.profile) - textProfileScore(b.profile))
            .flatMap(entry => collectUrls(entry.value))
            .filter(url => {
                try {
                    return subtitleUrlCandidate(url);
                } catch (_) {
                    return false;
                }
            }));
    }

    function optionFromManifestTrack(track, sourceUrl) {
        if (!track || typeof track !== 'object' || track.Ez || track.isNoneTrack) {
            return null;
        }

        const urls = extractTrackUrls(track);
        if (!urls.length) {
            return null;
        }

        const lang = normalizeLang(track.language || track.bcp47 || track.Bcp47 || track.uh || track.lang || '');
        const label = normalizeNativeLabel(track.languageDescription || track.aP || track.displayName || track.label || track.name || lang || 'Unknown');
        if (!label || !lang && label === 'Unknown') {
            return null;
        }

        const trackId = String(track.id || track.trackId || track.Au || track.Ix || track.new_track_id || '');
        return {
            key: 'manifest:' + stableHash([state.videoId || videoId(), trackId, lang, label, urls[0]].join('|')),
            label: label + (lang ? ' (' + lang + ')' : ''),
            lang,
            urls,
            sourceUrl,
            trackId,
            source: 'manifest'
        };
    }

    function extractManifestOptions(data, sourceUrl) {
        const options = [];
        const seen = new Set();
        const stack = [data];
        let inspected = 0;

        while (stack.length && inspected < MANIFEST_SCAN_LIMIT) {
            const item = stack.pop();
            inspected += 1;
            if (!item || typeof item !== 'object') {
                continue;
            }

            if (Array.isArray(item)) {
                item.forEach(value => stack.push(value));
                continue;
            }

            ['textTracks', 'timedtexttracks', 'BL'].forEach(key => {
                if (Array.isArray(item[key])) {
                    item[key].forEach(track => {
                        const option = optionFromManifestTrack(track, sourceUrl);
                        if (option && !seen.has(option.key)) {
                            seen.add(option.key);
                            options.push(option);
                        }
                    });
                }
            });

            if ((item.language || item.languageDescription || item.aP) && (item.downloadables || item.ttDownloadables || item.T7 || item.el)) {
                const option = optionFromManifestTrack(item, sourceUrl);
                if (option && !seen.has(option.key)) {
                    seen.add(option.key);
                    options.push(option);
                }
            }

            Object.values(item).forEach(value => {
                if (value && typeof value === 'object') {
                    stack.push(value);
                }
            });
        }

        return options;
    }

    function rememberManifestOptions(url, payload) {
        const text = String(payload || '').trim();
        if (!text || text[0] !== '{' && text[0] !== '[') {
            return 0;
        }

        let data;
        try {
            data = JSON.parse(text);
        } catch (_) {
            return 0;
        }

        const options = extractManifestOptions(data, url);
        if (!options.length) {
            return 0;
        }

        const merged = new Map(state.manifestOptions.map(option => [option.key, option]));
        options.forEach(option => merged.set(option.key, option));
        state.manifestOptions = Array.from(merged.values()).sort((a, b) => a.label.localeCompare(b.label));
        state.selectorSignature = '';
        renderSelector();
        prepopulateManifestOptionContent(options);
        return options.length;
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

    function enqueuePrefetchOption(option) {
        if (!option || !option.key || !Array.isArray(option.urls) || !option.urls.length) {
            return false;
        }
        if (state.prefetchedOptionKeys.has(option.key)) {
            return false;
        }
        if (officialOptionCached(option)) {
            state.prefetchedOptionKeys.add(option.key);
            return false;
        }

        state.prefetchedOptionKeys.add(option.key);
        state.prefetchQueue.push(option);
        return true;
    }

    function prepopulateManifestOptionContent(options) {
        const queued = options.reduce((count, option) => count + (enqueuePrefetchOption(option) ? 1 : 0), 0);
        if (queued) {
            state.status = 'preloading ' + queued + ' subtitle track(s)';
            render();
        }
        processPrefetchQueue();
    }

    async function processPrefetchQueue() {
        if (state.prefetchActive) {
            return;
        }

        state.prefetchActive = true;
        const requestVideoId = state.videoId || videoId();
        try {
            while (state.prefetchQueue.length) {
                if (requestVideoId !== (state.videoId || videoId())) {
                    state.prefetchQueue = [];
                    return;
                }

                const option = state.prefetchQueue.shift();
                if (!option || officialOptionCached(option)) {
                    continue;
                }

                await fetchManifestOptionForCache(option, requestVideoId);
                await sleep(PREFETCH_DELAY_MS);
            }
        } finally {
            state.prefetchActive = false;
            if (requestVideoId === (state.videoId || videoId())) {
                state.status = 'preloaded ' + state.tracks.size + ' subtitle track(s)';
                state.selectorSignature = '';
                render();
            }
        }
    }

    async function fetchManifestOptionForCache(option, requestVideoId) {
        for (const url of option.urls) {
            try {
                const response = await gmGet(url);
                if (requestVideoId !== (state.videoId || videoId())) {
                    return false;
                }

                const body = String(response.responseText || '');
                if (response.status >= 400 || body.length > MAX_RESPONSE_CHARS) {
                    continue;
                }

                const lang = inferPayloadLang(body) || option.lang;
                const cues = parseCues(body);
                if (lang && saveTrack(lang, cues, url, { silent: true, preserveDisplay: true, key: option.key, optionKey: option.key, label: option.label })) {
                    return true;
                }
            } catch (_) {}
        }
        return false;
    }

    async function refetchTrack(value) {
        const key = resolveTrackKey(value);
        const track = key ? state.tracks.get(key) : null;
        if (!track || !track.sourceUrl) {
            notify('No saved Netflix URL for ' + (value || 'subtitle track'));
            return false;
        }

        const requestVideoId = state.videoId || videoId();
        notify('Fetching ' + trackDisplayLabel(track) + ' from saved Netflix URL');
        try {
            const response = await gmGet(track.sourceUrl);
            if (requestVideoId !== (state.videoId || videoId())) {
                return false;
            }
            const body = String(response.responseText || '');
            if (response.status >= 400 || body.length > MAX_RESPONSE_CHARS) {
                notify('Fetch failed for ' + trackDisplayLabel(track) + ': HTTP ' + response.status + ' - reselect it in Netflix');
                return false;
            }

            const payloadLanguage = inferPayloadLang(body);
            if (payloadLanguage && payloadLanguage !== track.lang) {
                notify('Fetch returned ' + payloadLanguage + ', expected ' + track.lang);
                return false;
            }

            const cues = parseCues(body);
            if (!saveTrack(track.lang, cues, track.sourceUrl, { key: track.key, optionKey: track.optionKey, label: track.label })) {
                notify('Fetch could not parse ' + trackDisplayLabel(track) + ' subtitles');
                return false;
            }
            state.selectorSignature = '';
            return true;
        } catch (error) {
            notify('Fetch error for ' + trackDisplayLabel(track) + ': ' + (error && error.message ? error.message : 'unknown'));
            return false;
        }
    }

    async function refetchAllTracks() {
        const trackKeys = latestTrackKeys().filter(key => state.tracks.get(key)?.sourceUrl);
        if (!trackKeys.length) {
            notify('No saved Netflix subtitle URLs to fetch');
            return;
        }

        notify('Fetching ' + trackKeys.length + ' cached subtitle URL(s)');
        for (const key of trackKeys) {
            await refetchTrack(key);
        }
    }

    async function fetchOfficialSubtitleForSlot(slot, option) {
        if (!option || !Array.isArray(option.urls) || !option.urls.length) {
            return false;
        }

        const cachedKey = cachedTrackKeyForOption(option);
        if (cachedKey) {
            setDisplaySlot(slot, cachedKey);
            return true;
        }

        const requestVideoId = state.videoId || videoId();
        state.manualDisplay = true;
        state.pendingSlotValues[slot] = 'official:' + option.key;
        if (option.lang) {
            state.pendingSlots[option.key] = slot;
            state.pendingSlots[option.lang] = slot;
        }
        state.selectorSignature = '';
        renderSelector();

        notify('Fetching Netflix subtitle: ' + option.label);
        for (const url of option.urls) {
            try {
                const response = await gmGet(url);
                if (requestVideoId !== (state.videoId || videoId())) {
                    return false;
                }
                const body = String(response.responseText || '');
                if (response.status >= 400 || body.length > MAX_RESPONSE_CHARS) {
                    continue;
                }

                const lang = inferPayloadLang(body) || option.lang;
                const cues = parseCues(body);
                if (lang && saveTrack(lang, cues, url, { key: option.key, optionKey: option.key, label: option.label, displaySlot: slot })) {
                    return true;
                }
            } catch (_) {}
        }

        delete state.pendingSlotValues[slot];
        if (option.lang) {
            delete state.pendingSlots[option.key];
            delete state.pendingSlots[option.lang];
        }
        state.pendingCaptureSlot = '';
        notify('Could not fetch Netflix subtitle: ' + option.label);
        return false;
    }

    async function fetchCandidate(url, entry) {
        if (!subtitleUrlCandidate(url, entry) || state.requestedUrls.has(url)) {
            return;
        }

        state.requestedUrls.add(url);
        const requestVideoId = state.videoId || videoId();
        state.status = 'intercepted ?o=1 request #' + state.requestedUrls.size;
        render();

        try {
            const response = await gmGet(url);
            if (requestVideoId !== (state.videoId || videoId())) {
                return;
            }
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

        const manifestCount = rememberManifestOptions(url, payload);
        if (manifestCount) {
            state.status = 'found ' + manifestCount + ' manifest subtitle option(s)';
            render();
        }

        const rawLang = payloadLang(payload) || 'unknown';
        const lang = inferPayloadLang(payload);
        if (!lang) {
            if (manifestCount) {
                return;
            }
            state.ignoredPayloads += 1;
            state.status = 'ignored subtitle payload lang=' + rawLang + ' ignored=' + state.ignoredPayloads;
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

        if (state.resourceObserverStarted || typeof PerformanceObserver !== 'function') {
            return;
        }

        try {
            new PerformanceObserver(list => list.getEntries().forEach(inspect)).observe({ type: 'resource', buffered: true });
            state.resourceObserverStarted = true;
        } catch (_) {}
    }

    function injectNetworkBridge() {
        const parent = document.head || document.documentElement;
        if (!parent) {
            return false;
        }

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
                        if (!relevant(url, type)) {
                            return;
                        }
                        if (!this.responseType || this.responseType === 'text') {
                            emit(url, this.responseText);
                        } else if (this.responseType === 'json') {
                            try {
                                emit(url, JSON.stringify(this.response));
                            } catch (_) {}
                        } else if (typeof this.response === 'string') {
                            emit(url, this.response);
                        }
                    });
                    return originalSend.apply(this, arguments);
                };
                XMLHttpRequest.prototype.send.__ndsPatched = true;
            }
        }.toString() + ')(' + JSON.stringify(BRIDGE_EVENT) + ',' + MAX_RESPONSE_CHARS + ');';
        try {
            parent.appendChild(script);
            script.remove();
            return true;
        } catch (_) {
            return false;
        }
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function visibleElement(element) {
        if (!element || state.root && state.root.contains(element)) {
            return false;
        }
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }

    function elementText(element) {
        return normalizeNativeLabel(element ? element.textContent || element.getAttribute('aria-label') || '' : '');
    }

    function clickNativeElement(element) {
        if (!element) {
            return false;
        }
        ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(type => {
            try {
                element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            } catch (_) {}
        });
        try {
            element.click();
        } catch (_) {}
        return true;
    }

    function wakeNetflixControls() {
        const target = getVideo() || document.querySelector('[data-uia="player"]') || document.body;
        if (!target) {
            return;
        }
        try {
            target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window }));
        } catch (_) {}
    }

    function findNetflixSubtitleButton() {
        const selectors = [
            '[data-uia="control-audio-subtitle"]',
            'button[data-uia*="audio"]',
            'button[aria-label*="Audio" i]',
            'button[aria-label*="Subtitle" i]',
            'button[aria-label*="字幕" i]',
            'button[aria-label*="音声" i]',
            'button[aria-label*="音訊" i]',
            'button[aria-label*="音频" i]',
            '[role="button"][aria-label*="Audio" i]',
            '[role="button"][aria-label*="Subtitle" i]'
        ];
        for (const selector of selectors) {
            const found = Array.from(document.querySelectorAll(selector)).find(visibleElement);
            if (found) {
                return found;
            }
        }
        return null;
    }

    function likelySubtitleHeading(text) {
        return /^(subtitles?|captions?|字幕|CC)$/i.test(normalizeNativeLabel(text));
    }

    function likelyAudioHeading(text) {
        return /^(audio|音声|音訊|音频|語音|语言|語言)$/i.test(normalizeNativeLabel(text));
    }

    function nativeMenuContainers() {
        const selectors = [
            '[data-uia*="audio-subtitle"]',
            '[data-uia*="subtitle"]',
            '[role="dialog"]',
            '[role="menu"]',
            '[class*="audio" i]',
            '[class*="subtitle" i]',
            '[class*="popover" i]',
            '[class*="popup" i]'
        ];
        return Array.from(document.querySelectorAll(selectors.join(',')))
            .filter(visibleElement)
            .filter(element => !state.root || !state.root.contains(element))
            .sort((a, b) => {
                const ar = a.getBoundingClientRect();
                const br = b.getBoundingClientRect();
                return (ar.width * ar.height) - (br.width * br.height);
            });
    }

    function subtitleItemLabelFromUia(node) {
        const value = node ? node.getAttribute('data-uia') || '' : '';
        const match = value.match(/^subtitle-item-(?:selected-)?(.+)$/);
        return match ? normalizeNativeLabel(match[1]) : '';
    }

    function optionTextFromNode(node) {
        const dataUiaLabel = subtitleItemLabelFromUia(node);
        if (dataUiaLabel) {
            return dataUiaLabel;
        }

        const clone = node.cloneNode(true);
        clone.querySelectorAll('svg, img, path').forEach(child => child.remove());
        return normalizeNativeLabel(clone.textContent || node.getAttribute('aria-label') || '');
    }

    function optionNodesInside(container) {
        const nodes = Array.from(container.querySelectorAll('button, [role="menuitem"], [role="option"], li, [tabindex]'))
            .filter(visibleElement)
            .filter(node => !state.root || !state.root.contains(node));
        return nodes.filter((node, index, array) => !array.some(other => other !== node && other.contains(node) && optionTextFromNode(other) === optionTextFromNode(node)));
    }

    function subtitleItemRowsInside(container) {
        return Array.from(container.querySelectorAll('li[data-uia^="subtitle-item-"], [data-uia^="subtitle-item-"]'))
            .filter(visibleElement)
            .filter(node => !state.root || !state.root.contains(node));
    }

    function subtitleListContainers() {
        return Array.from(document.querySelectorAll('h3'))
            .filter(heading => likelySubtitleHeading(heading.textContent || ''))
            .map(heading => heading.parentElement)
            .filter(Boolean)
            .filter(visibleElement)
            .filter(container => subtitleItemRowsInside(container).length);
    }

    function subtitleSectionNodes(container) {
        const directRows = subtitleItemRowsInside(container);
        if (directRows.length) {
            return directRows;
        }

        const nodes = optionNodesInside(container);
        const result = [];
        let inSubtitleSection = false;
        for (const node of nodes) {
            const text = optionTextFromNode(node).replace(/\s+selected$/i, '').trim();
            if (!text) {
                continue;
            }
            if (likelySubtitleHeading(text)) {
                inSubtitleSection = true;
                continue;
            }
            if (inSubtitleSection && likelyAudioHeading(text)) {
                break;
            }
            if (inSubtitleSection) {
                result.push(node);
            }
        }
        return result.length ? result : nodes;
    }

    function nativeOptionFromNode(node) {
        const raw = optionTextFromNode(node).replace(/\s+selected$/i, '').trim();
        const label = normalizeNativeLabel(raw);
        const skip = /^(audio|subtitles?|captions?|off|none|關閉|关闭|latest|fetch all|scan official|primary|secondary|cc|done)$/i;
        if (!label || label.length < 2 || label.length > 80 || skip.test(label)) {
            return null;
        }
        const lang = langFromNativeLabel(label);
        if (!lang) {
            return null;
        }
        return { key: nativeLabelKey(label), label, lang, element: node };
    }

    function collectNativeSubtitleOptions() {
        const options = [];
        const seen = new Set();
        const containers = subtitleListContainers();
        for (const container of containers) {
            for (const node of subtitleSectionNodes(container)) {
                const option = nativeOptionFromNode(node);
                if (!option || seen.has(option.key)) {
                    continue;
                }
                seen.add(option.key);
                options.push({ key: option.key, label: option.label, lang: option.lang });
            }
            if (options.length) {
                break;
            }
        }
        state.nativeOptions = options.sort((a, b) => a.label.localeCompare(b.label));
        state.selectorSignature = '';
        renderSelector();
        return mergedNativeOptions();
    }

    async function refreshNativeOptions(openMenu = false) {
        wakeNetflixControls();
        let options = mergedNativeOptions();
        if (!openMenu) {
            notify(options.length ? 'Found ' + options.length + ' Netflix subtitle option(s)' : 'Waiting for Netflix subtitle manifest');
            return options;
        }
        if (!state.nativeOptions.length) {
            const button = findNetflixSubtitleButton();
            if (button) {
                clickNativeElement(button);
                await sleep(350);
                collectNativeSubtitleOptions();
            }
        }
        options = mergedNativeOptions();
        notify(options.length ? 'Found ' + options.length + ' Netflix subtitle option(s)' : 'No Netflix subtitle options found');
        return options;
    }

    function findNativeSubtitleOptionElement(option) {
        const key = option && option.key;
        if (!key) {
            return null;
        }
        const containers = [...subtitleListContainers(), ...nativeMenuContainers()];
        for (const container of containers) {
            const found = subtitleSectionNodes(container)
                .map(node => nativeOptionFromNode(node))
                .find(item => item && item.key === key);
            if (found) {
                return found.element;
            }
        }
        return null;
    }

    async function selectOfficialSubtitleForSlot(slot, optionKey) {
        let option = mergedNativeOptions().find(item => item.key === optionKey);
        if (!option) {
            await refreshNativeOptions(true);
            option = mergedNativeOptions().find(item => item.key === optionKey);
        }
        if (!option) {
            notify('Netflix subtitle option not found');
            return false;
        }

        if (await fetchOfficialSubtitleForSlot(slot, option)) {
            return true;
        }

        state.manualDisplay = true;
        state.pendingSlotValues[slot] = 'official:' + option.key;
        if (option.lang) {
            state.pendingSlots[option.key] = slot;
            state.pendingSlots[option.lang] = slot;
        }
        state.pendingCaptureSlot = slot;
        state.selectorSignature = '';
        renderSelector();

        await refreshNativeOptions(true);
        const element = findNativeSubtitleOptionElement(option);
        if (!element) {
            notify('Could not click Netflix option: ' + option.label);
            return false;
        }
        clickNativeElement(element);
        notify('Selected Netflix subtitle: ' + option.label);
        return true;
    }

    function switchVideoContext(nextVideoId, initial = false) {
        const normalizedVideoId = String(nextVideoId || '');
        if (!normalizedVideoId || (!initial && normalizedVideoId === state.videoId)) {
            return;
        }

        state.videoId = normalizedVideoId;
        state.requestedUrls.clear();
        state.tracks.clear();
        state.displayLangs = [];
        state.manualDisplay = false;
        state.nativeOptions = [];
        state.manifestOptions = [];
        state.prefetchQueue = [];
        state.prefetchActive = false;
        state.prefetchedOptionKeys.clear();
        state.pendingSlots = {};
        state.pendingSlotValues = {};
        state.pendingCaptureSlot = '';
        state.selectorSignature = '';
        state.lastText = '';
        state.ignoredPayloads = 0;
        removeLegacyGenericChineseCache();
        loadCachedTracks();
        if (!initial) {
            state.status = 'new video detected; loading subtitle tracks from manifest';
            notify(state.status);
        }
        render();
    }

    function checkWatchIdChange(initial = false) {
        const currentVideoId = videoId();
        if (currentVideoId && currentVideoId !== state.videoId) {
            switchVideoContext(currentVideoId, initial && !state.videoId);
            ensureRuntimeReady();
        }
    }

    function watchVideoChanges() {
        if (!state.historyPatched) {
            state.historyPatched = true;
            ['pushState', 'replaceState'].forEach(method => {
                const original = history[method];
                if (typeof original !== 'function') {
                    return;
                }
                history[method] = function() {
                    const result = original.apply(this, arguments);
                    setTimeout(() => checkWatchIdChange(), 0);
                    return result;
                };
            });
            window.addEventListener('popstate', () => setTimeout(() => checkWatchIdChange(), 0));
        }

        setInterval(() => checkWatchIdChange(), 250);
    }

    function registerMenu() {
        if (typeof GM_registerMenuCommand !== 'function') {
            return;
        }

        GM_registerMenuCommand('Netflix Dual Subtitles: Switch main/secondary', () => {
            state.manualDisplay = true;
            state.displayLangs.reverse();
            state.lastText = '';
            state.selectorSignature = '';
            render();
        });
        GM_registerMenuCommand('Netflix Dual Subtitles: Toggle native Netflix subtitles', () => {
            state.hideNative = !state.hideNative;
            saveHideNativePreference(state.hideNative);
            notify(state.hideNative ? 'Native Netflix subtitles hidden' : 'Native Netflix subtitles visible');
        });
        GM_registerMenuCommand('Netflix Dual Subtitles: Toggle status', () => {
            state.showStatus = !state.showStatus;
            render();
        });
        GM_registerMenuCommand('Netflix Dual Subtitles: Clear cache', () => clearCachedTracks());
    }

    function ensureRuntimeReady() {
        addStyles();
        injectNetworkBridge();
        observeSubtitleRequests();
        if (document.body) {
            createOverlay();
        }
        render();
    }

    function init() {
        window.addEventListener(BRIDGE_EVENT, event => rememberPayload(event.detail.url, event.detail.payload));
        registerMenu();
        checkWatchIdChange(true);
        watchVideoChanges();
        ensureRuntimeReady();
        noteScreenActivity();
        ['mousemove', 'pointermove', 'touchstart', 'keydown'].forEach(eventName => {
            window.addEventListener(eventName, noteScreenActivity, { passive: true });
        });

        const startup = setInterval(() => {
            ensureRuntimeReady();
            if (document.body && state.root && document.documentElement.contains(state.root)) {
                clearInterval(startup);
            }
        }, 50);

        window.addEventListener('DOMContentLoaded', ensureRuntimeReady, { once: true });
        window.addEventListener('load', ensureRuntimeReady, { once: true });
        ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach(eventName => {
            document.addEventListener(eventName, ensureRuntimeReady);
        });
        setInterval(ensureRuntimeReady, 1500);
        setInterval(render, RENDER_INTERVAL_MS);
    }

    init();
})();
