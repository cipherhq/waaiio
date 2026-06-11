export interface OptionGroup {
  name: string;
  values: string[];
}

export interface ProductVariant {
  id?: string;
  label: string;
  price: number;
  stock_quantity: number | null;
  sku: string;
  is_active: boolean;
  sort_order: number;
  image_url?: string | null;
  options?: Record<string, string>;
}

export interface ProductAddon {
  id?: string;
  product_id: string | null;
  name: string;
  description: string | null;
  price: number;
  price_type: 'fixed' | 'per_unit' | 'quote';
  unit_label: string | null;
  min_quantity: number | null;
  max_quantity: number | null;
  is_required: boolean;
  is_negotiable: boolean;
  is_active: boolean;
  sort_order: number;
}

export const EMPTY_ADDON: Omit<ProductAddon, 'sort_order'> = {
  product_id: null,
  name: '',
  description: null,
  price: 0,
  price_type: 'fixed',
  unit_label: null,
  min_quantity: null,
  max_quantity: null,
  is_required: false,
  is_negotiable: false,
  is_active: true,
};

export interface VolumeDiscountRule {
  id?: string;
  product_id: string | null;
  name: string;
  min_quantity: number;
  max_quantity: number | null;
  discount_type: 'percentage' | 'fixed_per_unit' | 'fixed_total';
  discount_value: number;
  is_active: boolean;
  sort_order: number;
}

export const EMPTY_DISCOUNT: Omit<VolumeDiscountRule, 'sort_order'> = {
  product_id: null,
  name: '',
  min_quantity: 10,
  max_quantity: null,
  discount_type: 'percentage',
  discount_value: 0,
  is_active: true,
};

export interface Product {
  id: string;
  name: string;
  description: string | null;
  price: number;
  image_url: string | null;
  category: string | null;
  stock_quantity: number | null;
  is_active: boolean;
  sort_order: number;
  track_inventory: boolean;
  low_stock_threshold: number;
  refundable: boolean;
  allow_promo: boolean;
  has_variants: boolean;
  shipping_cost: number | null;
  min_order_qty: number;
  variant_options?: OptionGroup[];
  catalog_synced_at?: string | null;
}

export interface CatalogSyncLog {
  id: string;
  catalog_id: string;
  synced_count: number;
  failed_count: number;
  error_message: string | null;
  status: 'pending' | 'success' | 'partial' | 'failed';
  created_at: string;
}

export const EMPTY_PRODUCT: Omit<Product, 'id'> = {
  name: '',
  description: null,
  price: 0,
  image_url: null,
  category: null,
  stock_quantity: null,
  is_active: true,
  sort_order: 0,
  track_inventory: false,
  low_stock_threshold: 5,
  refundable: false,
  allow_promo: false,
  has_variants: false,
  shipping_cost: null,
  min_order_qty: 1,
  variant_options: [],
};

export const EMPTY_VARIANT: ProductVariant = {
  label: '',
  price: 0,
  stock_quantity: null,
  sku: '',
  is_active: true,
  sort_order: 0,
  image_url: null,
  options: {},
};

export type ViewMode = 'list' | 'add' | 'edit' | 'bulk';

// ── Helpers ──

export function generateCombinations(groups: OptionGroup[]): Record<string, string>[] {
  const validGroups = groups.filter(g => g.name.trim() && g.values.length > 0);
  if (validGroups.length === 0) return [];
  return validGroups.reduce<Record<string, string>[]>(
    (combos, group) => {
      if (combos.length === 0) return group.values.map(v => ({ [group.name]: v }));
      const result: Record<string, string>[] = [];
      for (const combo of combos) {
        for (const value of group.values) {
          result.push({ ...combo, [group.name]: value });
        }
      }
      return result;
    }, []
  );
}

export function optionsKey(options: Record<string, string>): string {
  return Object.entries(options).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}:${v}`).join('|');
}

export function labelFromOptions(options: Record<string, string>): string {
  return Object.values(options).join(' / ');
}

// ── CSV helpers ──
export function parseCSV(text: string): Record<string, string>[] {
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/[^a-z_]/g, ''));
  return lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i] || ''; });
    return row;
  });
}

export function mapCSVRow(row: Record<string, string>) {
  return {
    name: (row.name || row.product || row.item || '').trim(),
    price: parseFloat(row.price || row.amount || '0') || 0,
    description: (row.description || row.desc || '').trim() || undefined,
    category: (row.category || row.type || '').trim() || undefined,
    stock_quantity: (row.stock || row.quantity || row.qty) ? parseInt(row.stock || row.quantity || row.qty) : undefined,
  };
}
