/* SPDX-License-Identifier: GPL-3.0-or-later */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TorBridges = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Tor Expert Bundle 15.0.24, tor/pluggable_transports/pt_config.json.
  const DEFAULT_MEEK =
    'meek_lite 192.0.2.20:80 url=https://1603026938.rsc.cdn77.org front=www.phpmyadmin.net utls=HelloRandomizedALPN';
  const TRANSPORTS = ['obfs4', 'snowflake', 'webtunnel', 'meek_lite'];
  function parse(text, allowEmpty = false) {
    const lines = String(text || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if ((!lines.length && !allowEmpty) || lines.length > 32)
      throw new Error('Enter 1–32 bridge lines');
    return lines.map((raw) => {
      if (raw.length > 4096 || /[\x00-\x1f\x7f]/.test(raw))
        throw new Error('Invalid Tor bridge line');
      const parts = raw.replace(/^Bridge\s+/i, '').split(/ +/);
      let transport = '';
      if (/^[a-z][a-z\d_]*$/i.test(parts[0])) {
        transport = parts.shift().toLowerCase();
        if (transport === 'meek') transport = 'meek_lite';
        if (!TRANSPORTS.includes(transport))
          throw new Error('Use obfs4, snowflake, webtunnel or meek bridges');
      }
      const address = parts.shift();
      const match = /^(?:\[([a-f\d:]+)\]|([\d.]+)):(\d+)$/i.exec(address || '');
      if (
        !match ||
        Number(match[3]) < 1 ||
        Number(match[3]) > 65535 ||
        (match[2] &&
          (match[2].split('.').length !== 4 ||
            match[2].split('.').some((n) => n === '' || Number(n) > 255)))
      )
        throw new Error('Invalid Tor bridge address');
      const fingerprint = /^[a-f\d]{40}$/i.test(parts[0] || '') ? parts.shift() : '';
      if (!transport && !fingerprint) throw new Error('A plain Tor bridge requires a fingerprint');
      if (parts.some((part) => !/^[\w-]+=\S+$/.test(part)))
        throw new Error('Invalid Tor bridge parameters');
      const args = Object.fromEntries(
        parts.map((part) => {
          const index = part.indexOf('=');
          return [part.slice(0, index), part.slice(index + 1)];
        }),
      );
      if (transport === 'meek_lite') {
        const urls = args.targets
          ? args.targets.split(',').map((target) => {
              const separator = target.indexOf('|');
              if (separator < 1) throw new Error('Invalid meek targets; use URL|front');
              return target.slice(0, separator);
            })
          : [args.url];
        if (!urls[0]) throw new Error('A meek bridge requires url= or targets=');
        for (const value of urls) {
          let url;
          try {
            url = new URL(value);
          } catch {
            throw new Error('Invalid meek URL');
          }
          if (
            !['http:', 'https:'].includes(url.protocol) ||
            !url.hostname ||
            url.username ||
            url.password
          )
            throw new Error('Invalid meek URL');
        }
      }
      return {
        transport,
        line: [transport, address, fingerprint, ...parts].filter(Boolean).join(' '),
      };
    });
  }
  return { DEFAULT_MEEK, TRANSPORTS, parse };
});
