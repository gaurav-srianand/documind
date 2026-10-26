import connectToDatabase from "@/lib/mongodb";
import Document from "@/models/Document";

// POST /api/documents  ->  create a new document record
export async function POST(request) {
  try {
    // Parse the JSON body. If the body is missing or not valid JSON,
    // request.json() would throw, so we fall back to null instead of crashing.
    const body = await request.json().catch(() => null);

    // Only accept a string, and ignore surrounding whitespace.
    // Anything else (numbers, objects, missing) becomes an empty string.
    const filename =
      typeof body?.filename === "string" ? body.filename.trim() : "";

    // Reject empty/blank filenames before touching the database.
    if (!filename) {
      return Response.json(
        { error: "filename is required and must be a non-empty string" },
        { status: 400 }
      );
    }

    await connectToDatabase();

    // Create the record. status and pageCount are written explicitly so the
    // intent is obvious, even though the schema already has these defaults.
    const document = await Document.create({
      filename,
      status: "processing",
      pageCount: 0,
    });

    // 201 = "Created" is the correct code when a new resource is added.
    return Response.json(document, { status: 201 });
  } catch (error) {
    // Log detail privately for debugging; never log the connection string.
    console.error("[documents:POST] Failed:", error.message);
    return Response.json({ error: "Could not create document" }, { status: 500 });
  }
}

// GET /api/documents  ->  list all documents, newest first
export async function GET() {
  try {
    await connectToDatabase();

    // find({}) = every record; sort({ createdAt: -1 }) = newest first.
    const documents = await Document.find({}).sort({ createdAt: -1 });

    return Response.json(documents, { status: 200 });
  } catch (error) {
    console.error("[documents:GET] Failed:", error.message);
    return Response.json({ error: "Could not list documents" }, { status: 500 });
  }
}
