/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function flattenModules(modules, prefix = '/node_modules', result = []) {
  for (const item of modules) {
    const directory = prefix + '/' + item.name;
    result.push({ ...item, packageDirectory: directory });
    if (item.dependencies) flattenModules(item.dependencies, directory + '/node_modules', result);
  }
  return result;
}
function locateDependency(packageDirectory, name, packageDirectories) {
  let directory = packageDirectory;
  for (;;) {
    const candidate = path.posix.join(directory, 'node_modules', name);
    if (packageDirectories.has(candidate)) return candidate;
    if (directory === '/') return null;
    directory = path.posix.dirname(directory);
  }
}
function auditPackages(packages) {
  const directories = new Set(packages.map((item) => item.packageDirectory));
  const issues = [];
  for (const { packageDirectory, manifest } of packages) {
    const optional = manifest.optionalDependencies || {};
    const required = new Map(
      Object.keys(manifest.dependencies || {})
        .filter((name) => !Object.hasOwn(optional, name))
        .map((name) => [name, 'dependency']),
    );
    for (const name of Object.keys(manifest.peerDependencies || {}))
      if (!manifest.peerDependenciesMeta?.[name]?.optional) required.set(name, 'peerDependency');
    for (const [name, relation] of required)
      if (!locateDependency(packageDirectory, name, directories))
        issues.push({ package: manifest.name, packageDirectory, missing: name, relation });
  }
  return issues;
}
function auditCollectedModules(root, modules) {
  const items = flattenModules(modules);
  return auditPackages([
    {
      packageDirectory: '/',
      manifest: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')),
    },
    ...items.map((item) => ({
      packageDirectory: item.packageDirectory,
      manifest: JSON.parse(fs.readFileSync(path.join(item.dir, 'package.json'), 'utf8')),
    })),
  ]);
}
function auditArchiveDependencies(entries, read) {
  const packages = [...entries]
    .filter(
      (file) =>
        file === '/package.json' ||
        (file.startsWith('/node_modules/') &&
          /\/node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(file)),
    )
    .map((file) => ({
      packageDirectory: path.posix.dirname(file),
      manifest: JSON.parse(read(file)),
    }))
    .filter((item) => item.packageDirectory === '/' || item.manifest.name);
  return auditPackages(packages);
}
async function collectProductionModules(root) {
  const {
    NpmNodeModulesCollector,
  } = require('app-builder-lib/out/node-module-collector/npmNodeModulesCollector');
  const temporary = new (require('temp-file').TmpDir)();
  try {
    const collector = new NpmNodeModulesCollector(root, temporary);
    const result = await collector.getNodeModules({
      packageName: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name,
    });
    return result.nodeModules;
  } finally {
    await temporary.cleanup();
  }
}
function assertNoIssues(issues) {
  if (issues.length)
    throw new Error(
      'Production dependency closure is incomplete:\n' +
        issues
          .map(
            (issue) =>
              `  ${issue.package}: missing ${issue.missing} (${issue.relation}) at ${issue.packageDirectory}`,
          )
          .join('\n'),
    );
}
async function verifyProductionDependencies(root) {
  const modules = await collectProductionModules(root);
  assertNoIssues(auditCollectedModules(root, modules));
  return modules;
}
module.exports = {
  flattenModules,
  locateDependency,
  auditPackages,
  auditCollectedModules,
  auditArchiveDependencies,
  collectProductionModules,
  assertNoIssues,
  verifyProductionDependencies,
};
