'use strict';
/**
 * 页面渲染器 IPC 桥（只用于 Electron 主进程）。
 * 初始化后全局保存渲染函数，供本地服务在抓不到内容时回调。
 */

let renderer = null;

function setRenderer(fn) {
  renderer = fn;
}

function clearRenderer() {
  renderer = null;
}

function getRenderer() {
  return renderer;
}

function hasRenderer() {
  return typeof renderer === 'function';
}

/**
 * 包装成“带超时保护”的渲染调用，避免渲染器卡死拖垮整个服务。
 */
function wrapRenderer(fn, timeoutMs = 30000) {
  return {
    async render(url, options = {}) {
      const limit = options.timeout || timeoutMs;
      let timer;
      try {
        return await Promise.race([
          fn(url, options),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`渲染超时（${limit}ms）`)), limit + 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

module.exports = { setRenderer, clearRenderer, getRenderer, hasRenderer, wrapRenderer };
