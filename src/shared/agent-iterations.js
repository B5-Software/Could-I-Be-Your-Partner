/* SPDX-License-Identifier: GPL-3.0-or-later */
(function (root) {
  'use strict';
  const DEFAULT_ITERATIONS = 1024;
  const valid = (value) => Number.isSafeInteger(value) && value >= 0;
  const limit = (value) => (valid(value) ? value : DEFAULT_ITERATIONS);
  function migrate(settings) {
    const agent = settings?.agent;
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return settings;
    const { maxIterations, ...current } = agent;
    if (!Object.hasOwn(current, 'iterationLimit') && valid(maxIterations) && maxIterations !== 50)
      current.iterationLimit = maxIterations;
    if (Object.hasOwn(current, 'iterationLimit'))
      current.iterationLimit = limit(current.iterationLimit);
    return { ...settings, agent: current };
  }
  const api = { DEFAULT_ITERATIONS, valid, limit, migrate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AgentIterations = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
