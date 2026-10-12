/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
function registerNodeTools({ bind, getSettings }) {
  const { WebResearch, requestText, normalizeResults } = require('../main/services/web-research');
  const web = new WebResearch({
    getSettings,
    bingSearch: async (query) => {
      const { parseDocument, DomUtils } = require('htmlparser2');
      const { text } = await requestText(
        'https://www.bing.com/search?q=' + encodeURIComponent(query),
        { maxBytes: 2 * 1024 * 1024 },
      );
      const dom = parseDocument(text);
      const rows = DomUtils.findAll(
        (n) => n.name === 'li' && /(?:^|\s)b_algo(?:\s|$)/.test(n.attribs?.class || ''),
        dom.children,
      ).map((node) => {
        const h2 = DomUtils.findOne((n) => n.name === 'h2', node.children),
          a = h2 && DomUtils.findOne((n) => n.name === 'a', h2.children),
          p = DomUtils.findOne((n) => n.name === 'p', node.children);
        return {
          title: a ? DomUtils.textContent(a) : '',
          url: a?.attribs?.href || '',
          snippet: p ? DomUtils.textContent(p) : '',
        };
      });
      const results = normalizeResults(rows, 'bing');
      if (!results.length) throw new Error('Bing returned no results; use another engine');
      return results;
    },
  });
  for (const [channel, action] of [
    ['web:search', 'search'],
    ['web:fetch', 'read'],
  ])
    bind(channel, async (options) => {
      try {
        return await web[action](options);
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });
  const math = require('../main/math-tools');
  for (const [action, handler] of Object.entries({
    evaluate: 'evaluateCalcExpression',
    factorInteger: 'factorInteger',
    gcdLcm: 'calcGcdLcm',
    baseConvert: 'convertBase',
    factorial: 'calcFactorial',
    complexMath: 'complexMath',
    matrixMath: 'matrixMath',
    vectorMath: 'vectorMath',
    solveInequality: 'solveInequality',
    solveLinearSystem: 'solveLinearSystem',
    solvePolynomial: 'solvePolynomial',
    distributionCalc: 'distributionCalc',
    combinatorics: 'combinatorics',
    fractionBaseConvert: 'fractionBaseConvert',
  })) {
    if (typeof math[handler] !== 'function') continue;
    bind('calc:' + action, (...args) => {
      try {
        return { ok: true, ...math[handler](...args) };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });
  }
  return new Set([
    'webSearch',
    'webFetch',
    'calculator',
    'factorInteger',
    'gcdLcm',
    'baseConvert',
    'factorial',
    'complexMath',
    'matrixMath',
    'vectorMath',
    'solveInequality',
    'solveLinearSystem',
    'solvePolynomial',
    'distributionCalc',
    'combinatorics',
    'fractionBaseConvert',
    'getSystemInfo',
  ]);
}
module.exports = { registerNodeTools };
