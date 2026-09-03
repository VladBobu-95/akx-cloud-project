import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'es.ateka.cloud',
  appName: 'ATEKA Cloud',
  webDir: 'www',
  server: {
    // HTTP al gateway del PC (emulador). Android bloquea cleartext si no.
    androidScheme: 'http',
    cleartext: true,
  },
};

export default config;
