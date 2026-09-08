import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'es.ateka.cloud',
  appName: 'ATEKA Cloud',
  webDir: 'www',
  server: {
    // HTTP al gateway del PC (emulador). Android bloquea cleartext si no.
    // No pongas `url` aquí: eso es live reload. Usa `npm start` + `npm run android:live`.
    androidScheme: 'http',
    cleartext: true,
  },
  plugins: {
    Keyboard: {
      resize: 'body',
      resizeOnFullScreen: true,
    },
  },
};

export default config;
