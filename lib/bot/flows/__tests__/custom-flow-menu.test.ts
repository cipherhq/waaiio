import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockContext, getStep } from './helpers';
import { capabilitySelectionFlow } from '../capability-selection.flow';
import { publishedFlowChoices, resolveFlowMenuSelection } from '../../custom-flow/menu';
import { isSharedConversation } from '../shared/navigation';
import { updatesOptInRowFor } from '../../customer-updates-optin';
vi.mock('../../custom-flow/menu', async original => ({ ...await original<typeof import('../../custom-flow/menu')>(), publishedFlowChoices: vi.fn() }));
vi.mock('@/lib/capabilities/service', () => ({ getCapabilityCustomLabels: vi.fn(async () => ({})) }));
vi.mock('../shared/navigation', async original => ({ ...await original<typeof import('../shared/navigation')>(), isSharedConversation: vi.fn(async () => false) }));
vi.mock('@/lib/promotions/history', () => ({ hasPromoHistory: vi.fn(async () => false) }));
vi.mock('../../customer-updates-optin', async original => ({ ...await original<typeof import('../../customer-updates-optin')>(), updatesOptInRowFor: vi.fn(async () => null) }));
const step = getStep(capabilitySelectionFlow, 'select_capability');
const flows = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`, name: `Published flow ${i + 1}` }));
function ctx(caps = ['chat', 'custom_flow']) {
  const c = createMockContext(); c.session.current_step = 'select_capability'; c.session.session_data.capabilities = caps; return c;
}
function ids(message: any) { return message.buttons?.map((x: any) => x.id) ?? message.items?.map((x: any) => x.postbackText) ?? []; }
beforeEach(() => { vi.clearAllMocks(); vi.mocked(publishedFlowChoices).mockResolvedValue(flows(1)); vi.mocked(isSharedConversation).mockResolvedValue(false); vi.mocked(updatesOptInRowFor).mockResolvedValue(null); });
describe('custom-flow choices in the normal business menu', () => {
  it('keeps an ordinary option first and prevents one-capability auto-skip', async () => {
    const c = ctx(); expect(await step.skipIf!(c)).toBe(false);
    const [message] = await step.prompt!(c);
    expect(ids(message)).toEqual(['cap_chat', `cf-start:${flows(1)[0].id}`]);
    expect((c.session.session_data._custom_flow_menu as any).postbacks).toEqual(ids(message));
  });
  it('renders a custom-only business instead of an empty menu', async () => {
    const c = ctx(['custom_flow']); expect(await step.skipIf!(c)).toBe(false);
    expect(ids((await step.prompt!(c))[0])).toEqual([`cf-start:${flows(1)[0].id}`]);
  });
  it.each([0, 1, 2, 3, 9, 10, 19])('preserves WhatsApp row limits for %i flows plus chat', async count => {
    vi.mocked(publishedFlowChoices).mockResolvedValue(flows(count));
    const c = ctx(); const [message] = await step.prompt!(c);
    expect(ids(message).length).toBeLessThanOrEqual(10);
    expect(message.type).toBe(count < 3 ? 'buttons' : 'list');
    if (count > 9) expect(ids(message).at(-1)).toBe('cap_nav_more');
    if (!count) expect(c.session.session_data._custom_flow_menu).toBeUndefined();
  });
  it('maps numeric page navigation to the exact displayed page and persists new snapshots', async () => {
    vi.mocked(publishedFlowChoices).mockResolvedValue(flows(19));
    const c = ctx(); await step.prompt!(c);
    expect(await step.validate!('10', c)).toMatchObject({ valid: true, data: { _cap_menu_navigate: true } });
    const [second] = await step.prompt!(c);
    expect(ids(second)[0]).toBe('cap_nav_prev');
    expect(resolveFlowMenuSelection(c.session, c.business!.id, '2')).toMatchObject({ kind: 'selection', flowId: flows(19)[8].id });
    expect(await step.validate!('1', c)).toMatchObject({ valid: true });
    expect(c.session.session_data._cap_menu_page).toBe(0);
  });
  it('keeps existing shared-directory and opt-in rows ahead of custom choices, even across pagination', async () => {
    vi.mocked(isSharedConversation).mockResolvedValue(true);
    vi.mocked(publishedFlowChoices).mockResolvedValue(flows(10));
    vi.mocked(updatesOptInRowFor).mockResolvedValue({ title: 'Updates', postbackText: 'updates-test', description: 'Existing description' } as any);
    const c = ctx(); c.session.session_data._greeting = 'Welcome';
    const [message] = await step.prompt!(c);
    expect(ids(message).slice(0, 4)).toEqual(['cap_chat', 'nav_directory', 'updates-test', `cf-start:${flows(1)[0].id}`]);
    expect(updatesOptInRowFor).toHaveBeenCalledOnce();
  });
  it('protects published names from translation and uses title limits without changing IDs', async () => {
    const flow = { ...flows(1)[0], name: 'A very long merchant festival information name' };
    vi.mocked(publishedFlowChoices).mockResolvedValue([flow]);
    const [message] = await step.prompt!(ctx());
    expect((message as any).buttons[1].title.length).toBeLessThanOrEqual(20);
    expect((message as any)._localization.protectedValues).toContain((message as any).buttons[1].title);
    expect(ids(message)[1]).toBe(`cf-start:${flow.id}`);
  });
  it('clears snapshot on My Account exit and rejects stale/unhandled custom IDs', async () => {
    const c = ctx(); await step.prompt!(c);
    expect(await step.validate!(`cf-start:${flows(1)[0].id}`, c)).toMatchObject({ valid: false });
    expect(await step.validate!('99', c)).toMatchObject({ valid: false });
    expect(await step.validate!('cap_my_account', c)).toMatchObject({ valid: true });
    expect(c.session.session_data._custom_flow_menu).toBeUndefined();
  });
  it('does not query flows for businesses without custom_flow and preserves ordinary auto-skip', async () => {
    const c = ctx(['chat']); expect(await step.skipIf!(c)).toBe(true);
    expect(publishedFlowChoices).not.toHaveBeenCalled();
  });
});
