import mongoose from "mongoose";

// Read the connection string from the server environment.
// lib/ files are only imported by server-side code, so this URI never
// reaches the browser and is never logged.
const MONGODB_URI = process.env.MONGODB_URI;

// In development, Next.js re-runs modules on every file save (Hot Module
// Replacement). A normal module-level variable would be wiped each reload,
// causing a brand-new database connection every time. Storing the cache on
// the global object keeps it alive across reloads so we reuse one connection.
let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

async function connectToDatabase() {
  // Fail early with a message a beginner can act on.
  if (!MONGODB_URI) {
    throw new Error(
      "MONGODB_URI is not set. Copy .env.example to .env and add your MongoDB Atlas connection string."
    );
  }

  // 1. A connection already exists: reuse it, don't open another.
  if (cached.conn) {
    return cached.conn;
  }

  // 2. A connection is already being opened: wait for it instead of
  //    kicking off a second, competing connection.
  if (!cached.promise) {
    // bufferCommands: false makes queries fail immediately with a clear
    // error if the database is unreachable, instead of silently queuing.
    cached.promise = mongoose.connect(MONGODB_URI, { bufferCommands: false });
  }

  try {
    // 3. Store the resolved connection so all future calls reuse it.
    cached.conn = await cached.promise;
  } catch (error) {
    // 4. Connection failed: forget the broken promise so the next request
    //    can try again, then surface the original error.
    cached.promise = null;
    throw error;
  }

  return cached.conn;
}

export default connectToDatabase;
