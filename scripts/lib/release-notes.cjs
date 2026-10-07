/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { execFileSync, spawnSync } = require('node:child_process');
const START = '<!-- cibyp-release-notes:start -->';
const END = '<!-- cibyp-release-notes:end -->';
const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/;

function compareVersions(a, b) {
  const left = a.match(versionPattern),
    right = b.match(versionPattern);
  if (!left || !right) throw Error('Invalid release version');
  for (let i = 1; i <= 3; i++) {
    if (Number(left[i]) !== Number(right[i])) return Number(left[i]) - Number(right[i]);
  }
  if (!left[4] || !right[4]) return left[4] ? -1 : right[4] ? 1 : 0;
  const x = left[4].split('.'),
    y = right[4].split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined || y[i] === undefined) return x[i] === undefined ? -1 : 1;
    if (x[i] === y[i]) continue;
    const nx = /^\d+$/.test(x[i]),
      ny = /^\d+$/.test(y[i]);
    if (nx && ny) return Number(x[i]) - Number(y[i]);
    if (nx !== ny) return nx ? -1 : 1;
    return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

function escapeMarkdown(value) {
  return value.replace(/[\\`*_{}\[\]<>#|]/g, '\\$&');
}

function generateReleaseNotes({
  version,
  to = 'v' + version,
  from,
  repo,
  cwd = process.cwd(),
  publishedTags,
}) {
  if (!versionPattern.test(version)) throw Error('Invalid release version');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw Error('Invalid GitHub repository');
  const validRef = (ref) =>
    /^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(ref) || /^[a-f\d]{7,40}$/i.test(ref);
  const git = (args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  const resolve = (ref) => {
    if (!validRef(ref)) throw Error('Invalid release revision');
    return git(['rev-parse', '--verify', ref + '^{commit}']);
  };
  const revision = resolve(to);
  const ancestor = (ref) =>
    spawnSync('git', ['merge-base', '--is-ancestor', ref, revision], { cwd, windowsHide: true })
      .status === 0;
  if (from) {
    resolve(from);
    if (!ancestor(from)) throw Error('Previous release is not an ancestor of the target');
  } else {
    const published = publishedTags === undefined ? null : new Set(publishedTags);
    const tags = git(['tag', '--list'])
      .split('\n')
      .filter(
        (tag) =>
          tag.startsWith('v') &&
          versionPattern.test(tag.slice(1)) &&
          compareVersions(tag.slice(1), version) < 0 &&
          (!published || published.has(tag)),
      );
    tags.sort((a, b) => compareVersions(b.slice(1), a.slice(1)));
    from = tags.find(ancestor);
  }
  const fields = git([
    'log',
    '--reverse',
    '--topo-order',
    '--format=%H%x00%s%x00%b%x00',
    from ? from + '..' + revision : revision,
  ]).split('\0');
  const commits = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const sha = fields[i].trim();
    if (sha) commits.push({ sha, subject: fields[i + 1], body: fields[i + 2].trim() });
  }
  const groups = [
    ['新增功能 / Features', /^(?:feat|feature)(?:\([^)]*\))?!?:/i],
    ['修复 / Fixes', /^(?:fix|revert)(?:\([^)]*\))?!?:|^(?:fix|repair|resolve)\b/i],
    ['改进 / Improvements', /^(?:perf|refactor)(?:\([^)]*\))?!?:/i],
    ['文档 / Documentation', /^docs?(?:\([^)]*\))?!?:/i],
    ['工程与发布 / Engineering', /^(?:ci|build|test|chore|style)(?:\([^)]*\))?!?:/i],
    ['其他变更 / Other changes', /.*/],
  ];
  const url = 'https://github.com/' + repo;
  const lines = [
    START,
    '## 更新日志 / Changelog',
    '',
    `**v${version}** · ${commits.length} 项提交 / commits`,
    '',
  ];
  if (from) lines.push(`版本范围 / Range: \`${from}\` → \`v${version}\``, '');
  else
    lines.push(
      '首次发布，包含此前全部提交 / Initial release, including all preceding commits.',
      '',
    );
  for (const [title, pattern] of groups) {
    const selected = commits.filter(
      (commit) => groups.find(([, match]) => match.test(commit.subject))[1] === pattern,
    );
    if (!selected.length) continue;
    lines.push('### ' + title, '');
    for (const commit of selected) {
      lines.push(
        `- ${escapeMarkdown(commit.subject)} ([${commit.sha.slice(0, 7)}](${url}/commit/${commit.sha}))`,
      );
      if (commit.body) {
        const fence = '`'.repeat(
          [...commit.body.matchAll(/`+/g)].reduce(
            (length, match) => Math.max(length, match[0].length + 1),
            3,
          ),
        );
        lines.push(
          '',
          '  <details>',
          '  <summary>提交详情 / Commit details</summary>',
          '',
          '  ' + fence + 'text',
          ...commit.body.split(/\r?\n/).map((line) => '  ' + line),
          '  ' + fence,
          '',
          '  </details>',
          '',
        );
      }
    }
    lines.push('');
  }
  if (!commits.length)
    lines.push('本版本没有新增提交 / No additional commits in this version.', '');
  lines.push(
    `[完整差异 / Full diff](${url}/${from ? 'compare/' + encodeURIComponent(from) + '...v' + encodeURIComponent(version) : 'tree/' + revision})`,
    '',
    END,
  );
  return { version, from: from || null, revision, commits, markdown: lines.join('\n') + '\n' };
}

function mergeReleaseNotes(body, notes) {
  // Only standalone markers are ours. Commit bodies may quote these strings.
  const markers = [...body.matchAll(/^<!-- cibyp-release-notes:(start|end) -->\r?$/gm)];
  if (
    markers.length &&
    (markers.length !== 2 || markers[0][1] !== 'start' || markers[1][1] !== 'end')
  )
    throw Error('Malformed managed release notes; preserve the existing body');
  if (!markers.length) return notes.trim() + (body.trim() ? '\n\n' + body.trim() : '') + '\n';
  return (
    body.slice(0, markers[0].index) +
    notes.trim() +
    body.slice(markers[1].index + markers[1][0].length)
  );
}
module.exports = { generateReleaseNotes, mergeReleaseNotes, compareVersions };
