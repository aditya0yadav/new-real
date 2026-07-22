// Bridge page ↔ Extension config
export const EXTENSION_ID = import.meta.env.VITE_EXTENSION_ID || 'fegmfcmnnmoekoabfpcodaalenilpkij';

// Backend URL fallback to localhost:4000 if not specified or dummy
export const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL && !import.meta.env.VITE_BACKEND_URL.includes('a.com'))
  ? import.meta.env.VITE_BACKEND_URL
  : 'http://localhost:4000';
