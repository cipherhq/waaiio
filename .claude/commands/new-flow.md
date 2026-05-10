# Scaffold a New Bot Flow

Create a new WhatsApp bot conversational flow with proper types, registration, and capability routing.

## Usage
`/new-flow <name> [description of what the flow should do]`

Example: `/new-flow gift-card Allow customers to buy and redeem gift cards`

## Architecture Reference

### Flow System Overview
- Flows live in `lib/bot/flows/<name>.flow.ts`
- Each flow exports a `FlowDefinition` with an array of `FlowStepConfig` steps
- The `FlowExecutor` (`lib/bot/flows/executor.ts`) runs steps sequentially
- Steps are found by ID — cross-flow lookup is supported (one flow can route to another flow's step)
- Session data persists between steps in `session.session_data` (JSON object on `bot_sessions` table)

### Types (from `lib/bot/flows/types.ts`)

```typescript
interface FlowStepConfig {
  id: string;                                              // Unique step identifier
  prompt(ctx: FlowContext): Promise<PromptMessage[]>;      // What to show the user
  validate(input: string, ctx: FlowContext): Promise<ValidationResult>; // Process user's reply
  next(ctx: FlowContext): Promise<string | null>;          // Next step ID (null = end flow)
  skipIf?(ctx: FlowContext): Promise<boolean>;             // Skip this step conditionally
}

// Prompt message types — what the bot can send:
type PromptMessage = PromptText | PromptList | PromptButtons | PromptImage | PromptDocument;

interface PromptText { type: 'text'; text: string; }
interface PromptButtons {
  type: 'buttons';
  body: string;
  buttons: Array<{ id: string; title: string }>;  // Max 3 buttons, 20 char limit per title
}
interface PromptList {
  type: 'list';
  title: string;          // Max 60 chars
  body: string;
  buttonLabel: string;    // Max 20 chars, label for the list menu button
  items: Array<{ title: string; description?: string; postbackText: string }>;  // Max 10 items
}
interface PromptImage { type: 'image'; imageUrl: string; caption?: string; }
interface PromptDocument { type: 'document'; url: string; filename: string; caption?: string; }

interface ValidationResult {
  valid: boolean;
  errorMessage?: string;     // Shown to user if valid=false
  data?: Record<string, unknown>;  // Merged into session_data
}

interface FlowContext {
  supabase: SupabaseClient;  // Service-role client (bypasses RLS)
  sender: MessageSender;     // Send messages outside the flow
  standalone: StandaloneService;
  intelligence: BotIntelligenceService;
  from: string;              // Customer's phone number (no + prefix)
  session: {
    id: string;
    user_id: string | null;
    business_id: string | null;
    current_step: string;
    session_data: Record<string, unknown>;  // Persisted state between steps
  };
  business: {
    id: string;
    name: string;
    slug: string;
    category: BusinessCategoryKey;
    flow_type: FlowType;
    subscription_tier: string;
    country_code?: CountryCode;
  } | null;
  mediaUrl?: string;   // If user sent an image/audio/document
  mediaType?: string;
}
```

### FlowDefinition structure

```typescript
import type { FlowDefinition, FlowStepConfig, FlowContext, PromptMessage, ValidationResult } from './types';

// Each step is a const with the FlowStepConfig interface
const myStep: FlowStepConfig = {
  id: 'step_name',
  async prompt(ctx) { ... },
  async validate(input, ctx) { ... },
  async next(ctx) { return 'next_step_id'; },
  async skipIf(ctx) { return false; },  // Optional
};

// Export the flow definition
export const myFlow: FlowDefinition = {
  type: 'scheduling' as any,  // Use the closest FlowType or cast
  steps: [myStep, anotherStep, ...],
};
```

## Instructions — What to Create

### 1. Create the flow file: `lib/bot/flows/<name>.flow.ts`

Follow this exact pattern:

```typescript
import type { FlowDefinition, FlowStepConfig, FlowContext, PromptMessage, ValidationResult } from './types';

// Step 1: Selection step (if user needs to choose from a list)
const selectStep: FlowStepConfig = {
  id: 'select_<item>',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const businessId = ctx.session.business_id || ctx.business?.id;
    if (!businessId) return [{ type: 'text', text: 'Something went wrong. Send "Hi" to start again.' }];

    // Load items from DB
    const { data: items } = await ctx.supabase
      .from('<table>')
      .select('id, name, price')
      .eq('business_id', businessId)
      .eq('is_active', true)
      .order('sort_order');

    if (!items || items.length === 0) {
      return [{ type: 'text', text: 'No options available right now. Please try again later.' }];
    }

    // Auto-select if only one item
    if (items.length === 1) {
      // Store in session and move on — handled by skipIf on next step
      ctx.session.session_data.selected_item = items[0];
      return [];
    }

    // 3 or fewer items → buttons; 4+ → list
    if (items.length <= 3) {
      return [{
        type: 'buttons',
        body: 'Choose an option:',
        buttons: items.map(item => ({
          id: `item_${item.id}`,
          title: item.name.slice(0, 20),  // WhatsApp 20 char limit
        })),
      }];
    }

    return [{
      type: 'list',
      title: 'Available Options',
      body: 'Select from the list below:',
      buttonLabel: 'View Options',
      items: items.map(item => ({
        title: item.name.slice(0, 24),
        description: `Price: ${item.price}`,
        postbackText: `item_${item.id}`,
      })),
    }];
  },

  async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
    const match = input.match(/^item_(.+)$/);
    const itemId = match ? match[1] : input;

    const { data: item } = await ctx.supabase
      .from('<table>')
      .select('*')
      .eq('id', itemId)
      .maybeSingle();

    if (!item) {
      return { valid: false, errorMessage: 'Please select a valid option from the list.' };
    }

    return { valid: true, data: { selected_item: item } };
  },

  async next() { return 'collect_name'; },
};

// Step 2: Collect customer name
const collectNameStep: FlowStepConfig = {
  id: 'collect_name',

  async skipIf(ctx: FlowContext): Promise<boolean> {
    // Skip if we already have their name from a previous session
    const phone = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
    const { data: profile } = await ctx.supabase
      .from('profiles')
      .select('first_name')
      .eq('phone', phone)
      .maybeSingle();
    if (profile?.first_name) {
      ctx.session.session_data.customer_name = profile.first_name;
      return true;
    }
    return false;
  },

  async prompt(): Promise<PromptMessage[]> {
    return [{ type: 'text', text: 'What is your name?' }];
  },

  async validate(input: string): Promise<ValidationResult> {
    const name = input.trim();
    if (name.length < 2) return { valid: false, errorMessage: 'Please enter your name.' };
    return { valid: true, data: { customer_name: name } };
  },

  async next() { return 'confirm'; },
};

// Step 3: Confirmation
const confirmStep: FlowStepConfig = {
  id: 'confirm_<action>',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const d = ctx.session.session_data;
    const item = d.selected_item as Record<string, unknown>;
    const name = d.customer_name as string;

    return [{
      type: 'buttons',
      body: [
        `Please confirm:`,
        ``,
        `Name: *${name}*`,
        `Item: *${item.name}*`,
        `Price: *${item.price}*`,
        ``,
        `Is this correct?`,
      ].join('\n'),
      buttons: [
        { id: 'yes', title: 'Yes, confirm' },
        { id: 'no', title: 'No, go back' },
      ],
    }];
  },

  async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
    const lower = input.toLowerCase();
    if (['yes', 'confirm', 'ok', 'sure', 'yeah'].includes(lower)) {
      return { valid: true, data: { confirmed: true } };
    }
    if (['no', 'cancel', 'back', 'nah'].includes(lower)) {
      return { valid: true, data: { confirmed: false } };
    }
    return { valid: false, errorMessage: 'Please reply *Yes* or *No*.' };
  },

  async next(ctx: FlowContext) {
    if (ctx.session.session_data.confirmed) return 'done_step';
    return 'select_<item>';  // Go back to selection
  },
};

// Step 4: Completion
const doneStep: FlowStepConfig = {
  id: 'done_step',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const d = ctx.session.session_data;

    // Save to database
    if (ctx.business) {
      await ctx.supabase.from('<result_table>').insert({
        business_id: ctx.business.id,
        // ... fields
      });
    }

    // Deactivate the session
    await ctx.supabase.from('bot_sessions')
      .update({ is_active: false })
      .eq('id', ctx.session.id);

    return [{ type: 'text', text: 'Done! Thank you. Send "Hi" to start again.' }];
  },

  async validate(): Promise<ValidationResult> {
    return { valid: true };
  },

  async next() { return null; },  // End flow
};

export const <name>Flow: FlowDefinition = {
  type: 'scheduling' as any,
  steps: [selectStep, collectNameStep, confirmStep, doneStep],
};
```

### 2. Register in `lib/bot/flows/registry.ts`

```typescript
// Add import at top:
import { <name>Flow } from './<name>.flow';

// Add to EXTENDED_REGISTRY:
const EXTENDED_REGISTRY = {
  ...FLOW_REGISTRY,
  // ... existing entries
  '<name>': <name>Flow,  // ADD THIS
};
```

### 3. Add capability routing in `lib/bot/flows/capability-selection.flow.ts`

Find the `getFirstStepForCapability()` function and add:
```typescript
case '<capability_id>': return 'select_<item>';  // First step of your flow
```

Find `getCapabilityLabel()` and add:
```typescript
case '<capability_id>': return '<Friendly Label>';
```

### 4. Add capability ID (if new) in `lib/capabilities/types.ts`

Add to `CapabilityId` union, `CAPABILITIES` array, `CAPABILITY_TIER_REQUIREMENTS`, and relevant `CATEGORY_DEFAULT_CAPABILITIES`.

## Key Rules

1. **Button titles max 20 chars** — WhatsApp enforces this. Truncate with `.slice(0, 20)`
2. **Max 3 buttons per message** — Use list message for 4+ options
3. **List items max 10** — Paginate if more
4. **Bold text uses *asterisks*** — WhatsApp markdown: `*bold*`, `_italic_`
5. **Session data is the only state** — Everything persists in `session.session_data`
6. **validate() returns data object** — Merged into session_data automatically
7. **Use ctx.supabase** — It's the service-role client (bypasses RLS)
8. **next() returns step ID** — Use `null` to end the flow
9. **skipIf() is optional** — Use it to skip steps based on session state
10. **Empty prompt = auto-advance** — If prompt returns `[]`, executor moves to next step
11. **Escape hatches are handled by executor** — "cancel", "quit", "exit" work automatically
12. **Payment integration** — Import `initializePayment` from `./shared/payment` for payment steps
13. **After flow ends** — Either deactivate session or route back to `select_capability` for menu
