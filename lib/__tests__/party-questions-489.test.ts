import { describe, it, expect } from 'vitest';
import { parseQuestions, validateAnswers, currentAnswers, type PartyQuestion } from '@/lib/parties/rsvp-questions';
const questions: PartyQuestion[] = [{id:'yes',label:'Access?',type:'yes_no',required:true},{id:'text',label:'Notes',type:'short_text',required:false},{id:'meal',label:'Meal',type:'single_choice',required:true,options:[{id:'a',label:'A'},{id:'b',label:'B'}]}];
describe('Party question contract', () => {
  it('accepts false and validates choice IDs', () => { expect(validateAnswers(questions,{yes:false,meal:'a'})).toEqual({yes:false,meal:'a'}); });
  it('rejects missing required, unknown keys, wrong boolean and stale choices', () => {
    for(const value of [{},{yes:'false',meal:'a'},{yes:false,meal:'c'},{yes:false,meal:'a',unknown:'x'}]) expect(()=>validateAnswers(questions,value)).toThrow();
  });
  it('rejects bounds and duplicate IDs/options', () => {
    for(const value of [[...questions,...questions],Array(11).fill(questions[0]),[{...questions[0],label:'x'.repeat(121)}],[{...questions[2],options:[{id:'a',label:'A'},{id:'a',label:'B'}]}]]) expect(()=>parseQuestions(value)).toThrow();
    expect(()=>validateAnswers(questions,{yes:true,meal:'b',text:'x'.repeat(501)})).toThrow();
  });
  it('clears optional answers and retains only compatible current answers', () => {
    expect(validateAnswers(questions,{yes:false,meal:'a',text:''})).toEqual({yes:false,meal:'a'});
    expect(currentAnswers(questions,{yes:false,meal:'retired',removed:'old'})).toEqual({yes:false});
  });
});
