# Graph Report - .  (2026-07-16)

## Corpus Check
- Large corpus: 1362 files · ~1,033,067 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder.

## Summary
- 4248 nodes · 12021 edges · 310 communities (259 shown, 51 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 252 edges (avg confidence: 0.68)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Account & Audit API
- Account Management
- Admin Payouts & Finance
- Dashboard Campaigns
- Auth & Booking API
- Dashboard Alerts
- Admin UI Components
- Analytics & Dropoffs
- Skills & Retrospective
- Public Booking API
- Consent & Privacy
- Dashboard Chat
- Admin Auth & Utilities
- Receipts & PDFs
- Refund Processing
- Module 15
- Module 16
- Module 17
- Module 18
- Module 19
- Module 20
- Module 21
- Module 22
- Module 23
- Module 24
- Module 25
- Module 26
- Module 27
- Module 28
- Module 29
- Module 30
- Module 31
- Module 32
- Module 33
- Module 34
- Module 35
- Module 36
- Module 37
- Module 38
- Module 39
- Module 40
- Module 41
- Module 42
- Module 43
- Module 44
- Module 45
- Module 46
- Module 47
- Module 48
- Module 49
- Module 50
- Module 51
- Module 52
- Module 53
- Module 54
- Module 55
- Module 56
- Module 57
- Module 58
- Module 59
- Module 60
- Module 61
- Module 62
- Module 63
- Module 64
- Module 65
- Module 66
- Module 67
- Module 68
- Module 69
- Module 70
- Module 71
- Module 72
- Module 73
- Module 74
- Module 75
- Module 76
- Module 77
- Module 78
- Module 79
- Module 80
- Module 81
- Module 82
- Module 83
- Module 84
- Module 85
- Module 86
- Module 87
- Module 88
- Module 89
- Module 90
- Module 91
- Module 92
- Module 93
- Module 94
- Module 95
- Module 96
- Module 97
- Module 98
- Module 99
- Module 100
- Module 101
- Module 102
- Module 103
- Module 104
- Module 105
- Module 106
- Module 107
- Module 108
- Module 109
- Module 110
- Module 111
- Module 112
- Module 113
- Module 114
- Module 115
- Module 116
- Module 117
- Module 118
- Module 119
- Module 120
- Module 121
- Module 122
- Module 123
- Module 124
- Module 125
- Module 126
- Module 127
- Module 128
- Module 129
- Module 130
- Module 131
- Module 132
- Module 133
- Module 134
- Module 135
- Module 136
- Module 137
- Module 138
- Module 140
- Module 141
- Module 142
- Module 143
- Module 144
- Module 145
- Module 146
- Module 147
- Module 148
- Module 149
- Module 150
- Module 151
- Module 152
- Module 153
- Module 154
- Module 155
- Module 156
- Module 157
- Module 158
- Module 159
- Module 161
- Module 162
- Module 163
- Module 164
- Module 165
- Module 166
- Module 167
- Module 168
- Module 169
- Module 170
- Module 171
- Module 172
- Module 173
- Module 174
- Module 175
- Module 176
- Module 177
- Module 190
- Module 191
- Module 192
- Module 193
- Module 194
- Module 195
- Module 196
- Module 197
- Module 198
- Module 199
- Module 200
- Module 201
- Module 202
- Module 253

## God Nodes (most connected - your core abstractions)
1. `createServiceClient()` - 414 edges
2. `createClient()` - 321 edges
3. `Logger` - 246 edges
4. `formatCurrency()` - 169 edges
5. `useBusiness()` - 166 edges
6. `rateLimitResponseAsync()` - 165 edges
7. `CountryCode` - 155 edges
8. `createClient()` - 150 edges
9. `getRateLimitKey()` - 147 edges
10. `sendEmail()` - 72 edges

## Surprising Connections (you probably didn't know these)
- `ContentManagement()` --indirect_call--> `p()`  [INFERRED]
  admin/src/pages/ContentManagement.tsx → lib/email/templates.ts
- `Finance()` --indirect_call--> `p()`  [INFERRED]
  admin/src/pages/Finance.tsx → lib/email/templates.ts
- `Notifications()` --indirect_call--> `p()`  [INFERRED]
  admin/src/pages/Notifications.tsx → lib/email/templates.ts
- `Payments()` --indirect_call--> `p()`  [INFERRED]
  admin/src/pages/Payments.tsx → lib/email/templates.ts
- `Payouts()` --indirect_call--> `p()`  [INFERRED]
  admin/src/pages/Payouts.tsx → lib/email/templates.ts

## Import Cycles
- None detected.

## Communities (310 total, 51 thin omitted)

### Community 0 - "Account & Audit API"
Cohesion: 0.02
Nodes (137): ALLOWED_ACTIONS, POST(), GET(), POST(), GET(), requireAdmin(), getAdminAuth(), PATCH() (+129 more)

### Community 1 - "Account Management"
Cohesion: 0.04
Nodes (67): DELETE(), PATCH(), POST(), GET(), POST(), GET(), POST(), sendWhatsAppMessage() (+59 more)

### Community 2 - "Admin Payouts & Finance"
Cohesion: 0.07
Nodes (87): POST(), POST(), GET(), esc(), INDUSTRIES, POST(), USE_CASES, GET() (+79 more)

### Community 3 - "Dashboard Campaigns"
Cohesion: 0.03
Nodes (83): Campaign, CampaignsPage(), Donation, ViewMode, Order, ORDER_STATUSES, OrderItem, OrdersPage() (+75 more)

### Community 4 - "Auth & Booking API"
Cohesion: 0.08
Nodes (24): POST(), POST(), STATUS_MESSAGES, STATUS_MESSAGES, bankCache, Params, Params, sitemap() (+16 more)

### Community 5 - "Dashboard Alerts"
Cohesion: 0.03
Nodes (72): Alert, AlertsPage(), FILTERS, FilterType, timeAgo(), AttendanceEntry, AttendancePage(), formatTime() (+64 more)

### Community 6 - "Admin UI Components"
Cohesion: 0.06
Nodes (64): DetailModal(), DetailModalProps, DetailRow(), Pagination(), PaginationProps, defaultColorMap, StatusBadge(), StatusBadgeProps (+56 more)

### Community 7 - "Analytics & Dropoffs"
Cohesion: 0.03
Nodes (70): DropoffRow, FlowDropoffsPage(), FunnelRow, reasonColors, timeAgo(), ScanPage(), ScanState, TicketResult (+62 more)

### Community 8 - "Skills & Retrospective"
Cohesion: 0.08
Nodes (40): Candidate, CandidateType, check_skill_conflict(), _content_overlaps(), dedup_against_memory(), filter_by_skill_content(), filter_linear_candidates(), gate_check() (+32 more)

### Community 9 - "Public Booking API"
Cohesion: 0.07
Nodes (51): POST(), GET(), POST(), DELETE(), GET(), POST(), PUT(), POST() (+43 more)

### Community 10 - "Consent & Privacy"
Cohesion: 0.05
Nodes (62): ConsentPreferences, DEFAULT_CONSENT, GET(), POST(), arrayToCsv(), csvEscape(), POST(), POST() (+54 more)

### Community 11 - "Dashboard Chat"
Cohesion: 0.04
Nodes (53): AssignmentFilter, CannedResponse, ChatConversation, ChatMessage, ChatPage(), formatBubbleTime(), formatMessageTime(), getAvatarColor() (+45 more)

### Community 12 - "Admin Auth & Utilities"
Cohesion: 0.08
Nodes (60): useAdminSession(), isFullAdmin(), downloadCSV(), fmtCurrency(), fmtDate(), fmtDateTime(), AdminTeam(), AISetupLog() (+52 more)

### Community 13 - "Receipts & PDFs"
Cohesion: 0.06
Nodes (39): handleAnnual(), handleHistory(), handleReceipt(), POST(), uploadAndSign(), CheckInQRSection(), AppendSignatureData, appendSignatureToUploadedPdf() (+31 more)

### Community 14 - "Refund Processing"
Cohesion: 0.08
Nodes (35): POST(), POST(), PaymentGatewayName, CountryRow, flutterwaveInstance, paypalInstance, paystackInstance, squareInstance (+27 more)

### Community 15 - "Module 15"
Cohesion: 0.06
Nodes (45): appointmentFlow, selectAppointmentStep, chatFlow, feedbackCommentStep, feedbackFlow, feedbackRatingStep, feedbackThanksStep, invoiceFlow (+37 more)

### Community 16 - "Module 16"
Cohesion: 0.09
Nodes (42): handleOnboardingComplete(), StepCategoryProps, StepFeaturesProps, deactivateSession(), forwardToBusinessOwner(), getActiveSession(), BotContext, BusinessRecord (+34 more)

### Community 17 - "Module 17"
Cohesion: 0.04
Nodes (52): BillingPage(), FeeInvoiceRow, FeeLineItem, formatCurrency(), formatDateShort(), formatSmallestUnit(), PaymentRow, SubscriptionRow (+44 more)

### Community 18 - "Module 18"
Cohesion: 0.04
Nodes (43): BusinessInfo, PageState, AudienceFilters, BroadcastContact, BroadcastHistory, BroadcastsPage(), BroadcastUsage, formatWhatsAppText() (+35 more)

### Community 19 - "Module 19"
Cohesion: 0.11
Nodes (38): awaitInvoicePaymentStep, invoiceDetailStep, invoiceListStep, invoicePayStep, AddonRecord, CartItem, OptionGroup, BANK_ONLY_BUTTONS (+30 more)

### Community 20 - "Module 20"
Cohesion: 0.06
Nodes (36): AdminSessionContext, AdminRole, AdminSidebar(), AdminSidebarProps, NavItem, navSections, IdleTimeout(), AdminRole (+28 more)

### Community 21 - "Module 21"
Cohesion: 0.07
Nodes (13): GET(), ResolvedChannel, MetaCloudSender, withRetry(), MetaCloudService, CircuitBreakerOpenError, circuits, CircuitState (+5 more)

### Community 22 - "Module 22"
Cohesion: 0.05
Nodes (41): ActivityItem, ActivityPage(), Appointment, AppointmentsManagementPage(), StaffMember, ViewMode, GivingCategory, GivingPage() (+33 more)

### Community 23 - "Module 23"
Cohesion: 0.07
Nodes (44): AdminLayout(), CountryRow, formatPayoutLimit(), getCountry(), getCountryCurrencyDetailMap(), getCountryCurrencyMap(), getCountryList(), getCurrencyCode() (+36 more)

### Community 24 - "Module 24"
Cohesion: 0.06
Nodes (38): FeedbackEntry, FeedbackPage(), RATING_COLORS, BookingRow, FinancialsPage(), flowTypeStyles, formatCompact(), formatDate() (+30 more)

### Community 25 - "Module 25"
Cohesion: 0.07
Nodes (39): Balance, Bank, PageView, PayoutAccount, PayoutRecord, PayoutsPage(), SetupStep, TermsAcceptance (+31 more)

### Community 26 - "Module 26"
Cohesion: 0.07
Nodes (39): ClassificationLog, logClassification(), cache, classifyWithLLM(), EMPTY_RESULT, getClient(), LLMIntentResult, BOOKING_PATTERNS (+31 more)

### Community 27 - "Module 27"
Cohesion: 0.11
Nodes (33): ADMIN_ROLES, corsHeaders(), handleSend(), handleVerify(), OPTIONS(), POST(), handleSend(), handleVerify() (+25 more)

### Community 28 - "Module 28"
Cohesion: 0.06
Nodes (29): AnalyticsPage(), DailyCount, HourlyCount, ServiceStat, TimeRange, TopCustomer, BookingRecord, CustomerProfile (+21 more)

### Community 29 - "Module 29"
Cohesion: 0.07
Nodes (12): Shared fixtures for TDD skill script tests., A writable temp directory for tests that need to create files., tmp_project(), py_src(), Tests for extract_api.sh — public API signature extraction.  Note: Python/TS fix, Copy Python fixture to tmp_path so it's not under tests/., run_extract(), TestEmptyProject (+4 more)

### Community 30 - "Module 30"
Cohesion: 0.07
Nodes (28): DashboardLayout(), metadata, CATEGORY_OPTIONS, COUNTRY_OPTIONS, ResellerAccountsPage(), ResellerMeta, SubAccount, TIER_OPTIONS (+20 more)

### Community 31 - "Module 31"
Cohesion: 0.06
Nodes (27): cardColors, iconColors, SummaryCard(), SummaryCardProps, AIUsageRow, ACTION_COLORS, ACTION_TYPES, BotKeywordRow (+19 more)

### Community 32 - "Module 32"
Cohesion: 0.07
Nodes (15): AbuseRecord, AbuseResult, BotIntelligenceService, BotIntent, IntentResult, LEET_PATTERNS, PROFANITY_SET, NOTE: Intent rules (INTENT_RULES) have been migrated to the bot_keywords table (+7 more)

### Community 33 - "Module 33"
Cohesion: 0.12
Nodes (17): getConversationLimitMessage(), trackOutboundMessage(), DropoffReason, logDropoff(), FlowExecutor, getExtendedFlowDefinition(), getFlowDefinition(), getFlowStep() (+9 more)

### Community 34 - "Module 34"
Cohesion: 0.06
Nodes (34): dependencies, lucide-react, react, react-dom, react-router, recharts, @supabase/supabase-js, devDependencies (+26 more)

### Community 35 - "Module 35"
Cohesion: 0.07
Nodes (25): AuditEntry, logAudit(), AdminPermissions(), PermAction, PermissionRow, RESOURCES, ROLES, ALL_CAPABILITIES (+17 more)

### Community 36 - "Module 36"
Cohesion: 0.10
Nodes (23): CATEGORY_CONTEXT, getClient(), POST(), POST(), getChannelResolver(), getIntelligence(), handleCatalogOrder(), POST() (+15 more)

### Community 37 - "Module 37"
Cohesion: 0.15
Nodes (24): BulkUpload(), BulkUploadProps, ProductForm(), ProductFormProps, ProductList(), ProductListProps, SalesAnalytics(), SalesAnalyticsProps (+16 more)

### Community 38 - "Module 38"
Cohesion: 0.09
Nodes (23): Flag, POST(), DELETE(), GET(), POST(), GET(), generateToken(), POST() (+15 more)

### Community 39 - "Module 39"
Cohesion: 0.11
Nodes (27): generate_html(), main(), Generate HTML report from loop output data. If auto_refresh is True, adds a meta, _call_claude(), improve_description(), main(), Path, Run `claude -p` with the prompt on stdin and return the text response.      Prom (+19 more)

### Community 40 - "Module 40"
Cohesion: 0.09
Nodes (12): load_prompt_templates(), Snapshot tests for agent prompt templates.  Renders each agent prompt (Test Writ, Extract agent prompt templates from agent_prompts.md., Compare rendered prompts against stored snapshots.      Run with --snapshot-upda, Substitute {VARIABLE} placeholders and handle {?SECTION}...{/SECTION}., read_snapshot(), render_template(), templates() (+4 more)

### Community 41 - "Module 41"
Cohesion: 0.08
Nodes (11): metadata, metadata, metadata, metadata, metadata, metadata, metadata, metadata (+3 more)

### Community 42 - "Module 42"
Cohesion: 0.14
Nodes (28): handleGlobalQuery(), isAnnualQuery(), isBookingsQuery(), isContractQuery(), isGivingQuery(), isHistoryQuery(), isInvoiceQuery(), isLocationQuery() (+20 more)

### Community 43 - "Module 43"
Cohesion: 0.09
Nodes (22): BillingInterval, PLAN_PAGE_SLUGS, POST(), STRIPE_ANNUAL_PRICE_IDS, VALID_INTERVALS, VALID_PLANS, PricingPage(), NOTE: This value must match PRICING_TIERS in lib/constants.ts (+14 more)

### Community 44 - "Module 44"
Cohesion: 0.08
Nodes (28): CAP_MAP, CapabilitiesPage(), CAPABILITY_GROUPS, CapabilityGroup, _BEAUTY, canEnableCapability(), CAPABILITY_MAP, CapabilityDefinition (+20 more)

### Community 45 - "Module 45"
Cohesion: 0.11
Nodes (25): BotRule, evaluateConditions(), evaluateRules(), executeAction(), fillVariables(), RuleCondition, RuleContext, advanceEnrollment() (+17 more)

### Community 46 - "Module 46"
Cohesion: 0.13
Nodes (3): sendBotText(), BotService, BotSession

### Community 47 - "Module 47"
Cohesion: 0.07
Nodes (29): next-env.d.ts, .next/types/**/*.ts, scripts, **/*.ts, **/*.tsx, compilerOptions, allowJs, esModuleInterop (+21 more)

### Community 48 - "Module 48"
Cohesion: 0.07
Nodes (29): eslint, eslint-config-next, husky, devDependencies, @antiwork/shortest, eslint, eslint-config-next, husky (+21 more)

### Community 49 - "Module 49"
Cohesion: 0.07
Nodes (26): compilerOptions, allowJs, baseUrl, esModuleInterop, incremental, isolatedModules, jsx, lib (+18 more)

### Community 50 - "Module 50"
Cohesion: 0.12
Nodes (11): Tests for discover_docs.sh — project documentation discovery., Create a project with very large docs to test truncation., run_discover(), TestAPISpecifications, TestDocumentationFiles, TestEmptyProject, TestGoDocstrings, TestOutputStructure (+3 more)

### Community 51 - "Module 51"
Cohesion: 0.15
Nodes (12): parse_output(), Tests for run_tests.sh — universal test runner JSON output., Even on weird output, should produce valid JSON., Ensure quotes and newlines in output don't break JSON., Parse the JSON from run_tests.sh stdout., run_tests_sh(), TestGenericFramework, TestGoParsing (+4 more)

### Community 52 - "Module 52"
Cohesion: 0.14
Nodes (19): StepAuth(), StepDetails(), StepFeatures(), StepPlan(), StepSuccess(), AuthMode, AuthSubStep, ConnectSubStep (+11 more)

### Community 53 - "Module 53"
Cohesion: 0.14
Nodes (16): capabilitySelectionFlow, myAccountMenuStep, myBookingsStep, myOrdersStep, selectCapabilityStep, crowdfundingFlow, orderingFlow, schedulingFlow (+8 more)

### Community 54 - "Module 54"
Cohesion: 0.08
Nodes (25): @anthropic-ai/sdk, next, dependencies, @anthropic-ai/sdk, next, pdf-lib, pdfjs-dist, posthog-js (+17 more)

### Community 55 - "Module 55"
Cohesion: 0.15
Nodes (19): build_run(), embed_file(), find_runs(), _find_runs_recursive(), generate_html(), get_mime_type(), _kill_port(), load_previous_iteration() (+11 more)

### Community 56 - "Module 56"
Cohesion: 0.11
Nodes (21): ActionType, BotCustomConfig, BotKeyword, businessKeywordCache, categoryKeywordCache, configCache, getCompiledRegex(), KeywordScope (+13 more)

### Community 57 - "Module 57"
Cohesion: 0.11
Nodes (10): NotifyStaffOpts, PostCompletionParams, SendTicketsOptions, GlobalQueryParams, EscalateParams, escalateToHuman(), ResolveParams, MessageSender (+2 more)

### Community 58 - "Module 58"
Cohesion: 0.14
Nodes (16): COEXIST_WARNINGS, FALLBACK_WHATSAPP_NUMBERS, getQueryParam(), OnboardingWizard(), OWN_NUMBER_WARNINGS, IMPORTANT: This useMemo must be BEFORE any conditional returns (React hooks rule, STEP_PANELS, WA_OPTIONS (+8 more)

### Community 59 - "Module 59"
Cohesion: 0.11
Nodes (13): metadata, ACCENT_STYLES, DEFAULT_PRICING, FAQ_DATA, FLOW_TABS, HomeClient(), INDUSTRY_DESCRIPTIONS, IndustryShowcase() (+5 more)

### Community 60 - "Module 60"
Cohesion: 0.21
Nodes (15): GET(), POST(), DELETE(), GET(), getEvent(), PUT(), GET(), POST() (+7 more)

### Community 61 - "Module 61"
Cohesion: 0.12
Nodes (20): BlockedDate, Booking, CalendarEntry, CalendarPage(), dateRange(), DAY_NAMES, EntryType, entryTypeColors (+12 more)

### Community 62 - "Module 62"
Cohesion: 0.16
Nodes (14): GET(), POST(), GET(), DELETE(), GET(), POST(), POST(), POST() (+6 more)

### Community 63 - "Module 63"
Cohesion: 0.14
Nodes (13): FormData, FormField, PageState, formatAmount(), formatDate(), InvoiceData, InvoiceItem, InvoicePage() (+5 more)

### Community 64 - "Module 64"
Cohesion: 0.14
Nodes (16): EventDetails, PageState, PublicInvitePage(), ContractInfo, PageState, SignPage(), formatDate(), formatDateTime() (+8 more)

### Community 65 - "Module 65"
Cohesion: 0.21
Nodes (13): GatewayVerifyResult, GET(), verifyPaystackPayment(), verifyStripePayment(), verifyWithGateway(), POST(), verifySquareSignature(), PaymentRecord (+5 more)

### Community 66 - "Module 66"
Cohesion: 0.11
Nodes (14): EventItem, EventsPage(), TicketType, ViewMode, AMENITY_OPTIONS, BlockedDate, PropertiesPage(), Property (+6 more)

### Community 67 - "Module 67"
Cohesion: 0.21
Nodes (17): CATEGORY_KEYWORDS, detectCategoryIntent(), isAcronymOf(), isCloseMatch(), levenshtein(), matchScore(), PHONE_COUNTRY_MAP, phoneticMatch() (+9 more)

### Community 68 - "Module 68"
Cohesion: 0.24
Nodes (13): GET(), POST(), GET(), RFC-5545, addMinutesToFormatted(), buildCalendarEvent(), CalendarEvent, formatDateTime() (+5 more)

### Community 69 - "Module 69"
Cohesion: 0.24
Nodes (14): GET(), recurringManageFlow, cancelSubscription(), chargeAuthorization(), createPlan(), createSubscription(), enableSubscription(), getAuthorization() (+6 more)

### Community 70 - "Module 70"
Cohesion: 0.25
Nodes (7): POST(), POST(), AlertInput, createAlert(), processPaystackChargeFailed(), processPaystackChargeSuccess(), getServerPostHog()

### Community 71 - "Module 71"
Cohesion: 0.32
Nodes (6): createMockContext(), createMockSupabase(), getStep(), buildCtx(), buildCtx(), FlowContext

### Community 72 - "Module 72"
Cohesion: 0.21
Nodes (13): checkRateLimit(), formatInviteDate(), formatInviteTime(), POST(), PUT(), RATE_LIMIT_MAP, POST(), sendWithTemplate() (+5 more)

### Community 73 - "Module 73"
Cohesion: 0.14
Nodes (15): BotSequence, BotSequenceStep, BuilderTab, DELAY_OPTIONS, emptyStep(), Enrollment, MESSAGE_TYPE_OPTIONS, MessageType (+7 more)

### Community 74 - "Module 74"
Cohesion: 0.19
Nodes (14): cache, CachedSession, fastHash(), getCachedSession(), setCachedSession(), shouldTouch(), applySecurityHeaders(), checkMiddlewareRateLimit() (+6 more)

### Community 75 - "Module 75"
Cohesion: 0.18
Nodes (15): create_baseline_metrics(), create_bug_tracking_template(), create_directory_structure(), create_master_qa_prompt(), create_readme(), create_test_execution_tracking(), create_weekly_report_template(), main() (+7 more)

### Community 76 - "Module 76"
Cohesion: 0.16
Nodes (12): GET(), POST(), awaitDonationPaymentStep, campaignViewStep, confirmDonationStep, donationPaymentStep, enterDonationAmountStep, enterDonorNameStep (+4 more)

### Community 77 - "Module 77"
Cohesion: 0.17
Nodes (10): BookingForm(), BookingFormProps, BusinessInfo, formatDuration(), formatPrice(), getCurrencySymbol(), getNext30Days(), ServiceInfo (+2 more)

### Community 78 - "Module 78"
Cohesion: 0.18
Nodes (13): ACTION_TYPES, actionLabel(), BotRule, Condition, CONDITION_OPERATORS, conditionsSummary(), EMPTY_FORM, FIELD_SUGGESTIONS (+5 more)

### Community 79 - "Module 79"
Cohesion: 0.16
Nodes (13): COLOR_BG_MAP, COLOR_BORDER_MAP, COLOR_OPTIONS, COLOR_RING_MAP, DAYS, EMPTY_STAFF, getInitials(), Service (+5 more)

### Community 80 - "Module 80"
Cohesion: 0.19
Nodes (9): inter, metadata, viewport, CookieConsent(), CookiePreferences, DEFAULT_PREFS, dispatchConsentEvent(), getCookieConsent() (+1 more)

### Community 81 - "Module 81"
Cohesion: 0.23
Nodes (12): aggregate_results(), calculate_stats(), generate_benchmark(), generate_markdown(), load_run_results(), main(), Path, Aggregate run results into summary statistics.      Returns run_summary with sta (+4 more)

### Community 82 - "Module 82"
Cohesion: 0.15
Nodes (9): Calculator, factorial(), _internal_helper(), Calculator module for arithmetic operations., Add two numbers and return the result., Divide a by b.          Raises:             ValueError: If b is zero., Compute factorial of n.      Args:         n: Non-negative integer.      Returns, This is private and should not appear in API surface. (+1 more)

### Community 83 - "Module 83"
Cohesion: 0.27
Nodes (11): Contract, ContractsPage(), CustomTemplate, detectCountryFromPhone(), DocTab, COMMON_QUESTIONS, CONTRACT_TEMPLATES, ContractTemplate (+3 more)

### Community 84 - "Module 84"
Cohesion: 0.23
Nodes (6): metadata, NAV_LINKS, Navbar(), PrivacyChoicesButton(), WaaiioMark(), WaaiioWordmark()

### Community 85 - "Module 85"
Cohesion: 0.17
Nodes (8): metadata, AccountForm, BrandForm, CATEGORY_OPTIONS, COUNTRY_OPTIONS, formatCategory(), ResellerInfo, SetupWizard()

### Community 86 - "Module 86"
Cohesion: 0.26
Nodes (11): maskEmail(), CheckinRecord, clampDate(), DateRange, daysAgoISO(), EngagementActivity(), rangeStart(), Tab (+3 more)

### Community 87 - "Module 87"
Cohesion: 0.20
Nodes (10): ActiveTab, FIELD_LABELS, FIELD_OPTIONS, SignedWaiver, TemplateMode, WaiversPage(), WaiverTemplate, fillWaiverPlaceholders() (+2 more)

### Community 88 - "Module 88"
Cohesion: 0.17
Nodes (11): CloudApiResponse, CloudDocumentMessage, CloudImageMessage, CloudInteractiveButtonMessage, CloudInteractiveListMessage, CloudTemplateMessage, CloudTextMessage, CreateTemplateInput (+3 more)

### Community 89 - "Module 89"
Cohesion: 0.25
Nodes (6): metadata, BLOG_POSTS, BlogPost, BlogPostPage(), generateMetadata(), PageProps

### Community 90 - "Module 90"
Cohesion: 0.18
Nodes (7): FormData, INDUSTRIES, initial, FEATURES, metadata, STEPS, VERTICALS

### Community 91 - "Module 91"
Cohesion: 0.29
Nodes (8): main(), package_skill(), Path, Check if a path should be excluded from packaging., Package a skill folder into a .skill file.      Args:         skill_path: Path t, should_exclude(), Basic validation of a skill, validate_skill()

### Community 92 - "Module 92"
Cohesion: 0.51
Nodes (9): emit_json(), parse_cargo(), parse_generic(), parse_go(), parse_jest_vitest(), parse_phpunit(), parse_pytest(), parse_rspec() (+1 more)

### Community 93 - "Module 93"
Cohesion: 0.42
Nodes (9): DELETE(), GET(), getReseller(), getStripeKey(), POST(), RESELLER_TIERS, ResellerTier, stripeRequest() (+1 more)

### Community 94 - "Module 94"
Cohesion: 0.36
Nodes (8): handleOnboardingDataExchange(), CUSTOMER_OUTCOMES, SEARCH_ALIASES, StepCategory(), CATEGORY_DEFAULT_CAPABILITIES, getCategoryGroups(), getCategoryList(), BUSINESS_CATEGORIES

### Community 95 - "Module 95"
Cohesion: 0.27
Nodes (7): formatCompact(), formatDate(), formatMonthLabel(), MonthBucket, PayoutHistoryPage(), PayoutRecord, statusStyles

### Community 96 - "Module 96"
Cohesion: 0.22
Nodes (9): CATEGORIES, PRIORITIES, priorityColors, STATUS_TABS, statusColors, SupportPage(), Ticket, TicketMessage (+1 more)

### Community 97 - "Module 97"
Cohesion: 0.31
Nodes (8): generateMetadata(), getReceiptData(), PageProps, ReceiptPage(), formatDate(), formatTime(), ReceiptClient(), ReceiptData

### Community 98 - "Module 98"
Cohesion: 0.20
Nodes (10): scripts, build, dev, lint, prepare, start, test, test:e2e (+2 more)

### Community 99 - "Module 99"
Cohesion: 0.22
Nodes (8): ALL_CAPABILITIES, Business, isDemo(), PayoutAccount, ServiceStats, TIER_BADGE_STYLE, TIER_RANK, TIER_REQUIREMENTS

### Community 100 - "Module 100"
Cohesion: 0.22
Nodes (8): AuditLogEntry, SubscriptionRecord, TabId, TIER_CATALOG_FALLBACK, TierCatalogEntry, TierKey, TIERS, toDisplay()

### Community 101 - "Module 101"
Cohesion: 0.31
Nodes (8): check_dns_records(), check_page_rules(), check_ssl_configuration(), main(), Check Page Rules for potential redirect loops.      Returns: (has_issues, issues, Main diagnostic function., Check SSL/TLS configuration for common issues.      Returns: (has_issues, issues, Check DNS configuration for common issues.      Returns: (has_issues, issues_lis

### Community 102 - "Module 102"
Cohesion: 0.39
Nodes (7): extract_go(), extract_php(), extract_python(), extract_ruby(), extract_rust(), extract_typescript(), extract_api.sh script

### Community 103 - "Module 103"
Cohesion: 0.31
Nodes (6): corsHeaders(), OPTIONS(), POST(), GET(), generateRecommendations(), Recommendation

### Community 104 - "Module 104"
Cohesion: 0.42
Nodes (6): ContactInput, POST(), StarRating(), ensurePlus(), phonePair(), stripPlus()

### Community 105 - "Module 105"
Cohesion: 0.39
Nodes (8): DemoResponse, extractService(), extractTime(), generateDemoResponse(), getGreeting(), getServiceEmoji(), getServiceMenu(), POST()

### Community 106 - "Module 106"
Cohesion: 0.22
Nodes (8): extends, ignorePatterns, admin/, supabase/functions/, rules, react/no-unescaped-entities, @typescript-eslint/no-explicit-any, next/core-web-vitals

### Community 107 - "Module 107"
Cohesion: 0.29
Nodes (4): AuthMode, Step, OtpInput(), OtpInputProps

### Community 108 - "Module 108"
Cohesion: 0.25
Nodes (7): FAQ_DATA, HomePage(), JSON_LD_APP, JSON_LD_FAQ, JSON_LD_ORG, JSON_LD_WEBSITE, metadata

### Community 109 - "Module 109"
Cohesion: 0.25
Nodes (6): getIndustryConfigAsync(), INDUSTRY_CONFIG, IndustryConfig, IndustryOrderingConfig, IndustryPaymentConfig, IndustrySchedulingConfig

### Community 110 - "Module 110"
Cohesion: 0.46
Nodes (7): cancelSubscription(), chargeToken(), createPlan(), createSubscription(), flutterwaveRequest(), getCardToken(), getSubscription()

### Community 111 - "Module 111"
Cohesion: 0.67
Nodes (6): emit(), extract_docstrings_go(), extract_docstrings_python(), extract_docstrings_rust(), extract_docstrings_typescript(), discover_docs.sh script

### Community 112 - "Module 112"
Cohesion: 0.29
Nodes (3): Calculator, CalculatorConfig, Operation

### Community 114 - "Module 114"
Cohesion: 0.33
Nodes (6): CURRENCY_MAP, CURRENCY_SYMBOLS, formatAmount(), PageState, PayLinkInfo, ScanToPayPage()

### Community 115 - "Module 115"
Cohesion: 0.33
Nodes (6): BUILT_IN_PATTERNS, BusinessProfile, DAY_NAMES, FaqEntry, formatOperatingHours(), tryFaqResponse()

### Community 116 - "Module 116"
Cohesion: 0.43
Nodes (5): CalendarEvent, createCalendarEvent(), refreshGoogleToken(), syncBookingToCalendar(), updateCalendarEvent()

### Community 117 - "Module 117"
Cohesion: 0.47
Nodes (5): fix_ssl_mode(), main(), purge_cache(), Change SSL mode for a zone.      Args:         zone_id: Cloudflare zone ID, Purge all Cloudflare cache for the zone.

### Community 118 - "Module 118"
Cohesion: 0.60
Nodes (5): authenticateAndVerifyOwnership(), DELETE(), GET(), POST(), PUT()

### Community 119 - "Module 119"
Cohesion: 0.60
Nodes (5): authenticateAndVerifyOwnership(), DELETE(), GET(), POST(), PUT()

### Community 120 - "Module 120"
Cohesion: 0.40
Nodes (5): CATEGORIES, HELP_ARTICLES, HELP_CATEGORIES, HelpArticle, HelpPage()

### Community 122 - "Module 122"
Cohesion: 0.53
Nodes (5): BACK_PATTERNS, ESCAPE_HATCH_PATTERNS, EXIT_PATTERNS, handleEscapeHatch(), MENU_PATTERNS

### Community 125 - "Module 125"
Cohesion: 0.40
Nodes (3): Check if email contains @ symbol., Represents a user in the system., User

### Community 126 - "Module 126"
Cohesion: 0.70
Nodes (4): handleDataExchange(), handleFlowComplete(), POST(), verifyMetaSignature()

### Community 127 - "Module 127"
Cohesion: 0.50
Nodes (4): ContractAccessPage(), maskIp(), metadata, PageProps

### Community 128 - "Module 128"
Cohesion: 0.40
Nodes (3): CATEGORIES, HELP_ARTICLES, HelpArticle

### Community 129 - "Module 129"
Cohesion: 0.60
Nodes (4): EventData, EventPage(), generateMetadata(), getEvent()

### Community 131 - "Module 131"
Cohesion: 0.40
Nodes (3): EventOrPartyDetails, InviteData, PageState

### Community 132 - "Module 132"
Cohesion: 0.50
Nodes (3): metadata, SignedWaiverView(), PrintButton()

### Community 134 - "Module 134"
Cohesion: 0.50
Nodes (4): chargePaystackAuthorization(), chargeSavedCard(), getSavedPaymentMethod(), SavedMethod

### Community 136 - "Module 136"
Cohesion: 0.60
Nodes (4): encryptToken(), isAlreadyEncrypted(), KEY, main()

### Community 137 - "Module 137"
Cohesion: 0.40
Nodes (3): CATEGORIES, DEFAULT_SERVICES, supabase

### Community 140 - "Module 140"
Cohesion: 0.83
Nodes (3): corsHeaders(), GET(), OPTIONS()

### Community 141 - "Module 141"
Cohesion: 0.83
Nodes (3): corsHeaders(), OPTIONS(), POST()

### Community 142 - "Module 142"
Cohesion: 0.83
Nodes (3): GET(), POST(), requireAdminOrFinance()

### Community 143 - "Module 143"
Cohesion: 1.00
Nodes (3): getPayPalBaseUrl(), POST(), verifyPayPalWebhook()

### Community 144 - "Module 144"
Cohesion: 0.83
Nodes (3): generateTimeSlots(), POST(), verifyMetaSignature()

### Community 147 - "Module 147"
Cohesion: 0.50
Nodes (3): migration229, migration230, MIGRATIONS_DIR

### Community 148 - "Module 148"
Cohesion: 0.50
Nodes (3): name, private, version

### Community 149 - "Module 149"
Cohesion: 0.50
Nodes (3): errorRate, options, pageLoadTime

## Knowledge Gaps
- **1100 isolated node(s):** `find-collaborator.sh script`, `Calculator`, `Operation`, `CalculatorConfig`, `extends` (+1095 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **51 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `p()` connect `Admin Payouts & Finance` to `Account Management`, `Module 66`, `Module 38`, `Module 70`, `Admin UI Components`, `Module 72`, `Module 74`, `Admin Auth & Utilities`, `Module 21`, `Module 22`, `Module 23`, `Module 25`, `Module 95`?**
  _High betweenness centrality (0.125) - this node is a cross-community bridge._
- **Why does `createServiceClient()` connect `Account Management` to `Account & Audit API`, `Admin Payouts & Finance`, `Dashboard Campaigns`, `Auth & Booking API`, `Module 132`, `Public Booking API`, `Consent & Privacy`, `Module 140`, `Module 141`, `Refund Processing`, `Module 142`, `Module 143`, `Receipts & PDFs`, `Module 16`, `Module 144`, `Module 19`, `Module 27`, `Module 36`, `Module 38`, `Module 43`, `Module 60`, `Module 62`, `Module 63`, `Module 65`, `Module 68`, `Module 69`, `Module 70`, `Module 72`, `Module 93`, `Module 103`, `Module 108`, `Module 118`, `Module 119`, `Module 126`, `Module 127`?**
  _High betweenness centrality (0.100) - this node is a cross-community bridge._
- **Why does `createClient()` connect `Account & Audit API` to `Account Management`, `Admin Payouts & Finance`, `Module 129`, `Auth & Booking API`, `Public Booking API`, `Consent & Privacy`, `Module 142`, `Refund Processing`, `Module 21`, `Module 27`, `Module 30`, `Module 36`, `Module 38`, `Module 43`, `Module 62`, `Module 76`, `Module 93`, `Module 97`, `Module 103`, `Module 118`, `Module 119`?**
  _High betweenness centrality (0.053) - this node is a cross-community bridge._
- **What connects `find-collaborator.sh script`, `Calculator`, `Operation` to the rest of the system?**
  _1100 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Account & Audit API` be split into smaller, more focused modules?**
  _Cohesion score 0.01899123845607388 - nodes in this community are weakly interconnected._
- **Should `Account Management` be split into smaller, more focused modules?**
  _Cohesion score 0.042717086834733894 - nodes in this community are weakly interconnected._
- **Should `Admin Payouts & Finance` be split into smaller, more focused modules?**
  _Cohesion score 0.06788926115323576 - nodes in this community are weakly interconnected._