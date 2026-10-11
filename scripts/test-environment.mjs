import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';

// Each ordinary test process gets its own signed-out profile. Never inherit a
// native home or desktop host's account/session variables from the launching AI.
export function isolatedTestEnvironment(base = process.env, workspace = process.cwd()) {
  const root = path.resolve(workspace, '.test-cache', 'test-profiles');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, 'run-'));
  const env = { ...base };
  env.AIROOM_DESKTOP_RUNTIME_PARENT??=path.join(base.LOCALAPPDATA??path.join(base.USERPROFILE??workspace,'AppData','Local'),'Temp');
  for (const key of Object.keys(env)) {
    if (/^(?:CLAUDE|ANTHROPIC|CODEX|OPENAI|DSH|GEMINI|GOOGLE|QWEN|QODER|QODERCN|CURSOR|KIMI|OPENCODE|XAI|MINIMAX|ZCODE|ZAI|BIGMODEL)_|^CLAUDECODE$|^AIROOM_(?:.*HOME|.*STATE_DIR|DATA_DIR|DATA_DIRECTORY|ACP_SECRETS|TEST_PROFILE)$|^(?:USERPROFILE|HOME|HOMEPATH|HOMEDRIVE|APPDATA|LOCALAPPDATA|XDG_CONFIG_HOME|XDG_CACHE_HOME|TEMP|TMP)$/i.test(key)) delete env[key];
  }
  const home = path.join(directory, 'user');
  const data = path.join(directory, 'data');
  Object.assign(env, {
    AIROOM_TEST_PROFILE: directory, AIROOM_APP_ROOT: path.resolve(workspace),
    USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    TEMP: path.join(directory, 'temp'), TMP: path.join(directory, 'temp'),
    AIROOM_DATA_DIR: data, AIROOM_DATA_DIRECTORY:data, AIROOM_CODEX_HOME: path.join(data, 'native', 'codex', 'home'),
    AIROOM_CODEX_STATE_DIR: path.join(data, 'native', 'codex', 'sqlite'),
    AIROOM_CLAUDE_HOME: path.join(data, 'native', 'claude'), AIROOM_DSH_HOME: path.join(data, 'native', 'dsh'),
    AIROOM_ACP_HOME: path.join(data, 'native', 'acp'),
  });
  for (const name of [home, data, env.APPDATA, env.LOCALAPPDATA, env.TEMP, env.AIROOM_CODEX_HOME, env.AIROOM_CODEX_STATE_DIR, env.AIROOM_CLAUDE_HOME, env.AIROOM_DSH_HOME, env.AIROOM_ACP_HOME]) mkdirSync(name, { recursive: true });
  return { directory, env };
}

export function cleanupTestEnvironment(directory,workspace=process.cwd()){
  const root=path.resolve(workspace,'.test-cache','test-profiles'),target=path.resolve(directory);
  if(path.dirname(target)!==root||!path.basename(target).startsWith('run-'))throw new Error('测试账号清理路径无法核对。');
  if(process.env.AIROOM_KEEP_TEST_PROFILE!=='1')rmSync(target,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
