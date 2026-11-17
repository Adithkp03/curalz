const db = vi.hoisted(() => {
  const st: any = { user: null as any, throwOnFind: false };
  return {
    st,
    User: {
      findById: (_id: string) => ({
        select: async () => {
          if (st.throwOnFind) throw new Error('db unreachable');
          return st.user;
        },
      }),
    },
  };
});
vi.mock('../src/models/User', () => ({ default: db.User }));
import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { protect } from '../src/middleware/auth.middleware';

process.env.JWT_SECRET = 'test-secret-for-middleware';
const user = { _id: 'u1', name: 'U', role: 'patient' };
const tokenFor = (id: string, secret = process.env.JWT_SECRET!) => jwt.sign({ id }, secret, { expiresIn: '30d' });

function run(headers: any) {
  const req: any = { headers };
  const res: any = {
    statusCode: 0,
    body: null as any,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: any) { this.body = payload; return this; },
  };
  const next = vi.fn();
  return { req, res, next, done: protect(req, res, next) };
}

beforeEach(() => { db.st.user = user; db.st.throwOnFind = false; });

describe('protect', () => {
  it('passes a valid token for an existing user', async () => {
    const { req, res, next, done } = run({ authorization: `Bearer ${tokenFor('u1')}` });
    await done;
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toBe(user);
    expect(res.statusCode).toBe(0);
  });

  it('denies a valid token whose user no longer exists (revoked/deleted account)', async () => {
    db.st.user = null;
    const { res, next, done } = run({ authorization: `Bearer ${tokenFor('u1')}` });
    await done;
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('USER_NOT_FOUND');
  });

  it('reports a database failure as 500 and never grants access', async () => {
    db.st.throwOnFind = true;
    const { res, next, done } = run({ authorization: `Bearer ${tokenFor('u1')}` });
    await done;
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
    expect(res.body.code).toBe('SERVER_ERROR');
  });

  it('denies an expired or wrongly-signed token as TOKEN_INVALID', async () => {
    const badSig = run({ authorization: `Bearer ${tokenFor('u1', 'other-secret')}` });
    await badSig.done;
    expect(badSig.next).not.toHaveBeenCalled();
    expect(badSig.res.statusCode).toBe(401);
    expect(badSig.res.body.code).toBe('TOKEN_INVALID');

    const expired = run({ authorization: `Bearer ${jwt.sign({ id: 'u1' }, process.env.JWT_SECRET!, { expiresIn: '0s' })}` });
    await new Promise(r => setTimeout(r, 1100));
    await expired.done;
    expect(expired.next).not.toHaveBeenCalled();
    expect(expired.res.statusCode).toBe(401);
    expect(expired.res.body.code).toBe('TOKEN_INVALID');
  });

  it('denies a missing or malformed header as NO_TOKEN', async () => {
    const none = run({});
    await none.done;
    expect(none.next).not.toHaveBeenCalled();
    expect(none.res.statusCode).toBe(401);
    expect(none.res.body.code).toBe('NO_TOKEN');

    const basic = run({ authorization: 'Basic abc' });
    await basic.done;
    expect(basic.res.statusCode).toBe(401);
    expect(basic.res.body.code).toBe('NO_TOKEN');
  });
});
