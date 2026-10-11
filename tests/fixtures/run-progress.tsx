import React from 'react';
import { createRoot } from 'react-dom/client';
import { RunProgress } from '../../src/renderer/run-progress';
import type { Run } from '../../src/shared/types';
const run = (id: string) => ({ id, createdAt: new Date(Date.now()-181000).toISOString(), status: 'running' } as Run);
const invoke = async (method: string, params: unknown) => { (window as any).calls.push({ method, params }); return { delivery: 'current' }; };
(window as any).calls = [];
createRoot(document.getElementById('root')!).render(<><RunProgress run={run('one')} invoke={invoke as any} label="独立准备甲" canNudge/><RunProgress run={run('two')} invoke={invoke as any} label="独立准备乙"/></>);
