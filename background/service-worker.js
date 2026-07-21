/*
 * Audio无限+ - Service Worker (MV3 后台)
 * 职责：
 *  1. 首次安装时写入默认设置
 *  2. 响应 content/booster 的 BAB_WHOAMI，回传其所属 tabId（实现分标签页管理）
 *  3. 按标签页更新扩展图标徽标（ON/OFF）
 *  4. 维护全局设置（babSettings）与默认状态
 */

const DEFAULT_STATE = { enabled: false, preset: 'balanced', masterGain: 1.0, clarity: 50, width: 100, custom: null };

function updateBadge(enabled, tabId) {
  const text = enabled ? 'ON' : '';
  const color = enabled ? '#6C5CE7' : '#7a7f8a';
  const opt = {};
  if (tabId != null) opt.tabId = tabId;
  chrome.action.setBadgeText({ text, ...opt });
  chrome.action.setBadgeBackgroundColor({ color, ...opt });
}

// 安装 / 更新
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get('babSettings', (res) => {
    if (!res || !res.babSettings) {
      chrome.storage.sync.set({
        babSettings: {
          theme: 'dark',
          accent: '#6C5CE7',
          modules: { vocal: true, denoise: true, compress: true, deesser: true, air: true, surround: false }
        }
      });
    }
  });
});

// 浏览器启动时同步全局徽标（取 global 键）
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.sync.get('babState_global', (res) => {
    updateBadge(res && res.babState_global ? res.babState_global.enabled : false);
  });
});

// 消息中枢
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'BAB_WHOAMI') {
    // content/booster 询问自身 tabId；sender.tab.id 在来自内容脚本时可用
    sendResponse({ tabId: sender.tab ? sender.tab.id : null });
    return true;
  }

  if (msg.type === 'BAB_STATE_CHANGED') {
    updateBadge(!!msg.enabled, msg.tabId != null ? msg.tabId : undefined);
    sendResponse({ ok: true });
    return true;
  }

  return true;
});

// 监听存储变化，保持徽标与状态同步（按标签页键）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  for (const key of Object.keys(changes)) {
    const m = /^babState_(.+)$/.exec(key);
    if (m) {
      const nv = changes[key].newValue;
      const tid = m[1] === 'global' ? undefined : parseInt(m[1], 10);
      if (nv) updateBadge(nv.enabled, tid);
    }
  }
});
