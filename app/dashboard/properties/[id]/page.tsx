'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import Image from 'next/image';
import { useParams, useRouter } from 'next/navigation';
import { useBusiness, useRequireCapability } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, getLocale, type CountryCode, CATEGORY_LABELS } from '@/lib/constants';
import EmptyState from '@/components/dashboard/EmptyState';
import { PageHelp } from '@/components/dashboard/PageHelp';

interface Property {
  id: string;
  name: string;
  description: string | null;
  property_type: string;
  price: number;
  deposit_amount: number;
  max_guests: number;
  bedrooms: number;
  bathrooms: number;
  amenities: string[];
  photos: string[];
  address: string | null;
  is_active: boolean;
}

interface Reservation {
  id: string;
  reference_code: string;
  check_in: string;
  check_out: string;
  nights: number;
  guests: number;
  status: string;
  guest_name: string;
  guest_phone: string;
  guest_email: string | null;
  special_requests: string | null;
  deposit_amount: number;
  deposit_status: string;
  total_amount: number;
  nightly_rate: number;
  created_at: string;
  confirmed_at: string | null;
  checked_in_at: string | null;
  checked_out_at: string | null;
  cancelled_at: string | null;
  payment_id: string | null;
  channel: string;
  notes: string | null;
}

interface BlockedDate {
  id: string;
  date_from: string;
  date_to: string;
  reason: string | null;
}

type TabId = 'bookings' | 'calendar' | 'revenue';
type StatusFilter = 'all' | 'upcoming' | 'current' | 'past' | 'cancelled';

const statusColors: Record<string, string> = {
  confirmed: 'bg-green-100 text-green-800',
  pending: 'bg-yellow-100 text-yellow-800',
  in_progress: 'bg-blue-100 text-blue-800',
  checked_in: 'bg-blue-100 text-blue-800',
  completed: 'bg-gray-100 text-gray-700',
  checked_out: 'bg-gray-100 text-gray-700',
  cancelled: 'bg-red-100 text-red-700',
  no_show: 'bg-red-100 text-red-700',
};

const statusLabels: Record<string, string> = {
  in_progress: 'Checked In',
  checked_in: 'Checked In',
  completed: 'Checked Out',
  checked_out: 'Checked Out',
};

// Actions available per reservation status
const reservationActions: Record<string, { label: string; next: string; color: string }[]> = {
  pending: [
    { label: 'Confirm', next: 'confirmed', color: 'text-green-600 hover:bg-green-50' },
    { label: 'Cancel', next: 'cancelled', color: 'text-red-600 hover:bg-red-50' },
  ],
  confirmed: [
    { label: 'Check In', next: 'checked_in', color: 'text-blue-600 hover:bg-blue-50' },
    { label: 'No Show', next: 'no_show', color: 'text-red-600 hover:bg-red-50' },
    { label: 'Cancel', next: 'cancelled', color: 'text-red-600 hover:bg-red-50' },
  ],
  checked_in: [
    { label: 'Check Out', next: 'checked_out', color: 'text-gray-600 hover:bg-gray-50' },
  ],
  in_progress: [
    { label: 'Check Out', next: 'checked_out', color: 'text-gray-600 hover:bg-gray-50' },
  ],
};

