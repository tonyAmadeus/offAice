export function isolatedTestEnvironment(base?: NodeJS.ProcessEnv, workspace?: string): {directory: string; env: NodeJS.ProcessEnv};
export function cleanupTestEnvironment(directory:string,workspace?:string):void;
