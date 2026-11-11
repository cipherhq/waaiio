/** Merchant-approved negotiated prices, persisted independently of later catalog edits. */
export interface QuotedItem {
  id: string; description: string; quantity: number; unit_price: number;
  product_id?: string; service_id?: string; parent_id?: string; kind?: 'delivery';
}
export function initialQuotedItems(quote: {
  cart_snapshot?: Array<{ product_id?: string; name: string; quantity: number; price: number;
    addons?: Array<{ name: string; price: number; quantity?: number }> }>;
  service_id?: string | null; delivery_address?: string | null;
}): QuotedItem[] {
  const lines: QuotedItem[] = [];
  for (const [index, item] of (quote.cart_snapshot || []).entries()) {
    const id = `item-${index}`;
    lines.push({ id, description: item.name, quantity: item.quantity, unit_price: item.price,
      ...(item.product_id ? { product_id: item.product_id } : {}) });
    for (const [addonIndex, addon] of (item.addons || []).entries()) {
      lines.push({ id: `${id}-addon-${addonIndex}`, parent_id: id, description: addon.name,
        quantity: addon.quantity || 1, unit_price: addon.price });
    }
  }
  if (!lines.length) lines.push({ id: 'custom-0', description: 'Custom work', quantity: 1, unit_price: 0,
    ...(quote.service_id ? { service_id: quote.service_id } : {}) });
  if (quote.delivery_address) lines.push({ id: 'delivery', kind: 'delivery', description: 'Delivery', quantity: 1, unit_price: 0 });
  return lines;
}
