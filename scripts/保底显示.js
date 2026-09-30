// ==UserScript==
// @name         Reelax 保底显示 + 运气加成分析
// @namespace    reelax-pity-display
// @version      2.0.0
// @description  在「自动钓鱼」面板标题后显示保底进度（奥秘/奇异 百分比 + 距硬保底剩余时间）+ 有效运气；新增：分析商店 +25% 运气加成能否把剩余时间压进 2 小时内，是则提示可购买。
// @match        https://reelax.cn/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  if (window.__reelaxPityDisplay__) return;
  window.__reelaxPityDisplay__ = true;

  const API_BASE = 'https://reelax.cn';
  const REFRESH_MS = 60 * 1000;
  const RENDER_MS = 2000;
  const LUCK_BOOST_PCT = 0.25;
  const REMIND_UNDER_MS = 2 * 60 * 60 * 1000;
  const LUCK_BOOST_PRODUCT = 'relic-luck-ii';
  const LUCK_BOOST_PRICE = 150;

  // ---------- 商店遗物加成（自动购买改为「勾选才买」，全部默认不勾） ----------
  // 购买 = POST /api/shop/purchases  { productId }
  // 生效态：GET /api/fishing/state → activeBuffs[].{productId,buffType,endsAt,bonusBasisPoints}
  // 同一组（experience/strength/luck/fragment）同一时刻只能有一个生效，买了新的会顶掉旧的。
  const BUFF = {
    'relic-xp-i':          { name: '经验 +30%',   price: 75,  group: 'experience', currency: 'relics' },
    'relic-xp-ii':         { name: '经验 +75%',   price: 150, group: 'experience', currency: 'relics' },
    'relic-strength-i':    { name: '力量 +10%',   price: 75,  group: 'strength',   currency: 'relics' },
    'relic-strength-ii':   { name: '力量 +25%',   price: 150, group: 'strength',   currency: 'relics' },
    'relic-luck-i':        { name: '运气 +10%',   price: 75,  group: 'luck',       currency: 'relics' },
    'relic-luck-ii':       { name: '运气 +25%',   price: 150, group: 'luck',       currency: 'relics' },
    'fragment-personal-xp':{ name: '碎光顿悟 +25%经验', price: 20, group: 'fragment', currency: 'fragments' },
  };
  const BUFF_GROUPS = [
    ['experience', '经验加成（遗物）'],
    ['strength',   '力量加成（遗物）'],
    ['luck',       '运气加成（遗物）'],
    ['fragment',   '经验加成（奥秘碎片）'],
  ];
  // 购买同一组后的冷却，避免反复刷新同一 buff
  const BUFF_COOLDOWN_MS = 25 * 60 * 1000;
  const BUFF_POLL_MS = 5 * 60 * 1000;
  const BUFF_CFG_KEY = 'r1cm-buff-cfg-v1';
  // 「仅在奥秘涌流购买」的剩余时间门槛（分钟）：
  //   遗物币 buff（relics）：涌流剩余 < 20 分钟 → 不买
  //   奥秘碎片 buff（fragments）：涌流剩余 < 90 分钟 → 不买
  const SURGE_RELIC_MIN = 20;
  const SURGE_FRAGMENT_MIN = 90;
  let buffChecked = new Set();   // 用户勾选要自动买的 productId（默认全空）
  let buffSurgeOnly = false;     // 是否「仅在奥秘涌流时购买」
  let buffGroupActiveAt = {};    // group -> 上次买到的时间戳（冷却防抖）
  function loadBuffChecked() {
    try {
      const o = JSON.parse(localStorage.getItem(BUFF_CFG_KEY));
      if (o && Array.isArray(o.buy) && o.buy.length) buffChecked = new Set(o.buy.filter((k) => BUFF[k]));
      if (o) buffSurgeOnly = o.surgeOnly === true;
    } catch (_e) {}
  }
  function saveBuffChecked() {
    try { localStorage.setItem(BUFF_CFG_KEY, JSON.stringify({ buy: [...buffChecked], surgeOnly: buffSurgeOnly })); } catch (_e) {}
  }
  loadBuffChecked();

  // 当前奥秘涌流剩余分钟（null=不在涌流或无法判定）。
  // 实测页面 /api/fishing/state 里涌流不在顶层 surge，而在顶层 arcaneSacrifice.surge（{isActive, endsAt}）。
  // 依次尝试：d.surge / d.arcaneSacrifice.surge / d.biome.weather 的 arcane_surge。
  function surgeRemainMinFromState(d) {
    if (d) {
      const candidates = [d.surge, d.arcaneSacrifice && d.arcaneSacrifice.surge, d.biome && d.biome.weather];
      for (const s of candidates) {
        if (!s || !s.endsAt) continue;
        const wid = s.weatherId || s.id;
        if (wid === 'arcane_surge' || s.isActive === true || s.isActive === undefined) {
          try {
            const r = (new Date(s.endsAt).getTime() - Date.now()) / 60000;
            if (r > 0) return r;
          } catch (_e) {}
        }
      }
    }
    return null;
  }
  function surgeRemainMinFromSnapshot() {
    try {
      const snap = window.arcaneReelax && window.arcaneReelax.getSnapshot && window.arcaneReelax.getSnapshot();
      if (snap) {
        const candidates = [snap.surge, snap.arcaneSacrifice && snap.arcaneSacrifice.surge, snap.biome && snap.biome.weather];
        for (const s of candidates) {
          if (!s || !s.endsAt) continue;
          try {
            const r = (new Date(s.endsAt).getTime() - Date.now()) / 60000;
            if (r > 0) return r;
          } catch (_e) {}
        }
      }
    } catch (_e) {}
    return null;
  }

  // ---------- 签名（与扩展 monitor.js / SKILL.md §2.5 一致） ----------
  let proof = null;
  function b64url(buf){ return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
  async function refreshProof(){ const res=await fetch(API_BASE+'/api/me',{credentials:'include',headers:{Accept:'application/json'}}); if(!res.ok) throw new Error('me '+res.status); proof=res.headers.get('x-arcane-request-proof'); if(!proof) throw new Error('no-proof'); }
  async function signedGet(path){
    if(!proof) await refreshProof();
    const doFetch = async (ts) => { const msg=['v1','GET',path,ts,''].join('\n'); const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(proof),{name:'HMAC',hash:'SHA-256'},false,['sign']); const sig=b64url(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(msg))); return fetch(API_BASE+path,{headers:{Accept:'application/json','x-arcane-request-proof':proof,'x-arcane-request-timestamp':ts,'x-arcane-request-signature':sig}}); };
    let res=await doFetch(String(Date.now()));
    if(res.status===403){ await refreshProof(); res=await doFetch(String(Date.now())); }
    return res;
  }
  // 签名 POST（§2.5）：msg = v1\nPOST\npath\nts\nbody（body 为 JSON 字符串）
  async function signedPost(path, body){
    if(!proof) await refreshProof();
    const bodyStr = (body === undefined || body === null) ? '' : JSON.stringify(body);
    const doFetch = async (ts) => { const msg=['v1','POST',path,ts,bodyStr].join('\n'); const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(proof),{name:'HMAC',hash:'SHA-256'},false,['sign']); const sig=b64url(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(msg))); return fetch(API_BASE+path,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','x-arcane-request-proof':proof,'x-arcane-request-timestamp':ts,'x-arcane-request-signature':sig,'Idempotency-Key':crypto.randomUUID()},body:bodyStr}); };
    let res=await doFetch(String(Date.now()));
    if(res.status===403){ await refreshProof(); res=await doFetch(String(Date.now())); }
    return res;
  }

  // ---------- 掉落概率模型（从 api/fish_economy.py rarity_probabilities 移植） ----------
  const RARITIES = ['common','uncommon','fine','rare','epic','legendary','mythic','exotic','arcane'];
  const BASE_WEIGHT = { common:550000000, uncommon:280000000, fine:120000000, rare:40000000, epic:9881800, legendary:100000, mythic:16000, exotic:2000, arcane:200 };
  const LUCK_SENS = { common:0.0, uncommon:0.02, fine:0.05, rare:0.1, epic:0.25, legendary:1.7, mythic:1.7, exotic:1.5, arcane:2.0 };
  const PT = { startsAt:15000, capsAt:50000, step:5000, bonusPerStep:{ mythic:0.05, exotic:0.1, arcane:0.25 } };
  const BAIT_CFG = {
    basic:{min:0,max:1,luck:0,mult:{}}, low:{min:0,max:4,luck:0,mult:{}},
    medium:{min:0,max:8,luck:250,mult:{}}, high:{min:0,max:8,luck:500,mult:{mythic:1.25,exotic:1.25,arcane:1.25}},
    supreme:{min:1,max:8,luck:1000,mult:{mythic:1.5,exotic:1.5,arcane:1.5}},
  };
  const WEATHER_CFG = {
    clear:{mult:{}}, rain:{mult:{common:0.97,uncommon:1.1,fine:1.03,rare:1.05,epic:1.1,legendary:1.05,mythic:1.05,exotic:1.03}},
    gale:{mult:{common:0.95,uncommon:1.05,fine:1.05,rare:1.1,epic:1.1,legendary:1.1,mythic:1.1,exotic:1.05}},
    mist:{mult:{common:0.93,fine:1.1,rare:1.1,epic:1.15,legendary:1.15,mythic:1.15,exotic:1.1,arcane:1.05}},
    heatwave:{mult:{common:0.9,uncommon:0.97,fine:1.15,rare:1.1,epic:1.2,legendary:1.2,mythic:1.2,exotic:1.15,arcane:1.1}},
    tempest:{mult:{common:0.9,uncommon:0.95,fine:1.1,rare:1.25,epic:1.25,legendary:1.25,mythic:1.25,exotic:1.25,arcane:1.25}},
    wither_tide:{mult:{common:1.5,uncommon:1.25,fine:0.75,rare:0.75,epic:0.75,legendary:0.75,mythic:0.75,exotic:0.75,arcane:0.75}},
    gilded_current:{mult:{common:1.25,uncommon:1.25}}, arcane_surge:{mult:{common:0.85,uncommon:0.92,fine:0.95,rare:1.15,epic:1.4,legendary:1.5,mythic:1.5,exotic:1.75,arcane:3.0}},
  };
  const BAIT_LUCK = { basic:0, low:0, medium:250, high:500, supreme:1000 };
  function normBait(id){ if(!id) return 'supreme'; id=String(id); if(id.indexOf('bait_')===0) return id.slice(5); return id; }
  function rarityProb(effLuck, baitId, weatherId){
    const b = BAIT_CFG[normBait(baitId)] || BAIT_CFG.supreme;
    const w = WEATHER_CFG[weatherId] || WEATHER_CFG.clear;
    const eff = Math.max(0, effLuck||0);
    const u = Math.max(0, (Math.min(PT.capsAt, Math.max(PT.startsAt, eff)) - PT.startsAt) / PT.step);
    const bonus = {}; for(const k in PT.bonusPerStep) bonus[k] = PT.bonusPerStep[k]*u;
    const weights = {}, allowedR = [];
    for(const r of RARITIES){
      const idx = RARITIES.indexOf(r);
      if(idx < b.min || idx > b.max) continue;
      const bm = (b.mult && b.mult[r]!=null) ? b.mult[r] : 1.0;
      const wm = (w.mult && w.mult[r]!=null) ? w.mult[r] : 1.0;
      const m = Math.max(0, bm + wm - 1);
      const sens = LUCK_SENS[r] + (bonus[r]||0);
      const wgt = BASE_WEIGHT[r] * (1 + eff/100.0*sens) * m;
      weights[r] = wgt; allowedR.push(r);
    }
    const total = allowedR.reduce((s,r)=>s+weights[r], 0);
    const out = {};
    for(const r of allowedR) out[r] = total>0 ? weights[r]/total : 0;
    return out;
  }
  function baitLuckOf(baitId){ return BAIT_LUCK[normBait(baitId)] != null ? BAIT_LUCK[normBait(baitId)] : 0; }

  // ---------- 保底 百分比/时间 ----------
  function computePity(data){
    const p = data && data.pity;
    if(!p || !p.arcane || !p.exotic) return null;
    const pctOf=(cur,cap)=> (cur!=null&&cap>0)?(cur/cap*100):null;
    const fmtRemain=(cur,cap)=>{ if(cur==null||cap==null||cap<=0) return ''; const remainCasts=cap-cur; if(remainCasts<=0) return '已到期'; const mm=Math.round(remainCasts*6/60); if(mm<60) return mm+'分'; return Math.floor(mm/60)+'时'+(mm%60?mm%60+'分':''); };
    const build=(key)=>{ const d=p[key]; const cur=d.currentDryCasts!=null?d.currentDryCasts:null; const max=d.maxDryCasts!=null?d.maxDryCasts:null;
      // hardPityCasts 为 null = 当前不追踪硬保底（例如所用道具不带保底），此时百分比/剩余时间显示「—」是正确行为。
      const hard=d.hardPityCasts!=null?d.hardPityCasts:null;
      const pct=pctOf(cur,hard); const remain=fmtRemain(cur,hard);
      let cls='ok'; if(cur!=null&&hard!=null&&cur>=hard) cls='bad'; else if(cur!=null&&max!=null&&cur>=max) cls='warn';
      return {pct,remain,cur,max,hard,cls}; };
    return { arcane:build('arcane'), exotic:build('exotic'), effectiveLuck:p.effectiveLuck!=null?p.effectiveLuck:null, baitId:p.baitId||null, weatherId:p.weatherId||null };
  }
  function fmtMs(ms){ if(ms==null||!isFinite(ms)) return '—'; if(ms<=0) return '已到'; const m=Math.round(ms/60000); if(m<60) return m+'分'; return Math.floor(m/60)+'时'+(m%60?m%60+'分':''); }

  // ---------- 运气加成分析：+25% 后的期望时间 + 距 2h 还差多少 ----------
  function luckBonusAnalysis(info){
    if(!info || info.effectiveLuck==null) return null;
    const baseLuck = info.effectiveLuck - baitLuckOf(info.baitId);
    const effNow = info.effectiveLuck;
    const effBoost = Math.round(baseLuck*(1+LUCK_BOOST_PCT) + baitLuckOf(info.baitId));
    const bait = info.baitId, weather = info.weatherId;
    const probsBoost = rarityProb(effBoost, bait, weather);
    const items = [];
    for(const key of ['arcane','exotic']){
      const pb = probsBoost[key]||0;
      if(pb<=0) continue;
      const boostMs = (1/pb)*6000;
      // 距 2h：若 +25% 后时间仍 >2h，显示还差多少；若已 <2h，显示已达标
      const gapMs = boostMs - REMIND_UNDER_MS;
      items.push({ key, label: key==='arcane'?'奥秘':'奇异', boostMs, gapMs, under2h: boostMs < REMIND_UNDER_MS });
    }
    if(!items.length) return null;
    return { effNow, effBoost, items };
  }

  // ---------- 天气(奥秘涌流)加成分析：现处当前天气 vs 假设切到奥秘涌流，保底期望时间 ----------
  // 奥秘涌流天气：exotic×1.75、arcane×3.0。用当前有效运气(非+25%)算期望剩余时间。
  function weatherBonusAnalysis(info){
    if(!info || info.effectiveLuck==null) return null;
    const eff = info.effectiveLuck;
    const bait = info.baitId;
    // 叠加前=无奥秘涌流加成（用晴朗天气），叠加后=切到奥秘涌流（×1.75/×3.0）
    const res = { items: [] };
    for(const key of ['arcane','exotic']){
      const pNo = rarityProb(eff, bait, 'clear')[key] || 0;
      const pSurge = rarityProb(eff, bait, 'arcane_surge')[key] || 0;
      if(pNo<=0 || pSurge<=0) continue;
      res.items.push({ key, label: key==='arcane'?'奥秘':'奇异', noMs:(1/pNo)*6000, surgeMs:(1/pSurge)*6000 });
    }
    if(!res.items.length) return null;
    return res;
  }

  // ---------- 渲染：在「自动钓鱼」标题后，保留保底+进度条(harvest样式)，+25%运做成悬浮tooltip ----------
  function fmtMsShort(ms){ if(ms==null||!isFinite(ms)) return '—'; if(ms<=0) return '已到'; const m=Math.round(ms/60000); if(m<60) return m+'分'; return (m/60).toFixed(1)+'时'; }
  // 保底 chip（参考 harvest-tags 圆角彩条 + 内嵌进度条）
  function pityChip(name, d, color){
    const chip=document.createElement('span');
    chip.style.cssText='display:inline-flex;align-items:center;gap:4px;background:'+color+'1f;border:1px solid '+color+'55;border-radius:10px;padding:2px 7px;font-size:12px;font-weight:600;color:'+color+';margin-left:6px;';
    if(!d || d.pct==null){ chip.textContent=name+' —'; return chip; }
    const txt=document.createElement('span');
    txt.textContent=name+' '+d.pct.toFixed(1)+'%'+(d.remain?' · '+d.remain:'');
    chip.appendChild(txt);
    if(d.pct!=null){
      const bar=document.createElement('span'); bar.style.cssText='display:inline-block;width:46px;height:5px;border-radius:3px;background:rgba(0,0,0,.14);overflow:hidden;';
      const fill=document.createElement('span'); fill.style.cssText='display:block;height:100%;background:'+color+';width:'+Math.min(100,d.pct)+'%;'; bar.appendChild(fill); chip.appendChild(bar);
    }
    return chip;
  }
  function luckTag(luck){
    const s=document.createElement('span');
    s.style.cssText='display:inline-flex;align-items:center;gap:3px;background:#1f6feb1f;border:1px solid #1f6feb55;border-radius:10px;padding:2px 7px;font-size:11px;font-weight:600;color:#58a6ff;margin-left:6px;';
    s.textContent='🎲 有效运气 '+luck; return s;
  }
  // +25% 运悬浮触发器 + tooltip
  function boostTrigger(info){
    const boost=luckBonusAnalysis(info);
    const wrap=document.createElement('span');
    wrap.style.cssText='position:relative;display:inline-flex;align-items:center;margin-left:6px;cursor:help;';
    const trig=document.createElement('span');
    trig.textContent='💡 +25%运';
    trig.style.cssText='display:inline-flex;align-items:center;gap:3px;background:rgba(210,153,34,.15);border:1px solid rgba(210,153,34,.5);border-radius:10px;padding:2px 7px;font-size:11px;font-weight:600;color:#e3b341;';
    wrap.appendChild(trig);
    // tooltip
    const tip=document.createElement('div');
    tip.style.cssText='position:absolute;top:100%;left:0;z-index:9999;display:none;min-width:210px;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.7;color:#e6edf3;box-shadow:0 4px 14px rgba(0,0,0,.5);white-space:nowrap;';
    let tipHtml='<div style="font-weight:700;color:#e3b341;margin-bottom:4px">💡 商店 +25% 运（'+LUCK_BOOST_PRICE+'遗物）</div>';
    if(!boost || !boost.items.length){ tipHtml+='<span style="color:#8b949e">当前无目标可分析</span>'; }
    else{
      tipHtml+='<div style="margin-bottom:3px">🎲 有效运气 <b>'+boost.effBoost+'</b>（+25%后）</div>';
      for(const it of boost.items){
        const color=it.under2h ? '#f85149' : '#8b949e';
        tipHtml+='<div><b>'+it.label+'</b> <span style="color:'+color+'">仅 '+fmtMsShort(it.boostMs)+'</span>'+(it.under2h?' <span style="color:#f85149;font-weight:700">✅已<2h</span>':' <span style="color:#8b949e">距2h还差'+fmtMsShort(Math.abs(it.gapMs))+'</span>')+'</div>';
      }
    }
    // 天气(奥秘涌流)加成详情：当前天气 vs 假设切到奥秘涌流
    const wb=weatherBonusAnalysis(info);
    if(wb && wb.items && wb.items.length){
      tipHtml+='<div style="border-top:1px dashed #30363d;margin:6px 0;padding-top:6px;font-weight:700;color:#bc8cff">🌩️ 奥秘涌流加成</div>';
      for(const it of wb.items){
        tipHtml+='<div><b>'+it.label+'</b> <span style="color:#6e7681">叠加前 '+fmtMsShort(it.noMs)+'</span> <span style="color:#f0f6fc;font-weight:700">叠加后 '+fmtMsShort(it.surgeMs)+'</span></div>';
      }
    }
    tip.innerHTML=tipHtml;
    wrap.appendChild(tip);
    // hover 切换
    let shown=false;
    const show=()=>{ tip.style.display='block'; shown=true; };
    const hide=()=>{ tip.style.display='none'; shown=false; };
    wrap.addEventListener('mouseenter', show);
    wrap.addEventListener('mouseleave', hide);
    trig.addEventListener('click', ()=>{ shown?hide():show(); });
    return wrap;
  }
  // ---------- 商店遗物 buff（勾选才自动买；默认全不勾，不再自动花遗物） ----------
  function activeBuffGroup(b) {
    if (b && b.productId && BUFF[b.productId]) return BUFF[b.productId].group;
    if (!b) return null;
    const bonus = Number(b.bonusBasisPoints);
    if (b.buffType === 'experience' && bonus === 2500) return 'fragment';
    if (b.buffType === 'experience' && (bonus === 3000 || bonus === 7500)) return 'experience';
    if (b.buffType === 'strength' && (bonus === 1000 || bonus === 2500)) return 'strength';
    if (b.buffType === 'luck' && (bonus === 1000 || bonus === 2500)) return 'luck';
    return null;
  }
  async function fetchActiveBuffs() {
    try {
      const res = await signedGet('/api/fishing/state');
      if (!res.ok) return { ok: false, error: 'status ' + res.status };
      const d = await res.json();
      // 【debug】打印实际拿到的涌流结构与 surgeRemainMin，定位为何判非涌流
      try {
        console.log('[Reelax 保底][dbg] fishing/state keys=', Object.keys(d || {}),
          '| surge=', JSON.stringify(d && d.surge),
          '| arcaneSacr.surge=', d && d.arcaneSacrifice ? JSON.stringify(d.arcaneSacrifice.surge) : 'none',
          '| nextBuffBoundaryAt=', d && d.nextBuffBoundaryAt);
      } catch (_e) {}
      const active = Array.isArray(d && d.activeBuffs) ? d.activeBuffs : [];
      const srm = surgeRemainMinFromState(d);
      console.log('[Reelax 保底][dbg] surgeRemainMinFromState=', srm);
      return { ok: true, active, surgeRemainMin: srm };
    } catch (e) { return { ok: false, error: String(e) }; }
  }
  function playerBalance() {
    try {
      const p = (window.arcaneReelax && window.arcaneReelax.getSnapshot && window.arcaneReelax.getSnapshot() && window.arcaneReelax.getSnapshot().player) || null;
      return { relics: (p && p.relics) != null ? p.relics : null, fragments: (p && p.fragments) != null ? p.fragments : null };
    } catch (_e) { return { relics: null, fragments: null }; }
  }
  // 购买已勾选且该组未生效、余额足够的 buff；返回购买结果数组
  async function buyCheckedBuffs() {
    const state = await fetchActiveBuffs();
    const activeNow = (state.ok ? state.active : []).filter((b) => b && b.endsAt && new Date(b.endsAt).getTime() > Date.now());
    const activeGroups = new Set(activeNow.map(activeBuffGroup).filter(Boolean));
    const bal = playerBalance();
    const now = Date.now();
    const results = [];
    // 「仅在奥秘涌流时购买」：剩余分钟不足则对应币种不买。
    //   遗物币 buff 需涌流剩余 ≥ 20 分钟；奥秘碎片 buff 需 ≥ 90 分钟。
    let surgeRemainMin = (buffSurgeOnly && state.ok) ? state.surgeRemainMin : null;
    if (buffSurgeOnly && surgeRemainMin == null) surgeRemainMin = surgeRemainMinFromSnapshot();
    const surgeOn = buffSurgeOnly && surgeRemainMin != null && surgeRemainMin > 0;
    if (buffSurgeOnly) console.log('[Reelax 保底] buffSurgeOnly', buffSurgeOnly, 'surgeRemainMin', surgeRemainMin, 'surgeOn', surgeOn, 'stateOk', state.ok, 'stateSV', state.surgeRemainMin);
    if (buffSurgeOnly && !surgeOn) {
      results.push({ group: 'all', ok: 'surge', msg: '非奥秘涌流或涌流剩余不足，本次不购买' });
      return { active: activeNow, results };
    }
    for (const group of BUFF_GROUPS.map((g) => g[0])) {
      const products = Object.keys(BUFF).filter((k) => BUFF[k].group === group);
      const chosen = products.filter((k) => buffChecked.has(k));
      if (!chosen.length) continue;
      if (activeGroups.has(group)) { results.push({ group, ok: 'active', msg: '该组 buff 生效中，跳过' }); continue; }
      for (const k of chosen) {
        const cfg = BUFF[k];
        if (buffGroupActiveAt[group] && now - buffGroupActiveAt[group] < BUFF_COOLDOWN_MS) { results.push({ k, ok: 'cooldown', msg: cfg.name + ' 冷却中' }); continue; }
        // 涌流剩余时间门槛（仅 buffSurgeOnly 生效；此刻 surgeOn 已保证在涌流内）
        if (surgeOn) {
          if (cfg.currency === 'relics' && surgeRemainMin < SURGE_RELIC_MIN) { results.push({ k, ok: 'surge', msg: cfg.name + ' 涌流仅剩' + Math.floor(surgeRemainMin) + '分(<' + SURGE_RELIC_MIN + '分)，遗物buff不买' }); continue; }
          if (cfg.currency === 'fragments' && surgeRemainMin < SURGE_FRAGMENT_MIN) { results.push({ k, ok: 'surge', msg: cfg.name + ' 涌流仅剩' + Math.floor(surgeRemainMin) + '分(<' + SURGE_FRAGMENT_MIN + '分)，碎片buff不买' }); continue; }
        }
        const balance = cfg.currency === 'fragments' ? bal.fragments : bal.relics;
        if (balance != null && balance < cfg.price) { results.push({ k, ok: 'balance', msg: cfg.name + ' 余额不足' }); continue; }
        try {
          const res = await signedPost('/api/shop/purchases', { productId: k });
          if (res.ok) {
            buffGroupActiveAt[group] = Date.now();
            results.push({ k, ok: 'bought', msg: cfg.name + ' 已购买' });
          } else {
            let why = String(res.status);
            try { const j = await res.json(); why = (j && (j.error || j.message)) || String(res.status); } catch (_e1) {}
            results.push({ k, ok: 'failed', msg: cfg.name + ' 购买失败(' + (typeof why === 'string' ? why : JSON.stringify(why)) + ')' });
          }
        } catch (e) { results.push({ k, ok: 'failed', msg: cfg.name + ' 购买异常(' + e + ')' }); }
        break; // 同组只买一个
      }
    }
    return { active: activeNow, results };
  }
  // ---- 面板 UI ----
  let buffPanelEl = null;
  function closeBuffPanel() { if (buffPanelEl && buffPanelEl.parentNode) buffPanelEl.parentNode.removeChild(buffPanelEl); buffPanelEl = null; }
  function fmtBuffStatus(active, bal) {
    if (!active.length) return '暂无生效 buff';
    const g = new Map();
    for (const b of active) { const grp = activeBuffGroup(b); if (!grp) continue; const until = new Date(b.endsAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); g.set(grp, until); }
    if (!g.size) return '暂无生效 buff';
    const label = { experience: '经验', strength: '力量', luck: '运气', fragment: '碎片' };
    const sel = buffChecked;
    const parts = [];
    for (const [grp, until] of g) {
      const on = [...sel].filter((k) => BUFF[k].group === grp).map((k) => BUFF[k].name).join('/');
      parts.push(label[grp] ? label[grp] + ' → ' + until + (on ? '(' + on + ')' : '') : grp + ' ' + until);
    }
    let balTxt = '';
    if (bal.relics != null) balTxt += ' 遗物' + bal.relics.toLocaleString();
    if (bal.fragments != null) balTxt += ' 碎片' + bal.fragments.toLocaleString();
    return parts.join('；') + (balTxt || '');
  }
  function openBuffPanel() {
    closeBuffPanel();
    const p = document.createElement('div');
    p.id = 'r1cm-buff-panel';
    const groupsHtml = BUFF_GROUPS.map((g) => {
      const [grp, label] = g;
      const opts = Object.keys(BUFF).filter((k) => BUFF[k].group === grp);
      return '<div style="margin:6px 0 2px;font-size:12px;color:#8b949e;">' + label + '</div>' + opts.map((k) => {
        const c = BUFF[k];
        return '<label style="display:flex;align-items:center;gap:6px;margin:3px 0;font-size:13px;cursor:pointer;">' +
          '<input type="checkbox" data-buff="' + k + '"' + (buffChecked.has(k) ? ' checked' : '') + ' style="cursor:pointer;"/>' +
          '<span>' + c.name + '（' + c.price + (c.currency === 'relics' ? ' 遗物' : ' 碎片') + '）</span></label>';
      }).join('');
    }).join('');
    p.innerHTML = ''
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">'
      + '<b style="font-size:13px;">🏪 遗物商店 buff（勾选才买）</b>'
      + '<span id="r1cm-buff-close" style="cursor:pointer;color:#8b949e;font-size:12px;">✕</span></div>'
      + '<div id="r1cm-buff-status" style="font-size:12px;color:#58a6ff;margin-bottom:6px;word-break:break-all;"></div>'
      + '<label style="display:flex;align-items:center;gap:6px;margin:3px 0 6px;font-size:12px;color:#ffb25a;cursor:pointer;">'
      + '<input type="checkbox" id="r1cm-buff-surgeonly"' + (buffSurgeOnly ? ' checked' : '') + ' style="cursor:pointer;"/>'
      + '<span>仅在奥秘涌流时购买（遗物需涌流剩≥20分；碎片需剩≥90分）</span></label>'
      + groupsHtml
      + '<button id="r1cm-buff-buy" style="margin-top:8px;width:100%;padding:7px;border:none;border-radius:6px;background:#ff8c1a;color:#fff;font-size:13px;cursor:pointer;">立即购买已勾选</button>'
      + '<div id="r1cm-buff-result" style="margin-top:6px;font-size:12px;color:#8b949e;max-height:90px;overflow:auto;"></div>';
    Object.assign(p.style, {
      position: 'fixed', right: '16px', top: '110px', zIndex: '99998', width: '260px', background: '#161b22',
      border: '1px solid #30363d', borderRadius: '10px', padding: '10px 12px', boxShadow: '0 6px 20px rgba(0,0,0,.5)', color: '#e6edf3',
    });
    document.body.appendChild(p);
    buffPanelEl = p;
    const refreshStatus = () => { const s = document.getElementById('r1cm-buff-status'); if (s) s.textContent = '状态：' + fmtBuffStatus(lastActiveBuffs, lastBal); };
    const closeBtn = document.getElementById('r1cm-buff-close');
    if (closeBtn) closeBtn.addEventListener('click', closeBuffPanel);
    // 勾选即自动保存（本地持久化），不用单独点保存
    const surgeEl = document.getElementById('r1cm-buff-surgeonly');
    if (surgeEl) surgeEl.addEventListener('change', () => { buffSurgeOnly = surgeEl.checked; saveBuffChecked(); refreshStatus(); });
    p.querySelectorAll('input[data-buff]').forEach((cb) => cb.addEventListener('change', () => {
      const next = new Set();
      p.querySelectorAll('input[data-buff]:checked').forEach((c) => next.add(c.getAttribute('data-buff')));
      buffChecked = next; saveBuffChecked(); refreshStatus();
    }));
    const buyBtn = document.getElementById('r1cm-buff-buy');
    if (buyBtn) buyBtn.addEventListener('click', async () => {
      const r = document.getElementById('r1cm-buff-result'); if (r) r.textContent = '购买中…';
      const out = await buyCheckedBuffs();
      if (r) r.textContent = out.results.length
        ? out.results.map((x) => (x.ok === 'bought' ? '✅ ' : (x.ok === 'active' ? '⏸ ' : '⚠️ ')) + x.msg).join('；')
        : '（未勾选任何 buff）';
      refreshStatus();
    });
  }
  let lastActiveBuffs = [];
  let lastBal = { relics: null, fragments: null };
  function renderBuffTrigger(heading) {
    lastBal = playerBalance();
    let trig = heading.querySelector('.r1cm-buff-trigger');
    if (!trig) {
      trig = document.createElement('span');
      trig.className = 'r1cm-buff-trigger';
      trig.style.cssText = 'display:inline-flex;align-items:center;gap:3px;background:rgba(255,140,26,.15);border:1px solid rgba(255,140,26,.5);border-radius:10px;padding:2px 7px;font-size:11px;font-weight:600;color:#ffb25a;margin-left:6px;cursor:pointer;user-select:none;';
      trig.textContent = '🏪 Buff';
      trig.addEventListener('click', () => { if (buffPanelEl) closeBuffPanel(); else { openBuffPanel(); renderBuffStatus(); } });
      heading.appendChild(trig);
    }
  }
  async function renderBuffStatus() {
    const st = await fetchActiveBuffs();
    if (st.ok) lastActiveBuffs = st.active;
    lastBal = playerBalance();
    if (buffPanelEl) {
      const s = document.getElementById('r1cm-buff-status');
      if (s) s.textContent = '状态：' + fmtBuffStatus(lastActiveBuffs, lastBal);
    }
  }
  // 定时自动购买：只买「已勾选」的 buff（未勾选一律不买）；并刷新面板状态
  async function buffTick() {
    if (buffChecked.size) {
      const out = await buyCheckedBuffs();
      for (const x of out.results) console.log('[Reelax 保底] Buff', x.k, x.ok, x.msg);
    } else {
      console.log('[Reelax 保底] buffTick 跳过：未勾选任何 buff，buffChecked=', [...buffChecked], 'surgeOnly=', buffSurgeOnly);
    }
    if (buffPanelEl) await renderBuffStatus();
  }
  function startBuff() {
    loadBuffChecked();
    setInterval(() => { try { buffTick(); } catch (_e) {} }, BUFF_POLL_MS);
  }
  startBuff();

  function renderPity(info){
    const h2=document.getElementById('batch-title');
    if(!h2 || !/自动钓鱼/.test(h2.textContent||'')) return;
    const heading=h2.closest('.panel-heading');
    if(!heading) return;
    renderBuffTrigger(heading);
    let el=heading.querySelector('.reelax-pity-mark');
    if(!el){ el=document.createElement('span'); el.className='reelax-pity-mark'; el.style.cssText='display:inline-flex;align-items:center;flex-wrap:wrap;margin-left:10px;'; heading.appendChild(el); }
    el.textContent='';
    if(!info){ const s=document.createElement('span'); s.textContent='加载中…'; s.style.color='#888'; el.appendChild(s); return; }
    // +25% 运触发器放最前
    el.appendChild(boostTrigger(info));
    const colorOf=(cls)=> cls==='bad'?'#f85149':cls==='warn'?'#e3b341':'#3fb950';
    if(info.effectiveLuck!=null) el.appendChild(luckTag(info.effectiveLuck));
    el.appendChild(pityChip('奥秘', info.arcane, colorOf(info.arcane.cls)));
    el.appendChild(pityChip('奇异', info.exotic, colorOf(info.exotic.cls)));
    const fmtDetail=(n,d)=>n+' '+ (d.pct!=null?d.pct.toFixed(1)+'%':'—')+'（'+d.cur+'/'+d.max+'/'+d.hard+'）'+(d.remain?' · '+d.remain:'');
    console.log('[Reelax 保底] '+fmtDetail('奥秘',info.arcane)+' | '+fmtDetail('奇异',info.exotic)+(info.effectiveLuck!=null?' | 有效运气 '+info.effectiveLuck:''));
  }
  let latest=null;
  async function tick(){
    try{ const res=await signedGet('/api/statistics'); if(res.ok) latest=computePity(await res.json()); else latest=null; }catch(e){ latest=null; }
    renderPity(latest);
  }
  setInterval(tick, REFRESH_MS);
  setInterval(()=>renderPity(latest), RENDER_MS);
  tick();
})();
