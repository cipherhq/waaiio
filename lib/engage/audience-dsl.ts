/**
 * Bounded Audience DSL — E1 (#557)
 *
 * Typed expression tree with allowlisted fields/operators only.
 * No client-supplied SQL. Unknown fields or operators fail validation.
 *
 * Constraints:
 * - Max expression depth: 3
 * - Max total predicates: 20
 * - `none` group only allowed as direct child of `all`
 * - Per-field value type validation
 * - Bounded string lengths and array cardinality
 * - LIKE wildcard escaping for `contains`
 */

// ── Source families and allowlisted fields ──

export const SOURCE_FAMILIES = [
  'contact',
  'order',
  'booking',
  'event',
  'form',
  'payment',
] as const;

export type SourceFamily = (typeof SOURCE_FAMILIES)[number];

export type FieldType = 'string' | 'number' | 'date' | 'boolean' | 'uuid';

export interface FieldDef {
  type: FieldType;
}

/**
 * Allowlisted fields per source family.
 * Only these fields may appear in predicates.
 * Field names MUST match actual database column names.
 *
 * Verified against migrations:
 * - customer_profiles (M021): phone, email, name, tags, created_at
 * - orders (M002): status, total_amount, created_at
 * - bookings: status, date, created_at, guest_phone, guest_name
 * - event_tickets (M072): event_id, status, created_at
 * - form_responses (M119): form_id, submitted_at
 * - payments (M001): status, amount, payment_method, created_at
 */
export const FIELD_ALLOWLIST: Record<SourceFamily, Record<string, FieldDef>> = {
  contact: {
    phone: { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string' },
    tags: { type: 'string' },
    created_at: { type: 'date' },
  },
  order: {
    status: { type: 'string' },
    total_amount: { type: 'number' },
    created_at: { type: 'date' },
  },
  booking: {
    status: { type: 'string' },
    date: { type: 'date' },
    created_at: { type: 'date' },
  },
  event: {
    event_id: { type: 'uuid' },
    status: { type: 'string' },
    created_at: { type: 'date' },
  },
  form: {
    form_id: { type: 'uuid' },
    submitted_at: { type: 'date' },
  },
  payment: {
    status: { type: 'string' },
    amount: { type: 'number' },
    payment_method: { type: 'string' },
    created_at: { type: 'date' },
  },
};

// ── Operators ──

export const OPERATORS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'in',
  'not_in',
  'is_null',
  'is_not_null',
] as const;

export type Operator = (typeof OPERATORS)[number];

/** Operators valid for each field type */
const OPERATOR_TYPE_COMPAT: Record<FieldType, readonly Operator[]> = {
  string:  ['eq', 'neq', 'contains', 'in', 'not_in', 'is_null', 'is_not_null'],
  number:  ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'is_null', 'is_not_null'],
  date:    ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_null', 'is_not_null'],
  boolean: ['eq', 'neq', 'is_null', 'is_not_null'],
  uuid:    ['eq', 'neq', 'in', 'not_in', 'is_null', 'is_not_null'],
};

// ── Safety bounds ──

export const MAX_STRING_VALUE_LENGTH = 500;
export const MAX_ARRAY_CARDINALITY = 50;

// ── Expression types ──

export interface Predicate {
  type: 'predicate';
  source: SourceFamily;
  field: string;
  operator: Operator;
  value?: string | number | boolean | string[] | null;
}

export interface GroupExpression {
  type: 'all' | 'any' | 'none';
  children: AudienceExpression[];
}

export type AudienceExpression = Predicate | GroupExpression;

// ── Validation ──

