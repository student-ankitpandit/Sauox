import type { Request, Response, NextFunction } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken"

export const authMiddleware = (req:Request, res:Response, next:NextFunction) => {
    try {
        const token = req.headers.authorization
    
        if(!token) {
            return res.status(403).json({
                error: "You're Unauthorized, Please login."
            })
        }
    
        const decodedToken =  jwt.verify(token, process.env.GITHUB_PRIVATE_KEY!) as JwtPayload 
        req.installationId = decodedToken.installationId 

        next()
    } catch (e) {
        console.log(e)
        if(e instanceof Error) {
            return res.status(403).json({
                error: "Invalid or Expired token"
            })
        }
    }
    return res.status(403).json({
        error: "You're Unauthorized, Please login."
    })
}