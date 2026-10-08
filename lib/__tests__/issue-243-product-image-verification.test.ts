/**
 * Issue #243 — Product Image Verification Audit Tests
 *
 * Read-only audit: verifies the product image pipeline is fully built
 * and functioning across all layers of the ordering flow.
 *
 * Part A: Source-text structural proofs (ordering.flow.ts)
 * Part B: Executor image dispatch (case 'image' + WebP conversion)
 * Part C: Meta Cloud sendImage API call structure
 * Part D: Upload pipeline security (validate-file + sanitize-image)
 * Part E: Dashboard integration (ProductForm accepts image)
 * Part F: Executable step tests — prompt output includes/omits images
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { FlowStepConfig, FlowContext, PromptMessage } from '@/lib/bot/flows/types';

// ── Module-level mocks (ordering.flow.ts deps) ──

vi.mock('@/lib/bot/flows/shared/payment', () => ({ initializePayment: vi.fn() }));
vi.mock('@/lib/bot/flows/shared/user', () => ({
  createWhatsAppUser: vi.fn().mockResolvedValue('user-uuid-001'),
  findUserByPhone: vi.fn().mockResolvedValue(null),
  isReusableCustomerEmail: vi.fn(() => false),
}));
vi.mock('@/lib/bot/flows/shared/bank-transfer', () => ({
  checkBankTransferEligibility: vi.fn(async () => ({ qualifies: false, bankAccount: null, platformSettings: { transfer_expiry_hours: 24 } })),
  createPendingTransfer: vi.fn(async () => 'TRF-TEST-001'),
  formatBankTransferBlock: vi.fn(() => 'Bank: Test\nAcct: 1234'),
  BANK_ONLY_BUTTONS: [{ id: 'sent_transfer', title: "I've Sent Transfer" }],
}));
vi.mock('@/lib/bot/flows/shared/terms', () => ({ getTermsPrompt: vi.fn(() => [{ type: 'text', text: 'Terms prompt' }]) }));
vi.mock('@/lib/bot/flows/shared/templates', () => ({
  getOrderConfirmationMessage: vi.fn(() => 'Order summary'),
  getConfirmationMessage: vi.fn(() => 'Confirmed'),
}));
vi.mock('@/lib/bot/flows/shared/post-completion', () => ({ handlePostCompletion: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/bot/flows/shared/notify-owner', () => ({
  notifyOwnerNewOrder: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewQuoteRequest: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/bot/flows/shared/notifications', () => ({ createNotification: vi.fn() }));
vi.mock('@/lib/bot/flows/shared/ive-paid-input', () => ({
  parseIvePaidInput: vi.fn().mockReturnValue({ recognized: false }),
  isIvePaidInput: vi.fn(() => false),
}));
vi.mock('@/lib/bot/receipt-ocr', () => ({ analyzeReceipt: vi.fn(), receiptMatchesExpected: vi.fn() }));
vi.mock('@/lib/bot/flows/shared/saved-card-flow', () => ({
  buildSavedCardOffer: vi.fn().mockResolvedValue(null),
  handleSavedCardInput: vi.fn(),
}));
vi.mock('@/lib/bot/flows/shared/safe-interactive', () => ({
  safeButtons: vi.fn((body: string, buttons: unknown[]) => [{ type: 'buttons', body, buttons }]),
}));
vi.mock('@/lib/bot/flows/shared/capability-guard', () => ({
  requireCurrentCapability: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('@/lib/bot/flows/shared/product-availability', () => ({
  isProductAvailable: vi.fn(() => true),
  computeVariantAvailability: vi.fn(() => new Map()),
  getViableAxisValues: vi.fn((_variants: unknown[], _options: Record<string, string>, axisName: string) => {
    // Return axis values that match what the test sets up
    return ['Red', 'Blue'];
  }),
}));
vi.mock('@/lib/bot/utils/truncate', () => ({ truncTitle: (s: string) => s }));
vi.mock('@/lib/bot/automation/rules-engine', () => ({ evaluateRules: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/bot/automation/sequence-service', () => ({ triggerSequences: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/tier-limits', () => ({ checkTierLimit: vi.fn().mockResolvedValue({ allowed: true }) }));
vi.mock('@/lib/capabilities/service', () => ({ getEnabledCapabilities: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), withContext: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() })) },
}));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: vi.fn(() => ({})) }));
vi.mock('@/lib/observability', () => ({
  observe: vi.fn((_name: string, fn: () => unknown) => fn()),
  observeProvider: vi.fn(),
  logSplitResolved: vi.fn(),
  logSplitMissing: vi.fn(),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }));
vi.mock('@/lib/trial-status', () => ({
  resolveTrialStatus: vi.fn(async () => ({ isInTrial: false, trialEndsAt: null })),
  resolveTrialCredit: vi.fn(async () => false),
}));
vi.mock('@/lib/getPlatformFees', () => ({ getPlatformFees: vi.fn(async () => ({ feePercentage: 5, isInTrial: false })) }));
vi.mock('@/lib/payments/factory', () => ({ getPaymentGateway: vi.fn(), getPaymentGatewayByName: vi.fn() }));
vi.mock('@/lib/payments/reconcile', () => ({ reconcilePayment: vi.fn(async () => ({ lifecycle: { status: 'completed' } })) }));
vi.mock('@/lib/payments/saved-card-compat', () => ({
  isSharedPlatformPaystackCompatible: vi.fn().mockResolvedValue({ compatible: true }),
  canonicalSavedCardPhone: vi.fn().mockImplementation((p: string) => {
    const withPlus = p.startsWith('+') ? p : `+${p}`;
    return /^\+[1-9]\d{7,14}$/.test(withPlus) ? withPlus : null;
  }),
}));
vi.mock('@/lib/payments/paystack-recurring', () => ({ getAuthorization: vi.fn(), createPlan: vi.fn(), createSubscription: vi.fn() }));
vi.mock('@/lib/payments/stripe-recurring', () => ({ createRecurringCheckout: vi.fn() }));
vi.mock('@/lib/payments/flutterwave-recurring', () => ({ getCardToken: vi.fn() }));
vi.mock('@/lib/payments/saved-payment-adapter', () => ({ savedPaymentAdapter: { getSavedMethods: vi.fn().mockResolvedValue([]) } }));
vi.mock('@/lib/whitelabel', () => ({ getPoweredByFooter: vi.fn(() => ''), isWhiteLabel: () => false }));
vi.mock('@/lib/utils/sanitize', () => ({ sanitizeFilterValue: (v: string) => v }));
vi.mock('@/lib/calendar/generate-links', () => ({ getCalendarLinksText: vi.fn(() => '') }));
vi.mock('@/lib/payments/stale-payment-recovery', () => ({ recoverByPaymentReference: vi.fn(async () => null) }));
vi.mock('@/lib/bot/smart-intent', () => ({ extractEntitiesOnly: vi.fn(async () => null) }));

// ── Source text for structural proofs ──

const orderingSource = readFileSync(join(process.cwd(), 'lib/bot/flows/ordering.flow.ts'), 'utf-8');
const executorSource = readFileSync(join(process.cwd(), 'lib/bot/flows/executor.ts'), 'utf-8');
const metaCloudSource = readFileSync(join(process.cwd(), 'lib/channels/meta-cloud.ts'), 'utf-8');
const uploadRouteSource = readFileSync(join(process.cwd(), 'app/api/products/upload-image/route.ts'), 'utf-8');
const convertRouteSource = readFileSync(join(process.cwd(), 'app/api/images/convert/route.ts'), 'utf-8');
const validateFileSource = readFileSync(join(process.cwd(), 'lib/security/validate-file.ts'), 'utf-8');
const sanitizeImageSource = readFileSync(join(process.cwd(), 'lib/security/sanitize-image.ts'), 'utf-8');
const productFormSource = readFileSync(join(process.cwd(), 'app/dashboard/products/components/ProductForm.tsx'), 'utf-8');
const productPageSource = readFileSync(join(process.cwd(), 'app/dashboard/products/page.tsx'), 'utf-8');

// ── Chainable mock supabase builder ──

function mockSupabaseClient(overrides?: {
  products?: unknown[];
  variants?: unknown[];
  addons?: unknown[];
}) {
  const products = overrides?.products ?? [];
  const variants = overrides?.variants ?? [];
  const addons = overrides?.addons ?? [];

  const chainable: any = {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn(),
    maybeSingle: vi.fn(),
    rpc: vi.fn().mockResolvedValue({ data: null }),
    insert: vi.fn().mockReturnThis(),
  };

  // Discriminate result by table name
  chainable.from.mockImplementation((table: string) => {
    const sub: any = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      neq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      single: vi.fn(),
      maybeSingle: vi.fn(),
    };

    if (table === 'products') {
      sub.limit.mockResolvedValue({ data: products, error: null });
      sub.single.mockResolvedValue({ data: products[0] ?? null, error: products[0] ? null : { code: 'PGRST116' } });
    } else if (table === 'product_variants') {
      sub.order.mockResolvedValue({ data: variants, error: null });
      // Also handle the case where order is not called
      sub.limit.mockResolvedValue({ data: variants, error: null });
      sub.in.mockReturnValue(sub);
      sub.eq.mockReturnValue(sub);
      sub.single.mockResolvedValue({ data: variants[0] ?? null, error: variants[0] ? null : { code: 'PGRST116' } });
    } else if (table === 'product_addons') {
      sub.limit.mockResolvedValue({ data: addons, error: null });
    } else {
      sub.limit.mockResolvedValue({ data: [], error: null });
      sub.single.mockResolvedValue({ data: null, error: { code: 'PGRST116' } });
    }

    return sub;
  });

  return chainable;
}

function makeCtx(overrides: Partial<FlowContext> = {}): FlowContext {
  return {
    supabase: mockSupabaseClient() as any,
    sender: {
      sendText: vi.fn().mockResolvedValue({ success: true }),
      sendList: vi.fn().mockResolvedValue({ success: true }),
      sendButtons: vi.fn().mockResolvedValue({ success: true }),
      sendImage: vi.fn().mockResolvedValue({ success: true }),
      sendDocument: vi.fn().mockResolvedValue({ success: true }),
    } as any,
    standalone: {} as any,
    intelligence: {} as any,
    from: '2348001234567',
    session: {
      id: 'sess-243-test',
      user_id: null,
      business_id: 'biz-243-test',
      current_step: 'browse_catalog',
      session_data: {},
      version: 1,
    },
    business: {
      id: 'biz-243-test',
      name: 'Test Shop',
      slug: 'test-shop',
      category: 'retail' as any,
      flow_type: 'ordering' as any,
      subscription_tier: 'growth',
      trial_ends_at: '',
      metadata: {},
      country_code: 'NG' as any,
    },
    t: async (text: string) => text,
    copyLang: 'en',
    ...overrides,
  } as FlowContext;
}

// ──────────────────────────────────────────────────────────────────────
// Part A: Source-text structural proofs
// ──────────────────────────────────────────────────────────────────────

describe('Part A: Structural source-text verification', () => {
  it('A1: products table query includes image_url column', () => {
    // browse_catalog selects image_url from products
    expect(orderingSource).toContain("'id, name, price, category, stock_quantity, track_inventory, low_stock_threshold, has_variants, image_url, variant_options, min_order_qty'");
  });

  it('A2: validate() stores current_product_image_url in session_data', () => {
    expect(orderingSource).toContain('current_product_image_url: product.image_url || null');
  });

  it('A3: select_option_axis prompt sends image on first axis', () => {
    // On first axis (index 0), product image is sent
    expect(orderingSource).toContain('if (axisIndex === 0 && d.current_product_image_url)');
    expect(orderingSource).toContain("type: 'image'");
    expect(orderingSource).toContain('imageUrl: d.current_product_image_url as string');
  });

  it('A4: select_variant prompt sends product image', () => {
    // select_variant sends product image when available
    expect(orderingSource).toContain('if (d.current_product_image_url)');
  });

  it('A5: variant validate() stores current_variant_image_url', () => {
    expect(orderingSource).toContain('current_variant_image_url: variant.image_url || null');
    // Also check the multi-axis path
    expect(orderingSource).toContain('d.current_variant_image_url = matchingVariant.image_url || null');
  });

  it('A6: select_quantity sends variant image with fallback to product image', () => {
    expect(orderingSource).toContain(
      'const imageUrl = (d.current_variant_image_url as string) || (d.current_product_image_url as string)'
    );
  });

  it('A7: product_variants query includes image_url column', () => {
    expect(orderingSource).toContain("'id, label, price, stock_quantity, image_url, options'");
    expect(orderingSource).toContain("'id, label, price, stock_quantity, image_url'");
  });

  it('A8: image session data is cleaned up after add_to_cart', () => {
    expect(orderingSource).toContain('delete d.current_product_image_url');
    expect(orderingSource).toContain('delete d.current_variant_image_url');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Part B: Executor image dispatch + WebP conversion
// ──────────────────────────────────────────────────────────────────────

describe('Part B: Executor image dispatch', () => {
  it('B1: executor sendSingleMessage has case image with WebP conversion', () => {
    expect(executorSource).toContain("case 'image':");
    expect(executorSource).toContain(".endsWith('.webp')");
    expect(executorSource).toContain('/api/images/convert?url=');
  });

  it('B2: executor converts WebP URLs to JPEG proxy endpoint', () => {
    // The exact pattern: if URL ends with .webp, rewrite to conversion proxy
    expect(executorSource).toContain("imageUrl.toLowerCase().endsWith('.webp')");
    expect(executorSource).toContain('encodeURIComponent(imageUrl)');
  });

  it('B3: executor calls sender.sendImage with correct interface', () => {
    // Verify sendImage is called on the sender with to, imageUrl, caption
    expect(executorSource).toContain('sendImage({ to, imageUrl, caption:');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Part C: Meta Cloud sendImage
// ──────────────────────────────────────────────────────────────────────

describe('Part C: Meta Cloud API sendImage', () => {
  it('C1: MetaCloudService has sendImage method', () => {
    expect(metaCloudSource).toContain('async sendImage(message: CloudImageMessage)');
  });

  it('C2: sendImage sends type image with link and caption', () => {
    expect(metaCloudSource).toContain("type: 'image'");
    expect(metaCloudSource).toContain('link: message.imageUrl');
    expect(metaCloudSource).toContain('caption: message.caption || undefined');
  });

  it('C3: CloudImageMessage interface defines correct shape', () => {
    expect(metaCloudSource).toContain('export interface CloudImageMessage');
    expect(metaCloudSource).toContain('imageUrl: string');
    expect(metaCloudSource).toContain('caption?: string');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Part D: Upload pipeline security
// ──────────────────────────────────────────────────────────────────────

describe('Part D: Upload pipeline security', () => {
  it('D1: upload-image route validates file type against allowed list', () => {
    expect(uploadRouteSource).toContain("'image/jpeg', 'image/jpg', 'image/png', 'image/x-png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'");
  });

  it('D2: upload-image route enforces 5MB max file size', () => {
    expect(uploadRouteSource).toContain('file.size > 5 * 1024 * 1024');
  });

  it('D3: upload-image route validates magic bytes via validateFileSignature', () => {
    expect(uploadRouteSource).toContain('validateFileSignature(buffer, file.type)');
  });

  it('D4: upload-image route sanitizes image via Sharp re-encoding', () => {
    expect(uploadRouteSource).toContain('sanitizeImage(buffer)');
  });

  it('D5: upload-image route verifies business ownership before upload', () => {
    expect(uploadRouteSource).toContain(".eq('owner_id', user.id)");
  });

  it('D6: upload-image route stores to business-scoped path', () => {
    expect(uploadRouteSource).toContain('`${businessId}/products/${Date.now()}.${cleanExt}`');
  });

  it('D7: validateFileSignature checks JPEG, PNG, WebP, GIF, HEIC magic bytes', () => {
    expect(validateFileSource).toContain("{ mime: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF] }");
    expect(validateFileSource).toContain("{ mime: 'image/png', bytes: [0x89, 0x50, 0x4E, 0x47] }");
    expect(validateFileSource).toContain("{ mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] }");
    expect(validateFileSource).toContain("{ mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] }");
    expect(validateFileSource).toContain("{ mime: 'image/heic', bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 }");
  });

  it('D8: sanitizeImage re-encodes via Sharp, strips EXIF, limits dimensions', () => {
    expect(sanitizeImageSource).toContain('sharp(Buffer.from(input))');
    expect(sanitizeImageSource).toContain('.rotate()');
    expect(sanitizeImageSource).toContain("fit: 'inside', withoutEnlargement: true");
    expect(sanitizeImageSource).toContain('maxWidth ?? 4096');
    expect(sanitizeImageSource).toContain('maxHeight ?? 4096');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Part E: WebP conversion proxy
// ──────────────────────────────────────────────────────────────────────

describe('Part E: WebP conversion proxy endpoint', () => {
  it('E1: /api/images/convert route exists and converts WebP to JPEG', () => {
    expect(convertRouteSource).toContain('sharp');
    expect(convertRouteSource).toContain('.jpeg({ quality: 85 })');
  });

  it('E2: conversion proxy only allows Supabase storage URLs', () => {
    expect(convertRouteSource).toContain('url.startsWith(supabaseUrl)');
  });

  it('E3: conversion proxy returns JPEG content type with caching', () => {
    expect(convertRouteSource).toContain("'Content-Type': 'image/jpeg'");
    expect(convertRouteSource).toContain("'Cache-Control': 'public, max-age=86400, s-maxage=86400'");
  });

  it('E4: conversion proxy is rate limited', () => {
    expect(convertRouteSource).toContain('rateLimitResponseAsync');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Part F: Dashboard product form
// ──────────────────────────────────────────────────────────────────────

describe('Part F: Dashboard product form image upload', () => {
  it('F1: ProductForm accepts image-related props', () => {
    expect(productFormSource).toContain('uploadingImage');
    expect(productFormSource).toContain('imagePreview');
    expect(productFormSource).toContain('imageInputRef');
  });

  it('F2: ProductForm file input accepts correct image formats', () => {
    expect(productFormSource).toContain('accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml,image/heic');
  });

  it('F3: ProductForm shows image preview', () => {
    expect(productFormSource).toContain('imagePreview');
    expect(productFormSource).toContain("alt=\"Product\"");
  });

  it('F4: ProductForm supports variant images', () => {
    expect(productFormSource).toContain('v.image_url');
    expect(productFormSource).toContain("alt={v.label || 'Variant image'}");
  });

  it('F5: product page uploads via /api/products/upload-image', () => {
    expect(productPageSource).toContain("fetch('/api/products/upload-image'");
    expect(productPageSource).toContain("method: 'POST'");
  });

  it('F6: product page stores image_url in product payload', () => {
    expect(productPageSource).toContain('image_url: imageUrl');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Part G: Executable step tests — prompt includes/omits images
// ──────────────────────────────────────────────────────────────────────

describe('Part G: Executable ordering step image behavior', () => {
  let orderingFlow: any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@/lib/bot/flows/ordering.flow');
    orderingFlow = mod.orderingFlow;
  });

  function getStep(id: string): FlowStepConfig {
    return orderingFlow.steps.find((s: FlowStepConfig) => s.id === id);
  }

  it('G1: select_variant prompt includes image when current_product_image_url is set', async () => {
    const supabase = mockSupabaseClient({
      variants: [
        { id: 'v1', label: 'Small', price: 500, stock_quantity: 10, image_url: null },
        { id: 'v2', label: 'Large', price: 800, stock_quantity: 5, image_url: null },
      ],
    });
    const ctx = makeCtx({
      supabase: supabase as any,
      session: {
        id: 'sess-g1',
        user_id: null,
        business_id: 'biz-243-test',
        current_step: 'select_variant',
        session_data: {
          current_product_id: 'prod-1',
          current_product_name: 'Test Product',
          current_product_has_variants: true,
          current_product_image_url: 'https://example.com/storage/prod1.jpg',
        },
        version: 1,
      },
    });

    const step = getStep('select_variant');
    const messages = await step.prompt(ctx);

    const imageMsg = messages.find((m: PromptMessage) => m.type === 'image');
    expect(imageMsg).toBeDefined();
    expect((imageMsg as any).imageUrl).toBe('https://example.com/storage/prod1.jpg');
    expect((imageMsg as any).caption).toContain('Test Product');
  });

  it('G2: select_variant prompt omits image when current_product_image_url is null', async () => {
    const supabase = mockSupabaseClient({
      variants: [
        { id: 'v1', label: 'Small', price: 500, stock_quantity: 10, image_url: null },
      ],
    });
    const ctx = makeCtx({
      supabase: supabase as any,
      session: {
        id: 'sess-g2',
        user_id: null,
        business_id: 'biz-243-test',
        current_step: 'select_variant',
        session_data: {
          current_product_id: 'prod-2',
          current_product_name: 'No Image Product',
          current_product_has_variants: true,
          current_product_image_url: null,
        },
        version: 1,
      },
    });

    const step = getStep('select_variant');
    const messages = await step.prompt(ctx);

    const imageMsg = messages.find((m: PromptMessage) => m.type === 'image');
    expect(imageMsg).toBeUndefined();
    // Should still have the list message
    const listMsg = messages.find((m: PromptMessage) => m.type === 'list');
    expect(listMsg).toBeDefined();
  });

  it('G3: select_quantity sends variant image (priority) over product image', async () => {
    const ctx = makeCtx({
      session: {
        id: 'sess-g3',
        user_id: null,
        business_id: 'biz-243-test',
        current_step: 'select_quantity',
        session_data: {
          current_product_id: 'prod-3',
          current_product_name: 'Test Product',
          current_product_price: 1000,
          current_product_image_url: 'https://example.com/storage/product.jpg',
          current_variant_image_url: 'https://example.com/storage/variant-red.jpg',
          current_variant_label: 'Red',
          cart: [],
        },
        version: 1,
      },
    });

    const step = getStep('select_quantity');
    const messages = await step.prompt(ctx);

    const imageMsg = messages.find((m: PromptMessage) => m.type === 'image');
    expect(imageMsg).toBeDefined();
    // Variant image should take priority
    expect((imageMsg as any).imageUrl).toBe('https://example.com/storage/variant-red.jpg');
  });

  it('G4: select_quantity falls back to product image when no variant image', async () => {
    const ctx = makeCtx({
      session: {
        id: 'sess-g4',
        user_id: null,
        business_id: 'biz-243-test',
        current_step: 'select_quantity',
        session_data: {
          current_product_id: 'prod-4',
          current_product_name: 'Test Product',
          current_product_price: 1000,
          current_product_image_url: 'https://example.com/storage/product.jpg',
          current_variant_image_url: null,
          cart: [],
        },
        version: 1,
      },
    });

    const step = getStep('select_quantity');
    const messages = await step.prompt(ctx);

    const imageMsg = messages.find((m: PromptMessage) => m.type === 'image');
    expect(imageMsg).toBeDefined();
    expect((imageMsg as any).imageUrl).toBe('https://example.com/storage/product.jpg');
  });

  it('G5: select_quantity omits image when neither variant nor product has image', async () => {
    const ctx = makeCtx({
      session: {
        id: 'sess-g5',
        user_id: null,
        business_id: 'biz-243-test',
        current_step: 'select_quantity',
        session_data: {
          current_product_id: 'prod-5',
          current_product_name: 'Test Product',
          current_product_price: 1000,
          current_product_image_url: null,
          current_variant_image_url: null,
          cart: [],
        },
        version: 1,
      },
    });

    const step = getStep('select_quantity');
    const messages = await step.prompt(ctx);

    const imageMsg = messages.find((m: PromptMessage) => m.type === 'image');
    expect(imageMsg).toBeUndefined();
  });

  it('G6: browse_catalog validate stores image_url in session data', async () => {
    const testProduct = {
      id: 'prod-6',
      name: 'Image Test Product',
      price: 2500,
      stock_quantity: 10,
      has_variants: false,
      image_url: 'https://example.com/storage/test.jpg',
      variant_options: [],
      min_order_qty: 1,
    };
    const supabase = mockSupabaseClient({ products: [testProduct] });
    const ctx = makeCtx({
      supabase: supabase as any,
      session: {
        id: 'sess-g6',
        user_id: null,
        business_id: 'biz-243-test',
        current_step: 'browse_catalog',
        session_data: {},
        version: 1,
      },
    });

    const step = getStep('browse_catalog');
    const result = await step.validate('prod-6', ctx);

    expect(result.valid).toBe(true);
    expect(result.data?.current_product_image_url).toBe('https://example.com/storage/test.jpg');
  });

  it('G7: browse_catalog validate stores null for products without image', async () => {
    const testProduct = {
      id: 'prod-7',
      name: 'No Image Product',
      price: 1000,
      stock_quantity: 5,
      has_variants: false,
      image_url: null,
      variant_options: [],
      min_order_qty: 1,
    };
    const supabase = mockSupabaseClient({ products: [testProduct] });
    const ctx = makeCtx({
      supabase: supabase as any,
      session: {
        id: 'sess-g7',
        user_id: null,
        business_id: 'biz-243-test',
        current_step: 'browse_catalog',
        session_data: {},
        version: 1,
      },
    });

    const step = getStep('browse_catalog');
    const result = await step.validate('prod-7', ctx);

    expect(result.valid).toBe(true);
    expect(result.data?.current_product_image_url).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Part H: Executor WebP conversion unit test
// ──────────────────────────────────────────────────────────────────────

describe('Part H: Executor WebP conversion logic', () => {
  it('H1: WebP URL detection is case-insensitive (.WEBP, .Webp)', () => {
    // The executor uses imageUrl.toLowerCase().endsWith('.webp')
    expect(executorSource).toContain("imageUrl.toLowerCase().endsWith('.webp')");
    // This ensures both .webp and .WEBP are caught
  });

  it('H2: non-WebP URLs are sent directly without proxy', () => {
    // The executor only rewrites the URL when .webp is detected
    // Otherwise it passes through directly
    const imageCase = executorSource.match(/case 'image':\s*\{[\s\S]*?break;\s*\}/);
    expect(imageCase).not.toBeNull();
    const caseBlock = imageCase![0];
    // The imageUrl variable starts as the message's imageUrl and is only modified in the .webp branch
    expect(caseBlock).toContain('let imageUrl =');
    expect(caseBlock).toContain("if (imageUrl.toLowerCase().endsWith('.webp'))");
  });

  it('H3: conversion proxy URL includes encoded original URL', () => {
    expect(executorSource).toContain('encodeURIComponent(imageUrl)');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Part I: validateFileSignature unit tests
// ──────────────────────────────────────────────────────────────────────

describe('Part I: validateFileSignature correctness', () => {
  let validateFileSignature: (buffer: Buffer | Uint8Array, claimedMime: string) => string | null;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@/lib/security/validate-file');
    validateFileSignature = mod.validateFileSignature;
  });

  it('I1: detects valid JPEG (FF D8 FF)', () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
    expect(validateFileSignature(buf, 'image/jpeg')).toBe('image/jpeg');
  });

  it('I2: detects valid PNG (89 50 4E 47)', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
    expect(validateFileSignature(buf, 'image/png')).toBe('image/png');
  });

  it('I3: rejects JPEG magic bytes with PNG claimed mime', () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
    expect(validateFileSignature(buf, 'image/png')).toBeNull();
  });

  it('I4: rejects buffer too small to validate', () => {
    const buf = Buffer.from([0xFF, 0xD8]);
    expect(validateFileSignature(buf, 'image/jpeg')).toBeNull();
  });

  it('I5: accepts image/jpg alias for JPEG', () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
    expect(validateFileSignature(buf, 'image/jpg')).toBe('image/jpeg');
  });

  it('I6: detects valid WebP (RIFF)', () => {
    // RIFF header: 52 49 46 46 [size] 57 45 42 50
    const buf = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
    expect(validateFileSignature(buf, 'image/webp')).toBe('image/webp');
  });

  it('I7: detects valid GIF (GIF8)', () => {
    const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00]);
    expect(validateFileSignature(buf, 'image/gif')).toBe('image/gif');
  });
});
