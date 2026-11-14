import { describe, expect, it, vi } from 'vitest';
import { createMockContext, getStep } from '@/lib/bot/flows/__tests__/helpers';
import { seatsAvailableDuring, type SeatingHold } from '@/lib/seating/holds';
import { openTimesOnDate } from '@/lib/bot/flows/shared/slot-availability';
const hold = (start: string, end: string, seats: number | null = 2): SeatingHold => ({
  id:'h',group_id:'g',business_id:'b',seating_resource_id:'r',starts_at:`2035-11-02T${start}:00`,
  ends_at:`2035-11-02T${end}:00`,seats,whole_resource:seats === null,label:'VIP',released_at:null,
});
describe('seating hold availability', () => {
  it('deducts peak simultaneous seats rather than the sum of disjoint holds', () => {
    expect(seatsAvailableDuring([hold('18:00','19:00',6),hold('19:00','20:00',6)],10,'2035-11-02T18:00:00',120)).toBe(4);
    expect(seatsAvailableDuring([hold('18:00','19:30',6),hold('19:00','20:00',3)],10,'2035-11-02T18:00:00',120)).toBe(1);
  });
  it('ignores released holds and allows touching boundaries', () => {
    expect(seatsAvailableDuring([hold('18:00','19:00',null)],10,'2035-11-02T19:00:00',60)).toBe(10);
    expect(seatsAvailableDuring([{...hold('18:00','20:00',null),released_at:'2035-11-01T12:00:00Z'}],10,'2035-11-02T18:00:00',60)).toBe(10);
  });
  it('filters party sizes through the existing time picker while preserving customer exclusivity', () => {
    const options = { date:'2035-11-02',isTable:true,maxCapacity:1,fallbackDuration:60,candidateDuration:60,bufferMinutes:0,
      seatingHolds:[hold('18:00','19:00',2)],seatingCapacity:10,seatsRequired:8 };
    expect(openTimesOnDate(['18:00','19:00'],[],options).map(t=>t.time)).toEqual(['18:00','19:00']);
    expect(openTimesOnDate(['18:00','19:00'],[],{...options,seatsRequired:9}).map(t=>t.time)).toEqual(['19:00']);
    expect(openTimesOnDate(['18:00'],[{date:'2035-11-02',time:'18:00',metadata:{duration_minutes:60}}],options)).toEqual([]);
  });
});


describe('table party-size holds through real scheduling steps', () => {
  async function context(seats: number) {
    const { schedulingFlow } = await import('@/lib/bot/flows/scheduling.flow');
    const ctx = createMockContext();
    ctx.session.session_data = { _is_table_reservation:true, _seating_capacity:10, _seating_min_party:1,
      _seating_duration:120, seating_resource_id:'r', date:'2035-11-02', time:'18:00', party_size:9 };
    ctx.intelligence.resetAbuse=vi.fn();
    ctx.supabase.from=vi.fn(() => {
      const query: Record<string, unknown> = {};
      for (const method of ['select','range','order','eq','is','lt']) query[method]=vi.fn(() => query);
      query.gt=vi.fn(async () => ({data:[hold('18:00','20:00',seats)],error:null}));
      return query;
    }) as never;
    return {ctx,step:getStep(schedulingFlow,'select_quantity')};
  }
  it('revalidates existing party size and accepts only the remaining exact fit', async () => {
    const {ctx,step}=await context(2);
    expect(await step.skipIf!(ctx)).toBe(false);
    expect((await step.validate!('9',ctx)).valid).toBe(false);
    expect(await step.validate!('8',ctx)).toMatchObject({valid:true,data:{party_size:8}});
  });
  it('routes back to time selection when a hold consumes the remaining seats', async () => {
    const {ctx,step}=await context(10);
    const result=await step.validate!('1',ctx);
    expect(result).toMatchObject({valid:true,data:{_seating_reselect_time:true}});
    Object.assign(ctx.session.session_data,result.data);
    expect(await step.next!(ctx)).toBe('select_time');
    expect(ctx.session.session_data._seating_reselect_time).toBeUndefined();
  });
});