export const MAX_DEPTH = 3;
export const MAX_PREDICATES = 20;

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/** Escape LIKE wildcards in user-supplied values for the `contains` operator */
export function escapeLikeWildcards(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

export function validateAudienceExpression(
  expr: unknown,
): ValidationResult {
  const errors: ValidationError[] = [];
  let predicateCount = 0;

  function validate(
    node: unknown,
    path: string,
    depth: number,
    parentType: string | null,
  ): void {
    if (!node || typeof node !== 'object') {
      errors.push({ path, message: 'Expression node must be an object' });
      return;
    }

    const n = node as Record<string, unknown>;

    if (depth > MAX_DEPTH) {
      errors.push({ path, message: `Expression exceeds maximum depth of ${MAX_DEPTH}` });
      return;
    }

    if (n.type === 'predicate') {
      predicateCount++;
      if (predicateCount > MAX_PREDICATES) {
        errors.push({ path, message: `Expression exceeds maximum of ${MAX_PREDICATES} predicates` });
        return;
      }
      validatePredicate(n, path);
      return;
    }

    if (n.type === 'all' || n.type === 'any' || n.type === 'none') {
      if (n.type === 'none') {
        if (parentType !== 'all') {
          errors.push({
            path,
            message: '`none` group is only allowed as a direct child of an `all` group',
          });
          return;
        }
      }

      if (!Array.isArray(n.children) || n.children.length === 0) {
        errors.push({ path, message: 'Group must have a non-empty children array' });
        return;
      }

      for (let i = 0; i < n.children.length; i++) {
        validate(n.children[i], `${path}.children[${i}]`, depth + 1, n.type as string);
      }
      return;
    }

    errors.push({ path, message: `Unknown expression type: ${String(n.type)}` });
  }

  function validatePredicate(
    n: Record<string, unknown>,
    path: string,
  ): void {
    const source = n.source as string;
    if (!SOURCE_FAMILIES.includes(source as SourceFamily)) {
      errors.push({ path, message: `Unknown source family: ${source}` });
      return;
    }

    const field = n.field as string;
    const allowedFields = FIELD_ALLOWLIST[source as SourceFamily];
    const fieldDef = allowedFields[field];
    if (!fieldDef) {
      errors.push({ path, message: `Field '${field}' is not allowed for source '${source}'` });
      return;
    }

    const operator = n.operator as string;
    if (!OPERATORS.includes(operator as Operator)) {
      errors.push({ path, message: `Unknown operator: ${operator}` });
      return;
    }

    // Check operator/field type compatibility
    const allowedOps = OPERATOR_TYPE_COMPAT[fieldDef.type];
    if (!allowedOps.includes(operator as Operator)) {
      errors.push({
        path,
        message: `Operator '${operator}' is not compatible with field type '${fieldDef.type}' (field '${field}')`,
      });
      return;
    }

    // is_null and is_not_null don't need a value
    if (operator === 'is_null' || operator === 'is_not_null') {
      return;
    }

    // in and not_in require an array value
    if (operator === 'in' || operator === 'not_in') {
      if (!Array.isArray(n.value)) {
        errors.push({ path, message: `Operator '${operator}' requires an array value` });
        return;
      }
      const arr = n.value as unknown[];
      if (arr.length === 0) {
        errors.push({ path, message: `Operator '${operator}' requires a non-empty array` });
        return;
      }
      if (arr.length > MAX_ARRAY_CARDINALITY) {
        errors.push({ path, message: `Array exceeds maximum cardinality of ${MAX_ARRAY_CARDINALITY}` });
        return;
      }
      // Validate each array element matches the field type
      for (let i = 0; i < arr.length; i++) {
        const elemError = validateValueType(arr[i], fieldDef.type, `${path}.value[${i}]`);
        if (elemError) {
          errors.push(elemError);
          return;
        }
      }
      return;
    }

    // Other operators require a non-null value
    if (n.value === undefined || n.value === null) {
      errors.push({ path, message: `Operator '${operator}' requires a value` });
      return;
    }

    // Validate value matches field type
    const typeError = validateValueType(n.value, fieldDef.type, `${path}.value`);
    if (typeError) {
      errors.push(typeError);
    }
  }

  function validateValueType(
    value: unknown,
    fieldType: FieldType,
    path: string,
  ): ValidationError | null {
    switch (fieldType) {
      case 'string': {
        if (typeof value !== 'string') {
          return { path, message: `Expected string value, got ${typeof value}` };
        }
        if (value.length > MAX_STRING_VALUE_LENGTH) {
          return { path, message: `String value exceeds maximum length of ${MAX_STRING_VALUE_LENGTH}` };
        }
        return null;
      }
      case 'number': {
        if (typeof value !== 'number' || !isFinite(value)) {
          return { path, message: `Expected finite number value, got ${typeof value}` };
        }
        return null;
      }
      case 'date': {
        if (typeof value !== 'string') {
          return { path, message: `Expected ISO date string, got ${typeof value}` };
        }
        if (!ISO_DATE_RE.test(value)) {
          return { path, message: `Invalid date format: expected ISO 8601` };
        }
        return null;
      }
      case 'boolean': {
        if (typeof value !== 'boolean') {
          return { path, message: `Expected boolean value, got ${typeof value}` };
        }
        return null;
      }
      case 'uuid': {
        if (typeof value !== 'string') {
          return { path, message: `Expected UUID string, got ${typeof value}` };
        }
        if (!UUID_RE.test(value)) {
          return { path, message: `Invalid UUID format` };
        }
        return null;
      }
      default:
        return { path, message: `Unknown field type: ${fieldType}` };
    }
  }

  // Root-level none is invalid
  if (
    expr &&
    typeof expr === 'object' &&
    (expr as Record<string, unknown>).type === 'none'
  ) {
    errors.push({ path: 'root', message: '`none` group is not allowed at expression root' });
  } else {
    validate(expr, 'root', 1, null);
  }

  return { valid: errors.length === 0, errors };
}
