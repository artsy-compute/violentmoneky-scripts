// ==UserScript==
// @name         YouTube Hot or Not
// @namespace    http://tampermonkey.net/
// @version      0.3.1
// @description  Compare watched YouTube videos and learn local interestingness preferences.
// @author       artsy-compute
// @license      MIT
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// ==/UserScript==

(function() {
    'use strict';

    const STORE_KEY = 'youtube-hot-or-not:v1';
    const RECORD_AFTER_SECONDS = 5;
    const MAX_HISTORY = 500;
    const MAX_VOTES = 1000;
    const MAX_EXPLORE = 300;
    const EXPLORE_REFRESH_MS = 6 * 60 * 60 * 1000;
    const ROOT_ID = 'yhon-root';

    const state = {
        data: {
            videos: {},
            exploreVideos: {},
            exploreFetchedAt: 0,
            votes: [],
            profile: { tokens: {}, channels: {} },
            recentPairs: []
        },
        root: null,
        button: null,
        overlay: null,
        open: false,
        pair: null,
        currentVideoId: '',
        currentVideoRecorded: false,
        videoListenersAttachedTo: null,
        historyPatched: false,
        exploreLoading: false
    };

    const WILD_TOPICS = [
        'world news analysis',
        'politics debate explained',
        'science documentary',
        'space exploration',
        'stand up comedy',
        'street food travel',
        'history documentary',
        'technology review',
        'film analysis',
        'classical music performance',
        'jazz live session',
        'sports highlights',
        'philosophy lecture',
        'economics explained',
        'art restoration',
        'wildlife documentary'
    ];

    const STOP_WORDS = new Set([
        'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'with',
        'official', 'video', 'youtube', 'shorts', 'short', 'clip', 'clips', 'full', 'hd', 'new', 'live', 'episode', 'part', 'trailer', 'music'
    ]);

    function gmAvailable(name) {
        try {
            if (typeof globalThis[name] === 'function') {
                return true;
            }
            if (name === 'GM_getValue') {
                return typeof GM_getValue === 'function';
            }
            if (name === 'GM_setValue') {
                return typeof GM_setValue === 'function';
            }
            if (name === 'GM_deleteValue') {
                return typeof GM_deleteValue === 'function';
            }
            if (name === 'GM_addStyle') {
                return typeof GM_addStyle === 'function';
            }
        } catch (_) {}
        return false;
    }

    async function storeGet(key, fallback) {
        try {
            if (gmAvailable('GM_getValue')) {
                return await Promise.resolve(GM_getValue(key, fallback));
            }
        } catch (_) {}
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (_) {
            return fallback;
        }
    }

    async function storeSet(key, value) {
        try {
            if (gmAvailable('GM_setValue')) {
                await Promise.resolve(GM_setValue(key, value));
                return;
            }
        } catch (_) {}
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (_) {}
    }

    async function storeDelete(key) {
        try {
            if (gmAvailable('GM_deleteValue')) {
                await Promise.resolve(GM_deleteValue(key));
                return;
            }
        } catch (_) {}
        try {
            localStorage.removeItem(key);
        } catch (_) {}
    }

    function normalizeText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function cleanTitle(value) {
        return normalizeText(String(value || '').replace(/\s+-\s+YouTube\s*$/i, ''));
    }

    function isValidYouTubeVideoId(value) {
        return /^[A-Za-z0-9_-]{11}$/.test(String(value || ''));
    }

    function canonicalVideoUrl(id) {
        return 'https://www.youtube.com/watch?v=' + encodeURIComponent(id);
    }

    function canonicalThumbnailUrl(id) {
        return 'https://i.ytimg.com/vi/' + encodeURIComponent(id) + '/hqdefault.jpg';
    }

    function extractVideoIdFromUrl(url) {
        try {
            const parsed = new URL(url, location.href);
            const watchId = parsed.searchParams.get('v');
            if (isValidYouTubeVideoId(watchId)) {
                return watchId;
            }
            const match = parsed.pathname.match(/\/(?:shorts|embed|live)\/([^/?#]+)/);
            return match && isValidYouTubeVideoId(match[1]) ? match[1] : '';
        } catch (_) {
            return '';
        }
    }

    function currentVideoId() {
        return extractVideoIdFromUrl(location.href);
    }

    function getCurrentVideoElement() {
        const videos = Array.from(document.querySelectorAll('video'));
        return videos.find(video => video.readyState > 0 && !video.paused) || videos[0] || null;
    }

    function currentTitleNode() {
        return document.querySelector('ytd-watch-metadata h1 yt-formatted-string') ||
            document.querySelector('h1.ytd-watch-metadata') ||
            document.querySelector('h1.title') ||
            document.querySelector('h1');
    }

    function currentChannelNode() {
        return document.querySelector('ytd-watch-metadata ytd-channel-name a') ||
            document.querySelector('#owner ytd-channel-name a') ||
            document.querySelector('#channel-name a') ||
            document.querySelector('ytd-video-owner-renderer a');
    }

    function currentVideoMeta() {
        const id = currentVideoId();
        if (!id) {
            return null;
        }
        const titleNode = currentTitleNode();
        const channelNode = currentChannelNode();
        const title = cleanTitle(titleNode ? titleNode.textContent : document.title) || id;
        const channel = normalizeText(channelNode ? channelNode.textContent : '');
        const channelUrl = channelNode && channelNode.href ? channelNode.href : '';
        return {
            id,
            title,
            channel,
            channelUrl,
            thumbnail: canonicalThumbnailUrl(id),
            url: canonicalVideoUrl(id),
            tokens: tokenize(title + ' ' + channel)
        };
    }

    function tokenize(value) {
        const matches = String(value || '').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];
        return Array.from(new Set(matches.filter(token => !STOP_WORDS.has(token)).slice(0, 24)));
    }

    function ensureDataShape(data) {
        const shaped = data && typeof data === 'object' ? data : {};
        const normalizeVideoMap = rawMap => {
            const result = {};
            Object.values(rawMap && typeof rawMap === 'object' ? rawMap : {}).forEach(video => {
                const id = video && isValidYouTubeVideoId(video.id) ? String(video.id) : extractVideoIdFromUrl(video && video.url || '');
                if (!id) {
                    return;
                }
                const title = cleanTitle(video.title || id) || id;
                result[id] = {
                    ...video,
                    id,
                    title,
                    thumbnail: canonicalThumbnailUrl(id),
                    url: canonicalVideoUrl(id),
                    tokens: Array.isArray(video.tokens) && video.tokens.length ? video.tokens : tokenize(title + ' ' + (video.channel || ''))
                };
            });
            return result;
        };
        shaped.videos = normalizeVideoMap(shaped.videos);
        shaped.exploreVideos = normalizeVideoMap(shaped.exploreVideos);
        shaped.exploreFetchedAt = Number(shaped.exploreFetchedAt || 0);
        shaped.votes = Array.isArray(shaped.votes) ? shaped.votes.filter(vote => isValidYouTubeVideoId(vote && vote.winnerId) && isValidYouTubeVideoId(vote && vote.loserId)) : [];
        shaped.profile = shaped.profile && typeof shaped.profile === 'object' ? shaped.profile : {};
        shaped.profile.tokens = shaped.profile.tokens && typeof shaped.profile.tokens === 'object' ? shaped.profile.tokens : {};
        shaped.profile.channels = shaped.profile.channels && typeof shaped.profile.channels === 'object' ? shaped.profile.channels : {};
        shaped.recentPairs = Array.isArray(shaped.recentPairs) ? shaped.recentPairs.filter(pair => Array.isArray(pair) && pair.every(isValidYouTubeVideoId)) : [];
        return shaped;
    }

    function watchedVideos() {
        return Object.values(state.data.videos)
            .filter(video => video && isValidYouTubeVideoId(video.id) && video.title)
            .sort((a, b) => (b.lastWatchedAt || 0) - (a.lastWatchedAt || 0));
    }

    function explorationVideos() {
        return Object.values(state.data.exploreVideos || {})
            .filter(video => video && isValidYouTubeVideoId(video.id) && video.title);
    }

    function candidateVideos() {
        return watchedVideos();
    }

    function broadCandidateVideos() {
        const merged = new Map();
        explorationVideos().forEach(video => merged.set(video.id, video));
        watchedVideos().forEach(video => merged.set(video.id, video));
        return Array.from(merged.values());
    }

    async function saveData() {
        const videos = Object.values(state.data.videos)
            .filter(video => video && isValidYouTubeVideoId(video.id))
            .map(video => ({ ...video, url: canonicalVideoUrl(video.id), thumbnail: canonicalThumbnailUrl(video.id) }))
            .sort((a, b) => (b.lastWatchedAt || 0) - (a.lastWatchedAt || 0))
            .slice(0, MAX_HISTORY);
        const exploreVideos = Object.values(state.data.exploreVideos || {})
            .filter(video => video && isValidYouTubeVideoId(video.id))
            .map(video => ({ ...video, url: canonicalVideoUrl(video.id), thumbnail: canonicalThumbnailUrl(video.id) }))
            .sort((a, b) => (b.discoveredAt || 0) - (a.discoveredAt || 0))
            .slice(0, MAX_EXPLORE);
        state.data.videos = Object.fromEntries(videos.map(video => [video.id, video]));
        state.data.exploreVideos = Object.fromEntries(exploreVideos.map(video => [video.id, video]));
        state.data.votes = state.data.votes.slice(-MAX_VOTES);
        await storeSet(STORE_KEY, state.data);
    }

    async function recordCurrentVideo(reason = 'play') {
        const meta = currentVideoMeta();
        if (!meta) {
            return false;
        }
        const now = Date.now();
        const previous = state.data.videos[meta.id] || {};
        const next = {
            ...previous,
            ...meta,
            firstSeenAt: previous.firstSeenAt || now,
            lastWatchedAt: now,
            watchCount: (previous.watchCount || 0) + (state.currentVideoRecorded ? 0 : 1),
            source: reason
        };
        state.data.videos[meta.id] = next;
        state.currentVideoRecorded = true;
        await saveData();
        render();
        return true;
    }

    function resetCurrentVideoTracking() {
        const nextId = currentVideoId();
        if (nextId !== state.currentVideoId) {
            state.currentVideoId = nextId;
            state.currentVideoRecorded = false;
            state.pair = null;
            attachVideoListeners();
            render();
        }
    }

    function maybeRecordFromPlayback() {
        const video = getCurrentVideoElement();
        if (!video || state.currentVideoRecorded || !currentVideoId()) {
            return;
        }
        if (!video.paused && video.currentTime >= RECORD_AFTER_SECONDS) {
            recordCurrentVideo('played');
        }
    }

    function attachVideoListeners() {
        const video = getCurrentVideoElement();
        if (!video || video === state.videoListenersAttachedTo) {
            return;
        }
        state.videoListenersAttachedTo = video;
        video.addEventListener('timeupdate', maybeRecordFromPlayback, { passive: true });
        video.addEventListener('play', () => setTimeout(maybeRecordFromPlayback, RECORD_AFTER_SECONDS * 1000 + 100), { passive: true });
    }

    function shuffle(items) {
        const copy = items.slice();
        for (let index = copy.length - 1; index > 0; index -= 1) {
            const other = Math.floor(Math.random() * (index + 1));
            [copy[index], copy[other]] = [copy[other], copy[index]];
        }
        return copy;
    }

    function textFromRuns(value) {
        if (!value) {
            return '';
        }
        if (typeof value.simpleText === 'string') {
            return normalizeText(value.simpleText);
        }
        if (Array.isArray(value.runs)) {
            return normalizeText(value.runs.map(run => run && run.text || '').join(''));
        }
        return '';
    }

    function extractBalancedJson(text, start) {
        let depth = 0;
        let inString = false;
        let quote = '';
        let escaped = false;
        for (let index = start; index < text.length; index += 1) {
            const char = text[index];
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (char === '\\') {
                    escaped = true;
                } else if (char === quote) {
                    inString = false;
                }
                continue;
            }
            if (char === '"' || char === "'") {
                inString = true;
                quote = char;
                continue;
            }
            if (char === '{') {
                depth += 1;
            } else if (char === '}') {
                depth -= 1;
                if (depth === 0) {
                    return text.slice(start, index + 1);
                }
            }
        }
        return '';
    }

    function extractYtInitialData(html) {
        const marker = 'ytInitialData';
        const markerIndex = String(html || '').indexOf(marker);
        if (markerIndex === -1) {
            return null;
        }
        const start = html.indexOf('{', markerIndex);
        if (start === -1) {
            return null;
        }
        const json = extractBalancedJson(html, start);
        if (!json) {
            return null;
        }
        try {
            return JSON.parse(json);
        } catch (_) {
            return null;
        }
    }

    function extractVideosFromYtData(data, topic) {
        const found = new Map();
        const stack = [data];
        let inspected = 0;
        while (stack.length && inspected < 50000) {
            const item = stack.pop();
            inspected += 1;
            if (!item || typeof item !== 'object') {
                continue;
            }
            if (Array.isArray(item)) {
                item.forEach(value => stack.push(value));
                continue;
            }
            if (item.videoRenderer && item.videoRenderer.videoId) {
                const renderer = item.videoRenderer;
                const id = renderer.videoId;
                if (isValidYouTubeVideoId(id) && !found.has(id)) {
                    const title = cleanTitle(textFromRuns(renderer.title) || id);
                    const channel = textFromRuns(renderer.ownerText || renderer.longBylineText || renderer.shortBylineText);
                    found.set(id, {
                        id,
                        title,
                        channel,
                        channelUrl: '',
                        thumbnail: canonicalThumbnailUrl(id),
                        url: canonicalVideoUrl(id),
                        tokens: tokenize(title + ' ' + channel + ' ' + topic),
                        source: 'explore:' + topic,
                        discoveredAt: Date.now()
                    });
                }
            }
            Object.values(item).forEach(value => {
                if (value && typeof value === 'object') {
                    stack.push(value);
                }
            });
        }
        return Array.from(found.values());
    }

    async function fetchExploreTopic(topic) {
        const url = '/results?search_query=' + encodeURIComponent(topic) + '&sp=EgIQAQ%253D%253D';
        const response = await fetch(url, { credentials: 'same-origin' });
        if (!response.ok) {
            return [];
        }
        const html = await response.text();
        return extractVideosFromYtData(extractYtInitialData(html), topic);
    }

    async function ensureExplorationPool(force = false) {
        if (state.exploreLoading) {
            return false;
        }
        const currentCount = explorationVideos().length;
        const stale = Date.now() - Number(state.data.exploreFetchedAt || 0) > EXPLORE_REFRESH_MS;
        if (!force && currentCount >= 40 && !stale) {
            return false;
        }
        state.exploreLoading = true;
        render();
        try {
            const topics = shuffle(WILD_TOPICS).slice(0, currentCount < 10 ? 6 : 3);
            let added = 0;
            for (const topic of topics) {
                try {
                    const videos = await fetchExploreTopic(topic);
                    videos.slice(0, 12).forEach(video => {
                        if (!state.data.videos[video.id] && !state.data.exploreVideos[video.id]) {
                            state.data.exploreVideos[video.id] = video;
                            added += 1;
                        }
                    });
                } catch (_) {}
            }
            state.data.exploreFetchedAt = Date.now();
            if (added) {
                state.pair = null;
            }
            await saveData();
            if (state.open && !state.pair) {
                createPair();
            }
            render();
            return added > 0;
        } finally {
            state.exploreLoading = false;
            render();
        }
    }

    function scoreVideo(video) {
        if (!video) {
            return Number.NEGATIVE_INFINITY;
        }
        let score = 0;
        const channelKey = video.channel || '';
        if (channelKey && state.data.profile.channels[channelKey]) {
            score += state.data.profile.channels[channelKey] * 3;
        }
        (video.tokens || []).forEach(token => {
            score += state.data.profile.tokens[token] || 0;
        });
        score += Math.min(2, Math.log1p(video.watchCount || 0) / 4);
        return score;
    }

    function randomItem(items) {
        if (!items.length) {
            return null;
        }
        return items[Math.floor(Math.random() * items.length)];
    }

    function randomCandidate(exclude = new Set()) {
        return randomItem(broadCandidateVideos().filter(video => !exclude.has(video.id)));
    }

    function recommendedCandidate(exclude = new Set()) {
        const videos = broadCandidateVideos().filter(video => !exclude.has(video.id));
        if (!videos.length) {
            return null;
        }
        const hasPreference = state.data.votes.length > 0 && (
            Object.values(state.data.profile.tokens).some(value => value > 0) ||
            Object.values(state.data.profile.channels).some(value => value > 0)
        );
        if (!hasPreference) {
            return randomItem(videos);
        }
        const ranked = videos
            .map(video => ({ video, score: scoreVideo(video) + Math.random() * 0.15 }))
            .sort((a, b) => b.score - a.score);
        return ranked[0] ? ranked[0].video : randomItem(videos);
    }

    function addChoice(choices, exclude, video, kind) {
        if (!video || !isValidYouTubeVideoId(video.id) || exclude.has(video.id)) {
            return false;
        }
        choices.push({ video, kind });
        exclude.add(video.id);
        return true;
    }

    function createPair() {
        const videos = broadCandidateVideos();
        if (videos.length < 4) {
            state.pair = null;
            return null;
        }
        const exclude = new Set([currentVideoId()].filter(Boolean));
        const choices = [];
        if (state.data.votes.length) {
            addChoice(choices, exclude, recommendedCandidate(exclude), 'Based on your picks');
        }
        while (choices.length < 4) {
            if (!addChoice(choices, exclude, randomCandidate(exclude), 'Random')) {
                break;
            }
        }
        if (choices.length < 4) {
            state.pair = null;
            return null;
        }
        state.pair = { choices: shuffle(choices) };
        return state.pair;
    }

    function adjustScore(map, key, delta) {
        if (!key) {
            return;
        }
        map[key] = Math.max(-50, Math.min(100, (map[key] || 0) + delta));
        if (Math.abs(map[key]) < 0.01) {
            delete map[key];
        }
    }

    function learnFromChoice(winner, loser) {
        adjustScore(state.data.profile.channels, winner.channel || '', 3);
        adjustScore(state.data.profile.channels, loser.channel || '', -1);
        (winner.tokens || []).forEach(token => adjustScore(state.data.profile.tokens, token, 2));
        (loser.tokens || []).forEach(token => adjustScore(state.data.profile.tokens, token, -0.6));
    }

    async function choose(value) {
        if (!state.pair || !Array.isArray(state.pair.choices)) {
            return;
        }
        const match = String(value || '').match(/^pick:(\d+)$/);
        const index = match ? Number(match[1]) : NaN;
        const winnerChoice = Number.isFinite(index) ? state.pair.choices[index] : null;
        const winner = winnerChoice && winnerChoice.video;
        const losers = state.pair.choices.map(choice => choice.video).filter(video => video && winner && video.id !== winner.id);
        if (!winner || losers.length < 1) {
            return;
        }
        if (!state.data.videos[winner.id] && state.data.exploreVideos && state.data.exploreVideos[winner.id]) {
            state.data.videos[winner.id] = {
                ...winner,
                firstSeenAt: Date.now(),
                lastWatchedAt: Date.now(),
                watchCount: 0,
                source: 'liked-exploration'
            };
        }
        losers.forEach(loser => {
            state.data.votes.push({ winnerId: winner.id, loserId: loser.id, ts: Date.now() });
            learnFromChoice(winner, loser);
            state.data.recentPairs.push([winner.id, loser.id]);
        });
        state.data.recentPairs = state.data.recentPairs.slice(-30);
        state.pair = null;
        await saveData();
        createPair();
        render();
    }

    function openOverlay() {
        state.open = true;
        ensureExplorationPool();
        if (!state.pair) {
            createPair();
        }
        render();
    }

    function closeOverlay() {
        state.open = false;
        render();
    }

    async function resetAll() {
        state.data = { videos: {}, exploreVideos: {}, exploreFetchedAt: 0, votes: [], profile: { tokens: {}, channels: {} }, recentPairs: [] };
        state.pair = null;
        state.currentVideoRecorded = false;
        await storeDelete(STORE_KEY);
        render();
    }

    function topEntries(map, count = 5) {
        return Object.entries(map || {})
            .filter(([, value]) => value > 0)
            .sort((a, b) => b[1] - a[1])
            .slice(0, count)
            .map(([key]) => key);
    }

    function videoCard(video, action, kind) {
        if (!video || !isValidYouTubeVideoId(video.id)) {
            return emptyState();
        }
        const article = document.createElement('article');
        article.className = 'yhon-card';

        const tag = document.createElement('div');
        tag.className = 'yhon-card-tag';
        tag.textContent = kind;
        article.appendChild(tag);

        const preview = document.createElement('button');
        preview.type = 'button';
        preview.className = 'yhon-preview';
        preview.dataset.action = 'play-preview';
        preview.dataset.videoId = video.id;
        preview.dataset.title = video.title;
        preview.title = 'Watch on YouTube';

        const image = document.createElement('img');
        image.src = video.thumbnail || canonicalThumbnailUrl(video.id);
        image.alt = video.title;
        image.loading = 'lazy';
        image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', () => {
            image.src = 'https://img.youtube.com/vi/' + encodeURIComponent(video.id) + '/mqdefault.jpg';
        }, { once: true });
        preview.appendChild(image);

        const play = document.createElement('span');
        play.className = 'yhon-play';
        play.textContent = 'Watch';
        preview.appendChild(play);
        article.appendChild(preview);

        const title = document.createElement('a');
        title.className = 'yhon-title';
        title.href = canonicalVideoUrl(video.id);
        title.target = '_blank';
        title.rel = 'noreferrer';
        title.textContent = video.title;
        article.appendChild(title);

        const meta = document.createElement('div');
        meta.className = 'yhon-meta';
        meta.textContent = [video.channel || 'Unknown channel', 'watched ' + (video.watchCount || 1) + 'x'].join(' · ');
        article.appendChild(meta);

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'yhon-pick';
        button.dataset.action = action;
        button.textContent = 'This is more interesting';
        article.appendChild(button);

        return article;
    }

    function emptyState() {
        const wrap = document.createElement('div');
        wrap.className = 'yhon-empty';
        const title = document.createElement('h2');
        title.textContent = 'Need at least four videos';
        const body = document.createElement('p');
        body.textContent = state.exploreLoading ?
            'Loading broad random videos from YouTube search topics. You can also play videos for 5 seconds to add personal seeds.' :
            'Play videos for 5 seconds to add personal seeds. The random side can also use broad exploration videos from YouTube search topics.';
        const count = document.createElement('div');
        count.className = 'yhon-empty-count';
        count.textContent = 'Seed videos recorded: ' + candidateVideos().length + ' · exploration videos: ' + explorationVideos().length;
        wrap.appendChild(title);
        wrap.appendChild(body);
        wrap.appendChild(count);
        return wrap;
    }

    function loadPreviewPlayer(button) {
        const id = button && button.dataset ? button.dataset.videoId : '';
        if (!isValidYouTubeVideoId(id)) {
            return false;
        }
        location.href = canonicalVideoUrl(id);
        return true;
    }

    function renderOverlay() {
        if (!state.overlay) {
            return;
        }
        state.overlay.classList.toggle('is-open', state.open);
        state.overlay.textContent = '';
        if (!state.open) {
            return;
        }

        const header = document.createElement('div');
        header.className = 'yhon-header';
        const title = document.createElement('div');
        title.className = 'yhon-heading';
        title.textContent = 'YouTube Hot or Not';
        const controls = document.createElement('div');
        controls.className = 'yhon-controls';
        const skip = document.createElement('button');
        skip.type = 'button';
        skip.dataset.action = 'skip';
        skip.textContent = 'Skip';
        const reset = document.createElement('button');
        reset.type = 'button';
        reset.dataset.action = 'reset';
        reset.textContent = 'Reset';
        const close = document.createElement('button');
        close.type = 'button';
        close.dataset.action = 'close';
        close.textContent = 'Close';
        controls.appendChild(skip);
        controls.appendChild(reset);
        controls.appendChild(close);
        header.appendChild(title);
        header.appendChild(controls);
        state.overlay.appendChild(header);

        const stats = document.createElement('div');
        stats.className = 'yhon-stats';
        const topics = topEntries(state.data.profile.tokens).join(', ') || 'none yet';
        const channels = topEntries(state.data.profile.channels, 3).join(', ') || 'none yet';
        stats.textContent = candidateVideos().length + ' seed videos · ' + explorationVideos().length + ' exploration videos' + (state.exploreLoading ? ' loading...' : '') + ' · ' + state.data.votes.length + ' votes · topics: ' + topics + ' · channels: ' + channels;
        state.overlay.appendChild(stats);

        const pair = state.pair || createPair();
        if (!pair || !Array.isArray(pair.choices) || pair.choices.length < 4) {
            state.overlay.appendChild(emptyState());
            return;
        }

        const grid = document.createElement('div');
        grid.className = 'yhon-grid';
        pair.choices.forEach((choice, index) => {
            grid.appendChild(videoCard(choice.video, 'pick:' + index, choice.kind));
        });
        state.overlay.appendChild(grid);
    }

    function render() {
        if (!state.root) {
            return;
        }
        const seedCount = candidateVideos().length;
        const totalCount = broadCandidateVideos().length;
        state.button.textContent = 'Hot? ' + seedCount;
        state.button.title = totalCount < 2 ? 'Play videos or wait for exploration videos to load' : 'Open YouTube Hot or Not';
        state.button.classList.toggle('is-loading', state.exploreLoading);
        renderOverlay();
    }

    function addStyles() {
        const css = `
            #${ROOT_ID} { position: fixed; z-index: 2147483647; font-family: Roboto, Arial, sans-serif; color: #fff; }
            #${ROOT_ID} .yhon-launch { position: fixed; right: 20px; bottom: 84px; min-width: 68px; height: 38px; border: 1px solid rgba(255,255,255,.24); border-radius: 19px; background: rgba(15,15,15,.88); color: #fff; font: 700 13px/1 Roboto, Arial, sans-serif; cursor: pointer; box-shadow: 0 8px 22px rgba(0,0,0,.35); }
            #${ROOT_ID} .yhon-launch:hover { background: #cc0000; }
            #${ROOT_ID} .yhon-launch.is-loading { opacity: .72; }
            #${ROOT_ID} .yhon-overlay { position: fixed; inset: 5vh 4vw; display: none; grid-template-rows: auto auto minmax(0, 1fr); gap: 12px; padding: 14px; border-radius: 8px; background: rgba(15,15,15,.96); box-shadow: 0 18px 60px rgba(0,0,0,.65); pointer-events: auto; }
            #${ROOT_ID} .yhon-overlay.is-open { display: grid; }
            #${ROOT_ID} .yhon-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
            #${ROOT_ID} .yhon-heading { font-size: 20px; font-weight: 800; }
            #${ROOT_ID} .yhon-controls { display: flex; gap: 8px; }
            #${ROOT_ID} button { border: 1px solid rgba(255,255,255,.24); border-radius: 4px; background: rgba(255,255,255,.09); color: #fff; cursor: pointer; }
            #${ROOT_ID} .yhon-controls button { height: 32px; padding: 0 12px; }
            #${ROOT_ID} button:hover { background: rgba(255,255,255,.18); }
            #${ROOT_ID} .yhon-stats { min-height: 18px; color: #bbb; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            #${ROOT_ID} .yhon-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-rows: repeat(2, minmax(0, 1fr)); gap: 12px; min-height: 0; }
            #${ROOT_ID} .yhon-card { position: relative; display: grid; grid-template-rows: minmax(150px, 1fr) auto auto auto; gap: 8px; min-width: 0; min-height: 0; padding: 9px; border: 1px solid rgba(255,255,255,.16); border-radius: 6px; background: rgba(255,255,255,.055); }
            #${ROOT_ID} .yhon-card-tag { position: absolute; top: 18px; left: 18px; padding: 4px 7px; border-radius: 4px; background: rgba(0,0,0,.72); color: #ddd; font-size: 11px; font-weight: 700; z-index: 1; }
            #${ROOT_ID} iframe { width: 100%; height: 100%; min-height: 150px; border: 0; border-radius: 4px; background: #000; }
            #${ROOT_ID} .yhon-preview { position: relative; width: 100%; height: 100%; min-height: 150px; padding: 0; border: 0; border-radius: 4px; overflow: hidden; background: #000; cursor: pointer; }
            #${ROOT_ID} .yhon-preview img { display: block; width: 100%; height: 100%; object-fit: cover; }
            #${ROOT_ID} .yhon-preview::after { content: ''; position: absolute; inset: 0; background: linear-gradient(to bottom, rgba(0,0,0,.08), rgba(0,0,0,.34)); pointer-events: none; }
            #${ROOT_ID} .yhon-play { position: absolute; left: 50%; top: 50%; z-index: 1; transform: translate(-50%, -50%); min-width: 86px; height: 48px; padding: 0 18px; border-radius: 24px; display: inline-flex; align-items: center; justify-content: center; background: rgba(204,0,0,.92); color: #fff; font-size: 14px; font-weight: 900; box-shadow: 0 8px 24px rgba(0,0,0,.45); }
            #${ROOT_ID} .yhon-preview:hover .yhon-play { background: #e50914; }
            #${ROOT_ID} .yhon-title { color: #fff; font-size: 15px; font-weight: 700; line-height: 1.3; text-decoration: none; overflow-wrap: anywhere; }
            #${ROOT_ID} .yhon-title:hover { text-decoration: underline; }
            #${ROOT_ID} .yhon-meta { color: #aaa; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            #${ROOT_ID} .yhon-pick { height: 40px; background: #cc0000; border-color: rgba(255,255,255,.28); font-weight: 800; }
            #${ROOT_ID} .yhon-pick:hover { background: #e50914; }
            #${ROOT_ID} .yhon-empty { align-self: center; justify-self: center; max-width: 560px; text-align: center; color: #ddd; }
            #${ROOT_ID} .yhon-empty h2 { margin: 0 0 8px; color: #fff; font-size: 22px; }
            #${ROOT_ID} .yhon-empty p { margin: 0 0 12px; font-size: 14px; line-height: 1.45; }
            #${ROOT_ID} .yhon-empty-count { color: #aaa; font-size: 13px; }
            @media (max-width: 840px) {
                #${ROOT_ID} .yhon-overlay { inset: 3vh 3vw; }
                #${ROOT_ID} .yhon-grid { grid-template-columns: 1fr; overflow-y: auto; }
                #${ROOT_ID} .yhon-card { grid-template-rows: 220px auto auto auto; }
            }
        `;
        try {
            if (gmAvailable('GM_addStyle')) {
                GM_addStyle(css);
                return;
            }
        } catch (_) {}
        const style = document.createElement('style');
        style.textContent = css;
        document.documentElement.appendChild(style);
    }

    function createUi() {
        if (state.root || !document.body) {
            return false;
        }
        addStyles();
        const root = document.createElement('div');
        root.id = ROOT_ID;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'yhon-launch';
        button.addEventListener('click', openOverlay);

        const overlay = document.createElement('div');
        overlay.className = 'yhon-overlay';
        overlay.addEventListener('click', event => {
            const actionNode = event.target && event.target.closest ? event.target.closest('[data-action]') : null;
            const action = actionNode && actionNode.dataset ? actionNode.dataset.action : '';
            if (!action || !overlay.contains(actionNode)) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            if (/^pick:\d+$/.test(action)) {
                choose(action);
            } else if (action === 'play-preview') {
                loadPreviewPlayer(actionNode);
            } else if (action === 'skip') {
                state.pair = null;
                ensureExplorationPool();
                createPair();
                render();
            } else if (action === 'close') {
                closeOverlay();
            } else if (action === 'reset') {
                resetAll();
            }
        });

        root.appendChild(button);
        root.appendChild(overlay);
        document.body.appendChild(root);
        state.root = root;
        state.button = button;
        state.overlay = overlay;
        render();
        return true;
    }

    function patchHistory() {
        if (state.historyPatched) {
            return;
        }
        state.historyPatched = true;
        ['pushState', 'replaceState'].forEach(method => {
            const original = history[method];
            if (typeof original !== 'function') {
                return;
            }
            history[method] = function() {
                const result = original.apply(this, arguments);
                setTimeout(resetCurrentVideoTracking, 0);
                return result;
            };
        });
        window.addEventListener('popstate', () => setTimeout(resetCurrentVideoTracking, 0));
        window.addEventListener('yt-navigate-finish', () => setTimeout(resetCurrentVideoTracking, 0));
    }

    async function init() {
        state.data = ensureDataShape(await storeGet(STORE_KEY, state.data));
        await saveData();
        ensureExplorationPool();
        patchHistory();
        createUi();
        resetCurrentVideoTracking();
        attachVideoListeners();
        setInterval(() => {
            createUi();
            resetCurrentVideoTracking();
            attachVideoListeners();
            maybeRecordFromPlayback();
        }, 1000);
    }

    init();
})();
