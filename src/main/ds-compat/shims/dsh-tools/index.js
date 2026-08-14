/*
 * CIBYP 自研的 @deepseek-ai/dsh-tools 契约 shim。
 * 提供 DeepSeek 插件作者常用的 defineTool() 表面（参数 DSL → 校验 → 规范输出），
 * 但执行注册进 CIBYP 自己的 ToolsService（ctx.tools），不引入 dsh 任何 agent 逻辑。
 */

'use strict';

/**
 * 把 dsh 的 ParameterSchemaSpec DSL 转成 OpenAI 风格 JSON Schema（子集）。
 * 支持：string/number/boolean/array/object，字段级 type/required/description/enum/items/properties。
 */
function parameterToJsonSchema(spec) {
  if (!spec || typeof spec !== 'object') return { type: 'string' };
  if (Array.isArray(spec)) return { type: 'string', enum: spec.map(String) };
  const out = {};
  if (spec.type) out.type = spec.type;
  if (spec.description) out.description = spec.description;
  if (Array.isArray(spec.enum)) out.enum = spec.enum;
  if (spec.type === 'array' && spec.items) out.items = parameterToJsonSchema(spec.items);
  if (spec.type === 'object' && spec.properties && typeof spec.properties === 'object') {
    out.properties = {};
    out.required = [];
    for (const [key, field] of Object.entries(spec.properties)) {
      const fieldSpec = field && typeof field === 'object' ? field : { type: 'string', description: String(field) };
      out.properties[key] = parameterToJsonSchema(fieldSpec);
      if (fieldSpec.required) out.required.push(key);
    }
    if (!out.required.length) delete out.required;
    if (spec.additionalProperties !== undefined) out.additionalProperties = spec.additionalProperties;
  }
  return out;
}

/**
 * defineTool 子集：返回一个注册用定义对象（形状贴近 dsh，但注册目标是 CIBYP ToolsService）。
 */
function defineTool(definition) {
  if (!definition || typeof definition !== 'object' || typeof definition.name !== 'string') {
    throw new Error('defineTool: name is required');
  }
  const parameters = definition.parameters && typeof definition.parameters === 'object'
    ? parameterToJsonSchema(definition.parameters)
    : { type: 'object', properties: {} };
  return {
    name: definition.name,
    description: String(definition.description || definition.name),
    parameters,
    output: definition.output || null,
    execute: definition.execute,
    presentationMeta: definition.presentationMeta || null,
    presentCall: definition.presentCall || null,
    presentResult: definition.presentResult || null,
    timeoutMs: Number.isFinite(definition.timeoutMs) && definition.timeoutMs > 0 ? definition.timeoutMs : 120000,
    // 原始参数 DSL 保留，供宿主做 dsh 风格参数校验（本 shim 提供轻量校验）
    _rawParameters: definition.parameters || null
  };
}

/** 轻量参数校验（dsh 语义子集）：required / 类型 / enum */
function validateArgs(definition, args) {
  const raw = definition?._rawParameters;
  const errors = [];
  if (raw && typeof raw === 'object' && raw.properties) {
    for (const [key, field] of Object.entries(raw.properties)) {
      const f = field && typeof field === 'object' ? field : { type: 'string' };
      const value = args ? args[key] : undefined;
      if (f.required && (value === undefined || value === null || value === '')) {
        errors.push(`missing required parameter: ${key}`);
        continue;
      }
      if (value === undefined || value === null) continue;
      const type = f.type || 'string';
      if (type === 'string' && typeof value !== 'string') errors.push(`${key} must be a string`);
      else if (type === 'number' && typeof value !== 'number') errors.push(`${key} must be a number`);
      else if (type === 'boolean' && typeof value !== 'boolean') errors.push(`${key} must be a boolean`);
      else if (type === 'array' && !Array.isArray(value)) errors.push(`${key} must be an array`);
      else if (Array.isArray(f.enum) && !f.enum.includes(value)) errors.push(`${key} must be one of: ${f.enum.join(', ')}`);
    }
  }
  if (errors.length) {
    const err = new Error(errors.join('; '));
    err.name = 'ToolArgsError';
    err.code = 'INVALID_ARGS';
    throw err;
  }
  return args || {};
}

module.exports = { defineTool, validateArgs, parameterToJsonSchema };
