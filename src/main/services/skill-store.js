/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  { randomUUID } = require('node:crypto');
function createSkillStore({ directory, load, save, changed = () => {} }) {
  fs.mkdirSync(directory, { recursive: true });
  const file = (id) => {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new TypeError('Invalid skill ID');
    return path.join(directory, id + '.json');
  };
  const validate = (value) => {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024
    )
      throw new TypeError('Invalid skill');
  };
  return {
    list() {
      return fs
        .readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .map((name) => load(path.join(directory, name), {}));
    },
    create(value) {
      validate(value);
      const skill = { ...value, id: randomUUID(), createdAt: new Date().toISOString() };
      save(file(skill.id), skill);
      changed();
      return skill;
    },
    update(id, patch) {
      validate(patch);
      const target = file(id),
        skill = load(target, null);
      if (!skill) return { ok: false, error: 'Skill does not exist' };
      const updated = { ...skill, ...patch, id, updatedAt: new Date().toISOString() };
      save(target, updated);
      changed();
      return { ok: true, skill: updated };
    },
    remove(id) {
      try {
        fs.unlinkSync(file(id));
        changed();
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    },
  };
}
module.exports = { createSkillStore };
