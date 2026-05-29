import { createBrowserRouter, Navigate } from 'react-router';
import { AdminLayout, useAdminSession } from './components/AdminLayout';
import type { AdminRole } from './lib/adminAuth';
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
import Tickets from './pages/Tickets';
import LLMClassifications from './pages/LLMClassifications';
import Alerts from './pages/Alerts';
import AIUsage from './pages/AIUsage';
import ConversationUsage from './pages/ConversationUsage';
import Surveys from './pages/Surveys';
import AISetupLog from './pages/AISetupLog';
import SystemHealth from './pages/SystemHealth';
import ChatHistory from './pages/ChatHistory';

export const router = createBrowserRouter([
  { path: '/login', Component: Login },
  {
    path: '/',
    Component: AdminLayout,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', Component: Dashboard },
      // Users
      { path: 'users', Component: Users },
      { path: 'customers', Component: Customers },
      { path: 'admin-team', Component: AdminTeam },
      // Businesses
      { path: 'businesses', Component: Businesses },
      { path: 'verification', Component: Verification },
      { path: 'category-templates', Component: CategoryTemplates },
      { path: 'impersonation', element: <RoleGuard roles={['admin']}><ImpersonationMode /></RoleGuard> },
      { path: 'impersonation-audit', element: <RoleGuard roles={['admin']}><ImpersonationAudit /></RoleGuard> },
      // Operations
      { path: 'bookings', Component: Bookings },
      { path: 'orders', Component: Orders },
      { path: 'payments', element: <RoleGuard roles={['admin', 'finance']}><Payments /></RoleGuard> },
      { path: 'subscriptions', element: <RoleGuard roles={['admin', 'finance']}><Subscriptions /></RoleGuard> },
      { path: 'recurring', element: <RoleGuard roles={['admin', 'finance']}><RecurringPayments /></RoleGuard> },
      { path: 'tickets', Component: Tickets },
      { path: 'alerts', Component: Alerts },
      { path: 'reports', Component: Reports },
      { path: 'queue-management', Component: QueueManagement },
      // Giving
      { path: 'giving', Component: Giving },
      // Communication
      { path: 'bot-management', Component: BotManagement },
      { path: 'bot-keywords', Component: BotKeywords },
      { path: 'llm-logs', Component: LLMClassifications },
      { path: 'whatsapp-channels', element: <RoleGuard roles={['admin', 'operations']}><WhatsAppChannels /></RoleGuard> },
      { path: 'whatsapp-templates', Component: WhatsAppTemplates },
      { path: 'notifications', element: <RoleGuard roles={['admin']}><Notifications /></RoleGuard> },
      { path: 'broadcasts', element: <RoleGuard roles={['admin']}><Broadcasts /></RoleGuard> },
      { path: 'support', Component: Support },
      { path: 'chat-history', Component: ChatHistory },
      // Finance
      { path: 'payouts', element: <RoleGuard roles={['admin', 'finance']}><Payouts /></RoleGuard> },
      { path: 'finance', element: <RoleGuard roles={['admin', 'finance']}><Finance /></RoleGuard> },
      // Content & System
      { path: 'content', Component: ContentManagement },
      { path: 'events', Component: Events },
      { path: 'campaigns', Component: Campaigns },
      { path: 'countries', element: <RoleGuard roles={['admin']}><Countries /></RoleGuard> },
      { path: 'surveys', Component: Surveys },
      { path: 'ai-setup-log', Component: AISetupLog },
      { path: 'ai-usage', Component: AIUsage },
      { path: 'conversation-usage', Component: ConversationUsage },
      { path: 'platform-settings', element: <RoleGuard roles={['admin']}><PlatformSettings /></RoleGuard> },
      { path: 'audit-log', Component: AuditLog },
      { path: 'system-health', Component: SystemHealth },
    ],
  },
  { path: '*', element: <Navigate to="/dashboard" replace /> },
]);
