import { assert } from './util.mjs';
// Deliberately small JSON Schema subset. Every public tool uses only this subset.
// Unknown fields are rejected before dispatch, rather than handed to a shell.
export function validate(schema, value, location = 'arguments') {
  if (schema.enum) assert(schema.enum.includes(value), `${location}: expected ${schema.enum.join(', ')}`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    assert(types.some(type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'integer' ? Number.isInteger(value) : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : typeof value === type), `${location}: expected ${types.join(' or ')}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined) assert(value.length >= schema.minLength, `${location}: too short`);
    if (schema.maxLength !== undefined) assert(value.length <= schema.maxLength, `${location}: too long`);
    if (schema.pattern) assert(new RegExp(schema.pattern).test(value), `${location}: invalid format`);
  }
  if (typeof value === 'number') {
    assert(Number.isFinite(value), `${location}: finite number required`);
    if (schema.minimum !== undefined) assert(value >= schema.minimum, `${location}: below minimum`);
    if (schema.maximum !== undefined) assert(value <= schema.maximum, `${location}: above maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined) assert(value.length <= schema.maxItems, `${location}: too many items`);
    if (schema.minItems !== undefined) assert(value.length >= schema.minItems, `${location}: too few items`);
    if (schema.items) value.forEach((v, i) => validate(schema.items, v, `${location}[${i}]`));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) assert(Object.hasOwn(value, key), `${location}.${key} is required`);
    for (const [key, val] of Object.entries(value)) {
      assert(!['__proto__', 'constructor', 'prototype'].includes(key), `${location}: reserved property`);
      if (schema.properties?.[key]) validate(schema.properties[key], val, `${location}.${key}`);
      else assert(schema.additionalProperties !== false, `${location}.${key}: unknown argument`);
    }
  }
  return value;
}
export const str = (description, maxLength = 4096) => ({ type: 'string', minLength: 1, maxLength, description });
export const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const integer = (minimum, maximum, description) => ({ type: 'integer', minimum, maximum, description });
