/**
 * #591 — Compile existing Waaiio Forms fields into a single-screen WhatsApp Flow.
 *
 * Pure compiler for preview only. Does NOT publish, send, or accept submissions.
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
    // Fail-closed: reject non-boolean `required` values (e.g. "yes", 1) instead of silently treating as false
    if (field.required !== undefined && field.required !== true && field.required !== false) {
      throw new NativeFlowValidationError(
        'Field "' + field.id + '" has an invalid required value — must be true, false, or omitted.',
      );
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
          // Normalize (trim) options BEFORE checking uniqueness — 'Sales' and ' Sales' are duplicates
          new Set(field.options.map((o: string) => o.trim())).size !== field.options.length) {
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

/** Exported for testing. */
export { CONSENT_FIELD_ID };
