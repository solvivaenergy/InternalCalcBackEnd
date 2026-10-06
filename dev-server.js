process.env.NODE_ENV = "development";
process.env.PARAMETERS_STORAGE = "local-json";
// Vite serves the frontend on :5173 and this server listens on :3000, so local
// development is always cross-origin. Staging and production set their own
// list; server.js allows no browser origin when the variable is absent.
process.env.CORS_ORIGINS ??= "*";

await import("./server.js");
