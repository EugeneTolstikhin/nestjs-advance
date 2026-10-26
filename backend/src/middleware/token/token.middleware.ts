import { Injectable, NestMiddleware } from "@nestjs/common";
import { NextFunction, Request, Response } from "express";

@Injectable()
export class TokenMiddleware implements NestMiddleware {
    use(req: Request, res: Response, next: NextFunction) {
        const token = req.headers.authorization?.split(' ')[1]; // Assuming the token is sent as "Bearer <token>"
        if (!token) {
            return res.status(401).json({ message: 'Unauthorized' });
        }
        // Here you can add logic to validate the token
        next();
    }
}