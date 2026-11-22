/* 静态版后端：把 server.py 的 /api/* 实现在浏览器里。
   曲目/稿子/作品存 localStorage，录音与成品存 IndexedDB，混音用 WebAudio。 */
(function () {
  const nativeFetch = window.fetch.bind(window);
  const LS = {
    tracks: 'rap_s_tracks',
    corpus: 'rap_s_corpus',
    works: 'rap_s_works',
    lrc: 'rap_s_lrc',
  };
  const SR = 48000;
  const DBG = /[?&]debug=1/.test(location.search);
  const log = (...a) => { if (DBG) console.log('[store]', ...a); };
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  const textResp = t => new Response(t, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const uid = n => Array.from(crypto.getRandomValues(new Uint8Array(n)))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  /* ---------- 本地存储 ---------- */
  const mem = {};
  function read(key, fallback) {
    if (mem[key] !== undefined) return mem[key];
    try {
      const v = JSON.parse(localStorage.getItem(key) || 'null');
      mem[key] = v == null ? fallback : v;
    } catch (e) { mem[key] = fallback; }
    return mem[key];
  }
  function write(key, val) {
    mem[key] = val;
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 配额满就只留内存 */ }
  }

  /* ---------- IndexedDB：录音/成品 ---------- */
  let dbp = null;
  function db() {
    if (!dbp) dbp = openDB(1).then(d => {
      if (d.objectStoreNames.contains('blobs')) return d;
      // 早前有别的页面探测过这个库，建成了空库：升一级补上
      d.close();
      return openDB(2);
    });
    return dbp;
  }
  function openDB(ver) {
    return new Promise((res, rej) => {
      const r = indexedDB.open('rap_media', ver);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function putBlob(k, blob) {
    const d = await db();
    return new Promise((res, rej) => {
      const tx = d.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').put(blob, k);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
  async function getBlob(k) {
    try {
      const d = await db();
      return await new Promise((res, rej) => {
        const q = d.transaction('blobs').objectStore('blobs').get(k);
        q.onsuccess = () => res(q.result || null);
        q.onerror = () => rej(q.error);
      });
    } catch (e) { return null; }
  }
  async function delBlob(k) {
    try {
      const d = await db();
      await new Promise((res, rej) => {
        const tx = d.transaction('blobs', 'readwrite');
        tx.objectStore('blobs').delete(k);
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
    } catch (e) { /* ignore */ }
  }

  /* ---------- 资源 ---------- */
  let baseTracks = null, templates = null;
  const loadBase = () => baseTracks || (baseTracks = nativeFetch('assets/library.json')
    .then(r => r.json()).then(d => d.tracks || []).catch(() => []));
  const loadTpls = () => templates || (templates = nativeFetch('assets/templates.json')
    .then(r => r.json()).catch(() => []));

  async function allTracks() {
    return (await loadBase()).concat(read(LS.tracks, []));
  }
  async function findTrack(id) {
    return (await allTracks()).find(t => t.id === id) || null;
  }
  const lrcMap = () => read(LS.lrc, {});

  /* ---------- 音频 ----------
     录音时同时抓「伴奏流」和「人声流」，所以混音只用这两段，不下载整首伴奏。
     一个作品可以有多段 take：后录的盖住先录的，K 歌式的补录就靠这个。 */
  async function blobBuf(blob) {
    const ab = await blob.arrayBuffer();
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    try { return await ac.decodeAudioData(ab); }
    finally { ac.close(); }
  }

  async function renderWork(work, volInst, volVocal, vocalOnly) {
    const takes = (work.takes || []).slice().sort((a, b) => a.start - b.start);
    if (!takes.length) throw new Error('还没有录音');
    const total = Math.min(Math.max(...takes.map(t => t.start + t.dur), 0.1), 3600);
    const ctx = new OfflineAudioContext(2, Math.ceil(total * SR), SR);
    log('render takes', takes.length, 'total', total, vocalOnly ? 'vocal' : 'mix');

    const gi = ctx.createGain();
    gi.gain.value = volInst;
    gi.connect(ctx.destination);

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.005;
    comp.release.value = 0.15;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -1.4;   // ≈ alimiter 0.85
    lim.knee.value = 0;
    lim.ratio.value = 20;
    lim.attack.value = 0.001;
    lim.release.value = 0.08;
    const gv = ctx.createGain();
    gv.gain.value = volVocal;
    const sum = ctx.createGain();
    sum.connect(ctx.destination);

    for (let k = 0; k < takes.length; k++) {
      const t = takes[k];
      const end = k + 1 < takes.length ? Math.min(t.start + t.dur, takes[k + 1].start) : t.start + t.dur;
      const dur = Math.min(end - t.start, t.dur);
      if (dur <= 0.04) continue;

      if (!vocalOnly) {
        const beatBlob = await getBlob(`beat:${work.id}:${t.i}`);
        if (beatBlob) {
          const buf = await blobBuf(beatBlob);
          const s = ctx.createBufferSource();
          s.buffer = buf;
          s.connect(gi);
          s.start(t.start, t.trim || 0, Math.min(dur, Math.max(0, buf.duration - (t.trim || 0))));
        }
      }
      const micBlob = await getBlob(`mic:${work.id}:${t.i}`);
      if (micBlob) {
        const buf = await blobBuf(micBlob);
        const s = ctx.createBufferSource();
        s.buffer = buf;
        s.connect(comp).connect(lim).connect(gv).connect(sum);
        s.start(t.start, t.trim || 0, Math.min(dur, Math.max(0, buf.duration - (t.trim || 0))));
      }
    }

    const out = await ctx.startRendering();
    log('rendered', out.duration);
    return { blob: encodeWav(out), duration: out.duration };
  }

  function encodeWav(buf) {
    const ch = buf.numberOfChannels, len = buf.length;
    const data = new DataView(new ArrayBuffer(44 + len * ch * 2));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); data.setUint32(4, 36 + len * ch * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); data.setUint32(16, 16, true); data.setUint16(20, 1, true);
    data.setUint16(22, ch, true); data.setUint32(24, buf.sampleRate, true);
    data.setUint32(28, buf.sampleRate * ch * 2, true); data.setUint16(32, ch * 2, true);
    data.setUint16(34, 16, true); str(36, 'data'); data.setUint32(40, len * ch * 2, true);
    const chans = Array.from({ length: ch }, (_, i) => buf.getChannelData(i));
    let o = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < ch; c++) {
        const s = Math.max(-1, Math.min(1, chans[c][i]));
        data.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        o += 2;
      }
    }
    return new Blob([data.buffer], { type: 'audio/wav' });
  }

  /* ---------- 作品 ---------- */
  const workUrls = new Map();
  function mixUrl(id, blob) {
    if (!workUrls.has(id)) workUrls.set(id, URL.createObjectURL(blob));
    return workUrls.get(id);
  }
  function dropWorkUrl(id) {
    const u = workUrls.get(id);
    if (u) { URL.revokeObjectURL(u); workUrls.delete(id); }
  }

  /* ---------- 请求体 ---------- */
  async function bodyJson(opt) {
    try { return JSON.parse(String(opt.body || '{}')); } catch (e) { return {}; }
  }
  function header(opt, name) {
    const h = opt.headers || {};
    if (typeof h.get === 'function') return h.get(name);
    const k = Object.keys(h).find(x => x.toLowerCase() === name.toLowerCase());
    return k ? h[k] : '';
  }

  /* ---------- LLM ---------- */
  async function chat(baseUrl, apiKey, model, messages) {
    if (!/^https:\/\/|^http:\/\//i.test(baseUrl)) return { error: '接口地址不对' };
    if (!apiKey) return { error: '没填 Key' };
    const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    let r;
    try {
      r = await nativeFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({ model, messages, temperature: 0.8, max_tokens: 1500 }),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') return { error: 'AI 响应超时（60 秒），再试一次' };
      return { error: '这个服务不让网页直接调用（跨域被浏览器拦了），换成 DeepSeek、硅基流动或 OpenRouter 的 Key' };
    } finally { clearTimeout(timer); }

    let d = null;
    try { d = await r.json(); } catch (e) { /* 非 JSON */ }
    if (!r.ok) {
      const msg = d && d.error ? (d.error.message || d.error.code || JSON.stringify(d.error))
        : `HTTP ${r.status}`;
      return { error: `AI 调用失败：${msg}` };
    }
    const text = d && d.choices && d.choices[0] && d.choices[0].message
      ? d.choices[0].message.content : '';
    if (!text) return { error: 'AI 没返回内容' };
    return { text: String(text).trim(), usage: d.usage || {} };
  }

  /* ---------- 路由 ---------- */
  async function handle(url, opt) {
    const u = new URL(url, location.href);
    const p = u.pathname;
    const method = (opt.method || 'GET').toUpperCase();

    /* GET */
    if (p === '/api/library' && method === 'GET') {
      return json({ tracks: await allTracks() });
    }
    if (p === '/api/templates' && method === 'GET') {
      return json({ templates: await loadTpls() });
    }
    if (p === '/api/llm/status' && method === 'GET') {
      return json({ default: false, model: '' });
    }
    if (p === '/api/llm/config' && method === 'GET') {
      return json({ default: false });
    }
    if (p === '/api/corpus' && method === 'GET') {
      return json({ items: read(LS.corpus, []) });
    }
    if (p === '/api/track/text' && method === 'GET') {
      const t = await findTrack(u.searchParams.get('id') || '');
      if (!t || !t.generated) return json({ error: 'builtin' }, 404);
      return json({ id: t.id, title: t.title, text: t.text || '' });
    }
    if (p === '/api/works' && method === 'GET') {
      const works = read(LS.works, []).filter(w => w.published !== false);
      const out = [];
      for (const w of works) {
        const b = await getBlob('mix:' + w.id);
        if (b) out.push(Object.assign({}, w, { mix: mixUrl(w.id, b) }));
      }
      return json({ works: out, legacy: 0 });
    }
    if (p === '/api/work' && method === 'GET') {
      const w = read(LS.works, []).find(x => x.id === u.searchParams.get('id'));
      if (!w) return json({ error: '没有这条录音' }, 404);
      let vocal = '';
      try {
        const pv = await renderWork(w, w.vol_inst || 1, w.vol_vocal || 1, true);
        await putBlob('pv:' + w.id, pv.blob);
        vocal = URL.createObjectURL(pv.blob);
      } catch (e) { /* 没录音就空着 */ }
      return json({ work: w, vocal, duration: w.duration });
    }

    if (p === '/api/blob' && method === 'GET') {
      const b = await getBlob(u.searchParams.get('k') || '');
      return b ? json({ url: URL.createObjectURL(b) }) : json({ error: '没有这个文件' }, 404);
    }

    if (method !== 'POST') return json({ error: 'not found' }, 404);

    /* POST */
    if (p === '/api/fit') {
      const b = await bodyJson(opt);
      const src = String(b.text || '').trim();
      const tid = b.template || 'mid-trap';
      if (!src) return json({ error: '内容为空' }, 400);
      const tpl = (await loadTpls()).find(t => t.id === tid);
      if (!tpl) return json({ error: '没有这个曲式：' + tid }, 400);
      try {
        const f = window.FIT.fitFlex(src, tpl);
        return json({
          text: window.FIT.render(f.sections, true),
          sections: f.sections.map(([name, lines]) => ({ name, lines })),
          stats: { lines: f.used, duration: f.duration, bars: f.bars, seconds: f.duration },
          info: { dropped: f.dropped, intro: f.intro },
          template: tpl.id,
        });
      } catch (e) {
        return json({ error: '排版失败：' + e.message }, 400);
      }
    }

    if (p === '/api/track/create') {
      const b = await bodyJson(opt);
      const src = String(b.text || '').trim();
      const tid = b.template || 'mid-trap';
      if (!src) return json({ error: '内容为空' }, 400);
      const tpl = (await loadTpls()).find(t => t.id === tid);
      if (!tpl) return json({ error: '没有这个曲式：' + tid }, 400);
      let f;
      try { f = window.FIT.fitFlex(src, tpl); }
      catch (e) { return json({ error: '排版失败：' + e.message }, 400); }

      const id = 'gen-' + uid(4);
      const map = lrcMap();
      map[id] = window.FIT.lrcText(f.lrc);
      write(LS.lrc, map);

      const first = (f.lrc[0] && f.lrc[0][1]) || src.split('\n')[0];
      const track = {
        id,
        text: src,
        title: String(b.title || first).slice(0, 40),
        artist: '我的练唱',
        bpm: tpl.bpm,
        template: tpl.id,
        template_name: tpl.name,
        instrumental: 'assets/snd/library/' + tpl.id + '.mp3',
        vocal: '',
        lrc_url: '/lrc/' + id + '.lrc',
        duration: f.duration,
        bars: f.bars,
        generated: true,
        created: Math.floor(Date.now() / 1000),
      };
      const list = read(LS.tracks, []);
      list.unshift(track);
      write(LS.tracks, list);
      return json({ ok: true, track, used: f.used, dropped: f.dropped });
    }

    if (p === '/api/track/vocal') {
      const id = header(opt, 'X-Track-Id');
      const body = opt.body;
      const blob = body && body.get && body.get('vocal');
      if (!id || !blob || !blob.size) return json({ error: '没有原唱音轨' }, 400);
      await putBlob('vocal:' + id, blob);
      const list = read(LS.tracks, []);
      const t = list.find(x => x.id === id);
      if (t) {
        t.vocal = 'vocal:' + id;
        write(LS.tracks, list);
      }
      return json({ ok: true, vocal: 'vocal:' + id, url: URL.createObjectURL(blob) });
    }

    if (p === '/api/track/update') {
      const b = await bodyJson(opt);
      const list = read(LS.tracks, []);
      const t = list.find(x => x.id === b.id);
      if (!t) return json({ error: '没有这首' }, 404);
      const src = String(b.text || '').trim();
      if (!src) return json({ error: '歌词不能是空的' }, 400);
      const tpl = (await loadTpls()).find(x => x.id === t.template);
      if (!tpl) return json({ error: '原曲式不存在' }, 400);
      try {
        const f = window.FIT.fitFlex(src, tpl);
        const map = lrcMap();
        map[t.id] = window.FIT.lrcText(f.lrc);
        write(LS.lrc, map);
        t.text = src;
        if (b.title) t.title = String(b.title).slice(0, 40);
        t.duration = f.duration;
        t.bars = f.bars;
        t.lines = f.used;
        t.edited = Math.floor(Date.now() / 1000);
        write(LS.tracks, list);
        return json({ ok: true, lines: f.used, dropped: f.dropped, duration: f.duration, title: t.title });
      } catch (e) {
        return json({ error: '排版失败：' + e.message }, 400);
      }
    }

    if (p === '/api/track/delete') {
      const b = await bodyJson(opt);
      write(LS.tracks, read(LS.tracks, []).filter(x => x.id !== b.id));
      return json({ ok: true });
    }

    if (p === '/api/corpus') {
      const b = await bodyJson(opt);
      const src = String(b.text || '').trim();
      if (!src) return json({ error: '内容为空' }, 400);
      const item = {
        id: uid(6),
        title: String(b.title || src.split('\n')[0]).slice(0, 60),
        style: b.style || '',
        template: b.template || '',
        text: src,
        created: Math.floor(Date.now() / 1000),
      };
      const list = read(LS.corpus, []);
      list.unshift(item);
      write(LS.corpus, list);
      return json({ ok: true, item });
    }

    if (p === '/api/corpus/delete') {
      const b = await bodyJson(opt);
      write(LS.corpus, read(LS.corpus, []).filter(x => x.id !== b.id));
      return json({ ok: true });
    }

    if (p === '/api/llm') {
      const b = await bodyJson(opt);
      return json(await chat(b.base_url || '', b.api_key || '', b.model || '', b.messages || []));
    }

    if (p === '/api/llm/config') {
      return json({ ok: true, model: '' });
    }

    if (p === '/api/recording') {
      const trackId = header(opt, 'X-Track-Id');
      const offsetMs = Math.max(0, Math.min(parseInt(header(opt, 'X-Offset') || '0', 10) || 0, 3600000));
      const body = opt.body;
      log('recording req', trackId, offsetMs, body && body.get && body.get('mic') && body.get('mic').size);
      const track = await findTrack(trackId);
      if (!track) return json({ error: 'unknown track' }, 400);
      if (!body || typeof body.get !== 'function') return json({ error: '请求格式不对（要 mic + beat）' }, 400);
      const mic = body.get('mic'), beat = body.get('beat');
      if (!mic || !mic.size || !beat || !beat.size) return json({ error: '录音或伴奏为空' }, 400);

      let beatDur;
      try { beatDur = (await blobBuf(beat)).duration; }
      catch (e) { return json({ error: '伴奏片段解码失败：' + (e.message || e) }, 500); }

      const workId = header(opt, 'X-Work-Id');
      const list = read(LS.works, []);
      let work = workId ? list.find(w => w.id === workId) : null;
      if (!work) {
        work = {
          id: uid(6),
          track: track.id,
          title: track.title,
          created: Math.floor(Date.now() / 1000),
          offset_ms: offsetMs,
          duration: 0,
          vol_inst: 1,
          vol_vocal: 1,
          published: false,
          takes: [],
        };
        list.unshift(work);
      }
      const idx = work.takes.reduce((m, t) => Math.max(m, t.i), -1) + 1;
      await putBlob(`mic:${work.id}:${idx}`, mic);
      await putBlob(`beat:${work.id}:${idx}`, beat);
      work.takes.push({ i: idx, start: offsetMs / 1000, trim: 0, dur: Math.min(beatDur, 600) });

      let mix;
      try { mix = await renderWork(work, 1, 1, false); }
      catch (e) { return json({ error: '合成失败：' + (e.message || e) }, 500); }
      await putBlob('mix:' + work.id, mix.blob);
      dropWorkUrl(work.id);
      work.duration = Math.round(mix.duration * 100) / 100;
      work.offset_ms = Math.min(work.offset_ms, offsetMs);
      write(LS.works, list);
      return json(Object.assign({}, work, {
        mix: mixUrl(work.id, mix.blob),
        rec: '',
        take_count: work.takes.length,
      }));
    }

    if (p === '/api/work/cut') {
      const b = await bodyJson(opt);
      const list = read(LS.works, []);
      const w = list.find(x => x.id === b.id);
      if (!w) return json({ error: '没有这条录音' }, 404);
      const t = Math.max(0, Number(b.t) || 0);
      const keep = [];
      for (const take of (w.takes || []).slice().sort((x, y) => x.start - y.start)) {
        const end = take.start + take.dur;
        if (b.mode === 'after') {
          if (take.start >= t) { await delBlob(`mic:${w.id}:${take.i}`); await delBlob(`beat:${w.id}:${take.i}`); continue; }
          if (end > t) take.dur = Math.max(0.05, t - take.start);
          keep.push(take);
        } else {
          if (end <= t) { await delBlob(`mic:${w.id}:${take.i}`); await delBlob(`beat:${w.id}:${take.i}`); continue; }
          if (take.start < t) {
            const cut = t - take.start;
            take.start = t;
            take.trim = (take.trim || 0) + cut;
            take.dur -= cut;
          }
          if (take.dur <= 0.05) {
            await delBlob(`mic:${w.id}:${take.i}`);
            await delBlob(`beat:${w.id}:${take.i}`);
            continue;
          }
          keep.push(take);
        }
      }
      w.takes = keep;
      let mix = null, vocal = '';
      if (keep.length) {
        try {
          mix = await renderWork(w, w.vol_inst || 1, w.vol_vocal || 1, false);
          await putBlob('mix:' + w.id, mix.blob);
          dropWorkUrl(w.id);
          w.duration = Math.round(mix.duration * 100) / 100;
          const pv = await renderWork(w, w.vol_inst || 1, w.vol_vocal || 1, true);
          await putBlob('pv:' + w.id, pv.blob);
          vocal = URL.createObjectURL(pv.blob);
        } catch (e) { /* ignore */ }
      }
      write(LS.works, list);
      return json({ ok: true, work: w, vocal,
                    mix: mix ? mixUrl(w.id, mix.blob) : '',
                    duration: w.duration, empty: !keep.length });
    }

    if (p === '/api/remix') {
      const b = await bodyJson(opt);
      const list = read(LS.works, []);
      const w = list.find(x => x.id === b.id);
      if (!w) return json({ error: '没有这条录音' }, 404);
      const vi = Math.max(0, Math.min(Number(b.vol_inst ?? 1) || 0, 2));
      const vv = Math.max(0, Math.min(Number(b.vol_vocal ?? 1) || 0, 2));
      let mix;
      try { mix = await renderWork(w, vi, vv, false); }
      catch (e) { return json({ error: '重新合成失败：' + (e.message || e) }, 500); }
      await putBlob('mix:' + w.id, mix.blob);
      dropWorkUrl(w.id);
      w.vol_inst = vi; w.vol_vocal = vv;
      w.duration = Math.round(mix.duration * 100) / 100;
      write(LS.works, list);
      return json({ ok: true, mix: mixUrl(w.id, mix.blob), duration: w.duration });
    }

    if (p === '/api/publish') {
      const b = await bodyJson(opt);
      const list = read(LS.works, []);
      const w = list.find(x => x.id === b.id);
      if (!w) return json({ error: '没有这条录音' }, 404);
      w.published = true;
      write(LS.works, list);
      return json({ ok: true, work: w });
    }

    if (p === '/api/works/delete') {
      const b = await bodyJson(opt);
      const list = read(LS.works, []);
      const w = list.find(x => x.id === b.id);
      write(LS.works, list.filter(x => x.id !== b.id));
      dropWorkUrl(b.id);
      for (const t of (w && w.takes) || []) {
        await delBlob(`mic:${b.id}:${t.i}`);
        await delBlob(`beat:${b.id}:${t.i}`);
      }
      await delBlob('pv:' + b.id);
      await delBlob('mix:' + b.id);
      return json({ ok: true });
    }

    if (p === '/api/works/claim') return json({ ok: true });

    return json({ error: 'not found' }, 404);
  }

  /* ---------- fetch 拦截 ---------- */
  const _handle = handle;
  window.fetch = function (url, opt = {}) {
    const s = typeof url === 'string' ? url : (url && url.url) || '';
    if (s.startsWith('/lrc/')) {
      const id = s.slice(5).replace(/\.lrc$/, '');
      return Promise.resolve(textResp(lrcMap()[id] || ''));
    }
    if (s.startsWith('/api/')) return _handle(s, opt);
    return nativeFetch(url, opt);
  };

  window.StaticStore = { read, write, LS };
})();
