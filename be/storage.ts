import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type InstallationData = {
    userId: string;
    installation_id: string;
    githubUserId: string;
    refreshToken: string | null;
    createdAt: number;
    updatedAt: number;
};

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


