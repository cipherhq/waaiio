'use client';

import { useState, useEffect, useCallback, useId, useRef } from 'react';
import { useBusiness, useRequireCapability } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { PageHelp } from '@/components/dashboard/PageHelp';
import EmptyState from '@/components/dashboard/EmptyState';
import type {
  SourceFamily,
  Operator,
  Predicate,
  GroupExpression,
  AudienceExpression,
  FieldType,
} from '@/lib/engage/audience-dsl';
import {
  SOURCE_FAMILIES,
  FIELD_ALLOWLIST,
  OPERATORS,
  validateAudienceExpression,
} from '@/lib/engage/audience-dsl';

/* ── Types ── */

interface Segment {
  id: string;
  name: string;
  description: string | null;
  expression: AudienceExpression;
  is_dynamic: boolean;
  created_at: string;
  updated_at: string;
}

interface PreviewResult {
  total: number;
  whatsappEligible: number;
  emailEligible: number;
  sample: Array<{
    identity: { key: string; phone: string | null; email: string | null; name: string | null };
    whatsappEligible: boolean;
    emailEligible: boolean;
  }>;
}

type ViewMode = 'list' | 'create' | 'edit';

/* ── Human-readable labels ── */

const SOURCE_LABELS: Record<SourceFamily, string> = {
  contact: 'Contact Profile',
  order: 'Order History',
  booking: 'Booking History',
  event: 'Event Participation',
  form: 'Form Submissions',
  payment: 'Payment History',
};

const FIELD_LABELS: Record<string, string> = {
  phone: 'Phone Number',
  email: 'Email Address',
  name: 'Name',
  tags: 'Tags',
  created_at: 'Date Added',
  status: 'Status',
  total_amount: 'Total Amount',
  date: 'Date',
  event_id: 'Event',
  form_id: 'Form',
  submitted_at: 'Submitted At',
  amount: 'Amount',
  payment_method: 'Payment Method',
};

const OPERATOR_LABELS: Record<Operator, string> = {
  eq: 'equals',
  neq: 'does not equal',
  gt: 'greater than',
  gte: 'at least',
  lt: 'less than',
  lte: 'at most',
  contains: 'contains',
  in: 'is one of',
  not_in: 'is not one of',
  is_null: 'is empty',
  is_not_null: 'is not empty',
};

/* ── Operator compatibility per field type ── */

const OPERATOR_TYPE_COMPAT: Record<FieldType, readonly Operator[]> = {
  string: ['eq', 'neq', 'contains', 'in', 'not_in', 'is_null', 'is_not_null'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'is_null', 'is_not_null'],
  date: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_null', 'is_not_null'],
  boolean: ['eq', 'neq', 'is_null', 'is_not_null'],
  uuid: ['eq', 'neq', 'in', 'not_in', 'is_null', 'is_not_null'],
};

/* ── Value-free operators ── */

const VALUE_FREE_OPS: Set<string> = new Set(['is_null', 'is_not_null']);
const ARRAY_OPS: Set<string> = new Set(['in', 'not_in']);

/**
 * PostgREST filter-unsafe characters — must match the DSL validator's rejection set.
 * Commas, parens, quotes, backslashes, and control characters.
 */
