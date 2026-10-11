import {mkdir,writeFile,readFile,link,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

/** Local native-package inventory fixture; linking the test host avoids copying 100 MiB per test. */
export async function cursorPackage(prefix:string,version:string,{script="console.log('fixture')",host=false}:{script?:string;host?:boolean}={}){
  const runtime=path.join(prefix,'dist-package');await mkdir(runtime,{recursive:true});
  await writeFile(path.join(runtime,'index.js'),script);
  if(host)await link(process.execPath,path.join(runtime,'node.exe')).catch(()=>copyFile(process.execPath,path.join(runtime,'node.exe')));else await writeFile(path.join(runtime,'node.exe'),'fixture-node');
  await writeFile(path.join(runtime,'package.json'),JSON.stringify({name:'@anysphere/agent-cli-runtime',private:true}));
  await writeFile(path.join(runtime,'node_sqlite3.node'),'fixture-addon');
  const files=[];for(const name of ['index.js','node.exe','package.json','node_sqlite3.node']){const bytes=await readFile(path.join(runtime,name));files.push({path:'dist-package/'+name,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
  await writeFile(path.join(prefix,'.airoom-install.json'),JSON.stringify({schema:1,member:'cursor',version,entry:'dist-package/index.js',source:`https://downloads.cursor.com/lab/${version}/windows/x64/agent-cli-package.zip`,nodeVersion:process.versions.node,files}));
  return {version,entry:path.join(runtime,'index.js')};
}
