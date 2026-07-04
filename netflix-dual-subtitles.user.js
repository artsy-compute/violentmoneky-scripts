// ==UserScript==
// @name         Netflix Dual Subtitles
// @namespace    http://tampermonkey.net/
// @version      0.13.24
// @description  Load Netflix audio/subtitle languages; switch audio through Netflix and display two subtitles together.
// @description:en Load Netflix audio/subtitle languages; switch audio through Netflix and display two subtitles together.
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
    const CACHE_VERSION = 5;
    const MAX_DISPLAY_LANGS = 2;
    const MANIFEST_SCAN_LIMIT = 50000;
    const SELECTOR_IDLE_HIDE_MS = 2600;
    const PREFETCH_DELAY_MS = 140;
    const CUE_START_TOLERANCE_MS = 80;
    const CUE_END_TOLERANCE_MS = 120;
    const HIDE_NATIVE_PREF_KEY = 'netflix-dual-subtitles:hide-native';
    const LANGUAGE_PREF_KEY = 'netflix-dual-subtitles:language-preferences:v1';
    const TRANSCRIPT_OPACITY_PREF_KEY = 'netflix-dual-subtitles:transcript-opacity';

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

    function clampTranscriptOpacity(value) {
        const opacity = Number(value);
        if (!Number.isFinite(opacity)) {
            return 0.35;
        }
        return Math.min(1, Math.max(0.35, opacity));
    }

    function loadTranscriptOpacityPreference() {
        try {
            return clampTranscriptOpacity(localStorage.getItem(TRANSCRIPT_OPACITY_PREF_KEY) || 0.35);
        } catch (_) {
            return 0.35;
        }
    }

    function saveTranscriptOpacityPreference(value) {
        try {
            localStorage.setItem(TRANSCRIPT_OPACITY_PREF_KEY, String(clampTranscriptOpacity(value)));
        } catch (_) {}
    }

    const state = {
        enabled: true,
        showStatus: false,
        hideNative: loadHideNativePreference(),
        requestedUrls: new Set(),
        resourceObserverStarted: false,
        controlObserverStarted: false,
        controlHoldRefreshScheduled: false,
        controlForcedStyles: new Map(),
        controlForcedPlayerClasses: new Map(),
        observedPlayers: new WeakSet(),
        bottomControlsVisible: true,
        historyPatched: false,
        videoId: '',
        displayLangs: [],
        manualDisplay: false,
        preferenceAppliedDisplay: false,
        selectorOpen: false,
        selectorVisible: true,
        selectorHover: false,
        selectorPickerRole: '',
        selectorHideTimer: null,
        selectorSignature: '',
        nativeOptions: [],
        manifestOptions: [],
        nativeAudioOptions: [],
        manifestAudioOptions: [],
        selectedAudioKey: '',
        nativeScanInProgress: false,
        nativeScanAttempted: false,
        nativeCacheRefreshScheduled: false,
        preferenceApplyScheduled: false,
        preferenceApplyInProgress: false,
        preferenceApplySignature: '',
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
        selectorMount: '',
        selectorPanelScrollTop: 0,
        selectorPanelScrollLeft: 0,
        transcriptOpen: false,
        transcriptNode: null,
        transcriptToggleNode: null,
        transcriptSignature: '',
        transcriptOpacity: loadTranscriptOpacityPreference(),
        transcriptScrollToCurrent: false,
        transcriptLastCueIndex: -1,
        transcriptUserScrollUntil: 0,
        transcriptProgrammaticScroll: false,
        toastNode: null,
        toastTimer: null,
        controlWakeNudge: 0,
        subtitleRenderScheduled: false,
        lastText: '',
        status: 'manual mode: select audio/subtitle languages',
        ignoredPayloads: 0
    };

    function videoId() {
        const match = location.pathname.match(/\/watch\/(\d+)/);
        return match ? match[1] : '';
    }

    function currentContextVideoId() {
        return videoId() || state.videoId || '';
    }

    function cachePrefix() {
        return 'netflix-dual-subtitles:v' + CACHE_VERSION + ':' + (currentContextVideoId() || 'unknown') + ':';
    }

    function cacheKey(lang) {
        return cachePrefix() + lang;
    }

    function langIndexKey() {
        return cachePrefix() + '__langs';
    }

    function optionCacheKey() {
        return cachePrefix() + '__options';
    }

    function loadLanguagePreferences() {
        try {
            const payload = JSON.parse(localStorage.getItem(LANGUAGE_PREF_KEY) || '{}');
            return payload && typeof payload === 'object' ? payload : {};
        } catch (_) {
            return {};
        }
    }

    function saveLanguagePreferences(payload) {
        try {
            localStorage.setItem(LANGUAGE_PREF_KEY, JSON.stringify(payload));
        } catch (_) {}
    }

    function currentTitlePreferenceKey() {
        const titleNode = document.querySelector('[data-uia="video-title"] h4') || document.querySelector('[data-uia="video-title"]');
        const title = normalizeNativeLabel(titleNode ? titleNode.textContent || '' : '');
        if (!title) {
            return '';
        }
        return 'title:' + title.toLowerCase();
    }

    function preferenceIdentityForSubtitle(item) {
        if (!item) {
            return null;
        }
        const lang = normalizeLang(item.lang || '');
        const label = cleanLanguageDisplayLabel(item.label || item.displayName || '', lang) || item.label || lang;
        return {
            lang,
            label: normalizeNativeLabel(label),
            identity: optionLabelIdentity(label),
            base: subtitleBaseLabelIdentity(label),
            cc: isCcSubtitleLabel(label)
        };
    }

    function preferenceIdentityForAudio(item) {
        if (!item) {
            return null;
        }
        const lang = normalizeLang(item.lang || '');
        const label = cleanLanguageDisplayLabel(item.label || item.displayName || '', lang) || item.label || lang;
        return {
            lang,
            label: normalizeNativeLabel(label),
            identity: audioLabelIdentity(label),
            description: isAudioDescriptionLabel(label)
        };
    }

    function updateLanguagePreference(mutator) {
        if (state.preferenceApplyInProgress) {
            return;
        }
        const preferences = loadLanguagePreferences();
        preferences.last = preferences.last || {};
        mutator(preferences.last);
        const titleKey = currentTitlePreferenceKey();
        if (titleKey) {
            preferences.titles = preferences.titles || {};
            preferences.titles[titleKey] = preferences.titles[titleKey] || {};
            mutator(preferences.titles[titleKey]);
        }
        preferences.updatedAt = Date.now();
        saveLanguagePreferences(preferences);
        state.preferenceApplySignature = '';
    }

    function storedLanguagePreference() {
        const preferences = loadLanguagePreferences();
        const titleKey = currentTitlePreferenceKey();
        return { ...(preferences.last || {}), ...(titleKey && preferences.titles ? preferences.titles[titleKey] || {} : {}) };
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

    function optionLabelIdentity(label) {
        return nativeLabelKey(String(label || '').replace(/\s*\(([a-z]{2,3}(?:[-_][a-z0-9]+)*)(?:\s*,[^)]*)?\)\s*$/i, ''));
    }

    function isCcSubtitleLabel(label) {
        return /\bCC\b|closed captions?|字幕.*CC/i.test(normalizeNativeLabel(label));
    }

    function subtitleBaseLabelIdentity(label) {
        return optionLabelIdentity(label)
            .replace(/\s*[\[(（]\s*(?:cc|closed captions?)\s*[\])）]\s*/gi, ' ')
            .replace(/\s*(?:[-–—:：]|,|，)\s*(?:cc|closed captions?).*$/i, '')
            .replace(/\bCC\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function subtitleVariantScore(option) {
        const label = normalizeNativeLabel(option && option.label || '');
        const base = subtitleBaseLabelIdentity(label);
        let score = base.length || label.length || 999;
        if (/forced|signs?|songs?|forced narrative|強制|標誌|歌曲/i.test(label)) {
            score += 100;
        }
        return score;
    }

    function singleBestSubtitleVariant(options) {
        if (!options.length) {
            return null;
        }
        const sorted = options.slice().sort((a, b) => subtitleVariantScore(a) - subtitleVariantScore(b) || a.label.localeCompare(b.label));
        if (sorted.length === 1 || subtitleVariantScore(sorted[0]) < subtitleVariantScore(sorted[1])) {
            return sorted[0];
        }
        return null;
    }

    function audioLabelIdentity(label) {
        return optionLabelIdentity(label)
            .replace(/\s*[\[(（][^\])）]*(?:original|原音|原聲|原声|原版|5\.1|2\.0|audio description|descriptive audio|ad|音訊描述|音频描述|音訊說明|音频说明|音聲ガイド|音声ガイド|口述影像|旁白)[^\])）]*[\])）]\s*/gi, ' ')
            .replace(/\s*(?:[-–—:：]|,|，)\s*(?:original|原音|原聲|原声|原版|5\.1|2\.0|audio description|descriptive audio|ad|音訊描述|音频描述|音訊說明|音频说明|音聲ガイド|音声ガイド|口述影像|旁白).*$/i, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function isAudioDescriptionLabel(label) {
        return /audio description|descriptive audio|\bAD\b|音訊描述|音频描述|音聲ガイド|音声ガイド|口述影像|旁白/i.test(normalizeNativeLabel(label));
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
        if (/italian|italiano|義大利語|義大利文|意大利语|意大利文/.test(raw)) {
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

    function langPrimary(lang) {
        return normalizeLang(lang).split('-')[0] || '';
    }

    function languageMatchScore(a, b) {
        const left = normalizeLang(a);
        const right = normalizeLang(b);
        if (!left || !right) {
            return Number.POSITIVE_INFINITY;
        }
        if (left === right) {
            return 0;
        }

        const leftPrimary = langPrimary(left);
        const rightPrimary = langPrimary(right);
        if (!leftPrimary || leftPrimary !== rightPrimary) {
            return Number.POSITIVE_INFINITY;
        }

        const leftBare = left === leftPrimary;
        const rightBare = right === rightPrimary;
        if (leftPrimary === 'zh') {
            return leftBare || rightBare ? 4 : Number.POSITIVE_INFINITY;
        }
        if (leftPrimary === 'en') {
            return leftBare || rightBare ? 3 : 7;
        }
        return leftBare || rightBare ? 5 : 9;
    }

    function languagesCompatible(a, b) {
        return Number.isFinite(languageMatchScore(a, b));
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

    function cleanLanguageDisplayLabel(label, lang = '') {
        const normalizedLang = normalizeLang(lang);
        let text = normalizeNativeLabel(label || '');
        if (normalizedLang) {
            const escapedLang = normalizedLang.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            text = text
                .replace(new RegExp('\\s*\\[' + escapedLang + '\\]\\s*$', 'i'), '')
                .replace(new RegExp('\\s*\\(' + escapedLang + '\\)\\s*$', 'i'), '')
                .trim();
        }
        return text;
    }

    function isBareLangDisplayLabel(label, lang = '') {
        const text = normalizeNativeLabel(label).toLowerCase();
        const normalizedLang = normalizeLang(lang).toLowerCase();
        if (!text || !normalizedLang) {
            return false;
        }
        return text === normalizedLang || text === normalizedLang.split('-')[0];
    }

    function localizedSubtitleLabelForTrack(track) {
        if (!track) {
            return '';
        }
        const lang = normalizeLang(track.lang || '');
        if (!lang) {
            return '';
        }
        const currentLabel = cleanLanguageDisplayLabel(track.label || track.displayName || '', lang);
        if (currentLabel && !isBareLangDisplayLabel(currentLabel, lang)) {
            return currentLabel;
        }
        const option = bestSubtitleOptionForLang(lang, track.sourceUrl || '');
        const optionLabel = cleanLanguageDisplayLabel(option && option.label || '', lang);
        return optionLabel && !isBareLangDisplayLabel(optionLabel, lang) ? optionLabel : '';
    }

    function trackDisplayLabel(track) {
        if (!track) {
            return '';
        }
        const lang = normalizeLang(track.lang || '');
        return localizedSubtitleLabelForTrack(track) || cleanLanguageDisplayLabel(track.label || track.displayName || '', lang) || lang || trackCacheKey(track);
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

    function cacheableOption(option) {
        if (!option || !option.key || !option.label) {
            return null;
        }
        const cached = {
            key: String(option.key),
            label: normalizeNativeLabel(option.label),
            lang: normalizeLang(option.lang || ''),
            source: String(option.source || '')
        };
        if (Array.isArray(option.urls) && option.urls.length) {
            cached.urls = option.urls.filter(Boolean).map(String).slice(0, 12);
        }
        ['sourceUrl', 'trackId', 'channels'].forEach(field => {
            if (option[field]) {
                cached[field] = String(option[field]);
            }
        });
        return cached;
    }

    function cacheOptionList(options) {
        const merged = new Map();
        (options || []).forEach(option => {
            const cached = cacheableOption(option);
            if (cached) {
                merged.set(cached.key, cached);
            }
        });
        return Array.from(merged.values()).sort((a, b) => cleanLanguageDisplayLabel(a.label, a.lang).localeCompare(cleanLanguageDisplayLabel(b.label, b.lang)));
    }

    function saveOptionCache() {
        const payload = {
            videoId: currentContextVideoId(),
            savedAt: Date.now(),
            nativeOptions: cacheOptionList(state.nativeOptions),
            manifestOptions: cacheOptionList(state.manifestOptions),
            nativeAudioOptions: cacheOptionList(state.nativeAudioOptions),
            manifestAudioOptions: cacheOptionList(state.manifestAudioOptions)
        };
        try {
            localStorage.setItem(optionCacheKey(), JSON.stringify(payload));
        } catch (_) {}
    }

    function loadOptionCache() {
        try {
            const raw = localStorage.getItem(optionCacheKey());
            if (!raw) {
                return false;
            }
            const payload = JSON.parse(raw);
            const currentVideoId = currentContextVideoId();
            if (payload && payload.videoId && currentVideoId && String(payload.videoId) !== String(currentVideoId)) {
                return false;
            }
            state.nativeOptions = cacheOptionList(payload && payload.nativeOptions || []);
            state.manifestOptions = cacheOptionList(payload && payload.manifestOptions || []);
            state.nativeAudioOptions = cacheOptionList(payload && payload.nativeAudioOptions || []);
            state.manifestAudioOptions = cacheOptionList(payload && payload.manifestAudioOptions || []);
            state.selectorSignature = '';
            return !!(state.nativeOptions.length || state.manifestOptions.length || state.nativeAudioOptions.length || state.manifestAudioOptions.length);
        } catch (_) {
            return false;
        }
    }

    function nativeManifestSubtitleScore(nativeOption, manifestOption) {
        const langScore = languageMatchScore(nativeOption && nativeOption.lang || '', manifestOption && manifestOption.lang || '');
        if (!Number.isFinite(langScore)) {
            return Number.POSITIVE_INFINITY;
        }
        let score = langScore * 10;
        if (optionLabelIdentity(nativeOption.label) !== optionLabelIdentity(manifestOption.label)) {
            score += 2;
        }
        if (subtitleBaseLabelIdentity(nativeOption.label) !== subtitleBaseLabelIdentity(manifestOption.label)) {
            score += 4;
        }
        if (isCcSubtitleLabel(nativeOption.label) !== isCcSubtitleLabel(manifestOption.label)) {
            score += 8;
        }
        return score + subtitleVariantScore(manifestOption) / 100;
    }

    function bestManifestSubtitleForNative(nativeOption, usedKeys = new Set()) {
        if (!nativeOption) {
            return null;
        }
        return state.manifestOptions
            .filter(option => option && option.key && !usedKeys.has(option.key) && Array.isArray(option.urls) && option.urls.length)
            .map(option => ({ option, score: nativeManifestSubtitleScore(nativeOption, option) }))
            .filter(item => Number.isFinite(item.score))
            .sort((a, b) => a.score - b.score || a.option.label.localeCompare(b.option.label))[0]?.option || null;
    }

    function mergedNativeOptions() {
        const merged = new Map();
        const usedManifestKeys = new Set();

        state.nativeOptions.forEach(nativeOption => {
            if (!nativeOption || !nativeOption.key) {
                return;
            }
            const manifestOption = bestManifestSubtitleForNative(nativeOption, usedManifestKeys);
            if (manifestOption) {
                usedManifestKeys.add(manifestOption.key);
                merged.set(manifestOption.key, {
                    ...manifestOption,
                    label: cleanLanguageDisplayLabel(nativeOption.label, manifestOption.lang || nativeOption.lang) || nativeOption.label,
                    nativeKey: nativeOption.key,
                    nativeLabel: nativeOption.label,
                    source: manifestOption.source || 'manifest'
                });
                return;
            }
            merged.set(nativeOption.key, nativeOption);
        });

        state.manifestOptions.forEach(option => {
            if (!option || !option.key || usedManifestKeys.has(option.key)) {
                return;
            }
            merged.set(option.key, option);
        });
        return Array.from(merged.values()).sort((a, b) => cleanLanguageDisplayLabel(a.label, a.lang).localeCompare(cleanLanguageDisplayLabel(b.label, b.lang)));
    }

    function audioOptionIdentity(option) {
        return [normalizeLang(option && option.lang || ''), optionLabelIdentity(option && option.label || '')].join('|');
    }

    function mergedAudioOptions() {
        const merged = new Map();
        const nativeLangs = new Set(state.nativeAudioOptions.map(option => normalizeLang(option && option.lang || '')).filter(Boolean));
        state.nativeAudioOptions.forEach(option => {
            if (option && option.key) {
                merged.set(option.key, option);
            }
        });
        state.manifestAudioOptions.forEach(option => {
            if (!option || !option.key) {
                return;
            }
            const lang = normalizeLang(option.lang || '');
            if (lang && nativeLangs.has(lang)) {
                return;
            }
            merged.set(option.key, option);
        });
        return Array.from(merged.values()).sort((a, b) => cleanLanguageDisplayLabel(a.label, a.lang).localeCompare(cleanLanguageDisplayLabel(b.label, b.lang)));
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
        if (match) {
            return trackCacheKey(match);
        }
        const optionLang = normalizeLang(option.lang || '');
        if (optionLang) {
            const tracksByScore = Array.from(state.tracks.values())
                .map(track => ({ track, score: languageMatchScore(track.lang || '', optionLang) }))
                .filter(item => Number.isFinite(item.score))
                .sort((a, b) => a.score - b.score || (b.track.savedAt || 0) - (a.track.savedAt || 0));
            const exactLang = tracksByScore.filter(item => item.score === 0);
            const sameLabel = tracksByScore.find(item => optionLabelIdentity(trackDisplayLabel(item.track)) === optionLabelIdentity(option.label));
            if (sameLabel) {
                return trackCacheKey(sameLabel.track);
            }
            const sameCc = tracksByScore.filter(item => isCcSubtitleLabel(trackDisplayLabel(item.track)) === isCcSubtitleLabel(option.label));
            if (exactLang.length === 1) {
                return trackCacheKey(exactLang[0].track);
            }
            if (sameCc.length === 1) {
                return trackCacheKey(sameCc[0].track);
            }
            if (tracksByScore.length === 1) {
                return trackCacheKey(tracksByScore[0].track);
            }
        }
        return '';
    }

    function bestSubtitleOptionForLang(lang, sourceUrl = '') {
        const normalized = normalizeLang(lang);
        if (!normalized) {
            return null;
        }
        const options = mergedNativeOptions()
            .map(option => ({ option, score: languageMatchScore(option.lang || '', normalized) }))
            .filter(item => Number.isFinite(item.score))
            .sort((a, b) => a.score - b.score || subtitleVariantScore(a.option) - subtitleVariantScore(b.option) || a.option.label.localeCompare(b.option.label))
            .map(item => item.option);
        if (!options.length) {
            return null;
        }
        if (sourceUrl) {
            const byUrl = options.find(option => Array.isArray(option.urls) && option.urls.includes(sourceUrl));
            if (byUrl) {
                return byUrl;
            }
        }
        const exact = options.find(option => normalizeLang(option.lang || '') === normalized);
        if (exact) {
            return exact;
        }
        const native = options.find(option => /^native-/.test(option.source || '') || /^subtitle:/.test(option.key || ''));
        return native || options[0];
    }

    function officialOptionCached(option) {
        return !!cachedTrackKeyForOption(option);
    }

    function subtitlePreferenceScore(preference, item) {
        if (!preference || preference.off || !item) {
            return Number.POSITIVE_INFINITY;
        }
        const identity = preferenceIdentityForSubtitle(item);
        if (!identity || !identity.lang) {
            return Number.POSITIVE_INFINITY;
        }
        const langScore = languageMatchScore(preference.lang, identity.lang);
        if (!Number.isFinite(langScore)) {
            return Number.POSITIVE_INFINITY;
        }
        let score = langScore * 100;
        if (preference.identity && identity.identity && preference.identity !== identity.identity) {
            score += 8;
        }
        if (preference.base && identity.base && preference.base !== identity.base) {
            score += 12;
        }
        if (preference.cc !== identity.cc) {
            score += 30;
        }
        return score + subtitleVariantScore(item) / 10;
    }

    function audioPreferenceScore(preference, item) {
        if (!preference || preference.off || !item) {
            return Number.POSITIVE_INFINITY;
        }
        const identity = preferenceIdentityForAudio(item);
        if (!identity || !identity.lang) {
            return Number.POSITIVE_INFINITY;
        }
        const langScore = languageMatchScore(preference.lang, identity.lang);
        if (!Number.isFinite(langScore)) {
            return Number.POSITIVE_INFINITY;
        }
        let score = langScore * 100;
        if (preference.identity && identity.identity && preference.identity !== identity.identity) {
            score += 10;
        }
        if (preference.description !== identity.description) {
            score += 40;
        }
        return score;
    }

    function bestSubtitlePreferenceMatch(preference) {
        const trackMatches = Array.from(state.tracks.values())
            .map(track => ({ type: 'track', track, score: subtitlePreferenceScore(preference, track) }))
            .filter(item => Number.isFinite(item.score))
            .sort((a, b) => a.score - b.score || (b.track.savedAt || 0) - (a.track.savedAt || 0));
        if (trackMatches.length) {
            return trackMatches[0];
        }
        return mergedNativeOptions()
            .map(option => ({ type: 'option', option, score: subtitlePreferenceScore(preference, option) }))
            .filter(item => Number.isFinite(item.score))
            .sort((a, b) => a.score - b.score || a.option.label.localeCompare(b.option.label))[0] || null;
    }

    function bestAudioPreferenceMatch(preference) {
        return mergedAudioOptions()
            .map(option => ({ option, score: audioPreferenceScore(preference, option) }))
            .filter(item => Number.isFinite(item.score))
            .sort((a, b) => a.score - b.score || a.option.label.localeCompare(b.option.label))[0]?.option || null;
    }

    function preferenceApplySignature(preference) {
        return [
            currentContextVideoId(),
            currentTitlePreferenceKey(),
            JSON.stringify(preference || {}),
            state.manualDisplay ? 'manual' : 'auto',
            state.displayLangs.join(','),
            state.selectedAudioKey,
            Array.from(state.tracks.values()).map(track => trackCacheKey(track) + ':' + track.lang + ':' + trackDisplayLabel(track)).join('|'),
            mergedNativeOptions().map(option => option.key + ':' + option.lang + ':' + option.label + ':' + ((option.urls || []).length)).join('|'),
            mergedAudioOptions().map(option => option.key + ':' + option.lang + ':' + option.label).join('|')
        ].join('::');
    }

    function scheduleApplyLanguagePreferences() {
        if (state.preferenceApplyScheduled || state.preferenceApplyInProgress) {
            return;
        }
        state.preferenceApplyScheduled = true;
        setTimeout(() => {
            state.preferenceApplyScheduled = false;
            applyLanguagePreferences();
        }, 120);
    }

    async function applyLanguagePreferences() {
        if (state.preferenceApplyInProgress || !state.enabled || !currentContextVideoId()) {
            return;
        }
        const preference = storedLanguagePreference();
        if (!preference.primary && !preference.secondary && !preference.audio) {
            return;
        }
        const signature = preferenceApplySignature(preference);
        if (signature === state.preferenceApplySignature) {
            return;
        }
        state.preferenceApplySignature = signature;
        if (state.manualDisplay && state.displayLangs.length && !state.preferenceAppliedDisplay) {
            return;
        }

        const requestVideoId = currentContextVideoId();
        state.preferenceApplyInProgress = true;
        try {
            for (const role of ['primary', 'secondary']) {
                const item = preference[role];
                if (!item || item.off || currentContextVideoId() !== requestVideoId) {
                    continue;
                }
                const match = bestSubtitlePreferenceMatch(item);
                if (!match) {
                    continue;
                }
                if (match.type === 'track') {
                    setDisplaySlot(role, trackCacheKey(match.track));
                } else if (match.option && Array.isArray(match.option.urls) && match.option.urls.length) {
                    await fetchOfficialSubtitleForSlot(role, match.option);
                }
            }

            if (preference.audio && !preference.audio.off && !state.selectedAudioKey && state.bottomControlsVisible && netflixBottomControlsVisibleNow()) {
                const audioOption = bestAudioPreferenceMatch(preference.audio);
                if (audioOption && currentContextVideoId() === requestVideoId) {
                    await selectOfficialAudio(audioOption.key);
                }
            }
        } finally {
            state.preferenceApplyInProgress = false;
            state.selectorSignature = '';
            render();
        }
    }

    function latestTrackKeys() {
        return Array.from(state.tracks.values())
            .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
            .map(trackCacheKey)
            .filter(Boolean);
    }

    function invalidateSubtitleRender() {
        state.lastText = null;
    }

    function scheduleSubtitleRender() {
        invalidateSubtitleRender();
        if (state.subtitleRenderScheduled) {
            return;
        }
        state.subtitleRenderScheduled = true;
        const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : callback => setTimeout(callback, 16);
        schedule(() => {
            state.subtitleRenderScheduled = false;
            render();
        });
    }

    function setLatestDisplayLangs() {
        state.manualDisplay = false;
        state.displayLangs = latestTrackKeys().slice(0, MAX_DISPLAY_LANGS);
        invalidateSubtitleRender();
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
        invalidateSubtitleRender();
        state.selectorSignature = '';
        return before !== state.displayLangs.join('\n');
    }

    function setDisplaySlot(slot, value) {
        const index = slot === 'secondary' ? 1 : 0;
        const key = resolveTrackKey(value);
        const next = state.displayLangs.filter(item => state.tracks.has(item));

        state.manualDisplay = true;
        state.preferenceAppliedDisplay = !!state.preferenceApplyInProgress;
        if (!normalizeTrackKey(value)) {
            next.splice(index, 1);
        } else if (key && state.tracks.has(key)) {
            next[index] = key;
        } else {
            return;
        }

        state.displayLangs = next.filter((item, itemIndex, array) => item && array.indexOf(item) === itemIndex).slice(0, MAX_DISPLAY_LANGS);
        if (!state.preferenceApplyInProgress) {
            const preference = key ? preferenceIdentityForSubtitle(state.tracks.get(key)) : { off: true };
            const preferenceRole = index === 0 ? 'primary' : 'secondary';
            updateLanguagePreference(target => {
                target[preferenceRole] = preference;
            });
        }
        scheduleSubtitleRender();
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

    function swapDisplaySubtitleSlots() {
        state.manualDisplay = true;
        state.preferenceAppliedDisplay = false;
        state.displayLangs = [state.displayLangs[1], state.displayLangs[0]]
            .filter(item => item && state.tracks.has(item))
            .slice(0, MAX_DISPLAY_LANGS);
        updateLanguagePreference(target => {
            const previousPrimary = target.primary;
            target.primary = target.secondary;
            target.secondary = previousPrimary;
        });
        invalidateSubtitleRender();
        state.selectorSignature = '';
        notify('Swapped primary and secondary subtitles');
        render();
    }

    function seekToCueTime(value) {
        const timeMs = Number(value);
        const video = getVideo();
        if (!video || !Number.isFinite(timeMs)) {
            return false;
        }
        video.currentTime = Math.max(0, timeMs / 1000);
        scheduleSubtitleRender();
        return true;
    }

    function formatCueTime(timeMs) {
        const totalSeconds = Math.max(0, Math.floor(Number(timeMs || 0) / 1000));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor(totalSeconds % 3600 / 60);
        const seconds = totalSeconds % 60;
        return (hours ? hours + ':' + String(minutes).padStart(2, '0') : String(minutes)) + ':' + String(seconds).padStart(2, '0');
    }

    function clearPendingSubtitleSlot(slot, option = null) {
        delete state.pendingSlotValues[slot];
        if (option && option.lang) {
            delete state.pendingSlots[option.key];
            delete state.pendingSlots[option.lang];
        }
        if (state.pendingCaptureSlot === slot) {
            state.pendingCaptureSlot = '';
        }
        state.selectorSignature = '';
    }

    function setAudioSelectValue(value) {
        const raw = String(value || '');
        if (!raw) {
            state.selectedAudioKey = '';
            state.selectorSignature = '';
            renderSelector();
            return;
        }
        if (raw.startsWith('audio:')) {
            selectOfficialAudio(raw.slice('audio:'.length));
        }
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
            savedAt: Date.now(),
            videoId: currentContextVideoId()
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
            invalidateSubtitleRender();
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
        if (state.displayLangs.includes(key)) {
            scheduleSubtitleRender();
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
                const currentVideoId = currentContextVideoId();
                if (track && track.videoId && currentVideoId && String(track.videoId) !== String(currentVideoId)) {
                    continue;
                }
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
        clearSubtitleOverlay();
        state.manualDisplay = false;
        state.preferenceAppliedDisplay = false;
        state.nativeOptions = [];
        state.manifestOptions = [];
        state.nativeAudioOptions = [];
        state.manifestAudioOptions = [];
        state.selectedAudioKey = '';
        state.nativeScanInProgress = false;
        state.nativeScanAttempted = false;
        state.nativeCacheRefreshScheduled = false;
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
            html.nds-addon-active:not(.nds-native-selecting) div:has(> [data-uia="selector-audio-subtitle"]),
            html.nds-addon-active:not(.nds-native-selecting) div:has(> div > [data-uia="selector-audio-subtitle"]),
            html.nds-addon-active:not(.nds-native-selecting) [data-uia="selector-audio-subtitle"] {
                opacity: 0 !important;
                pointer-events: none !important;
            }
            html.nds-selector-attention [data-uia="player"],
            html.nds-selector-attention [class*="watch-video--bottom-controls-container"],
            html.nds-selector-attention div:has(> [data-uia="controls-standard"]),
            html.nds-selector-attention div:has([data-uia="controls-standard"]) {
                display: flex !important;
                opacity: 1 !important;
                visibility: visible !important;
                transform: none !important;
                translate: none !important;
                filter: none !important;
                pointer-events: auto !important;
            }
            html.nds-selector-attention [data-uia="controls-standard"],
            html.nds-selector-attention [data-uia="controls-standard"] *,
            html.nds-selector-attention [data-uia="timeline"],
            html.nds-selector-attention [data-uia="timeline"] *,
            html.nds-selector-attention [data-uia^="control-"],
            html.nds-selector-attention [data-uia^="control-"] * {
                opacity: 1 !important;
                visibility: visible !important;
                transform: none !important;
                translate: none !important;
                filter: none !important;
                pointer-events: auto !important;
            }
            html.nds-selector-attention [hidden]:has([data-uia="controls-standard"]),
            html.nds-selector-attention [aria-hidden="true"]:has([data-uia="controls-standard"]) {
                display: flex !important;
                visibility: visible !important;
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
                top: max(24px, calc(env(safe-area-inset-top) + 24px));
                right: max(32px, calc(env(safe-area-inset-right) + 32px));
                max-width: min(360px, calc(100vw - 64px));
                padding: 10px 12px;
                border-radius: 6px;
                background: rgba(18, 18, 18, .88);
                color: #fff;
                font: 13px/1.35 Arial, sans-serif;
                text-align: right;
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
                top: max(72px, calc(env(safe-area-inset-top) + 72px));
                right: max(32px, calc(env(safe-area-inset-right) + 32px));
                pointer-events: auto;
                display: grid;
                justify-items: end;
                gap: 8px;
                color: #fff;
                font: 13px/1.35 Arial, sans-serif;
                opacity: 1;
                transform: translateX(0);
                transition: opacity .18s ease, transform .18s ease;
                z-index: 2147483647;
            }
            .nds-selector.is-idle,
            .nds-selector.is-control-hidden {
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
            .nds-selector-icon {
                display: block;
                width: 30px;
                height: 30px;
                pointer-events: none;
            }
            .nds-transcript-toggle {
                position: fixed;
                top: max(124px, calc(env(safe-area-inset-top) + 124px));
                right: max(32px, calc(env(safe-area-inset-right) + 32px));
                width: 42px;
                height: 42px;
                border: 1px solid rgba(255,255,255,.28);
                border-radius: 999px;
                background: rgba(18, 18, 18, .72);
                color: #fff;
                font: 800 13px/1 Arial, sans-serif;
                cursor: pointer;
                pointer-events: auto;
                z-index: 2147483647;
            }
            .nds-transcript-toggle.is-hidden {
                opacity: 0;
                pointer-events: none;
                transform: translateX(8px);
            }
            .nds-transcript-toggle.is-active {
                background: rgba(229, 9, 20, .82);
                border-color: rgba(255,255,255,.38);
            }
            .nds-transcript-window {
                position: fixed;
                top: max(176px, calc(env(safe-area-inset-top) + 176px));
                right: max(32px, calc(env(safe-area-inset-right) + 32px));
                width: min(720px, calc(100vw - 64px));
                max-height: min(76vh, calc(100vh - 208px));
                display: none;
                grid-template-rows: auto minmax(0, 1fr);
                gap: 10px;
                padding: 12px;
                border-radius: 4px;
                background: rgba(20, 20, 20, var(--nds-transcript-opacity, .35));
                box-shadow: 0 8px 24px rgba(0,0,0,.55);
                color: #fff;
                font: 13px/1.35 Arial, sans-serif;
                pointer-events: auto;
                z-index: 2147483647;
            }
            .nds-transcript-window.is-open {
                display: grid;
            }
            .nds-transcript-title {
                display: grid;
                grid-template-columns: minmax(0, 1fr) auto auto;
                align-items: center;
                gap: 10px;
                color: #fff;
                font-size: 14px;
                font-weight: 700;
            }
            .nds-transcript-opacity {
                display: grid;
                grid-template-columns: auto 88px;
                align-items: center;
                gap: 7px;
                color: #b3b3b3;
                font-size: 12px;
                font-weight: 600;
            }
            .nds-transcript-opacity input {
                width: 88px;
                accent-color: #e50914;
            }
            .nds-transcript-close {
                min-width: 32px;
                height: 30px;
                border: 1px solid rgba(255,255,255,.22);
                border-radius: 4px;
                background: rgba(255,255,255,.08);
                color: #fff;
                cursor: pointer;
            }
            .nds-selector-panel {
                width: min(360px, 88vw);
                max-height: min(82vh, calc(100vh - 120px));
                overflow-y: auto;
                overflow-x: hidden;
                padding: 12px;
                border: 0;
                border-radius: 4px;
                background: rgba(20, 20, 20, .96);
                box-shadow: 0 8px 24px rgba(0,0,0,.55);
                display: grid;
                gap: 10px;
            }
            .nds-selector-title {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                color: #fff;
                font-size: 14px;
                font-weight: 700;
            }
            .nds-selector-section {
                display: grid;
                gap: 6px;
                min-width: 0;
            }
            .nds-selector-row {
                display: grid;
                grid-template-columns: 82px minmax(160px, 1fr);
                align-items: center;
                gap: 10px;
                min-height: 40px;
            }
            .nds-selector-row-label {
                color: #b3b3b3;
                font-size: 13px;
                font-weight: 600;
            }
            .nds-swap-row {
                display: grid;
                grid-template-columns: 82px minmax(160px, 1fr);
                align-items: center;
                gap: 10px;
                min-height: 34px;
            }
            .nds-swap-button {
                width: 100%;
                height: 32px;
                font: 700 12px/1 Arial, sans-serif;
                text-align: center;
            }
            .nds-choice-button {
                min-width: 0;
                width: 100%;
                height: 36px;
                border: 0;
                border-radius: 3px;
                background: #333;
                color: #fff;
                padding: 0 10px;
                font: 14px/1.2 Arial, sans-serif;
                text-align: left;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                cursor: pointer;
            }
            .nds-choice-button:hover,
            .nds-choice-button.is-active {
                background: #444;
            }
            .nds-picker-block {
                display: grid;
                gap: 7px;
                padding-top: 8px;
                border-top: 1px solid rgba(255,255,255,.14);
            }
            .nds-picker-heading {
                color: #b3b3b3;
                font-size: 12px;
                font-weight: 700;
                text-transform: uppercase;
            }
            .nds-radio-list {
                display: grid;
                gap: 1px;
                max-height: none;
                overflow: visible;
                padding: 1px 0;
            }
            .nds-radio-option {
                display: grid;
                grid-template-columns: 18px minmax(0, 1fr);
                align-items: center;
                gap: 8px;
                min-height: 28px;
                padding: 3px 7px;
                border-radius: 3px;
                color: #fff;
                cursor: pointer;
            }
            .nds-radio-option:hover,
            .nds-radio-option:focus-within {
                background: rgba(255,255,255,.12);
            }
            .nds-radio-option input {
                width: 14px;
                height: 14px;
                margin: 0;
                accent-color: #e50914;
            }
            .nds-radio-label {
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                font-size: 13px;
                line-height: 1.25;
            }
            .nds-selector-count {
                color: #aaa;
                font-size: 11px;
            }
            .nds-selector button:not(.nds-choice-button) {
                border: 1px solid rgba(255,255,255,.22);
                border-radius: 5px;
                background: rgba(255,255,255,.08);
                color: #fff;
                padding: 6px 8px;
                cursor: pointer;
            }
            .nds-selector button:not(.nds-choice-button).is-active {
                background: rgba(229, 9, 20, .82);
                border-color: rgba(255,255,255,.38);
            }
            .nds-selector button:not(.nds-choice-button):disabled {
                cursor: default;
                opacity: .38;
            }
            .nds-transcript-block {
                display: grid;
                grid-template-rows: auto minmax(0, 1fr);
                gap: 6px;
                min-height: 0;
            }
            .nds-transcript-heading {
                display: grid;
                grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
                gap: 8px;
                color: #b3b3b3;
                font-size: 12px;
                font-weight: 700;
            }
            .nds-transcript-list {
                display: grid;
                gap: 2px;
                min-height: 180px;
                max-height: min(62vh, 620px);
                overflow-y: auto;
                overflow-x: hidden;
                overscroll-behavior: contain;
                align-self: stretch;
                padding-right: 3px;
            }
            .nds-transcript-row {
                display: grid;
                grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
                gap: 8px;
                width: 100%;
                min-height: 34px;
                padding: 6px 7px;
                border: 0;
                border-radius: 3px;
                background: rgba(255,255,255,.055);
                color: #fff;
                text-align: left;
                cursor: pointer;
            }
            .nds-transcript-row:hover,
            .nds-transcript-row:focus {
                background: rgba(255,255,255,.13);
            }
            .nds-transcript-row.is-current {
                background: rgba(229, 9, 20, .24);
                box-shadow: inset 3px 0 0 #e50914;
            }
            .nds-transcript-cell {
                min-width: 0;
                overflow-wrap: anywhere;
                font-size: 12px;
                line-height: 1.25;
            }
            .nds-transcript-time {
                color: #aaa;
                font-size: 11px;
                font-weight: 700;
                margin-right: 5px;
            }
            .nds-selector-empty {
                color: #b3b3b3;
                font-size: 13px;
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
        ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'].forEach(eventName => {
            selectorNode.addEventListener(eventName, event => {
                event.stopPropagation();
            });
        });
        selectorNode.addEventListener('mouseenter', () => {
            state.selectorHover = true;
            showSelectorChrome();
        });
        selectorNode.addEventListener('mouseleave', () => {
            state.selectorHover = false;
            scheduleSelectorHide();
        });
        selectorNode.addEventListener('focusin', () => {
            state.selectorHover = true;
            showSelectorChrome();
        });
        selectorNode.addEventListener('focusout', () => {
            setTimeout(() => {
                if (selectorNode.contains(document.activeElement)) {
                    return;
                }
                state.selectorHover = false;
                scheduleSelectorHide();
                renderSelector();
            }, 0);
        });
        selectorNode.addEventListener('change', event => {
            const target = event.target;
            const role = target && target.dataset ? target.dataset.role : '';
            if (target && target.type === 'radio' && (role === 'primary' || role === 'secondary')) {
                event.preventDefault();
                event.stopPropagation();
                showSelectorChrome();
                state.selectorPickerRole = '';
                state.selectorSignature = '';
                setDisplaySlotValue(role, target.value);
            } else if (target && target.type === 'radio' && role === 'audio') {
                event.preventDefault();
                event.stopPropagation();
                showSelectorChrome();
                state.selectorPickerRole = '';
                state.selectorSignature = '';
                setAudioSelectValue(target.value);
            }
        });
        selectorNode.addEventListener('click', event => {
            const actionNode = event.target && event.target.closest ? event.target.closest('[data-action]') : null;
            const action = actionNode && actionNode.dataset ? actionNode.dataset.action : '';
            if (!action || !selectorNode.contains(actionNode)) {
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
                    state.selectorPickerRole = '';
                    scheduleSelectorHide();
                }
                render();
                return;
            }
            if (action === 'swap-subtitles') {
                swapDisplaySubtitleSlots();
                return;
            }
            if (action === 'open-picker') {
                const role = actionNode.dataset ? actionNode.dataset.role : '';
                state.selectorPickerRole = state.selectorPickerRole === role ? '' : role;
                state.selectorSignature = '';
                renderSelector();
                return;
            }
        });

        const transcriptToggleNode = document.createElement('button');
        transcriptToggleNode.type = 'button';
        transcriptToggleNode.className = 'nds-transcript-toggle';
        transcriptToggleNode.textContent = 'TXT';
        transcriptToggleNode.title = 'Subtitle transcript';
        transcriptToggleNode.setAttribute('aria-label', 'Subtitle transcript');
        transcriptToggleNode.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            state.transcriptOpen = !state.transcriptOpen;
            if (state.transcriptOpen) {
                state.transcriptScrollToCurrent = true;
            }
            state.transcriptSignature = '';
            renderTranscript();
        });

        const transcriptNode = document.createElement('div');
        transcriptNode.className = 'nds-transcript-window';
        ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'].forEach(eventName => {
            transcriptNode.addEventListener(eventName, event => {
                event.stopPropagation();
            });
        });
        transcriptNode.addEventListener('input', event => {
            const target = event.target;
            if (!target || target.dataset.role !== 'transcript-opacity') {
                return;
            }
            state.transcriptOpacity = clampTranscriptOpacity(target.value);
            saveTranscriptOpacityPreference(state.transcriptOpacity);
            state.transcriptNode.style.setProperty('--nds-transcript-opacity', String(state.transcriptOpacity));
            state.transcriptSignature = '';
        });
        transcriptNode.addEventListener('click', event => {
            const actionNode = event.target && event.target.closest ? event.target.closest('[data-action]') : null;
            const action = actionNode && actionNode.dataset ? actionNode.dataset.action : '';
            if (!action || !transcriptNode.contains(actionNode)) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            if (action === 'close-transcript') {
                state.transcriptOpen = false;
                state.transcriptSignature = '';
                renderTranscript();
                return;
            }
            if (action === 'seek-cue') {
                seekToCueTime(actionNode.dataset ? actionNode.dataset.timeMs : '');
            }
        });

        const toastNode = document.createElement('div');
        toastNode.className = 'nds-toast';

        root.appendChild(textNode);
        root.appendChild(statusNode);
        root.appendChild(selectorNode);
        root.appendChild(transcriptToggleNode);
        root.appendChild(transcriptNode);
        root.appendChild(toastNode);
        parent.appendChild(root);

        state.root = root;
        state.textNode = textNode;
        state.statusNode = statusNode;
        state.selectorNode = selectorNode;
        state.transcriptToggleNode = transcriptToggleNode;
        state.transcriptNode = transcriptNode;
        state.selectorSignature = '';
        state.transcriptSignature = '';
        state.toastNode = toastNode;
        return true;
    }

    function getVideo() {
        const videos = Array.from(document.querySelectorAll('video'));
        return videos.find(video => video.readyState > 0 && !video.paused) || videos[0] || null;
    }

    function cueAt(track, timeMs) {
        if (!track || !Array.isArray(track.cues) || !Number.isFinite(timeMs)) {
            return null;
        }

        let low = 0;
        let high = track.cues.length - 1;
        let candidateIndex = -1;
        while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            const cue = track.cues[middle];
            if (cue.start - CUE_START_TOLERANCE_MS <= timeMs) {
                candidateIndex = middle;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }

        for (let index = candidateIndex; index >= 0; index -= 1) {
            const cue = track.cues[index];
            if (timeMs >= cue.start - CUE_START_TOLERANCE_MS && timeMs <= cue.end + CUE_END_TOLERANCE_MS) {
                return cue;
            }
        }
        return null;
    }

    function clearSubtitleOverlay() {
        state.lastText = '';
        if (state.textNode) {
            state.textNode.textContent = '';
        }
    }

    function applyNativeSubtitleVisibility() {
        document.documentElement.classList.toggle('nds-hide-native-subtitles', state.hideNative);
        document.documentElement.classList.toggle('nds-addon-active', state.enabled);
        document.documentElement.classList.toggle('nds-selector-attention', selectorShouldHoldNetflixControls());
    }

    function appendSelectorIconButton(parent, action, active) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.action = action;
        button.className = 'nds-selector-toggle' + (active ? ' is-active' : '');
        button.title = 'Audio and subtitle language selector';
        button.setAttribute('aria-label', 'Audio and subtitle language selector');

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', '24');
        svg.setAttribute('height', '24');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('fill', 'none');
        svg.classList.add('nds-selector-icon');

        const bubble = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        bubble.setAttribute('fill', 'currentColor');
        bubble.setAttribute('fill-rule', 'evenodd');
        bubble.setAttribute('clip-rule', 'evenodd');
        bubble.setAttribute('d', 'M2 4a1 1 0 0 1 1-1h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-4.2l-4.25 3.4A1 1 0 0 1 11 19.62V17H3a1 1 0 0 1-1-1zm2 1v10h9v2.54L16.1 15H20V5z');
        svg.appendChild(bubble);

        const letter = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        letter.setAttribute('fill', 'currentColor');
        letter.setAttribute('d', 'M7.2 13h1.7l.5-1.4h2.4l.5 1.4H14L11.6 7H9.7zm2.6-2.7.8-2.25.8 2.25zM15 8h4v1.5h-1.25V13h-1.5V9.5H15z');
        svg.appendChild(letter);

        button.appendChild(svg);
        parent.appendChild(button);
    }

    function appendRadioOption(list, groupName, role, value, labelText, selected) {
        const label = document.createElement('label');
        label.className = 'nds-radio-option';

        const input = document.createElement('input');
        input.type = 'radio';
        input.name = groupName;
        input.value = value;
        input.dataset.role = role;
        input.checked = !!selected;
        label.appendChild(input);

        const text = document.createElement('span');
        text.className = 'nds-radio-label';
        text.textContent = labelText;
        text.title = labelText;
        label.appendChild(text);

        list.appendChild(label);
    }

    function appendChoiceRow(parent, title, role, currentLabel, options) {
        if (!options.length) {
            return;
        }

        const section = document.createElement('div');
        section.className = 'nds-selector-section';

        const row = document.createElement('div');
        row.className = 'nds-selector-row';

        const label = document.createElement('div');
        label.className = 'nds-selector-row-label';
        label.textContent = title;
        row.appendChild(label);

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'nds-choice-button' + (state.selectorPickerRole === role ? ' is-active' : '');
        button.dataset.action = 'open-picker';
        button.dataset.role = role;
        button.textContent = currentLabel || 'Off';
        button.title = currentLabel || 'Off';
        row.appendChild(button);
        section.appendChild(row);

        parent.appendChild(section);
    }

    function appendSubtitleSwapChoice(parent) {
        const row = document.createElement('div');
        row.className = 'nds-swap-row';

        const label = document.createElement('div');
        label.className = 'nds-selector-row-label';
        label.textContent = 'Swap';
        row.appendChild(label);

        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.action = 'swap-subtitles';
        button.className = 'nds-swap-button';
        button.textContent = 'Primary ↔ Secondary';
        button.disabled = state.displayLangs.filter(key => key && state.tracks.has(key)).length < 2;
        row.appendChild(button);

        parent.appendChild(row);
    }

    function transcriptCurrentCueIndex(track) {
        const video = getVideo();
        if (!track || !Array.isArray(track.cues) || !track.cues.length || !video) {
            return -1;
        }
        const timeMs = video.currentTime * 1000;
        const active = cueAt(track, timeMs);
        if (active && active.text) {
            return track.cues.indexOf(active);
        }
        const nextIndex = track.cues.findIndex(cue => cue && cue.text && cue.start >= timeMs);
        if (nextIndex !== -1) {
            return nextIndex;
        }
        for (let index = track.cues.length - 1; index >= 0; index -= 1) {
            if (track.cues[index] && track.cues[index].text) {
                return index;
            }
        }
        return -1;
    }

    function updateTranscriptPointer() {
        const panel = state.transcriptNode;
        const primaryTrack = state.tracks.get(state.displayLangs[0] || '');
        if (!state.transcriptOpen || !panel || !primaryTrack) {
            return false;
        }
        const currentCueIndex = transcriptCurrentCueIndex(primaryTrack);
        if (currentCueIndex < 0) {
            panel.querySelectorAll('.nds-transcript-row.is-current').forEach(row => row.classList.remove('is-current'));
            state.transcriptLastCueIndex = -1;
            return false;
        }
        const nextRow = panel.querySelector('.nds-transcript-row[data-cue-index="' + currentCueIndex + '"]');
        if (!nextRow) {
            return false;
        }
        const changed = state.transcriptLastCueIndex !== currentCueIndex || !nextRow.classList.contains('is-current');
        if (changed) {
            panel.querySelectorAll('.nds-transcript-row.is-current').forEach(row => row.classList.remove('is-current'));
            nextRow.classList.add('is-current');
            state.transcriptLastCueIndex = currentCueIndex;
        }
        if ((changed || state.transcriptScrollToCurrent) && Date.now() >= state.transcriptUserScrollUntil) {
            scrollTranscriptToCurrent();
        }
        return true;
    }

    function scrollTranscriptToCurrent() {
        const panel = state.transcriptNode;
        const list = panel && panel.querySelector('.nds-transcript-list');
        const row = list && list.querySelector('.nds-transcript-row.is-current');
        if (!list || !row) {
            return false;
        }
        const targetTop = row.offsetTop - list.offsetTop - list.clientHeight * 0.35;
        state.transcriptProgrammaticScroll = true;
        list.scrollTop = Math.max(0, targetTop);
        setTimeout(() => {
            state.transcriptProgrammaticScroll = false;
        }, 0);
        return true;
    }

    function appendTranscriptCell(row, className, text, timeMs = null) {
        const cell = document.createElement('div');
        cell.className = 'nds-transcript-cell ' + className;
        if (timeMs !== null) {
            const time = document.createElement('span');
            time.className = 'nds-transcript-time';
            time.textContent = formatCueTime(timeMs);
            cell.appendChild(time);
        }
        cell.appendChild(document.createTextNode(text || ''));
        row.appendChild(cell);
    }

    function appendSubtitleTranscript(parent) {
        const primaryTrack = state.tracks.get(state.displayLangs[0] || '');
        if (!primaryTrack || !Array.isArray(primaryTrack.cues) || !primaryTrack.cues.length) {
            return;
        }
        const secondaryTrack = state.tracks.get(state.displayLangs[1] || '');

        const block = document.createElement('div');
        block.className = 'nds-transcript-block';

        const heading = document.createElement('div');
        heading.className = 'nds-transcript-heading';
        const primaryHeading = document.createElement('div');
        primaryHeading.textContent = trackDisplayLabel(primaryTrack) || 'Primary';
        const secondaryHeading = document.createElement('div');
        secondaryHeading.textContent = secondaryTrack ? trackDisplayLabel(secondaryTrack) : 'Secondary';
        heading.appendChild(primaryHeading);
        heading.appendChild(secondaryHeading);
        block.appendChild(heading);

        const list = document.createElement('div');
        list.className = 'nds-transcript-list';
        list.addEventListener('wheel', () => {
            state.transcriptUserScrollUntil = Date.now() + 4000;
        }, { passive: true });
        list.addEventListener('scroll', () => {
            if (!state.transcriptProgrammaticScroll) {
                state.transcriptUserScrollUntil = Date.now() + 4000;
            }
        }, { passive: true });
        const fragment = document.createDocumentFragment();
        const currentCueIndex = transcriptCurrentCueIndex(primaryTrack);
        primaryTrack.cues.forEach((cue, cueIndex) => {
            if (!cue || !cue.text) {
                return;
            }
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'nds-transcript-row' + (cueIndex === currentCueIndex ? ' is-current' : '');
            row.dataset.action = 'seek-cue';
            row.dataset.cueIndex = String(cueIndex);
            row.dataset.timeMs = String(Math.max(0, cue.start || 0));
            row.title = 'Jump to ' + formatCueTime(cue.start);
            const secondaryCue = secondaryTrack ? cueAt(secondaryTrack, cue.start + 1) : null;
            appendTranscriptCell(row, 'is-primary', cue.text, cue.start);
            appendTranscriptCell(row, 'is-secondary', secondaryCue && secondaryCue.text || '');
            fragment.appendChild(row);
        });
        list.appendChild(fragment);
        block.appendChild(list);
        parent.appendChild(block);
    }

    function appendPickerBlock(parent, title, role, options) {
        if (!options.length) {
            return;
        }

        const block = document.createElement('div');
        block.className = 'nds-picker-block';

        const heading = document.createElement('div');
        heading.className = 'nds-picker-heading';
        heading.textContent = title;
        block.appendChild(heading);

        const list = document.createElement('div');
        list.className = 'nds-radio-list';
        options.forEach(option => appendRadioOption(list, 'nds-' + role, role, option.value, option.label, option.selected));
        block.appendChild(list);
        parent.appendChild(block);
    }

    function audioRadioOptions() {
        const options = mergedAudioOptions();
        return [
            { value: '', label: 'Netflix current', selected: !state.selectedAudioKey },
            ...options.map(audioOption => ({
                value: 'audio:' + audioOption.key,
                label: audioOption.label,
                selected: audioOption.key === state.selectedAudioKey
            }))
        ];
    }

    function currentAudioLabel() {
        if (!state.selectedAudioKey) {
            return 'Netflix current';
        }
        const option = mergedAudioOptions().find(audioOption => audioOption.key === state.selectedAudioKey);
        return option ? option.label : 'Netflix current';
    }

    function languageRadioOptions(role, tracks) {
        const selected = role === 'primary' ? state.displayLangs[0] : state.displayLangs[1];
        const pendingValue = state.pendingSlotValues[role] || '';
        const options = [{ value: '', label: 'Off', selected: !pendingValue && !selected }];
        const languageOptions = [];
        const cachedLangs = new Set(tracks.map(track => normalizeLang(track.lang || '')).filter(Boolean));

        const officialOptions = mergedNativeOptions();
        const officialTrackKeys = new Set();
        const officialLangs = new Set(officialOptions.map(option => normalizeLang(option.lang || '')).filter(Boolean));
        officialOptions.forEach(nativeOption => {
            const cachedKey = cachedTrackKeyForOption(nativeOption);
            const value = 'official:' + nativeOption.key;
            const label = cleanLanguageDisplayLabel(nativeOption.label, nativeOption.lang) || nativeOption.label || nativeOption.lang || '';
            const optionLang = normalizeLang(nativeOption.lang || '');
            if (cachedKey) {
                officialTrackKeys.add(cachedKey);
            }
            languageOptions.push({
                value,
                label,
                cached: !!(cachedKey || optionLang && cachedLangs.has(optionLang)),
                selected: pendingValue === value || !pendingValue && cachedKey && cachedKey === selected
            });
        });

        tracks.filter(track => {
            const trackLang = normalizeLang(track.lang || '');
            return !officialTrackKeys.has(trackCacheKey(track)) && (!trackLang || !officialLangs.has(trackLang));
        }).forEach(track => {
            const trackKey = trackCacheKey(track);
            languageOptions.push({
                value: 'cached:' + trackKey,
                label: trackDisplayLabel(track),
                cached: true,
                selected: !pendingValue && trackKey === selected
            });
        });

        languageOptions
            .sort((a, b) => Number(b.cached) - Number(a.cached) || a.label.localeCompare(b.label))
            .forEach(option => options.push({
                value: option.value,
                label: option.label,
                selected: option.selected
            }));
        return options;
    }

    function currentLanguageLabel(role, options) {
        const selected = options.find(option => option.selected);
        return selected ? selected.label : 'Off';
    }

    function appendAudioChoice(parent) {
        const options = audioRadioOptions();
        if (options.length <= 1) {
            return [];
        }
        appendChoiceRow(parent, 'Audio', 'audio', currentAudioLabel(), options);
        return options;
    }

    function appendLanguageChoice(parent, role, tracks) {
        const options = languageRadioOptions(role, tracks);
        appendChoiceRow(parent, role === 'primary' ? 'Primary' : 'Secondary', role, currentLanguageLabel(role, options), options);
        return options;
    }

    function selectorHasAttention() {
        return !!(state.selectorOpen || state.selectorHover || (state.selectorNode && (state.selectorNode.matches(':hover') || state.selectorNode.contains(document.activeElement))));
    }

    function selectorPanelIsPresent() {
        return !!(state.selectorOpen && state.selectorNode && state.selectorNode.querySelector('.nds-selector-panel'));
    }

    function selectorDomIsVisible() {
        const selector = state.selectorNode;
        if (!selector || !document.documentElement.contains(selector)) {
            return false;
        }
        if (state.selectorOpen || selector.querySelector('.nds-selector-panel')) {
            return true;
        }
        if (selector.classList.contains('is-idle')) {
            return false;
        }
        try {
            const style = getComputedStyle(selector);
            const rect = selector.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.01 && rect.width > 0 && rect.height > 0;
        } catch (_) {
            return !!state.selectorVisible;
        }
    }

    function selectorIsAppearing() {
        return !!(state.selectorNode && (state.selectorVisible || state.selectorOpen || selectorDomIsVisible()));
    }

    function selectorShouldHoldNetflixControls() {
        return !!(state.enabled && state.bottomControlsVisible && netflixBottomControlsVisibleNow() && (selectorDomIsVisible() || selectorIsAppearing() || selectorPanelIsPresent() || selectorHasAttention()));
    }

    function netflixControlCandidateSelectors() {
        return [
            '[data-uia="player"]',
            '[data-uia="controls-standard"]',
            '[data-uia="timeline"]',
            '[data-uia^="control-"]',
            '[class*="watch-video--bottom-controls-container"]'
        ];
    }

    function isNetflixControlElement(element) {
        if (!element || element.nodeType !== 1) {
            return false;
        }
        return netflixControlCandidateSelectors().some(selector => {
            try {
                return element.matches(selector) || !!element.closest(selector);
            } catch (_) {
                return false;
            }
        });
    }

    function addedNodeTouchesNetflixControls(node) {
        if (isNetflixControlElement(node)) {
            return true;
        }
        if (!node || node.nodeType !== 1 || typeof node.querySelector !== 'function') {
            return false;
        }
        return netflixControlCandidateSelectors().some(selector => {
            try {
                return !!node.querySelector(selector);
            } catch (_) {
                return false;
            }
        });
    }

    function mutationTouchesNetflixControls(mutation) {
        if (isNetflixControlElement(mutation.target)) {
            return true;
        }
        return Array.from(mutation.addedNodes || []).some(addedNodeTouchesNetflixControls);
    }

    function forceStyle(element, property, value) {
        if (!element || !element.style) {
            return;
        }
        let previous = state.controlForcedStyles.get(element);
        if (!previous) {
            previous = {};
            state.controlForcedStyles.set(element, previous);
        }
        if (!previous[property]) {
            previous[property] = {
                value: element.style.getPropertyValue(property),
                priority: element.style.getPropertyPriority(property)
            };
        }
        element.style.setProperty(property, value, 'important');
    }

    function restoreNetflixControlForceStyles() {
        state.controlForcedStyles.forEach((properties, element) => {
            Object.keys(properties).forEach(property => {
                const previous = properties[property];
                try {
                    element.style.setProperty(property, previous.value, previous.priority);
                } catch (_) {}
            });
        });
        state.controlForcedStyles.clear();
    }

    function forcePlayerActiveClass() {
        document.querySelectorAll('[data-uia="player"]').forEach(player => {
            if (!state.controlForcedPlayerClasses.has(player)) {
                state.controlForcedPlayerClasses.set(player, {
                    active: player.classList.contains('active'),
                    inactive: player.classList.contains('inactive'),
                    passive: player.classList.contains('passive')
                });
            }
            player.classList.remove('inactive', 'passive');
            player.classList.add('active');
            player.setAttribute('data-nds-control-hold', 'active');
        });
    }

    function restorePlayerStateClasses() {
        state.controlForcedPlayerClasses.forEach((previous, player) => {
            try {
                if (player.getAttribute('data-nds-control-hold') !== 'active') {
                    return;
                }
                player.classList.remove('active', 'inactive', 'passive');
                ['active', 'inactive', 'passive'].forEach(className => {
                    if (previous[className]) {
                        player.classList.add(className);
                    }
                });
                player.removeAttribute('data-nds-control-hold');
            } catch (_) {}
        });
        state.controlForcedPlayerClasses.clear();
    }

    function addNetflixControlForceTarget(targets, element) {
        if (element && element.nodeType === 1) {
            targets.add(element);
        }
    }

    function clearSelectorControlHostTargets() {
        document.querySelectorAll('[data-nds-selector-host]').forEach(element => {
            element.removeAttribute('data-nds-selector-host');
        });
    }

    function addSelectorControlHostTargets(targets) {
        const selector = state.selectorNode;
        if (!selector || !document.documentElement.contains(selector)) {
            return;
        }

        let element = selector;
        for (let depth = 0; element && depth < 12; depth += 1) {
            addNetflixControlForceTarget(targets, element);
            if (element.matches && element.matches('[class*="watch-video--bottom-controls-container"]')) {
                element.setAttribute('data-nds-selector-host', '1');
            }
            if (element.matches && element.matches('[data-uia="player"]')) {
                break;
            }
            element = element.parentElement;
        }
    }

    function netflixControlForceTargets() {
        const targets = new Set();
        document.querySelectorAll('[data-uia="player"], [class*="watch-video--bottom-controls-container"], [data-uia="controls-standard"], [data-uia="timeline"], [data-uia^="control-"]').forEach(element => {
            addNetflixControlForceTarget(targets, element);
            let parent = element.parentElement;
            for (let depth = 0; parent && depth < 5; depth += 1) {
                addNetflixControlForceTarget(targets, parent);
                if (parent.matches && parent.matches('[data-uia="player"]')) {
                    break;
                }
                parent = parent.parentElement;
            }
        });
        addSelectorControlHostTargets(targets);
        return Array.from(targets);
    }

    function shouldForceControlDisplay(element) {
        if (!element || !element.matches) {
            return false;
        }
        if (element.hasAttribute('data-nds-selector-host')) {
            return true;
        }
        if (element.matches('[class*="watch-video--bottom-controls-container"]')) {
            return true;
        }
        try {
            return element.matches('div') && (
                !!element.querySelector(':scope > [data-uia="controls-standard"]') ||
                !!element.querySelector(':scope > div > [data-uia="controls-standard"]')
            );
        } catch (_) {
            return false;
        }
    }

    function applyNetflixControlForceStyles() {
        const targets = netflixControlForceTargets();
        targets.forEach(element => {
            forceStyle(element, 'opacity', '1');
            forceStyle(element, 'visibility', 'visible');
            forceStyle(element, 'pointer-events', 'auto');
            forceStyle(element, 'transform', 'none');
            forceStyle(element, 'translate', 'none');
            forceStyle(element, 'filter', 'none');
            if (shouldForceControlDisplay(element)) {
                forceStyle(element, 'display', 'flex');
            }
        });
    }

    function applyNetflixControlHold() {
        document.documentElement.classList.add('nds-selector-attention');
        forcePlayerActiveClass();
        applyNetflixControlForceStyles();
        wakeNetflixControls();
    }

    function releaseNetflixControlHold() {
        document.documentElement.classList.remove('nds-selector-attention');
        clearSelectorControlHostTargets();
        restoreNetflixControlForceStyles();
        restorePlayerStateClasses();
    }

    function scheduleNetflixControlHoldRefresh() {
        if (!selectorShouldHoldNetflixControls() || state.controlHoldRefreshScheduled) {
            return;
        }
        state.controlHoldRefreshScheduled = true;
        const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : callback => setTimeout(callback, 16);
        schedule(() => {
            state.controlHoldRefreshScheduled = false;
            if (!selectorShouldHoldNetflixControls()) {
                releaseNetflixControlHold();
                return;
            }
            applyNetflixControlHold();
        });
    }

    function playerControlState(player) {
        if (!player || !player.classList) {
            return '';
        }
        if (player.classList.contains('active')) {
            return 'active';
        }
        if (player.classList.contains('inactive')) {
            return 'inactive';
        }
        return player.classList.contains('passive') ? 'passive' : '';
    }

    function updateBottomControlVisibility(visible) {
        const nextVisible = visible !== false;
        if (state.bottomControlsVisible === nextVisible) {
            return;
        }
        state.bottomControlsVisible = nextVisible;
        if (!nextVisible) {
            state.selectorOpen = false;
            state.selectorPickerRole = '';
            releaseNetflixControlHold();
        }
        state.selectorSignature = '';
        renderSelector();
    }

    function handlePlayerControlStateChange(player) {
        const playerState = playerControlState(player);
        if (playerState === 'active') {
            updateBottomControlVisibility(true);
            return;
        }
        if (playerState === 'inactive' || playerState === 'passive') {
            updateBottomControlVisibility(false);
            return;
        }
        if (selectorShouldHoldNetflixControls()) {
            scheduleNetflixControlHoldRefresh();
        }
    }

    function observeNetflixPlayers() {
        if (typeof MutationObserver !== 'function') {
            return;
        }
        document.querySelectorAll('[data-uia="player"]').forEach(player => {
            if (state.observedPlayers.has(player)) {
                return;
            }
            state.observedPlayers.add(player);
            try {
                new MutationObserver(() => handlePlayerControlStateChange(player)).observe(player, {
                    attributes: true,
                    attributeFilter: ['class']
                });
                handlePlayerControlStateChange(player);
            } catch (_) {}
        });
    }

    function observeNetflixControlVisibility() {
        observeNetflixPlayers();
        if (state.controlObserverStarted || typeof MutationObserver !== 'function') {
            return;
        }
        const target = document.body || document.documentElement;
        if (!target) {
            return;
        }
        try {
            new MutationObserver(mutations => {
                observeNetflixPlayers();
                scheduleNativeOptionCacheRefresh();
                if (mutations.some(mutationTouchesNetflixControls)) {
                    updateBottomControlVisibility(netflixBottomControlsVisibleNow());
                }
                if (!selectorShouldHoldNetflixControls()) {
                    return;
                }
                if (mutations.some(mutationTouchesNetflixControls)) {
                    scheduleNetflixControlHoldRefresh();
                }
            }).observe(target, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: ['class', 'style', 'aria-hidden']
            });
            state.controlObserverStarted = true;
        } catch (_) {}
    }

    function keepNetflixControlsVisible() {
        const shouldHoldControls = selectorShouldHoldNetflixControls();
        if (!shouldHoldControls) {
            releaseNetflixControlHold();
            return;
        }
        applyNetflixControlHold();
    }

    function cacheVisibleNativeOptions() {
        if (!state.enabled || state.nativeScanInProgress) {
            return;
        }
        let changed = false;
        if (audioListContainers().length || nativeMediaRows('audio').length) {
            const before = state.nativeAudioOptions.map(option => option.key).join('|');
            collectNativeAudioOptions();
            changed = changed || before !== state.nativeAudioOptions.map(option => option.key).join('|');
        }
        if (subtitleListContainers().length || nativeMediaRows('subtitle').length) {
            const before = state.nativeOptions.map(option => option.key).join('|');
            collectNativeSubtitleOptions();
            changed = changed || before !== state.nativeOptions.map(option => option.key).join('|');
        }
        if (changed) {
            state.status = 'cached visible Netflix audio/subtitle languages';
            scheduleApplyLanguagePreferences();
        }
    }

    function scheduleNativeOptionCacheRefresh() {
        if (state.nativeCacheRefreshScheduled || !state.enabled || state.nativeScanInProgress) {
            return;
        }
        state.nativeCacheRefreshScheduled = true;
        setTimeout(() => {
            state.nativeCacheRefreshScheduled = false;
            cacheVisibleNativeOptions();
        }, 80);
    }

    function showSelectorChrome() {
        if (state.selectorHideTimer) {
            clearTimeout(state.selectorHideTimer);
            state.selectorHideTimer = null;
        }
        keepNetflixControlsVisible();
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
            if (selectorHasAttention()) {
                return;
            }
            state.selectorVisible = false;
            state.selectorSignature = '';
            render();
        }, SELECTOR_IDLE_HIDE_MS);
    }

    function noteScreenActivity() {
        const wasVisible = state.selectorVisible;
        state.selectorVisible = true;
        if (selectorHasAttention()) {
            keepNetflixControlsVisible();
        } else {
            scheduleSelectorHide();
        }
        if (!wasVisible) {
            state.selectorSignature = '';
            renderSelector();
        }
    }

    function closeSelectorPanel() {
        if (!state.selectorOpen) {
            return false;
        }
        state.selectorOpen = false;
        state.selectorPickerRole = '';
        state.selectorSignature = '';
        renderSelector();
        scheduleSelectorHide();
        return true;
    }

    function handleSelectorOutsidePointer(event) {
        if (!state.selectorOpen || !state.selectorNode) {
            return;
        }
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
        if (path.includes(state.selectorNode) || state.selectorNode.contains(event.target)) {
            return;
        }
        closeSelectorPanel();
    }

    function handleSelectorKeydown(event) {
        if (event.key === 'Escape' && closeSelectorPanel()) {
            event.preventDefault();
            event.stopPropagation();
        }
    }

    function netflixBottomControlsContainer() {
        const controls = document.querySelector('[data-uia="controls-standard"]');
        if (controls) {
            const bottom = controls.closest('[class*="watch-video--bottom-controls-container"]');
            if (bottom) {
                return bottom;
            }
            return controls.parentElement || controls;
        }
        return document.querySelector('[class*="watch-video--bottom-controls-container"]');
    }

    function netflixBottomControlsVisibleNow() {
        const bottom = netflixBottomControlsContainer();
        if (!bottom) {
            return false;
        }
        try {
            const rect = bottom.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
                return false;
            }
            for (let element = bottom; element && element.nodeType === 1; element = element.parentElement) {
                const style = getComputedStyle(element);
                if (element.hidden || element.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) <= 0.05) {
                    return false;
                }
                if (element === document.documentElement) {
                    break;
                }
            }
            return true;
        } catch (_) {
            return false;
        }
    }

    function selectorShouldMountInNetflixControls() {
        return !!state.enabled;
    }

    function mountSelectorNode() {
        const selector = state.selectorNode;
        if (!selector) {
            return 'none';
        }

        const netflixControls = selectorShouldMountInNetflixControls() ? netflixBottomControlsContainer() : null;
        if (netflixControls) {
            if (selector.parentNode !== netflixControls) {
                netflixControls.appendChild(selector);
            }
            selector.dataset.mount = 'netflix-controls';
            state.selectorMount = 'netflix-controls';
            return 'netflix-controls';
        }

        if (state.root && selector.parentNode !== state.root) {
            state.root.insertBefore(selector, state.toastNode || null);
        }
        selector.dataset.mount = 'overlay';
        state.selectorMount = 'overlay';
        return 'overlay';
    }

    function rememberSelectorPanelScroll() {
        const panel = state.selectorNode && state.selectorNode.querySelector('.nds-selector-panel');
        if (!panel) {
            return;
        }
        state.selectorPanelScrollTop = panel.scrollTop || 0;
        state.selectorPanelScrollLeft = panel.scrollLeft || 0;
    }

    function restoreSelectorPanelScroll() {
        const panel = state.selectorNode && state.selectorNode.querySelector('.nds-selector-panel');
        if (!panel) {
            return;
        }
        panel.scrollTop = state.selectorPanelScrollTop || 0;
        panel.scrollLeft = state.selectorPanelScrollLeft || 0;
    }

    function renderTranscript() {
        if (!state.transcriptNode || !state.transcriptToggleNode) {
            return;
        }
        const primaryTrack = state.tracks.get(state.displayLangs[0] || '');
        const secondaryTrack = state.tracks.get(state.displayLangs[1] || '');
        const signature = [
            state.transcriptOpen ? 'open' : 'closed',
            state.transcriptOpacity,
            state.displayLangs.join(','),
            primaryTrack ? trackCacheKey(primaryTrack) + ':' + primaryTrack.cues.length + ':' + (primaryTrack.savedAt || 0) : '',
            secondaryTrack ? trackCacheKey(secondaryTrack) + ':' + secondaryTrack.cues.length + ':' + (secondaryTrack.savedAt || 0) : ''
        ].join('::');
        const controlsVisible = state.bottomControlsVisible && netflixBottomControlsVisibleNow();
        state.transcriptNode.style.setProperty('--nds-transcript-opacity', String(state.transcriptOpacity));
        state.transcriptToggleNode.classList.toggle('is-active', state.transcriptOpen);
        state.transcriptToggleNode.classList.toggle('is-hidden', !controlsVisible && !state.transcriptOpen);
        state.transcriptNode.classList.toggle('is-open', state.transcriptOpen);
        if (signature === state.transcriptSignature) {
            return;
        }
        state.transcriptSignature = signature;
        state.transcriptNode.textContent = '';
        if (!state.transcriptOpen) {
            state.transcriptLastCueIndex = -1;
            return;
        }

        const title = document.createElement('div');
        title.className = 'nds-transcript-title';
        const titleText = document.createElement('div');
        titleText.textContent = 'Transcript';
        const opacityLabel = document.createElement('label');
        opacityLabel.className = 'nds-transcript-opacity';
        const opacityText = document.createElement('span');
        opacityText.textContent = 'Opacity';
        const opacityInput = document.createElement('input');
        opacityInput.type = 'range';
        opacityInput.min = '0.35';
        opacityInput.max = '1';
        opacityInput.step = '0.05';
        opacityInput.value = String(state.transcriptOpacity);
        opacityInput.dataset.role = 'transcript-opacity';
        opacityLabel.appendChild(opacityText);
        opacityLabel.appendChild(opacityInput);

        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'nds-transcript-close';
        closeButton.dataset.action = 'close-transcript';
        closeButton.textContent = 'Close';
        title.appendChild(titleText);
        title.appendChild(opacityLabel);
        title.appendChild(closeButton);
        state.transcriptNode.appendChild(title);

        if (!primaryTrack) {
            const empty = document.createElement('div');
            empty.className = 'nds-selector-empty';
            empty.textContent = 'Select a primary subtitle to show the transcript.';
            state.transcriptNode.appendChild(empty);
            return;
        }
        appendSubtitleTranscript(state.transcriptNode);
        updateTranscriptPointer();
        if (state.transcriptScrollToCurrent && scrollTranscriptToCurrent()) {
            state.transcriptScrollToCurrent = false;
        }
    }

    function renderSelector() {
        if (!state.selectorNode) {
            return;
        }
        rememberSelectorPanelScroll();
        mountSelectorNode();

        const tracks = Array.from(state.tracks.values()).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
        const selectorDisabled = !state.bottomControlsVisible || !netflixBottomControlsVisibleNow();
        const signature = [
            state.selectorOpen ? 'open' : 'closed',
            state.selectorMount,
            state.selectorPickerRole,
            state.selectorVisible ? 'visible' : 'idle',
            selectorDisabled ? 'control-hidden' : 'control-visible',
            state.manualDisplay ? 'manual' : 'latest',
            state.displayLangs.join(','),
            JSON.stringify(state.pendingSlotValues),
            state.selectedAudioKey,
            mergedAudioOptions().map(option => option.key + ':' + option.lang).join('|'),
            mergedNativeOptions().map(option => option.key + ':' + option.lang + ':' + ((option.urls || []).length)).join('|'),
            state.nativeScanInProgress ? 'native-scan' : 'native-idle',
            state.nativeScanAttempted ? 'native-tried' : 'native-untried',
            tracks.map(track => trackCacheKey(track) + ':' + track.lang + ':' + trackDisplayLabel(track) + ':' + track.cues.length + ':' + (track.savedAt || 0)).join('|')
        ].join('::');
        if (signature === state.selectorSignature) {
            return;
        }
        state.selectorSignature = signature;

        const selector = state.selectorNode;
        selector.classList.toggle('is-idle', !state.selectorVisible && !state.selectorOpen);
        selector.classList.toggle('is-control-hidden', selectorDisabled);
        selector.textContent = '';
        appendSelectorIconButton(selector, 'toggle-selector', state.selectorOpen);
        if (selectorDisabled || !state.selectorOpen) {
            return;
        }

        const panel = document.createElement('div');
        panel.className = 'nds-selector-panel';

        const title = document.createElement('div');
        title.className = 'nds-selector-title';
        title.textContent = 'Languages';
        panel.appendChild(title);

        const officialOptions = mergedNativeOptions();
        const audioOptions = mergedAudioOptions();
        if (!tracks.length && !officialOptions.length && !audioOptions.length) {
            const empty = document.createElement('div');
            empty.className = 'nds-selector-empty';
            empty.textContent = state.nativeScanInProgress ?
                'Loading Netflix audio/subtitle languages...' :
                state.nativeScanAttempted ?
                    'No Netflix audio/subtitle languages detected yet.' :
                    'Waiting for Netflix audio/subtitle languages...';
            panel.appendChild(empty);
        }
        const pickerOptions = {};
        if (audioOptions.length) {
            pickerOptions.audio = appendAudioChoice(panel);
        }
        if (tracks.length || officialOptions.length) {
            pickerOptions.primary = appendLanguageChoice(panel, 'primary', tracks);
            pickerOptions.secondary = appendLanguageChoice(panel, 'secondary', tracks);
            appendSubtitleSwapChoice(panel);
        }
        if (state.selectorPickerRole && pickerOptions[state.selectorPickerRole]) {
            const pickerTitle = state.selectorPickerRole === 'audio' ? 'Audio' : state.selectorPickerRole === 'primary' ? 'Primary' : 'Secondary';
            appendPickerBlock(panel, pickerTitle, state.selectorPickerRole, pickerOptions[state.selectorPickerRole]);
        }

        selector.appendChild(panel);
        restoreSelectorPanelScroll();
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
        renderTranscript();
        updateTranscriptPointer();

        if (!state.enabled || !state.displayLangs.length) {
            clearSubtitleOverlay();
            return;
        }

        const video = getVideo();
        if (!video) {
            clearSubtitleOverlay();
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
            key: 'manifest:' + stableHash([currentContextVideoId(), trackId, lang, label, urls[0]].join('|')),
            label: cleanLanguageDisplayLabel(label, lang) || lang || 'Unknown',
            lang,
            urls,
            sourceUrl,
            trackId,
            source: 'manifest'
        };
    }

    function optionFromManifestAudioTrack(track, sourceUrl) {
        if (!track || typeof track !== 'object' || track.Ez || track.isNoneTrack) {
            return null;
        }

        const lang = normalizeLang(track.language || track.bcp47 || track.Bcp47 || track.uh || track.lang || '');
        const label = normalizeNativeLabel(track.languageDescription || track.aP || track.displayName || track.label || track.name || lang || 'Unknown');
        if (!label || !lang && label === 'Unknown') {
            return null;
        }

        const trackId = String(track.id || track.trackId || track.Au || track.Ix || track.new_track_id || track.track_id || '');
        const channels = String(track.channels || track.bqd || track.channelCount || '');
        const suffix = [lang, channels && channels !== '0' ? channels : ''].filter(Boolean).join(', ');
        return {
            key: 'audio-manifest:' + stableHash([currentContextVideoId(), trackId, lang, label, channels].join('|')),
            label: label + (suffix ? ' (' + suffix + ')' : ''),
            lang,
            trackId,
            channels,
            sourceUrl,
            source: 'manifest-audio'
        };
    }

    function extractManifestOptions(data, sourceUrl) {
        const options = [];
        const audioOptions = [];
        const seen = new Set();
        const seenAudio = new Set();
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

            ['audioTracks', 'audio_tracks', 'Rm', 'OI'].forEach(key => {
                if (Array.isArray(item[key])) {
                    item[key].forEach(track => {
                        const option = optionFromManifestAudioTrack(track, sourceUrl);
                        if (option && !seenAudio.has(option.key)) {
                            seenAudio.add(option.key);
                            audioOptions.push(option);
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

        return { subtitleOptions: options, audioOptions };
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

        const extracted = extractManifestOptions(data, url);
        const options = extracted.subtitleOptions || [];
        const audioOptions = extracted.audioOptions || [];
        if (!options.length && !audioOptions.length) {
            return 0;
        }

        const merged = new Map(state.manifestOptions.map(option => [option.key, option]));
        options.forEach(option => merged.set(option.key, option));
        state.manifestOptions = Array.from(merged.values()).sort((a, b) => a.label.localeCompare(b.label));

        const mergedAudio = new Map(state.manifestAudioOptions.map(option => [option.key, option]));
        audioOptions.forEach(option => mergedAudio.set(option.key, option));
        state.manifestAudioOptions = Array.from(mergedAudio.values()).sort((a, b) => a.label.localeCompare(b.label));

        saveOptionCache();
        state.selectorSignature = '';
        renderSelector();
        scheduleApplyLanguagePreferences();
        return options.length + audioOptions.length;
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
        const requestVideoId = currentContextVideoId();
        try {
            while (state.prefetchQueue.length) {
                if (requestVideoId !== currentContextVideoId()) {
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
            if (requestVideoId === currentContextVideoId()) {
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
                if (requestVideoId !== currentContextVideoId()) {
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

        const requestVideoId = currentContextVideoId();
        notify('Fetching ' + trackDisplayLabel(track) + ' from saved Netflix URL');
        try {
            const response = await gmGet(track.sourceUrl);
            if (requestVideoId !== currentContextVideoId()) {
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

        const requestVideoId = currentContextVideoId();
        state.manualDisplay = true;
        state.preferenceAppliedDisplay = !!state.preferenceApplyInProgress;
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
                if (requestVideoId !== currentContextVideoId()) {
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

        clearPendingSubtitleSlot(slot, option);
        notify('Could not fetch Netflix subtitle: ' + option.label);
        return false;
    }

    async function fetchCandidate(url, entry) {
        if (!subtitleUrlCandidate(url, entry) || state.requestedUrls.has(url)) {
            return;
        }

        state.requestedUrls.add(url);
        const requestVideoId = currentContextVideoId();
        state.status = 'intercepted ?o=1 request #' + state.requestedUrls.size;
        render();

        try {
            const response = await gmGet(url);
            if (requestVideoId !== currentContextVideoId()) {
                return;
            }
            const body = String(response.responseText || '');
            if (response.status >= 400 || body.length > MAX_RESPONSE_CHARS) {
                state.status = 'fetch skipped: HTTP ' + response.status;
                render();
                return;
            }

            rememberPayload(url, body, requestVideoId);
        } catch (error) {
            state.status = 'fetch error: ' + (error && error.message ? error.message : 'unknown');
            render();
        }
    }

    function rememberPayload(url, payload, payloadVideoId = '') {
        if (typeof payload !== 'string' || payload.length > MAX_RESPONSE_CHARS) {
            return;
        }

        const currentVideoId = currentContextVideoId();
        const capturedVideoId = String(payloadVideoId || '');
        if (capturedVideoId && currentVideoId && capturedVideoId !== currentVideoId) {
            return;
        }

        const manifestCount = rememberManifestOptions(url, payload);
        if (manifestCount) {
            state.status = 'found ' + manifestCount + ' manifest audio/subtitle option(s)';
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
        const option = bestSubtitleOptionForLang(lang, url);
        const saveOptions = option ? {
            silent: true,
            preserveDisplay: true,
            key: option.key,
            optionKey: option.key,
            label: option.label
        } : { silent: true, preserveDisplay: true };
        if (!saveTrack(lang, cues, url, saveOptions)) {
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

            function currentWatchId() {
                const match = String(location.pathname || '').match(/\/watch\/(\d+)/);
                return match ? match[1] : '';
            }

            function emit(url, payload, watchId) {
                if (typeof payload !== 'string' || payload.length > maxChars) {
                    return;
                }
                window.dispatchEvent(new CustomEvent(eventName, { detail: { url: String(url || ''), payload, videoId: watchId || currentWatchId() } }));
            }

            function relevant(url, type) {
                return /subtitle|timedtext|dfxp|webvtt|ttml|nflxvideo\.net/i.test(String(url || '')) ||
                    /text|json|xml|vtt|ttml|dfxp|octet-stream/i.test(String(type || ''));
            }

            if (typeof originalFetch === 'function' && !originalFetch.__ndsPatched) {
                window.fetch = function(input) {
                    const requestUrl = input && input.url ? input.url : input;
                    const requestWatchId = currentWatchId();
                    return originalFetch.apply(this, arguments).then(response => {
                        const responseUrl = response.url || requestUrl;
                        const type = response.headers && response.headers.get ? response.headers.get('content-type') : '';
                        if (response.clone && relevant(responseUrl, type)) {
                            response.clone().text().then(text => emit(responseUrl, text, requestWatchId)).catch(() => {});
                        }
                        return response;
                    });
                };
                window.fetch.__ndsPatched = true;
            }

            if (!XMLHttpRequest.prototype.open.__ndsPatched) {
                XMLHttpRequest.prototype.open = function(method, url) {
                    this.__ndsUrl = url;
                    this.__ndsWatchId = currentWatchId();
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
                            emit(url, this.responseText, this.__ndsWatchId);
                        } else if (this.responseType === 'json') {
                            try {
                                emit(url, JSON.stringify(this.response), this.__ndsWatchId);
                            } catch (_) {}
                        } else if (typeof this.response === 'string') {
                            emit(url, this.response, this.__ndsWatchId);
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

    async function clickNativeMediaElement(element) {
        if (!element) {
            return false;
        }
        document.documentElement.classList.add('nds-native-selecting');
        try {
            await sleep(30);
            return clickNativeElement(element);
        } finally {
            setTimeout(() => document.documentElement.classList.remove('nds-native-selecting'), 160);
        }
    }

    function makeNetflixActivityEvent(type, init, pointer = false) {
        let event;
        try {
            event = pointer && typeof PointerEvent === 'function' ? new PointerEvent(type, init) : new MouseEvent(type, init);
        } catch (_) {
            event = new MouseEvent(type, init);
        }
        ['pageX', 'pageY'].forEach(prop => {
            try {
                Object.defineProperty(event, prop, { configurable: true, get: () => init[prop] });
            } catch (_) {}
        });
        return event;
    }

    function dispatchNetflixActivity(target, clientX, clientY) {
        const pageX = clientX + window.scrollX;
        const pageY = clientY + window.scrollY;
        const eventInit = {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            detail: 0,
            clientX,
            clientY,
            pageX,
            pageY,
            screenX: clientX,
            screenY: clientY,
            buttons: 0,
            button: 0,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true
        };
        const targets = [target, document, window];
        ['pointerover', 'pointerenter', 'pointermove'].forEach(type => {
            targets.forEach(node => {
                try {
                    node.dispatchEvent(makeNetflixActivityEvent(type, eventInit, true));
                } catch (_) {}
            });
        });
        ['mouseover', 'mouseenter', 'mousemove'].forEach(type => {
            targets.forEach(node => {
                try {
                    node.dispatchEvent(makeNetflixActivityEvent(type, eventInit, false));
                } catch (_) {}
            });
        });
    }

    function wakeNetflixControls() {
        const player = document.querySelector('[data-uia="player"]');
        const target = player || getVideo() || document.body;
        if (!target) {
            return;
        }
        const rect = target.getBoundingClientRect ? target.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
        const baseX = Math.max(1, Math.round(rect.left + Math.min(rect.width || window.innerWidth, 96)));
        const baseY = Math.max(1, Math.round(rect.top + Math.min(rect.height || window.innerHeight, 96)));
        state.controlWakeNudge = (state.controlWakeNudge + 1) % 11;
        const nudge = state.controlWakeNudge + 1;
        dispatchNetflixActivity(target, baseX + nudge, baseY + nudge);
        setTimeout(() => dispatchNetflixActivity(target, baseX + ((nudge + 3) % 5), baseY + ((nudge + 5) % 5)), 8);
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

    function itemLabelFromUia(node, kind = 'subtitle') {
        const value = node ? node.getAttribute('data-uia') || '' : '';
        const pattern = kind === 'audio' ? /^audio-item-(?:selected-)?(.+)$/ : /^subtitle-item-(?:selected-)?(.+)$/;
        const match = value.match(pattern);
        return match ? normalizeNativeLabel(match[1]) : '';
    }

    function optionTextFromNode(node, kind = 'subtitle') {
        const dataUiaLabel = itemLabelFromUia(node, kind);
        if (dataUiaLabel) {
            return dataUiaLabel;
        }

        const clone = node.cloneNode(true);
        clone.querySelectorAll('svg, img, path').forEach(child => child.remove());
        return normalizeNativeLabel(clone.textContent || node.getAttribute('aria-label') || '');
    }

    function optionNodesInside(container, kind = 'subtitle') {
        const nodes = Array.from(container.querySelectorAll('button, [role="menuitem"], [role="option"], li, [tabindex]'))
            .filter(visibleElement)
            .filter(node => !state.root || !state.root.contains(node));
        return nodes.filter((node, index, array) => !array.some(other => other !== node && other.contains(node) && optionTextFromNode(other, kind) === optionTextFromNode(node, kind)));
    }

    function mediaItemRowsInside(container, kind = 'subtitle') {
        const prefix = kind === 'audio' ? 'audio-item-' : 'subtitle-item-';
        return Array.from(container.querySelectorAll('li[data-uia^="' + prefix + '"], [data-uia^="' + prefix + '"]'))
            .filter(visibleElement)
            .filter(node => !state.root || !state.root.contains(node));
    }

    function subtitleItemRowsInside(container) {
        return mediaItemRowsInside(container, 'subtitle');
    }

    function audioItemRowsInside(container) {
        return mediaItemRowsInside(container, 'audio');
    }

    function subtitleListContainers() {
        return Array.from(document.querySelectorAll('h3'))
            .filter(heading => likelySubtitleHeading(heading.textContent || ''))
            .map(heading => heading.parentElement)
            .filter(Boolean)
            .filter(visibleElement)
            .filter(container => subtitleItemRowsInside(container).length);
    }

    function audioListContainers() {
        return Array.from(document.querySelectorAll('h3'))
            .filter(heading => likelyAudioHeading(heading.textContent || ''))
            .map(heading => heading.parentElement)
            .filter(Boolean)
            .filter(visibleElement)
            .filter(container => audioItemRowsInside(container).length);
    }

    function subtitleSectionNodes(container) {
        const directRows = subtitleItemRowsInside(container);
        if (directRows.length) {
            return directRows;
        }

        const nodes = optionNodesInside(container, 'subtitle');
        const result = [];
        let inSubtitleSection = false;
        for (const node of nodes) {
            const text = optionTextFromNode(node, 'subtitle').replace(/\s+selected$/i, '').trim();
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

    function audioSectionNodes(container) {
        const directRows = audioItemRowsInside(container);
        if (directRows.length) {
            return directRows;
        }

        const nodes = optionNodesInside(container, 'audio');
        const result = [];
        let inAudioSection = false;
        for (const node of nodes) {
            const text = optionTextFromNode(node, 'audio').replace(/\s+selected$/i, '').trim();
            if (!text) {
                continue;
            }
            if (likelyAudioHeading(text)) {
                inAudioSection = true;
                continue;
            }
            if (inAudioSection && likelySubtitleHeading(text)) {
                break;
            }
            if (inAudioSection) {
                result.push(node);
            }
        }
        return result.length ? result : nodes;
    }

    function nativeOptionFromNode(node, kind = 'subtitle') {
        const raw = optionTextFromNode(node, kind).replace(/\s+selected$/i, '').trim();
        const label = normalizeNativeLabel(raw);
        const skip = /^(audio|subtitles?|captions?|off|none|關閉|关闭|latest|fetch all|scan official|primary|secondary|cc|done)$/i;
        if (!label || label.length < 2 || label.length > 80 || skip.test(label)) {
            return null;
        }
        const lang = langFromNativeLabel(label);
        if (!lang) {
            return null;
        }
        return { key: kind + ':' + nativeLabelKey(label), label, lang, element: node, source: 'native-' + kind };
    }

    function nativeMediaRows(kind) {
        const prefix = kind === 'audio' ? 'audio-item-' : 'subtitle-item-';
        return Array.from(document.querySelectorAll('li[data-uia^="' + prefix + '"], [data-uia^="' + prefix + '"]'))
            .filter(visibleElement)
            .filter(node => !state.root || !state.root.contains(node));
    }

    async function waitForNativeMediaRows(kind, timeoutMs = 2200) {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            wakeNetflixControls();
            const rows = nativeMediaRows(kind);
            if (rows.some(row => nativeOptionFromNode(row, kind))) {
                return true;
            }
            await sleep(80);
        }
        return false;
    }

    function findNativeMediaOptionElement(kind, option) {
        return kind === 'audio' ? findNativeAudioOptionElement(option) : findNativeSubtitleOptionElement(option);
    }

    async function waitForNativeMediaOptionElement(kind, option, timeoutMs = 3200) {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            wakeNetflixControls();
            const element = findNativeMediaOptionElement(kind, option);
            if (element && visibleElement(element)) {
                return element;
            }
            await sleep(80);
        }
        return null;
    }

    function nativeSubtitleCandidates() {
        const candidates = [];
        const seen = new Set();
        const addNode = node => {
            const option = nativeOptionFromNode(node, 'subtitle');
            if (!option || seen.has(option.key)) {
                return;
            }
            seen.add(option.key);
            candidates.push(option);
        };

        for (const container of subtitleListContainers()) {
            subtitleSectionNodes(container).forEach(addNode);
        }
        nativeMediaRows('subtitle').forEach(addNode);
        return candidates;
    }

    function collectNativeSubtitleOptions() {
        const options = nativeSubtitleCandidates()
            .map(option => ({ key: option.key, label: option.label, lang: option.lang, source: 'native-subtitle' }))
            .sort((a, b) => a.label.localeCompare(b.label));
        if (options.length) {
            state.nativeOptions = options;
            saveOptionCache();
            state.selectorSignature = '';
            renderSelector();
        }
        return mergedNativeOptions();
    }

    function collectNativeAudioOptions() {
        const options = nativeAudioCandidates()
            .map(option => ({ key: option.key, label: option.label, lang: option.lang, source: 'native-audio' }))
            .sort((a, b) => a.label.localeCompare(b.label));
        state.nativeAudioOptions = options;
        saveOptionCache();
        state.selectorSignature = '';
        renderSelector();
        return mergedAudioOptions();
    }

    async function refreshNativeOptions(openMenu = false) {
        wakeNetflixControls();
        let options = mergedNativeOptions();
        if (!openMenu) {
            notify(options.length || mergedAudioOptions().length ? 'Found ' + mergedAudioOptions().length + ' audio and ' + options.length + ' subtitle option(s)' : 'Waiting for Netflix audio/subtitle manifest');
            return options;
        }
        if (state.nativeScanInProgress) {
            return options;
        }
        if (!state.nativeOptions.length || !state.nativeAudioOptions.length) {
            state.nativeScanInProgress = true;
            state.nativeScanAttempted = true;
            state.selectorSignature = '';
            renderSelector();
            try {
                const button = findNetflixSubtitleButton();
                if (button) {
                    clickNativeElement(button);
                    await waitForNativeMediaRows('audio');
                    await waitForNativeMediaRows('subtitle');
                    if (nativeAudioCandidates().length) {
                        collectNativeAudioOptions();
                    }
                    if (nativeSubtitleCandidates().length) {
                        collectNativeSubtitleOptions();
                    }
                }
            } finally {
                state.nativeScanInProgress = false;
                state.selectorSignature = '';
                renderSelector();
            }
        }
        options = mergedNativeOptions();
        const audioOptions = mergedAudioOptions();
        notify(options.length || audioOptions.length ? 'Found ' + audioOptions.length + ' audio and ' + options.length + ' subtitle option(s)' : 'No Netflix audio/subtitle options found');
        return options;
    }

    async function ensureNativeSubtitleMenuOpen() {
        wakeNetflixControls();
        if (subtitleListContainers().length) {
            return true;
        }
        const button = findNetflixSubtitleButton();
        if (!button) {
            return false;
        }
        clickNativeElement(button);
        return await waitForNativeMediaRows('subtitle');
    }

    async function ensureNativeAudioMenuOpen() {
        wakeNetflixControls();
        if (audioListContainers().length) {
            return true;
        }
        const button = findNetflixSubtitleButton();
        if (!button) {
            return false;
        }
        clickNativeElement(button);
        return await waitForNativeMediaRows('audio');
    }

    function findNativeSubtitleOptionElement(option) {
        if (!option) {
            return null;
        }
        const candidates = nativeSubtitleCandidates();
        const optionIdentity = optionLabelIdentity(option.label);
        const exact = candidates.find(item => item.key === option.key || optionLabelIdentity(item.label) === optionIdentity);
        if (exact) {
            return exact.element;
        }

        const targetLang = option.lang || langFromNativeLabel(option.label);
        const sameLang = targetLang ? candidates
            .map(item => ({ item, score: languageMatchScore(item.lang, targetLang) }))
            .filter(entry => Number.isFinite(entry.score))
            .sort((a, b) => a.score - b.score || subtitleVariantScore(a.item) - subtitleVariantScore(b.item))
            .map(entry => entry.item) : [];
        if (sameLang.length === 1) {
            return sameLang[0].element;
        }

        const wantsCc = isCcSubtitleLabel(option.label);
        const ccMatches = sameLang.filter(item => isCcSubtitleLabel(item.label));
        const nonCc = sameLang.filter(item => !isCcSubtitleLabel(item.label));
        if (wantsCc) {
            const bestCc = singleBestSubtitleVariant(ccMatches);
            if (bestCc) {
                return bestCc.element;
            }
        }
        if (!wantsCc) {
            const bestNonCc = singleBestSubtitleVariant(nonCc);
            if (bestNonCc) {
                return bestNonCc.element;
            }
        }

        const optionBaseIdentity = subtitleBaseLabelIdentity(option.label);
        const sameBase = sameLang.filter(item => subtitleBaseLabelIdentity(item.label) === optionBaseIdentity);
        if (sameBase.length === 1) {
            return sameBase[0].element;
        }
        const sameBaseByCc = sameBase.filter(item => isCcSubtitleLabel(item.label) === wantsCc);
        if (sameBaseByCc.length === 1) {
            return sameBaseByCc[0].element;
        }

        return null;
    }

    function nativeAudioCandidates() {
        const candidates = [];
        const seen = new Set();
        const addNode = node => {
            const option = nativeOptionFromNode(node, 'audio');
            if (!option || seen.has(option.key)) {
                return;
            }
            seen.add(option.key);
            candidates.push(option);
        };

        for (const container of audioListContainers()) {
            audioSectionNodes(container).forEach(addNode);
        }
        nativeMediaRows('audio').forEach(addNode);
        return candidates;
    }

    function findNativeAudioOptionElement(option) {
        if (!option) {
            return null;
        }
        const candidates = nativeAudioCandidates();
        const optionIdentity = audioLabelIdentity(option.label);
        const exact = candidates.find(item => item.key === option.key || audioLabelIdentity(item.label) === optionIdentity);
        if (exact) {
            return exact.element;
        }

        const targetLang = option.lang || langFromNativeLabel(option.label);
        const sameLang = targetLang ? candidates
            .map(item => ({ item, score: languageMatchScore(item.lang, targetLang) }))
            .filter(entry => Number.isFinite(entry.score))
            .sort((a, b) => a.score - b.score || audioLabelIdentity(a.item.label).localeCompare(audioLabelIdentity(b.item.label)))
            .map(entry => entry.item) : [];
        if (sameLang.length === 1) {
            return sameLang[0].element;
        }

        if (sameLang.length > 1 && !isAudioDescriptionLabel(option.label)) {
            const regularAudio = sameLang.filter(item => !isAudioDescriptionLabel(item.label));
            if (regularAudio.length === 1) {
                return regularAudio[0].element;
            }
            const regularByIdentity = regularAudio.find(item => audioLabelIdentity(item.label) === optionIdentity);
            if (regularByIdentity) {
                return regularByIdentity.element;
            }
        }

        return null;
    }

    async function selectOfficialAudio(optionKey) {
        let option = mergedAudioOptions().find(item => item.key === optionKey);
        if (!option) {
            await refreshNativeOptions(true);
            option = mergedAudioOptions().find(item => item.key === optionKey);
        }
        if (!option) {
            notify('Netflix audio option not found');
            return false;
        }

        if (!await ensureNativeAudioMenuOpen()) {
            notify('Netflix audio menu did not open');
            return false;
        }
        await waitForNativeMediaRows('audio');
        collectNativeAudioOptions();
        const element = await waitForNativeMediaOptionElement('audio', option);
        if (!element) {
            notify('Audio option not available in Netflix menu: ' + option.label);
            return false;
        }
        try {
            element.scrollIntoView({ block: 'center', inline: 'nearest' });
        } catch (_) {}
        await sleep(60);
        await clickNativeMediaElement(element);
        state.selectedAudioKey = option.key;
        if (!state.preferenceApplyInProgress) {
            updateLanguagePreference(target => {
                target.audio = preferenceIdentityForAudio(option);
            });
        }
        state.selectorSignature = '';
        renderSelector();
        notify('Selected Netflix audio: ' + option.label);
        return true;
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
        if (!state.preferenceApplyInProgress) {
            updateLanguagePreference(target => {
                target[slot] = preferenceIdentityForSubtitle(option);
            });
        }

        if (await fetchOfficialSubtitleForSlot(slot, option)) {
            return true;
        }

        state.manualDisplay = true;
        state.preferenceAppliedDisplay = !!state.preferenceApplyInProgress;
        state.pendingSlotValues[slot] = 'official:' + option.key;
        if (option.lang) {
            state.pendingSlots[option.key] = slot;
            state.pendingSlots[option.lang] = slot;
        }
        state.pendingCaptureSlot = slot;
        state.selectorSignature = '';
        renderSelector();

        if (!await ensureNativeSubtitleMenuOpen()) {
            clearPendingSubtitleSlot(slot, option);
            renderSelector();
            notify('Netflix subtitle menu did not open');
            return false;
        }
        await waitForNativeMediaRows('subtitle');
        collectNativeSubtitleOptions();
        const element = await waitForNativeMediaOptionElement('subtitle', option);
        if (!element) {
            clearPendingSubtitleSlot(slot, option);
            renderSelector();
            notify('Subtitle option not available in Netflix menu: ' + option.label);
            return false;
        }
        try {
            element.scrollIntoView({ block: 'center', inline: 'nearest' });
        } catch (_) {}
        await sleep(60);
        await clickNativeMediaElement(element);
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
        clearSubtitleOverlay();
        state.manualDisplay = false;
        state.preferenceAppliedDisplay = false;
        state.nativeOptions = [];
        state.manifestOptions = [];
        state.nativeAudioOptions = [];
        state.manifestAudioOptions = [];
        state.selectedAudioKey = '';
        state.nativeScanInProgress = false;
        state.nativeScanAttempted = false;
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
        if (loadOptionCache()) {
            state.status = 'loaded cached Netflix audio/subtitle languages';
        }
        if (!initial) {
            state.status = 'new video detected; loading audio/subtitle tracks from manifest';
            notify(state.status);
        }
        render();
        scheduleApplyLanguagePreferences();
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

        GM_registerMenuCommand('Netflix Dual Subtitles: Switch main/secondary', () => swapDisplaySubtitleSlots());
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
        observeNetflixControlVisibility();
        cacheVisibleNativeOptions();
        if (document.body) {
            createOverlay();
        }
        render();
        scheduleApplyLanguagePreferences();
    }

    function init() {
        window.addEventListener(BRIDGE_EVENT, event => rememberPayload(event.detail.url, event.detail.payload, event.detail.videoId));
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
        document.addEventListener('pointerdown', handleSelectorOutsidePointer, true);
        document.addEventListener('keydown', handleSelectorKeydown, true);
        ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach(eventName => {
            document.addEventListener(eventName, ensureRuntimeReady);
        });
        setInterval(ensureRuntimeReady, 1500);
        setInterval(keepNetflixControlsVisible, 150);
        setInterval(render, RENDER_INTERVAL_MS);
    }

    init();
})();
