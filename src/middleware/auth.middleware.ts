import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User';

interface AuthRequest extends Request {
    user?: any;
}

export const protect = async (req: AuthRequest, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;

    if (!header || !header.startsWith('Bearer')) {
        return res.status(401).json({ message: 'Not authorized, no token', code: 'NO_TOKEN' });
    }

    const token = header.split(' ')[1];

    let decoded: any;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET!);
    } catch (error) {
        // Only the token itself failing verification is a 401.
        return res.status(401).json({ message: 'Not authorized, token failed', code: 'TOKEN_INVALID' });
    }

    try {
        req.user = await User.findById(decoded.id).select('-password');
    } catch (error) {
        // A database hiccup is not an auth failure: reporting 401 here made
        // clients wipe a perfectly valid saved session.
        console.error(error);
        return res.status(500).json({ message: 'Server error', code: 'SERVER_ERROR' });
    }

    if (!req.user) return res.status(401).json({ message: 'Not authorized', code: 'USER_NOT_FOUND' });
    next();
};

export const authorize = (...roles: string[]) => {
    return (req: AuthRequest, res: Response, next: NextFunction) => {
        if (!req.user) {
            return res.status(401).json({ message: 'Not authorized' });
        }
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({
                message: `User role ${req.user.role} is not authorized to access this route`,
            });
        }
        next();
    };
};
