export interface LockedPackage {
  version?: string; dev?: boolean; optional?: boolean; peer?: boolean;
  os?: string[]; cpu?: string[];
}
export function productionPackages(lock: {packages: Record<string,LockedPackage>}, platform?: string, arch?: string): [string,LockedPackage][];
export function verifyRuntimeDependencies(appRoot: string): Promise<{packages:number;peers:number;nested:number}>;
export default function afterPack(context: {appOutDir:string;electronPlatformName:string}): Promise<void>;
