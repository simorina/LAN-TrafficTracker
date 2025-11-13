import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0', // Accetta connessioni da qualsiasi interfaccia
    port: 5173,
    strictPort: true,
  }
})