/* SPDX-License-Identifier: GPL-3.0-or-later
 * Latest upstream schema/presentation APIs with a legacy CIBYP overload.
 * Vendored MIT-licensed modules and provenance: upstream/SOURCE.md.
 */
'use strict';
const upstream = require('./upstream/schema.mjs');
const jsonSchema = require('./upstream/json-schema.mjs');
const tsTypes = require('./upstream/ts-types.mjs');
const pyTypes = require('./upstream/py-types.mjs');
const { HarnessError } = require('@deepseek-ai/dsh-llm');
const RUN_CODE_NAME = 'run_code';

function legacyNode(node) {
  if (!node || typeof node !== 'object') return { type: 'string' };
  const result = { ...node };
  if (typeof result.required === 'boolean') delete result.required;
  if (node.properties) {
    result.properties = Object.fromEntries(
      Object.entries(node.properties).map(([key, value]) => [key, legacyNode(value)]),
    );
    result.required = [
      ...new Set([
        ...(Array.isArray(node.required) ? node.required : []),
        ...Object.entries(node.properties)
          .filter(([, value]) => value.required === true)
          .map(([key]) => key),
      ]),
    ];
  }
  if (node.items) result.items = legacyNode(node.items);
  if (node.oneOf) result.oneOf = node.oneOf.map(legacyNode);
  return result;
}

function parameterToJsonSchema(spec = {}) {
  return spec.type || spec.oneOf
    ? legacyNode(spec)
    : upstream.parameterSchemaSpecToJsonSchema(
        Object.fromEntries(
          Object.entries(spec).map(([key, field]) => [key, compatibleSchema(field)]),
        ),
      );
}

// Older DSLs implicitly closed objects. Newer Harness releases require the
// property explicitly; preserve the old behavior without changing user data.
function compatibleSchema(spec) {
  if (!spec || typeof spec !== 'object') return spec;
  const node = { ...spec };
  if (node.type === 'object' && node.additionalProperties === undefined)
    node.additionalProperties = false;
  if (node.properties)
    node.properties = Object.fromEntries(
      Object.entries(node.properties).map(([key, field]) => [key, compatibleSchema(field)]),
    );
  if (node.items) node.items = compatibleSchema(node.items);
  if (node.oneOf) node.oneOf = node.oneOf.map(compatibleSchema);
  return node;
}

function valueToJsonSchema(spec) {
  return upstream.valueSchemaSpecToJsonSchema(compatibleSchema(spec));
}

function defineTool(definition) {
  if (definition?.name === RUN_CODE_NAME) throw new Error('run_code is reserved');
  if (typeof definition?.name !== 'string' || typeof definition.execute !== 'function')
    throw new TypeError('defineTool requires name and execute');
  if (definition.output && typeof definition.output.render === 'function') {
    const parameters =
      definition.parameters?.type === 'object'
        ? Object.fromEntries(
            Object.entries(definition.parameters.properties || {}).map(([key, field]) => [
              key,
              {
                ...field,
                required: field.required === true || definition.parameters.required?.includes(key),
              },
            ]),
          )
        : definition.parameters || {};
    const normalized = Object.fromEntries(
      Object.entries(parameters).map(([key, field]) => [key, compatibleSchema(field)]),
    );
    const tool = upstream.defineTool({
      ...definition,
      parameters: normalized,
      output: { ...definition.output, schema: compatibleSchema(definition.output.schema) },
    });
    tool._rawParameters = definition.parameters || {};
    tool.presentationMeta = tool.output.presentationMeta || definition.presentationMeta || null;
    return tool;
  }
  // Pre-0.1 definitions did not require the canonical output contract.
  return {
    ...definition,
    description: definition.description || definition.name,
    parameters: parameterToJsonSchema(definition.parameters),
    _rawParameters: definition.parameters || {},
  };
}

function validateArgs(spec, args) {
  if (typeof spec?.execute !== 'function')
    return upstream.validateArgs(
      Object.fromEntries(
        Object.entries(spec || {}).map(([key, field]) => [key, compatibleSchema(field)]),
      ),
      args,
    );
  const violations = jsonSchema.validateJsonSchemaValue(spec.parameters, args, '');
  if (violations.length) throw new upstream.ToolArgsError(violations);
  return args;
}

class CodeRunFailedError extends HarnessError {
  constructor(message, info) {
    super(message || 'code run failed', 'CODE_RUN_FAILED');
    this.name = 'CodeRunFailedError';
    if (info) this.info = info;
  }
}

module.exports = {
  ...require('../../native-tools'),
  defineTool,
  validateArgs,
  parameterToJsonSchema,
  parameterSchemaSpecToJsonSchema: parameterToJsonSchema,
  valueSchemaSpecToJsonSchema: valueToJsonSchema,
  ToolArgsError: upstream.ToolArgsError,
  JsonSchemaError: jsonSchema.JsonSchemaError,
  assertSupportedJsonSchema: jsonSchema.assertSupportedJsonSchema,
  assertObjectJsonSchema: jsonSchema.assertObjectJsonSchema,
  validateJsonSchemaValue: jsonSchema.validateJsonSchemaValue,
  jsonSchemaToTs: tsTypes.jsonSchemaToTs,
  renderToolsSdk: tsTypes.renderToolsSdk,
  jsonSchemaToPy: pyTypes.jsonSchemaToPy,
  renderToolsSdkPy: pyTypes.renderToolsSdkPy,
  defineContentToolFixture: require('./upstream/testing.mjs').defineContentToolFixture,
  CodeRunFailedError,
  RUN_CODE_NAME,
};