const POSTGREST_UNSAFE_RE = /[,()"\\\x00-\x1f]/;

/* ── Helper: create a blank predicate ── */

function blankPredicate(): Predicate {
  return { type: 'predicate', source: 'contact', field: 'phone', operator: 'eq', value: '' };
}

function blankGroup(): GroupExpression {
  return { type: 'all', children: [blankPredicate()] };
}

/* ── Predicate Editor Component ── */

function PredicateEditor({
  predicate,
  onChange,
  onRemove,
  onValidationChange,
}: {
  predicate: Predicate;
  onChange: (p: Predicate) => void;
  onRemove: () => void;
  /** Reports whether this editor has uncommitted or invalid input, keyed by stable identity */
  onValidationChange?: (key: string, hasError: boolean) => void;
}) {
  // Stable identity for validation tracking — survives sibling add/remove
  const stableKey = useId();

  const fields = FIELD_ALLOWLIST[predicate.source];
  const fieldNames = Object.keys(fields);
  const currentFieldDef = fields[predicate.field];
  const validOps = currentFieldDef
    ? OPERATOR_TYPE_COMPAT[currentFieldDef.type]
    : OPERATOR_TYPE_COMPAT.string;

  // Draft string for array input — prevents comma loss during typing.
  // null means "not editing, display from predicate.value"
  const [arrayDraft, setArrayDraft] = useState<string | null>(null);
  // Validation errors for array tokens
  const [arrayErrors, setArrayErrors] = useState<string[]>([]);

  // Clear this editor's validation error on unmount (condition removed)
  useEffect(() => {
    return () => { onValidationChange?.(stableKey, false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stableKey]);

  const handleSourceChange = (source: SourceFamily) => {
    const newFields = FIELD_ALLOWLIST[source];
    const firstField = Object.keys(newFields)[0];
    const firstFieldType = newFields[firstField].type;
    const firstOp = OPERATOR_TYPE_COMPAT[firstFieldType][0];
    setArrayDraft(null);
    setArrayErrors([]);
    onValidationChange?.(stableKey, false);
    onChange({ type: 'predicate', source, field: firstField, operator: firstOp, value: '' });
  };

  const handleFieldChange = (field: string) => {
    const ft = fields[field]?.type || 'string';
    const ops = OPERATOR_TYPE_COMPAT[ft];
    const op = ops.includes(predicate.operator) ? predicate.operator : ops[0];
    setArrayDraft(null);
    setArrayErrors([]);
    onValidationChange?.(stableKey, false);
    onChange({ ...predicate, field, operator: op, value: VALUE_FREE_OPS.has(op) ? undefined : '' });
  };

  const handleOperatorChange = (operator: Operator) => {
    setArrayDraft(null);
    setArrayErrors([]);
    if (VALUE_FREE_OPS.has(operator)) {
      onChange({ ...predicate, operator, value: undefined });
    } else if (ARRAY_OPS.has(operator)) {
      // Switching TO array operator: convert existing scalar to single-element array
      const existing = predicate.value;
      if (Array.isArray(existing)) {
        onChange({ ...predicate, operator });
      } else if (existing !== undefined && existing !== null && existing !== '') {
        onChange({ ...predicate, operator, value: [existing] as string[] });
      } else {
        onChange({ ...predicate, operator, value: [] as string[] });
      }
    } else {
      // Switching FROM array operator to scalar
      const existing = predicate.value;
      const ft = currentFieldDef?.type || 'string';
      if (Array.isArray(existing) && existing.length > 1) {
        if (ft === 'number') {
          // Numeric arrays cannot join to a valid scalar number — block and explain
          setArrayErrors([`Remove values until one remains before switching to "${OPERATOR_LABELS[operator]}"`]);
          onValidationChange?.(stableKey, true);
          return; // Do NOT change operator
        }
        // String arrays: join as comma-separated string for user to edit
        onChange({ ...predicate, operator, value: existing.join(', ') });
      } else if (Array.isArray(existing) && existing.length === 1) {
        // Single-element array: safe to convert to scalar
        onChange({ ...predicate, operator, value: existing[0] ?? '' });
      } else {
        onChange({ ...predicate, operator, value: existing ?? '' });
      }
      setArrayErrors([]);
      onValidationChange?.(stableKey, false);
    }
  };

  /**
   * Commit the draft string into a typed array on blur.
   * Invalid numeric tokens produce validation errors instead of being silently dropped.
   */
  const commitArrayDraft = (raw: string) => {
    const ft = currentFieldDef?.type || 'string';
    const tokens = raw.split(',').map(s => s.trim()).filter(Boolean);
    const errors: string[] = [];

    if (ft === 'number') {
      const result: number[] = [];
      for (const t of tokens) {
        const n = Number(t);
        if (!isFinite(n)) {
          errors.push(`"${t}" is not a valid number`);
        } else {
          result.push(n);
        }
      }
      setArrayErrors(errors);
      if (errors.length === 0) {
        onChange({ ...predicate, value: result as unknown as string[] });
        setArrayDraft(null); // Clear draft only on successful commit
        onValidationChange?.(stableKey, false);
      } else {
        // Keep draft visible so the user can fix it — do NOT setArrayDraft(null)
        onValidationChange?.(stableKey, true);
      }
    } else {
      setArrayErrors([]);
      onChange({ ...predicate, value: tokens });
      setArrayDraft(null);
      onValidationChange?.(stableKey, false);
    }
  };

  const handleScalarValueChange = (value: string) => {
    const ft = currentFieldDef?.type || 'string';
    if (ft === 'number') {
      const num = parseFloat(value);
      onChange({ ...predicate, value: isNaN(num) ? value : num });
    } else if (ft === 'boolean') {
      onChange({ ...predicate, value: value === 'true' });
    } else {
      onChange({ ...predicate, value });
    }
  };

  /** Display value for array fields — used when NOT actively editing */
  const arrayDisplayValue = (): string => {
    const val = predicate.value;
    if (Array.isArray(val)) return val.join(', ');
    if (val !== undefined && val !== null) return String(val);
    return '';
  };

  const needsValue = !VALUE_FREE_OPS.has(predicate.operator);
  const isArrayOp = ARRAY_OPS.has(predicate.operator);
  const fieldType = currentFieldDef?.type || 'string';
  const hasArrayErrors = arrayErrors.length > 0;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
      {/* Source selector */}
      <select
        value={predicate.source}
        onChange={(e) => handleSourceChange(e.target.value as SourceFamily)}
        className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1.5 text-sm"
      >
        {SOURCE_FAMILIES.map((s) => (
          <option key={s} value={s}>{SOURCE_LABELS[s]}</option>
        ))}
      </select>

      {/* Field selector */}
      <select
        value={predicate.field}
        onChange={(e) => handleFieldChange(e.target.value)}
        className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1.5 text-sm"
      >
        {fieldNames.map((f) => (
          <option key={f} value={f}>{FIELD_LABELS[f] || f}</option>
        ))}
      </select>

      {/* Operator selector */}
      <select
        value={predicate.operator}
        onChange={(e) => handleOperatorChange(e.target.value as Operator)}
        className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1.5 text-sm"
      >
        {validOps.map((op) => (
          <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>
        ))}
      </select>

      {/* Value input — array for in/not_in, scalar for others */}
      {needsValue && isArrayOp && (
        <div className="min-w-[180px] flex-1">
          <input
            type="text"
            value={arrayDraft !== null ? arrayDraft : arrayDisplayValue()}
            onChange={(e) => setArrayDraft(e.target.value)}
            onBlur={(e) => commitArrayDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitArrayDraft((e.target as HTMLInputElement).value); } }}
            placeholder={fieldType === 'number' ? 'e.g. 100, 200, 300' : fieldType === 'uuid' ? 'UUID, UUID, ...' : 'value1, value2, value3'}
            className={`w-full rounded-md border px-2 py-1.5 text-sm ${
              hasArrayErrors
                ? 'border-red-400 dark:border-red-600 bg-red-50 dark:bg-red-900/10'
                : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700'
            }`}
            aria-label="List values (comma-separated)"
          />
          {hasArrayErrors && (
            <div className="mt-1 text-xs text-red-600 dark:text-red-400" role="alert">
              {arrayErrors.map((err, i) => <div key={i}>{err}</div>)}
            </div>
          )}
          {!hasArrayErrors && Array.isArray(predicate.value) && predicate.value.length > 0 && arrayDraft === null && (
            <div className="mt-1 flex flex-wrap gap-1">
              {(predicate.value as (string | number)[]).map((v, i) => (
                <span
                  key={i}
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    typeof v === 'string' && POSTGREST_UNSAFE_RE.test(v)
                      ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
                      : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                  }`}
                >
                  {String(v)}
                  {typeof v === 'string' && POSTGREST_UNSAFE_RE.test(v) && (
                    <span className="ml-1" title="Contains unsafe characters">!</span>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {needsValue && !isArrayOp && fieldType === 'boolean' && (
        <select
          value={predicate.value === true ? 'true' : predicate.value === false ? 'false' : ''}
          onChange={(e) => handleScalarValueChange(e.target.value)}
          className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1.5 text-sm"
        >
          <option value="">Select...</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      )}
      {needsValue && !isArrayOp && fieldType !== 'boolean' && (
        <input
          type={fieldType === 'number' ? 'number' : fieldType === 'date' ? 'date' : 'text'}
          value={typeof predicate.value === 'string' || typeof predicate.value === 'number' ? predicate.value : ''}
          onChange={(e) => handleScalarValueChange(e.target.value)}
          placeholder="Value"
          className="min-w-[120px] flex-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1.5 text-sm"
        />
      )}

      {/* Remove button */}
      <button
        type="button"
        onClick={onRemove}
        className="ml-auto rounded p-1 text-gray-400 hover:text-red-500"
        aria-label="Remove condition"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

/* ── Group Editor Component ── */

function GroupEditor({
  group,
  onChange,
  onRemove,
  depth,
  onValidationChange,
}: {
  group: GroupExpression;
  onChange: (g: GroupExpression) => void;
  onRemove?: () => void;
  depth: number;
  onValidationChange?: (key: string, hasError: boolean) => void;
}) {
  // Stable React keys for children — survives sibling add/remove
  const keyCounterRef = useRef(0);
  const childKeysRef = useRef<string[]>([]);
  // Ensure we have a stable key for each child
  while (childKeysRef.current.length < group.children.length) {
    childKeysRef.current.push(`ck-${keyCounterRef.current++}`);
  }

  const updateChild = (index: number, child: AudienceExpression) => {
    const newChildren = [...group.children];
    newChildren[index] = child;
    onChange({ ...group, children: newChildren });
  };

  const removeChild = (index: number) => {
    if (group.children.length <= 1) return;
    // Remove the stable key for this index so React unmounts the correct component
    childKeysRef.current.splice(index, 1);
    // The removed PredicateEditor's useEffect cleanup will clear its own error
    const newChildren = group.children.filter((_, i) => i !== index);
    onChange({ ...group, children: newChildren });
  };

  const addPredicate = () => {
    onChange({ ...group, children: [...group.children, blankPredicate()] });
  };

  const addSubGroup = () => {
    if (depth >= 2) return; // Max depth 3 means max 2 nested group levels
    onChange({ ...group, children: [...group.children, blankGroup()] });
  };

  const groupTypeLabel = group.type === 'all' ? 'ALL' : group.type === 'any' ? 'ANY' : 'NONE';
  const bgColor = depth === 0
    ? 'bg-gray-50 dark:bg-gray-900'
    : depth === 1
      ? 'bg-blue-50/50 dark:bg-blue-900/10'
      : 'bg-purple-50/50 dark:bg-purple-900/10';

  return (
    <div className={`rounded-lg border border-gray-200 dark:border-gray-700 ${bgColor} p-4`}>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Match</span>
        <select
          value={group.type}
          onChange={(e) => onChange({ ...group, type: e.target.value as 'all' | 'any' | 'none' })}
          className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1 text-sm font-semibold"
        >
          <option value="all">ALL conditions</option>
          <option value="any">ANY condition</option>
          {depth === 1 && <option value="none">NONE of (exclude)</option>}
        </select>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="ml-auto rounded p-1 text-gray-400 hover:text-red-500"
            aria-label="Remove group"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      <div className="space-y-2">
        {group.children.map((child, i) => (
          <div key={childKeysRef.current[i]}>
            {i > 0 && (
              <div className="my-1 flex items-center gap-2 px-3">
                <div className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
                <span className="text-xs font-medium text-brand-600 dark:text-brand-400">{groupTypeLabel}</span>
                <div className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
              </div>
            )}
            {child.type === 'predicate' ? (
              <PredicateEditor
                predicate={child}
                onChange={(p) => updateChild(i, p)}
                onRemove={() => removeChild(i)}
                onValidationChange={onValidationChange}
              />
            ) : (
              <GroupEditor
                group={child}
                onChange={(g) => updateChild(i, g)}
                onRemove={() => removeChild(i)}
                depth={depth + 1}
                onValidationChange={onValidationChange}
              />
            )}
          </div>
        ))}
      </div>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={addPredicate}
          className="rounded-md border border-dashed border-gray-300 dark:border-gray-600 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 hover:border-brand-500 hover:text-brand-600"
        >
          + Add Condition
        </button>
        {depth < 2 && (
          <button
            type="button"
            onClick={addSubGroup}
            className="rounded-md border border-dashed border-gray-300 dark:border-gray-600 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 hover:border-brand-500 hover:text-brand-600"
          >
            + Add Group
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Preview Panel ── */

function PreviewPanel({
  preview,
  loading,
  error,
}: {
  preview: PreviewResult | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Calculating audience...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4">
        <p className="text-sm font-medium text-red-800 dark:text-red-300">Preview Error</p>
        <p className="mt-1 text-sm text-red-600 dark:text-red-400">{error}</p>
      </div>
    );
  }

  if (!preview) return null;

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
      <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Audience Preview</h4>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Preview only — no messages will be sent</p>

      <div className="mt-4 grid grid-cols-3 gap-4">
        <div className="text-center">
          <p className="text-2xl font-bold text-gray-900 dark:text-white">{preview.total.toLocaleString()}</p>
          <p className="text-xs text-gray-500">Total Contacts</p>
        </div>
        <div className="text-center">
          <p className="text-2xl font-bold text-green-600 dark:text-green-400">{preview.whatsappEligible.toLocaleString()}</p>
          <p className="text-xs text-gray-500">WhatsApp Eligible</p>
        </div>
        <div className="text-center">
          <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{preview.emailEligible.toLocaleString()}</p>
          <p className="text-xs text-gray-500">Email Eligible</p>
        </div>
      </div>

      {preview.sample.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">
            Sample ({preview.sample.length} of {preview.total})
          </p>
          <div className="space-y-1">
            {preview.sample.map((s, i) => (
              <div key={i} className="flex items-center gap-2 rounded bg-gray-50 dark:bg-gray-700/50 px-2 py-1 text-xs">
                <span className="font-medium text-gray-700 dark:text-gray-300 truncate">
                  {s.identity.name || s.identity.phone || s.identity.email || 'Unknown'}
                </span>
                {s.whatsappEligible && (
                  <span className="ml-auto shrink-0 rounded-full bg-green-100 dark:bg-green-900/30 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:text-green-400">
                    WhatsApp
                  </span>
                )}
                {s.emailEligible && (
                  <span className="shrink-0 rounded-full bg-blue-100 dark:bg-blue-900/30 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-400">
                    Email
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Main Page Component ── */

export default function AudiencesPage() {
  const business = useBusiness();
  const capReady = useRequireCapability('broadcast');

  const [view, setView] = useState<ViewMode>('list');
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Builder state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [segmentName, setSegmentName] = useState('');
  const [segmentDescription, setSegmentDescription] = useState('');
  const [expression, setExpression] = useState<GroupExpression>(blankGroup());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  // Tracks which predicate editors have invalid/uncommitted input (keyed by path)
  const [editorErrorKeys, setEditorErrorKeys] = useState<Set<string>>(new Set());
  const hasEditorErrors = editorErrorKeys.size > 0;

  const handleEditorValidation = useCallback((key: string, hasError: boolean) => {
    setEditorErrorKeys(prev => {
      const next = new Set(prev);
      if (hasError) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  }, []);

  // Preview state
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Delete confirmation
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  /* ── Load segments ── */

  const loadSegments = useCallback(async () => {
    if (!business?.id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/engage/segments?businessId=${business.id}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed to load audiences (${res.status})`);
      }
      const data = await res.json();
      setSegments(data.segments || []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [business?.id]);

  useEffect(() => {
    if (capReady) loadSegments();
  }, [capReady, loadSegments]);

  /* ── Preview ── */

  const runPreview = useCallback(async () => {
    if (!business?.id) return;

    if (hasEditorErrors) {
      setValidationErrors(['Fix invalid values in conditions before previewing']);
      setPreview(null);
      return;
    }

    const validation = validateAudienceExpression(expression);
    if (!validation.valid) {
      setValidationErrors(validation.errors.map((e) => `${e.path}: ${e.message}`));
      setPreview(null);
      return;
    }
    setValidationErrors([]);
    setPreviewLoading(true);
    setPreviewError(null);

    try {
      const res = await fetch('/api/engage/audience/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessId: business.id, expression }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error === 'audience_too_large'
          ? 'Audience exceeds 10,000 contacts. Try narrowing your conditions.'
          : data.message || data.error || `Preview failed (${res.status})`);
      }
      setPreview(data);
    } catch (err) {
      setPreviewError((err as Error).message);
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }, [business?.id, expression, hasEditorErrors]);

  /* ── Save segment ── */

  const handleSave = async () => {
    if (!business?.id || !segmentName.trim()) return;

    if (hasEditorErrors) {
      setValidationErrors(['Fix invalid values in conditions before saving']);
      return;
    }

    const validation = validateAudienceExpression(expression);
    if (!validation.valid) {
      setValidationErrors(validation.errors.map((e) => `${e.path}: ${e.message}`));
      return;
    }
    setValidationErrors([]);
    setSaving(true);
    setSaveError(null);

    try {
      const url = editingId ? `/api/engage/segments/${editingId}` : '/api/engage/segments';
      const method = editingId ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId: business.id,
          name: segmentName.trim(),
          description: segmentDescription.trim() || null,
          expression,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Save failed (${res.status})`);
      }

      await loadSegments();
      resetBuilder();
      setView('list');
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /* ── Delete segment ── */

  const handleDelete = async (id: string) => {
    if (!business?.id) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/engage/segments/${id}?businessId=${business.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Delete failed (${res.status})`);
      }
      await loadSegments();
      setDeletingId(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  /* ── Edit segment ── */

  const startEdit = (segment: Segment) => {
    setEditingId(segment.id);
    setSegmentName(segment.name);
    setSegmentDescription(segment.description || '');

    // Safely load expression — never silently discard
    if (segment.expression && typeof segment.expression === 'object') {
      const expr = segment.expression as AudienceExpression;
      if (expr.type === 'all' || expr.type === 'any' || expr.type === 'none') {
        setExpression(expr as GroupExpression);
      } else if (expr.type === 'predicate') {
        // Wrap single predicate in a group
        setExpression({ type: 'all', children: [expr] });
      } else {
        // Unknown expression shape — wrap and warn, don't discard
        setExpression({ type: 'all', children: [expr] });
      }
    } else {
      setExpression(blankGroup());
    }

    setPreview(null);
    setPreviewError(null);
    setValidationErrors([]);
    setSaveError(null);
    setView('edit');
  };

  /* ── Reset builder ── */

  const resetBuilder = () => {
    setEditingId(null);
    setSegmentName('');
    setSegmentDescription('');
    setExpression(blankGroup());
    setPreview(null);
    setPreviewError(null);
    setValidationErrors([]);
    setSaveError(null);
    setEditorErrorKeys(new Set());
  };

  /* ── Loading / capability gate ── */

  if (!capReady) {
    return (
      <div className="p-6">
        <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 p-4">
          <p className="text-sm text-amber-800 dark:text-amber-300">
            Audiences require the Broadcast capability. Upgrade your plan to access this feature.
          </p>
        </div>
      </div>
    );
  }

  /* ── List View ── */

  if (view === 'list') {
    return (
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        <PageHelp
          pageKey="audiences"
          title="Audiences"
          description="Create and manage audience segments to target the right contacts. Build audiences from customer data, purchase history, event participation, and more."
        />

        <div className="mt-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Audiences</h1>
          <button
            onClick={() => { resetBuilder(); setView('create'); }}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 transition-colors"
          >
            + New Audience
          </button>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3">
            <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
          </div>
        )}

        {loading ? (
          <div className="mt-8 flex justify-center">
            <svg className="h-8 w-8 animate-spin text-brand-600" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        ) : segments.length === 0 ? (
          <EmptyState
            icon="👥"
            title="No audiences yet"
            description="Create your first audience to start targeting the right contacts for your communications."
            actionLabel="Create Audience"
            onAction={() => { resetBuilder(); setView('create'); }}
          />
        ) : (
          <div className="mt-6 space-y-3">
            {segments.map((seg) => (
              <div
                key={seg.id}
                className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 hover:border-brand-300 dark:hover:border-brand-700 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                      {seg.name}
                    </h3>
                    {seg.description && (
                      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 line-clamp-2">
                        {seg.description}
                      </p>
                    )}
                    <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                      {seg.is_dynamic ? 'Dynamic' : 'Static'} &middot; Created {new Date(seg.created_at).toLocaleDateString()}
                    </p>
                  </div>

                  <div className="ml-4 flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => startEdit(seg)}
                      className="rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                    >
                      Edit
                    </button>
                    {deletingId === seg.id ? (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleDelete(seg.id)}
                          disabled={deleting}
                          className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                        >
                          {deleting ? 'Deleting...' : 'Confirm'}
                        </button>
                        <button
                          onClick={() => setDeletingId(null)}
                          className="rounded-md border border-gray-300 dark:border-gray-600 px-2 py-1.5 text-xs text-gray-600 dark:text-gray-400"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setDeletingId(seg.id)}
                        className="rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  /* ── Builder View (Create / Edit) ── */

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <div className="flex items-center gap-3">
        <button
          onClick={() => { resetBuilder(); setView('list'); }}
          className="rounded-md p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          aria-label="Back to list"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </button>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          {editingId ? 'Edit Audience' : 'New Audience'}
        </h1>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_340px]">
        {/* Left column: builder */}
        <div className="space-y-4">
          {/* Name & description */}
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Audience Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={segmentName}
              onChange={(e) => setSegmentName(e.target.value)}
              placeholder="e.g., Active Customers This Month"
              className="mt-1 w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm"
              maxLength={200}
            />
            <label className="mt-3 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Description
            </label>
            <textarea
              value={segmentDescription}
              onChange={(e) => setSegmentDescription(e.target.value)}
              placeholder="Optional description for this audience"
              rows={2}
              className="mt-1 w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm resize-none"
              maxLength={500}
            />
          </div>

          {/* Expression builder */}
          <div>
            <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">Conditions</h3>
            <GroupEditor
              group={expression}
              onChange={setExpression}
              depth={0}
              onValidationChange={handleEditorValidation}
            />
          </div>

          {/* Validation errors */}
          {validationErrors.length > 0 && (
            <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-3">
              <p className="text-sm font-medium text-amber-800 dark:text-amber-300">Validation Issues</p>
              <ul className="mt-1 list-disc pl-4 text-xs text-amber-700 dark:text-amber-400">
                {validationErrors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </div>
          )}

          {/* Save error */}
          {saveError && (
            <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3">
              <p className="text-sm text-red-700 dark:text-red-300">{saveError}</p>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={saving || !segmentName.trim()}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving...' : editingId ? 'Update Audience' : 'Save Audience'}
            </button>
            <button
              onClick={runPreview}
              disabled={previewLoading}
              className="rounded-lg border border-brand-300 dark:border-brand-700 px-4 py-2 text-sm font-medium text-brand-700 dark:text-brand-300 hover:bg-brand-50 dark:hover:bg-brand-900/20 disabled:opacity-50 transition-colors"
            >
              {previewLoading ? 'Calculating...' : 'Preview Audience'}
            </button>
            <button
              onClick={() => { resetBuilder(); setView('list'); }}
              className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>

        {/* Right column: preview */}
        <div className="lg:sticky lg:top-6">
          <PreviewPanel
            preview={preview}
            loading={previewLoading}
            error={previewError}
          />
          {!preview && !previewLoading && !previewError && (
            <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-600 p-4 text-center">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Click &ldquo;Preview Audience&rdquo; to see matching contacts
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
