// sign.js —— reelax.cn 请求签名工具（注入到页面主世界后可用）
//
// 用法（经 RDP 在页面里探查任意 /api 时）：
//   1. 先注入本文件（定义 window.__sign）：
//        python3 devtools/rdp_query.py evala "$(cat devtools/sign.js)"
//   2. 再调用签名请求：
//        python3 devtools/rdp_query.py evala \
//          "window.__sign.signedGet('/api/market/orders?assetType=gear&side=sell&rarities=legendary')"
//
//   也可以一次性注入并调用（见 market.py 的用法）。
//
// 签名原理（逆向自站点打包 JS）：
//   服务端在响应头 x-arcane-request-proof 下发会话级 proof 令牌；
//   待签明文 = "v1\n" + METHOD大写 + "\n" + url + "\n" + 毫秒时间戳 + "\n" + body
//   签名     = base64url( HMAC-SHA256( key=proof, msg=待签明文 ) )
//   请求头   = x-arcane-request-proof / x-arcane-request-timestamp / x-arcane-request-signature
//
// 本文件只做「签名 + 请求」，不改任何状态；所有请求都是凭页面会话发出的。

(() => {
  'use strict';

  const PROOF_HEADER = 'x-arcane-request-proof';
  const TIMESTAMP_HEADER = 'x-arcane-request-timestamp';
  const SIGNATURE_HEADER = 'x-arcane-request-signature';
  const PROOF_ME_PATH = '/api/me';

  // 会话级 proof 缓存（同一页面内复用；过期/失效时可调用 __sign.resetProof() 重取）
  let cachedProof = null;

  function b64url(u8) {
    let bin = '';
    for (const x of u8) bin += String.fromCharCode(x);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // 从 /api/me 响应头拿 proof 令牌（免签端点，用于引导后续签名）
  async function getProof() {
    if (cachedProof) return cachedProof;
    const meRes = await fetch(PROOF_ME_PATH, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    const proof = meRes.headers.get(PROOF_HEADER);
    if (proof) cachedProof = proof;
    return proof;
  }

  function resetProof() {
    cachedProof = null;
  }

  // 计算签名并返回三个请求头
  async function sign(method, path, body) {
    const proof = await getProof();
    if (!proof) throw new Error('no-proof-from-/api/me');
    const ts = String(Date.now());
    const msg = ['v1', method.toUpperCase(), path, ts, body || ''].join('\n');
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(proof),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
    return {
      Accept: 'application/json',
      [PROOF_HEADER]: proof,
      [TIMESTAMP_HEADER]: ts,
      [SIGNATURE_HEADER]: b64url(new Uint8Array(sigBuf)),
    };
  }

  // 签名后 fetch；返回 {status, ok, data, raw, headers}
  // 403 REQUEST_SIGNATURE_INVALID 时自动重置 proof 重取后重试一次（避免挂机后 proof 过期一直 403）
  async function signedFetch(path, options = {}, _retried = false) {
    const method = (options.method || 'GET').toUpperCase();
    const body = options.body === undefined ? undefined
      : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    const sigHeaders = await sign(method, path, body);
    const headers = { ...(options.headers || {}), ...sigHeaders };
    // 有 body 时补 application/json：服务端按 Content-Type 解析 body 参与签名校验，
    // 缺这个头带 body 的 POST 会 403 REQUEST_SIGNATURE_INVALID
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    // 幂等写操作补 Idempotency-Key：服务端要求有效幂等标识，否则 400 VALIDATION_ERROR
    if (method !== 'GET' && !headers['Idempotency-Key']) {
      headers['Idempotency-Key'] = crypto.randomUUID();
    }
    const res = await fetch(path, {
      ...options,
      method,
      headers,
      credentials: 'include',
      body: body || undefined,
    });

    // 403 且确认为签名失效 → 重置 proof 重新取一次，重试
    if (res.status === 403 && !_retried) {
      const probe = await res.clone().text();
      const isSigInvalid = /REQUEST_SIGNATURE_INVALID/.test(probe);
      if (isSigInvalid) {
        resetProof();
        return signedFetch(path, options, true);
      }
    }

    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* 非 JSON */ }
    return { status: res.status, ok: res.ok, data, raw: text, headers: res.headers };
  }

  // 便捷：GET 并直接返回 JSON 对象（自动 JSON.parse）
  async function signedGet(path) {
    const r = await signedFetch(path);
    return r.data !== null ? r.data : { _raw: r.raw, _status: r.status, _ok: r.ok };
  }

  window.__sign = {
    getProof,
    resetProof,
    sign,
    signedFetch,
    signedGet,
    b64url,
  };
})();
