import path from 'node:path';
import {createServer as createViteServer} from 'vite';
/** Parallel UI tests must not rewrite another worktree's shared dependency cache. */
export function createServer(options){
  if(!process.env.AIROOM_TEST_PROFILE)throw new Error('UI tests require the isolated test bootstrap.');
  const watch=options.server?.watch??{},ignored=watch.ignored===undefined?[]:Array.isArray(watch.ignored)?watch.ignored:[watch.ignored];
  // Scan the app entry, not packaged runtimes, rollback copies and portable extraction caches.
  return createViteServer({...options,optimizeDeps:{...options.optimizeDeps,entries:['index.html']},server:{...options.server,watch:{...watch,ignored:[...ignored,'**/.test-cache/**','**/release/**','**/.builder-cache/**']}},cacheDir:path.join(process.env.AIROOM_TEST_PROFILE,'vite-cache')});
}
