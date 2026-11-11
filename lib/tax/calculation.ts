/** Merchant-entered tax calculation. All money is integer currency minor units. */
export type PriceMode = 'inclusive' | 'exclusive';
export type TaxTreatment = 'inherit' | 'override' | 'exempt';
export interface TaxRule { label: string; rateBps: number; priceMode: PriceMode }
export interface MerchantTaxConfig extends TaxRule { enabled: boolean }
export interface TaxOverride { treatment: TaxTreatment; rule?: TaxRule }
export interface TaxInputLine {
  id: string; description: string; quantity: number; unitAmount: number;
  tax?: TaxOverride;
  /** Delivery or other separately configured lines can be excluded from merchandise discounts. */
  discountEligible?: boolean;
}
export interface TaxLineSnapshot {
  id: string; description: string; quantity: number; unitAmount: number;
  treatment: 'taxable' | 'zero_rated' | 'exempt' | 'disabled';
  label: string; rateBps: number; priceMode: PriceMode;
  discountAmount: number; netAmount: number; taxAmount: number; grossAmount: number;
}
export interface TaxSnapshot {
  version: 1; currency: string; lines: TaxLineSnapshot[];
  discountAmount: number; netAmount: number; taxAmount: number; grossAmount: number;
  percentageFeeBase: number;
}
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
function integer(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${field}`);
  return value;
}
function checked(value: bigint): number {
  if (value < BigInt(0) || value > MAX) throw new Error('Tax amount exceeds safe integer range');
  return Number(value);
}
function rounded(n: bigint, d: bigint): number {
  if (d <= BigInt(0)) throw new Error('Invalid tax divisor');
  return checked((n * BigInt(2) + d) / (BigInt(2) * d));
}
function sum(values: number[]): number { return checked(values.reduce((a, n) => a + BigInt(n), BigInt(0))); }
export function validateTaxRule(rule: TaxRule): void {
  if (!rule || typeof rule.label !== 'string' || !rule.label.trim() || rule.label.length > 60) throw new Error('Invalid tax label');
  integer(rule.rateBps, 'tax rate');
  if (rule.rateBps > 10000) throw new Error('Tax rate must be between 0 and 100 percent');
  if (rule.priceMode !== 'inclusive' && rule.priceMode !== 'exclusive') throw new Error('Invalid tax price mode');
}
/** Largest remainder allocation with input-order tie breaking, preserving the exact total. */
export function allocateMinorUnits(total: number, weights: number[]): number[] {
  integer(total, 'allocation total'); weights.forEach(w => integer(w, 'allocation weight'));
  const denominator = BigInt(sum(weights));
  if (!denominator) {
    if (total) throw new Error('Cannot allocate against zero value');
    return weights.map(() => 0);
  }
  const numerators = weights.map(w => BigInt(total) * BigInt(w));
  const result = numerators.map(n => checked(n / denominator));
  const order = numerators.map((n, index) => ({ index, remainder: n % denominator }))
    .sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  const remaining = total - sum(result);
  for (let i = 0; i < remaining; i++) result[order[i].index]++;
  return result;
}
export function calculateTaxQuote(config: MerchantTaxConfig, currency: string, inputs: TaxInputLine[], discountAmount = 0): TaxSnapshot {
  if (!config || typeof config.enabled !== 'boolean') throw new Error('Invalid merchant tax configuration');
  validateTaxRule(config);
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Invalid tax currency');
  if (!inputs.length || inputs.length > 200) throw new Error('Tax quote requires 1–200 lines');
  integer(discountAmount, 'discount');
  const seen = new Set<string>();
  const amounts = inputs.map(line => {
    if (!line.id || seen.has(line.id)) throw new Error('Duplicate or missing tax line identifier');
    seen.add(line.id);
    if (typeof line.description !== 'string' || !line.description.trim() || line.description.length > 500) throw new Error('Invalid tax line description');
    integer(line.quantity, 'quantity'); integer(line.unitAmount, 'unit amount');
    if (!line.quantity) throw new Error('Quantity must be positive');
    return checked(BigInt(line.quantity) * BigInt(line.unitAmount));
  });
  const weights = amounts.map((a, i) => inputs[i].discountEligible === false ? 0 : a);
  if (discountAmount > sum(weights)) throw new Error('Discount exceeds eligible line value');
  const discounts = allocateMinorUnits(discountAmount, weights);
  const lines = inputs.map((line, i): TaxLineSnapshot => {
    const override = line.tax ?? { treatment: 'inherit' as const };
    if (!['inherit', 'override', 'exempt'].includes(override.treatment)) throw new Error('Invalid tax treatment');
    if (override.treatment === 'override' && !override.rule) throw new Error('Tax override requires a rule');
    if (override.treatment !== 'override' && override.rule) throw new Error('Unexpected tax override rule');
    const rule = override.treatment === 'override' ? override.rule! : config;
    validateTaxRule(rule);
    const treatment = !config.enabled ? 'disabled' : override.treatment === 'exempt' ? 'exempt' : rule.rateBps === 0 ? 'zero_rated' : 'taxable';
    const rateBps = treatment === 'taxable' ? rule.rateBps : 0;
    const discounted = amounts[i] - discounts[i];
    const netAmount = rule.priceMode === 'inclusive' && rateBps
      ? rounded(BigInt(discounted) * BigInt(10000), BigInt(10000 + rateBps)) : discounted;
    const taxAmount = rule.priceMode === 'inclusive' ? discounted - netAmount
      : rounded(BigInt(netAmount) * BigInt(rateBps), BigInt(10000));
    return { id: line.id, description: line.description, quantity: line.quantity, unitAmount: line.unitAmount,
      treatment, label: rule.label.trim(), rateBps, priceMode: rule.priceMode,
      discountAmount: discounts[i], netAmount, taxAmount, grossAmount: sum([netAmount, taxAmount]) };
  });
  const netAmount = sum(lines.map(l => l.netAmount));
  const taxAmount = sum(lines.map(l => l.taxAmount));
  return { version: 1, currency, lines, discountAmount, netAmount, taxAmount,
    grossAmount: sum([netAmount, taxAmount]), percentageFeeBase: netAmount };
}
/** Cumulative allocation reconciles the final payment exactly, even after many small deposits. */
export function allocateTaxPayment(snapshot: TaxSnapshot, amount: number, alreadyPaid: number) {
  validateTaxSnapshot(snapshot);
  integer(amount, 'payment amount'); integer(alreadyPaid, 'already paid');
  const next = sum([alreadyPaid, amount]);
  if (next > snapshot.grossAmount) throw new Error('Payment exceeds quoted gross amount');
  if (!snapshot.grossAmount) return { netAmount: 0, taxAmount: 0, grossAmount: 0 };
  const cumulativeTax = (paid: number) => rounded(BigInt(paid) * BigInt(snapshot.taxAmount), BigInt(snapshot.grossAmount));
  const taxAmount = cumulativeTax(next) - cumulativeTax(alreadyPaid);
  return { netAmount: amount - taxAmount, taxAmount, grossAmount: amount };
}
/** Full-line quantity refunds use original allocations; cumulative limits prevent rounding drift. */
export function calculateTaxRefund(snapshot: TaxSnapshot, returned: Record<string, number>, previouslyReturned: Record<string, number> = {}) {
  validateTaxSnapshot(snapshot);
  const ids = new Set(snapshot.lines.map(l => l.id));
  for (const id of [...Object.keys(returned), ...Object.keys(previouslyReturned)]) if (!ids.has(id)) throw new Error('Unknown refund line');
  const lines = snapshot.lines.map(line => {
    const previous = integer(previouslyReturned[line.id] ?? 0, 'previously returned quantity');
    const quantity = integer(returned[line.id] ?? 0, 'returned quantity');
    if (previous + quantity > line.quantity) throw new Error('Refund quantity exceeds purchased quantity');
    const portion = (amount: number, count: number) => rounded(BigInt(amount) * BigInt(count), BigInt(line.quantity));
    const previousGross = portion(line.grossAmount, previous);
    const nextGross = portion(line.grossAmount, previous + quantity);
    const grossAmount = nextGross - previousGross;
    const taxAt = (gross: number) => line.grossAmount
      ? rounded(BigInt(gross) * BigInt(line.taxAmount), BigInt(line.grossAmount)) : 0;
    const taxAmount = taxAt(nextGross) - taxAt(previousGross);
    return { id: line.id, quantity, grossAmount, taxAmount, netAmount: grossAmount - taxAmount };
  }).filter(line => line.quantity > 0);
  if (!lines.length) throw new Error('Select at least one item to refund');
  return { lines, grossAmount: sum(lines.map(l => l.grossAmount)), taxAmount: sum(lines.map(l => l.taxAmount)), netAmount: sum(lines.map(l => l.netAmount)) };
}

/** Validate persisted data before allocating money. TypeScript types are not a trust boundary. */
export function validateTaxSnapshot(snapshot: TaxSnapshot): void {
  if (!snapshot || snapshot.version !== 1 || !/^[A-Z]{3}$/.test(snapshot.currency)
    || !Array.isArray(snapshot.lines) || !snapshot.lines.length || snapshot.lines.length > 200) throw new Error('Invalid tax snapshot');
  const seen = new Set<string>();
  for (const l of snapshot.lines) {
    if (!l || typeof l.id !== 'string' || !l.id || seen.has(l.id)) throw new Error('Invalid snapshot line');
    seen.add(l.id);
    if (typeof l.description !== 'string' || !l.description.trim() || l.description.length > 500) throw new Error('Invalid snapshot description');
    validateTaxRule(l);
    for (const n of [l.quantity, l.unitAmount, l.discountAmount, l.netAmount, l.taxAmount, l.grossAmount]) integer(n, 'snapshot amount');
    if (!l.quantity || !['taxable', 'zero_rated', 'exempt', 'disabled'].includes(l.treatment)) throw new Error('Invalid snapshot treatment');
    if (l.grossAmount !== sum([l.netAmount, l.taxAmount])) throw new Error('Snapshot line does not reconcile');
    const quoted = checked(BigInt(l.unitAmount) * BigInt(l.quantity));
    if (l.discountAmount > quoted) throw new Error('Invalid snapshot discount');
    const discounted = quoted - l.discountAmount;
    if (l.treatment !== 'taxable' && (l.rateBps !== 0 || l.taxAmount !== 0)) throw new Error('Untaxed snapshot carries tax');
    if (l.treatment === 'taxable' && l.rateBps === 0) throw new Error('Taxable snapshot has zero rate');
    const net = l.priceMode === 'inclusive' ? rounded(BigInt(discounted) * BigInt(10000), BigInt(10000 + l.rateBps)) : discounted;
    const tax = l.priceMode === 'inclusive' ? discounted - net : rounded(BigInt(net) * BigInt(l.rateBps), BigInt(10000));
    if (net !== l.netAmount || tax !== l.taxAmount) throw new Error('Snapshot tax calculation does not reconcile');
  }
  for (const key of ['discountAmount', 'netAmount', 'taxAmount', 'grossAmount'] as const) {
    integer(snapshot[key], 'snapshot total');
    if (snapshot[key] !== sum(snapshot.lines.map(l => l[key]))) throw new Error('Snapshot totals do not reconcile');
  }
  if (snapshot.percentageFeeBase !== snapshot.netAmount) throw new Error('Invalid pre-tax percentage fee base');
}
