/* fit.py 的浏览器版：把任意文本按曲式排成固定行数，并算出每行的时间点。 */
(function (global) {
  const CJK = /[一-鿿]/;
  const CJK_PUNCT = /[，。！？、；：,.!?;:\s]/g;
  const WORD_PUNCT = /[,.!?;:'"\s]/g;
  const CJK_SEPS = ["。", "！", "？", "；", "，", "、"];
  const CJK_SOFT = "的了着过是在和与都也就还又但把被给让从对这那我你他她它";
  const EN_SEPS = [". ", "! ", "? ", "; ", ", ", " and ", " but ", " so ", " because ", "&"];
  const CONJ_SEPS = new Set([" and ", " but ", " so ", " because "]);
  const SECTION_RE = /^\[?(verse|hook|chorus|bridge|outro|intro|主歌|副歌|说唱|过渡|开头|结尾)\s*(\d+)?\]?[:：]?$/i;

  const isCjk = s => CJK.test(s);

  function countWords(line) {
    line = String(line || "").trim();
    if (!line) return 0;
    if (isCjk(line)) return line.replace(CJK_PUNCT, "").length;
    return line.replace(WORD_PUNCT, " ").split(/\s+/).filter(Boolean).length;
  }

  function limitsFor(tpl, text) {
    const [lo, hi] = tpl.words;
    return isCjk(text) ? [lo * 2, hi * 2] : [lo, hi];
  }

  const lowerFirst = s => (s ? s[0].toLowerCase() + s.slice(1) : s);

  function cjqCut(line, maxW) {
    const limit = Math.min(line.length, maxW);
    const lo = Math.max(1, Math.floor(maxW * 0.6));
    for (let i = limit; i > lo - 1; i--) {
      if (i < line.length && CJK_SOFT.includes(line[i - 1])) return i;
    }
    return limit;
  }

  function bestCut(line, seps) {
    const mid = line.length / 2;
    for (const sep of seps) {
      const pos = [];
      for (let i = 1; i < line.length; i++) if (line.startsWith(sep, i)) pos.push(i);
      if (pos.length && pos[0] < line.length - sep.length) {
        return [pos.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a)), sep];
      }
    }
    return [null, null];
  }

  function splitLong(line, maxW) {
    line = String(line || "").trim();
    const n = countWords(line);
    if (n <= maxW) return [[line], false];

    const cjk = isCjk(line);
    const [idx, sep] = bestCut(line, cjk ? CJK_SEPS : EN_SEPS);
    if (idx !== null && idx !== undefined) {
      let head = cjk ? line.slice(0, idx + 1) : line.slice(0, idx).replace(/\s+$/, "");
      let tail = line.slice(idx + sep.length).trim();
      if (head.trim() && tail) {
        if (!cjk) {
          if (!".[!?;:]".includes(head[head.length - 1])) head += ",";
          if (CONJ_SEPS.has(sep)) tail = lowerFirst(tail);
        }
        const [a] = splitLong(head, maxW);
        const [b] = splitLong(tail, maxW);
        return [a.concat(b), true];
      }
    }

    if (n > maxW * 1.25) {
      let cut;
      if (cjk) {
        cut = cjqCut(line, maxW);
      } else {
        const words = line.split(/\s+/).filter(Boolean);
        cut = words.slice(0, Math.max(1, Math.floor(words.length / 2))).join(" ").length;
      }
      if (cut > 0 && cut < line.length) {
        return [splitLong(line.slice(0, cut), maxW)[0]
          .concat(splitLong(line.slice(cut), maxW)[0]), true];
      }
    }
    return [[line], false];
  }

  function normalize(text, minW, maxW, merge = true) {
    const raw = String(text || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const frags = [];
    for (const line of raw) {
      const [parts, split] = splitLong(line, maxW);
      for (const p of parts) frags.push({ text: p, complete: !split });
    }

    const out = [];
    let i = 0;
    while (merge && i < frags.length) {
      const cur = frags[i];
      if (cur.complete && countWords(cur.text) < minW
          && i + 1 < frags.length && frags[i + 1].complete) {
        const nxt = frags[i + 1];
        const joiner = isCjk(cur.text) ? "" : ", ";
        const joined = cur.text.replace(/[，,。.；;、\s]+$/, "") + joiner + nxt.text;
        if (countWords(joined) <= maxW) {
          out.push({ text: joined, complete: true });
          i += 2;
          continue;
        }
      }
      out.push(cur);
      i += 1;
    }
    for (; i < frags.length; i++) out.push(frags[i]);
    return out;
  }

  function parseSections(text) {
    const sections = [];
    let cur = ["Verse", []];
    let found = false;
    for (const raw of String(text || "").split(/\r?\n/)) {
      const s = raw.trim();
      if (!s) continue;
      const m = s.match(SECTION_RE);
      if (m) {
        found = true;
        if (cur[1].length) sections.push(cur);
        const name = m[1].toLowerCase();
        if (["副歌", "hook", "chorus"].includes(name)) cur = ["Hook", []];
        else if (["主歌", "verse", "说唱"].includes(name)) cur = ["Verse", []];
        else cur = [m[1], []];
        continue;
      }
      cur[1].push(s);
    }
    if (cur[1].length) sections.push(cur);
    return found ? sections : null;
  }

  const isHookName = name => /^(hook|chorus)/i.test(name);

  function fitFlex(text, tpl, introBars = 2.0) {
    const [minW, maxW] = limitsFor(tpl, text);
    const items = normalize(text, minW, maxW, false);
    if (!items.length) throw new Error("文本为空");

    const parsed = parseSections(text);
    let hookPool = [];
    let versePool = [];
    if (parsed) {
      const hookText = parsed.filter(([n]) => n === "Hook")
        .map(([, ls]) => ls.join("\n")).join("\n");
      if (hookText.trim()) {
        hookPool = normalize(hookText, minW, maxW, false).map(i => i.text);
      }
      versePool = [];
      for (const [n, ls] of parsed) {
        if (n !== "Verse") continue;
        versePool = versePool.concat(normalize(ls.join("\n"), minW, maxW, false).map(i => i.text));
      }
    } else {
      versePool = items.map(i => i.text);
    }

    const slots = [];
    for (const s of tpl.sections) {
      const per = s.bars / s.lines;
      for (let k = 0; k < s.lines; k++) slots.push([s.name, per]);
    }

    let vi = 0, hi = 0;
    const filled = [];
    for (const [name, per] of slots) {
      if (isHookName(name) && hookPool.length) {
        if (hi < hookPool.length) {
          filled.push([name, per, hookPool[hi]]);
          hi += 1;
          continue;
        }
      }
      if (vi < versePool.length) {
        filled.push([name, per, versePool[vi]]);
        vi += 1;
        continue;
      }
      break;
    }

    const used = filled.length;
    const dropped = Math.max(0, versePool.length + hookPool.length - used);
    const totalBars = filled.reduce((a, [, per]) => a + per, 0);
    const backingBars = tpl.sections.reduce((a, s) => a + (s.bars || 8), 0);
    const pad = totalBars + introBars <= backingBars ? introBars : 0;
    const bars = totalBars + pad;
    const secPerBar = 240.0 / tpl.bpm;

    const sections = [];
    for (const [name, , line] of filled) {
      if (sections.length && sections[sections.length - 1][0] === name) {
        sections[sections.length - 1][1].push(line);
      } else {
        sections.push([name, [line]]);
      }
    }

    let t = pad * secPerBar;
    const lrc = [];
    for (const [, per, line] of filled) {
      lrc.push([Math.round(t * 100) / 100, line]);
      t += per * secPerBar;
    }

    return {
      sections,
      lrc,
      duration: Math.round(bars * secPerBar * 100) / 100,
      bars: Math.round(bars * 100) / 100,
      used,
      dropped,
      intro: Math.round(pad * secPerBar * 100) / 100,
    };
  }

  function render(sections, withHeaders = true) {
    const out = [];
    for (const [name, block] of sections) {
      if (withHeaders) out.push(`[${name}]`);
      out.push(...block);
    }
    return out.join("\n");
  }

  function lrcText(pairs) {
    const ts = s => {
      const m = Math.floor(s / 60);
      return `[${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(2).padStart(5, "0")}]`;
    };
    return pairs.map(([t, line]) => ts(t) + line).join("\n") + "\n";
  }

  global.FIT = { countWords, limitsFor, normalize, parseSections, fitFlex, render, lrcText };
})(window);
