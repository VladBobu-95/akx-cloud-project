import { Preferences } from '@capacitor/preferences';

const KEY = 'akx_mobile_device_id';

export async function idDispositivo(): Promise<string> {
  const { value } = await Preferences.get({ key: KEY });
  if (value && value.length >= 8) return value;
  const id = crypto.randomUUID();
  await Preferences.set({ key: KEY, value: id });
  return id;
}
