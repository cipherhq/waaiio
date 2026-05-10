# Scaffold a New Dashboard Page

Create a new dashboard page with all standard boilerplate.

## Usage
`/new-page <name> [--table <table_name>] [--capability <cap_id>]`

Example: `/new-page gift-cards --table gift_cards --capability loyalty`

## Instructions

1. Create the page file at `app/dashboard/<name>/page.tsx` with this structure:
   - `'use client'` directive
   - Import `useBusiness` from `@/components/dashboard/DashboardProvider`
   - Import `createClient` from `@/lib/supabase/client`
   - Import `PageHelp` from `@/components/dashboard/PageHelp`
   - Import `EmptyState` from `@/components/dashboard/EmptyState`
   - Standard state: `items`, `loading`, `showForm`, `editItem`
   - useEffect to load data from the table filtered by `business_id`
   - Loading spinner while fetching
   - `PageHelp` banner with contextual description
   - `EmptyState` when no data with appropriate icon, title, description, and action
   - Data table/cards when data exists
   - Add/Edit form (inline or slide-over)
   - CRUD operations (create, update, delete) via Supabase client

2. Add a nav item to `components/dashboard/Sidebar.tsx`:
   - `href: '/dashboard/<name>'`
   - `label: '<Human Readable Name>'`
   - `capabilities: ['<capability>']` if specified
   - `section: 'commerce'` (or appropriate section)
   - Choose an appropriate icon from the existing icon set

3. Match the existing code style:
   - Tailwind classes: `rounded-xl`, `border border-gray-200`, `bg-white dark:bg-gray-800`
   - Brand colors for primary actions
   - Same loading spinner pattern as other pages
   - Same table header style

4. Report what was created and any next steps (like migrations needed).
