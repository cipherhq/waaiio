import { describe, expect, it } from 'vitest';
import {
  compileNativeFormFlow, NativeFlowValidationError,
  validateFlowResponse, resolveOptionLabels, CONSENT_FIELD_ID,
} from '@/lib/whatsapp-forms/native-flow';

const basic = () => ({
  title: 'Event Registration',
  description: 'Let us know your interest.',
  fields: [
    { id: 'customer_name', label: 'Full name', type: 'text', required: true },
    { id: 'customer_email', label: 'Email', type: 'email', required: true },
    { id: 'event', label: 'Event', type: 'select', required: true, options: ['Business', 'Social'] },
  ],
});

describe('#591 native WhatsApp Form JSON compiler', () => {
  it('generates Meta Flow 7.3 with terminal explicit answer payload', () => {
    const result = compileNativeFormFlow(basic());
    expect(result.version).toBe('7.3');
    expect(result.routing_model).toEqual({ FORM: [] });
    const screens = result.screens as Array<Record<string, unknown>>;
    expect(screens).toHaveLength(1);
    expect(screens[0].terminal).toBe(true);
    const children = (screens[0].layout as { children: Array<Record<string, unknown>> }).children;
    expect(children.map(x => x.type)).toEqual(['TextBody', 'TextInput', 'TextInput', 'Dropdown', 'Footer']);
    expect(children[3]['data-source']).toEqual([
      { id: 'option_1', title: 'Business' },
      { id: 'option_2', title: 'Social' },
    ]);
    expect(children[4]['on-click-action']).toEqual({
      name: 'complete',
      payload: {
        customer_name: '${form.customer_name}',
        customer_email: '${form.customer_email}',
        event: '${form.event}',
      },
    });
  });

  it('supports registration and booking REQUEST fields without creating booking state', () => {
    const r = compileNativeFormFlow({
      title: 'Request Appointment',
      fields: [
        { id: 'date', label: 'Preferred date', type: 'date', required: true },
        { id: 'notes', label: 'Comments', type: 'textarea', required: false },
        { id: 'size', label: 'Party size', type: 'number', required: true },
        { id: 'service', label: 'Service', type: 'radio', options: ['Consult', 'Class'] },
      ],
    });
    const children = ((r.screens as Array<any>)[0].layout.children) as Array<any>;
    expect(children.map(x => x.type)).toEqual([
      'DatePicker', 'TextArea', 'TextInput', 'RadioButtonsGroup', 'Footer',
    ]);
    expect(children[2]['input-type']).toBe('number');
    expect(JSON.stringify(r)).not.toContain('booking_confirmed');
  });

  it.each(['file', 'multi_select', 'checkbox', 'unsupported'])(
    'rejects unsupported %s instead of dropping a required field',
    type => {
      expect(() => compileNativeFormFlow({ title: 'Lead', fields: [{ id: 'photo', label: 'Evidence', type, required: true }] }))
        .toThrow(NativeFlowValidationError);
    },
  );

  it('provides a helpful hint for Waaiio-only field types', () => {
    try {
      compileNativeFormFlow({ title: 'Lead', fields: [{ id: 'photo', label: 'Evidence', type: 'file', required: true }] });
      expect.fail('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(NativeFlowValidationError);
      expect((e as NativeFlowValidationError).message).toContain('available on web forms');
    }
  });

  it('rejects unsafe field IDs and duplicates', () => {
    for (const id of ['name);} hack', 'x.y', '__proto__', '$name', '']) {
      expect(() => compileNativeFormFlow({ title: 'Lead', fields: [{ id, label: 'Name', type: 'text' }] }))
        .toThrow(NativeFlowValidationError);
    }
    expect(() => compileNativeFormFlow({
      title: 'Lead',
      fields: [
        { id: 'name', label: 'Name', type: 'text' },
        { id: 'name', label: 'Again', type: 'text' },
      ],
    })).toThrow(NativeFlowValidationError);
  });

  it('rejects unrepresentable titles, labels and options', () => {
    expect(() => compileNativeFormFlow({ title: 'X'.repeat(31), fields: basic().fields }))
      .toThrow(NativeFlowValidationError);
    expect(() => compileNativeFormFlow({
      title: 'Lead', fields: [{ id: 'name', label: 'X'.repeat(21), type: 'text' }],
    })).toThrow(NativeFlowValidationError);
    expect(() => compileNativeFormFlow({
      title: 'Lead', fields: [{ id: 'choice', label: 'Choice', type: 'select', options: ['Only one'] }],
    })).toThrow(NativeFlowValidationError);
    expect(() => compileNativeFormFlow({ title: 'Lead', fields: [] }))
      .toThrow(NativeFlowValidationError);
    expect(() => compileNativeFormFlow({ title: 'Lead', fields: Array(9).fill({ id: 'x', label: 'X', type: 'text' }) }))
      .toThrow(NativeFlowValidationError);
  });

  it('does not mutate the original form or silently publish/send anything', () => {
    const value = basic();
    const snapshot = JSON.stringify(value);
    const json = compileNativeFormFlow(value);
    expect(JSON.stringify(value)).toBe(snapshot);
    expect(JSON.stringify(json)).not.toContain('access_token');
    expect(JSON.stringify(json)).not.toContain('phone_number_id');
    expect(JSON.stringify(json)).not.toContain('endpoint_uri');
  });

  it('includes OptIn component when consent_label is provided', () => {
    const result = compileNativeFormFlow({
      title: 'Newsletter Signup',
      fields: [{ id: 'email', label: 'Email', type: 'email', required: true }],
      settings: { consent_label: 'I agree to receive marketing messages' },
    });
    const children = ((result.screens as Array<any>)[0].layout.children) as Array<any>;
    expect(children.map(x => x.type)).toEqual(['TextInput', 'OptIn', 'Footer']);
    expect(children[1].name).toBe(CONSENT_FIELD_ID);
    expect(children[1].label).toBe('I agree to receive marketing messages');
    expect(children[1].required).toBe(false);
    // Consent field should be in the payload
    const footer = children[2];
    expect(footer['on-click-action'].payload[CONSENT_FIELD_ID]).toBe('${form.' + CONSENT_FIELD_ID + '}');
  });

  it('omits OptIn when consent_label is absent or empty', () => {
    const noSettings = compileNativeFormFlow({
      title: 'Lead', fields: [{ id: 'name', label: 'Name', type: 'text' }],
    });
    const children1 = ((noSettings.screens as Array<any>)[0].layout.children) as Array<any>;
    expect(children1.map(x => x.type)).not.toContain('OptIn');

    const emptyConsent = compileNativeFormFlow({
      title: 'Lead', fields: [{ id: 'name', label: 'Name', type: 'text' }],
      settings: { consent_label: '' },
    });
    const children2 = ((emptyConsent.screens as Array<any>)[0].layout.children) as Array<any>;
    expect(children2.map(x => x.type)).not.toContain('OptIn');
  });
});

describe('#591 Flow response validation', () => {
  const fields = [
    { id: 'name', label: 'Name', type: 'text', required: true },
    { id: 'email', label: 'Email', type: 'email', required: false },
    { id: 'age', label: 'Age', type: 'number', required: false },
    { id: 'date', label: 'Preferred date', type: 'date', required: false },
    { id: 'service', label: 'Service', type: 'select', options: ['Consult', 'Class'] },
    { id: 'phone', label: 'Phone', type: 'phone', required: false },
  ];

  it('accepts valid response with all fields', () => {
    const result = validateFlowResponse(fields, {
      name: 'John Doe',
      email: 'john@example.com',
      age: '25',
      date: '2026-12-25',
      service: 'option_1',
      phone: '+1234567890',
    });
    expect(result.valid).toBe(true);
    expect(result.answers).toBeDefined();
    expect(result.answers!.name).toBe('John Doe');
    expect(result.answers!.age).toBe(25); // Parsed from string
  });

  it('accepts valid response with only required fields', () => {
    const result = validateFlowResponse(fields, { name: 'Jane' });
    expect(result.valid).toBe(true);
    expect(result.answers!.name).toBe('Jane');
  });

  it('rejects missing required field', () => {
    const result = validateFlowResponse(fields, { email: 'john@example.com' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Name');
  });

  it('rejects extra/unknown fields (prevents injection)', () => {
    const result = validateFlowResponse(fields, {
      name: 'John',
      injected_field: 'malicious_data',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Unexpected field');
  });

  it('rejects invalid email format', () => {
    const result = validateFlowResponse(fields, {
      name: 'John',
      email: 'not-an-email',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('valid email');
  });

  it('rejects invalid phone format', () => {
    const result = validateFlowResponse(fields, {
      name: 'John',
      phone: 'not-a-phone!!!',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('valid phone');
  });

  it('rejects non-numeric number field', () => {
    const result = validateFlowResponse(fields, {
      name: 'John',
      age: 'not-a-number',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('number');
  });

  it('rejects invalid date format', () => {
    const result = validateFlowResponse(fields, {
      name: 'John',
      date: 'tomorrow',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('valid date');
  });

  it('rejects excessively long strings', () => {
    const result = validateFlowResponse(fields, {
      name: 'X'.repeat(5001),
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('max 5000');
  });

  it('rejects non-object response data', () => {
    expect(validateFlowResponse(fields, null as any).valid).toBe(false);
    expect(validateFlowResponse(fields, 'string' as any).valid).toBe(false);
    expect(validateFlowResponse(fields, [1, 2] as any).valid).toBe(false);
  });

  it('handles consent field when hasConsent is true', () => {
    const result = validateFlowResponse(
      [{ id: 'name', label: 'Name', type: 'text', required: true }],
      { name: 'John', [CONSENT_FIELD_ID]: true },
      { hasConsent: true },
    );
    expect(result.valid).toBe(true);
    expect(result.answers![CONSENT_FIELD_ID]).toBe(true);
  });

  it('rejects consent field when hasConsent is false', () => {
    const result = validateFlowResponse(
      [{ id: 'name', label: 'Name', type: 'text', required: true }],
      { name: 'John', [CONSENT_FIELD_ID]: true },
      { hasConsent: false },
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Unexpected field');
  });
});

describe('#591 option label resolution', () => {
  it('resolves option IDs to display titles', () => {
    const fields = [
      { id: 'service', label: 'Service', type: 'select', options: ['Consult', 'Class'] },
      { id: 'priority', label: 'Priority', type: 'radio', options: ['Low', 'Medium', 'High'] },
      { id: 'name', label: 'Name', type: 'text' },
    ];
    const resolved = resolveOptionLabels(fields, {
      service: 'option_1',
      priority: 'option_3',
      name: 'John',
    });
    expect(resolved.service).toBe('Consult');
    expect(resolved.priority).toBe('High');
    expect(resolved.name).toBe('John');
  });

  it('preserves original value for non-select fields', () => {
    const fields = [{ id: 'name', label: 'Name', type: 'text' }];
    const resolved = resolveOptionLabels(fields, { name: 'option_1' });
    expect(resolved.name).toBe('option_1');
  });

  it('preserves option ID if index is out of range', () => {
    const fields = [{ id: 'svc', label: 'Service', type: 'select', options: ['A', 'B'] }];
    const resolved = resolveOptionLabels(fields, { svc: 'option_99' });
    expect(resolved.svc).toBe('option_99');
  });
});
