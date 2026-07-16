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
  Landmark,
  FileSpreadsheet,
  ScanLine,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAdminSession } from './AdminLayout';
import { ADMIN_PERMISSIONS } from '@/lib/permissions';
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
      { icon: Users, label: 'Users', path: '/users', roles: ADMIN_PERMISSIONS['users'] },
      { icon: Contact, label: 'Customers', path: '/customers', roles: ADMIN_PERMISSIONS['customers'] },
      { icon: ShieldCheck, label: 'Admin Team', path: '/admin-team', roles: ADMIN_PERMISSIONS['admin-team'] },
    ],
  },
  {
    label: 'Accounts',
    items: [
      { icon: Building2, label: 'Accounts', path: '/businesses', roles: ADMIN_PERMISSIONS['businesses'] },
      { icon: BadgeCheck, label: 'Verification', path: '/verification', roles: ADMIN_PERMISSIONS['verification'] },
      { icon: Layers, label: 'Category Templates', path: '/category-templates', roles: ADMIN_PERMISSIONS['category-templates'] },
      { icon: UserCog, label: 'Impersonation', path: '/impersonation', roles: ADMIN_PERMISSIONS['impersonation'] },
      { icon: Eye, label: 'Impersonation Audit', path: '/impersonation-audit', roles: ADMIN_PERMISSIONS['impersonation-audit'] },
      { icon: Handshake, label: 'Resellers', path: '/resellers', roles: ADMIN_PERMISSIONS['resellers'] },
      { icon: Inbox, label: 'Demo Requests', path: '/demo-requests', roles: ADMIN_PERMISSIONS['demo-requests'] },
      { icon: BarChart3, label: 'Reseller Financials', path: '/reseller-financials', roles: ADMIN_PERMISSIONS['reseller-financials'] },
      { icon: Wallet, label: 'Reseller Payouts', path: '/reseller-payouts', roles: ADMIN_PERMISSIONS['reseller-payouts'] },
    ],
  },
  {
    label: 'Operations',
    items: [
      { icon: ClipboardList, label: 'Bookings', path: '/bookings', roles: ADMIN_PERMISSIONS['bookings'] },
      { icon: ShoppingCart, label: 'Orders', path: '/orders', roles: ADMIN_PERMISSIONS['orders'] },
      { icon: CreditCard, label: 'Payments', path: '/payments', roles: ADMIN_PERMISSIONS['payments'] },
      { icon: RefreshCw, label: 'Subscriptions', path: '/subscriptions', roles: ADMIN_PERMISSIONS['subscriptions'] },
      { icon: Repeat, label: 'Recurring', path: '/recurring', roles: ADMIN_PERMISSIONS['recurring'] },
      { icon: Landmark, label: 'Bank Transfers', path: '/pending-transfers', roles: ADMIN_PERMISSIONS['pending-transfers'] },
      { icon: Ticket, label: 'Tickets', path: '/tickets', roles: ADMIN_PERMISSIONS['tickets'] },
      { icon: AlertTriangle, label: 'Alerts', path: '/alerts', roles: ADMIN_PERMISSIONS['alerts'] },
      { icon: ClipboardList, label: 'Surveys', path: '/surveys', roles: ADMIN_PERMISSIONS['surveys'] },
    ],
  },
  {
    label: 'Reports & Queues',
    items: [
      { icon: FileText, label: 'Reports', path: '/reports', roles: ADMIN_PERMISSIONS['reports'] },
      { icon: ListOrdered, label: 'Queue Mgmt', path: '/queue-management', roles: ADMIN_PERMISSIONS['queue-management'] },
      { icon: ScanLine, label: 'Engagement', path: '/engagement', roles: ADMIN_PERMISSIONS['engagement'] },
    ],
  },
  {
    label: 'Communication',
    items: [
      { icon: Bot, label: 'Bot Management', path: '/bot-management', roles: ADMIN_PERMISSIONS['bot-management'] },
      { icon: Hash, label: 'Bot Keywords', path: '/bot-keywords', roles: ADMIN_PERMISSIONS['bot-keywords'] },
      { icon: BrainCircuit, label: 'LLM Logs', path: '/llm-logs', roles: ADMIN_PERMISSIONS['llm-logs'] },
      { icon: MessageCircle, label: 'WhatsApp Channels', path: '/whatsapp-channels', roles: ADMIN_PERMISSIONS['whatsapp-channels'] },
      { icon: FileText, label: 'WA Templates', path: '/whatsapp-templates', roles: ADMIN_PERMISSIONS['whatsapp-templates'] },
      { icon: Bell, label: 'Notifications', path: '/notifications', roles: ADMIN_PERMISSIONS['notifications'] },
      { icon: Megaphone, label: 'Broadcasts', path: '/broadcasts', roles: ADMIN_PERMISSIONS['broadcasts'] },
      { icon: LifeBuoy, label: 'Support', path: '/support', roles: ADMIN_PERMISSIONS['support'] },
      { icon: MessagesSquare, label: 'Chat History', path: '/chat-history', roles: ADMIN_PERMISSIONS['chat-history'] },
    ],
  },
  {
    label: 'Giving',
    items: [
      { icon: Heart, label: 'Giving', path: '/giving', roles: ADMIN_PERMISSIONS['giving'] },
    ],
  },
  {
    label: 'Finance',
    items: [
      { icon: Wallet, label: 'Payouts', path: '/payouts', roles: ADMIN_PERMISSIONS['payouts'] },
      { icon: BarChart3, label: 'Finance', path: '/finance', roles: ADMIN_PERMISSIONS['finance'] },
      { icon: FileSpreadsheet, label: 'Fee Invoices', path: '/fee-invoices', roles: ADMIN_PERMISSIONS['fee-invoices'] },
    ],
  },
  {
    label: 'Content & System',
    items: [
      { icon: FileText, label: 'Content Management', path: '/content', roles: ADMIN_PERMISSIONS['content'] },
      { icon: CalendarDays, label: 'Events', path: '/events', roles: ADMIN_PERMISSIONS['events'] },
      { icon: Target, label: 'Campaigns', path: '/campaigns', roles: ADMIN_PERMISSIONS['campaigns'] },
      { icon: Globe, label: 'Countries', path: '/countries', roles: ADMIN_PERMISSIONS['countries'] },
      { icon: Zap, label: 'AI Setup Log', path: '/ai-setup-log', roles: ADMIN_PERMISSIONS['ai-setup-log'] },
      { icon: BrainCircuit, label: 'AI Usage', path: '/ai-usage', roles: ADMIN_PERMISSIONS['ai-usage'] },
      { icon: MessageCircle, label: 'Conversation Usage', path: '/conversation-usage', roles: ADMIN_PERMISSIONS['conversation-usage'] },
      { icon: Settings, label: 'Platform Settings', path: '/platform-settings', roles: ADMIN_PERMISSIONS['platform-settings'] },
      { icon: ScrollText, label: 'Audit Log', path: '/audit-log', roles: ADMIN_PERMISSIONS['audit-log'] },
      { icon: Activity, label: 'System Health', path: '/system-health', roles: ADMIN_PERMISSIONS['system-health'] },
      { icon: ShieldCheck, label: 'Permissions', path: '/permissions', roles: ADMIN_PERMISSIONS['permissions'] },
    ],
  },
];

interface AdminSidebarProps {
  mobileOpen?: boolean;
  onClose?: () => void;
}

export function AdminSidebar({ mobileOpen, onClose }: AdminSidebarProps) {
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
    <>
      {/* Backdrop overlay for mobile */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-30 lg:hidden"
          onClick={onClose}
        />
      )}
      <nav className={`
        w-64 h-screen bg-white border-r border-gray-200 flex flex-col shrink-0
        fixed inset-y-0 left-0 z-40 transition-transform duration-200 ease-in-out
        lg:relative lg:translate-x-0
        ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
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
                    onClick={() => { navigate(item.path); onClose?.(); }}
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
    </>
  );
}
