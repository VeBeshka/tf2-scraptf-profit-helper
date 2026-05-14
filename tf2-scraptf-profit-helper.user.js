// ==UserScript==
// @name         TF2 ScrapTF Profit Helper
// @namespace    https://steamcommunity.com/profiles/76561198201055179
// @version      1.0
// @author       VeBeshka
// @description  Scrap.tf profit checker with Backpack.tf buy order comparison
// @icon         https://raw.githubusercontent.com/VeBeshka/tf2-scraptf-profit-helper/main/icon.png

// @match        https://scrap.tf/buy/hats*
// @match        https://scrap.tf/buy/items*
// @match        https://scrap.tf/buy/stranges*
// @match        https://scrap.tf/buy/skins*
// @match        https://scrap.tf/buy/killstreaks*
// @match        https://scrap.tf/unusuals/*

// @grant        GM_xmlhttpRequest
// @connect      backpack.tf

// @downloadURL  https://raw.githubusercontent.com/VeBeshka/tf2-scraptf-profit-helper/main/tf2-scraptf-profit-helper.user.js
// @updateURL    https://raw.githubusercontent.com/VeBeshka/tf2-scraptf-profit-helper/main/tf2-scraptf-profit-helper.user.js
// ==/UserScript==

(function () {
    'use strict';

    const KEY_PRICE = 54.49;
    const CHECKED_CLASS = 'vbp-initialized';
    const CACHE_KEY = 'vbp_bp_price_cache_v21';
    const CACHE_TTL = 30 * 60 * 1000;

    const AUTO_CHECK_DELAY = 120;
    const BP_PAGES_TO_CHECK = 6;
    const PARALLEL_CHECKS = 3;

    [
        'vbp_bp_price_cache_v1',
        'vbp_bp_price_cache_v2',
        'vbp_bp_price_cache_v3',
        'vbp_bp_price_cache_v4',
        'vbp_bp_price_cache_v5',
        'vbp_bp_price_cache_v6',
        'vbp_bp_price_cache_v7',
        'vbp_bp_price_cache_v8',
        'vbp_bp_price_cache_v9',
        'vbp_bp_price_cache_v20'
    ].forEach(k => localStorage.removeItem(k));

    const QUALITY_MAP = {
        0: 'Normal',
        1: 'Genuine',
        3: 'Vintage',
        5: 'Unusual',
        6: 'Unique',
        11: 'Strange',
        13: 'Haunted',
        14: "Collector's",
        15: 'Decorated Weapon'
    };

    const QUALITY_PREFIXES = [
        'Genuine',
        'Vintage',
        'Unusual',
        'Unique',
        'Strange',
        'Haunted',
        "Collector's",
        'Decorated Weapon',
        'Normal'
    ];

    let autoQueue = [];
    let autoRunning = false;

    function ref(n) {
        return Number(n).toFixed(2);
    }

    function formatRefWithKeys(value) {
        const keys = Math.floor(value / KEY_PRICE);
        const metal = value - keys * KEY_PRICE;

        if (keys <= 0) return `${ref(value)} ref`;

        return `${keys} key${keys === 1 ? '' : 's'} ${ref(metal)} ref`;
    }

    function normalizeName(name) {
        return String(name || '')
            .toLowerCase()
            .replace(/^the\s+/, '')
            .replace(/^unique\s+/, '')
            .replace(/^strange\s+/, '')
            .replace(/^genuine\s+/, '')
            .replace(/^vintage\s+/, '')
            .replace(/^haunted\s+/, '')
            .replace(/^unusual\s+/, '')
            .replace(/^collector's\s+/, '')
            .replace(/^festivized\s+/, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function cleanName(rawHtml) {
        const div = document.createElement('div');
        div.innerHTML = rawHtml || '';
        return div.textContent.trim();
    }

    function getQualityId(item) {
        for (const cls of item.classList) {
            const match = cls.match(/^quality(\d+)$/);
            if (match) return Number(match[1]);
        }
        return 6;
    }

    function getQualityName(item) {
        return QUALITY_MAP[getQualityId(item)] || 'Unique';
    }

    function getQualityIdFromName(name) {
        for (const [id, q] of Object.entries(QUALITY_MAP)) {
            if (q === name) return id;
        }
        return 6;
    }

    function stripQualityPrefix(name) {
        let out = String(name || '').trim();

        for (const q of QUALITY_PREFIXES) {
            const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            out = out.replace(new RegExp(`^${escaped}\\s+`, 'i'), '');
        }

        out = out.replace(/^Festivized\s+/i, '');

        return out.trim();
    }

    function isFestivizedScrapItem(item) {
        const text = String(
            `${item.dataset.content || ''} ${item.dataset.title || ''}`
        ).toLowerCase();

        return text.includes('festivized');
    }

    function getItemInfo(item) {
        const rawName = cleanName(item.dataset.title);
        const quality = getQualityName(item);
        const qualityId = getQualityId(item);
        const festivized = isFestivizedScrapItem(item);
        const baseName = stripQualityPrefix(rawName);

        return {
            rawName,
            quality,
            qualityId,
            baseName,
            festivized,
            cacheKey: `${quality}:${normalizeName(baseName)}:${festivized ? 'festivized' : 'normal'}`
        };
    }

    function loadCache() {
        try {
            return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
        } catch {
            return {};
        }
    }

    function saveCache(cache) {
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    }

    function getCached(info) {
        const cache = loadCache();
        const entry = cache[info.cacheKey];

        if (!entry) return null;

        if (Date.now() - entry.time > CACHE_TTL) {
            delete cache[info.cacheKey];
            saveCache(cache);
            return null;
        }

        return entry;
    }

    function setCached(info, data) {
        const cache = loadCache();

        cache[info.cacheKey] = {
            ...data,
            time: Date.now()
        };

        saveCache(cache);
    }

    function scrapPriceFromItem(item) {
        const value = Number(item.dataset.itemValue || 0);
        if (value > 0) return value / 9;

        const text = item.querySelector('.item-value-indicator')?.textContent || '';

        const refMatch = text.match(/([\d.]+)\s*refined/i);
        if (refMatch) return Number(refMatch[1]);

        const keyMatch = text.match(/([\d.]+)\s*key/i);
        if (keyMatch) return Number(keyMatch[1]) * KEY_PRICE;

        return null;
    }

    function parsePriceToRef(text) {
        text = String(text || '')
            .toLowerCase()
            .replace(/,/g, '.')
            .replace(/\s+/g, ' ')
            .trim();

        let total = 0;

        const keyMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:keys|key)/);
        const refMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:ref|refined|metal)/);

        if (keyMatch) total += Number(keyMatch[1]) * KEY_PRICE;
        if (refMatch) total += Number(refMatch[1]);

        return total > 0 ? total : null;
    }

    function isCleanBuyOrder(listingElement) {
    const fullText = String(listingElement?.textContent || '').toLowerCase();

    const bad = [
        'painted',
        'painted hats',
        'painted items',

        'black ',
        'pink ',
        'lime ',
        'white ',
        'purple ',
        'gold ',
        'after eight',
        'team spirit',
        'australium gold',
        'a distinctive lack of hue',

        'spell',
        'spelled',
        'exorcism',
        'voices from below',
        'pumpkin bombs',
        'footprints',

        'parts attached',
        'strange part',
        'strange parts',

        'killstreak',
        'specialized',
        'professional',
        'sheen',

        'effect',
        'unusual',

        'mint',
        'clean mint',

        'cash',
        'paypal',
        'usd',
        '$',

        'listed price',
        'c/c',
        ' cc '
    ];

    if (bad.some(word => fullText.includes(word))) {
        return false;
    }

// ===== LVL FILTERS =====

if (/\b(lvl|level)\s*\d{1,3}\b/i.test(fullText)) return false;
if (/\b\d{1,3}\s*(lvl|level)\b/i.test(fullText)) return false;

    return true;
}

    function makeClassifiedsUrl(info, page = 1) {
        const item = encodeURIComponent(info.baseName);
        const qualityId = getQualityIdFromName(info.quality);
        const festivizedValue = info.festivized ? 1 : -1;

        return `https://backpack.tf/classifieds?page=${page}&item=${item}&quality=${qualityId}&tradable=1&craftable=1&australium=-1&killstreak_tier=0&festivized=${festivizedValue}`;
    }

    function fetchUrl(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout: 15000,
                onload: res => resolve(res.responseText),
                onerror: reject,
                ontimeout: reject
            });
        });
    }

    function priceLooksReasonable(price, scrapPrice) {
        if (price === null) return false;
        if (price <= 0) return false;
        if (price > 300) return false;

        if (scrapPrice < 5 && price > 8) return false;
        if (scrapPrice < 10 && price > 20) return false;
        if (price > scrapPrice * 3 && price > scrapPrice + 5) return false;
        if (price > scrapPrice + 25) return false;

        return true;
    }

    function getCleanBuyOrdersFromHtml(html, info, scrapPrice) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const cleanPrices = [];
        const targetName = normalizeName(info.baseName);

        const buyItems = [
            ...doc.querySelectorAll('.listing .item[data-listing_intent="buy"]')
        ];

        for (const item of buyItems) {
            const itemQuality = Number(item.dataset.quality || item.getAttribute('data-quality') || 6);
            if (itemQuality !== info.qualityId) continue;

            const isPainted =
                item.dataset.paint_price ||
                item.dataset.paint_hex ||
                item.querySelector('.paint');

            if (isPainted) continue;

            const listingRoot = item.closest('.listing') || item.parentElement;
            const listingText = String(listingRoot?.textContent || '').toLowerCase();
            const bpIsFestivized = listingText.includes('festivized');

            if (info.festivized && !bpIsFestivized) continue;
            if (!info.festivized && bpIsFestivized) continue;

            const name = normalizeName(
                item.dataset.name ||
                item.dataset.base_name ||
                item.getAttribute('data-name') ||
                item.getAttribute('data-original-title') ||
                ''
            );

            if (name !== targetName) continue;

            const priceText = item.dataset.listing_price || '';
            if (!priceText) continue;

            if (!isCleanBuyOrder(listingRoot)) continue;

            const price = parsePriceToRef(priceText);
            if (!priceLooksReasonable(price, scrapPrice)) continue;

            cleanPrices.push(price);
        }

        return cleanPrices;
    }

    async function findBestCleanBuyOrder(info, scrapPrice) {
        const allPrices = [];

        for (let page = 1; page <= BP_PAGES_TO_CHECK; page++) {
            const url = makeClassifiedsUrl(info, page);
            const html = await fetchUrl(url);
            const prices = getCleanBuyOrdersFromHtml(html, info, scrapPrice);

            allPrices.push(...prices);

            if (prices.length > 0) break;

            await new Promise(r => setTimeout(r, 100));
        }

        if (!allPrices.length) return null;

        return Math.max(...allPrices);
    }

    function makeBadge(item) {
        let badge = item.querySelector('.vbp-profit-box');

        if (!badge) {
            badge = document.createElement('div');
            badge.className = 'vbp-profit-box';
            badge.style.cssText = `
                position:absolute;
                left:2px;
                right:2px;
                bottom:2px;
                z-index:20;
                background:rgba(0,0,0,.84);
                color:#fff;
                font-size:10px;
                line-height:12px;
                padding:2px;
                text-align:center;
                border-radius:3px;
                pointer-events:auto;
                font-weight:bold;
            `;
            item.style.position = 'relative';
            item.appendChild(badge);
        }

        return badge;
    }

    function setCardState(item, state) {
        if (state === 'profit') {
            item.style.outline = '2px solid #00ff66';
            item.style.boxShadow = '0 0 8px rgba(0,255,102,.45)';
            return;
        }

        if (state === 'loss') {
            item.style.outline = '2px solid #ff5555';
            item.style.boxShadow = '0 0 8px rgba(255,85,85,.35)';
            return;
        }

        if (state === 'unknown') {
            item.style.outline = '2px solid #ffcc00';
            item.style.boxShadow = '0 0 8px rgba(255,204,0,.35)';
            return;
        }

        item.style.outline = '';
        item.style.boxShadow = '';
    }

    function renderResult(item, scrapPrice, bpBuy, info, fromCache = false) {
        const badge = makeBadge(item);

        if (bpBuy === null) {
            badge.innerHTML = `NO BUY`;
            badge.style.color = '#ffcc00';
            setCardState(item, 'unknown');
            return;
        }

        const profit = bpBuy - scrapPrice;
        const good = profit >= 0;

        badge.innerHTML = `
            BP: ${formatRefWithKeys(bpBuy)}<br>
            ${good ? '+' : ''}${ref(profit)} ref
            ${fromCache ? '<span style="font-size:9px;color:#aaa;"> cached</span>' : ''}
        `;

        badge.title =
            `${info.quality}${info.festivized ? ' Festivized' : ''} ${info.baseName}\n` +
            `BP buy: ${formatRefWithKeys(bpBuy)}\n` +
            `Scrap: ${formatRefWithKeys(scrapPrice)}\n` +
            `Profit: ${ref(profit)} ref`;

        badge.style.color = good ? '#00ff66' : '#ff5555';
        setCardState(item, good ? 'profit' : 'loss');
    }

    async function checkItem(item, force = false) {
        const badge = makeBadge(item);
        const info = getItemInfo(item);
        const scrapPrice = scrapPriceFromItem(item);

        if (!info.baseName || scrapPrice === null) {
            badge.textContent = 'NO DATA';
            badge.style.color = '#ff5555';
            setCardState(item, 'unknown');
            return;
        }

        if (!force) {
            const cached = getCached(info);
            if (cached) {
                renderResult(item, scrapPrice, cached.bpBuy, info, true);
                return;
            }
        }

        badge.textContent = 'CHECK...';
        badge.style.color = '#ffffff';
        setCardState(item, null);

        try {
            const bpBuy = await findBestCleanBuyOrder(info, scrapPrice);

            setCached(info, { bpBuy });
            renderResult(item, scrapPrice, bpBuy, info, false);

        } catch (e) {
            console.error('[VBP] BP check failed', e);
            badge.textContent = 'ERROR';
            badge.style.color = '#ff5555';
            setCardState(item, 'unknown');
        }
    }

    function createButton(item) {
        const btn = document.createElement('button');
        btn.textContent = 'BP';
        btn.title = 'Force check backpack.tf';
        btn.style.cssText = `
            position:absolute;
            top:2px;
            left:2px;
            z-index:30;
            font-size:10px;
            padding:1px 4px;
            background:#111;
            color:#fff;
            border:1px solid #888;
            border-radius:3px;
            cursor:pointer;
        `;

        btn.onclick = e => {
            e.preventDefault();
            e.stopPropagation();

            const info = getItemInfo(item);
            const cache = loadCache();
            delete cache[info.cacheKey];
            saveCache(cache);

            item.dataset.vbpQueued = '0';
            checkItem(item, true);
        };

        item.appendChild(btn);
    }

    function isVisible(el) {
        const rect = el.getBoundingClientRect();

        return (
            rect.bottom > 0 &&
            rect.top < window.innerHeight &&
            rect.right > 0 &&
            rect.left < window.innerWidth
        );
    }

    function enqueueVisibleItems() {
        const items = [...document.querySelectorAll('.item.hoverable.app440')];

        for (const item of items) {
            if (!item.dataset.title) continue;
            if (!isVisible(item)) continue;
            if (item.dataset.vbpQueued === '1') continue;

            item.dataset.vbpQueued = '1';
            autoQueue.push(item);
        }

        runQueue();
    }

    async function worker() {
        while (autoQueue.length) {
            const item = autoQueue.shift();

            if (item && document.body.contains(item)) {
                await checkItem(item, false);
                await new Promise(r => setTimeout(r, AUTO_CHECK_DELAY));
            }
        }
    }

    async function runQueue() {
        if (autoRunning) return;

        autoRunning = true;

        const workers = [];
        const count = Math.min(PARALLEL_CHECKS, autoQueue.length);

        for (let i = 0; i < count; i++) {
            workers.push(worker());
        }

        await Promise.all(workers);

        autoRunning = false;
    }

    function initItems() {
        document.querySelectorAll('.item.hoverable.app440').forEach(item => {
            if (item.classList.contains(CHECKED_CLASS)) return;
            if (!item.dataset.title) return;

            item.classList.add(CHECKED_CLASS);
            item.style.position = 'relative';

            createButton(item);
            makeBadge(item);
        });

        enqueueVisibleItems();
    }

    initItems();

    let scrollTimer = null;

    window.addEventListener('scroll', () => {
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(enqueueVisibleItems, 250);
    }, true);

    new MutationObserver(() => {
        clearTimeout(window.__vbpMutation);
        window.__vbpMutation = setTimeout(initItems, 300);
    }).observe(document.body, {
        childList: true,
        subtree: true
    });
})();