/**
 * Paystack split parameters — who pays Paystack's fee (Owner decision 2026-11-08).
 *
 * Rule: the merchant pays every payment-gateway fee; Waaiio absorbs none.
 *
 * Paystack docs (Split Payments → "Bearer of transaction fee"): by default the
 * Paystack charges are borne by the MAIN account; pass `bearer: "subaccount"`
 * to move them to the subaccount. `transaction_charge` is the flat amount that
 * goes to the main account.
 *
 * Two shapes exist:
 *  - Merchant split on Waaiio's Paystack account: Waaiio is the main account,
 *    the merchant is the subaccount. `transaction_charge` = Waaiio fee, so the
 *    subaccount (merchant) must bear the fee → `bearer: 'subaccount'`.
 *  - Bring-your-own (reversed) split on the merchant's Paystack account: the
 *    merchant is the main account, Waaiio is the subaccount.
 *    `transaction_charge` = what the merchant keeps, so the main account
 *    (merchant) must bear the fee → `bearer: 'account'` (stated explicitly,
 *    never left to the provider default).
 *
 * Amounts are in kobo/pesewas (smallest currency unit).
 */

export type PaystackSplitParams = {
  subaccount: string;
  transaction_charge?: number;
  bearer: 'subaccount' | 'account';
};

/** Merchant subaccount on Waaiio's account; Waaiio keeps exactly its fee. */
export function paystackMerchantSplit(
  merchantSubaccount: string,
  waaiioFeeKobo: number | undefined,
): PaystackSplitParams {
  return {
    subaccount: merchantSubaccount,
    ...(waaiioFeeKobo !== undefined && { transaction_charge: waaiioFeeKobo }),
    bearer: 'subaccount',
  };
}

/** Waaiio subaccount on the merchant's own account; the merchant keeps the rest. */
export function paystackByoSplit(
  waaiioSubaccount: string,
  merchantKeepsKobo: number,
): PaystackSplitParams {
  return {
    subaccount: waaiioSubaccount,
    transaction_charge: merchantKeepsKobo,
    bearer: 'account',
  };
}
