import express from "express"
import { exchangeCodeForToken, getGithubUser, getInstallationOctakit } from "./lib"
import { getSession, listSessions, saveRepoConfig, saveSession, storage, type InstallationData } from "./storage"
import axios from "axios"
import { getAppJWT } from "./lib" 
import Sandbox from "@e2b/code-interpreter"
import { randomUUID } from "node:crypto"

const app = express()

app.get("/health", (req, res) => {
    res.send({ message: "healthy" })
})

app.post("/api/auth/github/install", (req, res) => {
    res.redirect("https://github.com/settings/apps/sauox")
})

app.get("/api/auth/github/callback", async (req, res) => {
    const {installation_id, code} = req.query

    if(!installation_id) {
        return res.status(400).json({
            message: "Missing installtion_id parameter"
        })
    }

    try {
        let accessToken: string | null
        let refreshToken: string | null
        let githubUser: null | any = null
        let userId = `user${Date.now()}`

        //if authorization was requested, change the code for tokens

        if(code && typeof code == "string") {
            const clientId = process.env.CLIENT_ID
            const clientSecret = process.env.CLIENT_SECRET

            if(!clientId || !clientSecret) {
                return res.status(500).json({
                    message: "GitHub OAuth credentials are not configured"
                })
            }

            const tokenResponse = await exchangeCodeForToken(
                code,
                clientId,
                clientSecret
            )

            accessToken = tokenResponse.accessToken
            refreshToken = tokenResponse.refreshToken

            if(accessToken) {
                githubUser = await getGithubUser(accessToken)
                userId = `github${githubUser.id}` //using github userId as internal userId
            }

            //store the installation data
            const installationData: InstallationData = {
                userId,
                installation_id: installation_id as string,
                githubUserId: githubUser ? String(githubUser.id) : "",
                refreshToken,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            }

            await storage.upsert(installationData)
        }
        
    } catch (e) {
        console.log(e)
        return res.json({ 
            error: "Failed to authenticate you, Try again" 
        })
    }
})

app.get("/api/github/repos", async (req, res) => {
    const installation_id  = req.query.installation_id as string

    const authToken = await getInstallationOctakit(installation_id)

    try {
        const resposRes = await axios.get("https://api.github.com/installation/repositories", {
            headers: {
                Authorization: `Bearer ${authToken}`,
                Accept: "application/vnd.github+json"
            }
        })
    
        const data = await resposRes.data
        return res.json(data.repositories)
    } catch (e) {
        console.log(e)
        return res.json({
            error: "Failed to fetch repos"
        })
    }
})

app.post("/api/github/repo/config", async (req, res) => {
    const { repoFullName, buildCommand, runCommand, installCommand, testCommand, repoOwnerName } = req.body 
    const installationId = req.installationId

    try {
        const repoConfigs = await saveRepoConfig(installationId, repoFullName, {
            buildCommand,
            testCommand,
            runCommand,
            installCommand,
        })
    
        return res.json(repoConfigs)
    } catch (e) {
        console.log(e)
        return res.json({
            error: "Failed to save repo configs"
        })
    }
})

app.post("/api/app/sessions", async (req, res) => {
    const repoFullName = req.query.repoFullName as string
    const installationId = req.installationId
    

    if (!/^[\w.-]+\/[\w.-]+$/.test(repoFullName)) {
        return res.status(400).json({ error: 'Invalid repo name' });
    }

    try {
        const appJWT = getAppJWT()
        const response = await axios.post(`https://api.github.com/app/installations/${installationId}/access_tokens`, null, {
            headers: {
                Authorization: `Bearer ${appJWT}`,
                Accept: "application/vnd.github+json"
            }
        })

        const token = response.data.token as string 

        const sandbox = await Sandbox.create({ timeoutMs: 30 * 60 * 1000 })
        const cloneResult = await sandbox.commands.run(
            `git clone https://x-access-token:${token}@github.com/${repoFullName}.git repo`, {timeoutMs: 120000}
        )

        const session = {
            id: randomUUID(),
            installationId,
            repoFullName,
            sandboxId: sandbox.sandboxId,
            status: 'ready' as const,
            createdAt: new Date().toISOString(),
            messages: [],
            logs: [cloneResult.stdout, cloneResult.stderr].filter(Boolean)
        }

        await saveSession(session)

        return res.json(session)
    } catch (error) {
        console.log(error)
        return res.json({ error: "Failed to create session" })
    }
})

app.get("/api/app/sessions", async (req, res) => {
    const installationId = req.installationId

    return res.json(await listSessions(installationId))
})

app.get("/api/sessions/:id", async (req, res) => {
    try {
        const session = await getSession(req.params.id)

        if (!session || session.installationId !== req.installationId) {
            return res.status(404).json({ error: "Session not found" })
        }

        const sandbox = await Sandbox.connect(session.sandboxId)
        const diffResult = await sandbox.commands.run(
            "git -C repo diff --no-ext-diff",
            { timeoutMs: 120000 }
        )

        return res.json({
            session,
            messages: session.messages,
            currentGitDiff: diffResult.stdout,
            executionLogs: session.logs
        })
    } catch (error) {
        console.log(error)
        return res.status(500).json({ error: "Failed to retrieve session" })
    }
})

app.listen(3000, () => {
    console.log("server is up and running on port 3000")
})
