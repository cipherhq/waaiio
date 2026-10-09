import { describe, expect, it } from 'vitest';
import {
  compileNativeFormFlow, NativeFlowValidationError, CONSENT_FIELD_ID,
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

  // ── Defect D: consent_label type validation ──

  it('rejects non-string consent_label (number)', () => {
    expect(() => compileNativeFormFlow({
      title: 'Lead', fields: [{ id: 'name', label: 'Name', type: 'text' }],
      settings: { consent_label: 42 as unknown as string },
    })).toThrow(NativeFlowValidationError);
  });

  it('rejects non-string consent_label (object)', () => {
    expect(() => compileNativeFormFlow({
      title: 'Lead', fields: [{ id: 'name', label: 'Name', type: 'text' }],
      settings: { consent_label: { nested: true } as unknown as string },
    })).toThrow(NativeFlowValidationError);
  });

  it('rejects non-string consent_label (array)', () => {
    expect(() => compileNativeFormFlow({
      title: 'Lead', fields: [{ id: 'name', label: 'Name', type: 'text' }],
      settings: { consent_label: ['agree'] as unknown as string },
    })).toThrow(NativeFlowValidationError);
  });

  it('rejects non-string consent_label (boolean)', () => {
    expect(() => compileNativeFormFlow({
      title: 'Lead', fields: [{ id: 'name', label: 'Name', type: 'text' }],
      settings: { consent_label: true as unknown as string },
    })).toThrow(NativeFlowValidationError);
  });

  it('rejects overlong OptIn consent_label (>120 chars)', () => {
    expect(() => compileNativeFormFlow({
      title: 'Lead', fields: [{ id: 'name', label: 'Name', type: 'text' }],
      settings: { consent_label: 'A'.repeat(121) },
    })).toThrow(NativeFlowValidationError);
  });

  it('accepts OptIn consent_label at exactly 120 chars', () => {
    const result = compileNativeFormFlow({
      title: 'Lead', fields: [{ id: 'name', label: 'Name', type: 'text' }],
      settings: { consent_label: 'A'.repeat(120) },
    });
    const children = ((result.screens as Array<any>)[0].layout.children) as Array<any>;
    expect(children.map(x => x.type)).toContain('OptIn');
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

  // ── Defect 2: strict boolean validation for required ──

  it('rejects non-boolean required values like "yes" or 1', () => {
    expect(() => compileNativeFormFlow({
      title: 'Lead',
      fields: [{ id: 'name', label: 'Name', type: 'text', required: 'yes' as unknown as boolean }],
    })).toThrow(NativeFlowValidationError);

    expect(() => compileNativeFormFlow({
      title: 'Lead',
      fields: [{ id: 'name', label: 'Name', type: 'text', required: 1 as unknown as boolean }],
    })).toThrow(NativeFlowValidationError);

    expect(() => compileNativeFormFlow({
      title: 'Lead',
      fields: [{ id: 'name', label: 'Name', type: 'text', required: 'true' as unknown as boolean }],
    })).toThrow(NativeFlowValidationError);
  });

  it('accepts required: true, false, or undefined', () => {
    // These should all compile without throwing
    expect(() => compileNativeFormFlow({
      title: 'Lead',
      fields: [{ id: 'name', label: 'Name', type: 'text', required: true }],
    })).not.toThrow();

    expect(() => compileNativeFormFlow({
      title: 'Lead',
      fields: [{ id: 'name', label: 'Name', type: 'text', required: false }],
    })).not.toThrow();

    expect(() => compileNativeFormFlow({
      title: 'Lead',
      fields: [{ id: 'name', label: 'Name', type: 'text' }],
    })).not.toThrow();
  });

  // ── Defect 2: options normalized before uniqueness check ──

  it('rejects options that are duplicates after trimming', () => {
    expect(() => compileNativeFormFlow({
      title: 'Lead',
      fields: [{ id: 'cat', label: 'Category', type: 'select', options: ['Sales', ' Sales'] }],
    })).toThrow(NativeFlowValidationError);

    expect(() => compileNativeFormFlow({
      title: 'Lead',
      fields: [{ id: 'cat', label: 'Category', type: 'radio', options: ['Foo ', ' Foo'] }],
    })).toThrow(NativeFlowValidationError);
  });

  // ── Defect 4: canonical Meta Flow JSON fixture conformance ──

  describe('offline structural checks against documented Meta Flow constraints', () => {
    /**
     * Checks based on Meta WhatsApp Flows documentation:
     * https://developers.facebook.com/docs/whatsapp/flows/
     *
     * These are offline structural checks only; Meta Flow asset validation
     * is not verified here — that requires a separate provider gate.
     */
    const EXPECTED_META_FLOW_VERSION = '7.3';

    // Valid component types per Meta documentation
    const VALID_COMPONENT_TYPES = new Set([
      'TextBody', 'TextHeading', 'TextSubheading', 'TextCaption',
      'TextInput', 'TextArea', 'DatePicker', 'Dropdown', 'RadioButtonsGroup',
      'CheckboxGroup', 'OptIn', 'Footer', 'Image', 'EmbeddedLink',
    ]);

    // Valid input-type values per Meta documentation
    const VALID_INPUT_TYPES = new Set(['text', 'number', 'email', 'phone', 'password']);

    // Meta label length limits per component type
    const META_LABEL_LIMITS: Record<string, number> = {
      TextInput: 20,
      TextArea: 20,
      DatePicker: 40,
      Dropdown: 20,
      RadioButtonsGroup: 20,
    };

    it('uses the pinned Meta Flow version', () => {
      const result = compileNativeFormFlow(basic());
      expect(result.version).toBe(EXPECTED_META_FLOW_VERSION);
    });

    it('produces valid top-level structure with routing_model and screens', () => {
      const result = compileNativeFormFlow(basic());
      expect(result).toHaveProperty('version');
      expect(result).toHaveProperty('routing_model');
      expect(result).toHaveProperty('screens');
      expect(typeof result.version).toBe('string');
      expect(Array.isArray(result.screens)).toBe(true);
      const screens = result.screens as Array<any>;
      expect(screens.length).toBeGreaterThanOrEqual(1);
      for (const screen of screens) {
        expect(screen).toHaveProperty('id');
        expect(screen).toHaveProperty('title');
        expect(screen).toHaveProperty('layout');
        expect(screen.layout).toHaveProperty('type', 'SingleColumnLayout');
        expect(screen.layout).toHaveProperty('children');
        expect(Array.isArray(screen.layout.children)).toBe(true);
      }
    });

    it('only uses valid Meta component types', () => {
      const result = compileNativeFormFlow({
        title: 'Full Test',
        description: 'All field types',
        fields: [
          { id: 'name', label: 'Name', type: 'text', required: true },
          { id: 'bio', label: 'Bio', type: 'textarea' },
          { id: 'dob', label: 'Birth date', type: 'date' },
          { id: 'cat', label: 'Category', type: 'select', options: ['A', 'B'] },
          { id: 'pref', label: 'Preference', type: 'radio', options: ['X', 'Y'] },
          { id: 'email', label: 'Email', type: 'email' },
          { id: 'phone', label: 'Phone', type: 'phone' },
          { id: 'count', label: 'Count', type: 'number' },
        ],
        settings: { consent_label: 'I agree' },
      });
      const children = (result.screens as Array<any>)[0].layout.children;
      for (const child of children) {
        expect(VALID_COMPONENT_TYPES.has(child.type)).toBe(true);
      }
    });

    it('TextInput uses valid input-type values', () => {
      for (const [waaiioType, metaInputType] of [['text', 'text'], ['number', 'number'], ['email', 'email'], ['phone', 'phone']]) {
        const result = compileNativeFormFlow({
          title: 'Test',
          fields: [{ id: 'f', label: 'Field', type: waaiioType }],
        });
        const children = (result.screens as Array<any>)[0].layout.children;
        const textInput = children.find((c: any) => c.type === 'TextInput');
        expect(textInput).toBeDefined();
        expect(VALID_INPUT_TYPES.has(textInput['input-type'])).toBe(true);
        expect(textInput['input-type']).toBe(metaInputType);
      }
    });

    it('Dropdown data-source has correct id/title structure', () => {
      const result = compileNativeFormFlow({
        title: 'Test',
        fields: [{ id: 'sel', label: 'Choice', type: 'select', options: ['Alpha', 'Beta', 'Gamma'] }],
      });
      const children = (result.screens as Array<any>)[0].layout.children;
      const dropdown = children.find((c: any) => c.type === 'Dropdown');
      expect(dropdown).toBeDefined();
      expect(Array.isArray(dropdown['data-source'])).toBe(true);
      for (const item of dropdown['data-source']) {
        expect(item).toHaveProperty('id');
        expect(item).toHaveProperty('title');
        expect(typeof item.id).toBe('string');
        expect(typeof item.title).toBe('string');
        // Meta requires data-source IDs to be non-empty strings
        expect(item.id.length).toBeGreaterThan(0);
        expect(item.title.length).toBeGreaterThan(0);
      }
      expect(dropdown['data-source']).toEqual([
        { id: 'option_1', title: 'Alpha' },
        { id: 'option_2', title: 'Beta' },
        { id: 'option_3', title: 'Gamma' },
      ]);
    });

    it('Footer on-click-action uses "complete" action name with payload', () => {
      const result = compileNativeFormFlow({
        title: 'Test',
        fields: [{ id: 'name', label: 'Name', type: 'text' }],
      });
      const children = (result.screens as Array<any>)[0].layout.children;
      const footer = children.find((c: any) => c.type === 'Footer');
      expect(footer).toBeDefined();
      expect(footer).toHaveProperty('label');
      expect(footer).toHaveProperty('on-click-action');
      expect(footer['on-click-action']).toHaveProperty('name', 'complete');
      expect(footer['on-click-action']).toHaveProperty('payload');
      expect(typeof footer['on-click-action'].payload).toBe('object');
    });

    it('enforces Meta label length limits per component type', () => {
      // TextInput label limit is 20 — this should fail
      expect(() => compileNativeFormFlow({
        title: 'Test',
        fields: [{ id: 'x', label: 'A'.repeat(21), type: 'text' }],
      })).toThrow(NativeFlowValidationError);

      // DatePicker label limit is 40 — 21 chars should pass
      expect(() => compileNativeFormFlow({
        title: 'Test',
        fields: [{ id: 'x', label: 'A'.repeat(21), type: 'date' }],
      })).not.toThrow();

      // DatePicker label limit is 40 — 41 chars should fail
      expect(() => compileNativeFormFlow({
        title: 'Test',
        fields: [{ id: 'x', label: 'A'.repeat(41), type: 'date' }],
      })).toThrow(NativeFlowValidationError);

      // Dropdown/RadioButtonsGroup label limit is 20
      expect(() => compileNativeFormFlow({
        title: 'Test',
        fields: [{ id: 'x', label: 'A'.repeat(21), type: 'select', options: ['A', 'B'] }],
      })).toThrow(NativeFlowValidationError);

      expect(() => compileNativeFormFlow({
        title: 'Test',
        fields: [{ id: 'x', label: 'A'.repeat(21), type: 'radio', options: ['A', 'B'] }],
      })).toThrow(NativeFlowValidationError);
    });

    it('option title length is capped at 30 per Meta spec', () => {
      expect(() => compileNativeFormFlow({
        title: 'Test',
        fields: [{ id: 'x', label: 'Pick', type: 'select', options: ['A'.repeat(31), 'B'] }],
      })).toThrow(NativeFlowValidationError);

      // 30 chars should pass
      expect(() => compileNativeFormFlow({
        title: 'Test',
        fields: [{ id: 'x', label: 'Pick', type: 'select', options: ['A'.repeat(30), 'B'] }],
      })).not.toThrow();
    });

    it('screen title length is capped at 30 per Meta spec', () => {
      expect(() => compileNativeFormFlow({
        title: 'A'.repeat(31),
        fields: [{ id: 'x', label: 'Name', type: 'text' }],
      })).toThrow(NativeFlowValidationError);

      expect(() => compileNativeFormFlow({
        title: 'A'.repeat(30),
        fields: [{ id: 'x', label: 'Name', type: 'text' }],
      })).not.toThrow();
    });

    it('terminal screen has success: true and terminal: true', () => {
      const result = compileNativeFormFlow(basic());
      const screen = (result.screens as Array<any>)[0];
      expect(screen.terminal).toBe(true);
      expect(screen.success).toBe(true);
    });

    it('description length is capped at 256 per Meta spec', () => {
      expect(() => compileNativeFormFlow({
        title: 'Test',
        description: 'A'.repeat(257),
        fields: [{ id: 'x', label: 'Name', type: 'text' }],
      })).toThrow(NativeFlowValidationError);

      expect(() => compileNativeFormFlow({
        title: 'Test',
        description: 'A'.repeat(256),
        fields: [{ id: 'x', label: 'Name', type: 'text' }],
      })).not.toThrow();
    });
  });
});
