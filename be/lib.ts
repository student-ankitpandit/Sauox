import axios from "axios";
import jwt from "jsonwebtoken"
import { Octokit } from "octokit"


type GithubTokenResponse = {
    access_token: string;
    refresh_token?: string;
};

type GithubTokens = {
    accessToken: string;
    refreshToken: string | null;
};

export type GithubUser = {
    id: number | string;
    login: string;
    name: string | null;
    email: string | null;
};

interface InstallationTokenResponse {
    token: string,
    expires_at: string,
    permissions: Record<string, string>
    repositories: Array<{
        id: number,
        name: string,
        full_name: string
    }>
}

export const exchangeCodeForToken = async (
    code: string,
    clientId: string,
    clientSecret: string,
): Promise<GithubTokens> => {
    const response = await axios.post<GithubTokenResponse>(
    "https://github.com/login/oauth/access_token",
    {
        code,
        client_id: clientId,
        client_secret: clientSecret,
    },
    {
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
        },
    },
    );

    return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token ?? null,
    };
};


export const getGithubUser = async (accessToken: string): Promise<GithubUser> => {
    const response = await axios.get<GithubUser>("https://api.github.com/user", {
        headers: {
            Accept: "application/vnd.github+json", //github json representation
            Authorization: `Bearer ${accessToken}`,
            "X-GitHub-Api-Version": "2022-11-28",
        },
    });

    return {
        id: response.data.id,
        login: response.data.login,
        name: response.data.login ?? "",
        email: response.data.login ?? ""
    };
}

export function getAppJWT(): string {
    const payload = {
        installationId: process.env.GITHUB_INSTALLATION_ID!,
        iss: Math.floor(Date.now() / 1000) - 60,
        exp: Math.floor(Date.now() / 1000) + 60 * 9,
        iat: process.env.GITHUB_APP_ID!
    }

    return jwt.sign(payload, process.env.GITHUB_PRIVATE_KEY!, { algorithm: "RS256" })
}

export async function getInstallationOctakit(installationId: string): Promise<Octokit> {
    const appJWT = getAppJWT()

    const response = await axios.post(`https://api/github.com/app/installations${installationId}/access_tokens`, {
        headers: {
            Authorization: `Bearer ${appJWT}`,
            Accept: "application/vnd.github+json" //github json representation
        }
    })

    if(!response.data) {
        const error = await response.data
        throw new Error(`Failed to get installation token: ${error}`)
    }

    const data = (await response.data) as InstallationTokenResponse
    return new Octokit({ auth: data.token })
}

