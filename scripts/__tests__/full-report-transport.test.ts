import { it,expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createHash,randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decodeFullReportTransport as decode,MAX_FULL_REPORT_BYTES as max,MAX_FULL_REPORT_CHUNK_BYTES as size } from '../full-report-transport.mjs';
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex'),prefix='PRIVATE_RELEASE_ACCEPTANCE_CHUNK_';
function fixture(raw:string|Buffer,split=size){const chunks=gzipSync(raw).toString('base64').match(new RegExp(`.{1,${split}}`,'g'))!;return{d:{transport_version:2,encoding:'gzip-base64',chunk_count:chunks.length,chunk_sha256:chunks.map(hash),decoded_sha256:hash(raw)},env:Object.fromEntries(chunks.map((c,i)=>[prefix+(i+1),c]))};}
const run=(f:ReturnType<typeof fixture>)=>decode(JSON.stringify(f.d),f.env),deny=(f:ReturnType<typeof fixture>)=>expect(()=>run(f)).toThrow(/^Full acceptance report transport invalid$/);
it.each(['{}',' \n{"unicode":"é漢😀"}\n'])('preserves exact bytes %#',raw=>expect(run(fixture(raw))).toBe(raw));
it('accepts10 chunks',()=>{const raw=JSON.stringify({x:randomBytes(285000).toString('base64')});const f=fixture(raw);expect(f.d.chunk_count).toBe(10);expect(run(f)).toBe(raw);});
it('accepts exact decoded cap',()=>{const raw='{"x":"'+'a'.repeat(max-8)+'"}';expect(Buffer.byteLength(raw)).toBe(max);expect(run(fixture(raw))).toBe(raw);});
it('rejects expansion bomb',()=>deny(fixture('{"x":"'+'a'.repeat(max)+'"}')));
it.each(['transport_version','encoding','chunk_count','chunk_sha256','decoded_sha256'])('missing descriptor %s',key=>{const f=fixture('{}');delete(f.d as any)[key];deny(f);});
it.each([0,11,1.5,'1',null])('bad count %#',n=>{const f=fixture('{}');(f.d as any).chunk_count=n;deny(f);});
it('unknown version or field',()=>{const f=fixture('{}');f.d.transport_version=3;deny(f);f.d.transport_version=2;(f.d as any).extra=true;deny(f);});
it('missing/empty chunk',()=>{const f=fixture('{}');delete f.env[prefix+1];deny(f);f.env[prefix+1]='';deny(f);});
it.each(['2','11','01','0'])('surplus slot %s',n=>{const f=fixture('{}');f.env[prefix+n]='AAAA';deny(f);});
it('empty inactive slots',()=>{const f=fixture('{}');for(let i=2;i<=10;i++)f.env[prefix+i]='';expect(run(f)).toBe('{}');});
it('reordered chunks',()=>{const f=fixture(JSON.stringify({x:randomBytes(40).toString('hex')}),32);[f.env[prefix+1],f.env[prefix+2]]=[f.env[prefix+2],f.env[prefix+1]];deny(f);});
it('hash mismatch',()=>{const f=fixture('{}');f.d.chunk_sha256[0]='0'.repeat(64);deny(f);const g=fixture('{}');g.d.decoded_sha256='0'.repeat(64);deny(g);});
it.each(['AB==','AA=A','AAAA\n','AAAA '])('noncanonical base64 %#',s=>{const f=fixture('{}');f.env[prefix+1]=s;f.d.chunk_sha256=[hash(s)];deny(f);});
it('oversize chunk',()=>{const f=fixture('{}'),s='A'.repeat(size+4);f.env[prefix+1]=s;f.d.chunk_sha256=[hash(s)];deny(f);});
it.each(['truncate','crc'])('gzip damage %s',mode=>{const f=fixture('{}');let b=Buffer.from(f.env[prefix+1],'base64');if(mode==='truncate')b=b.subarray(0,-5);else b[b.length-8]^=1;f.env[prefix+1]=b.toString('base64');f.d.chunk_sha256=[hash(f.env[prefix+1])];deny(f);});
it('invalid UTF8 with correct digest',()=>deny(fixture(Buffer.from([123,34,255,34,125]))));
it('nonreport text',()=>deny(fixture('private-fixture-secret')));
it.each(['','not-json','x'.repeat(4097),'null','[]'])('generic descriptor failure %#',d=>expect(()=>decode(d,{})).toThrow(/^Full acceptance report transport invalid$/));
it('validated full-only workflow binding',()=>{const yaml=readFileSync(new URL('../../.github/workflows/deploy-reduced-release.yml',import.meta.url),'utf8');expect(yaml).toContain('full_release_policy: ${{ steps.plan.outputs.full_release_policy }}');for(let i=1;i<=10;i++)expect(yaml).toContain(`${prefix+i}: \${{ needs.plan.outputs.full_release_policy == 'true' && secrets.${prefix+i} || '' }}`);});

it('rejects an11chunk report even with matching descriptor hashes',()=>{const f=fixture(JSON.stringify({x:randomBytes(315000).toString('base64')}));expect(f.d.chunk_count).toBe(11);deny(f);});
