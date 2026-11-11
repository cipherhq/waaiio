import { parseTaxRefundSelection } from './refund-selection';
export interface RefundLineChoice { id: string; label: string; remainingMinor: number; zeroValue?: boolean; quantity?: number }
interface RefundReadQuery extends PromiseLike<{data:any;error:unknown}> {
  eq(column:string,value:unknown):RefundReadQuery;
  neq(column:string,value:unknown):RefundReadQuery;
  single():PromiseLike<{data:any;error:unknown}>;
}
interface RefundReadClient {from(table:string):{select(columns:string):RefundReadQuery}}
/** Display data only: the SQL authority repeats all money/hold checks at submit. */
export async function loadTaxRefundLines(db: RefundReadClient,paymentId:string,businessId:string):Promise<RefundLineChoice[]|null> {
  const {data:payment,error}=await db.from('payments').select('tax_allocation,order_id,booking_id,invoice_id')
    .eq('id',paymentId).eq('business_id',businessId).single();
  if(error||!payment) throw new Error('Payment details unavailable');
  if(!payment.tax_allocation) return null;
  const table=payment.order_id?'orders':payment.booking_id?'bookings':'invoices';
  const {data:sale,error:saleError}=await db.from(table).select('tax_snapshot')
    .eq('id',payment.order_id||payment.booking_id||payment.invoice_id).eq('business_id',businessId).single();
  const {data:refunds,error:refundError}=await db.from('refunds').select('tax_allocation')
    .eq('payment_id',paymentId).eq('business_id',businessId).neq('status','failed');
  if(saleError||refundError||!sale?.tax_snapshot||!Array.isArray(refunds)) throw new Error('Refund details unavailable');
  return payment.tax_allocation.lines.map((line:{id:string;grossAmount:number},index:number)=>{
    const used=refunds.reduce((sum:number,refund:{tax_allocation:any})=>{
      if(!refund.tax_allocation) throw new Error('Refund allocation unavailable');
      return sum+Number(refund.tax_allocation.lines.find((r:{id:string})=>r.id===line.id)?.grossAmount||0);
    },0);
    const remainingMinor=line.grossAmount-used;
    if(!Number.isSafeInteger(remainingMinor)||remainingMinor<0) throw new Error('Refund balance unavailable');
    const original=sale.tax_snapshot.lines.find((item:{id:string})=>item.id===line.id);
    return {id:line.id,label:original?.description||`Item ${index+1}`,remainingMinor,zeroValue:original?.grossAmount===0,quantity:original?.quantity};
  });
}
export function refundLineSelection(lines:RefundLineChoice[],values:Record<string,string>) {
  const selected=lines.flatMap(line=>{
    const text=values[line.id]?.trim(); if(!text) return [];
    if(!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error('Use amounts with at most two decimal places');
    const grossAmount=Math.round(Number(text)*100);
    if(!Number.isSafeInteger(grossAmount)||grossAmount<0||grossAmount>line.remainingMinor) throw new Error('Refund exceeds an item’s available amount');
    return grossAmount>0?[{id:line.id,grossAmount}]:[];
  });
  const selection=parseTaxRefundSelection({mode:'lines',lines:selected})!;
  return {taxSelection:selection,amount:selected.reduce((sum,line)=>sum+line.grossAmount,0)/100};
}

export function zeroValueReturnSelection(lines:RefundLineChoice[],values:Record<string,string>){
 const items=lines.filter(line=>line.zeroValue).flatMap(line=>{
  const text=values[line.id]?.trim();if(!text)return [];
  const quantity=Number(text);
  if(!/^\d+$/.test(text)||!Number.isSafeInteger(quantity)||quantity<0||quantity>(line.quantity||0))throw new Error('Enter a valid item quantity');
  return quantity>0?[{id:line.id,quantity}]:[];
 });
 return {taxSelection:parseTaxRefundSelection({mode:'items',items})!,amount:0};
}
