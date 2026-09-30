/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const location = new AsyncLocalStorage();
function isVmOperation(getService) {
  const selected = location.getStore();
  if (selected) return selected === 'vm';
  const service = getService?.();
  return service?.runtime.location === 'vm' && !service.emergencyHost;
}
function withToolLocation(getService, operation) {
  return location.run(isVmOperation(getService) ? 'vm' : 'host', operation);
}
function withRuntimeLocation(getService, operation) {
  const service = getService();
  return location.run(
    service.runtime.location === 'vm' && !service.emergencyHost ? 'vm' : 'host',
    operation,
  );
}
module.exports = { isVmOperation, withToolLocation, withRuntimeLocation };
