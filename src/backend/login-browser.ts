import type {CliCommand} from './adapters/common';

/** Login helpers relay URLs to Electron; only the desktop host opens the system browser. */
export const LOGIN_BROWSER_PRELOAD=String.raw`
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
function browserUrl(file,args){
 const name=String(file).split(/[\\/]/).at(-1).toLowerCase(),values=Array.isArray(args)?args.map(String):[];
 let text=[String(file),...values].join(' ');
 const encoded=values.findIndex(v=>/^-enc(?:odedcommand)?$/i.test(v));
 if(encoded>=0&&values[encoded+1])try{text+=' '+Buffer.from(values[encoded+1],'base64').toString('utf16le');}catch{}
 const handler=/^(?:chrome|msedge|firefox|brave|opera|iexplore|open|xdg-open|www-browser)(?:\.exe)?$/.test(name)
   ||/^(?:cmd|cmd.exe)$/.test(name)&&/\bstart\b/i.test(text)
   ||/^(?:powershell|pwsh)(?:\.exe)?$/.test(name)&&/Start-Process/i.test(text)
   ||name==='rundll32.exe'&&/FileProtocolHandler/i.test(text);
 return handler?text.match(/https:\/\/[^\s<>"'\x1b]+/)?.[0]:undefined;
}
function relay(url,argv){
 process.stderr.write('\nAIROOM_BROWSER_URL '+url+'\n');
 const child=new EventEmitter();Object.assign(child,{stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),exitCode:null,signalCode:null,killed:false,pid:undefined});
 child.unref=()=>child;child.kill=()=>true;
 queueMicrotask(()=>{child.exitCode=0;child.stdout.end();child.stderr.end();const callback=argv.findLast(value=>typeof value==='function');callback?.(null,'','');child.emit('exit',0,null);child.emit('close',0,null);});return child;
}
for(const method of ['spawn','execFile','exec']){const original=cp[method];cp[method]=function(...argv){const url=browserUrl(argv[0],argv[1]);if(url)return relay(url,argv);
 const index=Array.isArray(argv[1])?2:1;if(typeof argv[index]==='function'||argv[index]===undefined)argv.splice(index,0,{windowsHide:true});else if(argv[index]&&typeof argv[index]==='object')argv[index]={...argv[index],windowsHide:true};return original.apply(this,argv);};}
syncBuiltinESMExports();
`;
export function defaultBrowserLoginCommand(command:CliCommand){
  return command.prefix.length?{...command,prefix:['--import','data:text/javascript,'+encodeURIComponent(LOGIN_BROWSER_PRELOAD),...command.prefix]}:command;
}
export function defaultBrowserLoginEnvironment(env:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
  return {...env,CI:'1',BROWSER:'www-browser'};
}
