import mongoose from 'mongoose';
let connection: Promise<typeof mongoose> | undefined;
export default async function connectDB(opts: { dbName?: string } = {}) {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  if (mongoose.connection.readyState === 1) return mongoose;
  if (!connection) connection = mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000, ...(opts.dbName ? { dbName: opts.dbName } : {}) }).catch(error => { connection = undefined; throw error; });
  return connection;
}
