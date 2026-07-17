import { describe, it, expect } from 'vitest';
import { classifyIntent, FINANCE_REPORTS, FINANCE_ROLES } from '../classify-intent';

describe('classifyIntent', () => {
  // ── Bookings ──
  describe('bookings', () => {
    it('classifies "how many bookings today" → bookings_today', () => {
      expect(classifyIntent('How many bookings today?')).toEqual({ report: 'bookings_today', followUp: false });
    });

    it('classifies "appointments today" → bookings_today', () => {
      expect(classifyIntent('appointments today')).toEqual({ report: 'bookings_today', followUp: false });
    });

    it('classifies bare "bookings" → bookings_today (default)', () => {
      expect(classifyIntent('bookings')).toEqual({ report: 'bookings_today', followUp: false });
    });

    it('classifies "upcoming bookings" → bookings_upcoming', () => {
      expect(classifyIntent('upcoming bookings')).toEqual({ report: 'bookings_upcoming', followUp: false });
    });

    it('classifies "bookings this week" → bookings_week', () => {
      expect(classifyIntent('bookings this week')).toEqual({ report: 'bookings_week', followUp: false });
    });

    it('classifies "bookings this month" → bookings_month', () => {
      expect(classifyIntent('how many bookings this month')).toEqual({ report: 'bookings_month', followUp: false });
    });

    it('classifies "unpaid bookings" → unpaid_bookings', () => {
      expect(classifyIntent('unpaid bookings')).toEqual({ report: 'unpaid_bookings', followUp: false });
    });

    it('classifies "cancelled bookings" → cancellation_rate', () => {
      expect(classifyIntent('how many cancelled bookings')).toEqual({ report: 'cancellation_rate', followUp: false });
    });
  });

  // ── Orders ──
  describe('orders', () => {
    it('classifies "orders today" → orders_today', () => {
      expect(classifyIntent('how many orders today?')).toEqual({ report: 'orders_today', followUp: false });
    });

    it('classifies "pending orders" → orders_pending', () => {
      expect(classifyIntent('any pending orders?')).toEqual({ report: 'orders_pending', followUp: false });
    });

    it('classifies "unfulfilled orders" → orders_pending', () => {
      expect(classifyIntent('unfulfilled orders')).toEqual({ report: 'orders_pending', followUp: false });
    });
  });

  // ── Revenue ──
  describe('revenue', () => {
    it('classifies "revenue today" → revenue_today', () => {
      expect(classifyIntent("what's my revenue today?")).toEqual({ report: 'revenue_today', followUp: false });
    });

    it('classifies "how much did I earn" → revenue_today (default)', () => {
      expect(classifyIntent('how much did I earn?')).toEqual({ report: 'revenue_today', followUp: false });
    });

    it('classifies "revenue this week" → revenue_week', () => {
      expect(classifyIntent('revenue this week')).toEqual({ report: 'revenue_week', followUp: false });
    });

    it('classifies "revenue this month" → revenue_month', () => {
      expect(classifyIntent('what was my revenue this month?')).toEqual({ report: 'revenue_month', followUp: false });
    });

    it('classifies "compare revenue" → revenue_compare', () => {
      expect(classifyIntent('compare my revenue')).toEqual({ report: 'revenue_compare', followUp: false });
    });

    it('classifies "how much money did I make" → revenue_today', () => {
      expect(classifyIntent('how much money did I make?')).toEqual({ report: 'revenue_today', followUp: false });
    });

    it('classifies "sales this week" → revenue_week', () => {
      expect(classifyIntent('sales this week')).toEqual({ report: 'revenue_week', followUp: false });
    });
  });

  // ── Unpaid ──
  describe('unpaid', () => {
    it('classifies "unpaid invoices" → unpaid_invoices', () => {
      expect(classifyIntent('any unpaid invoices?')).toEqual({ report: 'unpaid_invoices', followUp: false });
    });

    it('classifies "outstanding" → unpaid_bookings (default)', () => {
      expect(classifyIntent('anything outstanding?')).toEqual({ report: 'unpaid_bookings', followUp: false });
    });

    it('classifies "overdue invoices" → unpaid_invoices', () => {
      expect(classifyIntent('overdue invoices')).toEqual({ report: 'unpaid_invoices', followUp: false });
    });
  });

  // ── Products & Services ──
  describe('products and services', () => {
    it('classifies "top products" → top_products', () => {
      expect(classifyIntent('what are my top products?')).toEqual({ report: 'top_products', followUp: false });
    });

    it('classifies "best selling" → top_products', () => {
      expect(classifyIntent('best selling products')).toEqual({ report: 'top_products', followUp: false });
    });

    it('classifies "most sold" → top_products', () => {
      expect(classifyIntent('most sold items')).toEqual({ report: 'top_products', followUp: false });
    });

    it('classifies "low stock" → low_stock', () => {
      expect(classifyIntent('any products low on stock?')).toEqual({ report: 'low_stock', followUp: false });
    });

    it('classifies "running low" → low_stock', () => {
      expect(classifyIntent("what's running low?")).toEqual({ report: 'low_stock', followUp: false });
    });

    it('classifies "top services" → top_services', () => {
      expect(classifyIntent('what are my top services?')).toEqual({ report: 'top_services', followUp: false });
    });

    it('classifies "most booked" → top_services', () => {
      expect(classifyIntent('most booked service')).toEqual({ report: 'top_services', followUp: false });
    });
  });

  // ── Customers ──
  describe('customers', () => {
    it('classifies "new customers" → customers_new', () => {
      expect(classifyIntent('how many new customers?')).toEqual({ report: 'customers_new', followUp: false });
    });

    it('classifies "returning customers" → customers_returning', () => {
      expect(classifyIntent('returning customers')).toEqual({ report: 'customers_returning', followUp: false });
    });

    it('classifies "repeat customers" → customers_returning', () => {
      expect(classifyIntent('repeat customers')).toEqual({ report: 'customers_returning', followUp: false });
    });
  });

  // ── Other ──
  describe('other reports', () => {
    it('classifies "cancellation rate" → cancellation_rate', () => {
      expect(classifyIntent('what is my cancellation rate?')).toEqual({ report: 'cancellation_rate', followUp: false });
    });

    it('classifies "check-ins today" → checkins_today', () => {
      expect(classifyIntent('how many check-ins today?')).toEqual({ report: 'checkins_today', followUp: false });
    });

    it('classifies "attendance" → checkins_today', () => {
      expect(classifyIntent('attendance today')).toEqual({ report: 'checkins_today', followUp: false });
    });

    it('classifies "anything needing attention" → attention_items', () => {
      expect(classifyIntent('anything needing attention?')).toEqual({ report: 'attention_items', followUp: false });
    });

    it('classifies "what do I need to do" → attention_items', () => {
      expect(classifyIntent('what do I need to do?')).toEqual({ report: 'attention_items', followUp: false });
    });
  });

  // ── Unsupported ──
  describe('unsupported questions', () => {
    it('returns null for unrecognized questions', () => {
      expect(classifyIntent('tell me a joke')).toEqual({ report: null, followUp: false });
    });

    it('returns null for empty input', () => {
      expect(classifyIntent('')).toEqual({ report: null, followUp: false });
    });

    it('returns null for random text', () => {
      expect(classifyIntent('hello there')).toEqual({ report: null, followUp: false });
    });
  });

  // ── Follow-ups ──
  describe('follow-up context', () => {
    it('maps "what about last week" after revenue → revenue_compare', () => {
      const result = classifyIntent('what about last week?', { lastReport: 'revenue_today' });
      expect(result).toEqual({ report: 'revenue_compare', followUp: true });
    });

    it('maps "last month" after revenue_week → revenue_compare', () => {
      const result = classifyIntent('last month', { lastReport: 'revenue_week' });
      expect(result).toEqual({ report: 'revenue_compare', followUp: true });
    });

    it('maps "what about last week" after bookings → bookings_week', () => {
      const result = classifyIntent('what about last week?', { lastReport: 'bookings_today' });
      expect(result).toEqual({ report: 'bookings_week', followUp: true });
    });

    it('maps "compare" after revenue report → revenue_compare', () => {
      const result = classifyIntent('compare', { lastReport: 'revenue_week' });
      expect(result).toEqual({ report: 'revenue_compare', followUp: true });
    });

    it('does not treat follow-up without context', () => {
      const result = classifyIntent('what about last week?');
      expect(result.followUp).toBe(false);
    });
  });
});

describe('FINANCE_REPORTS', () => {
  it('includes all revenue reports', () => {
    expect(FINANCE_REPORTS).toContain('revenue_today');
    expect(FINANCE_REPORTS).toContain('revenue_week');
    expect(FINANCE_REPORTS).toContain('revenue_month');
    expect(FINANCE_REPORTS).toContain('revenue_compare');
  });

  it('includes unpaid reports', () => {
    expect(FINANCE_REPORTS).toContain('unpaid_bookings');
    expect(FINANCE_REPORTS).toContain('unpaid_invoices');
  });

  it('does not include bookings_today (non-financial)', () => {
    expect(FINANCE_REPORTS).not.toContain('bookings_today');
    expect(FINANCE_REPORTS).not.toContain('checkins_today');
    expect(FINANCE_REPORTS).not.toContain('attention_items');
  });
});

describe('FINANCE_ROLES', () => {
  it('includes owner, admin, manager, finance', () => {
    expect(FINANCE_ROLES).toEqual(['owner', 'admin', 'manager', 'finance']);
  });

  it('excludes staff and support', () => {
    expect(FINANCE_ROLES).not.toContain('staff');
    expect(FINANCE_ROLES).not.toContain('support');
  });
});
