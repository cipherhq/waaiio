import { describe, expect, it } from 'vitest';
import {
  compileNativeFormFlow, NativeFlowValidationError,
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
});
