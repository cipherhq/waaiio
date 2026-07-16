import { createBrowserRouter, Navigate } from 'react-router';
import { AdminLayout, useAdminSession } from './components/AdminLayout';
import type { AdminRole } from './lib/adminAuth';
import { ADMIN_PERMISSIONS } from './lib/permissions';
import Login from './pages/Login';

function RoleGuard({ roles, children }: { roles: AdminRole[]; children: React.ReactNode }) {
  const session = useAdminSession();
  if (!session || !roles.includes(session.role)) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Access Restricted</h2>
          <p className="text-gray-500">You don't have permission to view this page.</p>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
import Dashboard from './pages/Dashboard';
import Businesses from './pages/Businesses';
import Payouts from './pages/Payouts';
import Finance from './pages/Finance';
import AuditLog from './pages/AuditLog';
import Users from './pages/Users';
import AdminTeam from './pages/AdminTeam';
import Bookings from './pages/Bookings';
import Orders from './pages/Orders';
import Payments from './pages/Payments';
import Subscriptions from './pages/Subscriptions';
import Support from './pages/Support';
import BotManagement from './pages/BotManagement';
import WhatsAppChannels from './pages/WhatsAppChannels';
import WhatsAppTemplates from './pages/WhatsAppTemplates';
import Notifications from './pages/Notifications';
import Broadcasts from './pages/Broadcasts';
import ContentManagement from './pages/ContentManagement';
import Events from './pages/Events';
import Campaigns from './pages/Campaigns';
import PlatformSettings from './pages/PlatformSettings';
import ImpersonationMode from './pages/ImpersonationMode';
import ImpersonationAudit from './pages/ImpersonationAudit';
import CategoryTemplates from './pages/CategoryTemplates';
import BotKeywords from './pages/BotKeywords';
import Customers from './pages/WhatsAppCustomers';
import Giving from './pages/Giving';
import Verification from './pages/Verification';
import Countries from './pages/Countries';
import RecurringPayments from './pages/RecurringPayments';
import Reports from './pages/Reports';
import QueueManagement from './pages/QueueManagement';
import EngagementActivity from './pages/EngagementActivity';
import Tickets from './pages/Tickets';
import LLMClassifications from './pages/LLMClassifications';
import Alerts from './pages/Alerts';
import AIUsage from './pages/AIUsage';
import ConversationUsage from './pages/ConversationUsage';
import Surveys from './pages/Surveys';
import AISetupLog from './pages/AISetupLog';
import SystemHealth from './pages/SystemHealth';
import ChatHistory from './pages/ChatHistory';
import Resellers from './pages/Resellers';
import DemoRequests from './pages/DemoRequests';
import ResellerFinancials from './pages/ResellerFinancials';
import ResellerPayouts from './pages/ResellerPayouts';
import PendingTransfers from './pages/PendingTransfers';
import FeeInvoices from './pages/FeeInvoices';
import AdminPermissions from './pages/AdminPermissions';
import AIMarketplace from './pages/AIMarketplace';

export const router = createBrowserRouter([
  { path: '/login', Component: Login },
  {
    path: '/',
    Component: AdminLayout,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', Component: Dashboard },
      // Users
      { path: 'users', element: <RoleGuard roles={ADMIN_PERMISSIONS['users']}><Users /></RoleGuard> },
      { path: 'customers', element: <RoleGuard roles={ADMIN_PERMISSIONS['customers']}><Customers /></RoleGuard> },
      { path: 'admin-team', element: <RoleGuard roles={ADMIN_PERMISSIONS['admin-team']}><AdminTeam /></RoleGuard> },
      // Businesses
      { path: 'businesses', element: <RoleGuard roles={ADMIN_PERMISSIONS['businesses']}><Businesses /></RoleGuard> },
      { path: 'verification', element: <RoleGuard roles={ADMIN_PERMISSIONS['verification']}><Verification /></RoleGuard> },
      { path: 'category-templates', element: <RoleGuard roles={ADMIN_PERMISSIONS['category-templates']}><CategoryTemplates /></RoleGuard> },
      { path: 'impersonation', element: <RoleGuard roles={ADMIN_PERMISSIONS['impersonation']}><ImpersonationMode /></RoleGuard> },
      { path: 'impersonation-audit', element: <RoleGuard roles={ADMIN_PERMISSIONS['impersonation-audit']}><ImpersonationAudit /></RoleGuard> },
      { path: 'resellers', element: <RoleGuard roles={ADMIN_PERMISSIONS['resellers']}><Resellers /></RoleGuard> },
      { path: 'demo-requests', element: <RoleGuard roles={ADMIN_PERMISSIONS['demo-requests']}><DemoRequests /></RoleGuard> },
      { path: 'reseller-financials', element: <RoleGuard roles={ADMIN_PERMISSIONS['reseller-financials']}><ResellerFinancials /></RoleGuard> },
      { path: 'reseller-payouts', element: <RoleGuard roles={ADMIN_PERMISSIONS['reseller-payouts']}><ResellerPayouts /></RoleGuard> },
      // Operations
      { path: 'bookings', element: <RoleGuard roles={ADMIN_PERMISSIONS['bookings']}><Bookings /></RoleGuard> },
      { path: 'orders', element: <RoleGuard roles={ADMIN_PERMISSIONS['orders']}><Orders /></RoleGuard> },
      { path: 'payments', element: <RoleGuard roles={ADMIN_PERMISSIONS['payments']}><Payments /></RoleGuard> },
      { path: 'subscriptions', element: <RoleGuard roles={ADMIN_PERMISSIONS['subscriptions']}><Subscriptions /></RoleGuard> },
      { path: 'recurring', element: <RoleGuard roles={ADMIN_PERMISSIONS['recurring']}><RecurringPayments /></RoleGuard> },
      { path: 'pending-transfers', element: <RoleGuard roles={ADMIN_PERMISSIONS['pending-transfers']}><PendingTransfers /></RoleGuard> },
      { path: 'tickets', element: <RoleGuard roles={ADMIN_PERMISSIONS['tickets']}><Tickets /></RoleGuard> },
      { path: 'alerts', element: <RoleGuard roles={ADMIN_PERMISSIONS['alerts']}><Alerts /></RoleGuard> },
      { path: 'reports', element: <RoleGuard roles={ADMIN_PERMISSIONS['reports']}><Reports /></RoleGuard> },
      { path: 'queue-management', element: <RoleGuard roles={ADMIN_PERMISSIONS['queue-management']}><QueueManagement /></RoleGuard> },
      { path: 'engagement', element: <RoleGuard roles={ADMIN_PERMISSIONS['engagement']}><EngagementActivity /></RoleGuard> },
      // Giving
      { path: 'giving', element: <RoleGuard roles={ADMIN_PERMISSIONS['giving']}><Giving /></RoleGuard> },
      // Communication
      { path: 'bot-management', element: <RoleGuard roles={ADMIN_PERMISSIONS['bot-management']}><BotManagement /></RoleGuard> },
      { path: 'bot-keywords', element: <RoleGuard roles={ADMIN_PERMISSIONS['bot-keywords']}><BotKeywords /></RoleGuard> },
      { path: 'llm-logs', element: <RoleGuard roles={ADMIN_PERMISSIONS['llm-logs']}><LLMClassifications /></RoleGuard> },
      { path: 'whatsapp-channels', element: <RoleGuard roles={ADMIN_PERMISSIONS['whatsapp-channels']}><WhatsAppChannels /></RoleGuard> },
      { path: 'whatsapp-templates', element: <RoleGuard roles={ADMIN_PERMISSIONS['whatsapp-templates']}><WhatsAppTemplates /></RoleGuard> },
      { path: 'notifications', element: <RoleGuard roles={ADMIN_PERMISSIONS['notifications']}><Notifications /></RoleGuard> },
      { path: 'broadcasts', element: <RoleGuard roles={ADMIN_PERMISSIONS['broadcasts']}><Broadcasts /></RoleGuard> },
      { path: 'support', element: <RoleGuard roles={ADMIN_PERMISSIONS['support']}><Support /></RoleGuard> },
      { path: 'chat-history', element: <RoleGuard roles={ADMIN_PERMISSIONS['chat-history']}><ChatHistory /></RoleGuard> },
      { path: 'surveys', element: <RoleGuard roles={ADMIN_PERMISSIONS['surveys']}><Surveys /></RoleGuard> },
      // Finance
      { path: 'payouts', element: <RoleGuard roles={ADMIN_PERMISSIONS['payouts']}><Payouts /></RoleGuard> },
      { path: 'finance', element: <RoleGuard roles={ADMIN_PERMISSIONS['finance']}><Finance /></RoleGuard> },
      { path: 'fee-invoices', element: <RoleGuard roles={ADMIN_PERMISSIONS['fee-invoices']}><FeeInvoices /></RoleGuard> },
      // Content & System
      { path: 'content', element: <RoleGuard roles={ADMIN_PERMISSIONS['content']}><ContentManagement /></RoleGuard> },
      { path: 'events', element: <RoleGuard roles={ADMIN_PERMISSIONS['events']}><Events /></RoleGuard> },
      { path: 'campaigns', element: <RoleGuard roles={ADMIN_PERMISSIONS['campaigns']}><Campaigns /></RoleGuard> },
      { path: 'countries', element: <RoleGuard roles={ADMIN_PERMISSIONS['countries']}><Countries /></RoleGuard> },
      { path: 'ai-setup-log', element: <RoleGuard roles={ADMIN_PERMISSIONS['ai-setup-log']}><AISetupLog /></RoleGuard> },
      { path: 'ai-usage', element: <RoleGuard roles={ADMIN_PERMISSIONS['ai-usage']}><AIUsage /></RoleGuard> },
      { path: 'conversation-usage', element: <RoleGuard roles={ADMIN_PERMISSIONS['conversation-usage']}><ConversationUsage /></RoleGuard> },
      { path: 'platform-settings', element: <RoleGuard roles={ADMIN_PERMISSIONS['platform-settings']}><PlatformSettings /></RoleGuard> },
      { path: 'audit-log', element: <RoleGuard roles={ADMIN_PERMISSIONS['audit-log']}><AuditLog /></RoleGuard> },
      { path: 'system-health', element: <RoleGuard roles={ADMIN_PERMISSIONS['system-health']}><SystemHealth /></RoleGuard> },
      { path: 'permissions', element: <RoleGuard roles={ADMIN_PERMISSIONS['permissions']}><AdminPermissions /></RoleGuard> },
      { path: 'ai-marketplace', element: <RoleGuard roles={ADMIN_PERMISSIONS['ai-marketplace'] || ['admin']}><AIMarketplace /></RoleGuard> },
    ],
  },
  { path: '*', element: <Navigate to="/dashboard" replace /> },
]);
