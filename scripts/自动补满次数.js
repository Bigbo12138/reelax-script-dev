// ==UserScript==
// @name         Arcane Reelax 自动补满次数弃用
// @namespace    arcane-reelax-auto-refill
// @version      1.0.0
// @description  每 10 秒检查自动钓鱼剩余次数，少于 5 次时自动点击补满
// @author       Codex
// @match        http://127.0.0.1:5173/*
// @match        http://localhost:5173/*
// @match        https://reelax.cn/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    const CHECK_INTERVAL_MS = 10_000;
    const REFILL_THRESHOLD = 5;
    const DESKTOP_STATUS_SELECTOR = '.topbar-fishing-status';
    const MOBILE_PANEL_SELECTOR = '.batch-panel';
    const CAST_COUNT_PATTERN = /([\d,]+)\s*\/\s*([\d,]+)/;
    const TIMER_KEY = '__arcaneReelaxAutoRefillTimer';

    function parseCastCounts(label) {
        const match = label?.match(CAST_COUNT_PATTERN);

        if (!match) return null;

        const remainingCasts = Number.parseInt(
            match[1].replaceAll(',', ''),
            10,
        );
        const totalCasts = Number.parseInt(match[2].replaceAll(',', ''), 10);

        if (
            !Number.isSafeInteger(remainingCasts) ||
            !Number.isSafeInteger(totalCasts)
        ) {
            return null;
        }

        return { remainingCasts, totalCasts };
    }

    function findDesktopRefillTarget() {
        const button = document.querySelector(DESKTOP_STATUS_SELECTOR);

        if (!(button instanceof HTMLButtonElement) || button.disabled) {
            return null;
        }

        const counts = parseCastCounts(
            button.getAttribute('aria-label') ?? button.textContent,
        );
        if (!counts) return null;

        const title = button.getAttribute('title') ?? '';

        if (title.startsWith('补满至')) return { button, counts };

        // 请求失败后按钮标题会显示错误信息；运行中的非满批次仍只能执行补满。
        if (
            counts.remainingCasts > 0 &&
            counts.remainingCasts < counts.totalCasts
        ) {
            return { button, counts };
        }

        return null;
    }

    function findMobileRefillTarget() {
        const panel = document.querySelector(MOBILE_PANEL_SELECTOR);
        if (!(panel instanceof HTMLElement)) return null;

        const countItem = Array.from(
            panel.querySelectorAll('.batch-number'),
        ).find(
            (item) =>
                item.querySelector('span')?.textContent?.trim() === '剩余杆数',
        );
        const button = Array.from(panel.querySelectorAll('button')).find(
            (item) => item.textContent?.trim() === '补满次数',
        );

        if (!(button instanceof HTMLButtonElement) || button.disabled) {
            return null;
        }

        const counts = parseCastCounts(
            countItem?.querySelector('strong')?.textContent,
        );

        return counts ? { button, counts } : null;
    }

    function refillIfNeeded() {
        const target = findDesktopRefillTarget() ?? findMobileRefillTarget();

        if (!target) return;

        if (target.counts.remainingCasts >= REFILL_THRESHOLD) return;

        target.button.click();
        console.info(
            `[Arcane Reelax 自动补满] 剩余 ${target.counts.remainingCasts} / ${target.counts.totalCasts} 杆，已点击补满。`,
        );
    }

    const previousTimer = window[TIMER_KEY];
    if (previousTimer) window.clearInterval(previousTimer);

    refillIfNeeded();
    window[TIMER_KEY] = window.setInterval(refillIfNeeded, CHECK_INTERVAL_MS);
})();