function CheckInQRSection({ propertyId, propertyName }: { propertyId: string; propertyName: string }) {
  const [showQR, setShowQR] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const qrUrl = `https://waaiio.com/checkin/property/${propertyId}`;

  useEffect(() => {
    if (!showQR || !canvasRef.current) return;
    import('qrcode').then(QRCode => {
      QRCode.toCanvas(canvasRef.current, qrUrl, { width: 256, margin: 2 }, () => {});
    });
  }, [showQR, qrUrl]);

  function downloadQR() {
    if (!canvasRef.current) return;
    const link = document.createElement('a');
    link.download = `checkin-qr-${propertyName.replace(/\s+/g, '-').toLowerCase()}.png`;
    link.href = canvasRef.current.toDataURL('image/png');
    link.click();
  }

  function printQR() {
    if (!canvasRef.current) return;
    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write(`
      <html><head><title>Check-in QR - ${propertyName}</title>
      <style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center}img{max-width:300px}h2{margin-top:24px}p{color:#666;font-size:14px;margin-top:8px}</style></head>
      <body>
        <img src="${canvasRef.current.toDataURL('image/png')}" />
        <h2>${propertyName}</h2>
        <p>Scan this QR code to check in</p>
        <p style="font-size:12px;color:#999;margin-top:16px">${qrUrl}</p>
      </body></html>
    `);
    win.document.close();
    win.print();
  }

  return (
    <div className="mt-4 rounded-xl border border-gray-100 bg-white p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Check-in QR Code</h3>
          <p className="text-xs text-gray-500 mt-0.5">Print and display this QR code at your property entrance</p>
        </div>
        <button
          onClick={() => setShowQR(!showQR)}
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
        >
          {showQR ? 'Hide' : 'Show QR'}
        </button>
      </div>
      {showQR && (
        <div className="mt-4 flex flex-col items-center gap-3">
          <canvas ref={canvasRef} className="rounded-lg border border-gray-200" />
          <p className="text-xs text-gray-400 font-mono break-all text-center max-w-xs">{qrUrl}</p>
          <div className="flex gap-2">
            <button onClick={downloadQR} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50">
              Download PNG
            </button>
            <button onClick={printQR} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50">
              Print QR
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function PropertyDetailPage() {
  const allowed = useRequireCapability('reservation');
  const params = useParams();
  const router = useRouter();
  const business = useBusiness();
  const country = (business.country_code || 'NG') as CountryCode;
  const locale = getLocale(country);
  const labels = CATEGORY_LABELS[business.category as keyof typeof CATEGORY_LABELS];
  const propertyLabel = labels?.propertyName || 'Property';

  const propertyId = params.id as string;

  const [property, setProperty] = useState<Property | null>(null);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [blockedDates, setBlockedDates] = useState<BlockedDate[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>('bookings');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [selectedReservation, setSelectedReservation] = useState<Reservation | null>(null);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  const loadData = useCallback(async () => {
    const supabase = createClient();

    // Load property
    const { data: prop } = await supabase
      .from('properties')
      .select('*')
      .eq('id', propertyId)
      .eq('business_id', business.id)
      .single();

    if (!prop) {
      setLoading(false);
      return;
    }
    setProperty(prop as Property);

    // Load reservations
    const { data: res } = await supabase
      .from('reservations')
      .select('id, reference_code, check_in, check_out, nights, guests, status, guest_name, guest_phone, guest_email, special_requests, deposit_amount, deposit_status, total_amount, nightly_rate, created_at, confirmed_at, checked_in_at, checked_out_at, cancelled_at, payment_id, channel, notes')
      .eq('property_id', propertyId)
      .eq('business_id', business.id)
      .order('check_in', { ascending: false });

    setReservations((res || []) as Reservation[]);

    // Load blocked dates
    const { data: blocked } = await supabase
      .from('property_blocked_dates')
      .select('id, date_from, date_to, reason')
      .eq('property_id', propertyId)
      .order('date_from');

    setBlockedDates((blocked || []) as BlockedDate[]);
    setLoading(false);
  }, [propertyId, business.id]);

  useEffect(() => { loadData(); }, [loadData]);

  // Update reservation status
  async function updateReservationStatus(id: string, newStatus: string) {
    const supabase = createClient();
    const extra: Record<string, unknown> = {};
    const now = new Date().toISOString();

    if (newStatus === 'confirmed') extra.confirmed_at = now;
    if (newStatus === 'cancelled') {
      extra.cancelled_at = now;
      extra.cancelled_by = 'business';

      // Check if deposit was paid — offer refund
      const reservation = reservations.find(r => r.id === id);
      if (reservation && reservation.deposit_status === 'paid' && reservation.payment_id) {
        const depositAmount = reservation.deposit_amount || reservation.total_amount;
        const shouldRefund = window.confirm(
          `This reservation has a paid deposit of ${formatCurrency(depositAmount, country)}. Would you like to issue a refund?`
        );
        if (shouldRefund) {
          try {
            const res = await fetch('/api/payments/refund', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                paymentId: reservation.payment_id,
                businessId: business.id,
                amount: depositAmount,
                reason: 'Reservation cancelled by business',
              }),
            });
            const result = await res.json();
            if (!res.ok) {
              alert(`Refund failed: ${result.error || 'Unknown error'}`);
            }
          } catch {
            alert('Failed to process refund. You can issue it manually from the Payments page.');
          }
        }
      }
    }
    if (newStatus === 'checked_in') {
      // Date-gate: only allow if today >= check_in date
      const todayStr = new Date().toISOString().split('T')[0];
      const reservation = reservations.find(r => r.id === id);
      if (reservation && reservation.check_in > todayStr) {
        alert(`Check-in is not available until ${new Date(reservation.check_in + 'T00:00').toLocaleDateString()}`);
        return;
      }
      extra.checked_in_at = now;
      extra.checked_in_by = 'business';
    }
    if (newStatus === 'checked_out') extra.checked_out_at = now;

    await supabase.from('reservations').update({ status: newStatus, ...extra }).eq('id', id);

    // Notify guest on check-in
    if (newStatus === 'checked_in') {
      const reservation = reservations.find(r => r.id === id);
      if (reservation?.guest_phone) {
        fetch('/api/reservations/notify-checkin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reservationId: id,
            businessId: business.id,
          }),
        }).catch(() => {});
      }
    }

    loadData();
  }

  // Filtered reservations
  const filteredReservations = useMemo(() => {
    const today = new Date().toISOString().split('T')[0];
    let filtered = reservations;

    // Status filter
    if (statusFilter === 'upcoming') {
      filtered = filtered.filter(r => r.check_in >= today && ['pending', 'confirmed'].includes(r.status));
    } else if (statusFilter === 'current') {
      filtered = filtered.filter(r => ['checked_in', 'in_progress'].includes(r.status));
    } else if (statusFilter === 'past') {
      filtered = filtered.filter(r => ['checked_out', 'completed'].includes(r.status));
    } else if (statusFilter === 'cancelled') {
      filtered = filtered.filter(r => ['cancelled', 'no_show'].includes(r.status));
    }

    // Search
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(r =>
        r.guest_name?.toLowerCase().includes(q) ||
        r.reference_code?.toLowerCase().includes(q)
      );
    }

    return filtered;
  }, [reservations, statusFilter, search]);

  // Stats
  const stats = useMemo(() => {
    const today = new Date().toISOString().split('T')[0];
    const active = reservations.filter(r => !['cancelled', 'no_show'].includes(r.status));
    const totalRevenue = active.reduce((s, r) => s + Number(r.total_amount || 0), 0);
    const upcomingCheckins = reservations.filter(r => r.check_in >= today && ['pending', 'confirmed'].includes(r.status)).length;

    // Occupancy: count booked days in last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split('T')[0];
    let bookedDays = 0;
    for (const r of active) {
      const start = r.check_in > thirtyDaysAgoStr ? r.check_in : thirtyDaysAgoStr;
      const end = r.check_out < today ? r.check_out : today;
      if (start < end) {
        const diff = Math.ceil((new Date(end).getTime() - new Date(start).getTime()) / (1000 * 60 * 60 * 24));
        bookedDays += diff;
      }
    }
    const occupancyRate = Math.min(100, Math.round((bookedDays / 30) * 100));

    return { totalBookings: reservations.length, totalRevenue, occupancyRate, upcomingCheckins };
  }, [reservations]);

  // Revenue stats
  const revenueStats = useMemo(() => {
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().split('T')[0];
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0];

    const active = reservations.filter(r => !['cancelled', 'no_show'].includes(r.status));
    const thisMonth = active.filter(r => r.check_in >= thisMonthStart).reduce((s, r) => s + Number(r.total_amount || 0), 0);
    const lastMonth = active.filter(r => r.check_in >= lastMonthStart && r.check_in <= lastMonthEnd).reduce((s, r) => s + Number(r.total_amount || 0), 0);
    const totalRevenue = active.reduce((s, r) => s + Number(r.total_amount || 0), 0);

    const rates = active.filter(r => r.nightly_rate > 0).map(r => r.nightly_rate);
    const avgRate = rates.length > 0 ? Math.round(rates.reduce((s, r) => s + r, 0) / rates.length) : 0;

    const nights = active.filter(r => r.nights > 0).map(r => r.nights);
    const avgStay = nights.length > 0 ? (nights.reduce((s, n) => s + n, 0) / nights.length).toFixed(1) : '0';

    return { thisMonth, lastMonth, totalRevenue, avgRate, avgStay };
  }, [reservations]);

  // Calendar helpers
  const calendarData = useMemo(() => {
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    // Build a map of date -> status
    const dateMap: Record<string, { status: 'booked' | 'blocked'; label: string }> = {};

    // Add booked dates
    const active = reservations.filter(r => !['cancelled', 'no_show'].includes(r.status));
    for (const r of active) {
      const start = new Date(r.check_in + 'T00:00');
      const end = new Date(r.check_out + 'T00:00');
      const d = new Date(start);
      while (d < end) {
        const key = d.toISOString().split('T')[0];
        dateMap[key] = { status: 'booked', label: r.guest_name || 'Guest' };
        d.setDate(d.getDate() + 1);
      }
    }

    // Add blocked dates
    for (const bd of blockedDates) {
      const start = new Date(bd.date_from + 'T00:00');
      const end = new Date(bd.date_to + 'T00:00');
      const d = new Date(start);
      while (d <= end) {
        const key = d.toISOString().split('T')[0];
        if (!dateMap[key]) {
          dateMap[key] = { status: 'blocked', label: bd.reason || 'Blocked' };
        }
        d.setDate(d.getDate() + 1);
      }
    }

    return { firstDay, daysInMonth, dateMap };
  }, [calendarMonth, reservations, blockedDates]);

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  if (!property) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center text-center">
        <p className="text-lg font-semibold text-gray-900">{propertyLabel} not found</p>
        <p className="mt-1 text-sm text-gray-500">This {propertyLabel.toLowerCase()} may have been deleted.</p>
        <button onClick={() => router.push('/dashboard/properties')} className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-600">
          Back to {labels?.propertyNamePlural || 'Properties'}
        </button>
      </div>
    );
  }

  const today = new Date().toISOString().split('T')[0];

  if (!allowed) return null;

  return (
    <div>
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <button onClick={() => router.push('/dashboard/properties')} className="hover:text-brand transition">
          {labels?.propertyNamePlural || 'Properties'}
        </button>
        <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span className="font-medium text-gray-900">{property.name}</span>
      </div>

      {/* Property Info Header */}
      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          {property.photos && property.photos.length > 0 ? (
            <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-gray-200">
              <Image src={property.photos[0]} alt={property.name} fill className="object-cover" sizes="80px" />
            </div>
          ) : (
            <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl bg-gray-100 text-3xl">
              🏠
            </div>
          )}
          <div>
            <h1 className="text-xl font-bold text-gray-900">{property.name}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-gray-500">
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 capitalize">{property.property_type}</span>
              <span>{formatCurrency(property.price, country)}/night</span>
              <span>{property.max_guests} guest{property.max_guests !== 1 ? 's' : ''}</span>
              {property.bedrooms > 0 && <span>{property.bedrooms} bed</span>}
              {property.bathrooms > 0 && <span>{property.bathrooms} bath</span>}
            </div>
            {!property.is_active && (
              <span className="mt-1 inline-block rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-500">Inactive</span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <a
            href={`/property/${propertyId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
          >
            Share Listing
          </a>
          <button onClick={() => router.push('/dashboard/properties')} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">
            Edit {propertyLabel}
          </button>
        </div>
      </div>

      <PageHelp
        pageKey="property-detail"
        title={`${propertyLabel} Bookings`}
        description={`All bookings for this ${propertyLabel.toLowerCase()}. See who's checking in, track occupancy, and manage reservations.`}
      />

      {/* Check-in QR Code Section */}
      <CheckInQRSection propertyId={propertyId} propertyName={property.name} />

      {/* Quick Stats */}
      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
          <p className="text-xs font-medium text-gray-500">Total Bookings</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{stats.totalBookings}</p>
        </div>
        <div className="rounded-xl border border-green-100 bg-green-50 p-4">
          <p className="text-xs font-medium text-gray-500">Revenue</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{formatCurrency(stats.totalRevenue, country)}</p>
        </div>
        <div className="rounded-xl border border-brand-100 bg-brand-50 p-4">
          <p className="text-xs font-medium text-gray-500">Occupancy (30d)</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{stats.occupancyRate}%</p>
        </div>
        <div className="rounded-xl border border-yellow-100 bg-yellow-50 p-4">
          <p className="text-xs font-medium text-gray-500">Upcoming Check-ins</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{stats.upcomingCheckins}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="mt-6 flex gap-1 border-b border-gray-200">
        {([
          { id: 'bookings' as TabId, label: 'Bookings' },
          { id: 'calendar' as TabId, label: 'Calendar' },
          { id: 'revenue' as TabId, label: 'Revenue' },
        ]).map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2.5 text-sm font-medium transition border-b-2 -mb-px ${
              activeTab === tab.id ? 'border-brand text-brand' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* ═══════════ BOOKINGS TAB ═══════════ */}
      {activeTab === 'bookings' && (
        <div>
          {/* Filters */}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <div className="flex gap-1 overflow-x-auto rounded-lg border border-gray-200 bg-white p-1">
              {(['all', 'upcoming', 'current', 'past', 'cancelled'] as StatusFilter[]).map(s => (
                <button key={s} onClick={() => setStatusFilter(s)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition ${
                    statusFilter === s ? 'bg-brand text-white' : 'text-gray-600 hover:bg-gray-50'
                  }`}>
                  {s === 'current' ? 'Checked In' : s}
                </button>
              ))}
            </div>
            <input
              type="text"
              placeholder="Search guest or reference..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-brand"
            />
          </div>

          {reservations.length === 0 ? (
            <EmptyState
              icon="🏠"
              title={`No bookings for this ${propertyLabel.toLowerCase()} yet`}
              description={`Once customers book this ${propertyLabel.toLowerCase()} through your WhatsApp bot, their reservations will appear here.`}
            />
          ) : filteredReservations.length === 0 ? (
            <div className="mt-8 rounded-xl border border-dashed border-gray-200 p-12 text-center">
              <p className="text-sm text-gray-400">No reservations match your filters</p>
            </div>
          ) : (
            <div className="mt-4 overflow-x-auto rounded-xl border border-gray-100 bg-white">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-50 bg-gray-50/50">
                    <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Guest</th>
                    <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Check-in</th>
                    <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Check-out</th>
                    <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Nights</th>
                    <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Guests</th>
                    <th scope="col" className="px-4 py-3 text-right font-medium text-gray-500">Amount</th>
                    <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                    <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Ref</th>
                    <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {filteredReservations.map(r => {
                    const checkOutDate = r.check_out || (() => {
                      const d = new Date(r.check_in + 'T00:00');
                      d.setDate(d.getDate() + (r.nights || 1));
                      return d.toISOString().split('T')[0];
                    })();
                    // Contextual badges
                    const isArrivingToday = r.check_in === today && ['pending', 'confirmed'].includes(r.status);
                    const isCheckingOutToday = checkOutDate === today && ['checked_in', 'in_progress'].includes(r.status);
                    const isCurrentlyStaying = ['checked_in', 'in_progress'].includes(r.status);
                    return (
                      <tr key={r.id} className="cursor-pointer hover:bg-gray-50/50" onClick={() => setSelectedReservation(r)}>
                        <td className="px-4 py-3">
                          <p className="font-medium text-gray-900">{r.guest_name || '—'}</p>
                          <p className="text-xs text-gray-400">{r.guest_phone}</p>
                        </td>
                        <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                          {new Date(r.check_in + 'T00:00').toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })}
                        </td>
                        <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                          {new Date(checkOutDate + 'T00:00').toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })}
                        </td>
                        <td className="px-4 py-3 text-gray-600">{r.nights || '—'}</td>
                        <td className="px-4 py-3 text-gray-600">{r.guests || 1}</td>
                        <td className="px-4 py-3 text-right font-medium text-gray-900">
                          {formatCurrency(r.total_amount || 0, country)}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusColors[r.status] || 'bg-gray-100 text-gray-600'}`}>
                            {statusLabels[r.status] || r.status.replace('_', ' ')}
                          </span>
                          {isArrivingToday && (
                            <span className="ml-1 rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-medium text-orange-700">Arriving Today</span>
                          )}
                          {isCurrentlyStaying && !isCheckingOutToday && (
                            <span className="ml-1 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700">Currently Staying</span>
                          )}
                          {isCheckingOutToday && (
                            <span className="ml-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">Checking Out Today</span>
                          )}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-gray-400">{r.reference_code}</td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                            {(reservationActions[r.status] || []).map(action => (
                              <button
                                key={action.next}
                                onClick={() => updateReservationStatus(r.id, action.next)}
                                className={`rounded px-3 py-1.5 text-xs font-medium ${action.color}`}
                              >
                                {action.label}
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ═══════════ CALENDAR TAB ═══════════ */}
      {activeTab === 'calendar' && (
        <div className="mt-4">
          {/* Month navigation */}
          <div className="flex items-center justify-between">
            <button onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}
              className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
              <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <h3 className="text-lg font-semibold text-gray-900">
              {calendarMonth.toLocaleDateString(locale, { month: 'long', year: 'numeric' })}
            </h3>
            <button onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}
              className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
              <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>

          {/* Legend */}
          <div className="mt-3 flex gap-4 text-xs text-gray-500">
            <div className="flex items-center gap-1.5">
              <div className="h-3 w-3 rounded bg-green-100 border border-green-300" />
              <span>Available</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="h-3 w-3 rounded bg-red-100 border border-red-300" />
              <span>Booked</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="h-3 w-3 rounded bg-gray-200 border border-gray-300" />
              <span>Blocked</span>
            </div>
          </div>

          {/* Calendar grid */}
          <div className="mt-3 overflow-hidden rounded-xl border border-gray-200 bg-white">
            {/* Day headers */}
            <div className="grid grid-cols-7 border-b border-gray-100 bg-gray-50">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
                <div key={d} className="px-2 py-2 text-center text-xs font-medium text-gray-500">{d}</div>
              ))}
            </div>
            {/* Days */}
            <div className="grid grid-cols-7">
              {/* Empty cells for days before month starts */}
              {Array.from({ length: calendarData.firstDay }).map((_, i) => (
                <div key={`empty-${i}`} className="border-b border-r border-gray-50 p-2 min-h-[72px]" />
              ))}
              {/* Day cells */}
              {Array.from({ length: calendarData.daysInMonth }).map((_, i) => {
                const day = i + 1;
                const dateStr = `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                const entry = calendarData.dateMap[dateStr];
                const isToday = dateStr === today;

                let bgClass = '';
                let textClass = 'text-gray-400';
                if (entry?.status === 'booked') {
                  bgClass = 'bg-red-50';
                  textClass = 'text-red-700';
                } else if (entry?.status === 'blocked') {
                  bgClass = 'bg-gray-100';
                  textClass = 'text-gray-500';
                } else {
                  bgClass = 'bg-green-50/50';
                }

                return (
                  <div key={day} className={`border-b border-r border-gray-50 p-1.5 min-h-[72px] ${bgClass}`}>
                    <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
                      isToday ? 'bg-brand text-white' : 'text-gray-700'
                    }`}>
                      {day}
                    </span>
                    {entry && (
                      <p className={`mt-0.5 truncate text-[10px] font-medium ${textClass}`}>
                        {entry.label}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ═══════════ REVENUE TAB ═══════════ */}
      {activeTab === 'revenue' && (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-xl border border-gray-100 bg-white p-5">
              <p className="text-xs font-medium text-gray-500">Total Revenue</p>
              <p className="mt-2 text-2xl font-bold text-gray-900">{formatCurrency(revenueStats.totalRevenue, country)}</p>
            </div>
            <div className="rounded-xl border border-gray-100 bg-white p-5">
              <p className="text-xs font-medium text-gray-500">This Month</p>
              <p className="mt-2 text-2xl font-bold text-gray-900">{formatCurrency(revenueStats.thisMonth, country)}</p>
              {revenueStats.lastMonth > 0 && (
                <p className={`mt-1 text-xs ${revenueStats.thisMonth >= revenueStats.lastMonth ? 'text-green-600' : 'text-red-600'}`}>
                  {revenueStats.thisMonth >= revenueStats.lastMonth ? '↑' : '↓'} vs last month ({formatCurrency(revenueStats.lastMonth, country)})
                </p>
              )}
            </div>
            <div className="rounded-xl border border-gray-100 bg-white p-5">
              <p className="text-xs font-medium text-gray-500">Last Month</p>
              <p className="mt-2 text-2xl font-bold text-gray-900">{formatCurrency(revenueStats.lastMonth, country)}</p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-gray-100 bg-white p-5">
              <p className="text-xs font-medium text-gray-500">Average Nightly Rate</p>
              <p className="mt-2 text-2xl font-bold text-gray-900">{formatCurrency(revenueStats.avgRate, country)}</p>
            </div>
            <div className="rounded-xl border border-gray-100 bg-white p-5">
              <p className="text-xs font-medium text-gray-500">Average Stay Duration</p>
              <p className="mt-2 text-2xl font-bold text-gray-900">{revenueStats.avgStay} nights</p>
            </div>
          </div>

          {reservations.length === 0 && (
            <EmptyState
              icon="🏠"
              title={`No bookings for this ${propertyLabel.toLowerCase()} yet`}
              description={`Once customers book this ${propertyLabel.toLowerCase()} through your WhatsApp bot, their reservations will appear here.`}
            />
          )}
        </div>
      )}

      {/* ═══════════ RESERVATION DETAIL PANEL ═══════════ */}
      {selectedReservation && (
        <div className="fixed inset-0 z-50 flex justify-end" onClick={() => setSelectedReservation(null)}>
          <div className="fixed inset-0 bg-black/30" />
          <div className="relative z-10 h-full w-full max-w-lg overflow-y-auto bg-white shadow-xl" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-100 bg-white px-6 py-4">
              <div>
                <p className="font-mono text-lg font-bold text-brand">{selectedReservation.reference_code}</p>
                <span className={`mt-1 inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusColors[selectedReservation.status] || 'bg-gray-100 text-gray-600'}`}>
                  {statusLabels[selectedReservation.status] || selectedReservation.status.replace('_', ' ')}
                </span>
              </div>
              <button aria-label="Close" onClick={() => setSelectedReservation(null)} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100">
                <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="space-y-5 px-6 py-5">
              {/* Guest Info */}
              <div className="rounded-lg bg-gray-50 p-4">
                <h3 className="text-xs font-semibold uppercase text-gray-400 mb-2">Guest</h3>
                <p className="text-sm font-semibold text-gray-900">{selectedReservation.guest_name || '—'}</p>
                {selectedReservation.guest_phone && <p className="text-sm text-gray-600">{selectedReservation.guest_phone}</p>}
                {selectedReservation.guest_email && <p className="text-sm text-gray-600">{selectedReservation.guest_email}</p>}
              </div>

              {/* Booking Details */}
              <div>
                <h3 className="text-xs font-semibold uppercase text-gray-400 mb-3">Details</h3>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-gray-400">Check-in</span>
                    <p className="font-medium text-gray-900">
                      {new Date(selectedReservation.check_in + 'T00:00').toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' })}
                    </p>
                  </div>
                  <div>
                    <span className="text-gray-400">Check-out</span>
                    <p className="font-medium text-gray-900">
                      {selectedReservation.check_out
                        ? new Date(selectedReservation.check_out + 'T00:00').toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' })
                        : '—'}
                    </p>
                  </div>
                  <div>
                    <span className="text-gray-400">Nights</span>
                    <p className="font-medium text-gray-900">{selectedReservation.nights || '—'}</p>
                  </div>
                  <div>
                    <span className="text-gray-400">Guests</span>
                    <p className="font-medium text-gray-900">{selectedReservation.guests || 1}</p>
                  </div>
                  <div>
                    <span className="text-gray-400">Channel</span>
                    <p className="font-medium text-gray-900">{selectedReservation.channel || 'whatsapp'}</p>
                  </div>
                </div>
              </div>

              {/* Payment */}
              <div className="rounded-lg border border-gray-200 p-4">
                <h3 className="text-xs font-semibold uppercase text-gray-400 mb-3">Payment</h3>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-gray-400">Total</span>
                    <p className="text-lg font-bold text-gray-900">{formatCurrency(selectedReservation.total_amount || 0, country)}</p>
                  </div>
                  <div>
                    <span className="text-gray-400">Deposit</span>
                    <p className="font-medium text-gray-900">
                      {selectedReservation.deposit_amount ? formatCurrency(selectedReservation.deposit_amount, country) : 'None'}
                      {selectedReservation.deposit_status && selectedReservation.deposit_status !== 'none' && (
                        <span className={`ml-1 rounded-full px-1.5 py-0.5 text-xs ${
                          selectedReservation.deposit_status === 'paid' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                        }`}>
                          {selectedReservation.deposit_status}
                        </span>
                      )}
                    </p>
                  </div>
                  {selectedReservation.nightly_rate > 0 && (
                    <div>
                      <span className="text-gray-400">Nightly Rate</span>
                      <p className="font-medium text-gray-900">{formatCurrency(selectedReservation.nightly_rate, country)}</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Special Requests */}
              {selectedReservation.special_requests && (
                <div className="rounded-lg bg-yellow-50 border border-yellow-200 p-4">
                  <h3 className="text-xs font-semibold uppercase text-yellow-700 mb-2">Special Requests</h3>
                  <p className="text-sm text-yellow-800 whitespace-pre-line">{selectedReservation.special_requests}</p>
                </div>
              )}

              {/* Notes */}
              {selectedReservation.notes && (
                <div>
                  <h3 className="text-xs font-semibold uppercase text-gray-400 mb-2">Notes</h3>
                  <p className="text-sm text-gray-600 bg-gray-50 rounded-lg px-3 py-2">{selectedReservation.notes}</p>
                </div>
              )}

              {/* Timeline */}
              <div>
                <h3 className="text-xs font-semibold uppercase text-gray-400 mb-3">Timeline</h3>
                <div className="space-y-2 text-xs">
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-2 rounded-full bg-gray-400" />
                    <span className="text-gray-500">Created</span>
                    <span className="ml-auto text-gray-400">{new Date(selectedReservation.created_at).toLocaleString()}</span>
                  </div>
                  {selectedReservation.confirmed_at && (
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-2 rounded-full bg-green-500" />
                      <span className="text-gray-500">Confirmed</span>
                      <span className="ml-auto text-gray-400">{new Date(selectedReservation.confirmed_at).toLocaleString()}</span>
                    </div>
                  )}
                  {selectedReservation.checked_in_at && (
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-2 rounded-full bg-blue-500" />
                      <span className="text-gray-500">Checked In</span>
                      <span className="ml-auto text-gray-400">{new Date(selectedReservation.checked_in_at).toLocaleString()}</span>
                    </div>
                  )}
                  {selectedReservation.checked_out_at && (
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-2 rounded-full bg-gray-600" />
                      <span className="text-gray-500">Checked Out</span>
                      <span className="ml-auto text-gray-400">{new Date(selectedReservation.checked_out_at).toLocaleString()}</span>
                    </div>
                  )}
                  {selectedReservation.cancelled_at && (
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-2 rounded-full bg-red-500" />
                      <span className="text-gray-500">Cancelled</span>
                      <span className="ml-auto text-gray-400">{new Date(selectedReservation.cancelled_at).toLocaleString()}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Actions */}
              {reservationActions[selectedReservation.status] && reservationActions[selectedReservation.status].length > 0 && (
                <div className="border-t border-gray-100 pt-4">
                  <div className="flex flex-wrap gap-2">
                    {reservationActions[selectedReservation.status].map(action => (
                      <button key={action.next}
                        onClick={() => { updateReservationStatus(selectedReservation.id, action.next); setSelectedReservation(null); }}
                        className={`rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium ${action.color}`}>
                        {action.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
