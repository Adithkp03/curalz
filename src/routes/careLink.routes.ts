import express, { Response } from 'express';
import { protect } from '../middleware/auth.middleware';
import { requestLink, listIncoming, listOutgoing, respond, revoke, LinkError } from '../services/careLink.service';

const router = express.Router();
router.use(protect);

const run = (fn: (req: any) => Promise<unknown>) => async (req: any, res: Response) => {
    try { res.json(await fn(req)); }
    catch (e: any) {
        if (e instanceof LinkError) return res.status(e.status).json({ error: e.message });
        res.status(500).json({ error: 'Request failed' });
    }
};

router.post('/request', run(req => requestLink(req.user, req.body?.email)));
router.get('/outgoing', run(req => listOutgoing(req.user)));
router.get('/incoming', run(req => listIncoming(req.user)));
router.post('/:id/approve', run(req => respond(req.user, req.params.id, true, req.body?.role)));
router.post('/:id/decline', run(req => respond(req.user, req.params.id, false)));
router.post('/:id/revoke', run(req => revoke(req.user, req.params.id)));

export default router;
