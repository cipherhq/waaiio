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
  Handshake,
  Heart,
  Globe,
  Repeat,
  ListOrdered,
  Ticket,
  BrainCircuit,
  AlertTriangle,
  Sun,
  Moon,
  Zap,
  Activity,
  MessagesSquare,
  Inbox,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAdminSession } from './AdminLayout';
import type { LucideIcon } from 'lucide-react';

type AdminRole = 'admin' | 'support' | 'finance' | 'operations';

interface NavItem {
  icon: LucideIcon;
  label: string;
  path: string;
  /** Roles that can see this item. Omit = everyone */
  roles?: AdminRole[];
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
      { icon: Users, label: 'Users', path: '/users', roles: ['admin'] },
      { icon: Contact, label: 'Customers', path: '/customers', roles: ['admin', 'support', 'operations'] },
      { icon: ShieldCheck, label: 'Admin Team', path: '/admin-team', roles: ['admin'] },
    ],
  },
  {
    label: 'Accounts',
    items: [
      { icon: Building2, label: 'Accounts', path: '/businesses', roles: ['admin', 'support', 'operations'] },
      { icon: BadgeCheck, label: 'Verification', path: '/verification', roles: ['admin', 'operations'] },
      { icon: Layers, label: 'Category Templates', path: '/category-templates', roles: ['admin'] },
      { icon: UserCog, label: 'Impersonation', path: '/impersonation', roles: ['admin'] },
      { icon: Eye, label: 'Impersonation Audit', path: '/impersonation-audit', roles: ['admin'] },
      { icon: Handshake, label: 'Resellers', path: '/resellers', roles: ['admin'] },
      { icon: Inbox, label: 'Demo Requests', path: '/demo-requests', roles: ['admin', 'support'] },
    ],
  },
  {
    label: 'Operations',
    items: [
      { icon: ClipboardList, label: 'Bookings', path: '/bookings', roles: ['admin', 'support', 'operations'] },
      { icon: ShoppingCart, label: 'Orders', path: '/orders', roles: ['admin', 'support', 'operations'] },
      { icon: CreditCard, label: 'Payments', path: '/payments', roles: ['admin', 'finance'] },
      { icon: RefreshCw, label: 'Subscriptions', path: '/subscriptions', roles: ['admin', 'finance'] },
      { icon: Repeat, label: 'Recurring', path: '/recurring', roles: ['admin', 'finance'] },
      { icon: Ticket, label: 'Tickets', path: '/tickets', roles: ['admin', 'support', 'operations'] },
      { icon: AlertTriangle, label: 'Alerts', path: '/alerts', roles: ['admin', 'support', 'operations'] },
      { icon: ClipboardList, label: 'Surveys', path: '/surveys', roles: ['admin', 'operations'] },
    ],
  },
  {
    label: 'Reports & Queues',
    items: [
      { icon: FileText, label: 'Reports', path: '/reports', roles: ['admin', 'operations'] },
      { icon: ListOrdered, label: 'Queue Mgmt', path: '/queue-management', roles: ['admin', 'operations'] },
    ],
  },
  {
    label: 'Communication',
    items: [
      { icon: Bot, label: 'Bot Management', path: '/bot-management', roles: ['admin', 'operations'] },
      { icon: Hash, label: 'Bot Keywords', path: '/bot-keywords', roles: ['admin', 'operations'] },
      { icon: BrainCircuit, label: 'LLM Logs', path: '/llm-logs', roles: ['admin'] },
      { icon: MessageCircle, label: 'WhatsApp Channels', path: '/whatsapp-channels', roles: ['admin', 'operations'] },
      { icon: FileText, label: 'WA Templates', path: '/whatsapp-templates', roles: ['admin'] },
      { icon: Bell, label: 'Notifications', path: '/notifications', roles: ['admin'] },
      { icon: Megaphone, label: 'Broadcasts', path: '/broadcasts', roles: ['admin'] },
      { icon: LifeBuoy, label: 'Support', path: '/support', roles: ['admin', 'support'] },
      { icon: MessagesSquare, label: 'Chat History', path: '/chat-history', roles: ['admin', 'support', 'operations'] },
    ],
  },
  {
    label: 'Giving',
    items: [
      { icon: Heart, label: 'Giving', path: '/giving', roles: ['admin', 'finance'] },
    ],
  },
  {
    label: 'Finance',
    items: [
      { icon: Wallet, label: 'Payouts', path: '/payouts', roles: ['admin', 'finance'] },
      { icon: BarChart3, label: 'Finance', path: '/finance', roles: ['admin', 'finance'] },
    ],
  },
  {
    label: 'Content & System',
    items: [
      { icon: FileText, label: 'Content Management', path: '/content', roles: ['admin'] },
      { icon: CalendarDays, label: 'Events', path: '/events', roles: ['admin', 'operations'] },
      { icon: Target, label: 'Campaigns', path: '/campaigns', roles: ['admin', 'operations'] },
      { icon: Globe, label: 'Countries', path: '/countries', roles: ['admin'] },
      { icon: Zap, label: 'AI Setup Log', path: '/ai-setup-log', roles: ['admin'] },
      { icon: BrainCircuit, label: 'AI Usage', path: '/ai-usage', roles: ['admin'] },
      { icon: MessageCircle, label: 'Conversation Usage', path: '/conversation-usage', roles: ['admin'] },
      { icon: Settings, label: 'Platform Settings', path: '/platform-settings', roles: ['admin'] },
      { icon: ScrollText, label: 'Audit Log', path: '/audit-log', roles: ['admin'] },
      { icon: Activity, label: 'System Health', path: '/system-health', roles: ['admin'] },
    ],
  },
];

export function AdminSidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const session = useAdminSession();
  const userRole = (session?.role || 'support') as AdminRole;

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
          <img src="/logo.png" alt="Waaiio" className="h-8" />
          <p className="text-[10px] text-gray-400">Admin Console</p>
        </div>
      </div>

      {/* Navigation */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {navSections.map((section) => {
          // Filter items by role
          const visibleItems = section.items.filter(item => !item.roles || item.roles.includes(userRole));
          if (visibleItems.length === 0) return null;

          return (
          <div key={section.label}>
            <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              {section.label}
            </p>
            <div className="space-y-0.5">
              {visibleItems.map((item) => {
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
          );
        })}
      </div>

      {/* Theme + Logout */}
      <div className="p-4 border-t border-gray-200 dark:border-gray-700 space-y-1">
        <button
          onClick={() => {
            const isDark = document.documentElement.classList.toggle('dark');
            localStorage.setItem('admin-theme', isDark ? 'dark' : 'light');
          }}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 transition cursor-pointer"
        >
          <Sun className="w-4 h-4 hidden dark:block" />
          <Moon className="w-4 h-4 block dark:hidden" />
          <span className="hidden dark:inline">Light Mode</span>
          <span className="inline dark:hidden">Dark Mode</span>
        </button>
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
