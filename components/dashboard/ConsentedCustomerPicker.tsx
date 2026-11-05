'use client';
import { useEffect, useState } from 'react';

type Customer = { phone: string; name: string | null };
export function ConsentedCustomerPicker({ businessId, onSelect }: { businessId: string; onSelect: (customer: Customer) => void }) {
  const [query, setQuery] = useState('');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [status, setStatus] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setCustomers([]);
    if (query.trim().length < 2) { setStatus('Type at least two characters to find an opted-in customer.'); return; }
    setStatus('Searching…');
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/merchant-recipients?businessId=${encodeURIComponent(businessId)}&q=${encodeURIComponent(query)}`, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load customers');
        if (controller.signal.aborted) return;
        setCustomers(data.customers || []);
        setStatus(data.customers?.length ? '' : 'No opted-in customers found.');
      } catch (error) { if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : 'Could not load customers'); }
    }, 250);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [businessId, query]);
  return <div>
    <label className="block text-sm font-medium">Select opted-in customer
      <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search name or phone" className="mt-1 w-full rounded-lg border p-2" />
    </label>
    {status && <p role="status" className="mt-1 text-xs text-gray-500">{status}</p>}
    {customers.map(customer => <button type="button" key={customer.phone} className="block w-full p-2 text-left text-sm hover:bg-gray-50" onClick={() => { onSelect(customer); setQuery(''); setCustomers([]); }}>{customer.name || 'Customer'} · {customer.phone}</button>)}
  </div>;
}
