// Loads .env from the project root when present (Node's built-in loader; no extra dependency).
try {
  process.loadEnvFile?.('.env');
} catch {
  /* no .env file — rely on the real environment */
}
export {};
