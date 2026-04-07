import { createBrowserRouter, Navigate } from 'react-router';
import { AdminLayout } from './components/AdminLayout';
import Login from './pages/Login';
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
import Notifications from './pages/Notifications';
import Broadcasts from './pages/Broadcasts';
import ContentManagement from './pages/ContentManagement';
import Events from './pages/Events';
import Campaigns from './pages/Campaigns';
import PlatformSettings from './pages/PlatformSettings';
import ImpersonationMode from './pages/ImpersonationMode';
import ImpersonationAudit from './pages/ImpersonationAudit';
import CategoryTemplates from './pages/CategoryTemplates';
import Customers from './pages/WhatsAppCustomers';
import Giving from './pages/Giving';
import Verification from './pages/Verification';
import Countries from './pages/Countries';
import RecurringPayments from './pages/RecurringPayments';
import Reports from './pages/Reports';
import QueueManagement from './pages/QueueManagement';

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
      { path: 'impersonation', Component: ImpersonationMode },
      { path: 'impersonation-audit', Component: ImpersonationAudit },
      // Operations
      { path: 'bookings', Component: Bookings },
      { path: 'orders', Component: Orders },
      { path: 'payments', Component: Payments },
      { path: 'subscriptions', Component: Subscriptions },
      { path: 'recurring', Component: RecurringPayments },
      { path: 'reports', Component: Reports },
      { path: 'queue-management', Component: QueueManagement },
      // Giving
      { path: 'giving', Component: Giving },
      // Communication
      { path: 'bot-management', Component: BotManagement },
      { path: 'whatsapp-channels', Component: WhatsAppChannels },
      { path: 'notifications', Component: Notifications },
      { path: 'broadcasts', Component: Broadcasts },
      { path: 'support', Component: Support },
      // Finance
      { path: 'payouts', Component: Payouts },
      { path: 'finance', Component: Finance },
      // Content & System
      { path: 'content', Component: ContentManagement },
      { path: 'events', Component: Events },
      { path: 'campaigns', Component: Campaigns },
      { path: 'countries', Component: Countries },
      { path: 'platform-settings', Component: PlatformSettings },
      { path: 'audit-log', Component: AuditLog },
    ],
  },
  { path: '*', element: <Navigate to="/dashboard" replace /> },
]);
