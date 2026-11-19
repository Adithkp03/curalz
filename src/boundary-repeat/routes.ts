import express from 'express';
import { protect } from '../middleware/auth.middleware';
import { LinkError } from '../services/careLink.service';
import { repeatCronAuthorized, sweepRepeats, stopRepeat, readRepeatEvent } from './service';

export const boundaryRepeatRouter = express.Router();

boundaryRepeatRouter.post('/jobs/sweep', async (req, res) => {
    if (!repeatCronAuthorized(req.headers.authorization)) return res.status(401).json({ error: 'Unauthorized' });
    try { res.json(await sweepRepeats()); } catch { res.status(500).json({ error: 'Boundary repeat sweep incomplete' }); }
});

boundaryRepeatRouter.use(protect);
const run = (fn: (r: any) => Promise<any>) => async (r: any, res: any) => {
    try { res.json(await fn(r)); }
    catch (e) {
        if (e instanceof LinkError) return res.status(e.status).json({ error: e.message });
        res.status(500).json({ error: 'Boundary repeat unavailable' });
    }
};
boundaryRepeatRouter.post('/:episodeId/stop', run(r => stopRepeat(r.user, r.params.episodeId)));
boundaryRepeatRouter.get('/events/:id', run(r => readRepeatEvent(r.user, r.params.id)));
