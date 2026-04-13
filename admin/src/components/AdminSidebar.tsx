import { useNavigate, useLocation } from 'react-router';
import {
  LayoutDashboard,
  Building2,
  Wallet,
  BarChart3,
  ScrollText,
  LogOut,
  CreditCard,
  RefreshCw,
  Users,
  ShieldCheck,
  BadgeCheck,
  UserCog,
  ClipboardList,
  ShoppingCart,
  Bot,
  Hash,
  MessageCircle,
  Bell,
  Megaphone,
  LifeBuoy,
  FileText,
  CalendarDays,
  Target,
  Settings,
  Eye,
  Layers,
  Contact,
  Heart,
  Globe,
  Repeat,
  ListOrdered,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import type { LucideIcon } from 'lucide-react';

interface NavItem {
  icon: LucideIcon;
  label: string;
  path: string;
}

const navSections: { label: string; items: NavItem[] }[] = [
  {
    label: 'Overview',
    items: [
      { icon: LayoutDashboard, label: 'Dashboard', path: '/dashboard' },
    ],
  },
  {
    label: 'Users',
    items: [
      { icon: Users, label: 'Users', path: '/users' },
      { icon: Contact, label: 'Customers', path: '/customers' },
      { icon: ShieldCheck, label: 'Admin Team', path: '/admin-team' },
    ],
  },
  {
    label: 'Businesses',
    items: [
      { icon: Building2, label: 'Businesses', path: '/businesses' },
      { icon: BadgeCheck, label: 'Verification', path: '/verification' },
      { icon: Layers, label: 'Category Templates', path: '/category-templates' },
      { icon: UserCog, label: 'Impersonation', path: '/impersonation' },
      { icon: Eye, label: 'Impersonation Audit', path: '/impersonation-audit' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { icon: ClipboardList, label: 'Bookings', path: '/bookings' },
      { icon: ShoppingCart, label: 'Orders', path: '/orders' },
      { icon: CreditCard, label: 'Payments', path: '/payments' },
      { icon: RefreshCw, label: 'Subscriptions', path: '/subscriptions' },
      { icon: Repeat, label: 'Recurring', path: '/recurring' },
    ],
  },
  {
    label: 'Healthcare',
    items: [
      { icon: FileText, label: 'Reports', path: '/reports' },
      { icon: ListOrdered, label: 'Queue Mgmt', path: '/queue-management' },
    ],
  },
  {
    label: 'Communication',
    items: [
      { icon: Bot, label: 'Bot Management', path: '/bot-management' },
      { icon: Hash, label: 'Bot Keywords', path: '/bot-keywords' },
      { icon: MessageCircle, label: 'WhatsApp Channels', path: '/whatsapp-channels' },
      { icon: Bell, label: 'Notifications', path: '/notifications' },
      { icon: Megaphone, label: 'Broadcasts', path: '/broadcasts' },
      { icon: LifeBuoy, label: 'Support', path: '/support' },
    ],
  },
  {
    label: 'Giving',
    items: [
      { icon: Heart, label: 'Giving', path: '/giving' },
    ],
  },
  {
    label: 'Finance',
    items: [
      { icon: Wallet, label: 'Payouts', path: '/payouts' },
      { icon: BarChart3, label: 'Finance', path: '/finance' },
    ],
  },
  {
    label: 'Content & System',
    items: [
      { icon: FileText, label: 'Content Management', path: '/content' },
      { icon: CalendarDays, label: 'Events', path: '/events' },
      { icon: Target, label: 'Campaigns', path: '/campaigns' },
      { icon: Globe, label: 'Countries', path: '/countries' },
      { icon: Settings, label: 'Platform Settings', path: '/platform-settings' },
      { icon: ScrollText, label: 'Audit Log', path: '/audit-log' },
    ],
  },
];

export function AdminSidebar() {
  const navigate = useNavigate();
  const location = useLocation();

  const isActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(path + '/');

  async function handleLogout() {
    await supabase.auth.signOut();
    navigate('/login');
  }

  return (
    <nav className="w-64 h-screen bg-white border-r border-gray-200 flex flex-col shrink-0">
      {/* Logo */}
      <div className="p-6 border-b border-gray-200">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-sm font-bold text-white">
            S
          </div>
          <div className="text-left">
            <p className="text-sm font-bold text-gray-900">Waaiio</p>
            <p className="text-[10px] text-gray-400">Admin Console</p>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {navSections.map((section) => (
          <div key={section.label}>
            <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              {section.label}
            </p>
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.path);
                return (
                  <button
                    key={item.path}
                    onClick={() => navigate(item.path)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm transition cursor-pointer ${
                      active
                        ? 'bg-brand-50 border border-brand-100'
                        : 'border border-transparent hover:bg-gray-50'
                    }`}
                  >
                    <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-brand' : 'text-gray-400'}`} />
                    <span className={`truncate ${active ? 'text-brand font-semibold' : 'text-gray-600'}`}>
                      {item.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Logout */}
      <div className="p-4 border-t border-gray-200">
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-gray-500 hover:bg-red-50 hover:text-red-600 transition cursor-pointer"
        >
          <LogOut className="w-4 h-4" />
          <span>Sign Out</span>
        </button>
      </div>
    </nav>
  );
}
