# Scaffold a New Bot Flow

Create a new WhatsApp bot conversational flow.

## Usage
`/new-flow <name> [--capability <cap_id>]`

Example: `/new-flow gift-card --capability loyalty`

## Instructions

1. Read `lib/bot/flows/executor.ts` to understand the FlowStep interface and execution model.

2. Read one existing simple flow (e.g., `lib/bot/flows/feedback.flow.ts`) as a template.

3. Create `lib/bot/flows/<name>.flow.ts` with this structure:

```typescript
import { createFlowDefinition, type FlowStep } from './executor';
import { createServiceClient } from '@/lib/supabase/service';

const steps: Record<string, FlowStep> = {
  // First step — usually select/list items
  select_item: {
    prompt: async (ctx) => {
      // Load data, return message options
    },
    validate: async (ctx, input) => {
      // Validate user's selection
    },
    next: () => 'next_step',
  },
  // ... more steps
  confirm: {
    prompt: async (ctx) => {
      // Show summary, ask for confirmation
    },
    validate: async (ctx, input) => {
      const lower = input.toLowerCase();
      if (['yes', 'confirm', 'ok'].includes(lower)) return true;
      if (['no', 'cancel', 'back'].includes(lower)) return 'cancelled';
      return 'Please reply Yes or No';
    },
    next: () => 'done',
  },
  done: {
    prompt: async (ctx) => {
      // Final message, save data
      return { text: 'Done! ✅', end: true };
    },
  },
};

export const <name>Flow = createFlowDefinition('<name>', steps);
```

4. Register the flow in `lib/bot/flows/registry.ts`:
   - Import the new flow
   - Add to the registry map

5. Add routing in `lib/bot/flows/capability-selection.flow.ts`:
   - Map the capability to the flow's first step in `getFirstStepForCapability()`
   - Add a label in `getCapabilityLabel()`

6. If a new capability ID is needed, add it to `lib/capabilities/types.ts`:
   - Add to `CapabilityId` union type
   - Add to `CAPABILITIES` array with label, description, icon
   - Add tier requirement in `CAPABILITY_TIER_REQUIREMENTS`

7. Report what was created and test instructions.

## Key Patterns
- Always use `createServiceClient()` for DB queries in flows (runs server-side)
- Use `ctx.session` to store state between steps
- Return `{ text, buttons }` for button options or `{ text, list }` for list menus
- `end: true` in the return signals flow completion
- Support escape hatches — the executor handles "cancel" automatically
