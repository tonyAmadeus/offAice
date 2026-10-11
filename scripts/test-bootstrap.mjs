import { isolatedTestEnvironment, cleanupTestEnvironment } from './test-environment.mjs';

const workspace=process.cwd(),{ directory, env } = isolatedTestEnvironment(process.env,workspace);
for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
Object.assign(process.env, env);
process.once('exit',()=>{try{cleanupTestEnvironment(directory,workspace);}catch{/* A locked test file stays in the ignored cache for diagnosis. */}});
