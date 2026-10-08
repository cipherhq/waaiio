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

export interface FieldDef {
  type: 'string' | 'number' | 'date' | 'boolean' | 'uuid';
}

/**
 * Allowlisted fields per source family.
 * Only these fields may appear in predicates.
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
    product_name: { type: 'string' },
  },
  booking: {
    status: { type: 'string' },
    service_name: { type: 'string' },
    booking_date: { type: 'date' },
    created_at: { type: 'date' },
  },
  event: {
    event_id: { type: 'uuid' },
    event_name: { type: 'string' },
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
      // none is only valid as direct child of all
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
    if (!allowedFields[field]) {
      errors.push({ path, message: `Field '${field}' is not allowed for source '${source}'` });
      return;
    }

    const operator = n.operator as string;
    if (!OPERATORS.includes(operator as Operator)) {
      errors.push({ path, message: `Unknown operator: ${operator}` });
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
      }
      return;
    }

    // Other operators require a non-null value
    if (n.value === undefined || n.value === null) {
      errors.push({ path, message: `Operator '${operator}' requires a value` });
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
