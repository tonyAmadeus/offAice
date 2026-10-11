import {randomUUID} from 'node:crypto';
import {SnapshotPublisher} from '../shared/snapshot-sync';
import type {PushEvent,Snapshot} from '../shared/types';
import { Engine } from './engine';
import { setOwnershipListener } from './process-supervisor';
import { redact, registerSecret } from './security';
import { setClaudeOAuthToken, setClaudeApiKey } from './adapters/claude';
/** The saved Claude token goes to the Claude adapter only (never process.env), redacted from every log. */
const claudeToken = (value?: string) => { if (value) registerSecret(value); setClaudeOAuthToken(value); };
let engine: Engine | undefined;
let port: any;
let closing = false;
const send = (value: unknown) => port?.postMessage(value);
const snapshots=new SnapshotPublisher(randomUUID());
function publish(event:PushEvent){const next=event.type==='snapshot'?snapshots.publish(event.snapshot):event;if(next)send({type:'push',event:next});}
function currentSnapshot(){publish({type:'snapshot',snapshot:engine!.snapshot()});return snapshots.current!;}
setOwnershipListener(info => send({ type: 'ownership', info }));
(process as any).parentPort.on('message', (event: any) => {
  if (event.data?.type !== 'connect' || !event.ports?.[0] || port) return;
  port = event.ports[0];
  engine = new Engine(event.data.dataDirectory, publish, () => {});
  engine.setKey(event.data.key || undefined);
  engine.setAcpSecrets(event.data.acpSecrets || {});
  claudeToken(event.data.claudeToken || undefined);
  if(event.data.claudeApiKey)registerSecret(event.data.claudeApiKey);setClaudeApiKey(event.data.claudeApiKey||undefined);
  port.on('message', async (message: any) => {
    const packet = message.data;
    if (!packet?.id || typeof packet.method !== 'string') return;
    try {
      if (closing) throw new Error('执行服务正在关闭，不再接收新操作');
      if(packet.method==='internal.claudeApiKey'){if(packet.params?.value)registerSecret(packet.params.value);setClaudeApiKey(packet.params?.value||undefined);engine!.broadcast();send({id:packet.id,result:true});return;}
      if (packet.method === 'internal.claudeToken') { claudeToken(packet.params?.value || undefined); engine!.broadcast(); send({ id: packet.id, result: true }); return; }
      if (packet.method === 'internal.key') { engine!.setKey(packet.params?.value || undefined); send({ id: packet.id, result: true }); return; }
      if (packet.method === 'internal.close') { closing = true; await engine!.close(); send({ id: packet.id, result: true }); process.exit(0); return; }
      send({ id: packet.id, result: packet.method==='snapshot'?currentSnapshot():await engine!.invoke(packet.method, packet.params) });
    } catch (error) { const message=redact(error instanceof Error ? error.message : String(error));if(packet.method.startsWith('projectFlow.'))send({id:packet.id,result:{__airoomFlowError:{code:(error as {code?:string}).code??'FLOW_ERROR',message}}});else send({ id: packet.id, error: message }); }
  });
  port.start();
  currentSnapshot();
  send({ type: 'ready' });
  void engine.probe();
});
process.on('uncaughtException', error => { send({ type: 'fatal', error: redact(error.message) }); process.exitCode = 1; if (!closing) void engine?.close().finally(() => process.exit(1)); });
process.on('unhandledRejection', error => { send({ type: 'fatal', error: redact(error instanceof Error ? error.message : String(error)) }); process.exit(1); });
