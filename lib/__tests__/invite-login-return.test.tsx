// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render, fireEvent, screen, waitFor, cleanup } from '@testing-library/react';
const h=vi.hoisted(()=>({push:vi.fn(),next:`/invite/${'a'.repeat(64)}?setup=1`,from:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:h.push,refresh:vi.fn()}),useSearchParams:()=>new URLSearchParams({next:h.next})}));
vi.mock('@/lib/posthog/client',()=>({getPostHogClient:()=>null}));
vi.mock('@/components/auth/PhoneInput',()=>({PhoneInput:()=>null}));
vi.mock('@/components/auth/OtpInput',()=>({OtpInput:()=>null}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({auth:{signInWithPassword:async()=>({data:{user:{id:'staff'}},error:null})},from:h.from})}));
import LoginPage from '@/app/(auth)/login/page';
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.clearAllMocks();});
it('returns an invited staff account to acceptance without requiring ownership',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true}));
 const q:any={select:()=>q,eq:async()=>({count:0})};h.from.mockReturnValue(q);
 const {container}=render(<LoginPage/>);fireEvent.change(screen.getByPlaceholderText('you@example.com'),{target:{value:'staff@example.com'}});fireEvent.change(container.querySelector('input[type="password"]')!,{target:{value:'testpassword'}});fireEvent.submit(container.querySelector('form')!);
 await waitFor(()=>expect(h.push).toHaveBeenCalledWith(h.next));expect(h.from).not.toHaveBeenCalled();
});
