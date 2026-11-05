import { describe,it,expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { decodePrivateReport,REPORT_TRANSPORT_PREFIX as prefix,MAX_REPORT_BYTES,MAX_REPORT_TRANSPORT_BYTES } from '../private-report-transport.mjs';
const wrap=(value:string|Buffer)=>prefix+gzipSync(value).toString('base64');
describe('bounded private report transport',()=>{
 it.each(['{"case":"fixture"}',' \n{"unicode":"é漢😀"}\n','{}'])('preserves exact original raw and compressed text %#',raw=>{expect(decodePrivateReport(raw)).toBe(raw);expect(decodePrivateReport(wrap(raw))).toBe(raw);});
 it('accepts exactly the decompressed bound',()=>{const raw='{"x":"'+'a'.repeat(MAX_REPORT_BYTES-8)+'"}';expect(Buffer.byteLength(raw)).toBe(MAX_REPORT_BYTES);expect(decodePrivateReport(wrap(raw))).toBe(raw);});
 it.each([undefined,null,42,'','gzip-base64-v2:AAAA','br-base64-v1:AAAA','gzip-base64-v1:','gzip-base64-v1:AA=A','gzip-base64-v1:AA==\n','gzip-base64-v1:AB==','gzip-base64-v1:AAAA','not-json','{"x":"\ud800"}'])('rejects invalid input generically %#',value=>{expect(()=>decodePrivateReport(value)).toThrow(/^Private acceptance report transport invalid$/);});
 it('rejects a truncated gzip member',()=>{const bytes=gzipSync('{"fixture":true}');expect(()=>decodePrivateReport(prefix+bytes.subarray(0,-5).toString('base64'))).toThrow('transport');});
 it('rejects corrupt gzip CRC',()=>{const bytes=gzipSync('{}');bytes[bytes.length-8]^=1;expect(()=>decodePrivateReport(prefix+bytes.toString('base64'))).toThrow('transport');});
 it('rejects non UTF-8 output',()=>{expect(()=>decodePrivateReport(wrap(Buffer.from([123,34,255,34,125])))).toThrow('transport');});
 it('rejects oversized envelope before decompression',()=>{expect(()=>decodePrivateReport(prefix+'A'.repeat(MAX_REPORT_TRANSPORT_BYTES))).toThrow('transport');});
 it('rejects decompression expansion beyond bound',()=>{expect(()=>decodePrivateReport(wrap('{"x":"'+'a'.repeat(MAX_REPORT_BYTES)+'"}'))).toThrow('transport');});
 it('rejects oversized raw UTF-8 bytes',()=>{expect(()=>decodePrivateReport('{"x":"'+'é'.repeat(MAX_REPORT_BYTES/2)+'"}')).toThrow('transport');});
 it('never includes malformed content in errors',()=>{const secret='private-fixture-value';try{decodePrivateReport(prefix+secret);}catch(error){expect(String(error)).not.toContain(secret);expect(String(error)).toBe('Error: Private acceptance report transport invalid');}});
});
