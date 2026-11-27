import { useEffect, useRef, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { SortableTh } from '@/components/SortableTh';
import { sortTime, useTableSort } from '@/lib/tableSort';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { StepUpDialog } from '@/components/StepUpDialog';
import { useAdminSession } from '@/components/AdminLayout';
import { useStepUp } from '@/hooks/useStepUp';
import { adminApiFetch, adminApiGet } from '@/lib/adminApi';
import { maskPhone } from '@/lib/formatters';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDate, fmtDateTime, fmtRelative, fmtCurrency } from '@/lib/formatters';
import { Users, UserCheck, CreditCard, Building2, Search, Ban } from 'lucide-react';

interface Customer {
  id: string; // generated key (user_id or phone)
  user_id: string | null;
  name: string;
  email: string;
  phone: string;
  /** Raw guest phone as stored on bookings, for the detail lookup. */
  guest_phone: string | null;
  /** E.164 digits used for platform suspension (#1103); null when unknown. */
  canonical_phone: string | null;
  businesses: { id: string; name: string }[];
  booking_count: number;
  payment_count: number;
  spending: Record<string, number>; // currency → amount of successful payments
  first_seen: string;
  last_active: string;
}

interface Transaction {
  id: string;
  type: 'booking' | 'payment' | 'order';
  business_name: string;
  service_name: string | null;
  status: string;
  amount: number;
  currency: string;
  date: string;
  reference: string | null;
}

interface Suspension {
  phone: string;
  reason: string;
  suspended_at: string;
}

/** A blocked email (#1166), with the number it was blocked with, if any. */
interface EmailBlock {
  email: string;
  phone: string | null;
  reason: string;
  blocked_at: string;
}

type CandidateSource = 'proved' | 'account' | 'web' | 'dashboard' | 'api' | 'unrecorded' | 'added';

interface EmailCandidate {
  email: string;
  source: CandidateSource;
  last_seen: string | null;
  blocked: boolean;
}

/** Owner wording (#1166 r7). */
const SOURCE_LABEL: Record<CandidateSource, string> = {
  account: 'Account',
  proved: 'Proved with a code',
  web: 'Website',
  dashboard: 'Booking added by the business',
  api: 'Booking from the business\u2019s booking system',
  unrecorded: 'Booking (source not recorded)',
  added: 'Added by you',
};

/**
 * The block / unblock dialog. `phone` is the customer's canonical number, or
 * null for an email-only change. `phoneBlocked` means the number is already
 * blocked, so a block only adds emails.
 */
interface BlockTarget {
  block: boolean;
  phone: string | null;
  phoneBlocked: boolean;
  label: string;
  userId: string | null;
  /** "Block an email" from the list: no candidate list, the add field only. */
  addOnly: boolean;
}

const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Same key as the server: trimmed and lower-cased. */
const emailKey = (value: string) => value.trim().toLowerCase();
const emailCount = (n: number) => `${n} email${n === 1 ? '' : 's'}`;

const COUNTRY_TO_CURRENCY: Record<string, string> = { US: 'USD', CA: 'CAD', GB: 'GBP', NG: 'NGN', GH: 'GHS', IN: 'INR' };
const currencyFor = (country: string | null | undefined) => COUNTRY_TO_CURRENCY[country || 'NG'] || 'NGN';

