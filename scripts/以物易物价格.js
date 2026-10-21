// ==UserScript==
// @name         Reelax 以物易物市场最低价
// @namespace    reelax-barter-price
// @version      1.0.0
// @description  在「以物易物（barter）交换列表」的每张卡片 footer 加「更新价格」按钮。
//               点击后查询当前整页所有卡片里每条鱼的市场最低卖价，并显示在鱼名下方。
//               仅在用户点击时才发起查询，不做自动轮询。
// @match        https://reelax.cn/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  if (window.__reelaxBarterPrice__) return;
  window.__reelaxBarterPrice__ = true;

  const TAG = '[以物易物价格]';

  // ---------- 签名 API 中继（经 injector.js 页面上下文签名 fetch，与一键市场.js 同模式） ----------
  let _reqSeq = 0;
  const _pending = new Map();
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (d && d.__reelaxApiResponse && _pending.has(d.id)) {
      const cb = _pending.get(d.id);
      _pending.delete(d.id);
      cb(d);
    }
  });
  function api(path, method, body) {
    const id = ++_reqSeq;
    const payload = {
      __reelaxApiRequest: true, id, path,
      method: method || 'GET', body: (body === undefined ? null : body),
    };
    if (!window.postMessage) return Promise.resolve({ ok: false, error: 'no-postMessage' });
    window.postMessage(payload, '*');
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (_pending.has(id)) { _pending.delete(id); resolve({ ok: false, error: 'api-timeout', path }); }
      }, 20000);
      _pending.set(id, (r) => { clearTimeout(timeout); resolve(r); });
    });
  }
  // 返回增强版结果，含诊断字段：{ ok, data, error, status, body, rawBody }
  async function getJSON(path) {
    const r = await api(path, 'GET', null);
    if (!r) return { ok: false, error: 'no-response' };
    if (!r.ok) return { ok: false, error: r.error || ('status:' + r.status), status: r.status, body: r.body };
    try { return { ok: true, data: JSON.parse(r.body), rawBody: r.body }; }
    catch (e) { return { ok: false, error: 'json-parse-fail', body: (r.body || '').slice(0, 400) }; }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function fmtGold(n) { return (n == null || n === '' ? '—' : Number(n).toLocaleString()); }
  let _debuggedMiss = new Set(); // 已诊断过「未匹配」的鱼名，避免刷屏

  // ---------- 名称 → fishId 映射（硬编码鱼种表，零请求） ----------
  // overview / 交换单页面只有鱼名，市场 order-book 接口要 fishId。
  // 原实现每次点「更新价格」都要拉 /api/biomes + 逐图 /api/fishpedia 建名字表，
  // 15 张图串行连发极易被限流 → fishpediaFails 高达 5~12 → 表残缺 → 「未匹配到鱼」。
  // 现改为与「捡漏」同源：直接硬编码 [fishId, name] 全量鱼种表，查价零网络开销。
  // 数据来源：与 一键市场.js 的 HARD_FISH 完全一致（由 /api/fishpedia 一次性采集，共 990 种）。
  // 游戏更新鱼种后，两处需同步手动更新。
  const HARD_FISH = [
    ['b_001_arcane_01', '水车纪元鲟'],
    ['b_001_arcane_02', '月桂星河鳐'],
    ['b_001_arcane_03', '蚀月溪歌姬'],
    ['b_001_arcane_04', '溪源三相龙鲤'],
    ['b_001_arcane_05', '银潮梦鹿鲸'],
    ['b_001_common_01', '银星溪鲦'],
    ['b_001_common_02', '青苔石鳅'],
    ['b_001_common_03', '水车纹鲫'],
    ['b_001_common_04', '柳叶青鳉'],
    ['b_001_common_05', '泉须小鲶'],
    ['b_001_common_06', '赤鳍马口'],
    ['b_001_common_07', '月点麦穗鱼'],
    ['b_001_common_08', '圆石吻虾虎'],
    ['b_001_common_09', '浅湾花鳅'],
    ['b_001_common_10', '溪铃白条'],
    ['b_001_common_11', '苇影鳉'],
    ['b_001_common_12', '露背小鳟'],
    ['b_001_epic_01', '玻璃鳍溪龙鱼'],
    ['b_001_epic_02', '月桂王冠鳜'],
    ['b_001_epic_03', '银瀑织流鲤'],
    ['b_001_epic_04', '星钟灯鱼'],
    ['b_001_epic_05', '夜灯王鳗'],
    ['b_001_epic_06', '虹脊古鲟'],
    ['b_001_epic_07', '月轮翼鳐'],
    ['b_001_epic_08', '水车圣轮鲑'],
    ['b_001_exotic_01', '月影双生斗鱼'],
    ['b_001_exotic_02', '露相千折鳐'],
    ['b_001_exotic_03', '逆瀑琴尾鲶'],
    ['b_001_exotic_04', '梦藻无眠鲤'],
    ['b_001_exotic_05', '溪星拾光蟹'],
    ['b_001_fine_01', '星斑鳜'],
    ['b_001_fine_02', '玉鳍光唇鱼'],
    ['b_001_fine_03', '月盏河鲀'],
    ['b_001_fine_04', '霜翼溪鳟'],
    ['b_001_fine_05', '镜尾弓背鱼'],
    ['b_001_fine_06', '苔舟翘嘴鲌'],
    ['b_001_fine_07', '银冠溪鲈'],
    ['b_001_fine_08', '蓝焰月鳗'],
    ['b_001_legendary_01', '月角河鳐'],
    ['b_001_legendary_02', '古渠镇水鲟'],
    ['b_001_legendary_03', '银瀑九尾鲤'],
    ['b_001_legendary_04', '水车心核鳜'],
    ['b_001_legendary_05', '巡月玄龟'],
    ['b_001_mythic_01', '命轮月鳗'],
    ['b_001_mythic_02', '初潮轮羽龙鱼'],
    ['b_001_mythic_03', '神谕镜甲鲟'],
    ['b_001_mythic_04', '赤曜睡莲灵'],
    ['b_001_mythic_05', '霜月古龙鲑'],
    ['b_001_rare_01', '月藤蛇鳝'],
    ['b_001_rare_02', '露冠飞鳍鱼'],
    ['b_001_rare_03', '紫弦虹鳟'],
    ['b_001_rare_04', '梦涡六须鲶'],
    ['b_001_rare_05', '镜鳞月鳊'],
    ['b_001_rare_06', '月笛长鳗'],
    ['b_001_rare_07', '苔背骨舌鱼'],
    ['b_001_rare_08', '流萤羽鳃鲑'],
    ['b_001_uncommon_01', '月纱溪鲤'],
    ['b_001_uncommon_02', '苔冠溪鱲'],
    ['b_001_uncommon_03', '涟轮月鳊'],
    ['b_001_uncommon_04', '银梭青鳉'],
    ['b_001_uncommon_05', '石鼓杜父鱼'],
    ['b_001_uncommon_06', '月露灯眼鱼'],
    ['b_001_uncommon_07', '苇刀针鱼'],
    ['b_001_uncommon_08', '溪琴鳑鲏'],
    ['b_001_uncommon_09', '泉眼沙塘鳢'],
    ['b_001_uncommon_10', '水轮鳗鲡'],
    ['b_002_arcane_01', '雾冠六鳃天鳢'],
    ['b_002_arcane_02', '万苇听潮鲶'],
    ['b_002_arcane_03', '荷灯水母娘'],
    ['b_002_arcane_04', '洪季年轮骨舌鱼'],
    ['b_002_arcane_05', '泽心脉络鳐'],
    ['b_002_common_01', '雾苇泥鳅'],
    ['b_002_common_02', '灰腹鳑鲏'],
    ['b_002_common_03', '芦影青鳉'],
    ['b_002_common_04', '泥湾小鲫'],
    ['b_002_common_05', '荷梗麦穗鱼'],
    ['b_002_common_06', '沼须小鲶'],
    ['b_002_common_07', '睡莲鳉'],
    ['b_002_common_08', '腐木虾虎'],
    ['b_002_common_09', '苔背月鳢'],
    ['b_002_common_10', '浅泥银鳊'],
    ['b_002_common_11', '露鳍溪鱲'],
    ['b_002_common_12', '雾点泽虾'],
    ['b_002_epic_01', '玻璃荷冠鳜'],
    ['b_002_epic_02', '雾钟灯笼鱼'],
    ['b_002_epic_03', '芦海织流鲤'],
    ['b_002_epic_04', '夜沼王鳗'],
    ['b_002_epic_05', '古荷虹脊鲟'],
    ['b_002_epic_06', '泥宫圣轮鲑'],
    ['b_002_epic_07', '百泡淡水蚌'],
    ['b_002_epic_08', '雾幕水母'],
    ['b_002_exotic_01', '沉雾灯笼鳢'],
    ['b_002_exotic_02', '倒生芦骨鳗'],
    ['b_002_exotic_03', '宿雨空腔鲶'],
    ['b_002_exotic_04', '泥梦折扇章'],
    ['b_002_exotic_05', '百刻睡莲鼋'],
    ['b_002_fine_01', '青灯七鳃鳗'],
    ['b_002_fine_02', '翡翠荷鳍鲤'],
    ['b_002_fine_03', '霜苇长吻鳅'],
    ['b_002_fine_04', '泥金冠鳢'],
    ['b_002_fine_05', '镜荷月鲫'],
    ['b_002_fine_06', '紫雾丝足鲈'],
    ['b_002_fine_07', '腐木铠鲶'],
    ['b_002_fine_08', '荷灯水母'],
    ['b_002_legendary_01', '芦王巨鳢'],
    ['b_002_legendary_02', '古沼泥甲鲟'],
    ['b_002_legendary_03', '百叶莲鲤'],
    ['b_002_legendary_04', '雾潮六须鲶'],
    ['b_002_legendary_05', '守沼老鼋'],
    ['b_002_mythic_01', '万苇听风鳗'],
    ['b_002_mythic_02', '初泥四环古鱼'],
    ['b_002_mythic_03', '神谕荷镜鲤'],
    ['b_002_mythic_04', '腐木轮回鲟'],
    ['b_002_mythic_05', '万荷梦姬'],
    ['b_002_rare_01', '梦雾六须鲶'],
    ['b_002_rare_02', '千叶鳍鲤'],
    ['b_002_rare_03', '泥月镜鳢'],
    ['b_002_rare_04', '芦笛长鳗'],
    ['b_002_rare_05', '萤河骨舌鱼'],
    ['b_002_rare_06', '荷露飞鳍鱼'],
    ['b_002_rare_07', '紫沼河蟹'],
    ['b_002_rare_08', '苔宫沼螺'],
    ['b_002_uncommon_01', '雾纱斗鱼'],
    ['b_002_uncommon_02', '芦刀针鱼'],
    ['b_002_uncommon_03', '泥镜月鳢'],
    ['b_002_uncommon_04', '萤腹塘鳢'],
    ['b_002_uncommon_05', '苇琴鳑鲏'],
    ['b_002_uncommon_06', '荷冠溪鲤'],
    ['b_002_uncommon_07', '泡眼沼鲶'],
    ['b_002_uncommon_08', '灰羽翘嘴鲌'],
    ['b_002_uncommon_09', '沼纹鳗鲡'],
    ['b_002_uncommon_10', '冷露田螺'],
    ['b_003_arcane_01', '白礁圣冠海龙'],
    ['b_003_arcane_02', '日轮虹帆旗鱼'],
    ['b_003_arcane_03', '珠潮人鱼祭司'],
    ['b_003_arcane_04', '千礁共生巨鳐'],
    ['b_003_arcane_05', '万潮镜瞳鲸鲨'],
    ['b_003_common_01', '珠沙小鳀'],
    ['b_003_common_02', '镜湾银鲳'],
    ['b_003_common_03', '珊枝虾虎'],
    ['b_003_common_04', '白礁隆头鱼'],
    ['b_003_common_05', '潮池青鳉'],
    ['b_003_common_06', '玻鳍小鳀'],
    ['b_003_common_07', '贝纹小石斑'],
    ['b_003_common_08', '盐线针鱼'],
    ['b_003_common_09', '蓝沫幼鲷'],
    ['b_003_common_10', '海窗鳚'],
    ['b_003_common_11', '晴礁雀鲷'],
    ['b_003_common_12', '透尾樱虾'],
    ['b_003_epic_01', '万镜鳞鲤'],
    ['b_003_epic_02', '珊瑚王冠鳜'],
    ['b_003_epic_03', '珠海织流鲷'],
    ['b_003_epic_04', '星窗灯鱼'],
    ['b_003_epic_05', '镜夜王鳗'],
    ['b_003_epic_06', '圣礁轮鳐'],
    ['b_003_epic_07', '虹脊砗磲'],
    ['b_003_epic_08', '潮宫章鱼'],
    ['b_003_exotic_01', '棱潮万色蝶鱼'],
    ['b_003_exotic_02', '贝壳迷宫河鲀'],
    ['b_003_exotic_03', '昼夜双面翻车鱼'],
    ['b_003_exotic_04', '轨星珠链章'],
    ['b_003_exotic_05', '潮历书甲龟'],
    ['b_003_fine_01', '虹膜月鱼'],
    ['b_003_fine_02', '玻璃珊鲈'],
    ['b_003_fine_03', '珠冠刺尾鱼'],
    ['b_003_fine_04', '潮盏河鲀'],
    ['b_003_fine_05', '镜翼燕鱼'],
    ['b_003_fine_06', '盐花狮子鱼'],
    ['b_003_fine_07', '珊琴石斑'],
    ['b_003_fine_08', '蓝窗海兔'],
    ['b_003_legendary_01', '镜海月鳐'],
    ['b_003_legendary_02', '白礁镇潮鲟'],
    ['b_003_legendary_03', '珊王九尾鲷'],
    ['b_003_legendary_04', '珠心巨鳜'],
    ['b_003_legendary_05', '守潮砗磲'],
    ['b_003_mythic_01', '万潮听海鳗'],
    ['b_003_mythic_02', '初礁环鳍龙鱼'],
    ['b_003_mythic_03', '神谕珠镜鲤'],
    ['b_003_mythic_04', '千窗轮回鲟'],
    ['b_003_mythic_05', '珊宫潮姬'],
    ['b_003_rare_01', '镜潮六翼鲷'],
    ['b_003_rare_02', '珊宫龙鱼'],
    ['b_003_rare_03', '珠月灯笼鱼'],
    ['b_003_rare_04', '盐镜王鲳'],
    ['b_003_rare_05', '潮笛绸带鳗'],
    ['b_003_rare_06', '玻璃礁鳐'],
    ['b_003_rare_07', '虹珊海星'],
    ['b_003_rare_08', '海沫羽鳃海蛞蝓'],
    ['b_003_uncommon_01', '镜鳞蝴蝶鱼'],
    ['b_003_uncommon_02', '珊冠红娘鱼'],
    ['b_003_uncommon_03', '潮纱海马'],
    ['b_003_uncommon_04', '盐晶河鲀'],
    ['b_003_uncommon_05', '贝歌石首鱼'],
    ['b_003_uncommon_06', '晴浪鹦嘴鱼'],
    ['b_003_uncommon_07', '镜潮鳗鲡'],
    ['b_003_uncommon_08', '珠帘须鲷'],
    ['b_003_uncommon_09', '海窗四眼鱼'],
    ['b_003_uncommon_10', '珊影寄居蟹'],
    ['b_004_arcane_01', '裂云九帆龙鱼'],
    ['b_004_arcane_02', '霆瀑铸脊帝鲑'],
    ['b_004_arcane_03', '风暴鳐翼姬'],
    ['b_004_arcane_04', '天衡双翼巨鳐'],
    ['b_004_arcane_05', '雷脉王骨鳕'],
    ['b_004_common_01', '铁背小鳕'],
    ['b_004_common_02', '崖影幼鲑'],
    ['b_004_common_03', '风鳍青花鱼'],
    ['b_004_common_04', '岩吻虾虎'],
    ['b_004_common_05', '雷点溪鳟'],
    ['b_004_common_06', '裂湾小鲱'],
    ['b_004_common_07', '冷流针鱼'],
    ['b_004_common_08', '云腹鳕'],
    ['b_004_common_09', '锚纹杜父鱼'],
    ['b_004_common_10', '暴雨银鱼'],
    ['b_004_common_11', '黑礁鳚'],
    ['b_004_common_12', '闪尾磷虾'],
    ['b_004_epic_01', '玻璃雷鳍龙鱼'],
    ['b_004_epic_02', '风暴王冠鳜'],
    ['b_004_epic_03', '银瀑织流鲑'],
    ['b_004_epic_04', '雷钟星灯鱼'],
    ['b_004_epic_05', '永夜霆鳗'],
    ['b_004_epic_06', '虹脊古鳕'],
    ['b_004_epic_07', '峡湾圣轮水母'],
    ['b_004_epic_08', '雷痕巨章鱼'],
    ['b_004_exotic_01', '雷前闪鲭'],
    ['b_004_exotic_02', '风眼盘鳗'],
    ['b_004_exotic_03', '极性锚甲鲟'],
    ['b_004_exotic_04', '断雷八臂章'],
    ['b_004_exotic_05', '静界霆冠水母'],
    ['b_004_fine_01', '雷冠狮子鱼'],
    ['b_004_fine_02', '风壁鳐'],
    ['b_004_fine_03', '霆纹鳄雀鳝'],
    ['b_004_fine_04', '崖钟灯鱼'],
    ['b_004_fine_05', '银锚大比目鱼'],
    ['b_004_fine_06', '暴雨琴鲭'],
    ['b_004_fine_07', '铁甲狼鳗'],
    ['b_004_fine_08', '冷虹海葵'],
    ['b_004_legendary_01', '月角风暴鳐'],
    ['b_004_legendary_02', '古峡镇流鲟'],
    ['b_004_legendary_03', '银瀑九尾鲑'],
    ['b_004_legendary_04', '雷心巨鳕'],
    ['b_004_legendary_05', '雷甲海龟'],
    ['b_004_mythic_01', '万风听海鳗'],
    ['b_004_mythic_02', '初雷四环电鳗'],
    ['b_004_mythic_03', '神谕风镜鲑'],
    ['b_004_mythic_04', '终崖轮回鲟'],
    ['b_004_mythic_05', '雷潮风暴姬'],
    ['b_004_rare_01', '雷幕六鳍鳕'],
    ['b_004_rare_02', '裂峡龙鱼'],
    ['b_004_rare_03', '风笛长鳗'],
    ['b_004_rare_04', '镜雷王鳟'],
    ['b_004_rare_05', '云铠古鲟'],
    ['b_004_rare_06', '霆羽飞鳍鱼'],
    ['b_004_rare_07', '怒潮帝王蟹'],
    ['b_004_rare_08', '闪石海胆'],
    ['b_004_uncommon_01', '风锚石斑'],
    ['b_004_uncommon_02', '雷线青鳕'],
    ['b_004_uncommon_03', '裂浪梭鱼'],
    ['b_004_uncommon_04', '崖冠虹鳟'],
    ['b_004_uncommon_05', '电泡河鲀'],
    ['b_004_uncommon_06', '冷雾长鳗'],
    ['b_004_uncommon_07', '云裂飞鱼'],
    ['b_004_uncommon_08', '铁须海鲶'],
    ['b_004_uncommon_09', '暴潮圆鲳'],
    ['b_004_uncommon_10', '闪脊海螺'],
    ['b_005_arcane_01', '万根归海鲟'],
    ['b_005_arcane_02', '星髓王冠腔棘鱼'],
    ['b_005_arcane_03', '晶根洞螈女王'],
    ['b_005_arcane_04', '地心脉动翼灵'],
    ['b_005_arcane_05', '无昼创世盲龙鱼'],
    ['b_005_common_01', '幽苔盲鳅'],
    ['b_005_common_02', '晶须穴鲶'],
    ['b_005_common_03', '星点洞鳉'],
    ['b_005_common_04', '根影虾虎'],
    ['b_005_common_05', '暗河银鱼'],
    ['b_005_common_06', '石吻鳢'],
    ['b_005_common_07', '萤腹小鳟'],
    ['b_005_common_08', '洞泉鲫'],
    ['b_005_common_09', '退目鳚'],
    ['b_005_common_10', '岩缝麦穗鱼'],
    ['b_005_common_11', '夜晶鳊'],
    ['b_005_common_12', '苔尾洞虾'],
    ['b_005_epic_01', '星根圣冠鱼'],
    ['b_005_epic_02', '无昼月鳗'],
    ['b_005_epic_03', '晶河帝王鲑'],
    ['b_005_epic_04', '地脉龙首鳅'],
    ['b_005_epic_05', '万年苔甲鲟'],
    ['b_005_epic_06', '星窟玻璃水母'],
    ['b_005_epic_07', '根王巨螯蟹'],
    ['b_005_epic_08', '夜晶十二鳍'],
    ['b_005_exotic_01', '盲星回声鲶'],
    ['b_005_exotic_02', '反重晶腹鳐'],
    ['b_005_exotic_03', '食光苔冠鳢'],
    ['b_005_exotic_04', '根脉折跃鳗'],
    ['b_005_exotic_05', '地晶梦壳螈'],
    ['b_005_fine_01', '星根骨舌鱼'],
    ['b_005_fine_02', '月窟银龙鱼'],
    ['b_005_fine_03', '晶盔狼鳗'],
    ['b_005_fine_04', '萤幕六鳍鲶'],
    ['b_005_fine_05', '地脉赤鳟'],
    ['b_005_fine_06', '石花比目鱼'],
    ['b_005_fine_07', '夜髓古鲟'],
    ['b_005_fine_08', '根笛洞螈'],
    ['b_005_legendary_01', '月髓皇冠鲈'],
    ['b_005_legendary_02', '星根盘龙鳗'],
    ['b_005_legendary_03', '万晶地宫鳐'],
    ['b_005_legendary_04', '初泉祖鲟'],
    ['b_005_legendary_05', '背碑洞鼋'],
    ['b_005_mythic_01', '地心星脉鱼'],
    ['b_005_mythic_02', '万夜守灯鳗'],
    ['b_005_mythic_03', '神木根冠鲑'],
    ['b_005_mythic_04', '无声晶翼蝠鲼'],
    ['b_005_mythic_05', '星根梦灵'],
    ['b_005_rare_01', '万晶王鲤'],
    ['b_005_rare_02', '星井吞光鳗'],
    ['b_005_rare_03', '古根六须鲶'],
    ['b_005_rare_04', '月脉盲鳐'],
    ['b_005_rare_05', '晶冠洞鳢'],
    ['b_005_rare_06', '地心镜鲑'],
    ['b_005_rare_07', '萤河盲蟹'],
    ['b_005_rare_08', '黑曜洞螯虾'],
    ['b_005_uncommon_01', '月髓盲鲈'],
    ['b_005_uncommon_02', '晶簇石斑'],
    ['b_005_uncommon_03', '根须长鳗'],
    ['b_005_uncommon_04', '萤线虹鳟'],
    ['b_005_uncommon_05', '暗泉玻璃鲶'],
    ['b_005_uncommon_06', '星砂鳅'],
    ['b_005_uncommon_07', '石环七鳃鳗'],
    ['b_005_uncommon_08', '苔冠月鱼'],
    ['b_005_uncommon_09', '洞钟灯鱼'],
    ['b_005_uncommon_10', '晶脊洞螺'],
    ['b_006_arcane_01', '天候编纬鲤'],
    ['b_006_arcane_02', '百鸟归航龙鱼'],
    ['b_006_arcane_03', '湖心倒悬鼋'],
    ['b_006_arcane_04', '四野息风巨鲶'],
    ['b_006_arcane_05', '霞原候鸟姬'],
    ['b_006_common_01', '霞鳞湖鲫'],
    ['b_006_common_02', '风尾白鲦'],
    ['b_006_common_03', '苇影小鲈'],
    ['b_006_common_04', '晴腹鳑鲏'],
    ['b_006_common_05', '花斑泥鳅'],
    ['b_006_common_06', '雁羽麦穗鱼'],
    ['b_006_common_07', '暖湾鳟'],
    ['b_006_common_08', '露珠虾虎'],
    ['b_006_common_09', '云底银鱼'],
    ['b_006_common_10', '草香鳢'],
    ['b_006_common_11', '夕照小鳊'],
    ['b_006_common_12', '铃尾湖虾'],
    ['b_006_epic_01', '霞栖圣羽鱼'],
    ['b_006_epic_02', '万风巡湖旗鱼'],
    ['b_006_epic_03', '晴空镜龙鱼'],
    ['b_006_epic_04', '百花冠王鲤'],
    ['b_006_epic_05', '雁门破浪鲑'],
    ['b_006_epic_06', '金露帝王鲶'],
    ['b_006_epic_07', '虹原羽鳃螺'],
    ['b_006_epic_08', '夕阳绒螯蟹'],
    ['b_006_exotic_01', '迟暮跳时鱼'],
    ['b_006_exotic_02', '借季花鳞鲫'],
    ['b_006_exotic_03', '风洞回声鲶'],
    ['b_006_exotic_04', '断岸跃门鲑'],
    ['b_006_exotic_05', '云脚露囊章鱼'],
    ['b_006_fine_01', '霞幕六鳍鱼'],
    ['b_006_fine_02', '风车鳍鲈'],
    ['b_006_fine_03', '晴穹骨舌鱼'],
    ['b_006_fine_04', '百花王鲤'],
    ['b_006_fine_05', '雁书长鳗'],
    ['b_006_fine_06', '金露灯鱼'],
    ['b_006_fine_07', '湖原角鲶'],
    ['b_006_fine_08', '夕虹水母'],
    ['b_006_legendary_01', '九霞天衣鲤'],
    ['b_006_legendary_02', '牧风神鳟'],
    ['b_006_legendary_03', '万花湖心鲈'],
    ['b_006_legendary_04', '日轮金龙鱼'],
    ['b_006_legendary_05', '驮岬老鼋'],
    ['b_006_mythic_01', '北汀驼峰鲑'],
    ['b_006_mythic_02', '雁路司南鳗'],
    ['b_006_mythic_03', '暮霞蓄光鲤'],
    ['b_006_mythic_04', '苇海鸣簧鲈'],
    ['b_006_mythic_05', '牧风毡翼鳐'],
    ['b_006_rare_01', '万霞织鳍鲑'],
    ['b_006_rare_02', '风庭王鲈'],
    ['b_006_rare_03', '花海巨鲤'],
    ['b_006_rare_04', '晴日金枪鱼'],
    ['b_006_rare_05', '雁回月鳗'],
    ['b_006_rare_06', '草原六须鲶'],
    ['b_006_rare_07', '朝露湖蟹'],
    ['b_006_rare_08', '湖歌淡水蚌'],
    ['b_006_uncommon_01', '霞冠虹鳟'],
    ['b_006_uncommon_02', '风纹草鱼'],
    ['b_006_uncommon_03', '草原芦笛鳗'],
    ['b_006_uncommon_04', '晴镜圆鲳'],
    ['b_006_uncommon_05', '花原锦鲤'],
    ['b_006_uncommon_06', '雁阵梭鱼'],
    ['b_006_uncommon_07', '露环鲶'],
    ['b_006_uncommon_08', '暖云月鱼'],
    ['b_006_uncommon_09', '牧风银鲑'],
    ['b_006_uncommon_10', '芳草湖螺'],
    ['b_007_arcane_01', '穹湖脉络龙鱼'],
    ['b_007_arcane_02', '万阶升潮鳐'],
    ['b_007_arcane_03', '天底倒映鲲'],
    ['b_007_arcane_04', '雷虹播种鲟'],
    ['b_007_arcane_05', '悬湖守汐姬'],
    ['b_007_common_01', '云腹小鲫'],
    ['b_007_common_02', '汐纹银鲦'],
    ['b_007_common_03', '浮叶鳑鲏'],
    ['b_007_common_04', '天光鳉'],
    ['b_007_common_05', '瀑尾小鳟'],
    ['b_007_common_06', '风铃虾虎'],
    ['b_007_common_07', '悬湖泥鳅'],
    ['b_007_common_08', '云影小鲈'],
    ['b_007_common_09', '露珠银鱼'],
    ['b_007_common_10', '岚鳍鳚'],
    ['b_007_common_11', '天池麦穗鱼'],
    ['b_007_common_12', '羽尾云虾'],
    ['b_007_epic_01', '九霄云龙鱼'],
    ['b_007_epic_02', '万风圣翼鳐'],
    ['b_007_epic_03', '浮岛王鲟'],
    ['b_007_epic_04', '天河倒游鲑'],
    ['b_007_epic_05', '云门冠鳢'],
    ['b_007_epic_06', '虹梯六翼飞鱼'],
    ['b_007_epic_07', '风铃浮螺'],
    ['b_007_epic_08', '星露云水母'],
    ['b_007_exotic_01', '落向未定鱼'],
    ['b_007_exotic_02', '缺岸洄游鲑'],
    ['b_007_exotic_03', '零重壳月螺'],
    ['b_007_exotic_04', '云层剪影乌贼'],
    ['b_007_exotic_05', '反瀑滴轮水母'],
    ['b_007_fine_01', '天河银龙鱼'],
    ['b_007_fine_02', '云梯九鳍鲑'],
    ['b_007_fine_03', '风眼镜鳐'],
    ['b_007_fine_04', '浮光帝王鲤'],
    ['b_007_fine_05', '瀑琴长鳗'],
    ['b_007_fine_06', '云港锚纹鲟'],
    ['b_007_fine_07', '天露六须鲶'],
    ['b_007_fine_08', '虹桥水母'],
    ['b_007_legendary_01', '云汐天冠龙鱼'],
    ['b_007_legendary_02', '万瀑归一鳗'],
    ['b_007_legendary_03', '神风镜翼鳐'],
    ['b_007_legendary_04', '天岛祖鲟'],
    ['b_007_legendary_05', '浮岛云龟'],
    ['b_007_mythic_01', '升瀑银梭'],
    ['b_007_mythic_02', '浮囊琴鲂'],
    ['b_007_mythic_03', '云脊帆鲟'],
    ['b_007_mythic_04', '虹汐螺旋鳗'],
    ['b_007_mythic_05', '岛根抱石鲶'],
    ['b_007_rare_01', '云海王冠鲈'],
    ['b_007_rare_02', '天穹织风鳟'],
    ['b_007_rare_03', '无岸浮岛鱼'],
    ['b_007_rare_04', '汐月双尾鲑'],
    ['b_007_rare_05', '瀑门龙鳗'],
    ['b_007_rare_06', '浮岛古鲟'],
    ['b_007_rare_07', '风羽云蟹'],
    ['b_007_rare_08', '天镜星海兔'],
    ['b_007_uncommon_01', '云冠虹鳟'],
    ['b_007_uncommon_02', '风帆草鱼'],
    ['b_007_uncommon_03', '悬瀑长鳗'],
    ['b_007_uncommon_04', '天镜圆鲳'],
    ['b_007_uncommon_05', '浮岛石斑'],
    ['b_007_uncommon_06', '汐钟灯鱼'],
    ['b_007_uncommon_07', '云须鲶'],
    ['b_007_uncommon_08', '羽翼飞鱼'],
    ['b_007_uncommon_09', '晴空骨舌鱼'],
    ['b_007_uncommon_10', '雾环天螺'],
    ['b_008_arcane_01', '赤海回春龙鱼'],
    ['b_008_arcane_02', '地核冷泉鲟'],
    ['b_008_arcane_03', '千绿洲星盘鳐'],
    ['b_008_arcane_04', '沙暴饮潮海牛'],
    ['b_008_arcane_05', '泉脉司水姬'],
    ['b_008_common_01', '赤砂小鲫'],
    ['b_008_common_02', '泉眼青鳉'],
    ['b_008_common_03', '金背泥鳅'],
    ['b_008_common_04', '绿洲鳑鲏'],
    ['b_008_common_05', '沙纹虾虎'],
    ['b_008_common_06', '暖泉小鳟'],
    ['b_008_common_07', '日斑麦穗鱼'],
    ['b_008_common_08', '苇尾鳢'],
    ['b_008_common_09', '砾吻鲶'],
    ['b_008_common_10', '涌泉银鱼'],
    ['b_008_common_11', '赤鳍鳚'],
    ['b_008_common_12', '琥珀泉虾'],
    ['b_008_epic_01', '九阳赤龙鱼'],
    ['b_008_epic_02', '万泉织流鲑'],
    ['b_008_epic_03', '绿洲圣冠鲤'],
    ['b_008_epic_04', '赤砂风暴鳐'],
    ['b_008_epic_05', '地火王甲鲟'],
    ['b_008_epic_06', '蜃楼镜鳢'],
    ['b_008_epic_07', '熔砂巨虾'],
    ['b_008_epic_08', '日轮章鱼'],
    ['b_008_exotic_01', '沸点漂移鲈'],
    ['b_008_exotic_02', '失水仍游鳐'],
    ['b_008_exotic_03', '百井同声鲶'],
    ['b_008_exotic_04', '沙纹自改章鱼'],
    ['b_008_exotic_05', '夜泉倒影龟'],
    ['b_008_fine_01', '日轮骨舌鱼'],
    ['b_008_fine_02', '赤脉龙鱼'],
    ['b_008_fine_03', '绿洲花冠鲤'],
    ['b_008_fine_04', '涌泉六翼鳐'],
    ['b_008_fine_05', '沙钟灯笼鱼'],
    ['b_008_fine_06', '赤砾狼鳗'],
    ['b_008_fine_07', '晴热王鲈'],
    ['b_008_fine_08', '火脉绒螯蟹'],
    ['b_008_legendary_01', '赤砂天冠肺鱼'],
    ['b_008_legendary_02', '万泉祖龙鱼'],
    ['b_008_legendary_03', '绿洲神树鲤'],
    ['b_008_legendary_04', '日蚀赤鳐'],
    ['b_008_legendary_05', '驮泉沙龟'],
    ['b_008_mythic_01', '盐冠储潮鲷'],
    ['b_008_mythic_02', '昼夜换鳃鲶'],
    ['b_008_mythic_03', '赤砾钻泉鳗'],
    ['b_008_mythic_04', '蜃叶呼雨鱼'],
    ['b_008_mythic_05', '琥珀沙钟螈'],
    ['b_008_rare_01', '万砂星鳞鲤'],
    ['b_008_rare_02', '地泉龙首鳅'],
    ['b_008_rare_03', '赤日镜鳐'],
    ['b_008_rare_04', '绿洲帝王鲑'],
    ['b_008_rare_05', '沙海长鬃鳗'],
    ['b_008_rare_06', '泉冠古鲟'],
    ['b_008_rare_07', '绿洲月贝'],
    ['b_008_rare_08', '蜃幕水母'],
    ['b_008_uncommon_01', '赤霞虹鳟'],
    ['b_008_uncommon_02', '泉脉草鱼'],
    ['b_008_uncommon_03', '沙帆月鱼'],
    ['b_008_uncommon_04', '绿洲镜鲤'],
    ['b_008_uncommon_05', '热雾长鳗'],
    ['b_008_uncommon_06', '日针梭鱼'],
    ['b_008_uncommon_07', '泉铃灯鱼'],
    ['b_008_uncommon_08', '砂甲小鲟'],
    ['b_008_uncommon_09', '苇影六须鲶'],
    ['b_008_uncommon_10', '沙铃泉螺'],
    ['b_009_arcane_01', '极冠定星龙鳕'],
    ['b_009_arcane_02', '万载浮冰鼋'],
    ['b_009_arcane_03', '曙线开海鳐'],
    ['b_009_arcane_04', '极夜孵光鲸'],
    ['b_009_arcane_05', '极光巡湾姬'],
    ['b_009_common_01', '霜鳞小鳕'],
    ['b_009_common_02', '冰湾幼鲑'],
    ['b_009_common_03', '雪腹小鲱'],
    ['b_009_common_04', '极光青花鱼'],
    ['b_009_common_05', '冰缝虾虎'],
    ['b_009_common_06', '冻露针鱼'],
    ['b_009_common_07', '白夜银鱼'],
    ['b_009_common_08', '冰砂泥鳅'],
    ['b_009_common_09', '雪冠鳚'],
    ['b_009_common_10', '寒潮小鲈'],
    ['b_009_common_11', '冰晶麦穗鱼'],
    ['b_009_common_12', '蓝雪磷虾'],
    ['b_009_epic_01', '九曜极光鱼'],
    ['b_009_epic_02', '冰湾圣冠旗鱼'],
    ['b_009_epic_03', '永昼天镜鳐'],
    ['b_009_epic_04', '雪原祖龙鱼'],
    ['b_009_epic_05', '寒潮帝王鲑'],
    ['b_009_epic_06', '极星王甲鲟'],
    ['b_009_epic_07', '冰瀑巨乌贼'],
    ['b_009_epic_08', '曙光海豹'],
    ['b_009_exotic_01', '无影低日鳐'],
    ['b_009_exotic_02', '温度交换鲈'],
    ['b_009_exotic_03', '折光七色鳗'],
    ['b_009_exotic_04', '未冻先裂蟹'],
    ['b_009_exotic_05', '逆融海豹'],
    ['b_009_fine_01', '极光骨舌鱼'],
    ['b_009_fine_02', '冰冠王鲑'],
    ['b_009_fine_03', '雪原狼鳗'],
    ['b_009_fine_04', '永昼镜鳐'],
    ['b_009_fine_05', '霜月灯笼鱼'],
    ['b_009_fine_06', '冰河龙鱼'],
    ['b_009_fine_07', '寒风琴鳟'],
    ['b_009_fine_08', '极光海天使'],
    ['b_009_legendary_01', '极昼皇冠鳕'],
    ['b_009_legendary_02', '万冰归流鲑'],
    ['b_009_legendary_03', '极光神翼鳐'],
    ['b_009_legendary_04', '初雪祖鲟'],
    ['b_009_legendary_05', '极昼冰龟'],
    ['b_009_mythic_01', '白昼藏夜鳕'],
    ['b_009_mythic_02', '磁潮冠鲑'],
    ['b_009_mythic_03', '冰层年轮鲟'],
    ['b_009_mythic_04', '雪音鼓腹鱼'],
    ['b_009_mythic_05', '霜灯海天使'],
    ['b_009_rare_01', '万霜王鳕'],
    ['b_009_rare_02', '极昼日轮鲑'],
    ['b_009_rare_03', '冰脉古鲟'],
    ['b_009_rare_04', '雪幕六翼鳐'],
    ['b_009_rare_05', '极光长鬃鳗'],
    ['b_009_rare_06', '寒星巨口鲈'],
    ['b_009_rare_07', '霜甲帝王蟹'],
    ['b_009_rare_08', '蓝夜冰灯水母'],
    ['b_009_uncommon_01', '极昼虹鳟'],
    ['b_009_uncommon_02', '冰帆青鳕'],
    ['b_009_uncommon_03', '雪线长鳗'],
    ['b_009_uncommon_04', '霜镜圆鲳'],
    ['b_009_uncommon_05', '冰铃灯鱼'],
    ['b_009_uncommon_06', '寒羽飞鱼'],
    ['b_009_uncommon_07', '极光六须鲶'],
    ['b_009_uncommon_08', '冻潮河鲀'],
    ['b_009_uncommon_09', '白湾古鲟'],
    ['b_009_uncommon_10', '雪铃海螺'],
    ['b_010_arcane_01', '万钟共鸣龙鱼'],
    ['b_010_arcane_02', '沉城负碑巨鳐'],
    ['b_010_arcane_03', '失航图书鲟'],
    ['b_010_arcane_04', '潮墓复苏帝王蟹'],
    ['b_010_arcane_05', '古港守钟姬'],
    ['b_010_common_01', '锈鳞小鲷'],
    ['b_010_common_02', '钟影银鲱'],
    ['b_010_common_03', '缆纹虾虎'],
    ['b_010_common_04', '青铜鳚'],
    ['b_010_common_05', '旧港鳑鲏'],
    ['b_010_common_06', '沉木小鲈'],
    ['b_010_common_07', '潮钟青鳉'],
    ['b_010_common_08', '盐雾针鱼'],
    ['b_010_common_09', '锚尾泥鳅'],
    ['b_010_common_10', '月窗银鱼'],
    ['b_010_common_11', '钟舌小鳕'],
    ['b_010_common_12', '锈壳港虾'],
    ['b_010_epic_01', '九钟王冠鱼'],
    ['b_010_epic_02', '沉城圣甲鲟'],
    ['b_010_epic_03', '万缆织流鳗'],
    ['b_010_epic_04', '潮钟帝王鲑'],
    ['b_010_epic_05', '月锚神翼鳐'],
    ['b_010_epic_06', '旧港龙冠鲷'],
    ['b_010_epic_07', '钟楼章鱼'],
    ['b_010_epic_08', '沉港帝王蟹'],
    ['b_010_exotic_01', '空舱回游鱼'],
    ['b_010_exotic_02', '借壳记忆章鱼'],
    ['b_010_exotic_03', '钟声先至鲑'],
    ['b_010_exotic_04', '无门归港龟'],
    ['b_010_exotic_05', '倒灌街巷水母'],
    ['b_010_fine_01', '沉城骨舌鱼'],
    ['b_010_fine_02', '青铜王鲑'],
    ['b_010_fine_03', '锚链狼鳗'],
    ['b_010_fine_04', '钟楼灯鱼'],
    ['b_010_fine_05', '月港镜鳐'],
    ['b_010_fine_06', '潮轮六鳍鲷'],
    ['b_010_fine_07', '旧王冠鳜'],
    ['b_010_fine_08', '铜铃寄居蟹'],
    ['b_010_legendary_01', '古港天冠龙鱼'],
    ['b_010_legendary_02', '万锚守潮鲟'],
    ['b_010_legendary_03', '月钟神鳗'],
    ['b_010_legendary_04', '沉城九尾鲑'],
    ['b_010_legendary_05', '驮钟海龟'],
    ['b_010_mythic_01', '潮汐铸钟鲷'],
    ['b_010_mythic_02', '拱桥穿影鳗'],
    ['b_010_mythic_03', '船墓护灯鲉'],
    ['b_010_mythic_04', '石塔刻度鲟'],
    ['b_010_mythic_05', '缆结潮蟹'],
    ['b_010_rare_01', '万钟听潮鳗'],
    ['b_010_rare_02', '沉港龙鱼'],
    ['b_010_rare_03', '月锚帝王鲑'],
    ['b_010_rare_04', '青铜镜鲟'],
    ['b_010_rare_05', '潮宫王鲈'],
    ['b_010_rare_06', '锈月巨口鱼'],
    ['b_010_rare_07', '古锚海星'],
    ['b_010_rare_08', '月窗水母'],
    ['b_010_uncommon_01', '铜铃虹鳟'],
    ['b_010_uncommon_02', '沉钟石斑'],
    ['b_010_uncommon_03', '缆索长鳗'],
    ['b_010_uncommon_04', '海窗蝴蝶鱼'],
    ['b_010_uncommon_05', '锚冠鲈'],
    ['b_010_uncommon_06', '港灯鮟鱇'],
    ['b_010_uncommon_07', '铜甲河鲀'],
    ['b_010_uncommon_08', '潮笛须鲷'],
    ['b_010_uncommon_09', '旧帆燕鱼'],
    ['b_010_uncommon_10', '钟纹海螺'],
    ['b_011_arcane_01', '母河种脉鲟'],
    ['b_011_arcane_02', '万林潮肺森蚺'],
    ['b_011_arcane_03', '初绿种心鲤'],
    ['b_011_arcane_04', '昼雨双生叶鳐'],
    ['b_011_arcane_05', '万根雨幕水灵'],
    ['b_011_common_01', '翠纹小鲫'],
    ['b_011_common_02', '雨点灯鳉'],
    ['b_011_common_03', '根须泥鳅'],
    ['b_011_common_04', '藤影虾虎'],
    ['b_011_common_05', '洪流银鱼'],
    ['b_011_common_06', '叶腹鳑鲏'],
    ['b_011_common_07', '翡翠小鲈'],
    ['b_011_common_08', '雨林短鲶'],
    ['b_011_common_09', '花尾麦穗鱼'],
    ['b_011_common_10', '树洞鳚'],
    ['b_011_common_11', '雾腹小鳟'],
    ['b_011_common_12', '翠叶河虾'],
    ['b_011_epic_01', '层叶冠骨舌鱼'],
    ['b_011_epic_02', '万河归流龙鱼'],
    ['b_011_epic_03', '旱湾送雨鳐'],
    ['b_011_epic_04', '盘根镇床鲟'],
    ['b_011_epic_05', '返青双尾鲑'],
    ['b_011_epic_06', '花海长鬃鳗'],
    ['b_011_epic_07', '雨鼓巨河虾'],
    ['b_011_epic_08', '树宫章鱼'],
    ['b_011_exotic_01', '叶生归鳞鱼'],
    ['b_011_exotic_02', '倒悬根海鳐'],
    ['b_011_exotic_03', '并河结鳗'],
    ['b_011_exotic_04', '千树跃门蛙'],
    ['b_011_exotic_05', '空叶河图章鱼'],
    ['b_011_fine_01', '翡翠龙鱼'],
    ['b_011_fine_02', '万叶王鲤'],
    ['b_011_fine_03', '洪林六翼鳐'],
    ['b_011_fine_04', '雨鼓帝王鲑'],
    ['b_011_fine_05', '藤笛长鳗'],
    ['b_011_fine_06', '根冠古鲟'],
    ['b_011_fine_07', '花影王鲈'],
    ['b_011_fine_08', '翠冠树蛙'],
    ['b_011_legendary_01', '雨棚巨骨舌鱼'],
    ['b_011_legendary_02', '瀑帘银鲑'],
    ['b_011_legendary_03', '绝种种库龙鱼'],
    ['b_011_legendary_04', '洪痕碑鲟'],
    ['b_011_legendary_05', '驮林巨鼋'],
    ['b_011_mythic_01', '初霖肺鱼'],
    ['b_011_mythic_02', '共根神鲶'],
    ['b_011_mythic_03', '花历巨鲤'],
    ['b_011_mythic_04', '蜕季藤鳗'],
    ['b_011_mythic_05', '雨冠蹼尾蛙姬'],
    ['b_011_rare_01', '万雨织鳍鲑'],
    ['b_011_rare_02', '翡翠圣冠鲤'],
    ['b_011_rare_03', '洪流巨口鲶'],
    ['b_011_rare_04', '树海镜鳐'],
    ['b_011_rare_05', '古藤龙鳗'],
    ['b_011_rare_06', '雨夜灯冠鱼'],
    ['b_011_rare_07', '洪林绒螯蟹'],
    ['b_011_rare_08', '翡翠伞水母'],
    ['b_011_uncommon_01', '雨冠虹鳟'],
    ['b_011_uncommon_02', '藤鞭长鳗'],
    ['b_011_uncommon_03', '翡翠镜鲤'],
    ['b_011_uncommon_04', '洪钟石首鱼'],
    ['b_011_uncommon_05', '根甲小鲟'],
    ['b_011_uncommon_06', '花冠月鱼'],
    ['b_011_uncommon_07', '雨幕飞鱼'],
    ['b_011_uncommon_08', '林灯骨舌鱼'],
    ['b_011_uncommon_09', '红果河鲀'],
    ['b_011_uncommon_10', '雨林河螺'],
    ['b_012_arcane_01', '太阳熔心鱼'],
    ['b_012_arcane_02', '地火泄压凰尾鱼'],
    ['b_012_arcane_03', '造礁熔笔龙鱼'],
    ['b_012_arcane_04', '昼熔夜泉鳐'],
    ['b_012_arcane_05', '环礁火山海龙'],
    ['b_012_common_01', '熔斑小鲷'],
    ['b_012_common_02', '火泉青鳉'],
    ['b_012_common_03', '灰礁虾虎'],
    ['b_012_common_04', '赤尾雀鲷'],
    ['b_012_common_05', '硫纹鳚'],
    ['b_012_common_06', '环礁鳑鲏'],
    ['b_012_common_07', '暖流小鳀'],
    ['b_012_common_08', '黑砂泥鳅'],
    ['b_012_common_09', '焰点隆头鱼'],
    ['b_012_common_10', '赤潮银鱼'],
    ['b_012_common_11', '焦岩小石斑'],
    ['b_012_common_12', '余烬礁虾'],
    ['b_012_epic_01', '冷焰扇鳍鲷'],
    ['b_012_epic_02', '万礁守护隆头鱼'],
    ['b_012_epic_03', '热障黑帆鳐'],
    ['b_012_epic_04', '熔层纪甲鲟'],
    ['b_012_epic_05', '双泉泵尾鲑'],
    ['b_012_epic_06', '日蚀龙鳗'],
    ['b_012_epic_07', '岩浆环章鱼'],
    ['b_012_epic_08', '火环巨砗磲'],
    ['b_012_exotic_01', '吞热冷焰鱼'],
    ['b_012_exotic_02', '先沸镜鳐'],
    ['b_012_exotic_03', '缝界礁鳗'],
    ['b_012_exotic_04', '胎礁门章鱼'],
    ['b_012_exotic_05', '悖温玻璃海兔姬'],
    ['b_012_fine_01', '熔潮龙鱼'],
    ['b_012_fine_02', '日焰王鲑'],
    ['b_012_fine_03', '火山镜鳐'],
    ['b_012_fine_04', '灰冠古鲟'],
    ['b_012_fine_05', '赤珊狮子鱼'],
    ['b_012_fine_06', '熔钟灯鱼'],
    ['b_012_fine_07', '热浪狼鳗'],
    ['b_012_fine_08', '熔脉绒螯蟹'],
    ['b_012_legendary_01', '熔雨鬃狮子鱼'],
    ['b_012_legendary_02', '火脉测温龙鱼'],
    ['b_012_legendary_03', '珊枝缝礁鲑'],
    ['b_012_legendary_04', '黑曜镇潮鲟'],
    ['b_012_legendary_05', '熔甲海龟'],
    ['b_012_mythic_01', '原焰肺鱼'],
    ['b_012_mythic_02', '火眼地脉鳐'],
    ['b_012_mythic_03', '白灰预兆鲑'],
    ['b_012_mythic_04', '涅礁熔鳗'],
    ['b_012_mythic_05', '熔潮海葵姬'],
    ['b_012_rare_01', '万焰鳞鲤'],
    ['b_012_rare_02', '环火帝王鲑'],
    ['b_012_rare_03', '黑曜圣甲鲟'],
    ['b_012_rare_04', '熔海龙鳗'],
    ['b_012_rare_05', '火冠王鲈'],
    ['b_012_rare_06', '赤潮六翼鳐'],
    ['b_012_rare_07', '焰心海胆'],
    ['b_012_rare_08', '灰烬水母'],
    ['b_012_uncommon_01', '熔冠虹鳟'],
    ['b_012_uncommon_02', '火脉鹦嘴鱼'],
    ['b_012_uncommon_03', '灰烬长鳗'],
    ['b_012_uncommon_04', '赤环河鲀'],
    ['b_012_uncommon_05', '熔镜圆鲳'],
    ['b_012_uncommon_06', '温泉六须鲶'],
    ['b_012_uncommon_07', '焰翼飞鱼'],
    ['b_012_uncommon_08', '黑曜骨舌鱼'],
    ['b_012_uncommon_09', '熔潮石首鱼'],
    ['b_012_uncommon_10', '熔锥海螺'],
    ['b_013_arcane_01', '天河产湖鱼'],
    ['b_013_arcane_02', '万界共夜海龙'],
    ['b_013_arcane_03', '昼夜升降鳐'],
    ['b_013_arcane_04', '原声云生鲑'],
    ['b_013_arcane_05', '天穹祖鲸'],
    ['b_013_common_01', '云鳞小鲫'],
    ['b_013_common_02', '星点青鳉'],
    ['b_013_common_03', '风尾银鲦'],
    ['b_013_common_04', '天河泥鳅'],
    ['b_013_common_05', '鲸影小鲱'],
    ['b_013_common_06', '浮星虾虎'],
    ['b_013_common_07', '晴空鳑鲏'],
    ['b_013_common_08', '羽腹小鳟'],
    ['b_013_common_09', '云礁鳚'],
    ['b_013_common_10', '天光银鱼'],
    ['b_013_common_11', '天星须鲶'],
    ['b_013_common_12', '云羽浮虾'],
    ['b_013_epic_01', '云阶帆龙鱼'],
    ['b_013_epic_02', '万鲸听歌鲑'],
    ['b_013_epic_03', '夜幕帆翼鳐'],
    ['b_013_epic_04', '浮陆脊甲鲟'],
    ['b_013_epic_05', '风环巡天鲨'],
    ['b_013_epic_06', '日月双尾鱼'],
    ['b_013_epic_07', '极光天乌贼'],
    ['b_013_epic_08', '浮陆巨砗磲'],
    ['b_013_exotic_01', '上坠星鱼'],
    ['b_013_exotic_02', '穹中穹鳐'],
    ['b_013_exotic_03', '穿层梭鳗'],
    ['b_013_exotic_04', '无重云汐水精灵'],
    ['b_013_exotic_05', '虚空章鱼'],
    ['b_013_fine_01', '鲸海龙鱼'],
    ['b_013_fine_02', '星冠帝王鲑'],
    ['b_013_fine_03', '万云镜鳐'],
    ['b_013_fine_04', '风环六鳍鲼'],
    ['b_013_fine_05', '天琴长鳗'],
    ['b_013_fine_06', '浮陆古鲟'],
    ['b_013_fine_07', '星门王鲈'],
    ['b_013_fine_08', '流星水母'],
    ['b_013_legendary_01', '压暴穹帆鱼'],
    ['b_013_legendary_02', '航星脊龙鱼'],
    ['b_013_legendary_03', '鲸语远播鲑'],
    ['b_013_legendary_04', '寻岛风眼鳐'],
    ['b_013_legendary_05', '浮陆天龟'],
    ['b_013_mythic_01', '澄空鳞羽鱼'],
    ['b_013_mythic_02', '纵层巡游鲲'],
    ['b_013_mythic_03', '梦航额舵鲑'],
    ['b_013_mythic_04', '无重聚河鳗'],
    ['b_013_mythic_05', '星风鲸歌姬'],
    ['b_013_rare_01', '万星织鳍鱼'],
    ['b_013_rare_02', '云海帝王鲑'],
    ['b_013_rare_03', '鲸影圣冠鲨'],
    ['b_013_rare_04', '天穹镜龙鱼'],
    ['b_013_rare_05', '风暴王甲鲟'],
    ['b_013_rare_06', '星歌巨口鲈'],
    ['b_013_rare_07', '风羽天蟹'],
    ['b_013_rare_08', '云海兔'],
    ['b_013_uncommon_01', '天冠虹鳟'],
    ['b_013_uncommon_02', '云帆月鱼'],
    ['b_013_uncommon_03', '星河长鳗'],
    ['b_013_uncommon_04', '鲸歌石首鱼'],
    ['b_013_uncommon_05', '浮岛镜鲤'],
    ['b_013_uncommon_06', '风翼飞鱼'],
    ['b_013_uncommon_07', '天灯骨舌鱼'],
    ['b_013_uncommon_08', '云钟河鲀'],
    ['b_013_uncommon_09', '星帆小鲟'],
    ['b_013_uncommon_10', '天穹云螺'],
    ['b_014_arcane_01', '永恒瞬鱼'],
    ['b_014_arcane_02', '万古时冠鹦鹉螺'],
    ['b_014_arcane_03', '原历刻鳞龙鱼'],
    ['b_014_arcane_04', '终末返晨鳐'],
    ['b_014_arcane_05', '纪元回流海天使'],
    ['b_014_common_01', '回纹小鲫'],
    ['b_014_common_02', '时点青鳉'],
    ['b_014_common_03', '镜腹鳑鲏'],
    ['b_014_common_04', '逆流泥鳅'],
    ['b_014_common_05', '春鳞小鲈'],
    ['b_014_common_06', '夏尾银鲦'],
    ['b_014_common_07', '秋斑虾虎'],
    ['b_014_common_08', '冬腹小鳟'],
    ['b_014_common_09', '秒针针鱼'],
    ['b_014_common_10', '旧影银鱼'],
    ['b_014_common_11', '镜岸鳚'],
    ['b_014_common_12', '刻度回流虾'],
    ['b_014_epic_01', '叠世背鳍鱼'],
    ['b_014_epic_02', '万年巡游古鱼'],
    ['b_014_epic_03', '双岸校流鳐'],
    ['b_014_epic_04', '四季蜕鳞龙鱼'],
    ['b_014_epic_05', '旧水回补鲑'],
    ['b_014_epic_06', '城史浮雕鲟'],
    ['b_014_epic_07', '倒时章鱼'],
    ['b_014_epic_08', '轮回钟水母'],
    ['b_014_exotic_01', '因果倒游鱼'],
    ['b_014_exotic_02', '他择镜鳐'],
    ['b_014_exotic_03', '年结刻度鳗'],
    ['b_014_exotic_04', '异年钟水母'],
    ['b_014_exotic_05', '悖论章鱼'],
    ['b_014_fine_01', '时镜龙鱼'],
    ['b_014_fine_02', '四季王鲤'],
    ['b_014_fine_03', '逆瀑六翼鳐'],
    ['b_014_fine_04', '年轮冠鲑'],
    ['b_014_fine_05', '回声长鳗'],
    ['b_014_fine_06', '镜湖古鲟'],
    ['b_014_fine_07', '昼夜王鲈'],
    ['b_014_fine_08', '四季镜蟹'],
    ['b_014_legendary_01', '今线分海鱼'],
    ['b_014_legendary_02', '遗形鳞库鱼'],
    ['b_014_legendary_03', '昼夜校准鲑'],
    ['b_014_legendary_04', '岔路空影鳐'],
    ['b_014_legendary_05', '年轮古龟'],
    ['b_014_mythic_01', '第一刻心鱼'],
    ['b_014_mythic_02', '纪元剖面龙鱼'],
    ['b_014_mythic_03', '万路终点鲑'],
    ['b_014_mythic_04', '莫比乌斯鳗'],
    ['b_014_mythic_05', '四季回流海马姬'],
    ['b_014_rare_01', '万刻织鳍鱼'],
    ['b_014_rare_02', '回流帝王鲑'],
    ['b_014_rare_03', '未来镜鳐'],
    ['b_014_rare_04', '纪年王甲鲟'],
    ['b_014_rare_05', '轮回龙鳗'],
    ['b_014_rare_06', '时针巨口鲈'],
    ['b_014_rare_07', '沙漏月贝'],
    ['b_014_rare_08', '昨日水母'],
    ['b_014_uncommon_01', '四季虹鳟'],
    ['b_014_uncommon_02', '时钟月鱼'],
    ['b_014_uncommon_03', '镜线长鳗'],
    ['b_014_uncommon_04', '回潮石首鱼'],
    ['b_014_uncommon_05', '年轮小鲟'],
    ['b_014_uncommon_06', '春秋双尾鲑'],
    ['b_014_uncommon_07', '镜门飞鱼'],
    ['b_014_uncommon_08', '沙漏灯鱼'],
    ['b_014_uncommon_09', '往日骨舌鱼'],
    ['b_014_uncommon_10', '时环镜螺'],
    ['b_015_arcane_01', '心跳新海鱼'],
    ['b_015_arcane_02', '诸界潮汐海龙'],
    ['b_015_arcane_03', '初日终月鳐'],
    ['b_015_arcane_04', '万灵圣枝龙鱼'],
    ['b_015_arcane_05', '世界心鲸'],
    ['b_015_common_01', '星砂小鲫'],
    ['b_015_common_02', '圣泉青鳉'],
    ['b_015_common_03', '渊影泥鳅'],
    ['b_015_common_04', '星环鳑鲏'],
    ['b_015_common_05', '月尘虾虎'],
    ['b_015_common_06', '祈愿小鳟'],
    ['b_015_common_07', '圣羽银鱼'],
    ['b_015_common_08', '渊蓝小鲈'],
    ['b_015_common_09', '星须小鲶'],
    ['b_015_common_10', '银冠鳚'],
    ['b_015_common_11', '圣纹麦穗鱼'],
    ['b_015_common_12', '星屑圣泉虾'],
    ['b_015_epic_01', '守星灯冠鮟鱇'],
    ['b_015_epic_02', '万愿圣鲤'],
    ['b_015_epic_03', '月潮静翼鳐'],
    ['b_015_epic_04', '圣枝脉龙鱼'],
    ['b_015_epic_05', '疗环双尾鲑'],
    ['b_015_epic_06', '陨光墓甲鲟'],
    ['b_015_epic_07', '银河圣章鱼'],
    ['b_015_epic_08', '世界珍珠砗磲'],
    ['b_015_exotic_01', '归星逆鳞鱼'],
    ['b_015_exotic_02', '噬光明界鳐'],
    ['b_015_exotic_03', '无底短路鳗'],
    ['b_015_exotic_04', '异海瞳水母'],
    ['b_015_exotic_05', '虚空圣乌贼魅姬'],
    ['b_015_fine_01', '星渊龙鱼'],
    ['b_015_fine_02', '圣冠帝王鲑'],
    ['b_015_fine_03', '月海镜鳐'],
    ['b_015_fine_04', '星环六鳍鲼'],
    ['b_015_fine_05', '祷琴长鳗'],
    ['b_015_fine_06', '圣殿古鲟'],
    ['b_015_fine_07', '渊冠王鲈'],
    ['b_015_fine_08', '星渊月水母'],
    ['b_015_legendary_01', '渊空灯塔鮟鱇'],
    ['b_015_legendary_02', '愿史鳞库鱼'],
    ['b_015_legendary_03', '白潮开路鲑'],
    ['b_015_legendary_04', '万月息潮鳐'],
    ['b_015_legendary_05', '圣环星龟'],
    ['b_015_mythic_01', '初星育海鱼'],
    ['b_015_mythic_02', '九渊鳃门龙鱼'],
    ['b_015_mythic_03', '真愿额镜鲑'],
    ['b_015_mythic_04', '无源圣河鳗'],
    ['b_015_mythic_05', '星渊圣歌人鱼'],
    ['b_015_rare_01', '万星织鳍鲑'],
    ['b_015_rare_02', '圣泉帝王鱼'],
    ['b_015_rare_03', '星殿镜翼鳐'],
    ['b_015_rare_04', '渊海王甲鲟'],
    ['b_015_rare_05', '祈愿龙鳗'],
    ['b_015_rare_06', '圣歌巨口鲈'],
    ['b_015_rare_07', '星甲渊蟹'],
    ['b_015_rare_08', '圣辉海参'],
    ['b_015_uncommon_01', '星冠虹鳟'],
    ['b_015_uncommon_02', '圣镜月鱼'],
    ['b_015_uncommon_03', '渊河长鳗'],
    ['b_015_uncommon_04', '祷歌石首鱼'],
    ['b_015_uncommon_05', '星殿镜鲤'],
    ['b_015_uncommon_06', '圣翼飞鱼'],
    ['b_015_uncommon_07', '月灯骨舌鱼'],
    ['b_015_uncommon_08', '星刺河鲀'],
    ['b_015_uncommon_09', '圣甲小鲟'],
    ['b_015_uncommon_10', '圣环星螺'],
  ];

  let _nameMap = null; // name -> fishId（首次使用时由 HARD_FISH 构建一次）
  let _mapDiag = null; // 兼容旧字段

  function stripBracket(name) {
    const m = /^\s*\[[A-Za-z0-9]+\]\s*/.exec(name);
    return m ? name.slice(m[0].length) : name;
  }

  // 游戏接口返回可能带 { data: {...} } 包装（桥有时剥一层）；这里统一兼容取 .data 下的内容
  function unwrap(obj) { return (obj && obj.data && typeof obj.data === 'object') ? obj.data : obj; }

  // 由硬编码表构建 name -> fishId（同步、零请求、恒定完整）。
  // 同时登记「完整名」与「去 [Bx] 前缀名」两种键，兼容页面/图鉴两种命名。
  function buildNameMap() {
    const map = {};
    for (const row of HARD_FISH) {
      const fishId = row[0], name = row[1];
      if (!fishId || !name) continue;
      map[name] = fishId;
      const stripped = stripBracket(String(name));
      if (stripped !== name) map[stripped] = fishId;
    }
    return map;
  }

  function ensureNameMap() {
    if (_nameMap) return _nameMap;
    _nameMap = buildNameMap();
    _mapDiag = { source: 'hardcoded', mapSize: Object.keys(_nameMap).length };
    console.log(TAG, 'name-map(硬编码) 已就绪，条数:', _mapDiag.mapSize);
    return _nameMap;
  }

  // 某鱼名在 map 里查 fishId：完整名直查，再退化到去 [Bx] 前缀名
  function lookupFishId(map, displayName) {
    if (map[displayName]) return map[displayName];
    const stripped = stripBracket(displayName);
    if (map[stripped]) return map[stripped];
    return null;
  }

  // 查 fishId（同步、零请求）。硬编码表里没有的鱼（新增鱼种）返回 null。
  function fishIdFor(displayName) {
    return lookupFishId(ensureNameMap(), displayName);
  }

  // ---------- 查询单条鱼的价位 ----------
  // 单鱼价位缓存：同一 fishId 在 30 分钟内直接复用，跨订单/同一订单的多张卡片都能秒加载。
  // 只缓存成功取到的结果（ask/bid 至少有一个非空），失败不缓存，下次仍会重查。
  const PRICE_TTL_MS = 30 * 60 * 1000;
  const _priceCache = new Map(); // fishId -> { ask, bid, ts }
  // 返回 { ask, bid }：ask = 最低在售价（sellLevels 最低档），bid = 最高求购价（buyLevels 最大档）
  async function getPrices(fishId) {
    const hit = _priceCache.get(fishId);
    if (hit && (Date.now() - hit.ts) < PRICE_TTL_MS) {
      return { ask: hit.ask, bid: hit.bid };
    }
    const ob = await getJSON('/api/market/fish/' + encodeURIComponent(fishId) + '/order-book');
    const d = (ob.ok && ob.data) ? unwrap(ob.data) : null;
    let ask = null, bid = null;
    if (d) {
      if (Array.isArray(d.sellLevels) && d.sellLevels.length) {
        ask = d.sellLevels[0].unitPrice; // 最低卖一档
      }
      if (Array.isArray(d.buyLevels) && d.buyLevels.length) {
        let bm = null;
        for (const lvl of d.buyLevels) {
          if (lvl && typeof lvl.unitPrice === 'number') bm = (bm == null ? lvl.unitPrice : Math.max(bm, lvl.unitPrice));
        }
        bid = bm; // 最高求购价
      }
    }
    // 仅缓存成功结果（有卖价或求购价，且请求本身成功）
    if (d && (ask != null || bid != null)) {
      _priceCache.set(fishId, { ask, bid, ts: Date.now() });
    }
    return { ask, bid };
  }

  // ---------- 拆鱼名 + 导航辅助 ----------
  function fishNameText(fishNameEl) {
    const b = fishNameEl.querySelector('.barter-fish-name > b') || fishNameEl;
    return (b.textContent || '').trim();
  }

  // 判断该鱼格是否已无货（剩余数量为 0）：依据 .barter-fish-chip 的 data-exhausted 或其中的「剩余 N」
  function isExhausted(fishNameEl) {
    const chip = fishNameEl.closest('.barter-fish-chip');
    if (chip) {
      if (chip.getAttribute('data-exhausted') === 'true') return true;
      const small = chip.querySelector('small');
      if (small) {
        const m = /剩余\s*(\d+)/.exec(small.textContent || '');
        if (m && Number(m[1]) === 0) return true;
      }
    }
    return false;
  }

// ============ 跳转到鱼类市场并自动搜索 ============
  // 不依赖 SPA 路由/URL：直接点「鱼类市场」tab 切过去，等其渲染出过滤控件后，
  // 显式设置「地图」下拉 +「名称」搜索框的值并派发事件，让组件重新查询过滤列表。
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : (el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    try { setter.call(el, value); } catch (_e) { el.value = value; }
  }
  function findLabelControl(index, labelText) {
    const lab = Array.from(index.querySelectorAll('label')).find((l) => {
      const firstNode = l.firstChild && l.firstChild.nodeType === 3 ? l.firstChild.textContent : (l.childNodes[0] && l.childNodes[0].textContent);
      return (firstNode || '').trim() === labelText;
    });
    if (!lab) return null;
    return lab.querySelector('input') || lab.querySelector('select');
  }
  function applyMarketFilters(search, biome) {
    let tries = 0;
    (function poll() {
      const index = document.querySelector('.fish-market-index');
      if (!index) { if (++tries < 40) setTimeout(poll, 120); return; }
      const mapSel = findLabelControl(index, '地图');
      const nameInp = findLabelControl(index, '名称');
      if (!mapSel && !nameInp) { if (++tries < 40) setTimeout(poll, 120); return; }
      // 等市场组件完成初始化再设值，避免被初始渲染覆盖
      setTimeout(() => {
        if (mapSel && biome && Array.from(mapSel.options).some((o) => o.value === biome)) {
          setNativeValue(mapSel, biome);
          mapSel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (nameInp && search) {
          setNativeValue(nameInp, search);
          nameInp.dispatchEvent(new Event('input', { bubbles: true }));
          nameInp.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, 500);
    })();
  }
  function gotoMarket(url) {
    // 切到「鱼类市场」主 tab
    const tabs = Array.from(document.querySelectorAll('.market-tabs [role="tab"]'));
    const fishTab = tabs.find((t) => /鱼类市场/.test(t.getAttribute('aria-label') || t.textContent || ''));
    if (fishTab) { try { fishTab.click(); } catch (_e) {} }
    // 拦截点 tab 后 SPA 自己的 URL 写入（可能覆盖我们地址栏的目标 query），这里不强求 URL，
    // 因为过滤完全靠控件显式设置。
    let search = '', biome = '';
    try {
      const u = new URL(url);
      search = u.searchParams.get('fishSearch') || '';
      biome = u.searchParams.get('fishBiome') || '';
    } catch (_e) {}
    if (search || biome) applyMarketFilters(search, biome);
  }

  // 给单个 .barter-fish-name 元素创建/复用价格行，插在名字下方（block 换行，不挤占鱼名）
  const _priceElemByEl = new WeakMap();
  function priceElFor(fishNameEl) {
    if (_priceElemByEl.has(fishNameEl)) return _priceElemByEl.get(fishNameEl);
    const line = document.createElement('div');
    line.className = 'reelax-barter-price';
    // 强制另起一行显示在鱼名正下方：block + flex-basis:100%（父为 flex 时占满整行换行）
    line.style.cssText = 'display:block!important;width:100%;flex-basis:100%;flex-shrink:0;' +
      'box-sizing:border-box;white-space:normal;line-height:1.3;' +
      'font-size:11px;color:#9bd1ff;margin-top:1px;font-weight:normal;text-align:left;';
    // 若父级(.barter-fish-name)是 flex/inline 容器，也强制转块以便内部换行
    try { fishNameEl.style.display = 'block'; } catch (_e) {}
    fishNameEl.appendChild(line);
    _priceElemByEl.set(fishNameEl, line);
    return line;
  }

  // ---------- 更新价格（只更新当前这一张卡片；并统计两区极值标红 + 差价） ----------
  async function onUpdatePrices(btn) {
    const scope = btn.closest('.barter-order-card'); // 当前卡片 = 作用域
    if (!scope) return;
    // 分区：第一个 .barter-order-side = 「挂单人想要之一」，第二个 = 「你可以获得之一」；按通用取两区
    const sides = Array.from(scope.querySelectorAll('.barter-order-side'));
    const wantEls = sides[0] ? Array.from(sides[0].querySelectorAll('.barter-fish-name')) : [];
    const getEls = sides[1] ? Array.from(sides[1].querySelectorAll('.barter-fish-name')) : [];
    const nameEls = wantEls.concat(getEls);
    const diffLab = scope.querySelector('.reelax-barter-diff');

    if (!nameEls.length) {
      btn.textContent = '仅交换列表可用';
      setTimeout(() => { btn.textContent = '更新价格'; }, 1500);
      return;
    }

    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = '查询中…';

    const askByEl = new Map(); // .barter-fish-name 元素 -> ask(最低在售价) 或 null
    const bidByEl = new Map(); // .barter-fish-name 元素 -> bid(最高求购价) 或 null
    const fishIdByEl = new Map(); // .barter-fish-name 元素 -> fishId（供跳转链接提取地图）
    const getElSet = new Set(getEls); // 用于区分可获区两行渲染

    const setLoading = (el, text, color) => {
      const line = priceElFor(el);
      line.textContent = text;
      line.style.color = color || '#9bd1ff';
    };
    nameEls.forEach((el) => setLoading(el, '…'));

    // 按鱼名去重，同名只查一次，结果回填到所有同名格，并记录每格 ask/bid
    const groups = new Map(); // name -> [fishNameEl, ...]
    for (const el of nameEls) {
      const nm = fishNameText(el);
      if (!nm) continue;
      if (!groups.has(nm)) groups.set(nm, []);
      groups.get(nm).push(el);
    }

    // 渲染一格：可获区显示「在售 / 求购」两行，想要区显示在售单行；err 时显示错误文本
    const renderFish = (el, ask, bid, err) => {
      const line = priceElFor(el);
      line.innerHTML = '';
      if (err) {
        line.textContent = err;
        line.style.color = '#ff8f8f';
        return;
      }
      if (getElSet.has(el)) {
        const r1 = document.createElement('div');
        r1.textContent = '在售 ' + (ask == null ? '无' : fmtGold(ask));
        r1.style.cssText = 'color:' + (ask == null ? '#ccc' : '#d4a520') + ';'; // 在售用深黄色
        const r2 = document.createElement('div');
        r2.textContent = '求购 ' + (bid == null ? '无' : fmtGold(bid));
        r2.style.cssText = 'color:' + (bid == null ? '#ccc' : '#59d95a') + ';'; // 求购用绿色区分
        line.appendChild(r1);
        line.appendChild(r2);
      } else {
        line.textContent = ask == null ? '无在售' : fmtGold(ask);
        line.style.color = (ask == null ? '#ccc' : '#d4a520'); // 想要区售价用深黄色
      }
    };

    const total = groups.size;
    let done = 0;
    try {
      const nameMap = ensureNameMap();
      const hasMap = !!Object.keys(nameMap).length;
      for (const [nm, els] of groups) {
        let ask = null, bid = null, matched = false, fishId = null, err = null;
        if (!hasMap) {
          err = '价格获取失败';
          if (_mapDiag) {
            const d = _mapDiag;
            console.error(TAG, '名字映射失败详情:', d);
            if (els[0]) {
              const line = priceElFor(els[0]);
              line.title = JSON.stringify(d);
              line.innerHTML = '';
              line.textContent = '映射失败: ' + JSON.stringify(d);
              line.style.color = '#ff8f8f';
            }
          }
        }
        else {
          fishId = fishIdFor(nm);
          if (!fishId) {
            err = '未匹配到鱼';
            if (!_debuggedMiss.has(nm)) {
              _debuggedMiss.add(nm);
              const sampleKeys = Object.keys(nameMap).slice(0, 6);
              console.error(TAG, '未匹配:', JSON.stringify(nm),
                '| 页面名去掉前缀后:', JSON.stringify(stripBracket(nm)),
                '| map 是否有去前缀键:', !!(nameMap[stripBracket(nm)]),
                '| map 键样例:', JSON.stringify(sampleKeys));
            }
          }
          else {
            matched = true;
            const p = await getPrices(fishId);
            ask = p.ask;
            bid = p.bid;
          }
        }
        for (const el of els) {
          renderFish(el, ask, bid, err);
          askByEl.set(el, (matched && ask != null) ? ask : null);
          bidByEl.set(el, (matched && bid != null) ? bid : null);
          fishIdByEl.set(el, matched ? fishId : null);
        }
        done++;
        btn.textContent = `查询中… ${done}/${total}`;
        await sleep(150); // 节奏控制
      }

      // ---- 极值统计与标红 ----
      // 想要区：最低卖价（红）；可获区：最高卖价（红）、最高求购价（用于稳赚）；差价 = 可获最高在售 − 想要最低
      //   稳赚 = 可获区最高求购价 − 想要区那条最低价鱼的出售价
      // 注：两区数量为 0 的鱼（已换完）都不计入判断。
      let wantMin = null, getMax = null, bidMax = null;
      for (const el of wantEls) {
        if (isExhausted(el)) continue; // 无货的鱼不算
        const a = askByEl.get(el);
        if (a != null) wantMin = (wantMin == null ? a : Math.min(wantMin, a));
      }
      for (const el of getEls) {
        if (isExhausted(el)) continue; // 无货的鱼不算
        const a = askByEl.get(el);
        if (a != null) getMax = (getMax == null ? a : Math.max(getMax, a));
        const b = bidByEl.get(el);
        if (b != null) bidMax = (bidMax == null ? b : Math.max(bidMax, b));
      }
      for (const el of wantEls) {
        if (isExhausted(el)) continue; // 无货的鱼不参与标红
        const a = askByEl.get(el);
        if (a != null && a === wantMin) { const l = priceElFor(el); l.style.color = '#ff5a5a'; }
      }
      for (const el of getEls) {
        if (isExhausted(el)) continue; // 无货的鱼不参与标红
        const a = askByEl.get(el);
        if (a != null && a === getMax) {
          const l = priceElFor(el);
          // 可获区为两行，标红作用于「在售」行（第一个子元素）
          const first = l.firstElementChild;
          if (first) first.style.color = '#ff5a5a'; else l.style.color = '#ff5a5a';
        }
      }
      if (diffLab) {
        if (wantMin != null && getMax != null) {
          const d = getMax - wantMin;
          diffLab.textContent = '差价：' + fmtGold(d);
          diffLab.style.color = (d >= 0 ? '#2f9e44' : '#c0392b'); // 赚=深绿，亏=深红
          diffLab.title = '可获最高在售 ' + fmtGold(getMax) + ' − 想要最低 ' + fmtGold(wantMin);
        } else {
          diffLab.textContent = '差价：缺在售';
          diffLab.style.color = '#aaa';
        }
      }
      // 差价左边：显示「想要区最低价」那条鱼的鱼名 + 地图前缀，如「[B13] 星风鲸歌姬」，点击跳转市场
      let minAsk = null; // 想要区最低价那条鱼的出售价
      const fishLab = scope.querySelector('.reelax-barter-diff-fish');
      if (fishLab) {
        let minName = null, minFishId = null;
        if (wantMin != null) {
          for (const el of wantEls) {
            const a = askByEl.get(el);
            if (a != null && a === wantMin) {
              minName = fishNameText(el); // 页面原始鱼名，含 [B13] 前缀
              minFishId = fishIdByEl.get(el); // 该格对应的 fishId
              minAsk = askByEl.get(el); // 那条鱼的出售价
              break;
            }
          }
        }
        if (minName && minFishId) {
          // fishId 形如 b_007_exotic_01 → biomeId 取其前两段
          const segs = String(minFishId).split('_');
          const biome = segs.length >= 2 ? segs.slice(0, 2).join('_') : '';
          const search = stripBracket(minName); // 去掉 [Bxx] 前缀（用于搜索链接）
          const url = 'https://reelax.cn/market?fishSearch=' + encodeURIComponent(search) +
            '&fishBiome=' + encodeURIComponent(biome);
          fishLab.textContent = minName; // 显示为「[B13] 星风鲸歌姬」
          // 不走 <a> 默认导航（会被 SPA 路由拦截导致不跳转），改用控件显式设置跳转
          fishLab.removeAttribute('href');
          fishLab.title = '在市场中跳转到 ' + search;
          fishLab.style.cursor = 'pointer';
          fishLab.style.textDecoration = 'underline';
          if (!fishLab.__reelaxNavBound) {
            fishLab.__reelaxNavBound = true;
            fishLab.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              gotoMarket(url);
            });
          }
        } else {
          fishLab.textContent = '';
          fishLab.removeAttribute('href');
          fishLab.title = '';
          fishLab.style.cursor = 'default';
        }
      }

      // ---- 稳赚：可获区最高求购价 − 想要区最低价那条鱼的出售价 ----
      const stableLab = scope.querySelector('.reelax-barter-stable');
      if (stableLab) {
        if (bidMax != null && minAsk != null) {
          const s = bidMax - minAsk;
          stableLab.textContent = '稳赚：' + fmtGold(s);
          stableLab.style.color = (s >= 0 ? '#2f9e44' : '#c0392b'); // 赚=深绿 亏=深红
          stableLab.title = '可获区最高求购 ' + fmtGold(bidMax) + ' − 想要鱼出售 ' + fmtGold(minAsk);
        } else {
          stableLab.textContent = '';
          stableLab.title = '';
        }
      }
    } catch (e) {
      nameEls.forEach((el) => setLoading(el, '查询异常', '#ff8f8f'));
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  // ---------- 注入按钮到每张卡片 footer（选择交换按钮左边） ----------
  // 布局（都在「选择交换」按钮左边）：
  //   第1行：差价  [B13]鱼名链接
  //   第2行：稳赚 X
  //   更新价格 按钮
  function ensureButtons() {
    document.querySelectorAll('.barter-order-card').forEach((card) => {
      if (card.querySelector('.reelax-barter-refresh')) return;
      const footer = card.querySelector('footer');
      if (!footer) return;
      const exchangeBtn = footer.querySelector('button'); // 主按钮「选择交换」

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'reelax-barter-refresh';
      btn.textContent = '更新价格';
      btn.style.cssText = 'margin:0 8px 0 0;padding:4px 12px;border-radius:6px;' +
        'border:1px solid #174a8f;background:#1e5aa8;color:#fff;' +
        'font-size:13px;cursor:pointer;white-space:nowrap;';
      btn.addEventListener('click', (e) => { e.stopPropagation(); onUpdatePrices(btn); });

      // 差价标签
      const diffLab = document.createElement('span');
      diffLab.className = 'reelax-barter-diff';
      diffLab.textContent = '差价：—';
      diffLab.style.cssText = 'margin:0 8px 0 0;font-size:13px;font-weight:bold;color:#d4a520;white-space:nowrap;';
      // 鱼名链接（在差价后面）
      const fishLab = document.createElement('span');
      fishLab.className = 'reelax-barter-diff-fish';
      fishLab.textContent = '';
      fishLab.style.cssText = 'font-size:12px;color:#d4a520;white-space:nowrap;cursor:pointer;text-decoration:underline;';
      // 稳赚标签（独立一行）
      const stableLab = document.createElement('span');
      stableLab.className = 'reelax-barter-stable';
      stableLab.textContent = '';
      stableLab.style.cssText = 'font-size:13px;font-weight:bold;white-space:nowrap;';

      // 容器：两行（第1行 差价+链接，第2行 稳赚）
      const wrapper = document.createElement('div');
      wrapper.className = 'reelax-barter-rows';
      wrapper.style.cssText = 'display:inline-flex;flex-direction:column;align-items:flex-start;' +
        'gap:2px;margin:0 8px 0 0;vertical-align:middle;';
      const row1 = document.createElement('div');
      row1.style.cssText = 'display:flex;align-items:baseline;flex-wrap:nowrap;';
      row1.appendChild(diffLab);
      row1.appendChild(fishLab);
      const row2 = document.createElement('div');
      row2.style.cssText = 'display:block;';
      row2.appendChild(stableLab);
      wrapper.appendChild(row1);
      wrapper.appendChild(row2);

      // 插入：先 wrapper（在左），再 btn（紧贴选择交换）
      footer.insertBefore(wrapper, exchangeBtn || footer.firstChild);
      footer.insertBefore(btn, exchangeBtn || footer.firstChild);
    });
  }

  // ---------- 轮询注入（barter 列表异步渲染） ----------
  function tryInject() {
    if (!document.body) return;
    if (document.querySelector('.barter-order-card')) ensureButtons();
  }

  setInterval(() => { try { tryInject(); } catch (_e) {} }, 1200);
  try { tryInject(); } catch (_e) {}

  console.log(TAG, '已加载：交换列表卡片上将出现「更新价格」按钮');
})();