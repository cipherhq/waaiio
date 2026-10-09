/**
 * #591 — Compile existing Waaiio Forms fields into a single-screen WhatsApp Flow.
 *
 * Supports preview, publishing, sending, and inbound nfm_reply capture.
 * Unsupported field types fail closed instead of silently losing customer data.
 *
 * Meta WhatsApp Flows spec: https://developers.facebook.com/docs/whatsapp/flows/
 * Version: 7.3
 */

// ── Types ──

export interface WaaiioFormField {
  id: string;
  label: string;
  type: string;
  required?: boolean;
  options?: unknown;
}

export interface WaaiioFormDefinition {
  title: string;
  description?: string | null;
  fields: unknown;
  /** If present in form settings, appends a marketing consent OptIn. */
  settings?: { consent_label?: string } | null;
}

/** Result of validating Flow response data against the form schema. */
export interface FlowResponseValidation {
  valid: boolean;
  /** Cleaned answers keyed by field ID — only present when valid. */
  answers?: Record<string, unknown>;
  /** Human-readable error — only present when invalid. */
  error?: string;
}

export class NativeFlowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeFlowValidationError';
  }
}

// ── Constants ──

const FIELD_ID = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

const INPUT_TYPES: Record<string, string> = {
  text: 'text', number: 'number', email: 'email', phone: 'phone',
};

/** Waaiio field types that map to native WhatsApp Flow components. */
const ALLOWED_TYPES = new Set([
  'text', 'number', 'email', 'phone', 'textarea', 'date', 'select', 'radio',
]);

/** Field types that exist in Waaiio but have no native Flow equivalent.
 *  Listed explicitly so error messages can distinguish "unsupported" from "unknown". */
const WAAIIO_ONLY_TYPES = new Set([
  'file', 'multi_select', 'checkbox',
]);

const SINGLE_SCREEN_MAX_FIELDS = 8;
/** Reserved field ID for the marketing consent OptIn component. */
const CONSENT_FIELD_ID = '_marketing_consent';

const hasBadControls = (value: string): boolean => /[\u0000-\u001f\u007f]/u.test(value);

// ── Compiler ──

/**
 * Compile a Waaiio form definition into a single-screen WhatsApp Flow 7.3 JSON.
 *
 * This is a pure, deterministic function with no side effects.
 * It does NOT publish, send, or accept submissions.
 *
 * @throws NativeFlowValidationError if the form cannot be represented
 */
export function compileNativeFormFlow(form: WaaiioFormDefinition): Record<string, unknown> {
  if (!form || typeof form.title !== 'string' || !form.title.trim() ||
      form.title.trim().length > 30 || hasBadControls(form.title)) {
    throw new NativeFlowValidationError('Title must contain 1–30 printable characters for a WhatsApp Flow.');
  }
  if (!Array.isArray(form.fields) || form.fields.length === 0 ||
      form.fields.length > SINGLE_SCREEN_MAX_FIELDS) {
    throw new NativeFlowValidationError('Native WhatsApp Forms support 1–8 fields per screen.');
  }
  if (form.description !== undefined && form.description !== null &&
      (typeof form.description !== 'string' || form.description.length > 256 || hasBadControls(form.description))) {
    throw new NativeFlowValidationError('Description must contain at most 256 printable characters.');
  }

  const used = new Set<string>();
  const payload: Record<string, string> = {};
  const children: Record<string, unknown>[] = [];

  if (form.description?.trim()) {
    children.push({ type: 'TextBody', text: form.description.trim() });
  }

  for (const raw of form.fields as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new NativeFlowValidationError('Every form field must be an object.');
    }
    const field = raw as WaaiioFormField;
    if (typeof field.id !== 'string' || !FIELD_ID.test(field.id) ||
        used.has(field.id) || field.id === '__proto__' || field.id === 'constructor') {
      throw new NativeFlowValidationError('Form field IDs must be unique, safe identifiers.');
    }
    used.add(field.id);

    if (!ALLOWED_TYPES.has(field.type)) {
      const hint = WAAIIO_ONLY_TYPES.has(field.type)
        ? ` (${field.type} is available on web forms but not in native WhatsApp Flows)`
        : '';
      throw new NativeFlowValidationError(
        'Field "' + field.id + '" uses an unsupported native Flow type: ' + String(field.type) + hint,
      );
    }

    // Meta label limits: TextInput 20, TextArea 20, DatePicker 40, Dropdown 20, RadioButtonsGroup 20
    const maxLabel = field.type === 'date' ? 40 : 20;
    if (typeof field.label !== 'string' || !field.label.trim() ||
        field.label.trim().length > maxLabel || hasBadControls(field.label)) {
      throw new NativeFlowValidationError('Field "' + field.id + '" label exceeds native Flow limits.');
    }
    const common = {
      name: field.id,
      label: field.label.trim(),
      required: field.required === true,
    };

    if (field.type === 'textarea') {
      children.push({ type: 'TextArea', ...common });
    } else if (field.type === 'date') {
      children.push({ type: 'DatePicker', ...common });
    } else if (field.type === 'select' || field.type === 'radio') {
      if (!Array.isArray(field.options) || field.options.length < 2 || field.options.length > 20 ||
          field.options.some((o: unknown) => typeof o !== 'string' || !o.trim() ||
            o.trim().length > 30 || hasBadControls(o)) ||
          new Set(field.options).size !== field.options.length) {
        throw new NativeFlowValidationError('Field "' + field.id + '" needs 2–20 unique options of up to 30 characters.');
      }
      children.push({
        type: field.type === 'select' ? 'Dropdown' : 'RadioButtonsGroup',
        ...common,
        'data-source': field.options.map((o: string, i: number) => ({
          id: 'option_' + (i + 1), title: o.trim(),
        })),
      });
    } else {
      children.push({ type: 'TextInput', ...common, 'input-type': INPUT_TYPES[field.type] });
    }

    // Required to surface answers to the inbound nfm_reply webhook.
    payload[field.id] = '$' + '{form.' + field.id + '}';
  }

  // Optional marketing consent checkbox — appended after fields, before footer.
  // Uses OptIn component per Meta spec. Only included when settings.consent_label is set.
  const consentLabel = form.settings?.consent_label?.trim();
  if (consentLabel && consentLabel.length <= 100 && !hasBadControls(consentLabel)) {
    children.push({
      type: 'OptIn',
      name: CONSENT_FIELD_ID,
      label: consentLabel,
      required: false,
    });
    payload[CONSENT_FIELD_ID] = '$' + '{form.' + CONSENT_FIELD_ID + '}';
  }

  children.push({
    type: 'Footer',
    label: 'Submit',
    'on-click-action': { name: 'complete', payload },
  });

  return {
    version: '7.3',
    routing_model: { FORM: [] },
    screens: [{
      id: 'FORM', title: form.title.trim(), terminal: true, success: true,
      layout: { type: 'SingleColumnLayout', children },
    }],
  };
}

