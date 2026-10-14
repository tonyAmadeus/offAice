import type {CliCommand} from './common';

// Official ZCode reads -p from argv, not stdin. A Node preload bridges stdin into argv
// before the unmodified official CLI starts, avoiding Windows' command-line size limit.
const marker='AIROOM_ZCODE_STDIN_PROMPT';
const preload='data:text/javascript,'+encodeURIComponent(`import {readFileSync} from 'node:fs';
const index=process.argv.indexOf('-p');
if(index<0||process.argv[index+1]!==${JSON.stringify(marker)})throw new Error('ZCode 输入通道无效，未发送消息。');
process.argv[index+1]=readFileSync(0,'utf8');`);
export function zcodeInput(command:CliCommand,prompt:string){
  if(prompt.length>256000)throw new Error(`AIROOM 组装的消息与历史共 ${prompt.length} 字符，超过本地输入上限 256000；消息尚未发送，请先压缩话题上下文。`);
  if(command.prefix.length)return {command:{...command,prefix:['--import',preload,...command.prefix]},argument:marker,stdin:prompt};
  // Custom native launchers cannot use a Node preload. Keep a conservative explicit limit.
  if(prompt.length>14000)throw new Error(`当前 ZCode 启动方式只能通过命令行传入消息；AIROOM 组装的 ${prompt.length} 字符超过 14000 的本地保护上限，尚未发送。请使用内置 ZCode 执行端或先压缩话题上下文。`);
  return {command,argument:prompt,stdin:undefined};
}
