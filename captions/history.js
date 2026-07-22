/*
 * Audio无限+ - 字幕历史页
 * 读取 storage.local.babSubtitleSessions，回看会话、逐句查看，导出 SRT / TXT。
 */
(function () {
  'use strict';
  const SUB = window.BAB_SUB;
  const listEl = document.getElementById('list');
  const hintEl = document.getElementById('hint');

  function fmtDate(ts) {
    const d = new Date(ts);
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function segTime(session, seg) {
    const base = new Date((session.startedAt || Date.now()) + (seg.start || 0) * 1000);
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return p(base.getHours()) + ':' + p(base.getMinutes()) + ':' + p(base.getSeconds());
  }
  function langName(code) {
    const m = (SUB.LANGS || []).find((l) => l.code === code);
    return m ? m.name : (code || '自动');
  }

  function loadSessions(cb) {
    try {
      chrome.storage.local.get('babSubtitleSessions', (r) => {
        const arr = (r && r.babSubtitleSessions) || [];
        cb(arr.slice().sort((a, b) => b.startedAt - a.startedAt));
      });
    } catch (e) { cb([]); }
  }

  function exportSession(session, format) {
    const text = format === 'txt' ? SUB.exportTXT(session, true) : SUB.exportSRT(session);
    const ext = format === 'txt' ? 'txt' : 'srt';
    const name = '字幕_' + fmtDate(session.startedAt).replace(/[: ]/g, '-') + '.' + ext;
    SUB.download(name, text);
  }

  function render(sessions) {
    listEl.innerHTML = '';
    if (!sessions.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = '暂无字幕记录。在插件弹窗里点「开始字幕」后，实时识别的文字会保存在这里。';
      listEl.appendChild(e);
      hintEl.style.display = 'none';
      return;
    }
    hintEl.style.display = 'none';
    sessions.forEach((sess, idx) => {
      const card = document.createElement('div');
      card.className = 'session';
      const count = (sess.segments || []).length;
      const card2 = document.createElement('div');
      card2.className = 's-head';
      card2.innerHTML =
        '<div class="meta"><div class="s-date">' + fmtDate(sess.startedAt) + '</div>' +
        '<div class="s-sub">引擎：' + (sess.engine || '-') + ' · 语言：' + langName(sess.lang) +
        ' · 共 ' + count + ' 句</div></div>' +
        '<div class="s-actions">' +
        '<button class="btn" data-act="srt">SRT</button>' +
        '<button class="btn" data-act="txt">TXT</button>' +
        '<button class="btn danger" data-act="del">删除</button>' +
        '</div>';
      const body = document.createElement('div');
      body.className = 's-body';
      if (!count) {
        body.innerHTML = '<div class="seg"><div class="x">本会话没有识别到文字。</div></div>';
      } else {
        sess.segments.forEach((seg) => {
          const row = document.createElement('div');
          row.className = 'seg';
          row.innerHTML = '<div class="t">' + segTime(sess, seg) + '</div><div class="x"></div>';
          row.querySelector('.x').textContent = seg.text || '';
          body.appendChild(row);
        });
      }
      card.appendChild(card2);
      card.appendChild(body);
      card2.addEventListener('click', (e) => {
        if (e.target.closest('.btn')) return;
        card.classList.toggle('open');
      });
      card2.querySelector('[data-act="srt"]').addEventListener('click', () => exportSession(sess, 'srt'));
      card2.querySelector('[data-act="txt"]').addEventListener('click', () => exportSession(sess, 'txt'));
      card2.querySelector('[data-act="del"]').addEventListener('click', () => {
        if (!confirm('确定删除这条字幕记录？')) return;
        loadSessions((all) => {
          const next = all.filter((s) => s.startedAt !== sess.startedAt);
          try { chrome.storage.local.set({ babSubtitleSessions: next }); } catch (e) {}
          render(next);
        });
      });
      listEl.appendChild(card);
    });
  }

  document.getElementById('clearAll').addEventListener('click', () => {
    if (!confirm('确定清空全部字幕历史？此操作不可恢复。')) return;
    try { chrome.storage.local.set({ babSubtitleSessions: [] }); } catch (e) {}
    render([]);
  });
  document.getElementById('exportAll').addEventListener('click', () => {
    loadSessions((sessions) => {
      if (!sessions.length) { alert('没有可导出的字幕。'); return; }
      const fmt = (SUB.DEFAULTS.exportFormat) || 'srt';
      // 合并所有会话为一个文件，按时间排序
      const merged = { startedAt: Date.now(), segments: [] };
      sessions.slice().reverse().forEach((s) => {
        (s.segments || []).forEach((seg) => merged.segments.push(seg));
      });
      const text = fmt === 'txt' ? SUB.exportTXT(merged, true) : SUB.exportSRT(merged);
      SUB.download('字幕_全部.' + (fmt === 'txt' ? 'txt' : 'srt'), text);
    });
  });

  loadSessions(render);
})();