export default function Customers() {
  const adminSession = useAdminSession();
  const isFullAdmin = adminSession?.role === 'admin';

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [businessFilter, setBusinessFilter] = useState('all');
  const [page, setPage] = useState(1);
  const perPage = 20;

  // Detail state
  const [selected, setSelected] = useState<Customer | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loadingTx, setLoadingTx] = useState(false);
  const [txError, setTxError] = useState('');

  // All businesses for filter dropdown
  const [allBusinesses, setAllBusinesses] = useState<{ id: string; name: string }[]>([]);

  // Platform-wide suspension (#1103)
  const [suspensions, setSuspensions] = useState<Map<string, Suspension>>(new Map());
  const [suspensionError, setSuspensionError] = useState('');
  const [emailBlocks, setEmailBlocks] = useState<EmailBlock[]>([]);
  const [suspendTarget, setSuspendTarget] = useState<BlockTarget | null>(null);
  const [candidates, setCandidates] = useState<EmailCandidate[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [candidatesError, setCandidatesError] = useState('');
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [addEmail, setAddEmail] = useState('');
  const [addError, setAddError] = useState('');
  // Each dialog open gets a number; a candidate response for an earlier open is ignored.
  const candidatesRequestRef = useRef(0);
  const [suspendReason, setSuspendReason] = useState('');
  const [suspendSaving, setSuspendSaving] = useState(false);
  const [suspendMessage, setSuspendMessage] = useState('');
  const stepUp = useStepUp();
  const stepUpCallbackRef = useRef<((stepUpId: string) => Promise<void>) | null>(null);
  const stepUpFlightRef = useRef(false);

  const loadingRef = useRef(false);

  async function loadSuspensions() {
    try {
      const res = await adminApiGet('/api/admin/customers/suspension');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Unable to load suspended customers');
      setSuspensions(new Map((data.suspensions as Suspension[]).map(s => [s.phone, s])));
      setEmailBlocks((data.emailBlocks as EmailBlock[] | undefined) ?? []);
      setSuspensionError('');
    } catch (err) {
      setSuspensionError(err instanceof Error ? err.message : 'Unable to load suspended customers');
    }
  }

  async function loadData() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setLoadError('');

    try {
      // Fetch all data via admin API (uses service key server-side, bypasses RLS)
      const apiUrl = import.meta.env.VITE_API_URL || '';
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;

      const res = await fetch(`${apiUrl}/api/admin/customers`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!res.ok) throw new Error('Failed to load customer data');
      const apiData = await res.json();

      const bookings = apiData.bookings || [];
      const payments = apiData.payments || [];
      const bizData = apiData.businesses || [];
      const profileData = apiData.profiles || [];

      const bizMap = new Map<string, string>(bizData.map((b: { id: string; name: string }) => [b.id, b.name]));
      setAllBusinesses(
        bizData.map((b: { id: string; name: string }) => ({ id: b.id, name: b.name })).sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))
      );
      const profileMap = new Map<string, { name: string; email: string; phone: string; canonical_phone: string | null }>(
        (profileData || []).map((p: { id: string; first_name?: string; last_name?: string; email?: string; phone?: string; canonical_phone?: string | null }) => [p.id, {
          name: [p.first_name, p.last_name].filter(Boolean).join(' ') || '',
          email: p.email || '',
          phone: p.phone || '',
          canonical_phone: p.canonical_phone ?? null,
        }])
      );

      // Group by customer (user_id or guest phone)
      const customerMap = new Map<string, Omit<Customer, 'id' | 'businesses'> & { businesses: Map<string, string> }>();

      function getOrCreate(key: string, userId: string | null, name: string, email: string, phone: string) {
        if (!customerMap.has(key)) {
          customerMap.set(key, {
            user_id: userId,
            name,
            email,
            phone,
            guest_phone: null,
            canonical_phone: null,
            businesses: new Map(),
            booking_count: 0,
            payment_count: 0,
            spending: {},
            first_seen: new Date().toISOString(),
            last_active: new Date(0).toISOString(),
          });
        }
        const entry = customerMap.get(key)!;
        // Update name/email/phone if we have better data
        if (!entry.name && name) entry.name = name;
        if (!entry.email && email) entry.email = email;
        if (!entry.phone && phone) entry.phone = phone;
        return entry;
      }

      function touch(entry: { first_seen: string; last_active: string }, at: string) {
        if (at < entry.first_seen) entry.first_seen = at;
        if (at > entry.last_active) entry.last_active = at;
      }

      // Process bookings. Money is counted from successful payments only, so a
      // booking adds to the count, never to "spent".
      const bookingKey = new Map<string, string>();
      for (const b of bookings) {
        const userId = b.user_id;
        const profile = userId ? profileMap.get(userId) : null;

        const key = userId || b.canonical_phone || b.guest_phone || `anon-${b.id}`;
        if (b.id) bookingKey.set(b.id, key);
        const name = profile?.name || b.guest_name || '';
        const email = profile?.email || b.guest_email || '';
        const phone = profile?.phone || b.guest_phone || '';

        const entry = getOrCreate(key, userId, name, email, phone);
        entry.booking_count++;
        if (!entry.guest_phone && b.guest_phone) entry.guest_phone = b.guest_phone;
        if (!entry.canonical_phone) entry.canonical_phone = profile?.canonical_phone || b.canonical_phone || null;
        if (b.business_id) entry.businesses.set(b.business_id, bizMap.get(b.business_id) || 'Unknown');
        touch(entry, b.created_at);
      }

      // Process successful payments. A guest payment belongs to its booking's
      // customer; a payment with neither a user nor a booking has no customer.
      for (const p of payments) {
        if (p.status !== 'success') continue;
        const key = p.user_id || (p.booking_id ? bookingKey.get(p.booking_id) : undefined);
        if (!key) continue;
        const profile = p.user_id ? profileMap.get(p.user_id) : null;

        const entry = getOrCreate(key, p.user_id || null, profile?.name || '', profile?.email || '', profile?.phone || '');
        if (!entry.canonical_phone && profile?.canonical_phone) entry.canonical_phone = profile.canonical_phone;
        entry.payment_count++;
        const cur = p.currency || 'USD';
        if (typeof p.amount === 'number' && p.amount > 0) {
          entry.spending[cur] = (entry.spending[cur] || 0) + p.amount;
        }
        if (p.business_id) entry.businesses.set(p.business_id, bizMap.get(p.business_id) || 'Unknown');
        touch(entry, p.created_at);
      }

      // Build final list
      const list: Customer[] = [];
      for (const [key, entry] of customerMap) {
        list.push({
          ...entry,
          id: key,
          name: entry.name || '—',
          email: entry.email || '—',
          phone: entry.phone || '—',
          businesses: Array.from(entry.businesses.entries()).map(([id, name]) => ({ id, name })),
        });
      }

      list.sort((a, b) => new Date(b.last_active).getTime() - new Date(a.last_active).getTime());
      setCustomers(list);
    } catch (error) {
      console.warn('Failed to load customers:', error);
      setLoadError(error instanceof Error ? error.message : 'Failed to load customer data');
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }

  useEffect(() => { loadData(); loadSuspensions(); }, []);

  // Load transactions for selected customer
  useEffect(() => {
    if (!selected) {
      setTransactions([]);
      setTxError('');
      return;
    }
    setLoadingTx(true);
    setTxError('');

    async function loadTransactions() {
      const txs: Transaction[] = [];
      const customer = selected!;
      try {
        if (!customer.user_id && !customer.guest_phone) return;
        // Registered customers by user; guests by the phone on their bookings.
        const [ownerColumn, ownerValue] = customer.user_id ? ['user_id', customer.user_id] : ['guest_phone', customer.guest_phone!];
        const { data: bookings, error: bookingsError } = await adminDb
          .from('bookings')
          .select('id, business_id, service_id, status, total_amount, deposit_amount, reference_code, date, created_at')
          .eq(ownerColumn, ownerValue)
          .order('created_at', { ascending: false });
        if (bookingsError) throw new Error('Unable to load bookings');

        // A guest's payments are the ones linked to their bookings, as in the totals.
        const guestBookingIds = (bookings || []).map(b => b.id);
        const paymentsQuery = adminDb.from('payments')
          .select('id, business_id, amount, currency, status, gateway_reference, created_at');
        const [paymentsRes, ordersRes] = await Promise.all([
          customer.user_id
            ? paymentsQuery.eq('user_id', customer.user_id).order('created_at', { ascending: false })
            : guestBookingIds.length > 0
              ? paymentsQuery.in('booking_id', guestBookingIds).order('created_at', { ascending: false })
              : Promise.resolve({ data: [], error: null }),
          customer.user_id
            ? adminDb.from('orders')
              .select('id, business_id, status, total_amount, reference_code, created_at')
              .eq('user_id', customer.user_id)
              .order('created_at', { ascending: false })
            : Promise.resolve({ data: [], error: null }),
        ]);
        if (paymentsRes.error) throw new Error('Unable to load payments');
        if (ordersRes.error) throw new Error('Unable to load orders');
        const payments = paymentsRes.data || [];
        const orders = ordersRes.data || [];

        // Business names and countries (currency), and service names
        const allBizIds = new Set<string>();
        for (const b of bookings || []) if (b.business_id) allBizIds.add(b.business_id);
        for (const p of payments) if (p.business_id) allBizIds.add(p.business_id);
        for (const o of orders) if (o.business_id) allBizIds.add(o.business_id);
        const serviceIds = [...new Set((bookings || []).map(b => b.service_id).filter(Boolean))] as string[];

        const [{ data: bizData }, { data: serviceData }] = await Promise.all([
          allBizIds.size > 0
            ? adminDb.from('businesses').select('id, name, country_code').in('id', [...allBizIds])
            : Promise.resolve({ data: [] as { id: string; name: string; country_code: string | null }[] }),
          serviceIds.length > 0
            ? adminDb.from('services').select('id, name').in('id', serviceIds)
            : Promise.resolve({ data: [] as { id: string; name: string }[] }),
        ]);
        const bizMap = new Map((bizData || []).map(b => [b.id, b]));
        const serviceMap = new Map((serviceData || []).map(s => [s.id, s.name]));

        for (const b of bookings || []) {
          txs.push({
            id: b.id,
            type: 'booking',
            business_name: bizMap.get(b.business_id)?.name || 'Unknown',
            service_name: (b.service_id && serviceMap.get(b.service_id)) || null,
            status: b.status,
            amount: b.total_amount || b.deposit_amount || 0,
            currency: currencyFor(bizMap.get(b.business_id)?.country_code),
            date: b.date || b.created_at,
            reference: b.reference_code || null,
          });
        }

        for (const p of payments) {
          txs.push({
            id: p.id,
            type: 'payment',
            business_name: bizMap.get(p.business_id)?.name || 'Unknown',
            service_name: null,
            status: p.status,
            amount: p.amount || 0,
            currency: p.currency || currencyFor(bizMap.get(p.business_id)?.country_code),
            date: p.created_at,
            reference: p.gateway_reference || null,
          });
        }

        for (const o of orders) {
          txs.push({
            id: o.id,
            type: 'order',
            business_name: bizMap.get(o.business_id)?.name || 'Unknown',
            service_name: null,
            status: o.status,
            amount: o.total_amount || 0,
            currency: currencyFor(bizMap.get(o.business_id)?.country_code),
            date: o.created_at,
            reference: o.reference_code || null,
          });
        }

        // Sort by date descending
        txs.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      } catch (err) {
        setTxError(err instanceof Error ? err.message : 'Unable to load transactions');
      } finally {
        setTransactions(txs);
        setLoadingTx(false);
      }
    }

    loadTransactions();
  }, [selected]);

  /** Blocked emails that belong to this customer: linked to their number, or their own email. */
  function blockedEmailsFor(phone: string | null, email: string | null): EmailBlock[] {
    const own = email ? emailKey(email) : '';
    return emailBlocks.filter(b => (phone && b.phone === phone) || (own && b.email === own));
  }

  async function openBlock(target: BlockTarget, own: { email: string | null } = { email: null }) {
    const request = ++candidatesRequestRef.current;
    setSuspendTarget(target);
    setSuspendReason('');
    setSuspendMessage('');
    setTicked(new Set());
    setAddEmail('');
    setAddError('');
    setCandidatesError('');
    // Cleared for every open, so a lookup still running for an earlier dialog
    // cannot leave "Loading emails…" on this one.
    setCandidatesLoading(false);
    if (!target.block) {
      // Unblock: every email blocked for this customer, none ticked.
      setCandidates(blockedEmailsFor(target.phone, own.email).map(b => ({
        email: b.email, source: 'unrecorded', last_seen: b.blocked_at, blocked: true,
      })));
      return;
    }
    setCandidates([]);
    // Nothing to look up for a guest with no usable number and no account:
    // the list is empty and the admin adds emails by hand (F5a).
    if (target.addOnly || (!target.phone && !target.userId)) return;
    setCandidatesLoading(true);
    try {
      const query = new URLSearchParams();
      if (target.phone) query.set('phone', target.phone);
      if (target.userId) query.set('userId', target.userId);
      const res = await adminApiGet(`/api/admin/customers/suspension/candidates?${query.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (request !== candidatesRequestRef.current) return;
      if (!res.ok) throw new Error(data.error || 'Unable to load this customer\u2019s emails');
      setCandidates(data.candidates as EmailCandidate[]);
    } catch (err) {
      if (request !== candidatesRequestRef.current) return;
      setCandidatesError(err instanceof Error ? err.message : 'Unable to load this customer\u2019s emails');
    } finally {
      if (request === candidatesRequestRef.current) setCandidatesLoading(false);
    }
  }

  function toggleEmail(email: string) {
    setTicked(prev => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email); else next.add(email);
      return next;
    });
  }

  function addHandEmail() {
    const email = emailKey(addEmail);
    if (!EMAIL_FORMAT.test(email) || email.length > 254) {
      setAddError('Enter a valid email address.');
      return;
    }
    if (candidates.some(c => c.email === email)) {
      setAddError('This email is already in the list.');
      return;
    }
    setCandidates(prev => [...prev, { email, source: 'added', last_seen: null, blocked: false }]);
    setTicked(prev => new Set(prev).add(email));
    setAddEmail('');
    setAddError('');
  }

  /** Run one bound change: a number and/or emails, behind its own step-up. */
  async function runBlockChange(change: {
    phone: string | null; linkPhone?: string; block: boolean; reason: string | null; emails: string[]; description: string;
  }) {
    if (!isFullAdmin || suspendSaving) return;
    const emails = [...new Set(change.emails.map(emailKey))].sort();
    const { phone, block, reason } = change;
    setSuspendSaving(true);
    setSuspendMessage('');
    const params: Record<string, unknown> = { phone, suspended: block, reason, emails };
    if (change.linkPhone) params.linkPhone = change.linkPhone;
    const onAuthorized = async (stepUpId: string) => {
      const res = await adminApiFetch('/api/admin/customers/suspension', { ...params, stepUpId });
      const data = await res.json().catch(() => ({}));
      stepUpCallbackRef.current = null;
      if (!res.ok) {
        setSuspendMessage(data.error || 'The change was not saved.');
        // 409: someone else already made this change; show the real state.
        await loadSuspensions();
        return;
      }
      await loadSuspensions();
      setSuspendTarget(null);
    };
    stepUpCallbackRef.current = onAuthorized;
    try {
      await stepUp.execute({
        actionType: 'customer_suspension',
        targetId: phone ?? emails[0],
        params,
        description: change.description,
        onAuthorized,
      });
    } catch (err) {
      stepUpCallbackRef.current = null;
      setSuspendMessage(err instanceof Error ? err.message : 'Step-up failed');
      stepUp.reset();
    } finally {
      setSuspendSaving(false);
    }
  }

  async function confirmSuspend() {
    if (!suspendTarget || !isFullAdmin || suspendSaving) return;
    const { phone, phoneBlocked, label, block } = suspendTarget;
    const reason = suspendReason.trim() ? suspendReason : null;
    const emails = [...ticked];
    const phoneChange = phone !== null && !(block && phoneBlocked);
    if (!phoneChange && emails.length === 0) {
      setSuspendMessage('Tick or add at least one email.');
      return;
    }
    // Counted in characters, as the server and the database count them.
    if (block && (!reason || [...reason.trim()].length < 3)) {
      setSuspendMessage('Enter a reason (at least 3 characters).');
      return;
    }
    const who = phone ? `${label} (${maskPhone(phone)})` : label;
    const emailPart = emails.length > 0 ? `${block ? 'block' : 'unblock'} ${emailCount(emails.length)}` : '';
    const description = phoneChange
      ? `${block ? 'Suspend' : 'Unsuspend'} ${who} on all Waaiio bots${emailPart ? ` and ${emailPart}` : ''}`
      : `${block ? 'Block' : 'Unblock'} ${emailCount(emails.length)} for ${who}`;
    // Emails added for an already-blocked number are linked to it, without
    // touching the number (an email-only change bound to that link).
    if (phone !== null && !phoneChange) {
      await runBlockChange({ phone: null, linkPhone: phone, block, reason, emails, description });
      return;
    }
    await runBlockChange({ phone, block, reason, emails, description });
  }

  async function unblockEmail(block: EmailBlock) {
    setSuspendTarget(null);
    await runBlockChange({ phone: null, block: false, reason: null, emails: [block.email], description: `Unblock ${block.email}` });
  }

  // Filters
  const filtered = customers.filter(c => {
    if (search) {
      const q = search.toLowerCase();
      if (
        !c.name.toLowerCase().includes(q) &&
        !c.email.toLowerCase().includes(q) &&
        !c.phone.includes(q)
      ) return false;
    }
    if (businessFilter !== 'all') {
      if (!c.businesses.some(b => b.id === businessFilter)) return false;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const { sorted, sortProps } = useTableSort(filtered, {
    name: c => c.name,
    email: c => c.email,
    phone: c => c.phone,
    business: c => c.businesses[0]?.name,
    bookings: c => c.booking_count,
    payments: c => c.payment_count,
    spent: c => Object.values(c.spending || {}).reduce((sum, amt) => sum + (amt > 0 ? amt : 0), 0),
    lastActive: c => sortTime(c.last_active),
  }, { onSortChange: () => setPage(1) });
  const pageItems = sorted.slice((page - 1) * perPage, page * perPage);
  // One list of blocked numbers and blocked emails (#1166 F5).
  const blockRows = [
    ...[...suspensions.values()].map(s => ({ key: `n:${s.phone}`, type: 'Number' as const, value: s.phone, reason: s.reason, at: s.suspended_at, email: null as EmailBlock | null })),
    ...emailBlocks.map(b => ({ key: `e:${b.email}`, type: 'Email' as const, value: b.email, reason: b.reason, at: b.blocked_at, email: b })),
  ];
  const suspensionSort = useTableSort(blockRows, {
    type: r => r.type,
    phone: r => r.value,
    reason: r => r.reason,
    suspended: r => sortTime(r.at),
  });

  // Stats
  const totalCustomers = customers.length;
  const withBookings = customers.filter(c => c.booking_count > 0).length;
  // Successful payments, by currency
  const revenueByCurrency: Record<string, number> = {};
  for (const c of customers) {
    for (const [cur, amt] of Object.entries(c.spending || {})) {
      revenueByCurrency[cur] = (revenueByCurrency[cur] || 0) + amt;
    }
  }
  const revenueParts = Object.entries(revenueByCurrency).filter(([, a]) => a > 0);
  const revenueDisplay = revenueParts.length > 0
    ? revenueParts.map(([cur, amt]) => fmtCurrency(amt, cur)).join(' · ')
    : '—';
  const uniqueBiz = new Set(customers.flatMap(c => c.businesses.map(b => b.id))).size;

  const hasFilters = search || businessFilter !== 'all';
  // The confirmation stays hidden while the step-up dialog is up, and comes back
  // with the error if the step-up or the save fails.
  const stepUpInFlight = ['preparing', 'awaiting-code', 'verifying', 'executing'].includes(stepUp.state.phase);
  const stepUpFailure = stepUp.state.phase === 'error' ? stepUp.state.error : '';
  const selectedSuspension = selected?.canonical_phone ? suspensions.get(selected.canonical_phone) : undefined;
  const selectedEmailBlocks = selected
    ? blockedEmailsFor(selected.canonical_phone, selected.email !== '—' ? selected.email : null)
    : [];
  const tickedCount = ticked.size;
  const confirmLabel = !suspendTarget ? '' : suspendTarget.block
    ? (suspendTarget.phone && !suspendTarget.phoneBlocked
      ? (tickedCount > 0 ? `Block number and ${emailCount(tickedCount)}` : 'Block number')
      : `Block ${emailCount(tickedCount)}`)
    : (suspendTarget.phone
      ? (tickedCount > 0 ? `Unblock number and ${emailCount(tickedCount)}` : 'Unblock number')
      : `Unblock ${emailCount(tickedCount)}`);

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Customers</h1>
      <p className="mt-1 text-sm text-gray-500">End customers who booked, ordered, or made payments</p>

      {loadError && (
        <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {loadError}
        </div>
      )}
      {suspensionError && (
        <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {suspensionError}. Suspension status is not shown.
        </div>
      )}

      {/* Stats */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Total Customers" value={totalCustomers} icon={Users} color="blue" />
        <SummaryCard label="With Bookings" value={withBookings} icon={UserCheck} color="green" />
        <SummaryCard label="Successful Payments" value={revenueDisplay} icon={CreditCard} color="purple" />
        <SummaryCard label="Businesses" value={uniqueBiz} icon={Building2} color="yellow" />
      </div>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search by name, email, or phone..."
            className="rounded-lg border border-gray-300 py-2 pl-10 pr-3 text-sm text-gray-700 focus:border-brand focus:outline-none sm:w-72"
          />
        </div>
        <select
          value={businessFilter}
          onChange={e => { setBusinessFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Accounts</option>
          {allBusinesses.map(b => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
        {hasFilters && (
          <button
            onClick={() => { setSearch(''); setBusinessFilter('all'); setPage(1); }}
            className="text-sm text-brand hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No customers found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <SortableTh {...sortProps('name')} className="px-4 py-3 text-left font-medium text-gray-500">Name</SortableTh>
                <SortableTh {...sortProps('email')} className="px-4 py-3 text-left font-medium text-gray-500">Email</SortableTh>
                <SortableTh {...sortProps('phone')} className="px-4 py-3 text-left font-medium text-gray-500">Phone</SortableTh>
                <SortableTh {...sortProps('business')} className="px-4 py-3 text-left font-medium text-gray-500">Business</SortableTh>
                <SortableTh {...sortProps('bookings')} className="px-4 py-3 text-right font-medium text-gray-500">Bookings</SortableTh>
                <SortableTh {...sortProps('payments')} className="px-4 py-3 text-right font-medium text-gray-500">Payments</SortableTh>
                <SortableTh {...sortProps('spent')} className="px-4 py-3 text-right font-medium text-gray-500">Total Spent</SortableTh>
                <SortableTh {...sortProps('lastActive')} className="px-4 py-3 text-left font-medium text-gray-500">Last Active</SortableTh>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(c => (
                <tr
                  key={c.id}
                  onClick={() => setSelected(c)}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {c.name}
                    {((c.canonical_phone && suspensions.has(c.canonical_phone))
                      || (c.email !== '—' && emailBlocks.some(b => b.email === emailKey(c.email)))) && (
                      <span className="ml-2 align-middle"><StatusBadge status="suspended" /></span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{c.email}</td>
                  <td className="px-4 py-3 text-gray-600">{maskPhone(c.phone)}</td>
                  <td className="px-4 py-3 text-gray-600">
                    {c.businesses.length === 1
                      ? c.businesses[0].name
                      : c.businesses.length > 1
                        ? `${c.businesses[0].name} +${c.businesses.length - 1}`
                        : '—'}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">{c.booking_count}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{c.payment_count}</td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">
                    {(() => {
                      const entries = Object.entries(c.spending || {}).filter(([, a]) => a > 0);
                      if (entries.length === 0) return '—';
                      if (entries.length === 1) return fmtCurrency(entries[0][1], entries[0][0]);
                      return (
                        <span title={entries.map(([cur, amt]) => fmtCurrency(amt, cur)).join('\n')}>
                          {entries.map(([cur, amt]) => (
                            <span key={cur} className="block text-xs leading-tight">{fmtCurrency(amt, cur)}</span>
                          ))}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmtRelative(c.last_active)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      {/* Blocked numbers (#1103) and emails (#1166), including ones not in the list above */}
      {(blockRows.length > 0 || (isFullAdmin && !suspensionError)) && (
        <div className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
              <Ban className="h-5 w-5 text-red-500" /> Suspended numbers and emails ({blockRows.length})
            </h2>
            {isFullAdmin && !suspensionError && (
              <button
                onClick={() => openBlock({ block: true, phone: null, phoneBlocked: false, label: 'this email', userId: null, addOnly: true })}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Block an email
              </button>
            )}
          </div>
          <p className="mt-1 text-sm text-gray-500">Blocked from every Waaiio bot at every business. Marketing skips them. Payments are not affected.</p>
          {blockRows.length > 0 && (
          <div className="mt-3 overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-100 bg-gray-50">
                <tr>
                  <SortableTh {...suspensionSort.sortProps('type')} className="px-4 py-3 text-left font-medium text-gray-500">Type</SortableTh>
                  <SortableTh {...suspensionSort.sortProps('phone')} className="px-4 py-3 text-left font-medium text-gray-500">Number or email</SortableTh>
                  <SortableTh {...suspensionSort.sortProps('reason')} className="px-4 py-3 text-left font-medium text-gray-500">Reason</SortableTh>
                  <SortableTh {...suspensionSort.sortProps('suspended')} className="px-4 py-3 text-left font-medium text-gray-500">Suspended</SortableTh>
                  {isFullAdmin && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {suspensionSort.sorted.map(r => (
                  <tr key={r.key}>
                    <td className="px-4 py-3 text-gray-500">{r.type}</td>
                    <td className="px-4 py-3 text-gray-700">
                      {r.email ? r.email.email : maskPhone(r.value)}
                      {r.email?.phone && <span className="ml-2 text-xs text-gray-400">with {maskPhone(r.email.phone)}</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{r.reason}</td>
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmtDateTime(r.at)}</td>
                    {isFullAdmin && (
                      <td className="px-4 py-3 text-right">
                        {r.email ? (
                          <button
                            onClick={() => unblockEmail(r.email!)}
                            disabled={suspendSaving}
                            aria-label={`Unblock ${r.email.email}`}
                            className="text-sm font-medium text-brand hover:underline disabled:opacity-50"
                          >
                            Unblock
                          </button>
                        ) : (
                          <button
                            onClick={() => openBlock({ block: false, phone: r.value, phoneBlocked: true, label: 'this number', userId: null, addOnly: false })}
                            aria-label={`Unsuspend ${maskPhone(r.value)}`}
                            className="text-sm font-medium text-brand hover:underline"
                          >
                            Unsuspend
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </div>
      )}

      {/* Detail Modal */}
      <DetailModal
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? selected.name : ''}
        wide
      >
        {selected && (
          <div className="space-y-4 text-sm">
            <DetailRow label="Name" value={selected.name} />
            <DetailRow label="Email" value={selected.email} />
            <DetailRow label="Phone" value={maskPhone(selected.phone)} />
            <DetailRow label="Bookings" value={selected.booking_count} />
            <DetailRow label="Successful payments" value={selected.payment_count} />
            <DetailRow label="Total Spent" value={
              Object.entries(selected.spending || {}).filter(([, a]) => a > 0).map(([cur, amt]) => fmtCurrency(amt, cur)).join(' · ') || '—'
            } />
            <DetailRow label="First Seen" value={fmtDateTime(selected.first_seen)} />
            <DetailRow label="Last Active" value={fmtDateTime(selected.last_active)} />

            {/* Platform-wide suspension (#1103), with emails (#1166) */}
            <div className="rounded-lg border border-gray-200 p-4">
              <p className="mb-2 text-xs font-semibold uppercase text-gray-500">Waaiio access</p>
              {!selected.canonical_phone ? (
                <div className="space-y-2">
                  <p className="text-gray-500">No WhatsApp number in international format is on record, so this customer cannot be suspended here.</p>
                  {isFullAdmin && !suspensionError && (
                    <button
                      onClick={() => openBlock({ block: true, phone: null, phoneBlocked: false, label: selected.name, userId: selected.user_id, addOnly: false }, { email: selected.email !== '—' ? selected.email : null })}
                      className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                    >
                      Block
                    </button>
                  )}
                </div>
              ) : selectedSuspension ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2"><StatusBadge status="suspended" /><span className="text-gray-600">since {fmtDateTime(selectedSuspension.suspended_at)}</span></div>
                  <p className="text-gray-600">Reason: {selectedSuspension.reason}</p>
                  {isFullAdmin && (
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => openBlock({ block: false, phone: selected.canonical_phone!, phoneBlocked: true, label: selected.name, userId: selected.user_id, addOnly: false }, { email: selected.email !== '—' ? selected.email : null })}
                        className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                      >
                        Unsuspend
                      </button>
                      {!suspensionError && (
                        <button
                          onClick={() => openBlock({ block: true, phone: selected.canonical_phone!, phoneBlocked: true, label: selected.name, userId: selected.user_id, addOnly: false })}
                          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                        >
                          Block an email
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-2"><StatusBadge status="active" /><span className="text-gray-600">Can use every Waaiio bot</span></div>
                  {isFullAdmin && !suspensionError && (
                    <button
                      onClick={() => openBlock({ block: true, phone: selected.canonical_phone!, phoneBlocked: false, label: selected.name, userId: selected.user_id, addOnly: false })}
                      className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
                    >
                      Suspend from all bots
                    </button>
                  )}
                </div>
              )}
              {selectedEmailBlocks.length > 0 && (
                <div className="mt-3 space-y-1">
                  <p className="text-xs font-semibold uppercase text-gray-500">Blocked emails</p>
                  {selectedEmailBlocks.map(b => (
                    <div key={b.email} className="flex items-center justify-between gap-2">
                      <span className="text-gray-700">{b.email} <span className="text-xs text-gray-400">since {fmtDateTime(b.blocked_at)}</span></span>
                      {isFullAdmin && (
                        <button
                          onClick={() => unblockEmail(b)}
                          disabled={suspendSaving}
                          aria-label={`Unblock ${b.email}`}
                          className="text-sm font-medium text-brand hover:underline disabled:opacity-50"
                        >
                          Unblock
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Businesses */}
            {selected.businesses.length > 0 && (
              <div className="rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold uppercase text-gray-500 mb-2">
                  Businesses ({selected.businesses.length})
                </p>
                <div className="space-y-1">
                  {selected.businesses.map(b => (
                    <div key={b.id} className="flex justify-between">
                      <span className="text-gray-700">{b.name}</span>
                      <span className="font-mono text-xs text-gray-400">{b.id.slice(0, 8)}...</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Transactions */}
            <div className="rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">
                Transactions ({transactions.length})
              </p>
              {loadingTx ? (
                <div className="flex justify-center py-4">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                </div>
              ) : txError ? (
                <p role="alert" className="text-red-600">{txError}</p>
              ) : transactions.length === 0 ? (
                <p className="text-gray-400">No transactions found</p>
              ) : (
                <div className="max-h-80 overflow-y-auto space-y-2">
                  {transactions.map(tx => (
                    <div key={`${tx.type}-${tx.id}`} className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                            tx.type === 'booking' ? 'bg-blue-100 text-blue-700'
                              : tx.type === 'order' ? 'bg-purple-100 text-purple-700'
                              : 'bg-green-100 text-green-700'
                          }`}>
                            {tx.type}
                          </span>
                          <span className="font-medium text-gray-800 truncate">{tx.business_name}</span>
                        </div>
                        <p className="mt-0.5 text-xs text-gray-400">
                          {tx.service_name ? `${tx.service_name} · ` : ''}
                          {fmtDate(tx.date)}
                          {tx.reference ? ` · ${tx.reference}` : ''}
                        </p>
                      </div>
                      <div className="ml-3 text-right shrink-0">
                        <p className="font-medium text-gray-900">
                          {tx.amount > 0 ? fmtCurrency(tx.amount, tx.currency) : '—'}
                        </p>
                        <StatusBadge status={tx.status} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </DetailModal>

      {/* Block / unblock confirmation (#1103, emails #1166) */}
      <DetailModal
        open={!!suspendTarget && !stepUpInFlight}
        onClose={() => { if (!suspendSaving) setSuspendTarget(null); }}
        title={!suspendTarget ? '' : suspendTarget.block
          ? (suspendTarget.phone && !suspendTarget.phoneBlocked ? 'Suspend from all Waaiio bots' : 'Block emails')
          : 'Unsuspend this number'}
      >
        {suspendTarget && (
          <div className="space-y-4 text-sm">
            {suspendTarget.phone && !(suspendTarget.block && suspendTarget.phoneBlocked) && (
              <p className="text-gray-700">
                {suspendTarget.block
                  ? <>The number <strong>+{suspendTarget.phone}</strong> will be blocked from every Waaiio bot at every business. It gets one short reply, with no reason given. Marketing will skip it. Payments, refunds and payouts are not changed.</>
                  : <>The number <strong>+{suspendTarget.phone}</strong> will be able to use Waaiio bots again.</>}
              </p>
            )}

            <fieldset className="space-y-2">
              {!suspendTarget.addOnly && (suspendTarget.block || candidates.length > 0) && (
                <>
                  <legend className="text-xs font-semibold uppercase text-gray-500">
                    {suspendTarget.block ? 'Also block these emails' : 'Also unblock these emails'}
                  </legend>
                  <p className="text-gray-500">
                    {suspendTarget.block
                      ? 'Tick the emails to block. Nothing is blocked unless you tick it.'
                      : 'Tick the emails to unblock. Emails you don\u2019t tick stay blocked.'}
                  </p>
                </>
              )}
              {candidatesLoading && <p className="text-gray-400">Loading emails…</p>}
              {candidatesError && <p role="alert" className="text-red-600">{candidatesError}</p>}
              {candidates.map(c => {
                const unavailable = suspendTarget.block && c.blocked;
                return (
                  <label key={c.email} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={ticked.has(c.email)}
                      disabled={unavailable}
                      onChange={() => toggleEmail(c.email)}
                      className="mt-1"
                    />
                    <span>
                      <span className="text-gray-800">{c.email}</span>
                      <span className="block text-xs text-gray-500">
                        {suspendTarget.block
                          ? <>{SOURCE_LABEL[c.source]}{c.last_seen ? ` · ${fmtDate(c.last_seen)}` : ''}{unavailable ? ' · Blocked' : ''}</>
                          : <>Blocked {c.last_seen ? fmtDate(c.last_seen) : ''}</>}
                      </span>
                    </span>
                  </label>
                );
              })}
              {suspendTarget.block && (
                <div>
                  <label htmlFor="block-add-email" className="block text-xs font-semibold uppercase text-gray-500">Add an email</label>
                  <div className="mt-1 flex gap-2">
                      <input
                        id="block-add-email"
                        type="email"
                        value={addEmail}
                        onChange={e => { setAddEmail(e.target.value); setAddError(''); }}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addHandEmail(); } }}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={addHandEmail}
                        className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                      >
                        Add
                      </button>
                  </div>
                  {addError && <p role="alert" className="mt-1 text-red-600">{addError}</p>}
                </div>
              )}
            </fieldset>

            <label className="block">
              <span className="text-xs font-semibold uppercase text-gray-500">
                Reason{suspendTarget.block ? ' (required, kept in the audit log)' : ' (optional)'}
              </span>
              <textarea
                value={suspendReason}
                onChange={e => setSuspendReason(e.target.value)}
                maxLength={500}
                rows={3}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
              />
            </label>
            {(suspendMessage || stepUpFailure) && <p role="alert" className="text-red-600">{suspendMessage || stepUpFailure}</p>}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setSuspendTarget(null)}
                disabled={suspendSaving}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmSuspend}
                disabled={suspendSaving}
                className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${suspendTarget.block ? 'bg-red-600 hover:bg-red-700' : 'bg-brand hover:opacity-90'}`}
              >
                {suspendSaving ? 'Working…' : confirmLabel}
              </button>
            </div>
          </div>
        )}
      </DetailModal>

      {/* An "Unblock" outside the dialog shows its error here. */}
      {!suspendTarget && suspendMessage && (
        <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{suspendMessage}</div>
      )}

      <StepUpDialog
        open={!!stepUpCallbackRef.current && (stepUp.state.phase === 'awaiting-code' || stepUp.state.phase === 'verifying')}
        description={stepUp.state.description} method={stepUp.state.method}
        error={stepUp.state.error}
        loading={stepUp.state.phase === 'verifying'}
        onSubmit={async (code) => {
          if (stepUpFlightRef.current || !stepUpCallbackRef.current) return;
          stepUpFlightRef.current = true;
          try { await stepUp.submitCode(code, stepUpCallbackRef.current); }
          finally {
            stepUpFlightRef.current = false;
            if (!stepUpCallbackRef.current) stepUp.reset();
          }
        }}
        onCancel={() => { stepUp.reset(); stepUpCallbackRef.current = null; }}
      />
    </div>
  );
}
