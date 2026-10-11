import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {planCleanup,applyCleanup,validateRoot,main} from '../scripts/cleanup-project.mjs';

const future=Date.now()+40*86400000;
async function fixture(){
  const lab=await fs.mkdtemp(path.join(os.tmpdir(),'AIROOM-cleanup-tests-')),root=path.join(lab,'AIROOM');await fs.mkdir(root);
  const write=async(relative:string,text='fixture')=>{const file=path.join(root,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);return file;};
  await write('package.json',JSON.stringify({name:'airoom'}));await write('src/backend/engine.ts');
  execFileSync('git',['init','-q',root],{windowsHide:true});execFileSync('git',['-C',root,'add','package.json','src/backend/engine.ts'],{windowsHide:true});
  const plan=(options={})=>planCleanup(root,{now:future,processes:[],...options});
  const dispose=async()=>{assert.equal(await fs.realpath(lab),lab);assert.ok(path.basename(lab).startsWith('AIROOM-cleanup-tests-'));await fs.rm(lab,{recursive:true,force:true});};
  return {lab,root,write,plan,dispose};
}

test('cleanup removes regenerable old files while preserving sources, data, records, current build and unique backups',async()=>{
  const f=await fixture();try{
    for(const file of ['.builder-temp/expired.tmp','.runtime-temp/compiled.bin','.npm-cache/content/old.bin'])await f.write(file);
    const keep=['tests/acceptance.test.ts','docs/handoffs/handoff.md','docs/records/acceptance.json','.airoom-data/airoom.sqlite','.env','assets/original.webp','node_modules/working.js','dist/current.mjs','release/win-unpacked/AIROOM.exe','release/AIROOM-current.exe','release/rollback/AIROOM-fallback.exe','.test-cache/report.log','.test-cache/ui/screenshot.png','.builder-temp/diagnostic.log','.builder-temp/receipt.json','.builder-temp/report.html','.runtime-temp/results/output.bin','.runtime-temp/test.sqlite-wal','.runtime-temp/trace.zip'];
    for(const file of keep)await f.write(file,file);
    await f.write('release/history-aabbccd/package.json','{"name":"airoom"}');await f.write('release/history-aabbccd/src/code.ts');await f.write('release/history-aabbccd/node_modules/pkg/index.js');await f.write('release/history-aabbccd/release/win-unpacked/AIROOM.exe');await f.write('release/history-aabbccd/release/AIROOM-unique.exe','unique installer');await f.write('release/history-aabbccd/docs/handoffs/old.md');await f.write('release/history-aabbccd/tests/old.test.ts');
    const plan=await f.plan();assert.ok(plan.files.some(x=>x.path.endsWith('pkg/index.js')));assert.ok(plan.files.some(x=>x.path.endsWith('win-unpacked/AIROOM.exe')));
    const result=await applyCleanup(plan,{processes:[]});assert.equal(result.status,'complete');assert.ok(result.bytes>0);
    for(const file of keep)assert.equal(await fs.readFile(path.join(f.root,file),'utf8'),file);
    assert.equal(await fs.readFile(path.join(f.root,'release/history-aabbccd/release/AIROOM-unique.exe'),'utf8'),'unique installer');
    await assert.rejects(fs.access(path.join(f.root,'.builder-temp/expired.tmp')));await assert.rejects(fs.access(path.join(f.root,'release/history-aabbccd/node_modules/pkg/index.js')));
    assert.equal((await f.plan()).files.length,0,'a second run is idempotent');
  }finally{await f.dispose();}
});

test('cleanup skips recent directories and active runs, including native paths expressed with forward slashes',async()=>{
  const f=await fixture();try{
    const recent=await f.write('.builder-temp/recent.tmp');await fs.utimes(recent,new Date(future),new Date(future));await f.write('.runtime-temp/in-use.bin');
    const plan=await f.plan({processes:[{pid:999991,parent:0,name:'AIROOM.exe',command:path.join(f.root,'.runtime-temp','AIROOM.exe').replaceAll('\\','/')}]});
    assert.equal(plan.files.length,0);assert.ok(plan.skipped.some(x=>x.reason==='尚未过期'));assert.ok(plan.skipped.some(x=>x.reason==='有活动进程'));
  }finally{await f.dispose();}
});

