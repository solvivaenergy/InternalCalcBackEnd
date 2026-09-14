process.env.NODE_ENV = "development";
process.env.PARAMETERS_STORAGE = "local-json";

await import("./server.js");
