/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const LABELS = {
  'zh-CN': {
    unavailable: '额度不可用',
    managePlan:
      '当前登录方式无法读取订阅额度，请到 ChatGPT 官网查看（不影响正常使用）。',
    remaining: '剩余',
    reset: '重置时间',
    '5hour': '5 小时',
    weekly: '每周',
    monthly: '每月',
    other: '额度',
    equivalent: 'API 等效',
    reference: '今日按 API 价目表估算的参考消费（非订阅实际扣费）',
    partial: '部分请求未配置价格',
    api: '今日 API 消费',
  },
  en: {
    unavailable: 'Usage unavailable',
    managePlan:
      'This login does not expose subscription limits. Check them on ChatGPT—models still work normally.',
    remaining: 'remaining',
    reset: 'Resets',
    '5hour': '5-hour',
    weekly: 'Weekly',
    monthly: 'Monthly',
    other: 'Usage',
    equivalent: 'API equivalent',
    reference: 'Estimated API-equivalent cost for today (not a subscription charge)',
    partial: 'Some requests have no reference price',
    api: 'Today’s API spending',
  },
  de: {
    unavailable: 'Kontingent nicht verfügbar',
    managePlan:
      'Diese Anmeldung liefert keine Abo-Limits. Prüfe sie direkt bei ChatGPT – Modelle funktionieren weiter normal.',
    remaining: 'verbleibend',
    reset: 'Zurücksetzung',
    '5hour': '5 Stunden',
    weekly: 'Wöchentlich',
    monthly: 'Monatlich',
    other: 'Kontingent',
    equivalent: 'API-Vergleich',
    reference: 'Heutiger Schätzwert nach API-Preisen (nur zur Orientierung)',
    partial: 'Für einige Anfragen fehlt ein Preis',
    api: 'Heutige API-Kosten',
  },
};
function formatUsage(data, language = 'zh-CN') {
  const labels = LABELS[language] || LABELS.en;
  let text;
  let title;
  let pct = 0;
  if (!data.subscription) {
    const daily = data.daily || {};
    const cost = daily.costUSD || 0;
    const limit = daily.limitUSD || 0;
    text = `$${cost.toFixed(4)}${limit > 0 ? ' / $' + limit.toFixed(2) : ''}`;
    title = labels.api;
    pct = limit > 0 ? (cost / limit) * 100 : 0;
  } else if (data.mode === 'api-equivalent' && data.equivalent) {
    const value = data.equivalent;
    const known = value.pricedRequests > 0 || value.unknownRequests === 0;
    text = known
      ? labels.equivalent +
        ' $' +
        value.costUSD.toFixed(4) +
        (data.equivalentLimitUSD > 0 ? ' / $' + data.equivalentLimitUSD.toFixed(2) : '') +
        (value.unknownRequests ? ' *' : '')
      : labels.unavailable;
    title = labels.reference + (value.unknownRequests ? '\n' + labels.partial : '');
    pct =
      known && data.equivalentLimitUSD > 0 ? (value.costUSD / data.equivalentLimitUSD) * 100 : 0;
  } else if (data.selected) {
    const window = data.selected;
    pct = window.usedPercent;
    text =
      (labels[window.period] || labels.other) +
      ' · ' +
      (100 - pct).toFixed(0) +
      '% ' +
      labels.remaining;
    title =
      (window.label || '') +
      (window.resetsAt
        ? '\n' + labels.reset + ': ' + new Date(window.resetsAt).toLocaleString(language)
        : '');
  } else {
    text = labels.unavailable;
    title = data.unavailable ? labels.managePlan : data.error || labels.unavailable;
  }
  return {
    text,
    title,
    pct: Math.max(0, Math.min(100, pct)),
    level: pct >= 100 ? 'danger' : pct >= 80 ? 'warn' : 'normal',
  };
}
module.exports = { formatUsage };