test('cleanup never follows junctions or deletes the root dependency link',async()=>{
  const f=await fixture();try{
    const outside=path.join(f.lab,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'untouched.bin'),'outside');
    await f.write('.builder-temp/old.tmp');await fs.symlink(outside,path.join(f.root,'.builder-temp','escape'),process.platform==='win32'?'junction':'dir');await fs.symlink(outside,path.join(f.root,'node_modules'),process.platform==='win32'?'junction':'dir');
    const plan=await f.plan();assert.ok(plan.skipped.some(x=>x.path.endsWith('/escape')));const result=await applyCleanup(plan,{processes:[]});assert.equal(result.status,'complete');
    assert.equal(await fs.readFile(path.join(outside,'untouched.bin'),'utf8'),'outside');assert.ok((await fs.lstat(path.join(f.root,'node_modules'))).isSymbolicLink());assert.ok((await fs.lstat(path.join(f.root,'.builder-temp/escape'))).isSymbolicLink());
  }finally{await f.dispose();}
});

test('cleanup honors tracked ignored-looking files and refuses a file changed after planning',async()=>{
  const f=await fixture();try{
    await f.write('.builder-temp/tracked.js');execFileSync('git',['-C',f.root,'add','.builder-temp/tracked.js'],{windowsHide:true});const changed=await f.write('.builder-temp/changed.tmp');
    const plan=await f.plan();assert.ok(!plan.files.some(x=>x.path.endsWith('tracked.js')));await fs.writeFile(changed,'new contents');
    const result=await applyCleanup(plan,{processes:[]});assert.ok(result.skipped.some(x=>x.reason==='预览后已发生变化'));assert.equal(await fs.readFile(changed,'utf8'),'new contents');
  }finally{await f.dispose();}
});

test('cleanup removes only exact duplicate installers and rechecks the retained copy',async()=>{
  const f=await fixture();try{
    await f.write('release/rollback/AIROOM-kept.exe','same');await f.write('release/history-aabbccd/package.json','{"name":"airoom"}');await f.write('release/history-aabbccd/src/code.ts');const duplicate=await f.write('release/history-aabbccd/release/AIROOM-copy.exe','same');await f.write('release/history-aabbccd/release/AIROOM-unique.exe','different');
    let plan=await f.plan();assert.equal(plan.duplicateInstallers.length,1);assert.equal((await applyCleanup(plan,{processes:[]})).status,'complete');await assert.rejects(fs.access(duplicate));assert.equal(await fs.readFile(path.join(f.root,'release/rollback/AIROOM-kept.exe'),'utf8'),'same');
    await fs.writeFile(duplicate,'same');plan=await f.plan();await f.write('release/rollback/AIROOM-kept.exe','changed');const result=await applyCleanup(plan,{processes:[]});assert.equal(result.status,'partial');assert.equal(await fs.readFile(duplicate,'utf8'),'same');
  }finally{await f.dispose();}
});

test('cleanup recognizes extracted portable test runtimes without removing screenshots or installers',async()=>{
  const f=await fixture();try{
    const base='.test-cache/portable-temp/ns123.tmp';await f.write(base+'/app-64.7z');await f.write(base+'/7z-out/AIROOM.exe');await f.write(base+'/7z-out/resources/app/dist/main.mjs');await f.write(base+'/capture.png');await f.write(base+'/AIROOM-preserved.exe');await f.write('.test-cache/portable-temp/unrecognized/custom.bin');
    const plan=await f.plan();assert.ok(plan.files.some(x=>x.path.endsWith('/app-64.7z')));await applyCleanup(plan,{processes:[]});assert.equal(await fs.readFile(path.join(f.root,base,'capture.png'),'utf8'),'fixture');assert.equal(await fs.readFile(path.join(f.root,base,'AIROOM-preserved.exe'),'utf8'),'fixture');assert.equal(await fs.readFile(path.join(f.root,'.test-cache/portable-temp/unrecognized/custom.bin'),'utf8'),'fixture');
  }finally{await f.dispose();}
});

test('cleanup rechecks a candidate replaced by a junction after preview and protects the external target',async()=>{
  const f=await fixture();try{
    const dir=path.join(f.root,'.builder-temp');await f.write('.builder-temp/old.bin');const plan=await f.plan();const outside=path.join(f.lab,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'old.bin'),'outside');await fs.rename(dir,path.join(f.root,'saved-temp'));await fs.symlink(outside,dir,process.platform==='win32'?'junction':'dir');
    const result=await applyCleanup(plan,{processes:[]});assert.equal(result.status,'partial');assert.equal(await fs.readFile(path.join(outside,'old.bin'),'utf8'),'outside');
  }finally{await f.dispose();}
});

