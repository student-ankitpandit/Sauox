import fs from 'fs/promises';
import path from 'path';

const repoConfigFile = path.join(import.meta.dir, 'data', 'repo-configs.json');
interface RepoConfig {
    buildCommand?: string;
    testCommand?: string;
    runCommand?: string;
    installCommand?: string;
}
interface DB {
  [key: string]: RepoConfig;  // keyed by `${installationId}:${repoFullName}`
}

async function readDB(): Promise<DB> {
  try {
    const raw = await fs.readFile(repoConfigFile, 'utf-8');
    return JSON.parse(raw);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      await fs.mkdir(path.dirname(repoConfigFile), { recursive: true });
      await fs.writeFile(repoConfigFile, '{}');
      return {};
    }
    throw err;
  }
}

async function writeDB(data: DB): Promise<void> {
  await fs.writeFile(repoConfigFile, JSON.stringify(data, null, 2));
}

export function makeKey(installationId: string, repoFullName: string): string {
  return `${installationId}:${repoFullName}`;
}

export async function getRepoConfig(installationId: string, repoFullName: string): Promise<RepoConfig | null> {
  const db = await readDB();
  return db[makeKey(installationId, repoFullName)] ?? null;
}

export async function saveRepoConfig(installationId: string, repoFullName: string, config: RepoConfig): Promise<RepoConfig> {
  const db = await readDB();
  const key = makeKey(installationId, repoFullName);
  db[key] = { ...db[key], ...config };
  await writeDB(db);
  return db[key];
}