// ── Response Validation ──

/**
 * Validate a Flow response payload against the form's field schema.
 *
 * Rejects:
 * - Extra fields not in the schema (prevents injection)
 * - Missing required fields
 * - Values that don't match expected types
 * - Excessively long string values
 *
 * Returns cleaned answers with only declared field IDs.
 */
export function validateFlowResponse(
  formFields: WaaiioFormField[],
  responseData: Record<string, unknown>,
  options?: { hasConsent?: boolean },
): FlowResponseValidation {
  if (!responseData || typeof responseData !== 'object' || Array.isArray(responseData)) {
    return { valid: false, error: 'Response data must be an object.' };
  }

  const fieldMap = new Map<string, WaaiioFormField>();
  for (const f of formFields) {
    fieldMap.set(f.id, f);
  }

  // Compute the set of allowed keys
  const allowedKeys = new Set(fieldMap.keys());
  if (options?.hasConsent) {
    allowedKeys.add(CONSENT_FIELD_ID);
  }

  // Reject extra/unknown fields — prevents payload injection
  for (const key of Object.keys(responseData)) {
    if (!allowedKeys.has(key)) {
      return { valid: false, error: `Unexpected field "${key}" in response.` };
    }
  }

  const answers: Record<string, unknown> = {};

  // Validate each declared field
  for (const [fieldId, field] of fieldMap) {
    const value = responseData[fieldId];

    // Required check
    if (field.required && (value === undefined || value === null || value === '')) {
      return { valid: false, error: `Required field "${field.label}" is missing.` };
    }

    // Skip absent optional fields
    if (value === undefined || value === null || value === '') {
      continue;
    }

    // Type-specific validation
    switch (field.type) {
      case 'text':
      case 'textarea':
      case 'email':
      case 'phone':
        if (typeof value !== 'string' || value.length > 5000) {
          return { valid: false, error: `Field "${field.label}" must be a string (max 5000 chars).` };
        }
        if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          return { valid: false, error: `Field "${field.label}" must be a valid email.` };
        }
        if (field.type === 'phone' && !/^[+\d\s()-]{3,20}$/.test(value)) {
          return { valid: false, error: `Field "${field.label}" must be a valid phone number.` };
        }
        answers[fieldId] = value;
        break;

      case 'number':
        // Meta Flows may send numbers as strings
        if (typeof value === 'string') {
          const parsed = Number(value);
          if (Number.isNaN(parsed)) {
            return { valid: false, error: `Field "${field.label}" must be a number.` };
          }
          answers[fieldId] = parsed;
        } else if (typeof value === 'number' && Number.isFinite(value)) {
          answers[fieldId] = value;
        } else {
          return { valid: false, error: `Field "${field.label}" must be a number.` };
        }
        break;

      case 'date':
        // Meta DatePicker sends ISO date strings
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) {
          return { valid: false, error: `Field "${field.label}" must be a valid date.` };
        }
        answers[fieldId] = value;
        break;

      case 'select':
      case 'radio':
        // Meta sends the option ID (e.g. "option_1"), not the display title
        if (typeof value !== 'string') {
          return { valid: false, error: `Field "${field.label}" must be a string selection.` };
        }
        answers[fieldId] = value;
        break;

      default:
        // Unknown field type — should not happen if form was compiled, but fail closed
        return { valid: false, error: `Field "${field.label}" has unrecognized type "${field.type}".` };
    }
  }

  // Preserve consent value if present
  if (options?.hasConsent && responseData[CONSENT_FIELD_ID] !== undefined) {
    answers[CONSENT_FIELD_ID] = !!responseData[CONSENT_FIELD_ID];
  }

  return { valid: true, answers };
}

/**
 * Map option IDs back to display titles for human-readable storage.
 *
 * Meta Flows submit option IDs like "option_1" — this resolves them
 * to the original option labels from the form definition.
 */
export function resolveOptionLabels(
  formFields: WaaiioFormField[],
  answers: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...answers };

  for (const field of formFields) {
    if ((field.type === 'select' || field.type === 'radio') && Array.isArray(field.options)) {
      const rawValue = answers[field.id];
      if (typeof rawValue === 'string' && rawValue.startsWith('option_')) {
        const index = parseInt(rawValue.replace('option_', ''), 10) - 1;
        if (index >= 0 && index < field.options.length) {
          resolved[field.id] = (field.options[index] as string).trim();
        }
      }
    }
  }

  return resolved;
}

/** Exported for testing. */
export { CONSENT_FIELD_ID };
