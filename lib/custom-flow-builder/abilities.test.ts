import { describe, expect, it } from 'vitest';
import { abilitiesFor, customAbility, defaultTicks, planFlow } from './abilities';
import { applyStarter, STARTERS } from './starters';
import { createTemplate } from './templates';
import { matchRows } from './live-preview';
import type { EditableFlow } from './order';

const blank = createTemplate({ id: 'f', businessId: 'b', template: 'blank', name: 'F', keyword: '', language: 'en', timezone: 'Africa/Lagos', currency: 'NGN', bindings: [] }).definition as EditableFlow;

describe('start screen plan (#1107)', () => {
  it('a starter with its own ticks gives exactly the starter flow', () => {
    for (const id of Object.keys(STARTERS) as Array<keyof typeof STARTERS>) {
      const chosen = abilitiesFor(id).filter(item => defaultTicks(id).includes(item.key));
      const plan = planFlow(id, chosen);
      expect(plan.unchanged).toBe(true);
      expect(plan.lists.map(list => list.name)).toEqual(STARTERS[id].lists.map(list => list.name));
      expect(plan.build(blank)).toEqual(applyStarter(blank, id));
    }
  });
  it('blank and festival start with nothing extra to make', () => {
    expect(planFlow('blank', []).unchanged).toBe(true);
    const festival = abilitiesFor('festival_info');
    expect(planFlow('festival_info', festival.filter(item => item.builtIn)).lists).toEqual([]);
  });
  it('gives a made-up list a name no other list has', () => {
    const plan = planFlow('blank', [abilitiesFor('blank').find(item => item.key === 'artists')!, customAbility('custom_1', 'Artists', 'list')]);
    expect(plan.lists.map(list => list.name)).toEqual(['Artists', 'Artists 2']);
    const flow = plan.build(blank);
    expect(flow.nodes.filter(node => node.type === 'lookup').map(node => node.type === 'lookup' && node.table)).toEqual(['Artists', 'Artists 2']);
  });
});

describe('preview search mirrors the engine', () => {
  const rows = [{ row_code: 'WIZKID', data: { name: 'Wizkid', day: 'Saturday' } }, { row_code: 'TEMS', data: { name: 'Tems', day: 'Saturday' } }];
  it('exact code, whole word, then part of a word; one letter matches nothing', () => {
    expect(matchRows(rows, ['name'], 'tems')).toEqual([rows[1]]);
    expect(matchRows(rows, ['name', 'day'], 'saturday')).toEqual(rows);
    expect(matchRows(rows, ['name'], 'wiz')).toEqual([rows[0]]);
    expect(matchRows(rows, ['name'], 'w')).toEqual([]);
  });
});
