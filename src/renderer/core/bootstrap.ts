/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */

/** Bound optional dependency waits; a failure should be visible and diagnosable. */
export async function waitForDependency(ready: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, remaining)));
  }
  return true;
}

export function reportBootstrapFailure(error: unknown): void {
  console.error('[renderer] Initialization failed:', error);
  const api = (window as unknown as { api?: { rendererFailed?: (message: string) => void } }).api;
  api?.rendererFailed?.(error instanceof Error ? error.message : String(error));
  const notice = document.createElement('div');
  notice.setAttribute('role', 'alert');
  notice.style.cssText =
    'position:fixed;bottom:16px;left:16px;right:16px;padding:16px;background:#8b2020;color:white;z-index:100000';
  notice.textContent = '应用初始化失败，请重启应用或查看崩溃日志。';
  document.body.appendChild(notice);
}
