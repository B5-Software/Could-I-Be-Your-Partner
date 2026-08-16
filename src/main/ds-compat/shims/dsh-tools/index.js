/*
 * CIBYP 自研的 @deepseek-ai/dsh-tools 契约 shim。
 *
 * 提供 DeepSeek 插件作者常用的 defineTool() 表面（参数 DSL → 校验 → 规范输出），
 * 但执行注册进 CIBYP 自己的 ToolsService（ctx.tools），不引入 dsh 任何 agent 逻辑。
 *
 * 上游 0.1.0-rc.6（2026-08-13 公开发布）把 defineTool 的 output 重定义为
 * { schema, render, presentationMeta? }，并新增了 RUN_CODE_NAME / CodeRunFailedError /
 * ToolArgsError / JsonSchemaError / valueSchemaSpecToJsonSchema 等运行时导出。
 * 本 shim 兼容新旧两种调用形态，保证老插件与 rc.6 新插件都能加载。
 */

'use strict';

/**
 * 把 dsh 的 ParameterSchemaSpec DSL 转成 OpenAI 风格 JSON Schema（子集）。
 * 支持：string/number/boolean/array/object，字段级 type/required/description/enum/items/properties。
 */
function parameterToJsonSchema(spec) {
  if (!spec || typeof spec !== 'object') return { type: 'string' };
  if (Array.isArray(spec)) return { type: 'string', enum: spec.map(String) };
  // 区分两种 DSL：
  //  - rc.6 逐属性参数 DSL：{ a: {type,required,...}, b: {...} }（隐式 object 根）
  //  - 显式 schema 节点：含 type/properties/enum/items/oneOf 等键
  const hasNodeShape = spec.type !== undefined || spec.properties !== undefined
    || spec.enum !== undefined || spec.items !== undefined || spec.oneOf !== undefined;
  if (!hasNodeShape) {
    const properties = {};
    const required = [];
    for (const [key, field] of Object.entries(spec)) {
      const fieldSpec = field && typeof field === 'object' ? field : { type: 'string', description: String(field) };
      properties[key] = valueSchemaSpecToJsonSchema(fieldSpec);
      if (fieldSpec.required) required.push(key);
    }
    const out = { type: 'object', properties };
    if (required.length) out.required = required;
    return out;
  }
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
 * ValueSchemaSpec DSL → JSON Schema（string/number/boolean/null/array/object/oneOf 子集）。
 * 与 parameterToJsonSchema 共享字段语义，仅不拼装隐式 object 根。
 */
function valueSchemaSpecToJsonSchema(spec) {
  if (!spec || typeof spec !== 'object') return { type: 'string' };
  if (Array.isArray(spec)) return { type: 'string', enum: spec.map(String) };
  if (spec.oneOf && Array.isArray(spec.oneOf)) {
    return { oneOf: spec.oneOf.map(valueSchemaSpecToJsonSchema) };
  }
  const out = {};
  if (spec.type) out.type = spec.type;
  if (spec.description) out.description = spec.description;
  if (Array.isArray(spec.enum)) out.enum = spec.enum;
  if (spec.const !== undefined) out.const = spec.const;
  if (spec.type === 'array' && spec.items) out.items = valueSchemaSpecToJsonSchema(spec.items);
  if (spec.type === 'object' && spec.properties && typeof spec.properties === 'object') {
    out.properties = {};
    out.required = [];
    for (const [key, field] of Object.entries(spec.properties)) {
      const fieldSpec = field && typeof field === 'object' ? field : { type: 'string', description: String(field) };
      out.properties[key] = valueSchemaSpecToJsonSchema(fieldSpec);
      if (fieldSpec.required) out.required.push(key);
    }
    if (!out.required.length) delete out.required;
    if (spec.additionalProperties !== undefined) out.additionalProperties = spec.additionalProperties;
  }
  return out;
}

// 上游官方名称：parameterSchemaSpecToJsonSchema 与 valueSchemaSpecToJsonSchema
const parameterSchemaSpecToJsonSchema = parameterToJsonSchema;

/** 参数校验失败（插件按 err.name === 'ToolArgsError' / err.code === 'INVALID_ARGS' 捕获） */
class ToolArgsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolArgsError';
    this.code = 'INVALID_ARGS';
  }
}

/** 不支持的 JSON Schema 子集（与上游 JsonSchemaError 形状一致：violations 列表） */
class JsonSchemaError extends Error {
  constructor(violations) {
    const list = Array.isArray(violations) ? violations : [violations];
    super(`unsupported JSON schema: ${list.join('; ')}`);
    this.name = 'JsonSchemaError';
    this.code = 'UNSUPPORTED_SCHEMA';
    this.violations = list;
  }
}

/** Code Mode 保留工具名（上游常量 'run_code'） */
const RUN_CODE_NAME = 'run_code';

/** Code Mode 执行失败错误（形状贴近上游 CodeRunFailedError） */
class CodeRunFailedError extends Error {
  constructor(message, info) {
    super(message || 'code run failed');
    this.name = 'CodeRunFailedError';
    this.code = 'CODE_RUN_FAILED';
    if (info) this.info = info;
  }
}

/**
 * defineTool 子集：返回一个注册用定义对象（形状贴近 dsh，但注册目标是 CIBYP ToolsService）。
 */
function defineTool(definition) {
  if (!definition || typeof definition !== 'object' || typeof definition.name !== 'string') {
    throw new Error('defineTool: name is required');
  }
  if (definition.name === RUN_CODE_NAME) {
    throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for Code Mode and cannot be registered`);
  }
  const parameters = definition.parameters && typeof definition.parameters === 'object'
    ? parameterToJsonSchema(definition.parameters)
    : { type: 'object', properties: {} };
  // 上游 rc.6：output 是 { schema, render, presentationMeta? }；
  // 老插件：output 可为任意 schema/描述值，presentationMeta/presentCall/presentResult 在顶层。
  const output = definition.output || null;
  return {
    name: definition.name,
    description: String(definition.description || definition.name),
    parameters,
    output,
    execute: definition.execute,
    isConcurrencySafe: typeof definition.isConcurrencySafe === 'function' ? definition.isConcurrencySafe : null,
    finalizeContent: typeof definition.finalizeContent === 'function' ? definition.finalizeContent : null,
    presentationMeta: (output && typeof output.presentationMeta === 'function' ? output.presentationMeta : null)
      || (typeof definition.presentationMeta === 'function' ? definition.presentationMeta : null),
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
  // 归一化两种 parameters DSL 为 { key: fieldSpec } 映射
  let props = null;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (raw.properties && typeof raw.properties === 'object') props = raw.properties;
    else if (raw.type === undefined) props = raw;
  }
  const errors = [];
  if (props) {
    for (const [key, field] of Object.entries(props)) {
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
    throw new ToolArgsError(errors.join('; '));
  }
  return args || {};
}

module.exports = {
  defineTool,
  validateArgs,
  parameterToJsonSchema,
  parameterSchemaSpecToJsonSchema,
  valueSchemaSpecToJsonSchema,
  ToolArgsError,
  JsonSchemaError,
  CodeRunFailedError,
  RUN_CODE_NAME,
};
