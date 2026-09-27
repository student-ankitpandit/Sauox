import express from "express"
import { exchangeCodeForToken, getGithubUser, getInstallationOctakit } from "./lib"
import { saveRepoConfig, storage, type InstallationData } from "./storage"
import axios from "axios"

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
        return res.status(500).json({ 
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
        res.json(data.repositories)
    } catch (e) {
        console.log(e)
        res.status(500).json({
            error: "Failed to fetch repos"
        })
    }
})


app.post("/api/github/repos/config", async (req, res) => {
    const { repoFullName, buildCommand, runCommand, installCommand, testCommand } = req.body 
    const installationId = req.installationId

    try {
        const repoConfigs = await saveRepoConfig(installationId, repoFullName, {
            buildCommand,
            testCommand,
            runCommand,
            installCommand
        })
    
        res.json(repoConfigs)
    } catch (e) {
        console.log(e)
        return res.status(500).json({
            error: "Failed to save repo configs"
        })
    }
})

app.listen(3000, () => {
    console.log("server is up and running on port 3000")
})