test('cleanup rejects unrelated or linked roots and invalid ages',async()=>{
  const f=await fixture();try{
    await assert.rejects(validateRoot(f.lab));await fs.symlink(f.root,path.join(f.lab,'alias'),process.platform==='win32'?'junction':'dir');await assert.rejects(validateRoot(path.join(f.lab,'alias')));await assert.rejects(f.plan({tempDays:0}));await assert.rejects(f.plan({cacheDays:NaN}));
    await assert.rejects(main(['--apply','--root']),/必须提供完整项目目录/);await assert.rejects(main(['--root','--apply']),/必须提供完整项目目录/);
  }finally{await f.dispose();}
});

test('cleanup CLI defaults to preview and writes a persistent report',async()=>{
  const f=await fixture();try{
    const file=await f.write('.builder-temp/retained.tmp');
    const script=path.resolve('scripts/cleanup-project.mjs');execFileSync(process.execPath,[script,'--root',f.root],{encoding:'utf8',windowsHide:true});
    assert.equal(await fs.readFile(file,'utf8'),'fixture');const records=await fs.readdir(path.join(f.root,'.test-cache/cleanup-records'));assert.equal(records.length,1);
    const result=JSON.parse(await fs.readFile(path.join(f.root,'.test-cache/cleanup-records',records[0],'result.json'),'utf8'));assert.equal(result.status,'preview');assert.equal(result.deleted.length,0);await fs.access(path.join(f.root,'.test-cache/cleanup-records',records[0],'报告.md'));
  }finally{await f.dispose();}
});

test('cleanup CLI refuses a linked report parent without writing outside the project',async()=>{
  const f=await fixture();try{
    const outside=path.join(f.lab,'outside');await fs.mkdir(outside);await fs.symlink(outside,path.join(f.root,'.test-cache'),process.platform==='win32'?'junction':'dir');
    assert.throws(()=>execFileSync(process.execPath,[path.resolve('scripts/cleanup-project.mjs'),'--root',f.root],{encoding:'utf8',windowsHide:true,stdio:'pipe'}));assert.deepEqual(await fs.readdir(outside),[]);
  }finally{await f.dispose();}
});

test('cleanup notices a process or new Git tracking added after preview',async()=>{
  const f=await fixture();try{
    const target=await f.write('.builder-temp/in-use.tmp');let plan=await f.plan();
    let result=await applyCleanup(plan,{processes:[{pid:999991,parent:0,name:'node.exe',command:path.join(f.root,'scripts/verify.mjs')}]});assert.equal(result.deleted.length,0);await fs.access(target);
    plan=await f.plan();execFileSync('git',['-C',f.root,'add','.builder-temp/in-use.tmp'],{windowsHide:true});result=await applyCleanup(plan,{processes:[]});assert.equal(result.deleted.length,0);await fs.access(target);
  }finally{await f.dispose();}
});

test('cleanup preserves a historical dependency tree still used by the root dependency junction',async()=>{
  const f=await fixture();try{
    const base='release/history-aabbccd';await f.write(base+'/package.json','{"name":"airoom"}');await f.write(base+'/src/code.ts');await f.write(base+'/node_modules/working.js','in use');
    await fs.symlink(path.join(f.root,base,'node_modules'),path.join(f.root,'node_modules'),process.platform==='win32'?'junction':'dir');
    const plan=await f.plan();assert.equal(plan.files.length,0);await applyCleanup(plan,{processes:[]});assert.equal(await fs.readFile(path.join(f.root,base,'node_modules/working.js'),'utf8'),'in use');
  }finally{await f.dispose();}
});

test('Windows launcher runs its local cleanup script and produces the preview report',{skip:process.platform!=='win32'},async()=>{
  const f=await fixture();try{
    const file=await f.write('.builder-temp/retained.tmp');
    await fs.mkdir(path.join(f.root,'scripts'),{recursive:true});
    await fs.copyFile(path.resolve('scripts/cleanup-project.mjs'),path.join(f.root,'scripts/cleanup-project.mjs'));
    await fs.copyFile(path.resolve('Clean-AIROOM.cmd'),path.join(f.root,'Clean-AIROOM.cmd'));
    const output=execFileSync('cmd.exe',['/d','/c',path.join(f.root,'Clean-AIROOM.cmd'),'--preview'],{cwd:f.root,encoding:'utf8',windowsHide:true,timeout:30000});
    assert.match(output,/仅预览/);assert.match(output,/预览完成/);
    assert.equal(await fs.readFile(file,'utf8'),'fixture');
    const records=await fs.readdir(path.join(f.root,'.test-cache/cleanup-records'));
    assert.equal(records.length,1);
    const result=JSON.parse(await fs.readFile(path.join(f.root,'.test-cache/cleanup-records',records[0],'result.json'),'utf8'));
    assert.equal(result.status,'preview');
  }finally{await f.dispose();}
});
