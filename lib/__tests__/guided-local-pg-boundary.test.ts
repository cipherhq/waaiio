import { describe,it,expect } from 'vitest';
import { assertGuidedLocalPg } from './helpers/guided-local-pg';
const base={socketDirectory:null,peerAddress:'127.0.0.1',serverAddress:'172.18.0.2/32',initialDatabase:'pg_test_18',expectedDatabase:'pg_test_18'};
describe('guided disposable database transport boundary',()=>{
  it.each(['127.0.0.1','::1','::ffff:127.0.0.1'])('accepts actual loopback peer %s independently of Docker server address',peerAddress=>expect(()=>assertGuidedLocalPg({...base,peerAddress})).not.toThrow());
  it.each(['172.18.0.2','203.0.113.1',undefined])('rejects non-loopback or absent TCP peer %s',peerAddress=>expect(()=>assertGuidedLocalPg({...base,peerAddress})).toThrow());
  it('requires both approved Unix socket path and a Unix server connection',()=>{
    expect(()=>assertGuidedLocalPg({...base,socketDirectory:'/private/tmp/waaiio-guided-test',peerAddress:undefined,serverAddress:null})).not.toThrow();
    expect(()=>assertGuidedLocalPg({...base,socketDirectory:'/private/tmp/other',serverAddress:null})).toThrow();
    expect(()=>assertGuidedLocalPg({...base,socketDirectory:'/private/tmp/waaiio-guided-test'})).toThrow();
  });
  it('rejects a different initial database before any database creation',()=>expect(()=>assertGuidedLocalPg({...base,initialDatabase:'unexpected'})).toThrow());
});
