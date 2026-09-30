// ==UserScript==
// @name         Reelax 自动登录
// @namespace    reelax-auto-login
// @version      1.0.1
// @description  打开网站后若检测到登录表单，用运行期注入的凭据自动填充并登录。
//               凭据来自 window.__REELAX_LOGIN__（由 injector.js 注入，值源自
//               run.sh 的环境变量 FISH_EMAIL / FISH_PASSWD 或 --login 参数）。
//               未注入凭据时不执行任何登录，避免在代码中硬编码账号密码。
// @match        https://reelax.cn/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  // 仅从运行期注入的凭据读取；未配置则不自动登录（绝不硬编码账号密码）。
  const runtime = (typeof window !== 'undefined' && window.__REELAX_LOGIN__) || {};
  const EMAIL = runtime.email;
  const PASSWORD = runtime.password;
  if (!EMAIL || !PASSWORD) {
    console.log('[Reelax 自动登录] 未配置登录凭据（FISH_EMAIL/FISH_PASSWD），跳过自动登录');
    return;
  }

  const EMAIL_SELECTOR =
    'input[type="email"], input[autocomplete="email"]';
  const PASSWORD_SELECTOR =
    'input[type="password"], input[autocomplete="current-password"]';
  const SUBMIT_SELECTOR = 'button.primary-button.auth-submit';

  // 兼容 React 受控输入框：用原生 setter 赋值，再派发 input/change 事件，
  // 否则直接改 .value 框架感知不到，登录按钮可能仍是禁用态。
  function setInputValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) {
      desc.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function tryLogin() {
    const emailEl = document.querySelector(EMAIL_SELECTOR);
    const pwdEl = document.querySelector(PASSWORD_SELECTOR);
    const submitBtn = document.querySelector(SUBMIT_SELECTOR);

    // 表单还没渲染出来，或已经登录（无表单）→ 不处理
    if (!emailEl || !pwdEl || !submitBtn) return false;

    if (!emailEl.value) setInputValue(emailEl, EMAIL);
    if (!pwdEl.value) setInputValue(pwdEl, PASSWORD);

    console.log('[Reelax 自动登录] 检测到登录表单，已填充并点击登录');
    submitBtn.click();
    return true;
  }

  // 立即试一次；若表单是 SPA 异步渲染，则轮询（最多约 10 秒）。
  // 一旦点击过就停（避免重复提交）。
  let tries = 0;
  if (!tryLogin()) {
    const timer = setInterval(() => {
      tries += 1;
      const ok = tryLogin();
      if (ok || tries >= 20) clearInterval(timer);
    }, 500);
  }
})();
