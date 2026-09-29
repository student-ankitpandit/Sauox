import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import fs from 'fs/promises';
import path from 'path';

export type InstallationData = {
    userId: string;
    installation_id: string;
    githubUserId: string;
    refreshToken: string | null;
    createdAt: number;
    updatedAt: number;
};

export interface Session {
  id: string;
  installationId: string;
  repoFullName: string;
  sandboxId: string;
  status: "ready" | "running" | "done" | "error" | "suspended" | "resuming";
  createdAt: string;
  messages: string[];
  logs: string[]
}

const storageFile = join(import.meta.dir, "data", "installations.json");

const readInstallations = async (): Promise<InstallationData[]> => {
    try {
        const contents = await readFile(storageFile, "utf8");
        return JSON.parse(contents) as InstallationData[];
    } catch (error: unknown) {
        if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
        ) {
        return [];
        }

        throw error;
    }
};

const writeInstallations = async (
  installations: InstallationData[],
): Promise<void> => {
  await mkdir(dirname(storageFile), { recursive: true });

  const temporaryFile = `${storageFile}.tmp`;
  await writeFile(
    temporaryFile,
    JSON.stringify(installations, null, 2),
    "utf8",
  );
  await rename(temporaryFile, storageFile);
};

export const storage = {
  async upsert(installation: InstallationData): Promise<void> {
    const installations = await readInstallations();
    const existingIndex = installations.findIndex(
      (item) => item.installation_id === installation.installation_id,
    );

    if (existingIndex === -1) {
      installations.push(installation);
    } else {
      installations[existingIndex] = installation;
    }

    await writeInstallations(installations);
  },
};

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

const sessionFile = path.join(import.meta.dir, 'data', 'sessions.json');

async function readSessions(): Promise<Record<string, Session>> {
  try {
    return JSON.parse(await fs.readFile(sessionFile, 'utf-8'));
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      await fs.mkdir(path.dirname(sessionFile), { recursive: true });
      await fs.writeFile(sessionFile, '{}');
      return {};
    }
    throw err;
  }
}

export async function saveSession(session: Session) {
  const all = await readSessions();
  all[session.id] = session;
  await fs.writeFile(sessionFile, JSON.stringify(all, null, 2));
}

export async function getSession(sessionId: string) {
  return (await readSessions())[sessionId] ?? null;
}

export async function listSessions(installationId: string) {
  const allSessions = (await readSessions()) 

  return Object.values(allSessions)
    .filter(s => s.installationId == installationId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

