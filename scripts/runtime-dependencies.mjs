import path from 'node:path';
import { createHash } from 'node:crypto';
import { cp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const matches = (values, value) => !values || (!values.includes('!' + value) && (!values.some(item => !item.startsWith('!')) || values.includes(value)));
export function productionPackages(lock, platform = 'win32', arch = 'x64') {
  return Object.entries(lock.packages).filter(([name, pkg]) => name.startsWith('node_modules/') && !pkg.dev && matches(pkg.os, platform) && matches(pkg.cpu, arch));
}
function dependencyPath(base, name) {
  if (!name.startsWith('node_modules/') || name.includes('\\') || name.split('/').some(item => item === '..' || item === '.')) throw new Error('Invalid dependency path');
  const result = path.resolve(base, name);
  if (!result.startsWith(path.resolve(base) + path.sep)) throw new Error('Dependency path escaped app root');
  return result;
}
export async function verifyRuntimeDependencies(appRoot) {
  const lockBytes = await readFile(path.join(appRoot, 'package-lock.json'));
  const manifest = JSON.parse(await readFile(path.join(appRoot, 'dist', 'runtime-dependencies.json'), 'utf8'));
  if (manifest.lockSha256 !== sha(lockBytes)) throw new Error('Runtime lockfile hash mismatch');
  const records = new Map(manifest.packages.map(item => [item.path, item]));
  const excluded = new Set(manifest.excluded.map(item => item.path));
  const failures = [];
  for (const name of records.keys()) if (/node_modules\/(?:@anthropic-ai\/claude-code|@openai\/codex|@deepseek-ai\/dsh)(?:[-/]|$)/.test(name)) failures.push(name + ': vendor CLI must be downloaded by the user');
  for (const [name, pkg] of productionPackages(JSON.parse(lockBytes), manifest.platform, manifest.arch)) {
    const record = records.get(name);
    if (!record && pkg.optional && excluded.has(name)) continue;
    try {
      if (!record) throw new Error('missing inventory');
      const bytes = await readFile(path.join(dependencyPath(appRoot, name), 'package.json'));
      if (JSON.parse(bytes).version !== pkg.version || sha(bytes) !== record.packageJsonSha256) throw new Error('wrong version or hash');
    } catch (error) { failures.push(name + ': ' + error.message); }
  }
  for (const item of manifest.equivalentFiles) {
    if (sha(await readFile(dependencyPath(appRoot, item.path))) !== item.sha256) failures.push(item.path + ': equivalent executable hash mismatch');
  }
  if (failures.length) throw new Error('Production dependencies incomplete:\n' + failures.join('\n'));
  return { packages: records.size, peers: manifest.packages.filter(item => item.peer).length, nested: manifest.packages.filter(item => item.path.slice(13).includes('/node_modules/')).length };
}

/** electron-builder's automatic dependency collection omits installed peer and nested packages. */
export default async function afterPack(context) {
  const output = path.resolve(context.appOutDir);
  const expected = path.join(root, 'release', 'win-unpacked');
  if (output !== expected || context.electronPlatformName !== 'win32') throw new Error('Unexpected packaging target: ' + output);
  // A custom Electron distribution also copies its demo app; ship only AIROOM.
  await rm(path.join(expected, 'resources', 'default_app.asar'), {force:true});
  const appRoot = path.join(output, 'resources', 'app');
  const targetModules = path.join(appRoot, 'node_modules');
  // Validate the absolute deletion target before removing builder's incomplete tree.
  if (targetModules !== path.join(expected, 'resources', 'app', 'node_modules')) throw new Error('Unsafe runtime dependency target');
  await rm(targetModules, { recursive: true, force: true });
  const dependencies=await copyProductionDependencies(appRoot);
  console.log('[AIROOM] Complete production dependency tree:', dependencies);
}

/** Copy the same production payload into an empty package or disposable desktop test app. */
export async function copyProductionDependencies(appRoot) {
  const lockBytes = await readFile(path.join(root, 'package-lock.json'));
  const lock = JSON.parse(lockBytes);
  const manifest = { schemaVersion: 1, platform: 'win32', arch: 'x64', lockSha256: sha(lockBytes), packages: [], excluded: [], equivalentFiles: [] };
  for (const [name, pkg] of productionPackages(lock)) {
    const source = dependencyPath(root, name);
    try { await stat(path.join(source, 'package.json')); }
    catch (error) { if (pkg.optional && error.code === 'ENOENT') { manifest.excluded.push({path:name,reason:'optional package absent from source installation'});continue;}throw new Error('Required source dependency missing: ' + name); }
    const bytes = await readFile(path.join(source, 'package.json'));
    if (JSON.parse(bytes).version !== pkg.version) throw new Error('Source dependency does not match lockfile: ' + name);
    // Nested installed packages are copied individually at their exact lockfile paths.
    await cp(source, dependencyPath(appRoot, name), {recursive:true,dereference:true,filter:file => {
      const parts=path.relative(source,file).split(path.sep);
      if(parts[0]==='node_modules')return false;
      // npm is an internal installer, not an interactive shell. Keep code and
      // every package/license, while omitting its rendered and source help pages.
      if(name==='node_modules/npm'&&['docs','man'].includes(parts[0]))return false;
      if(name==='node_modules/7zip-bin'){
        if(['linux','mac'].includes(parts[0]))return false;
        if(parts[0]==='win'&&parts.length>1&&parts[1]!=='x64')return false;
      }
      return true;
    }});
    if(name==='node_modules/7zip-bin'){
      const binary='node_modules/7zip-bin/win/x64/7za.exe';
      manifest.equivalentFiles.push({path:binary,sha256:sha(await readFile(dependencyPath(root,binary)))});
    }
    manifest.packages.push({path:name,version:pkg.version,packageJsonSha256:sha(bytes),peer:!!pkg.peer,optional:!!pkg.optional});
  }
  await writeFile(path.join(appRoot, 'package-lock.json'), lockBytes);
  await writeFile(path.join(appRoot, 'dist', 'runtime-dependencies.json'), JSON.stringify(manifest, null, 2));
  return verifyRuntimeDependencies(appRoot);
}
