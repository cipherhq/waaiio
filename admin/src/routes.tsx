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
import Resellers from './pages/Resellers';

export const router = createBrowserRouter([
  { path: '/login', Component: Login },
  {
    path: '/',
    Component: AdminLayout,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', Component: Dashboard },
      // Users
      { path: 'users', element: <RoleGuard roles={['admin']}><Users /></RoleGuard> },
      { path: 'customers', element: <RoleGuard roles={['admin', 'support', 'operations']}><Customers /></RoleGuard> },
      { path: 'admin-team', element: <RoleGuard roles={['admin']}><AdminTeam /></RoleGuard> },
      // Businesses
      { path: 'businesses', element: <RoleGuard roles={['admin', 'support', 'operations']}><Businesses /></RoleGuard> },
      { path: 'verification', element: <RoleGuard roles={['admin', 'operations']}><Verification /></RoleGuard> },
      { path: 'category-templates', Component: CategoryTemplates },
      { path: 'impersonation', element: <RoleGuard roles={['admin']}><ImpersonationMode /></RoleGuard> },
      { path: 'impersonation-audit', element: <RoleGuard roles={['admin']}><ImpersonationAudit /></RoleGuard> },
      { path: 'resellers', element: <RoleGuard roles={['admin']}><Resellers /></RoleGuard> },
      // Operations
      { path: 'bookings', element: <RoleGuard roles={['admin', 'support', 'operations']}><Bookings /></RoleGuard> },
      { path: 'orders', element: <RoleGuard roles={['admin', 'support', 'operations']}><Orders /></RoleGuard> },
      { path: 'payments', element: <RoleGuard roles={['admin', 'finance']}><Payments /></RoleGuard> },
      { path: 'subscriptions', element: <RoleGuard roles={['admin', 'finance']}><Subscriptions /></RoleGuard> },
      { path: 'recurring', element: <RoleGuard roles={['admin', 'finance']}><RecurringPayments /></RoleGuard> },
      { path: 'tickets', element: <RoleGuard roles={['admin', 'support', 'operations']}><Tickets /></RoleGuard> },
      { path: 'alerts', element: <RoleGuard roles={['admin', 'support', 'operations']}><Alerts /></RoleGuard> },
      { path: 'reports', element: <RoleGuard roles={['admin', 'operations']}><Reports /></RoleGuard> },
      { path: 'queue-management', element: <RoleGuard roles={['admin', 'operations']}><QueueManagement /></RoleGuard> },
      // Giving
      { path: 'giving', element: <RoleGuard roles={['admin', 'finance']}><Giving /></RoleGuard> },
      // Communication
      { path: 'bot-management', element: <RoleGuard roles={['admin', 'operations']}><BotManagement /></RoleGuard> },
      { path: 'bot-keywords', element: <RoleGuard roles={['admin', 'operations']}><BotKeywords /></RoleGuard> },
      { path: 'llm-logs', element: <RoleGuard roles={['admin']}><LLMClassifications /></RoleGuard> },
      { path: 'whatsapp-channels', element: <RoleGuard roles={['admin', 'operations']}><WhatsAppChannels /></RoleGuard> },
      { path: 'whatsapp-templates', element: <RoleGuard roles={['admin']}><WhatsAppTemplates /></RoleGuard> },
      { path: 'notifications', element: <RoleGuard roles={['admin']}><Notifications /></RoleGuard> },
      { path: 'broadcasts', element: <RoleGuard roles={['admin']}><Broadcasts /></RoleGuard> },
      { path: 'support', element: <RoleGuard roles={['admin', 'support']}><Support /></RoleGuard> },
      { path: 'chat-history', element: <RoleGuard roles={['admin', 'support', 'operations']}><ChatHistory /></RoleGuard> },
      // Finance
      { path: 'payouts', element: <RoleGuard roles={['admin', 'finance']}><Payouts /></RoleGuard> },
      { path: 'finance', element: <RoleGuard roles={['admin', 'finance']}><Finance /></RoleGuard> },
      // Content & System
      { path: 'content', Component: ContentManagement },
      { path: 'events', element: <RoleGuard roles={['admin', 'operations']}><Events /></RoleGuard> },
      { path: 'campaigns', element: <RoleGuard roles={['admin', 'operations']}><Campaigns /></RoleGuard> },
      { path: 'countries', element: <RoleGuard roles={['admin']}><Countries /></RoleGuard> },
      { path: 'surveys', element: <RoleGuard roles={['admin', 'operations']}><Surveys /></RoleGuard> },
      { path: 'ai-setup-log', Component: AISetupLog },
      { path: 'ai-usage', Component: AIUsage },
      { path: 'conversation-usage', Component: ConversationUsage },
      { path: 'platform-settings', element: <RoleGuard roles={['admin']}><PlatformSettings /></RoleGuard> },
      { path: 'audit-log', element: <RoleGuard roles={['admin']}><AuditLog /></RoleGuard> },
      { path: 'system-health', Component: SystemHealth },
    ],
  },
  { path: '*', element: <Navigate to="/dashboard" replace /> },
]);
